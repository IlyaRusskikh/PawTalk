"""Real Docker/Compose, local registry and ephemeral signing keys; no publication.

Run on Linux or in tests/vps.Dockerfile with the test-only Docker socket mount.
Only image-origin constants are redirected to the disposable local registry.
The production allowlist/signature selection is separately tested without overrides.
"""
import base64
import contextlib
import hashlib
import http.client
import io
import json
import os
import signal
import ssl
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'manager'))
from pawtalk_manager import bundles, cli, controller, release, runtime, preflight
from pawtalk_manager.config import save, write_config
from release_contract_test import ReleaseTests


def docker(*args,input=None):
    result = subprocess.run(['docker',*args],input=input,capture_output=True,timeout=600)
    if result.returncode:
        raise RuntimeError('Test Docker command failed: '+args[0]+' '+result.stderr.decode(errors='replace')[-1500:])
    return result.stdout.decode().strip()


class ShortRuntime(runtime.Runtime):
    def healthy(self,state,config,expected=None,timeout=20):
        return super().healthy(state,config,expected,timeout)


def origin(repository):
    release.IMAGE = runtime.IMAGE = controller.IMAGE = repository


def worker(root,repository,manifest_path):
    origin(repository)
    class CrashRuntime(ShortRuntime):
        def healthy(self,state,config,expected=None,timeout=20):
            if state['version'] == '0.9.3':
                os.kill(os.getpid(),signal.SIGKILL)
            return super().healthy(state,config,expected,timeout)
    c = controller.Controller(root)
    c.runtime = CrashRuntime(c.template)
    c.update_server(release.verify(Path(manifest_path).read_bytes(),'server',json.loads((c.etc/'trust.json').read_text())))


