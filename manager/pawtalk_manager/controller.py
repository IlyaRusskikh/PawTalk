"""Durable room transactions. All callers hold the same exclusive host lock."""
import base64
import hashlib
import json
import os
import re
import shutil
import tarfile
import time
import uuid
from pathlib import Path
from .config import atomic, read_config, remove, save, validate, write_config
from .release import IMAGE, semver
from .runtime import Runtime, run
from .platforms import WINDOWS, secure


def checksum(file):
    with open(file,'rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


class Controller:
    def __init__(self, root='/', runtime=None):
        self.root = Path(root).resolve()
        self.etc = self.root/'etc/pawtalk'
        self.directory = self.root/'var/lib/pawtalk-manager'
        self.backups = self.root/'var/backups/pawtalk'
        self.template = self.root/'opt/pawtalk/compose.server.yaml'
        self.state_file = self.directory/'installed.json'
        self.journal = self.directory/'transaction.json'
        if runtime is None and WINDOWS:
            from .native import NativeRuntime
            runtime = NativeRuntime(self.root)
        self.runtime = runtime or Runtime(self.template)

    def state(self):
        return json.loads(self.state_file.read_text())

    def config(self):
        return read_config(self.etc/'config.env')

    def transaction(self,state,config,kind):
        entry = dict(previous=state,config=config,kind=kind,phase='prepared',backup=None,
                     template=base64.b64encode(self.template.read_bytes()).decode())
        if kind == 'manager-update':
            agent = self.root/'opt/pawtalk-manager'
            entry['pointers'] = ({name:json.loads((agent/(name+'.json')).read_text()) for name in ['current','previous'] if (agent/(name+'.json')).exists()} if WINDOWS else
                                 {name:os.readlink(agent/name) for name in ['current','previous'] if (agent/name).is_symlink()})
            entry['trust'] = base64.b64encode((self.etc/'trust.json').read_bytes()).decode()
            units = self.root/'etc/systemd/system'
            entry['units'] = {p.name:base64.b64encode(p.read_bytes()).decode() for p in units.glob('pawtalk-*') if p.name in ['pawtalk-update.service','pawtalk-update.timer','pawtalk-health.service','pawtalk-health.timer']}
        save(self.journal,entry)
        return entry

    def finish(self,outcome='success'):
        entry = json.loads(self.journal.read_text())
        state = self.state()
        save(self.directory/'last-operation.json',dict(kind=entry['kind'],outcome=outcome,serverVersion=state['version'],managerVersion=state['managerVersion'],finishedAt=int(time.time())))
        entry['phase'] = 'committed'
        save(self.journal,entry)
        remove(self.journal)

    def prune(self):
        if not self.state_file.exists():
            return
        project = self.state()['project']
        candidates = []
        for p in self.backups.glob('backup-*'):
            if p.is_symlink() or p.resolve().parent != self.backups.resolve() or not re.fullmatch(r'backup-[a-f0-9]{12}',p.name):
                continue
            try:
                meta = json.loads((p/'metadata.json').read_text())
                if meta.get('schema') == 1 and meta['state']['project'] == project:
                    candidates.append((meta['createdAt'],p.name,p))
            except (OSError,ValueError,KeyError):
                continue
        for _,_,p in sorted(candidates,reverse=True)[int(self.config()['PAWTALK_BACKUP_KEEP']):]:
            shutil.rmtree(p)

    def backup(self,entry,resume=True):
        state,config = entry['previous'],entry['config']
        # Ensure failed copies, full disks and interrupted backups cannot claim success.
        self.backups.mkdir(parents=True,exist_ok=True,mode=0o700)
        # Reserve space for both the stopped backup and a fresh restore volume.
        required = max(512*1024*1024,self.runtime.data_size(state)*24//10+16*1024*1024)
        if shutil.disk_usage(self.backups).free < required:
            raise ValueError('Insufficient space for a consistent room backup')
        name = 'backup-'+uuid.uuid4().hex[:12]
        temporary = self.backups/('.'+name)
        temporary.mkdir(mode=0o700)
        secure(temporary)
        self.runtime.stop(state,config)
        try:
            archive = temporary/'data.tar'
            self.runtime.export(state,archive)
            os.chmod(archive,0o600)
            metadata = dict(schema=1,createdAt=int(time.time()),state=state,config=config,
                            sha256=checksum(archive),template=entry['template'])
            manager = self.root/'opt/pawtalk-manager/versions'/state['managerVersion']
            if (manager/'verified-bundle.tar.gz').is_file():
                shutil.copyfile(manager/'verified-bundle.tar.gz',temporary/'manager.tar.gz')
                shutil.copyfile(manager/'manager-manifest.json',temporary/'manager-manifest.json')
                metadata['managerSha256'] = checksum(temporary/'manager.tar.gz')
            save(temporary/'metadata.json',metadata)
            secure(temporary)
            os.rename(temporary,self.backups/name)
            entry.update(backup=name,phase='backed-up')
            save(self.journal,entry)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
            if resume:
                self.runtime.start(state,config)
                self.runtime.healthy(state,config,state.get('identity'))
        return name

    def snapshot(self,name):
        if not re.fullmatch(r'backup-[a-f0-9]{12}',name):
            raise ValueError('Invalid backup name')
        directory = self.backups/name
        if directory.is_symlink() or directory.resolve().parent != self.backups.resolve():
            raise ValueError('Unsafe backup directory')
        secure(directory)
        meta = json.loads((directory/'metadata.json').read_text())
        archive = directory/'data.tar'
        if meta.get('schema') != 1 or archive.is_symlink() or checksum(archive) != meta['sha256']:
            raise ValueError('Backup integrity check failed')
        if 'managerSha256' in meta and checksum(directory/'manager.tar.gz') != meta['managerSha256']:
            raise ValueError('Backup Manager bundle integrity check failed')
        validate(meta['config'])
        # Validate every member before extraction (including symlinks and hardlinks).
        with tarfile.open(archive) as contents:
            names = set()
            for member in contents:
                path = Path(member.name)
                if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                    raise ValueError('Unsafe backup archive member')
                if member.name in names:
                    raise ValueError('Duplicate backup member')
                names.add(member.name)
            if not any(n.lstrip('./') == 'state.json' for n in names):
                raise ValueError('Backup has no room identity')
        return meta,archive

    def restore_data(self,name,resume=True):
        meta,archive = self.snapshot(name)
        previous = meta['state']
        restored = {**previous,'volume':previous['project']+'-restore-'+uuid.uuid4().hex[:12]}
        self.runtime.import_backup(restored,archive)
        atomic(self.template,base64.b64decode(meta['template'],validate=True))
        write_config(self.etc/'config.env',meta['config'])
        if resume:
            self.runtime.start(restored,meta['config'])
            self.runtime.healthy(restored,meta['config'],previous.get('identity'))
        elif hasattr(self.runtime,'prepare'):
            self.runtime.prepare(restored,meta['config'])
        save(self.state_file,restored)
        return restored

    def recover(self):
        if not self.journal.exists():
            return False
        entry = json.loads(self.journal.read_text())
        if entry['phase'] == 'committed':
            remove(self.journal)
            return True
        state,config = entry['previous'],entry['config']
        if entry['phase'] == 'applying' and entry.get('backup'):
            # A new image may have changed SQLite. Always restore the data/image pair.
            try:
                self.runtime.stop(state,config)
            except (RuntimeError,ValueError):
                pass
            self.restore_data(entry['backup'],resume=entry.get('resume',True))
        else:
            atomic(self.template,base64.b64decode(entry['template'],validate=True))
            write_config(self.etc/'config.env',config)
            if entry.get('resume',True):
                self.runtime.start(state,config)
                self.runtime.healthy(state,config,state.get('identity'))
            elif hasattr(self.runtime,'prepare'):
                self.runtime.prepare(state,config)
            save(self.state_file,state)
        if entry['kind'] == 'manager-update':
            for name,target in entry.get('pointers',{}).items():
                if WINDOWS:
                    from .release import semver
                    semver(target['version'])
                    save(self.root/'opt/pawtalk-manager'/(name+'.json'),target)
                    continue
                if not re.fullmatch(r'versions/[0-9A-Za-z.-]+',target):
                    raise ValueError('Unsafe recovery pointer')
                pointer = self.root/'opt/pawtalk-manager'/name
                temporary = pointer.with_name('.recovery-'+name)
                temporary.unlink(missing_ok=True)
                temporary.symlink_to(target)
                os.replace(temporary,pointer)
            atomic(self.etc/'trust.json',base64.b64decode(entry['trust'],validate=True))
            for name,data in entry.get('units',{}).items():
                atomic(self.root/'etc/systemd/system'/name,base64.b64decode(data,validate=True),0o644)
            if self.root == Path('/') and Path('/run/systemd/system').is_dir():
                run(['systemctl','daemon-reload'])
        # A killed exporter cannot finalize its temporary snapshot. The shared
        # operation lock excludes active backups; remove only our exact private names.
        for partial in self.backups.glob('.backup-*'):
            if re.fullmatch(r'\.backup-[a-f0-9]{12}',partial.name) and not partial.is_symlink() and partial.resolve().parent == self.backups.resolve():
                shutil.rmtree(partial)
        self.finish('recovered')
        return True

    def install(self,config,manifest,template,manager_version):
        config = validate(config)
        if self.state_file.exists():
            self.recover()
            state = self.state()
            if 'identity' not in state:
                self.runtime.create_volume(state)
            # Reinstall never resets data, identities, configuration or installed digest.
            if WINDOWS and os.environ.get('PAWTALK_INSTALL_KEEP_STOPPED') == '1':
                self.runtime.prepare(state,self.config())
            else:
                self.runtime.start(state,self.config())
                state['identity'] = self.runtime.healthy(state,self.config(),state.get('identity'))
            save(self.state_file,state)
            return False
        state = dict(project='pawtalk-'+uuid.uuid4().hex[:12],version=manifest['version'],
                     image=IMAGE+'@'+manifest['digest'],dataSchema=1,managerVersion=manager_version,serverManifest=manifest['_signed'])
        if 'windows' in manifest:
            state['windows'] = manifest['windows']
        state['volume'] = state['project']
        self.runtime.pull(state)
        write_config(self.etc/'config.env',config)
        atomic(self.template,Path(template).read_bytes())
        # Record ownership before creating the volume/starting the first container.
        save(self.state_file,state)
        self.runtime.create_volume(state)
        self.runtime.start(state,config)
        state['identity'] = self.runtime.healthy(state,config)
        save(self.state_file,state)
        return True

    def create_backup(self):
        self.recover()
        entry = self.transaction(self.state(),self.config(),'backup')
        entry['resume'] = bool(self.runtime.container(self.state(),self.config())['State'].get('Running'))
        save(self.journal,entry)
        try:
            name = self.backup(entry,resume=entry['resume'])
        except Exception:
            self.recover()
            raise
        self.finish()
        self.prune()
        return name

    def delete_backup(self,name):
        # Caller holds operation.lock. A rollback source must remain available.
        if not isinstance(name,str) or not re.fullmatch(r'backup-[a-f0-9]{12}',name):
            raise ValueError('Invalid backup name')
        directory=self.backups/name
        target=directory.resolve()
        def is_link(path):
            return path.is_symlink() or (WINDOWS and path.is_junction())
        if not self.backups.resolve().is_relative_to(self.root.resolve()) or is_link(directory) or target.parent!=self.backups.resolve() or not directory.is_dir():
            raise ValueError('Unsafe or missing backup directory')
        if self.journal.exists() and json.loads(self.journal.read_text()).get('backup')==name:
            raise ValueError('Backup is required for pending recovery')
        # Reject nested links before recursive removal; never traverse out of
        # this exact, resolved backup directory (including Windows junctions).
        for current,dirs,files in os.walk(directory,followlinks=False):
            for item in (Path(current)/entry for entry in dirs+files):
                if is_link(item) or not item.resolve().is_relative_to(target):
                    raise ValueError('Backup contains an unsafe link')
        shutil.rmtree(target)

    def update_server(self,manifest,local=False):
        self.recover()
        state,config = self.state(),self.config()
        if local and (not WINDOWS or manifest.get('_local') is not True): raise ValueError('Local packages require explicit Windows approval')
        replacing_local=local or bool(state.get('localPackage'))
        if not replacing_local and semver(manifest['version']) == semver(state['version']) and state['image'] != IMAGE+'@'+manifest['digest']:
            raise ValueError('Published Server version was replaced; refusing changed digest')
        if WINDOWS and not replacing_local and semver(manifest['version']) == semver(state['version']) and state.get('windows') != manifest.get('windows'):
            raise ValueError('Published Windows Server version was replaced')
        if not replacing_local and semver(manifest['version']) <= semver(state['version']):
            return False
        if manifest['dataSchema'] != state['dataSchema'] or manifest['apiProtocol'] != 1:
            raise ValueError('Unsupported server data/protocol transition')
        candidate = {**state,'version':manifest['version'],'image':IMAGE+'@'+manifest['digest'],'serverManifest':manifest['_signed']}
        candidate.pop('localPackage',None)
        if local: candidate['localPackage']=manifest['windows']['sha256']
        if 'windows' in manifest:
            candidate['windows'] = manifest['windows']
        elif WINDOWS:
            raise ValueError('Server release has no Windows artifact')
        if not WINDOWS and candidate['image'] == state['image']:
            save(self.state_file,candidate)
            return False
        self.runtime.pull(candidate)
        # Validate old digest is still locally usable before stopping anything.
        self.runtime.verify_image(state)
        was_running = bool(self.runtime.container(state,config)['State'].get('Running')) if WINDOWS else True
        entry = self.transaction(state,config,'server-update')
        entry['resume'] = was_running
        save(self.journal,entry)
        try:
            self.backup(entry,resume=False)
            entry['phase'] = 'applying'
            save(self.journal,entry)
            if was_running:
                self.runtime.start(candidate,config)
                self.runtime.healthy(candidate,config,state['identity'])
            elif hasattr(self.runtime,'prepare'):
                self.runtime.prepare(candidate,config)
            save(self.state_file,candidate)
            self.finish()
            self.prune()
            return True
        except Exception:
            self.recover()
            raise RuntimeError('Server update failed; previous image/data restored and verified') from None

    def configure(self,changes):
        self.recover()
        state,old = self.state(),self.config()
        new = validate({**old,**changes})
        network_changed = any(new[key] != old[key] for key in ('PAWTALK_PUBLIC_IP','PAWTALK_PORT'))
        if network_changed and not hasattr(self.runtime,'reconfigure_network'):
            raise ValueError('Address/port changes are supported by the native Windows runtime only')
        runtime_keys = ['PAWTALK_PUBLIC_IP','PAWTALK_PORT','PAWTALK_E2EE','PAWTALK_E2EE_KEY_ID','PAWTALK_CHAT_MAX_MB','PAWTALK_UPDATE_PROXY']
        if all(new[key] == old[key] for key in runtime_keys):
            write_config(self.etc/'config.env',new)
            return False
        was_running = bool(self.runtime.container(state,old)['State'].get('Running'))
        entry = self.transaction(state,old,'configure')
        entry['resume'] = was_running
        save(self.journal,entry)
        try:
            self.backup(entry,resume=False)
            entry['phase'] = 'applying'
            save(self.journal,entry)
            candidate = dict(state)
            if network_changed:
                candidate['identity'] = self.runtime.reconfigure_network(state,old,new)
            write_config(self.etc/'config.env',new)
            if was_running:
                self.runtime.start(candidate,new) # Always the installed digest, never a config pin.
                self.runtime.healthy(candidate,new,candidate['identity'])
            elif hasattr(self.runtime,'prepare'):
                self.runtime.prepare(candidate,new)
            save(self.state_file,candidate)
            self.finish()
            self.prune()
        except Exception:
            self.recover()
            raise
        return True

    def restore(self,name):
        meta,_ = self.snapshot(name) # Verify completely before interrupting a running room.
        if self.state_file.exists() and meta['state']['project'] != self.state()['project'] and self.runtime.project_exists(meta['state'],meta['config']):
            raise ValueError('Refusing to restore over another existing Docker project')
        self.runtime.pull(meta['state'])
        self.recover()
        if self.state_file.exists():
            installed_manager = self.state()['managerVersion']
            entry = self.transaction(self.state(),self.config(),'restore')
            entry['resume'] = bool(self.runtime.container(self.state(),self.config())['State'].get('Running'))
            save(self.journal,entry)
            try:
                self.backup(entry,resume=False)
                entry['phase'] = 'applying'
                save(self.journal,entry)
                self.restore_data(name,resume=entry['resume'])
                save(self.state_file,{**self.state(),'managerVersion':installed_manager})
            except Exception:
                self.recover()
                raise
            self.finish()
        else:
            meta,_ = self.snapshot(name)
            if self.runtime.project_exists(meta['state'],meta['config']):
                raise ValueError('Refusing fresh restore over an existing Docker project')
            self.restore_data(name)

    def watchdog(self,now=None):
        self.recover()
        state,config = self.state(),self.config()
        info = self.runtime.container(state,config)
        file = self.directory/'health.json'
        health = json.loads(file.read_text()) if file.exists() else dict(attempts=0,next=0)
        now = time.time() if now is None else now
        if info['State'].get('Health',{}).get('Status') == 'healthy':
            save(file,dict(attempts=0,next=0))
            return 'healthy'
        if not info['State'].get('Running'):
            return 'stopped; inspect Windows service recovery or start manually' if WINDOWS else 'stopped; inspect Docker restart policy or start manually'
        if info['State'].get('Health',{}).get('Status') != 'unhealthy':
            return 'starting'
        if health['attempts'] >= 3 or now < health['next']:
            return 'backoff; run pawtalkctl doctor'
        save(file,dict(attempts=health['attempts']+1,next=now+min(3600,300*2**health['attempts'])))
        self.runtime.compose(state,config,'restart','server')
        return 'restarted unhealthy room'
