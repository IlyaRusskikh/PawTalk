from source_layout import bundle_source
"""Real Docker/Compose, local registry and ephemeral signing keys; no publication.

Run on Linux or in tests/integration/vps.Dockerfile with the test-only Docker socket mount.
Only image-origin constants are redirected to the disposable local registry.
The production allowlist/signature selection is separately tested without overrides.
Pass --interactive-tui from a terminal to open the installed Manager with the test Server stopped.
Pass --protected-migration to isolate the signed migration and post-cutover restart scenario.
Pass --protected-migration-prepare to isolate maintenance restart and explicit rollback.
"""
import base64
import contextlib
import errno
import hashlib
import http.client
import io
import json
import os
import pty
import random
import re
import select
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
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'apps/manager/linux'))
from pawtalk_manager import bundles, cli, controller, release, runtime, preflight
from pawtalk_manager.config import lock, save, write_config
from protected_migration_smoke import activate_and_verify
from release_contract_test import ReleaseTests


def docker(*args,input=None):
    result = subprocess.run(['docker',*args],input=input,capture_output=True,timeout=600)
    if result.returncode:
        raise RuntimeError('Test Docker command failed: '+args[0]+' '+result.stderr.decode(errors='replace')[-1500:])
    return result.stdout.decode().strip()


