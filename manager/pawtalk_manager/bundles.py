"""Only verified Manager bundles may become executable; no tar links or traversal."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from .config import atomic, save
from .controller import checksum
from .release import REPO, fetch, semver
from .platforms import WINDOWS, host, sync_directory, admin, protect, secure

FILES = {'manager/VERSION','manager/trust.json','manager/compose.server.yaml','manager/launcher','manager/pawtalkctl',
         'manager/pawtalk-update.service','manager/pawtalk-update.timer','manager/pawtalk-health.service','manager/pawtalk-health.timer',
         'LICENSE','THIRD_PARTY_NOTICES.md'}
MODULES = {'__init__','release','config','runtime','controller','preflight','bundles','cli','platforms','native'}
FILES |= {'manager/pawtalk_manager/'+name+'.py' for name in MODULES}


def unpack(file,destination):
    seen,total = set(),0
    with tarfile.open(file,'r:gz') as contents:
        for item in contents:
            if item.name not in FILES or item.name in seen or not item.isfile() or not 0 <= item.size <= 4*1024*1024:
                raise ValueError('Unexpected/unsafe Manager archive entry')
            seen.add(item.name)
            total += item.size
            if total>32*1024*1024:
                raise ValueError('Manager archive expands beyond limit')
            output = Path(destination)/item.name
            output.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            secure(output.parent)
            with contents.extractfile(item) as source:
                atomic(output,source.read(),0o700 if item.name in ('manager/launcher','manager/pawtalkctl') else 0o600)
    if seen != FILES:
        raise ValueError('Incomplete Manager bundle')


def self_test(directory):
    script = Path(directory)/'manager/pawtalkctl'
    p = subprocess.run([sys.executable,'-B','-X','utf8','-I',str(script),'--self-test'],capture_output=True,timeout=15)
    if p.returncode or p.stdout.strip() != b'PawTalk manager protocol 1 OK':
        raise ValueError('Manager self-test failed')


def stage(root,manifest,keys,file=None,get=fetch):
    root = Path(root)
    versions = root/'opt/pawtalk-manager/versions'
    versions.mkdir(parents=True,exist_ok=True,mode=0o700)
    destination = versions/manifest['version']
    if destination.exists():
        marker = json.loads((destination/'verified.json').read_text())
        if marker.get('sha256') != manifest['sha256']:
            raise ValueError('Refusing to replace an existing Manager version')
        self_test(destination)
        return destination
    with tempfile.TemporaryDirectory(prefix='.manager-',dir=versions) as temporary:
        temporary = Path(temporary)
        secure(temporary)
        archive = temporary/'bundle.tar.gz'
        if file is None:
            url = f'https://github.com/{REPO}/releases/download/manager-v{manifest["version"]}/{manifest["bundle"]}'
            atomic(archive,get(url,manifest['size']))
        else:
            shutil.copyfile(file,archive)
        if archive.stat().st_size != manifest['size'] or checksum(archive) != manifest['sha256']:
            raise ValueError('Manager bundle hash/size mismatch')
        content = temporary/'content'
        content.mkdir(mode=0o700)
        secure(content)
        unpack(archive,content)
        if (content/'manager/VERSION').read_text().strip() != manifest['version']:
            raise ValueError('Manager version mismatch')
        new_keys = json.loads((content/'manager/trust.json').read_text())
        for component in ('server','manager'):
            if any(new_keys.get(component,{}).get(key) != value for key,value in keys[component].items()):
                raise ValueError('Trust-root removal/change requires explicit maintenance')
        launcher = root/'opt/pawtalk-manager/launcher'
        if launcher.exists() and launcher.read_bytes() != (content/'manager/launcher').read_bytes():
            raise ValueError('Stable launcher changes require explicit maintenance')
        self_test(content)
        save(content/'verified.json',dict(sha256=manifest['sha256'],version=manifest['version']))
        if '_signed' not in manifest:
            raise ValueError('Verified Manager signature receipt required')
        atomic(content/'manager-manifest.json',manifest['_signed'].encode())
        shutil.copyfile(archive,content/'verified-bundle.tar.gz')
        os.chmod(content/'verified-bundle.tar.gz',0o600)
        secure(content)
        os.rename(content,destination)
    if WINDOWS and admin():
        protect(root)
    return destination


def switch(root,destination):
    agent = Path(root)/'opt/pawtalk-manager'
    destination = Path(destination).resolve()
    if destination.parent != (agent/'versions').resolve():
        raise ValueError('Unsafe controller directory')
    if WINDOWS:
        if (agent/'current.json').exists():
            atomic(agent/'previous.json',(agent/'current.json').read_bytes())
        save(agent/'current.json',dict(version=destination.name))
        return
    for pointer in ['previous','current']:
        file = agent/pointer
        if pointer == 'previous':
            current = agent/'current'
            if not current.is_symlink():
                continue
            target = os.readlink(current)
        else:
            target = 'versions/'+destination.name
        temporary = agent/('.'+pointer)
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(target)
        os.replace(temporary,file)
    sync_directory(agent)


def install_units(root,directory,config,no_systemd=False):
    root,directory = Path(root),Path(directory)
    if WINDOWS:
        for action in ['install-server','install-manager','start-manager']:
            if host(action,root).returncode:
                raise RuntimeError('Windows service setup failed')
        return
    for name in ['pawtalk-update.service','pawtalk-update.timer','pawtalk-health.service','pawtalk-health.timer']:
        atomic(root/'etc/systemd/system'/name,(directory/'manager'/name).read_bytes(),0o644)
    if no_systemd:
        return
    from .runtime import run
    run(['systemctl','daemon-reload'])
    run(['systemctl','enable','--now','pawtalk-health.timer'])
    enabled = any(config[k] == 'true' for k in ['PAWTALK_SERVER_AUTO_UPDATE','PAWTALK_MANAGER_AUTO_UPDATE'])
    run(['systemctl','enable' if enabled else 'disable','--now','pawtalk-update.timer'])


def activate(controller,manifest,keys,file=None,no_systemd=False):
    root = controller.root
    state,config = controller.state(),controller.config()
    if semver(manifest['version']) == semver(state['managerVersion']):
        receipt = root/'opt/pawtalk-manager/versions'/state['managerVersion']/'verified.json'
        if json.loads(receipt.read_text()).get('sha256') != manifest['sha256']:
            raise ValueError('Published Manager version was replaced; refusing changed bundle')
    if semver(manifest['version']) <= semver(state['managerVersion']):
        return False
    destination = stage(root,manifest,keys,file)
    # Compose comments/formatting changes do not cause a server restart.
    from .runtime import Runtime
    new_template = destination/'manager/compose.server.yaml'
    new_runtime = controller.runtime if WINDOWS else Runtime(new_template)
    before = json.loads(controller.runtime.compose(state,config,'config','--format','json'))
    after = json.loads(new_runtime.compose(state,config,'config','--format','json'))
    # Compose includes its source filename in labels on some versions; service
    # config itself is otherwise deterministic. Normal config output omits those labels.
    entry = controller.transaction(state,config,'manager-update')
    try:
        if before != after:
            controller.backup(entry,resume=False)
            entry['phase'] = 'applying'
            save(controller.journal,entry)
            atomic(controller.template,new_template.read_bytes())
            controller.runtime.start(state,config)
            controller.runtime.healthy(state,config,state['identity'])
        else:
            atomic(controller.template,new_template.read_bytes())
        install_units(root,destination,config,no_systemd)
        switch(root,destination)
        save(controller.state_file,{**state,'managerVersion':manifest['version']})
        # Trust additions are authenticated by the previous Manager trust root.
        atomic(controller.etc/'trust.json',(destination/'manager/trust.json').read_bytes())
        controller.finish()
        controller.prune()
    except Exception:
        controller.recover()
        raise
    return True
