"""Strict data-only config and durable managed state, never source an env file."""
import contextlib
import fcntl
import ipaddress
import json
import os
import re
import tempfile
from pathlib import Path

DEFAULTS = dict(PAWTALK_PORT='18443',PAWTALK_E2EE='false',PAWTALK_E2EE_KEY_ID='',
                PAWTALK_CHAT_MAX_MB='128',PAWTALK_UPDATE_PROXY='true',
                PAWTALK_BACKUP_KEEP='5',
                PAWTALK_SERVER_AUTO_UPDATE='false',PAWTALK_DEPLOY_AUTO_UPDATE='false',
                PAWTALK_SERVER_CHANNEL='preview',PAWTALK_DEPLOY_CHANNEL='preview',PAWTALK_LANGUAGE='ru')


def validate(values):
    values = {**DEFAULTS, **values}
    if set(values) != set(DEFAULTS) | {'PAWTALK_PUBLIC_IP'}:
        raise ValueError('Unknown/missing configuration field')
    address = ipaddress.ip_address(values['PAWTALK_PUBLIC_IP'])
    if address.version != 4 or address.is_unspecified or address.is_multicast:
        raise ValueError('Expected unicast IPv4 address')
    if not re.fullmatch(r'[0-9]{1,5}', values['PAWTALK_PORT']) or not 1024 <= int(values['PAWTALK_PORT']) <= 65532:
        raise ValueError('Port must be 1024..65532')
    for key in ['PAWTALK_E2EE','PAWTALK_UPDATE_PROXY','PAWTALK_SERVER_AUTO_UPDATE','PAWTALK_DEPLOY_AUTO_UPDATE']:
        if values[key] not in ('true','false'):
            raise ValueError('Invalid boolean: '+key)
    for key in ['PAWTALK_SERVER_CHANNEL','PAWTALK_DEPLOY_CHANNEL']:
        if values[key] not in ('stable','preview'):
            raise ValueError('Invalid update channel')
    key_id = values['PAWTALK_E2EE_KEY_ID']
    if (key_id or values['PAWTALK_E2EE'] == 'true') and not re.fullmatch(r'[a-f0-9]{64}',key_id):
        raise ValueError('E2EE requires the SHA-256 key ID, never the secret key')
    if not re.fullmatch(r'[0-9]{1,7}',values['PAWTALK_CHAT_MAX_MB']) or int(values['PAWTALK_CHAT_MAX_MB']) > 1048576:
        raise ValueError('Invalid chat limit')
    if values['PAWTALK_LANGUAGE'] not in ('ru','en'):
        raise ValueError('Invalid language')
    if not re.fullmatch(r'[0-9]{1,4}',values['PAWTALK_BACKUP_KEEP']) or not 1 <= int(values['PAWTALK_BACKUP_KEEP']) <= 1000:
        raise ValueError('Backup retention must be 1..1000')
    return values


def read_config(file):
    values = {}
    for line in Path(file).read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep or key in values or re.search(r'[\s\x00$`"\'\\]',value):
            raise ValueError('Invalid/repeated configuration field')
        values[key] = value
    return validate(values)


def atomic(file, data, mode=0o600):
    file = Path(file)
    file.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix='.'+file.name+'-',dir=file.parent)
    try:
        with os.fdopen(fd,'wb') as out:
            os.fchmod(out.fileno(),mode)
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary,file)
        directory = os.open(file.parent,os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_config(file, values):
    values = validate(values)
    atomic(file,''.join(k+'='+v+'\n' for k,v in sorted(values.items())).encode())


def save(file, data):
    atomic(file,(json.dumps(data,sort_keys=True)+'\n').encode())


def remove(file):
    file = Path(file)
    file.unlink(missing_ok=True)
    directory = os.open(file.parent,os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


@contextlib.contextmanager
def lock(file):
    Path(file).parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    with open(file,'a') as stream:
        os.chmod(file,0o600)
        try:
            fcntl.flock(stream,fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Another PawTalk operation is running') from None
        try:
            yield
        finally:
            fcntl.flock(stream,fcntl.LOCK_UN)