def terminal_menu(root,answers):
    launcher = root/'opt/pawtalk-manager/launcher'
    master,slave = pty.openpty()
    command = [sys.executable,str(launcher),'--root',str(root),'--lang','en','--no-systemd','tui']
    try:
        with subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,env={**os.environ,'TERM':'dumb'}) as process:
            os.close(slave)
            slave = None
            output = bytearray()
            try:
                os.write(master,answers.encode())
                deadline = time.monotonic()+120
                while time.monotonic()<deadline:
                    if not select.select([master],[],[],0.2)[0]:
                        continue
                    try:
                        chunk = os.read(master,65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        break
                    if not chunk:
                        break
                    output.extend(chunk)
                rendered = output.decode(errors='replace')
                assert process.wait(timeout=2) == 0,rendered
                return rendered
            finally:
                if process.poll() is None:
                    process.kill()
    finally:
        os.close(master)
        if slave is not None:
            os.close(slave)


class ShortRuntime(runtime.Runtime):
    def healthy(self,state,config,expected=None,timeout=20):
        return super().healthy(state,config,expected,timeout)


def origin(repository):
    release.IMAGE = runtime.IMAGE = controller.IMAGE = repository


def protected_migration(c, client_file, source, *, cutover=True):
    installed, config = c.state(), c.config()
    address = c.runtime.command(installed,config,'info').decode().strip()
    certificate = ssl.get_server_certificate(('127.0.0.1',int(config['PAWTALK_PORT'])),timeout=10)
    prepared = c.prepare_protected_migration()
    assert prepared['phase'] == 'migration-prepared' and c.state() == installed
    checkpoint = prepared['checkpoint']
    server_id, archive_sha = checkpoint['serverId'], checkpoint['backupArchiveSha256']
    assert checkpoint['maintenance'] is True and checkpoint['dataSchema'] == 3
    _, archive = c.snapshot(prepared['backup'])
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == archive_sha
    with tarfile.open(archive) as contents:
        databases = [item for item in contents if item.isfile() and item.name.removeprefix('./') == 'membership-v2.sqlite']
        assert len(databases) == 1
        with contents.extractfile(databases[0]) as database:
            assert hashlib.file_digest(database,'sha256').hexdigest() == checkpoint['backupSha256']

    def request(path, status, headers=None):
        context = ssl.create_default_context(cadata=certificate)
        with contextlib.closing(http.client.HTTPSConnection('127.0.0.1',int(config['PAWTALK_PORT']),context=context,timeout=10)) as connection:
            connection.request('GET',path,headers=headers or {})
            response = connection.getresponse()
            body = response.read()
            assert response.status == status, (path, response.status)
            return json.loads(body)

    health = '/api/v3/migration/healthz'
    headers = {'X-PawTalk-Migration-Checkpoint':archive_sha}
    assert request(health,200,headers) == {'status':'maintenance'}
    request(health,409,{'X-PawTalk-Migration-Checkpoint':'0'*64})
    request('/api/config',503)
    c.runtime.stop(installed,config)
    restarted = controller.Controller(c.root)
    restarted.runtime = ShortRuntime(restarted.template)
    assert restarted.prepare_protected_migration() == prepared
    assert list(restarted.backups.glob('backup-*')) == [archive.parent]
    assert request(health,200,headers) == {'status':'maintenance'}

    if not cutover:
        restarted.rollback_protected_migration()
        assert restarted.migration_status() == {'phase':'inactive'}
        assert restarted.state()['volume'] != installed['volume']
        assert restarted.state()['identity'] == installed['identity']
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == archive_sha
        assert request('/api/config',200)['apiProtocolVersion'] == 2
        return

    script = source/'apps/manager/tests/protected_migration_client.cjs'

    def client(phase, **fields):
        request = dict(phase=phase,file=str(client_file),address=address,certificate=certificate,serverId=server_id,
                       archiveSha256=archive_sha,ownerProfileId=checkpoint['ownerProfileId'],**fields)
        result = subprocess.run(['node',str(script)],input=json.dumps(request),capture_output=True,text=True,timeout=100)
        if result.returncode:
            raise RuntimeError(f'Migration Client failed at {phase}: {result.stderr}')
        return json.loads(result.stdout)

    activate_and_verify(restarted,prepared,client)
    print('PASS protected cutover in real Compose, TLS and decrypted history after restart, original API 2 archive preserved')


def choose_room_port(*,exclude=(),ephemeral_range=None,candidates=None):
    """Keep the fixture's listeners outside Linux's outgoing source-port pool."""
    if ephemeral_range is None:
        ephemeral_range=tuple(map(int,Path('/proc/sys/net/ipv4/ip_local_port_range').read_text().split()))
    low,high=ephemeral_range
    def eligible(port):
        return 10000<=port<=65532 and (port+3<low or port>high) and not any(port<=used<=port+3 for used in exclude)
    if candidates is None:
        pool=[port for port in range(10000,65533) if eligible(port)]
        candidates=random.SystemRandom().sample(pool,min(100,len(pool)))
    for port in candidates:
        if not eligible(port):continue
        try:
            preflight.check_ports(port)
            return port
        except ValueError:
            pass
    raise RuntimeError('No free room port group outside the ephemeral range')


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
    interactive = '--interactive-tui' in sys.argv[1:]
    if interactive and not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise SystemExit('--interactive-tui needs a terminal (docker run -it)')
    source = Path(__file__).resolve().parents[3]
    prefix = 'pawtalk-ci-'+uuid.uuid4().hex[:12]
    base = os.environ.get('PAWTALK_COMPOSE_TEST_IMAGE','pawtalk-server:local')
    if not subprocess.run(['docker','image','inspect',base],capture_output=True).returncode == 0:
        docker('build','-f',str(source/'apps/server/deploy/standalone.Dockerfile'),'-t',base,str(source))
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
            docker('run','-d','--name',registry,'--label','io.pawtalk.test='+prefix,'--network','host',
                   '-e',f'REGISTRY_HTTP_ADDR=127.0.0.1:{port}','-e','REGISTRY_HTTP_DEBUG_ADDR=127.0.0.1:0','registry:3')
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
                logs = subprocess.run(['docker','logs','--tail','20',registry],capture_output=True,text=True,timeout=10)
                raise RuntimeError('Disposable test registry did not become ready\n'+logs.stdout+logs.stderr)
            repository = f'127.0.0.1:{port}/pawtalk-server'
            origin(repository)
            digests = []
            for version in ['0.9.0','0.9.1','0.9.2','0.9.3']:
                tag = repository+':'+version
                # A published multiarch index can reference platforms not pulled
                # locally. Materialize this runner's test image, reusing binaries
                # unchanged instead of retagging the remote index into our registry.
                definition = f'FROM {base}\nLABEL io.pawtalk.test.revision={version}\n'
                if version == '0.9.2':
                    definition += 'ENV PAWTALK_LIVEKIT_EXECUTABLE=/missing\nENTRYPOINT ["sh","-c","touch /data/failed-rollout; exec /pawtalk serve"]\n'
                docker('build','-t',tag,'-',input=definition.encode())
                docker('push',tag)
                values = json.loads(docker('image','inspect',tag))[0]['RepoDigests']
                digests.append(next(v.split('@')[1] for v in values if v.startswith(repository+'@')))
                docker('pull',repository+'@'+digests[-1])
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
                        else: data = bundle_source(name).read_bytes()
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
            # Choose after registry/image preparation: those operations create
            # outgoing connections and the registry itself owns a host port.
            room_port=choose_room_port(exclude=(port,))
            print(f'QA Server ports {room_port}..{room_port+3}; registry port {port}')
            write_config(config_file,{'PAWTALK_PUBLIC_IP':'127.0.0.1','PAWTALK_PORT':str(room_port)})
            command = ['--root',str(c.root),'--lang','en','--no-systemd','install','--config',str(config_file),
                       '--trust',str(trust),'--server-manifest',str(server_manifest),'--manager-manifest',str(initial_manifest),'--bundle',str(initial_bundle)]
            install = subprocess.run([sys.executable,__file__,'--install-worker',repository,*command],capture_output=True,text=True,timeout=180)
            # Installation can fail after creating the labelled room. Preserve
            # its ownership identity so finally still removes this test fixture.
            if c.state_file.exists():
                project = c.state()['project']
            assert install.returncode == 0,install.stderr
            if interactive:
                launcher = c.root/'opt/pawtalk-manager/launcher'
                entry = [sys.executable,str(launcher),'--root',str(c.root)]
                subprocess.run([*entry,'stop','--yes'],check=True)
                raise SystemExit(subprocess.run([*entry,'tui']).returncode)
            lines = install.stdout.splitlines()
            invitation = next(line for line in lines if line.startswith('pawtalk://'))
            fingerprint = invitation.split('#')[0].rsplit('/',1)[1]
            project = c.state()['project']
            container = c.runtime.container(c.state(),c.config())
            assert container['HostConfig']['NetworkMode'] == 'host'
            assert container['Config']['User'] == '65532:65532'
            assert invitation not in docker('logs',container['Id'])
            def native_client(mode):
                subprocess.run(['node',str(source/'apps/client/windows/tests/membership-host-client.cjs'),mode,str(root),invitation],check=True,timeout=45)
            native_client('join')
            assert c.runtime.initialized(c.state(),c.config()) is True
            assert c.runtime.invitation(c.state(),c.config()) is None
            once = subprocess.run(['docker','exec',container['Id'],'/pawtalk','serve','initial-admin'],capture_output=True)
            assert once.returncode != 0
            print('PASS signed offline install, non-root Compose, one-time first-admin admission and no invitation in logs')
            prepare_migration = '--protected-migration-prepare' in sys.argv[1:]
            if prepare_migration or '--protected-migration' in sys.argv[1:]:
                with lock(c.directory/'operation.lock'):
                    protected_migration(c,root/'client-keys.json',source,cutover=not prepare_migration)
                if prepare_migration:
                    native_client('verify')
                    print('PASS real Compose: reentered maintenance after restart, rolled back explicitly to API 2 and reopened encrypted history')
                return

            assert 'Cancelled.' in terminal_menu(c.root,'1\n3\n\n0\n0\n')
            assert c.runtime.container(c.state(),c.config())['State']['Running']
            assert 'Stopped' in terminal_menu(c.root,'1\n3\ny\n\n0\n0\n')
            assert not c.runtime.container(c.state(),c.config())['State']['Running']
            assert 'Changes applied.' in terminal_menu(c.root,'1\n2\n\n0\n0\n')
            c.runtime.healthy(c.state(),c.config(),c.state()['identity'])
            print('PASS installed Manager launcher opens the TUI in a Linux PTY and controls Compose')

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
            api('/api/v2/state',expected=401)
            api('/api/connect',{'nickname':'Legacy'},expected=426)
            def preserved():
                native_client('verify')
                assert c.runtime.identity(c.state(),c.config()) == c.state()['identity']
                assert api('/api/config')['e2eeRequired'] is True
                assert api('/api/config')['apiProtocolVersion'] == 2
            original = c.state()
            reinstall = subprocess.run([sys.executable,__file__,'--install-worker',repository,*command],capture_output=True,text=True,timeout=180)
            assert reinstall.returncode == 0,reinstall.stderr
            assert c.state() == original
            backup_output = terminal_menu(c.root,'5\n1\ny\n\n0\n0\n')
            created = re.search(r'^backup-[a-f0-9]{12}\r?$',backup_output,re.MULTILINE)
            assert created,backup_output
            checkpoint = created.group().rstrip('\r')
            c.snapshot(checkpoint)
            print('PASS idempotent reinstall and consistent SQLite backup from the TUI')
            update_manifest = root/'update-server.json'
            update_manifest.write_text(server_release('0.9.1',digests[1])['_signed'])
            assert 'Changes applied.' in terminal_menu(c.root,f'4\n3\n{update_manifest}\ny\n\n0\n0\n')
            assert c.state()['version'] == '0.9.1'
            preserved()
            assert c.configure({'PAWTALK_CHAT_MAX_MB':'64'})
            assert c.state()['version'] == '0.9.1'
            assert c.state()['image'].endswith(digests[1])
            print('PASS real Server rollout preserves TLS, membership, encrypted SQLite; configure retains installed digest')
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
            launcher = c.root/'opt/pawtalk-manager/launcher'
            listed = subprocess.check_output([sys.executable,str(launcher),'--root',str(c.root),'backup','list','--json'])
            choices = [entry['name'] for entry in json.loads(listed)]
            choice = choices.index(checkpoint)+1
            before_restore = c.state()
            assert 'Cancelled.' in terminal_menu(c.root,f'5\n2\n{choice}\nn\n0\n0\n')
            assert c.state() == before_restore
            assert 'Changes applied.' in terminal_menu(c.root,f'5\n2\n{choice}\ny\n\n0\n0\n')
            assert c.state()['version'] == '0.9.0' and c.state()['managerVersion'] == '0.1.1'
            preserved()
            print('PASS TUI backup selection, cancellation and restore with membership/encrypted-history/TLS verification')
            fresh = controller.Controller(root/'fresh-host')
            fresh.runtime = ShortRuntime(fresh.template)
            shutil = __import__('shutil')
            shutil.copytree(c.backups/checkpoint,fresh.backups/checkpoint)

            assert 'Changes applied.' in terminal_menu(c.root,'4\n4\n1\n\n0\n0\n')
            assert c.config()['PAWTALK_SERVER_AUTO_UPDATE'] == 'true' and c.config()['PAWTALK_MANAGER_AUTO_UPDATE'] == 'false'
            assert 'Changes applied.' in terminal_menu(c.root,'3\n2\n96\ny\n\n0\n0\n')
            assert c.config()['PAWTALK_CHAT_MAX_MB'] == '96'
            assert 'already initialized' in terminal_menu(c.root,'1\n4\n\n0\n0\n')
            extra = re.search(r'^backup-[a-f0-9]{12}\r?$',terminal_menu(c.root,'5\n1\ny\n\n0\n0\n'),re.MULTILINE)
            assert extra
            extra = extra.group().rstrip('\r')
            listed = subprocess.check_output([sys.executable,str(launcher),'--root',str(c.root),'backup','list','--json'])
            choice = [entry['name'] for entry in json.loads(listed)].index(extra)+1
            assert 'Changes applied.' in terminal_menu(c.root,f'5\n3\n{choice}\ny\n\n0\n0\n')
            assert not (c.backups/extra).exists()
            print('PASS TUI history, independent update preferences, initialized admission and backup removal')

            original_info = c.runtime.command(c.state(),c.config(),'info').decode().strip()
            original_status = c.runtime.command(c.state(),c.config(),'status')
            new_port = choose_room_port(exclude=range(room_port,room_port+4))
            port_result = terminal_menu(c.root,f'2\n2\n\n{new_port}\ny\n\n0\n0\n')
            assert 'Changes applied.' in port_result,port_result
            port_info = c.runtime.command(c.state(),c.config(),'info').decode().strip()
            assert port_info == f'pawtalk://127.0.0.1:{new_port}/{original_info.rsplit("/",1)[1]}'
            address_result = terminal_menu(c.root,'2\n2\n127.0.0.2\n\ny\n\n0\n0\n')
            assert 'Changes applied.' in address_result,address_result
            address_info = c.runtime.command(c.state(),c.config(),'info').decode().strip()
            assert address_info.startswith(f'pawtalk://127.0.0.2:{new_port}/')
            assert address_info.rsplit('/',1)[1] != port_info.rsplit('/',1)[1]
            assert json.loads(c.runtime.command(c.state(),c.config(),'status')) == json.loads(original_status)
            assert c.runtime.identity(c.state(),c.config()) == c.state()['identity']
            print('PASS TUI port change preserves TLS and address change preserves initialized room identity with a new certificate')

            c.runtime.stop(c.state(),c.config())
            c.runtime.compose(c.state(),c.config(),'down')
            restored = subprocess.run([sys.executable,__file__,'--install-worker',repository,'--root',str(fresh.root),'--no-systemd','backup','restore',checkpoint,'--trust',str(trust),'--yes'],capture_output=True,text=True,timeout=180)
            assert restored.returncode == 0,restored.stderr
            c = fresh
            # Reauthenticate from the same synthetic device after fresh-host restore.
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
