"""Windows service/filesystem adapter for the shared durable Controller."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import time
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from .config import atomic, save, source_file
from .platforms import host, admin, protect, secure
from .release import REPO, fetch


SERVER_FILES={'pawtalk-server.exe','livekit-server.exe','LICENSE','THIRD_PARTY_NOTICES.md','GO-LICENSE','LIVEKIT-LICENSE','GO-DEPENDENCIES-LICENSE'}


def inspect_server_package(controller,file):
    """Stage immutable bytes before asking the user to approve executable code."""
    import io
    from . import release
    file=Path(file)
    if not file.is_file() or file.stat().st_size>256*1024*1024: raise ValueError('Invalid Server package')
    with file.open('rb') as stream: raw=stream.read(256*1024*1024+1)
    if len(raw)>256*1024*1024: raise ValueError('Server package too large')
    signed=None
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names=archive.namelist()
        if 'package.json' in names:
            if len(names)!=len(set(names)) or set(names) not in ({'package.json','server.zip'},{'package.json','server.zip','server-manifest.json'}): raise ValueError('Invalid Server package contents')
            if archive.getinfo('package.json').file_size>16384 or archive.getinfo('server.zip').file_size>256*1024*1024: raise ValueError('Server package too large')
            meta=json.loads(archive.read('package.json'))
            if meta.get('format')!='pawtalk-server-package-v1' or meta.get('apiProtocol')!=2 or meta.get('dataSchema')!=2: raise ValueError('Unsupported Server package')
            version=meta['version']; raw=archive.read('server.zip')
            if hashlib.sha256(raw).hexdigest()!=meta['sha256']: raise ValueError('Server package checksum mismatch')
            if 'server-manifest.json' in names:
                if archive.getinfo('server-manifest.json').file_size>16384: raise ValueError('Manifest too large')
                signed=archive.read('server-manifest.json')
        else:
            match=re.fullmatch(r'PawTalk\.Server\.(.+)\.windows-x64\.zip',file.name)
            if not match: raise ValueError('Use a PawTalk Server package or named Windows Server archive')
            version=match[1]
            companion=file.with_name('server-manifest.json')
            if companion.exists():
                if companion.stat().st_size>16384: raise ValueError('Manifest too large')
                signed=companion.read_bytes()
    release.semver(version)
    digest=hashlib.sha256(raw).hexdigest()
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries=archive.infolist()
        if len(entries)!=len(SERVER_FILES) or {e.filename for e in entries}!=SERVER_FILES or sum(e.file_size for e in entries)>512*1024*1024: raise ValueError('Invalid Server archive contents')
        for entry in entries:
            if entry.is_dir() or (entry.external_attr>>16)&0o170000==0o120000: raise ValueError('Unsafe Server archive entry')
            # CRC/decompression validation does not execute the selected programs.
            with archive.open(entry) as stream:
                while stream.read(1024*1024): pass
    artifact=dict(name=f'PawTalk.Server.{version}.windows-x64.zip',size=len(raw),sha256=digest)
    if signed is not None:
        keys=json.loads((controller.etc/'trust.json').read_text())
        manifest=release.verify(signed,'server',keys)
        if manifest['version']!=version or manifest.get('windows')!=artifact: raise ValueError('Server package does not match signed manifest')
    else:
        manifest=dict(version=version,dataSchema=2,apiProtocol=2,digest='sha256:'+digest,windows=artifact,_signed='',_local=True)
    directory=controller.directory/'packages'
    directory.mkdir(parents=True,exist_ok=True);secure(directory)
    atomic(directory/(digest+'.zip'),raw)
    save(directory/(digest+'.json'),manifest)
    return dict(id=digest,version=version,sha256=digest,verified=signed is not None,size=len(raw))


def install_server_package(controller,identifier):
    if not isinstance(identifier,str) or not re.fullmatch(r'[a-f0-9]{64}',identifier): raise ValueError('Invalid Server package identifier')
    directory=controller.directory/'packages'
    manifest=json.loads((directory/(identifier+'.json')).read_text())
    archive=directory/(identifier+'.zip')
    if manifest['windows']['sha256']!=identifier or hashlib.sha256(archive.read_bytes()).hexdigest()!=identifier: raise ValueError('Staged Server package changed')
    if manifest.get('_local') is not True:
        from .release import verify
        manifest=verify(manifest['_signed'],'server',json.loads((controller.etc/'trust.json').read_text()))
        if manifest['windows']['sha256']!=identifier: raise ValueError('Signed package changed')
    previous=getattr(controller.runtime,'server_bundle',None)
    controller.runtime.server_bundle=archive
    try:
        changed=controller.update_server(manifest,local=manifest.get('_local') is True)
        if manifest.get('_local') is True:
            controller.configure({'PAWTALK_SERVER_AUTO_UPDATE':'false'})
        return changed
    finally:
        controller.runtime.server_bundle=previous


def installed_desktop_version():
    file=Path(os.environ['PAWTALK_MANAGER_HOST']).parent/'desktop-version.json'
    from .release import semver
    if not file.exists():
        if os.name=='nt':
            import winreg
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawTalkServerManager',0,winreg.KEY_READ|winreg.KEY_WOW64_64KEY) as key:
                    version=winreg.QueryValueEx(key,'DisplayVersion')[0];semver(version);return version
            except FileNotFoundError: pass
        return '0.0.0'
    version=json.loads(file.read_text())['version']; semver(version)
    return version


def queue_manager_installer(controller,manifest):
    """The SYSTEM task runs outside the maintenance service's kill-on-close job."""
    from .release import verify, semver
    keys=json.loads((controller.etc/'trust.json').read_text())
    manifest=verify(manifest['_signed'], 'manager',keys)
    if semver(manifest['version']) <= semver(installed_desktop_version()): return False
    artifact=manifest.get('windowsInstaller')
    if not artifact: raise ValueError('Manager release has no signed Windows installer')
    directory=controller.directory/'updates'
    directory.mkdir(parents=True,exist_ok=True); secure(directory)
    installer=directory/artifact['name']
    if installer.is_symlink() or installer.is_junction(): raise ValueError('Unsafe installer path')
    if not installer.exists() or installer.stat().st_size!=artifact['size'] or hashlib.sha256(installer.read_bytes()).hexdigest()!=artifact['sha256']:
        data=fetch(f'https://github.com/{REPO}/releases/download/manager-v{manifest["version"]}/{artifact["name"]}',artifact['size'])
        if len(data)!=artifact['size'] or hashlib.sha256(data).hexdigest()!=artifact['sha256']: raise ValueError('Manager installer hash/size mismatch')
        atomic(installer,data);secure(installer)
    pending=directory/'pending.json'
    if pending.exists():
        saved=json.loads(pending.read_text())
        if saved.get('version')==manifest['version'] and time.time()-saved.get('at',0)<900: return True
    schedule_manager_installer(controller,installer)
    save(pending,dict(version=manifest['version'],at=int(time.time())))
    return True


