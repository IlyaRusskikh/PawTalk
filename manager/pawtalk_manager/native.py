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
from pathlib import Path
from .config import atomic, save
from .platforms import host, admin, protect, secure
from .release import REPO, fetch


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
        return self.root/'opt/pawtalk-server'/state['version']/'pawtalk-server.exe'

    def env(self,state,config):
        return {**os.environ,**config,'PAWTALK_DATA_DIR':str(self.data(state)),
                'PAWTALK_LIVEKIT_EXECUTABLE':str(self.binary(state).with_name('livekit-server.exe')),
                'PAWTALK_MANAGED_STDIN':'true'}

    def command(self,state,config,*args):
        result = subprocess.run([str(self.binary(state)),'serve',*args],env=self.env(state,config),capture_output=True,timeout=15)
        if result.returncode:
            raise RuntimeError('Server command failed; run pawtalkctl doctor')
        return result.stdout

    def pull(self,state):
        artifact = state.get('windows')
        if not artifact:
            raise ValueError('This signed Server release has no Windows x64 artifact')
        destination = self.binary(state).parent
        marker = destination/'verified.json'
        if destination.exists():
            self.verify_image(state)
            return
        destination.parent.mkdir(parents=True,exist_ok=True)
        import tempfile
        with tempfile.TemporaryDirectory(prefix='.server-',dir=destination.parent) as temporary:
            temporary = Path(temporary)
            secure(temporary)
            archive = temporary/'server.zip'
            url = f'https://github.com/{REPO}/releases/download/server-v{state["version"]}/{artifact["name"]}'
            if getattr(self,'server_bundle',None):
                shutil.copyfile(self.server_bundle,archive)
            else:
                atomic(archive,fetch(url,artifact['size']))
            with archive.open('rb') as stream:
                digest = hashlib.file_digest(stream,'sha256').hexdigest()
            if archive.stat().st_size != artifact['size'] or digest != artifact['sha256']:
                raise ValueError('Server archive hash/size mismatch')
            content = temporary/'content'
            content.mkdir()
            secure(content)
            allowed = {'pawtalk-server.exe','livekit-server.exe','LICENSE','THIRD_PARTY_NOTICES.md','GO-LICENSE','LIVEKIT-LICENSE','GO-DEPENDENCIES-LICENSE'}
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

    def start(self,state,config):
        self.check_volume(state)
        self.verify_image(state)
        save(self.control/'runtime.json',dict(state=state,config=config))
        for action in ['install-server','start-server']:
            if host(action,self.root).returncode:
                raise RuntimeError('Unable to start PawTalk Windows service')

    def stop(self,state,config):
        if host('stop-server',self.root).returncode:
            raise RuntimeError('Unable to stop PawTalk Windows service')

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
        return hashlib.sha256(raw.encode()).hexdigest()

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
