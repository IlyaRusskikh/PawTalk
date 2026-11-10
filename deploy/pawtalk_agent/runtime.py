"""Compose adapter. Only the recorded PawTalk project/labelled volume is managed."""
import hashlib
import json
import re
import subprocess
import time
from pathlib import Path
from .release import DIGEST, IMAGE


def run(args, *, input=None, timeout=180, output=None):
    result = subprocess.run(args,input=input,stdout=output or subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
    if result.returncode:
        # Docker output can include room credentials/config; keep it out of ordinary logs.
        raise RuntimeError(f'{args[0]} {args[1]} failed (exit {result.returncode}); run pawtalkctl doctor')
    return result.stdout


class Runtime:
    def __init__(self, template):
        self.template = Path(template)

    def names(self,state):
        if not isinstance(state.get('project'),str) or not isinstance(state.get('volume'),str) or not re.fullmatch(r'pawtalk-[a-f0-9]{12}',state['project']) or not re.fullmatch(r'pawtalk-[a-f0-9]{12}(?:-restore-[a-f0-9]{12})?',state['volume']):
            raise ValueError('Unsafe managed project/volume')

    def compose(self, state, config, *args):
        self.names(state)
        image = state['image']
        if not image.startswith(IMAGE+'@') or not DIGEST.fullmatch(image[len(IMAGE)+1:]):
            raise ValueError('Runtime requires a pinned PawTalk Server digest')
        # Config travels only through the child environment; never execute/source it.
        import os
        env = {'PATH':os.environ.get('PATH','/usr/bin:/bin'), 'HOME':os.environ.get('HOME','/root'),
               **config,'PAWTALK_IMAGE':image,'PAWTALK_DATA_VOLUME':state['volume']}
        command = ['docker','compose','--project-name',state['project'],'--file',str(self.template),'--env-file','/dev/null',*args]
        p = subprocess.run(command,env=env,capture_output=True,timeout=180)
        if p.returncode:
            raise RuntimeError('Compose command failed: '+args[0]+'; run pawtalkctl doctor')
        return p.stdout

    def container(self,state,config):
        ids = self.compose(state,config,'ps','-a','-q','server').decode().split()
        if len(ids) != 1 or not re.fullmatch(r'[a-f0-9]{12,64}',ids[0]):
            raise ValueError('Expected exactly one managed room container')
        info = json.loads(run(['docker','inspect',ids[0]]))[0]
        labels = info['Config'].get('Labels',{})
        if labels.get('io.pawtalk.managed') != 'compose-v1' or labels.get('com.docker.compose.project') != state['project']:
            raise ValueError('Container ownership mismatch')
        return info

    def create_volume(self,state):
        self.names(state)
        # Never adopt an existing arbitrary volume, even if it has a similar name.
        existing = subprocess.run(['docker','volume','inspect',state['volume']],capture_output=True)
        if existing.returncode == 0:
            info = json.loads(existing.stdout)[0]
            if (info.get('Labels') or {}).get('io.pawtalk.project') != state['project']:
                raise ValueError('Refusing to adopt an unowned Docker volume')
        else:
            # Inspect failure can mean unavailable Docker, not just an absent volume.
            run(['docker','info','--format','{{.OSType}}'])
            run(['docker','volume','create','--label','io.pawtalk.project='+state['project'],state['volume']])

    def check_volume(self,state):
        self.names(state)
        info = json.loads(run(['docker','volume','inspect',state['volume']]))[0]
        if (info.get('Labels') or {}).get('io.pawtalk.project') != state['project']:
            raise ValueError('Volume ownership mismatch')

    def pull(self,state):
        run(['docker','pull',state['image']],timeout=600)
        # Pulling and running the signed digest binds the exact registry object.
        run(['docker','image','inspect',state['image']])

    def verify_image(self,state):
        run(['docker','image','inspect',state['image']])

    def start(self,state,config):
        self.check_volume(state)
        if self.compose(state,config,'ps','-a','-q','server').strip():
            self.container(state,config) # Refuse replacing an unowned service.
        self.compose(state,config,'up','-d','--no-deps','server')

    def project_exists(self,state,config):
        if not re.fullmatch(r'pawtalk-[a-f0-9]{12}',state['project']):
            raise ValueError('Unsafe project name')
        return bool(run(['docker','ps','-a','-q','--filter','label=com.docker.compose.project='+state['project']]).strip())

    def data_size(self,state):
        self.check_volume(state)
        size = run(['docker','run','--rm','--network','none','--read-only','--user','65532:65532','--cap-drop','ALL',
                    '--security-opt','no-new-privileges:true','--mount','type=volume,source='+state['volume']+',target=/data,readonly',
                    '--entrypoint','du',state['image'],'-sk','/data'])
        return int(size.split()[0])*1024

    def stop(self,state,config):
        self.container(state,config)
        self.compose(state,config,'stop','-t','20','server')

    def identity(self,state,config):
        info = self.container(state,config)
        raw = run(['docker','exec',info['Id'],'/pawtalk','serve','info']).decode().strip()
        if not re.fullmatch(r'pawtalk://[^/\s]+/[a-f0-9]{64}',raw):
            raise ValueError('Invalid room identity')
        return hashlib.sha256(raw.encode()).hexdigest()

    def healthy(self,state,config,expected=None,timeout=90):
        deadline = time.monotonic()+timeout
        while time.monotonic()<deadline:
            try:
                info = self.container(state,config)
                if info['State'].get('Health',{}).get('Status') == 'healthy':
                    run(['docker','exec',info['Id'],'/pawtalk','serve','healthcheck'])
                    identity = self.identity(state,config)
                    if expected is not None and identity != expected:
                        raise ValueError('TLS/invitation identity changed')
                    return identity
            except RuntimeError:
                pass
            time.sleep(1)
        raise RuntimeError('Room health verification timed out')

    def export(self,state,destination):
        self.check_volume(state)
        with open(destination,'xb') as stream:
            run(['docker','run','--rm','--network','none','--read-only','--user','65532:65532','--cap-drop','ALL',
                 '--security-opt','no-new-privileges:true','--mount','type=volume,source='+state['volume']+',target=/data,readonly',
                 '--entrypoint','tar',state['image'],'-C','/data','-cf','-','.'],output=stream,timeout=600)
            import os
            stream.flush()
            os.fsync(stream.fileno())

    def import_backup(self,state,source):
        self.create_volume(state)
        # Destination is a newly generated volume; the damaged/original volume survives.
        with open(source,'rb') as stream:
            p = subprocess.run(['docker','run','--rm','-i','--network','none','--read-only','--user','65532:65532','--cap-drop','ALL',
                 '--security-opt','no-new-privileges:true','--mount','type=volume,source='+state['volume']+',target=/data',
                 '--entrypoint','tar',state['image'],'-C','/data','--no-same-owner','-xf','-'],stdin=stream,capture_output=True,timeout=600)
            if p.returncode:
                raise RuntimeError('Restore extraction failed; original room data retained')
