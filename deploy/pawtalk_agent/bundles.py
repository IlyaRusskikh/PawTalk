"""Only verified Deploy bundles may become executable; no tar links or traversal."""
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

FILES = {'deploy/VERSION','deploy/trust.json','deploy/compose.server.yaml','deploy/launcher','deploy/pawtalkctl',
         'deploy/pawtalk-update.service','deploy/pawtalk-update.timer','deploy/pawtalk-health.service','deploy/pawtalk-health.timer',
         'LICENSE','THIRD_PARTY_NOTICES.md'}
MODULES = {'__init__','release','config','runtime','controller','preflight','bundles','cli'}
FILES |= {'deploy/pawtalk_agent/'+name+'.py' for name in MODULES}


def unpack(file,destination):
    seen,total = set(),0
    with tarfile.open(file,'r:gz') as contents:
        for item in contents:
            if item.name not in FILES or item.name in seen or not item.isfile() or not 0 <= item.size <= 4*1024*1024:
                raise ValueError('Unexpected/unsafe Deploy archive entry')
            seen.add(item.name)
            total += item.size
            if total>32*1024*1024:
                raise ValueError('Deploy archive expands beyond limit')
            output = Path(destination)/item.name
            output.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            with contents.extractfile(item) as source:
                atomic(output,source.read(),0o700 if item.name in ('deploy/launcher','deploy/pawtalkctl') else 0o600)
    if seen != FILES:
        raise ValueError('Incomplete Deploy bundle')


def self_test(directory):
    script = Path(directory)/'deploy/pawtalkctl'
    p = subprocess.run([sys.executable,'-I',str(script),'--self-test'],capture_output=True,timeout=15)
    if p.returncode or p.stdout.strip() != b'PawTalk deploy protocol 1 OK':
        raise ValueError('Deploy self-test failed')


def stage(root,manifest,keys,file=None,get=fetch):
    root = Path(root)
    versions = root/'opt/pawtalk-agent/versions'
    versions.mkdir(parents=True,exist_ok=True,mode=0o700)
    destination = versions/manifest['version']
    if destination.exists():
        marker = json.loads((destination/'verified.json').read_text())
        if marker.get('sha256') != manifest['sha256']:
            raise ValueError('Refusing to replace an existing Deploy version')
        self_test(destination)
        return destination
    with tempfile.TemporaryDirectory(prefix='.deploy-',dir=versions) as temporary:
        temporary = Path(temporary)
        archive = temporary/'bundle.tar.gz'
        if file is None:
            url = f'https://github.com/{REPO}/releases/download/deploy-v{manifest["version"]}/{manifest["bundle"]}'
            atomic(archive,get(url,manifest['size']))
        else:
            shutil.copyfile(file,archive)
        if archive.stat().st_size != manifest['size'] or checksum(archive) != manifest['sha256']:
            raise ValueError('Deploy bundle hash/size mismatch')
        content = temporary/'content'
        content.mkdir(mode=0o700)
        unpack(archive,content)
        if (content/'deploy/VERSION').read_text().strip() != manifest['version']:
            raise ValueError('Deploy version mismatch')
        new_keys = json.loads((content/'deploy/trust.json').read_text())
        for component in ('server','deploy'):
            if any(new_keys.get(component,{}).get(key) != value for key,value in keys[component].items()):
                raise ValueError('Trust-root removal/change requires explicit maintenance')
        launcher = root/'opt/pawtalk-agent/launcher'
        if launcher.exists() and launcher.read_bytes() != (content/'deploy/launcher').read_bytes():
            raise ValueError('Stable launcher changes require explicit maintenance')
        self_test(content)
        save(content/'verified.json',dict(sha256=manifest['sha256'],version=manifest['version']))
        if '_signed' not in manifest:
            raise ValueError('Verified Deploy signature receipt required')
        atomic(content/'deploy-manifest.json',manifest['_signed'].encode())
        shutil.copyfile(archive,content/'verified-bundle.tar.gz')
        os.chmod(content/'verified-bundle.tar.gz',0o600)
        os.rename(content,destination)
    return destination


def switch(root,destination):
    agent = Path(root)/'opt/pawtalk-agent'
    destination = Path(destination).resolve()
    if destination.parent != (agent/'versions').resolve():
        raise ValueError('Unsafe controller directory')
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
    fd = os.open(agent,os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def install_units(root,directory,config,no_systemd=False):
    root,directory = Path(root),Path(directory)
    for name in ['pawtalk-update.service','pawtalk-update.timer','pawtalk-health.service','pawtalk-health.timer']:
        atomic(root/'etc/systemd/system'/name,(directory/'deploy'/name).read_bytes(),0o644)
    if no_systemd:
        return
    from .runtime import run
    run(['systemctl','daemon-reload'])
    run(['systemctl','enable','--now','pawtalk-health.timer'])
    enabled = any(config[k] == 'true' for k in ['PAWTALK_SERVER_AUTO_UPDATE','PAWTALK_DEPLOY_AUTO_UPDATE'])
    run(['systemctl','enable' if enabled else 'disable','--now','pawtalk-update.timer'])


def activate(controller,manifest,keys,file=None,no_systemd=False):
    root = controller.root
    state,config = controller.state(),controller.config()
    if semver(manifest['version']) == semver(state['deployVersion']):
        receipt = root/'opt/pawtalk-agent/versions'/state['deployVersion']/'verified.json'
        if json.loads(receipt.read_text()).get('sha256') != manifest['sha256']:
            raise ValueError('Published Deploy version was replaced; refusing changed bundle')
    if semver(manifest['version']) <= semver(state['deployVersion']):
        return False
    destination = stage(root,manifest,keys,file)
    # Compose comments/formatting changes do not cause a server restart.
    from .runtime import Runtime
    new_template = destination/'deploy/compose.server.yaml'
    new_runtime = Runtime(new_template)
    before = json.loads(controller.runtime.compose(state,config,'config','--format','json'))
    after = json.loads(new_runtime.compose(state,config,'config','--format','json'))
    # Compose includes its source filename in labels on some versions; service
    # config itself is otherwise deterministic. Normal config output omits those labels.
    entry = controller.transaction(state,config,'deploy-update')
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
        save(controller.state_file,{**state,'deployVersion':manifest['version']})
        # Trust additions are authenticated by the previous Deploy trust root.
        atomic(controller.etc/'trust.json',(destination/'deploy/trust.json').read_bytes())
        controller.finish()
        controller.prune()
    except Exception:
        controller.recover()
        raise
    return True