def schedule_manager_installer(controller,installer):
    task='PawTalk-Manager-Update-'+hashlib.sha256(str(controller.root).lower().encode()).hexdigest()[:16]
    quote=lambda value: subprocess.list2cmdline([str(value)])
    arguments='/S /ROOT='+quote(controller.root)
    scheduler=str(Path(os.environ.get('SystemRoot',r'C:\Windows'))/'System32/schtasks.exe')
    # No clock trigger: /Run starts it exactly once. A near-future ONCE trigger
    # would run the installer a second time after the immediate /Run.
    namespace='http://schemas.microsoft.com/windows/2004/02/mit/task'
    ET.register_namespace('',namespace)
    def child(parent,name,text=None,**attributes):
        element=ET.SubElement(parent,'{'+namespace+'}'+name,attributes)
        element.text=text
        return element
    document=ET.Element('{'+namespace+'}Task',version='1.2')
    child(document,'Triggers')
    principal=child(child(document,'Principals'),'Principal',id='System')
    child(principal,'UserId','S-1-5-18');child(principal,'RunLevel','HighestAvailable')
    settings=child(document,'Settings')
    child(settings,'MultipleInstancesPolicy','IgnoreNew')
    child(settings,'DisallowStartIfOnBatteries','false');child(settings,'StopIfGoingOnBatteries','false')
    child(settings,'AllowStartOnDemand','true');child(settings,'ExecutionTimeLimit','PT15M')
    action=child(child(document,'Actions',Context='System'),'Exec')
    child(action,'Command',str(installer));child(action,'Arguments',arguments)
    xml=installer.parent/'install-task.xml'
    atomic(xml,ET.tostring(document,encoding='utf-16',xml_declaration=True));secure(xml)
    try:
        created=subprocess.run([scheduler,'/Create','/TN',task,'/XML',str(xml),'/F'],capture_output=True,timeout=20)
        if created.returncode: raise RuntimeError('Unable to schedule Manager installer')
        started=subprocess.run([scheduler,'/Run','/TN',task],capture_output=True,timeout=20)
        if started.returncode: raise RuntimeError('Unable to start Manager installer')
    finally:
        xml.unlink(missing_ok=True)


