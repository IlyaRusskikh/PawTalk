"""Disposable native lifecycle; --scm uses real Windows SCM, otherwise console SCM protocol."""
import ctypes
from contextlib import closing
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
repository = Path(__file__).resolve().parents[3]
sys.path.insert(0,str(Path(__file__).resolve().parent))
from windows_smoke_support import assert_manager_only_layout, remove_owned_tree
sys.path.insert(0,str(stage/'bootstrap/manager'))
from pawtalk_manager import bundles, native, release, preflight, cli
from pawtalk_manager.config import atomic, lock
from pawtalk_manager.controller import Controller
from pawtalk_manager.platforms import host as real_host, protect

preflight.supported_windows()
assert subprocess.run([str(stage/'pawtalk-server-tray.exe'),'--self-test'],capture_output=True,timeout=45).returncode==0,'GUI -> Python -> console host DPAPI protocol failed'
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

def control(action,target=None,**kwargs):
    global process, active_root
    calls.append(action)
    if action in ('seal-credential','unseal-credential'):
        return real_host(action,**kwargs)
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
config=dict(PAWTALK_PUBLIC_IP='127.0.0.1',PAWTALK_PORT=str(port))
client_directory=fixtures/'native-client'
client_result=fixtures/'membership-result.json'
def run_client(mode,address=None):
    input_file=fixtures/'membership-input.json'
    input_file.write_text(json.dumps(dict(mode=mode,address=address or runtime.command(c.state(),c.config(),'info').decode().strip())),encoding='utf-8')
    env={**os.environ,'PAWTALK_APP_TEST_DIR':str(client_directory),'PAWTALK_APP_TEST_INPUT':str(input_file),'PAWTALK_APP_TEST_OUTPUT':str(client_result)}
    env.pop('ELECTRON_RUN_AS_NODE',None)
    result=subprocess.run([os.environ['PAWTALK_ELECTRON'],str(repository/'apps/manager/windows/tests/manager-membership-client.cjs')],env=env,capture_output=True,timeout=45,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        report=(result.stdout+result.stderr).decode(errors='replace')
        if address:report=report.replace(address,'[invitation redacted]')
        raise RuntimeError('Native API 2 client failed: '+report)
    return json.loads(client_result.read_text())
try:
    with patch.object(native,'host',side_effect=control),patch.object(bundles,'host',side_effect=control),patch.object(native,'fetch',side_effect=fetch):
        fresh_root=root.with_name(root.name+'-first-ui');roots.append(fresh_root)
        if scm: protect(fresh_root)
        fresh=Controller(fresh_root)
        initial_calls=len(calls)
        with patch.object(native,'fetch',side_effect=AssertionError('Manager install fetched Server')):
            native.install_manager_only(fresh,stage/'bootstrap/manager','en')
        assert len(calls)==initial_calls and not fresh.state_file.exists()
        assert_manager_only_layout(fresh_root)
        # Copy a raw local archive without its fixture signature: tests the same
        # explicit unsigned-package confirmation path as manual API2 review.
        local=fixtures/'local';local.mkdir();local_zip=local/'PawTalk.Server.0.9.0.windows-x64.zip'
        shutil.copyfile(fixtures/local_zip.name,local_zip)
        package=native.inspect_server_package(fresh,str(local_zip))
        defaults=native.manager_values(fresh)
        values={k:defaults[k] for k in cli.SETTINGS_FIELDS};values.update(config)
        with patch.object(native,'fetch',side_effect=AssertionError('Local setup fetched Server')),patch.object(preflight,'check',side_effect=lambda values:preflight.check_ports(int(values['PAWTALK_PORT']))):
            native.setup_server(fresh,dict(source='local',id=package['id'],expected=defaults,values=values),stage/'bootstrap/manager')
        assert fresh.runtime.container(fresh.state(),fresh.config())['State']['Running']
        assert fresh.state()['localPackage']==package['id'] and not (fresh.directory/'setup.json').exists()
        fresh.runtime.stop(fresh.state(),fresh.config());control('stop-manager',fresh_root)
        print('PASS Manager-only install: no network/service; explicit first UI local setup runs actual API2 core')
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
        if scm:
            snapshot=cli.desktop_execute(c,'snapshot',{})
            public_file=stage/('status-'+hashlib.sha256(str(root).lower().encode()).hexdigest()[:16]+'.json')
            public=json.loads(public_file.read_text())
            assert public['serverVersion']==snapshot['serverVersion']
            assert set(public)=={'update','language','autoManager','serverVersion','managerVersion'}
            assert 'values' not in public and 'password' not in public
            print('PASS actual desktop snapshot and public status publication through native host ACL boundary')
            launcher=stage/'bootstrap/manager/pawtalkctl'
            original=launcher.read_bytes()
            # Fault injection is confined to this disposable, protected test host.
            slow=b"\nfrom pawtalk_manager import cli\nif 'desktop' in sys.argv:\n import time\n def slow(*args,**kwargs):\n  time.sleep(4)\n  return None\n cli.discover_desktop=slow\n"
            try:
                launcher.write_bytes(original.replace(b'from pawtalk_manager.cli import main',slow+b'\nfrom pawtalk_manager.cli import main'))
                broker=subprocess.run(['node',str(repository/'apps/manager/windows/tests/manager-broker.cjs'),str(stage),str(root)],capture_output=True,timeout=150)
                assert broker.returncode==0,broker.stderr.decode(errors='replace')
                print(broker.stdout.decode().strip())
            finally:launcher.write_bytes(original)
            if '--desktop-backups-only' in sys.argv:
                runtime.healthy(c.state(),c.config(),before['identity'])
                print('PASS targeted desktop backup integration with actual SCM and retained room identity')
                raise SystemExit(0)
            restricted=subprocess.run([str(fixtures/'clipboard-test.exe'),'-test.run=^TestStopSCMServiceWithoutDebugPrivilege$'],
                                      env={**os.environ,'PAWTALK_SCM_NO_DEBUG_TEST_ROOT':str(root)},capture_output=True,timeout=90)
            assert restricted.returncode==0,'Actual SCM stop failed with SeDebugPrivilege disabled'
            assert control('status-server',root).returncode!=0
            entry=[str(stage/'pawtalkctl.exe'),'--root',str(root),'--lang','en']
            noninteractive=subprocess.run([*entry,'tui'],stdin=subprocess.DEVNULL,capture_output=True,timeout=30)
            assert noninteractive.returncode!=0 and b'Use an interactive terminal' in noninteractive.stderr
            subprocess.run([*entry,'start'],check=True,timeout=60)
            runtime.healthy(before,c.config(),before['identity'])
            subprocess.run([*entry,'stop','--yes'],check=True,timeout=60)
            assert control('status-server',root).returncode!=0
            subprocess.run([*entry,'start'],check=True,timeout=60)
            runtime.healthy(before,c.config(),before['identity'])
            print('PASS actual LocalService SCM stop without debug privilege; console start/stop and TUI terminal guard')
        invitation=runtime.command(before,c.config(),'info')
        assert runtime.initialized(before,c.config()) is False
        shared=runtime.invitation(before,c.config())
        assert shared['url'].startswith(invitation.decode().strip()+'#')
        member=run_client('join',shared['url'])
        assert runtime.initialized(before,c.config()) is True
        assert runtime.invitation(before,c.config()) is None
        assert shared['url'].encode() not in (root/'var/log/pawtalk/server.log').read_bytes()
        assert not (c.directory/'invitation.dpapi').exists()
        try:runtime.command(before,c.config(),'initial-admin');raise AssertionError('administrative link issued after setup')
        except RuntimeError:pass
        def activity(path,token=None):
            saved=json.loads((runtime.data(c.state())/'state.json').read_text())
            context=ssl.create_default_context(cadata=saved['Certificate'])
            connection=http.client.HTTPSConnection('127.0.0.1',int(c.config()['PAWTALK_PORT']),context=context,timeout=10)
            connection.request('GET',path,headers={'Authorization':'Bearer '+token} if token else {})
            response=connection.getresponse();raw=response.read();status=response.status;connection.close()
            return status,raw
        def server_policy():
            status,body=activity('/api/config');assert status==200;return json.loads(body)
        policy=server_policy()
        assert policy['apiProtocolVersion']==2 and policy['e2eeRequired'] is True and policy['initialized'] is True
        assert activity('/api/v2/state')[0]==401
        assert activity('/api/v2/state','synthetic-invalid-session')[0]==401
        assert activity('/api/presence')[0]==426
        print('PASS actual initial-admin CLI, native DPAPI client bootstrap, mandatory E2EE and anonymous/legacy rejection; no admin bootstrap after setup')
        audio_fixture=run_client('audio')
        audio_file=fixtures/'membership-audio.json';audio_file.write_text(json.dumps(audio_fixture),encoding='utf-8')
        env={**os.environ,'PAWTALK_TEST_SERVER':f'https://127.0.0.1:{port}','PAWTALK_TEST_INVITATION':invitation.decode().strip(),'PAWTALK_API2_FIXTURE':str(audio_file)}
        env.pop('ELECTRON_RUN_AS_NODE',None)
        audio=subprocess.run([os.environ['PAWTALK_ELECTRON'],str(Path(__file__).resolve().parents[3]/'tooling/dev/integration.cjs')],env=env,capture_output=True,timeout=180,creationflags=subprocess.CREATE_NO_WINDOW)
        if audio.returncode:raise RuntimeError('Native API 2 RTP integration failed: '+(audio.stdout+audio.stderr).decode(errors='replace'))
        print(audio.stdout.decode(errors='replace').strip())
        app_input=fixtures/'membership-app.json';app_input.write_text(json.dumps(dict(address=shared['url'],serverId=member['serverId'])),encoding='utf-8')
        env={**os.environ,'PAWTALK_APP_TEST_DIR':str(client_directory),'PAWTALK_APP_TEST_INPUT':str(app_input)};env.pop('ELECTRON_RUN_AS_NODE',None)
        app_check=subprocess.run([os.environ['PAWTALK_ELECTRON'],str(repository/'apps/client/windows/tests/membership-app-native.cjs'),'--smoke'],env=env,capture_output=True,timeout=100,creationflags=subprocess.CREATE_NO_WINDOW)
        if app_check.returncode:raise RuntimeError('Native Manager -> Client UI failed: '+(app_check.stdout+app_check.stderr).decode(errors='replace').replace(shared['url'],'[invitation redacted]'))
        print('PASS real Manager Server -> Client main/preload/renderer, retained OS credentials, encrypted chat/images, channels and LiveKit E2EE')
        c.install(config,{},directory/'manager/compose.server.yaml','')
        assert c.state()==before
        print('PASS native API 2 install, health, stable server identity, bootstrap, reinstall and cross-process lock')
        def probe():
            with closing(sqlite3.connect(runtime.data(c.state())/'membership-v2.sqlite')) as db:
                return db.execute('SELECT value FROM manager_smoke_probe').fetchone()[0]
        with closing(sqlite3.connect(runtime.data(c.state())/'membership-v2.sqlite')) as db, db:
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
                (runtime.data(candidate)/'membership-v2.sqlite').write_bytes(b'injected failed rollout mutation')
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
        # Sequential test transactions may meet the real SCM health/periodic
        # worker. Wait only for ownership; never replay the transaction body.
        with lock(c.directory/'operation.lock',timeout=10):
            assert bundles.activate(c,manifest('manager','0.1.1'),keys,fixtures/'PawTalk.Manager.0.1.1.tar.gz')
            assert calls.count('start-server')==count
            assert c.state()['managerVersion']=='0.1.1'
            c.restore(backup)
        assert c.state()['version']=='0.9.0' and c.state()['managerVersion']=='0.1.1'
        assert runtime.command(c.state(),c.config(),'info')==invitation
        print('PASS native backup, failed-update data rollback, Server update, Manager-only update without server restart, restore')
        # The GUI protocol applies the same validated settings to the real
        # native room. Older published Server fixtures do not support rebind.
        if policy.get('apiProtocolVersion')==2:
            # These additional transactions deliberately create more than the
            # normal retention count; keep the original backup for the later
            # fresh-root restore test instead of letting normal pruning remove it.
            assert not c.configure({'PAWTALK_BACKUP_KEEP':'20'})
            old_config=c.config()
            for candidate in range(35000,50000,4):
                sockets=[]
                try:
                    for offset,kind in [(0,socket.SOCK_STREAM),(1,socket.SOCK_STREAM),(2,socket.SOCK_DGRAM),(3,socket.SOCK_STREAM)]:
                        item=socket.socket(socket.AF_INET,kind);sockets.append(item);item.bind(('0.0.0.0',candidate+offset))
                    new_port=candidate;break
                except OSError:pass
                finally:
                    for item in sockets:item.close()
            else:raise RuntimeError('No alternate settings test port range')
            values={key:old_config[key] for key in cli.SETTINGS_FIELDS}
            values.update(PAWTALK_PUBLIC_IP='127.0.0.2',PAWTALK_PORT=str(new_port),PAWTALK_CHAT_MAX_MB='64')
            assert cli.apply_settings(c,dict(expected=old_config,values=values))
            port=new_port
            assert server_policy()['e2eeRequired'] is True
            assert probe()=='original'
            changed_invite=runtime.command(c.state(),c.config(),'info')
            assert changed_invite!=invitation and b'127.0.0.2:'+str(port).encode() in changed_invite
            assert runtime.invitation(c.state(),c.config()) is None
            run_client('verify')
            try:cli.apply_settings(c,dict(expected=old_config,values=values));raise AssertionError('stale settings window accepted')
            except ValueError:pass
            stable=c.config()
            rebind=runtime.reconfigure_network
            def failed_rebind(state,old,new):
                rebind(state,old,new)
                raise RuntimeError('injected failure after actual certificate rebind')
            with patch.object(runtime,'reconfigure_network',side_effect=failed_rebind):
                try:c.configure({'PAWTALK_PUBLIC_IP':'127.0.0.3'});raise AssertionError('failed settings committed')
                except RuntimeError:pass
            assert c.config()==stable and runtime.command(c.state(),c.config(),'info')==changed_invite
            assert probe()=='original' and server_policy()['e2eeRequired'] is True
            for invalid in [{'PAWTALK_E2EE':'false'},{'PAWTALK_E2EE_KEY_ID':'b'*64}]:
                try:c.configure(invalid);raise AssertionError('manual encryption policy accepted')
                except ValueError:pass
            assert probe()=='original' and server_policy()['e2eeRequired'] is True
            run_client('verify')
            print('PASS native settings: IP/port/history apply, encrypted membership/history retained, stale window rejected, actual rebind failure rollback, E2EE cannot be disabled')
            # Reproduce the reported tray stop -> edit -> save path with the
            # real server/config/runtime, both with console hosting and SCM.
            runtime.stop(c.state(),c.config())
            assert not runtime.container(c.state(),c.config())['State']['Running']
            stopped_config=c.config()
            values={key:stopped_config[key] for key in cli.SETTINGS_FIELDS}
            values['PAWTALK_CHAT_MAX_MB']='48'
            assert cli.apply_settings(c,dict(expected=stopped_config,values=values))
            assert not runtime.container(c.state(),c.config())['State']['Running']
            prepared=json.loads((c.directory/'runtime.json').read_text())
            assert prepared['config']['PAWTALK_CHAT_MAX_MB']=='48'
            runtime.start(c.state(),c.config())
            runtime.healthy(c.state(),c.config(),c.state()['identity'])
            assert server_policy()['e2eeRequired'] is True
            print('PASS stop -> edit -> save retains stopped state and prepares new settings for the next real start')
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
        with lock(c.directory/'operation.lock',timeout=10):
            c.restore(backup)
            bundles.install_units(root,directory,c.config())
        assert runtime.command(c.state(),c.config(),'info')==invitation
        assert probe()=='original'
        assert c.state()['managerVersion']=='0.1.0'
        run_client('verify')
        print('PASS native fresh-root restore authenticates archived Server/Manager and preserves encrypted SQLite/TLS/profile identity')
        with lock(c.directory/'operation.lock',timeout=10):
            before_local=c.create_backup()
            package=native.inspect_server_package(c,fixtures/'PawTalk.Server.0.9.2.windows-x64.zip')
            with patch.object(native,'fetch',side_effect=AssertionError('local installation must stay offline')):
                native.install_server_package(c,package['id'])
            assert c.state()['localPackage']==package['id']
            runtime.healthy(c.state(),c.config(),c.state()['identity'])
            local_backup=c.create_backup()
            c.restore(local_backup)
            assert c.state()['localPackage']==package['id']
            c.restore(before_local)
            assert not c.state().get('localPackage')
            assert runtime.command(c.state(),c.config(),'info')==invitation and probe()=='original'
        print('PASS actual offline local Server installation, isolated binaries, local backup restore and return to signed Server; SQLite/TLS identity retained')
        if '--installer' in sys.argv:
            import time
            import winreg
            program=Path(os.environ['ProgramData'])/'PawTalk Server Manager'
            legacy=Path(os.environ['ProgramFiles'])/'PawTalk Server Manager'
            registration=r'SOFTWARE\PawTalk\ServerManager'
            uninstall_key=r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawTalkServerManager'
            menu=Path(os.environ['ProgramData'])/'Microsoft/Windows/Start Menu/Programs/PawTalk Server Manager'
            def exists_key(name):
                try:
                    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,name,0,winreg.KEY_READ|winreg.KEY_WOW64_64KEY):return True
                except FileNotFoundError:return False
            if program.exists() or legacy.exists() or menu.exists() or exists_key(registration) or exists_key(uninstall_key):
                raise RuntimeError('Installer smoke refuses to touch an existing Manager installation')
            for target_root in roots:
                assert control('stop-server',target_root).returncode==0
                assert control('stop-manager',target_root).returncode==0
            install_root=roots[0].with_name(roots[0].name+'-installer')
            roots.append(install_root)
            version=(stage/'bootstrap/manager/VERSION').read_text().strip()
            setup=build_stage.parent/f'PawTalk.Server.Manager.Setup.{version}.exe'
            arguments=[str(setup),'/S',f'/ROOT={install_root}']
            tui_stage=build_stage.with_name('windows-tui')
            tui_setup=build_stage.parent/f'PawTalk.Server.Manager.TUI.Setup.{version}.exe'
            tui_arguments=[str(tui_setup),'/S',f'/ROOT={install_root}']
            installed=program/'pawtalkctl.exe'
            def assert_tui_layout():
                assert installed.read_bytes()==(tui_stage/'pawtalkctl.exe').read_bytes()
                assert json.loads((program/'tui-version.json').read_text())['version']==version
                for relative in ('desktop','desktop-version.json','pawtalk-server-tray.exe','server.ico','runtime/pythonw.exe'):
                    assert not (program/relative).exists(),f'TUI installation retained {relative}'
                assert not list(program.glob('status-*.json')),'TUI installation retained desktop status files'
                assert not menu.exists(),'TUI installation retained desktop shortcuts'
            try:
                fresh_tui=subprocess.run(tui_arguments,capture_output=True,timeout=240)
                assert fresh_tui.returncode==0,'Fresh silent TUI installer failed'
                assert_tui_layout()
                assert_manager_only_layout(install_root)
                result=subprocess.run(arguments,capture_output=True,timeout=240)
                if result.returncode:raise RuntimeError('Actual EXE installation failed')
                assert installed.is_file() and (program/'Uninstall.exe').is_file()
                assert (program/'desktop-version.json').is_file() and not (program/'tui-version.json').exists()
                assert hashlib.sha256(installed.read_bytes()).digest()==hashlib.sha256((stage/'pawtalkctl.exe').read_bytes()).digest()
                # protectRoot pre-creates the empty Server directory with its
                # final ACLs even though Manager has not downloaded Server.
                assert_manager_only_layout(install_root)
                def desktop(action,payload):
                    result=subprocess.run([str(installed),'--root',str(install_root),'desktop',action],input=json.dumps(payload).encode(),capture_output=True,timeout=180)
                    assert result.returncode==0,f'Desktop {action} failed'
                    return json.loads(result.stdout)['value']
                snapshot=desktop('snapshot',{})
                assert snapshot['setupRequired'] is True
                staged=desktop('inspect-server-package',dict(path=str(local_zip)))
                values={k:snapshot['values'][k] for k in cli.SETTINGS_FIELDS};values.update(config)
                snapshot=desktop('setup-server',dict(source='local',id=staged['id'],expected=snapshot['values'],values=values))
                assert snapshot['setupRequired'] is False
                for attempt in range(20):
                    status=subprocess.run([str(installed),'--root',str(install_root),'status'],capture_output=True,timeout=30)
                    if status.returncode==0:
                        result=json.loads(status.stdout)
                        if result.get('installed') and result.get('health')=='Healthy':break
                    time.sleep(0.5)
                else:raise RuntimeError('Installed server did not become healthy')
                assert not list((install_root/'var/lib/pawtalk-data').glob('*/initial-password'))
                invitation_result=subprocess.run([str(installed),'--root',str(install_root),'--lang','en','initial-admin'],capture_output=True,timeout=30)
                assert invitation_result.returncode==0
                saved_invitation=json.loads(invitation_result.stdout)
                assert 'setup=1' in saved_invitation['url'] and 'v=2' in saved_invitation['url']
                saved_config=(install_root/'etc/pawtalk/config.env').read_bytes()
                # Execute the actual generated Windows uninstaller, not an emulation.
                removed=subprocess.run([str(program/'Uninstall.exe'),'/S'],capture_output=True,timeout=120)
                if removed.returncode:raise RuntimeError('Actual EXE uninstall failed')
                for attempt in range(100):
                    # NSIS hands uninstall off to its temporary executable.
                    # The registry key disappears before its final directory
                    # cleanup; wait for both before starting the next installer.
                    if not exists_key(uninstall_key) and not program.exists():break
                    time.sleep(0.2)
                else:raise RuntimeError('Windows uninstaller did not finish')
                assert (install_root/'var/lib/pawtalk-manager/installed.json').is_file()
                assert not program.exists(),'Uninstall left program files behind'
                # Exercise migration from the previous Program Files layout.
                shutil.copytree(build_stage,legacy)
                legacy_host=legacy/'pawtalkctl.exe'
                assert subprocess.run([str(legacy_host),'protect-install',str(legacy)],capture_output=True).returncode==0
                with winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE,registration,0,winreg.KEY_SET_VALUE|winreg.KEY_WOW64_64KEY) as key:
                    winreg.SetValueEx(key,'InstallDir',0,winreg.REG_SZ,str(legacy))
                for action in ['install-server','start-server','install-manager','start-manager']:
                    assert subprocess.run([str(legacy_host),action,str(install_root)],capture_output=True,timeout=90).returncode==0
                # No config/manifest flags: reuse the saved config and verified
                # release without a wizard, network request or identity reset.
                again=subprocess.run([str(setup),'/S',f'/ROOT={install_root}'],capture_output=True,timeout=240)
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,registration,0,winreg.KEY_READ|winreg.KEY_WOW64_64KEY) as key:
                    install_stage=winreg.QueryValueEx(key,'InstallStatus')[0]
                assert again.returncode==0,f'Reinstallation with existing config failed (exit={again.returncode}, stage={install_stage})'
                assert not legacy.exists(),'Legacy Program Files directory was not retired'
                assert (install_root/'etc/pawtalk/config.env').read_bytes()==saved_config
                again_invitation=subprocess.run([str(installed),'--root',str(install_root),'initial-admin'],capture_output=True,timeout=30)
                busy=b'Another PawTalk operation is running' in again_invitation.stderr
                assert again_invitation.returncode==0,f'Invitation after migration failed (exit={again_invitation.returncode}, busy={busy})'
                restored_invitation=json.loads(again_invitation.stdout)
                assert restored_invitation['url'].split('#')[0]==saved_invitation['url'].split('#')[0],'Reinstall changed TLS identity'
                assert restored_invitation['url']!=saved_invitation['url'],'Initial admission links must be unique'
                converted=subprocess.run(tui_arguments,capture_output=True,timeout=240)
                assert converted.returncode==0,'Silent TUI installer failed'
                assert_tui_layout()
                assert (install_root/'etc/pawtalk/config.env').read_bytes()==saved_config
                assert desktop('snapshot',{})['setupRequired'] is False
                purged=subprocess.run([str(program/'Uninstall.exe'),'/S','/DELETE-DATA'],capture_output=True,timeout=120)
                assert purged.returncode==0,'Full uninstall failed'
                for attempt in range(100):
                    if not program.exists() and not install_root.exists():break
                    time.sleep(0.2)
                else:raise RuntimeError('Full uninstall left program files or room data')
                assert not exists_key(registration) and not exists_key(uninstall_key)
                print('PASS actual EXE ProgramData install, initial-admin admission, preserved-config reinstall, legacy-path service migration, keep-data and full uninstalls')
                print('PASS fresh silent TUI install and edition changes with no GUI payload in TUI and preserved room configuration')
            finally:
                installer_error=sys.exception()
                try:
                    # Only this fresh, exact product directory may be removed; never
                    # recursively delete a pre-existing installation or unrelated path.
                    if program.exists() and (program/'pawtalkctl.exe').is_file():
                        runtime_hosts=[stage/'pawtalkctl.exe',build_stage.with_name('windows-tui')/'pawtalkctl.exe']
                        matching=any(host.is_file() and host.read_bytes()==(program/'pawtalkctl.exe').read_bytes() for host in runtime_hosts)
                        if matching and program.parent.resolve()==Path(os.environ['ProgramData']).resolve() and program.name=='PawTalk Server Manager':
                            for action in ['stop-server','stop-manager','uninstall-manager','uninstall-server']:
                                real_host(action,install_root)
                            remove_owned_tree(program,Path(os.environ['ProgramData']),'PawTalk Server Manager')
                            if menu.exists():
                                if menu.parent.resolve()!=(Path(os.environ['ProgramData'])/'Microsoft/Windows/Start Menu/Programs').resolve():
                                    raise RuntimeError('Unsafe shortcut cleanup path')
                                remove_owned_tree(menu,menu.parent,'PawTalk Server Manager')
                            for name in [uninstall_key,registration]:
                                try:winreg.DeleteKeyEx(winreg.HKEY_LOCAL_MACHINE,name,winreg.KEY_WOW64_64KEY)
                                except FileNotFoundError:pass
                    if legacy.exists() and (legacy/'pawtalkctl.exe').is_file():
                        matching=hashlib.sha256((legacy/'pawtalkctl.exe').read_bytes()).digest()==hashlib.sha256((build_stage/'pawtalkctl.exe').read_bytes()).digest()
                        if matching:
                            for action in ['stop-server','stop-manager','uninstall-manager','uninstall-server']:
                                subprocess.run([str(legacy/'pawtalkctl.exe'),action,str(install_root)],capture_output=True,timeout=90)
                            remove_owned_tree(legacy,Path(os.environ['ProgramFiles']),'PawTalk Server Manager')
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
            except OSError as error:
                cleanup_errors.append(f'{type(error).__name__}: {target.name}; operation={error.filename}; winerror={getattr(error,"winerror",None)}')
    if not clean:
        cleanup_errors.append('service cleanup failed; test root retained')
    if cleanup_errors:
        message='Windows test cleanup: '+', '.join(cleanup_errors)
        if primary_error is not None:print(message,file=sys.stderr)
        else:raise RuntimeError(message)
print('PASS real Windows SCM lifecycle' if scm else 'PASS Windows console service/job lifecycle (SCM registration not exercised)')
