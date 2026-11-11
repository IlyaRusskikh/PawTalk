"""Disposable native lifecycle; --scm uses real Windows SCM, otherwise console SCM protocol."""
import ctypes
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import ssl
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch

fixtures,stage = map(Path,sys.argv[1:3])
sys.path.insert(0,str(Path(__file__).resolve().parent))
from windows_smoke_support import remove_owned_tree
sys.path.insert(0,str(stage/'bootstrap/manager'))
from pawtalk_manager import bundles, native, release, preflight
from pawtalk_manager.config import atomic, lock
from pawtalk_manager.controller import Controller
from pawtalk_manager.platforms import host as real_host, protect

preflight.supported_windows()
scm = '--scm' in sys.argv
if '--installer' in sys.argv and not scm:
    raise RuntimeError('--installer requires --scm and Administrator')
root = (Path(os.environ['ProgramData'])/('PawTalk-CI-'+fixtures.name.removeprefix('pawtalk-windows-manager-'))) if scm else fixtures/'host'
roots = [root]
if scm and not ctypes.windll.shell32.IsUserAnAdmin():
    raise RuntimeError('--scm requires Administrator; do not silently skip service verification')
build_stage = stage
bootstrap = None
if scm:
    # SCM runs under different accounts; do not assume the runner workspace
    # grants LocalService access to its binaries/runtime.
    bootstrap=root.with_name(root.name+'-bootstrap')
    if bootstrap.exists():raise RuntimeError('Disposable bootstrap already exists')
    shutil.copytree(stage,bootstrap)
    result=subprocess.run([str(bootstrap/'pawtalkctl.exe'),'protect-install',str(bootstrap)],capture_output=True,timeout=180)
    if result.returncode:raise RuntimeError('Unable to protect the disposable service bootstrap')
    stage=bootstrap
    os.environ['PAWTALK_MANAGER_HOST']=str(stage/'pawtalkctl.exe')
process = None
active_root = None
calls = []