class NativeRuntime:
    def __init__(self,root):
        self.root = Path(root)
        self.control = self.root/'var/lib/pawtalk-manager'

    def names(self,state):
        if not re.fullmatch(r'pawtalk-[a-f0-9]{12}',state['project']) or not re.fullmatch(r'pawtalk-[a-f0-9]{12}(?:-restore-[a-f0-9]{12})?',state['volume']):
            raise ValueError('Unsafe managed project/volume')

    def data(self,state):
        self.names(state)
        return self.root/'var/lib/pawtalk-data'/state['volume']

    def binary(self,state):
        from .release import semver
        semver(state['version'])
        directory=state['version']
        if state.get('localPackage'):
            if not re.fullmatch(r'[a-f0-9]{64}',state['localPackage']): raise ValueError('Invalid local Server identity')
            directory+='-local-'+state['localPackage']
        return self.root/'opt/pawtalk-server'/directory/'pawtalk-server.exe'

    def env(self,state,config):
        return {**os.environ,**config,'PAWTALK_DATA_DIR':str(self.data(state)),
                'PAWTALK_LIVEKIT_EXECUTABLE':str(self.binary(state).with_name('livekit-server.exe')),
                'PAWTALK_MANAGED_STDIN':'true'}

    def command(self,state,config,*args):
        result = subprocess.run([str(self.binary(state)),'serve',*args],env=self.env(state,config),capture_output=True,timeout=15)
        if result.returncode:
            raise RuntimeError('Server command failed; run pawtalkctl doctor')
        return result.stdout

    def initialized(self,state,config):
        from .admission import status
        return status(lambda *args: self.command(state,config,*args))

    def invitation(self,state,config):
        from .admission import initial_invitation
        return initial_invitation(lambda *args: self.command(state,config,*args))

    def pull(self,state):
        artifact = state.get('windows')
        if not artifact:
            raise ValueError('This signed Server release has no Windows x64 artifact')
        destination = self.binary(state).parent
        marker = destination/'verified.json'
        if destination.exists():
            self.verify_image(state)
            return
        bundle=getattr(self,'server_bundle',None)
        if state.get('localPackage') and not bundle:
            cached=self.control/'packages'/(state['localPackage']+'.zip')
            if not cached.is_file(): raise ValueError('Reimport the original local Server package before restoring this backup')
            bundle=cached
        destination.parent.mkdir(parents=True,exist_ok=True)
        import tempfile
        with tempfile.TemporaryDirectory(prefix='.server-',dir=destination.parent) as temporary:
            temporary = Path(temporary)
            secure(temporary)
            archive = temporary/'server.zip'
            url = f'https://github.com/{REPO}/releases/download/server-v{state["version"]}/{artifact["name"]}'
            if bundle:
                shutil.copyfile(bundle,archive)
            else:
                atomic(archive,fetch(url,artifact['size']))
            with archive.open('rb') as stream:
                digest = hashlib.file_digest(stream,'sha256').hexdigest()
            if archive.stat().st_size != artifact['size'] or digest != artifact['sha256']:
                raise ValueError('Server archive hash/size mismatch')
            content = temporary/'content'
            content.mkdir()
            secure(content)
            allowed = SERVER_FILES
            hashes = {}
            with zipfile.ZipFile(archive) as source:
                entries = source.infolist()
                if len(entries) != len(allowed) or {entry.filename for entry in entries} != allowed or sum(e.file_size for e in entries)>512*1024*1024:
                    raise ValueError('Unexpected Server archive contents')
                for entry in entries:
                    if entry.is_dir() or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                        raise ValueError('Unsafe Server archive entry')
                    data = source.read(entry)
                    atomic(content/entry.filename,data)
                    hashes[entry.filename] = hashlib.sha256(data).hexdigest()
            save(content/'verified.json',dict(sha256=artifact['sha256'],files=hashes))
            os.rename(content,destination)
        if admin():
            protect(self.root)
        self.verify_image(state)

    def verify_image(self,state):
        directory = self.binary(state).parent
        marker = json.loads((directory/'verified.json').read_text())
        if marker['sha256'] != state['windows']['sha256']:
            raise ValueError('Published Windows Server version was replaced')
        for name,digest in marker['files'].items():
            if Path(name).name != name or hashlib.sha256((directory/name).read_bytes()).hexdigest() != digest:
                raise ValueError('Installed Server files changed')

    def create_volume(self,state):
        directory = self.data(state)
        marker = directory.parent/(state['volume']+'.owner')
        if directory.exists() and (not marker.is_file() or marker.read_text() != state['project']):
            raise ValueError('Refusing to adopt an unowned data directory')
        directory.mkdir(parents=True,exist_ok=True)
        secure(directory)
        atomic(marker,state['project'].encode())

    def check_volume(self,state):
        directory = self.data(state)
        if not directory.is_dir() or (directory.parent/(state['volume']+'.owner')).read_text() != state['project']:
            raise ValueError('Data directory ownership mismatch')

    def prepare(self,state,config):
        self.check_volume(state)
        self.verify_image(state)
        save(self.control/'runtime.json',dict(state=state,config=config))

    def start(self,state,config):
        self.prepare(state,config)
        for action in ['install-server','start-server']:
            if host(action,self.root).returncode:
                raise RuntimeError('Unable to start PawTalk Windows service')

    def stop(self,state,config):
        if host('stop-server',self.root).returncode:
            raise RuntimeError('Unable to stop PawTalk Windows service')

    def reconfigure_network(self,state,old,new):
        # Controller has stopped the service and made a restorable snapshot.
        # Older signed Servers reject rebind; the transaction then rolls back.
        if old['PAWTALK_PUBLIC_IP'] != new['PAWTALK_PUBLIC_IP']:
            self.command(state,new,'rebind')
        return self.identity(state,new)

    def container(self,state,config):
        running = host('status-server',self.root).returncode == 0
        healthy = False
        if running:
            try:
                self.command(state,config,'healthcheck')
                healthy = True
            except (RuntimeError,subprocess.TimeoutExpired):
                pass
        return {'Id':'PawTalkServer','State':{'Running':running,'Health':{'Status':'healthy' if healthy else 'unhealthy'}}}

    def identity(self,state,config):
        raw = self.command(state,config,'info').decode().strip()
        if not re.fullmatch(r'pawtalk://[^/\s]+/[a-f0-9]{64}',raw):
            raise ValueError('Invalid room identity')
        from .admission import inspect_status
        status = inspect_status(lambda *args: self.command(state,config,*args))
        if status is None:
            raise ValueError('Server does not support API 2 host status')
        return hashlib.sha256(('pawtalk-host-v2\n'+raw+'\n'+status['serverId']).encode()).hexdigest()

    def healthy(self,state,config,expected=None,timeout=90):
        deadline = time.monotonic()+timeout
        while time.monotonic()<deadline:
            try:
                self.command(state,config,'healthcheck')
                identity = self.identity(state,config)
                if expected is not None and identity != expected:
                    raise ValueError('TLS/invitation identity changed')
                return identity
            except RuntimeError:
                time.sleep(1)
        raise RuntimeError('Room health verification timed out')

    def project_exists(self,state,config):
        self.names(state)
        return host('status-server',self.root).returncode == 0

    def data_size(self,state):
        self.check_volume(state)
        return sum(p.stat().st_size for p in self.data(state).rglob('*') if p.is_file())

    def export(self,state,destination):
        self.check_volume(state)
        with tarfile.open(destination,'x') as archive:
            secure(destination)
            for file in self.data(state).rglob('*'):
                if file.is_symlink() or file.is_junction():
                    raise ValueError('Data directory contains a link')
                archive.add(file,arcname=str(file.relative_to(self.data(state))).replace('\\','/'),recursive=False)

    def import_backup(self,state,source):
        self.create_volume(state)
        with tarfile.open(source) as archive:
            archive.extractall(self.data(state),filter='data')
        secure(self.data(state))

    def compose(self,state,config,*args):
        if args == ('restart','server'):
            self.stop(state,config)
            self.start(state,config)
            return b''
        if args == ('config','--format','json'):
            return b'{}' # Compose changes do not affect the native runtime.
        raise ValueError('Unsupported native operation')