def main():
    if len(sys.argv)>1 and sys.argv[1] == '--crash-worker':
        worker(*sys.argv[2:])
        return
    if len(sys.argv)>1 and sys.argv[1] == '--install-worker':
        origin(sys.argv[2])
        raise SystemExit(cli.main(sys.argv[3:]))
    source = Path(__file__).resolve().parents[1]
    prefix = 'pawtalk-ci-'+uuid.uuid4().hex[:12]
    encrypted = os.environ.get('PAWTALK_COMPOSE_TEST_E2EE') == 'true'
    for _ in range(100):
        with socket.socket() as free:
            free.bind(('127.0.0.1',0))
            room_port = free.getsockname()[1]
        if room_port <= 65532:
            try:
                preflight.check_ports(room_port)
                break
            except ValueError:
                pass
    else:
        raise RuntimeError('No free room port group')
    base = os.environ.get('PAWTALK_COMPOSE_TEST_IMAGE','pawtalk-server:local')
    if not subprocess.run(['docker','image','inspect',base],capture_output=True).returncode == 0:
        docker('build','-f',str(source/'server/standalone.Dockerfile'),'-t',base,str(source))
    registry,project = prefix+'-registry',None
    fixture = ReleaseTests()
    fixture.setUp()
    with tempfile.TemporaryDirectory(prefix='pawtalk-compose-') as temporary:
        root = Path(temporary)
        c = controller.Controller(root/'host')
        c.runtime = ShortRuntime(c.template)
        try:
            with socket.socket() as free:
                free.bind(('127.0.0.1',0))
                port = free.getsockname()[1]
            docker('run','-d','--name',registry,'--label','io.pawtalk.test='+prefix,'--network','host','-e',f'REGISTRY_HTTP_ADDR=127.0.0.1:{port}','registry:3')
            # Docker returning a container ID does not mean its registry listener is ready.
            for attempt in range(100):
                try:
                    connection = http.client.HTTPConnection('127.0.0.1',port,timeout=1)
                    connection.request('GET','/v2/')
                    ready = connection.getresponse().status == 200
                    connection.close()
                    if ready: break
                except OSError:
                    pass
                time.sleep(0.1)
            else:
                raise RuntimeError('Disposable test registry did not become ready')
            repository = f'127.0.0.1:{port}/pawtalk-server'
            origin(repository)
            digests = []
            for version in ['0.9.0','0.9.1','0.9.2','0.9.3']:
                tag = repository+':'+version
                if version == '0.9.0':
                    docker('tag',base,tag)
                else:
                    definition = f'FROM {base}\nLABEL io.pawtalk.test.revision={version}\n'
                    if version == '0.9.2':
                        definition += 'ENV PAWTALK_LIVEKIT_EXECUTABLE=/missing\nENTRYPOINT ["sh","-c","touch /data/failed-rollout; exec /pawtalk serve"]\n'
                    docker('build','-t',tag,'-',input=definition.encode())
                docker('push',tag)
                values = json.loads(docker('image','inspect',tag))[0]['RepoDigests']
                digests.append(next(v.split('@')[1] for v in values if v.startswith(repository+'@')))
            print('PASS disposable registry and four distinct real image digests')
            unowned = 'pawtalk-'+uuid.uuid4().hex[:12]
            docker('volume','create',unowned)
            try:
                try:
                    c.runtime.create_volume(dict(project=unowned,volume=unowned))
                    raise AssertionError('Unlabelled external volume was adopted')
                except ValueError:
                    pass
            finally:
                docker('volume','rm',unowned)
            print('PASS unowned/unlabelled Docker volume is rejected without adoption')

            def bundle(version):
                file = root/f'manager-{version}.tar.gz'
                with tarfile.open(file,'w:gz') as archive:
                    for name in sorted(bundles.FILES):
                        if name == 'manager/trust.json': data = json.dumps(fixture.keys).encode()
                        elif name == 'manager/VERSION': data = (version+'\n').encode()
                        else: data = (source/name).read_bytes()
                        if name == 'manager/pawtalk_manager/release.py':
                            data = data.replace(b'IMAGE = "ghcr.io/ilyarusskikh/pawtalk-server"',('IMAGE = '+repr(repository)).encode())
                        item = tarfile.TarInfo(name)
                        item.size = len(data)
                        archive.addfile(item,io.BytesIO(data))
                signed = fixture.signed('manager',version=version,bundle=f'PawTalk.Manager.{version}.tar.gz',size=file.stat().st_size,sha256=hashlib.sha256(file.read_bytes()).hexdigest())
                manifest = root/f'manager-{version}.json'
                manifest.write_bytes(signed)
                return file,manifest

            initial_bundle,initial_manifest = bundle('0.1.0')
            def server_release(version,digest):
                return release.verify(fixture.signed(version=version,image=repository,digest=digest),'server',fixture.keys)
            server_manifest = root/'server.json'
            server_manifest.write_bytes(fixture.signed(version='0.9.0',image=repository,digest=digests[0]))
            trust = root/'trust.json'
            trust.write_text(json.dumps(fixture.keys))
            config_file = root/'config.env'
            key_id = hashlib.sha256(b'synthetic local E2EE key identity').hexdigest()
            write_config(config_file,{'PAWTALK_PUBLIC_IP':'127.0.0.1','PAWTALK_PORT':str(room_port),
                         'PAWTALK_E2EE':'true' if encrypted else 'false','PAWTALK_E2EE_KEY_ID':key_id if encrypted else ''})
            command = ['--root',str(c.root),'--lang','en','--no-systemd','install','--config',str(config_file),
                       '--trust',str(trust),'--server-manifest',str(server_manifest),'--manager-manifest',str(initial_manifest),'--bundle',str(initial_bundle)]
            install = subprocess.run([sys.executable,__file__,'--install-worker',repository,*command],capture_output=True,text=True,timeout=180)
            assert install.returncode == 0,install.stderr
            lines = install.stdout.splitlines()
            invitation = next(line for line in lines if line.startswith('pawtalk://'))
            password = lines[lines.index(invitation)+1]
            fingerprint = invitation.rsplit('/',1)[1]
            project = c.state()['project']
            container = c.runtime.container(c.state(),c.config())
            assert container['HostConfig']['NetworkMode'] == 'host'
            assert container['Config']['User'] == '65532:65532'
            assert password not in docker('logs',container['Id'])
            once = subprocess.run(['docker','exec',container['Id'],'/pawtalk','serve','initial-password'],capture_output=True)
            assert once.returncode != 0
            print('PASS signed offline install, non-root Compose, one-time password and no password in logs')

            def api(path,body=None,token=None,expected=200):
                connection = http.client.HTTPSConnection('127.0.0.1',room_port,context=ssl._create_unverified_context(),timeout=10)
                connection.connect()
                assert hashlib.sha256(connection.sock.getpeercert(binary_form=True)).hexdigest() == fingerprint
                headers = {'Content-Type':'application/json'}
                if token: headers['Authorization'] = 'Bearer '+token
                connection.request('POST' if body is not None else 'GET',path,json.dumps(body) if body is not None else None,headers)
                response = connection.getresponse()
                data,status = response.read(),response.status
                connection.close()
                assert status == expected,(path,status,data)
                return json.loads(data)
            login = {'nickname':'CI','password':password,**({'e2ee':True,'e2eeKeyId':key_id} if encrypted else {})}
            if encrypted:
                api('/api/connect',{'nickname':'Missing key','password':password},expected=426)
                api('/api/connect',{**login,'e2eeKeyId':'0'*64},expected=403)
            joined = api('/api/connect',login)
            token = joined['chatToken']
            request_id = uuid.uuid4().hex
            api('/api/chat',dict(requestId=request_id,nonce=base64.b64encode(b'x'*12).decode() if encrypted else '',ciphertext=base64.b64encode(b'local synthetic opaque history payload').decode()),token)
            def preserved():
                api('/api/connect',{**login,'nickname':'After'})
                messages = api('/api/chat?after=0',token=token)['messages']
                assert any(item['requestId'] == request_id for item in messages)
                assert c.runtime.identity(c.state(),c.config()) == c.state()['identity']
                assert api('/api/config')['e2eeRequired'] == encrypted
                assert c.config()['PAWTALK_E2EE_KEY_ID'] == (key_id if encrypted else '')
            original = c.state()
            reinstall = subprocess.run([sys.executable,__file__,'--install-worker',repository,*command],capture_output=True,text=True,timeout=180)
            assert reinstall.returncode == 0,reinstall.stderr
            assert c.state() == original
            checkpoint = c.create_backup()
            print('PASS idempotent reinstall and consistent SQLite backup')
            assert c.update_server(server_release('0.9.1',digests[1]))
            preserved()
            assert c.configure({'PAWTALK_CHAT_MAX_MB':'64'})
            assert c.state()['version'] == '0.9.1'
            assert c.state()['image'].endswith(digests[1])
            print('PASS real Server rollout preserves TLS, password, SQLite; configure retains installed digest')
            try:
                c.update_server(server_release('0.9.2',digests[2]))
                raise AssertionError('Unhealthy rollout was accepted')
            except RuntimeError as error:
                assert 'restored and verified' in str(error)
            preserved()
            container = c.runtime.container(c.state(),c.config())['Id']
            assert subprocess.run(['docker','exec',container,'test','-e','/data/failed-rollout'],capture_output=True).returncode != 0
            print('PASS unhealthy image rollback restores the data/image pair, not just the image')
            crash_manifest = root/'crash-server.json'
            crash_manifest.write_text(server_release('0.9.3',digests[3])['_signed'])
            process = subprocess.run([sys.executable,__file__,'--crash-worker',str(c.root),repository,str(crash_manifest)],capture_output=True,timeout=120)
            assert process.returncode == -signal.SIGKILL
            assert c.journal.exists()
            assert c.recover()
            preserved()
            print('PASS actual controller SIGKILL and durable crash-journal recovery')
            next_bundle,next_manifest = bundle('0.1.1')
            manifest = release.verify(next_manifest.read_bytes(),'manager',fixture.keys)
            old_id = c.runtime.container(c.state(),c.config())['Id']
            assert bundles.activate(c,manifest,fixture.keys,next_bundle,no_systemd=True)
            assert c.runtime.container(c.state(),c.config())['Id'] == old_id
            assert c.state()['version'] == '0.9.1' and c.state()['managerVersion'] == '0.1.1'
            print('PASS Manager-only self-update has no Server restart or digest change')
            c.restore(checkpoint)
            preserved()
            print('PASS explicit backup restore with password/history/TLS verification')
            c.runtime.stop(c.state(),c.config())
            c.runtime.compose(c.state(),c.config(),'down')
            fresh = controller.Controller(root/'fresh-host')
            fresh.runtime = ShortRuntime(fresh.template)
            shutil = __import__('shutil')
            shutil.copytree(c.backups/checkpoint,fresh.backups/checkpoint)
            restored = subprocess.run([sys.executable,__file__,'--install-worker',repository,'--root',str(fresh.root),'--no-systemd','backup','restore',checkpoint,'--trust',str(trust),'--yes'],capture_output=True,text=True,timeout=180)
            assert restored.returncode == 0,restored.stderr
            c = fresh
            # Auth limiter resets on container restart, identities and chat token survive.
            preserved()
            print('PASS restore onto a fresh host directory with a new volume')
        finally:
            if project:
                try: c.runtime.compose(c.state(),c.config(),'down')
                except Exception: pass
                volumes = docker('volume','ls','-q','--filter','label=io.pawtalk.project='+project).splitlines()
                for volume in volumes:
                    info = json.loads(docker('volume','inspect',volume))[0]
                    if info.get('Labels',{}).get('io.pawtalk.project') == project:
                        docker('volume','rm',volume)
            docker('rm','-fv',registry)
            fixture.tearDown()


if __name__ == '__main__': main()