def control(action,target):
    global process, active_root
    calls.append(action)
    if scm:
        return real_host(action,target)
    if action in ('install-server','install-manager','start-manager','status-manager','uninstall-server','uninstall-manager','stop-manager'):
        return SimpleNamespace(returncode=0)
    if action == 'status-server':
        return SimpleNamespace(returncode=0 if active_root==Path(target) and process is not None and process.poll() is None else 1)
    if action == 'start-server':
        if process is None or process.poll() is not None:
            process = subprocess.Popen([str(stage/'pawtalkctl.exe'),'--console-service','server',str(target)],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            active_root = Path(target)
        elif active_root!=Path(target):
            raise AssertionError('Console fixture supports one active room at a time')
        return SimpleNamespace(returncode=0)
    if action == 'stop-server':
        if process is not None and active_root==Path(target):
            if process.poll() is None:
                process.stdin.write(b'\n');process.stdin.flush()
            process.wait(timeout=30)
            process.stderr.close()
            process = None
            active_root = None
        return SimpleNamespace(returncode=0)
    raise AssertionError(action)

def fetch(url,limit):
    file = fixtures/url.rsplit('/',1)[-1]
    data = file.read_bytes()
    if len(data)>limit: raise ValueError('oversized fixture')
    return data

def manifest(component,version):
    return release.verify((fixtures/f'{component}-{version}.json').read_bytes(),component,keys)

keys=json.loads((fixtures/'trust.json').read_text())
root.mkdir()
if scm: protect(root)
c=Controller(root)
runtime=c.runtime
# One free adjacent TCP/UDP group; no workstation port assumptions.
for port in range(23000,60000,4):
    sockets=[]
    try:
        for kind,p in [(socket.SOCK_STREAM,port),(socket.SOCK_STREAM,port+1),(socket.SOCK_DGRAM,port+2),(socket.SOCK_STREAM,port+3)]:
            s=socket.socket(socket.AF_INET,kind);s.bind(('127.0.0.1',p));sockets.append(s)
        break
    except OSError: pass
    finally:
        for s in sockets:s.close()
else: raise RuntimeError('No free port range')
media_key='42'*32 # Synthetic loopback test key, never a production room key.
key_id=hashlib.sha256(bytes.fromhex(media_key)).hexdigest()
config=dict(PAWTALK_PUBLIC_IP='127.0.0.1',PAWTALK_PORT=str(port),PAWTALK_E2EE='true',PAWTALK_E2EE_KEY_ID=key_id)
try:
    with patch.object(native,'host',side_effect=control),patch.object(bundles,'host',side_effect=control),patch.object(native,'fetch',side_effect=fetch):
        manager=manifest('manager','0.1.0')
        directory=bundles.stage(root,manager,keys,fixtures/manager['bundle'])
        bundles.switch(root,directory)
        atomic(c.etc/'trust.json',json.dumps(keys).encode())
        with lock(c.directory/'operation.lock'):
            try:
                with lock(c.directory/'operation.lock'):raise AssertionError('lock overlap')
            except ValueError:pass
            check = ('import sys;sys.path.insert(0,'+repr(str(stage/'bootstrap/manager'))+');'
                     'from pawtalk_manager.config import lock;'
                     '\ntry:\n with lock('+repr(str(c.directory/'operation.lock'))+'):sys.exit(2)'
                     '\nexcept ValueError:sys.exit(0)')
            assert subprocess.run([sys.executable,'-X','utf8','-I','-c',check],capture_output=True).returncode==0
        c.install(config,manifest('server','0.9.0'),directory/'manager/compose.server.yaml','0.1.0')
        before=c.state()
        invitation=runtime.command(before,c.config(),'info')
        password=runtime.command(before,c.config(),'initial-password')
        assert password.strip() and b'pawtalk://' in invitation
        assert password.strip() not in (root/'var/log/pawtalk/server.log').read_bytes()
        try:runtime.command(before,c.config(),'initial-password');raise AssertionError('password reused')
        except RuntimeError:pass
        def login(extra=None,expected=200):
            saved=json.loads((runtime.data(c.state())/'state.json').read_text())
            context=ssl.create_default_context(cadata=saved['Certificate'])
            connection=http.client.HTTPSConnection('127.0.0.1',port,context=context,timeout=10)
            body=dict(nickname='Native CI',password=password.decode().strip(),e2ee=True,e2eeKeyId=key_id)
            body.update(extra or {})
            connection.request('POST','/api/connect',json.dumps(body),{'Content-Type':'application/json'})
            response=connection.getresponse();response.read();status=response.status;connection.close()
            assert status==expected
        login()
        login({'e2ee':False,'e2eeKeyId':''},426)
        login({'e2eeKeyId':'b'*64},403)
        env={**os.environ,'PAWTALK_TEST_SERVER':f'https://127.0.0.1:{port}',
             'PAWTALK_TEST_INVITATION':invitation.decode().strip(),'PAWTALK_TEST_PASSWORD':password.decode().strip(),
             'PAWTALK_TEST_MEDIA_KEY':media_key}
        env.pop('ELECTRON_RUN_AS_NODE',None)
        audio=subprocess.run([os.environ['PAWTALK_ELECTRON'],str(Path(__file__).resolve().parents[1]/'scripts/integration.cjs')],
                             env=env,capture_output=True,timeout=180,creationflags=subprocess.CREATE_NO_WINDOW)
        if audio.returncode:
            import re
            report=(audio.stdout+audio.stderr).decode(errors='replace')
            for value in [password.decode().strip(),media_key,invitation.decode().strip()]:report=report.replace(value,'[redacted]')
            report=re.sub(r'eyJ[A-Za-z0-9._-]+','[token redacted]',report)
            file=Path(__file__).resolve().parents[1]/'release/qa/native-windows-audio-failure.txt'
            file.parent.mkdir(parents=True,exist_ok=True);file.write_text(report,encoding='utf-8')
            raise RuntimeError('Native encrypted RTP check failed; see release/qa/native-windows-audio-failure.txt')
        print('PASS native Windows encrypted bidirectional Opus/RTP, PTT, mute and rejoin with two actual Electron clients (synthetic audio)')
        c.install(config,{},directory/'manager/compose.server.yaml','')
        assert c.state()==before
        print('PASS native install, E2EE health, identity, one-time password, reinstall and cross-process lock')
        def probe():
            with sqlite3.connect(runtime.data(c.state())/'chat.sqlite') as db:
                return db.execute('SELECT value FROM manager_smoke_probe').fetchone()[0]
        with sqlite3.connect(runtime.data(c.state())/'chat.sqlite') as db:
            db.execute('CREATE TABLE manager_smoke_probe(value TEXT)')
            db.execute('INSERT INTO manager_smoke_probe VALUES (?)',('original',))
        backup=c.create_backup()
        artifact=fixtures/'PawTalk.Server.0.9.1.windows-x64.zip'
        correct=artifact.read_bytes()
        artifact.write_bytes(bytes([correct[0]^1])+correct[1:])
        invalid=manifest('server','0.9.1')
        try:
            runtime.pull({**c.state(),'version':invalid['version'],'windows':invalid['windows']})
            raise AssertionError('tampered archive accepted')
        except ValueError:pass
        finally:artifact.write_bytes(correct)
        start=runtime.start
        def fail(candidate,values):
            if candidate['version']=='0.9.1':
                (runtime.data(candidate)/'chat.sqlite').write_bytes(b'injected failed rollout mutation')
                raise RuntimeError('injected native start failure')
            return start(candidate,values)
        with patch.object(runtime,'start',side_effect=fail):
            try:c.update_server(manifest('server','0.9.1'));raise AssertionError('update accepted')
            except RuntimeError:pass
        assert c.state()['version']=='0.9.0'
        assert probe()=='original'
        assert runtime.command(c.state(),c.config(),'info')==invitation
        c.update_server(manifest('server','0.9.2'))
        assert c.state()['version']=='0.9.2'
        assert not c.configure({'PAWTALK_SERVER_AUTO_UPDATE':'true','PAWTALK_MANAGER_AUTO_UPDATE':'true'})
        count=calls.count('start-server')
        with lock(c.directory/'operation.lock'):
            assert bundles.activate(c,manifest('manager','0.1.1'),keys,fixtures/'PawTalk.Manager.0.1.1.tar.gz')
            assert calls.count('start-server')==count
            assert c.state()['managerVersion']=='0.1.1'
            c.restore(backup)
        assert c.state()['version']=='0.9.0' and c.state()['managerVersion']=='0.1.1'
        assert runtime.command(c.state(),c.config(),'info')==invitation
        print('PASS native backup, failed-update data rollback, Server update, Manager-only update without server restart, restore')
        if not scm:
            process.kill()
            process.wait(timeout=10)
            process.stderr.close()
            process = None
            # OS job cleanup must release media TCP/UDP, not merely the API process.
            import time
            for attempt in range(50):
                sockets=[]
                try:
                    for kind,p in [(socket.SOCK_STREAM,port+1),(socket.SOCK_DGRAM,port+2),(socket.SOCK_STREAM,port+3)]:
                        s=socket.socket(socket.AF_INET,kind);s.bind(('127.0.0.1',p));sockets.append(s)
                    break
                except OSError:
                    time.sleep(0.1)
                finally:
                    for s in sockets:s.close()
            else:raise AssertionError('Server/LiveKit orphan survived its service job')
            runtime.start(c.state(),c.config())
            runtime.healthy(c.state(),c.config(),c.state()['identity'])
            assert probe()=='original'
            print('PASS killing the service host releases its entire process tree and preserves room data')
        # The signed verifier must fail closed independently of source/HTTP fixtures.
        raw=json.loads((fixtures/'server-0.9.0.json').read_text());raw['signature']='A'*88
        try:release.verify(json.dumps(raw).encode(),'server',keys);raise AssertionError('signature accepted')
        except ValueError:pass
        print('PASS actual Go Ed25519 verification rejects tampering')
        old=c
        assert control('stop-server',old.root).returncode==0
        assert control('stop-manager',old.root).returncode==0
        root = old.root.with_name(old.root.name+'-fresh')
        roots.append(root)
        root.mkdir()
        if scm:protect(root)
        c=Controller(root)
        runtime=c.runtime
        target=c.backups/backup
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copytree(old.backups/backup,target)
        meta,_=c.snapshot(backup)
        release.verify_snapshot(meta,keys)
        manager=release.verify_historical((target/'manager-manifest.json').read_bytes(),'manager',keys)
        directory=bundles.stage(root,manager,keys,target/'manager.tar.gz')
        bundles.switch(root,directory)
        atomic(c.etc/'trust.json',json.dumps(keys).encode())
        with lock(c.directory/'operation.lock'):
            c.restore(backup)
            bundles.install_units(root,directory,c.config())
        assert runtime.command(c.state(),c.config(),'info')==invitation
        assert probe()=='original'
        assert c.state()['managerVersion']=='0.1.0'
        login()
        print('PASS native fresh-root restore authenticates archived Server/Manager and preserves SQLite/TLS/password identity')
        if '--installer' in sys.argv:
            import time
            import winreg
            program=Path(os.environ['ProgramFiles'])/'PawTalk Server Manager'
            registration=r'SOFTWARE\PawTalk\ServerManager'
            uninstall_key=r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawTalkServerManager'
            menu=Path(os.environ['ProgramData'])/'Microsoft/Windows/Start Menu/Programs/PawTalk Server Manager'
            def exists_key(name):
                try:
                    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,name,0,winreg.KEY_READ|winreg.KEY_WOW64_64KEY):return True
                except FileNotFoundError:return False
            if program.exists() or menu.exists() or exists_key(registration) or exists_key(uninstall_key):
                raise RuntimeError('Installer smoke refuses to touch an existing Manager installation')
            for target_root in roots:
                assert control('stop-server',target_root).returncode==0
                assert control('stop-manager',target_root).returncode==0
            install_root=roots[0].with_name(roots[0].name+'-installer')
            roots.append(install_root)
            config_file=fixtures/'installer.env'
            # This input is public configuration. Signed private fixture roots are explicit.
            config_file.write_text(''.join(k+'='+v+'\n' for k,v in {**config,'PAWTALK_LANGUAGE':'en'}.items()),encoding='utf-8')
            version=(stage/'bootstrap/manager/VERSION').read_text().strip()
            setup=build_stage.parent/f'PawTalk.Server.Manager.Setup.{version}.exe'
            arguments=[str(setup),'/S',f'/ROOT={install_root}',f'/CONFIG={config_file}',f'/TRUST={fixtures/"trust.json"}',
                       f'/SERVERMANIFEST={fixtures/"server-0.9.0.json"}',f'/MANAGERMANIFEST={fixtures/"manager-0.1.0.json"}',
                       f'/BUNDLE={fixtures/"PawTalk.Manager.0.1.0.tar.gz"}',f'/SERVERBUNDLE={fixtures/"PawTalk.Server.0.9.0.windows-x64.zip"}']
            try:
                result=subprocess.run(arguments,capture_output=True,timeout=240)
                if result.returncode:raise RuntimeError('Actual EXE installation failed')
                installed=program/'pawtalkctl.exe'
                assert installed.is_file() and (program/'Uninstall.exe').is_file()
                assert hashlib.sha256(installed.read_bytes()).digest()==hashlib.sha256((stage/'pawtalkctl.exe').read_bytes()).digest()
                for attempt in range(20):
                    status=subprocess.run([str(installed),'--root',str(install_root),'status'],capture_output=True,timeout=30)
                    if status.returncode==0:
                        result=json.loads(status.stdout)
                        if result.get('installed') and result.get('health')=='Healthy':break
                    time.sleep(0.5)
                else:raise RuntimeError('Installed server did not become healthy')
                assert not list((install_root/'var/lib/pawtalk-data').glob('*/initial-password'))
                # Execute the actual generated Windows uninstaller, not an emulation.
                removed=subprocess.run([str(program/'Uninstall.exe'),'/S'],capture_output=True,timeout=120)
                if removed.returncode:raise RuntimeError('Actual EXE uninstall failed')
                for attempt in range(100):
                    if not exists_key(uninstall_key):break
                    time.sleep(0.2)
                else:raise RuntimeError('Windows uninstaller did not finish')
                assert (install_root/'var/lib/pawtalk-manager/installed.json').is_file()
                print('PASS actual silent EXE install, embedded runtime, signed offline artifacts, services and data-preserving uninstaller')
            finally:
                installer_error=sys.exception()
                try:
                    # Only this fresh, exact product directory may be removed; never
                    # recursively delete a pre-existing installation or unrelated path.
                    if program.exists() and (program/'pawtalkctl.exe').is_file():
                        matching=hashlib.sha256((program/'pawtalkctl.exe').read_bytes()).digest()==hashlib.sha256((stage/'pawtalkctl.exe').read_bytes()).digest()
                        if matching and program.parent.resolve()==Path(os.environ['ProgramFiles']).resolve() and program.name=='PawTalk Server Manager':
                            for action in ['stop-server','stop-manager','uninstall-manager','uninstall-server']:
                                real_host(action,install_root)
                            remove_owned_tree(program,Path(os.environ['ProgramFiles']),'PawTalk Server Manager')
                            if menu.exists():
                                if menu.parent.resolve()!=(Path(os.environ['ProgramData'])/'Microsoft/Windows/Start Menu/Programs').resolve():
                                    raise RuntimeError('Unsafe shortcut cleanup path')
                                remove_owned_tree(menu,menu.parent,'PawTalk Server Manager')
                            for name in [uninstall_key,registration]:
                                try:winreg.DeleteKeyEx(winreg.HKEY_LOCAL_MACHINE,name,winreg.KEY_WOW64_64KEY)
                                except FileNotFoundError:pass
                except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as cleanup_error:
                    if installer_error is None:raise
                    print("Installer cleanup failed: "+type(cleanup_error).__name__+"; original error preserved",file=sys.stderr)
finally:
    primary_error=sys.exception()
    cleanup_errors=[]
    clean = True
    for target in roots:
        for action in ['stop-server','stop-manager','uninstall-manager','uninstall-server']:
            try:
                if control(action,target).returncode: clean = False
            except Exception: clean = False
    if scm and clean:
        for target in roots+([bootstrap] if bootstrap else []):
            if target.parent.resolve()!=Path(os.environ['ProgramData']).resolve() or not target.name.startswith('PawTalk-CI-'):
                raise RuntimeError('Unsafe SCM test cleanup path')
            try:remove_owned_tree(target,Path(os.environ['ProgramData']),'PawTalk-CI-')
            except OSError as error:cleanup_errors.append(type(error).__name__)
    if not clean:
        cleanup_errors.append('service cleanup failed; test root retained')
    if cleanup_errors:
        message='Windows test cleanup: '+', '.join(cleanup_errors)
        if primary_error is not None:print(message,file=sys.stderr)
        else:raise RuntimeError(message)
print('PASS real Windows SCM lifecycle' if scm else 'PASS Windows console service/job lifecycle (SCM registration not exercised)')