def serve(root):
    """Service child; the stable SCM host owns a kill-on-close process job."""
    runtime = NativeRuntime(root)
    control = runtime.control
    selected = json.loads((control/'runtime.json').read_text())
    state,config = selected['state'],selected['config']
    runtime.verify_image(state)
    logs = Path(root)/'var/log/pawtalk'
    logs.mkdir(parents=True,exist_ok=True)
    log = logs/'server.log'
    if log.exists() and log.stat().st_size>8*1024*1024:
        os.replace(log,logs/'server.previous.log')
    with open(log,'ab',buffering=0) as output:
        child = subprocess.Popen([str(runtime.binary(state)),'serve'],env=runtime.env(state,config),stdin=subprocess.PIPE,stdout=output,stderr=output)
        while child.poll() is None:
            if (logs/'stop-server').exists():
                child.stdin.close()
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    child.kill()
                break
            time.sleep(0.2)
        return child.wait()

def manager_values(controller,language='ru'):
    """Draft defaults are data only; reading this never installs or starts Server."""
    from .config import DEFAULTS,read_config,validate
    if (controller.etc/'config.env').exists():
        return read_config(controller.etc/'config.env')
    metadata=controller.directory/'manager.json'
    if metadata.exists(): language=json.loads(metadata.read_text()).get('language',language)
    return validate({**DEFAULTS,'PAWTALK_PUBLIC_IP':'127.0.0.1','PAWTALK_LANGUAGE':language})


def install_manager_only(controller,source,language):
    """Install the protected control plane without fetching any executable package."""
    if language not in ('ru','en'): raise ValueError('Invalid language')
    source=Path(source)
    version=installed_desktop_version()
    save(controller.directory/'manager.json',dict(version=version,language=language))
    trust=controller.etc/'trust.json'
    if not trust.exists(): atomic(trust,(source/'trust.json').read_bytes())
    # Upgrading Manager preserves existing Server data and its stopped/running state.
    # A fresh Manager registers no Server or maintenance service.
    if controller.state_file.exists() and not (controller.directory/'setup.json').exists():
        state,config=controller.state(),controller.config()
        controller.runtime.prepare(state,config)
        for action in ['install-server','install-manager','start-manager']:
            if host(action,controller.root).returncode: raise RuntimeError('Windows service setup failed')
        if os.environ.get('PAWTALK_INSTALL_KEEP_STOPPED')!='1':
            controller.runtime.start(state,config)
            controller.runtime.healthy(state,config,state.get('identity'))
    return version


def setup_server(controller,request,source):
    """Explicit first-run operation, serialized by the same lock as later updates."""
    import uuid
    from . import release,preflight
    from .config import validate,write_config,remove
    journal=controller.directory/'setup.json'
    pending=json.loads(journal.read_text()) if journal.exists() else {}
    if controller.state_file.exists() and controller.state().get('project')!=pending.get('project'): raise ValueError('Server already configured')
    fields={'PAWTALK_PUBLIC_IP','PAWTALK_PORT','PAWTALK_CHAT_MAX_MB','PAWTALK_SERVER_AUTO_UPDATE','PAWTALK_MANAGER_AUTO_UPDATE','PAWTALK_LANGUAGE'}
    if set(request)!= {'source','id','expected','values'} or request['source'] not in ('local','published'):
        raise ValueError('Invalid setup request')
    old=manager_values(controller)
    if request['expected']!=old: raise ValueError('Settings changed elsewhere')
    values=request['values']
    if not isinstance(values,dict) or set(values)!=fields or any(not isinstance(v,str) for v in values.values()): raise ValueError('Invalid settings fields')
    config=validate({**old,**values})
    keys=json.loads((controller.etc/'trust.json').read_text())
    archive=None
    if request['source']=='local':
        identifier=request['id']
        if not isinstance(identifier,str) or not re.fullmatch(r'[a-f0-9]{64}',identifier): raise ValueError('Invalid Server package identifier')
        directory=controller.directory/'packages'
        manifest=json.loads((directory/(identifier+'.json')).read_text())
        archive=directory/(identifier+'.zip')
        if manifest['windows']['sha256']!=identifier or hashlib.sha256(archive.read_bytes()).hexdigest()!=identifier: raise ValueError('Staged Server package changed')
        if manifest.get('_local') is not True:
            manifest=release.verify(manifest['_signed'],'server',keys)
            if manifest['windows']['sha256']!=identifier: raise ValueError('Signed package changed')
    else:
        if request['id'] is not None: raise ValueError('Invalid published Server selection')
        manifest=release.discover('server',keys)
        if manifest is None: raise ValueError('No compatible published Server')
    if manifest.get('apiProtocol')!=2 or manifest.get('dataSchema')!=2 or not manifest.get('windows'):
        raise ValueError('Unsupported Server package')
    if manifest.get('_local') is True: config['PAWTALK_SERVER_AUTO_UPDATE']='false'
    if controller.state_file.exists():
        controller.runtime.stop(controller.state(),manager_values(controller))
        remove(controller.state_file)
    preflight.check(config)
    project=pending.get('project','pawtalk-'+uuid.uuid4().hex[:12])
    if not re.fullmatch(r'pawtalk-[a-f0-9]{12}',project): raise ValueError('Invalid setup journal')
    state=dict(project=project,volume=project,version=manifest['version'],image=release.IMAGE+'@'+manifest['digest'],dataSchema=2,
               managerVersion=installed_desktop_version(),serverManifest=manifest['_signed'],windows=manifest['windows'])
    if manifest.get('_local') is True: state['localPackage']=manifest['windows']['sha256']
    previous=getattr(controller.runtime,'server_bundle',None)
    controller.runtime.server_bundle=archive
    try:
        controller.runtime.pull(state)
        save(journal,dict(project=project,config=config))
        controller.runtime.create_volume(state)
        if pending.get('config',{}).get('PAWTALK_PUBLIC_IP',config['PAWTALK_PUBLIC_IP'])!=config['PAWTALK_PUBLIC_IP'] and (controller.runtime.data(state)/'state.json').exists():
            controller.runtime.command(state,config,'rebind')
        write_config(controller.etc/'config.env',config)
        atomic(controller.template,source_file(source,'compose.server.yaml').read_bytes())
        save(controller.state_file,state)
        controller.runtime.start(state,config)
        state['identity']=controller.runtime.healthy(state,config)
        save(controller.state_file,state)
        for action in ['install-manager','start-manager']:
            if host(action,controller.root).returncode: raise RuntimeError('Windows service setup failed')
        remove(journal)
    except Exception:
        try: host('stop-manager',controller.root)
        except (OSError,ValueError,RuntimeError): pass
        try: controller.runtime.stop(state,config)
        except (OSError,ValueError,RuntimeError): pass
        try:
            if controller.state_file.exists() and controller.state().get('project')==project:
                remove(controller.state_file)
                runtime=controller.directory/'runtime.json'
                if runtime.exists(): remove(runtime)
        except OSError: pass
        try: write_config(controller.etc/'config.env',old)
        except OSError: pass
        raise
    finally: controller.runtime.server_bundle=previous
