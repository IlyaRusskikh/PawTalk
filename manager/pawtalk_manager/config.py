"""Strict data-only config and durable managed state, never source an env file."""
import contextlib
import ipaddress
import json
import os
import re
import tempfile
from pathlib import Path
from .platforms import WINDOWS, sync_directory, secure
if WINDOWS:
    import msvcrt
else:
    import fcntl

DEFAULTS = dict(PAWTALK_PORT='18443',PAWTALK_E2EE='false',PAWTALK_E2EE_KEY_ID='',
                PAWTALK_CHAT_MAX_MB='128',PAWTALK_UPDATE_PROXY='true',
                PAWTALK_BACKUP_KEEP='5',
                PAWTALK_SERVER_AUTO_UPDATE='false',PAWTALK_MANAGER_AUTO_UPDATE='false',
                PAWTALK_LANGUAGE='ru')


def validate(values):
    # Discard obsolete selectors from existing installations and backup configs.
    values = {k:v for k,v in values.items() if k not in ('PAWTALK_SERVER_CHANNEL','PAWTALK_MANAGER_CHANNEL')}
    values = {**DEFAULTS, **values}
    if set(values) != set(DEFAULTS) | {'PAWTALK_PUBLIC_IP'}:
        raise ValueError('Unknown/missing configuration field')
    address = ipaddress.ip_address(values['PAWTALK_PUBLIC_IP'])
    if address.version != 4 or address.is_unspecified or address.is_multicast:
        raise ValueError('Expected unicast IPv4 address')
    if not re.fullmatch(r'[0-9]{1,5}', values['PAWTALK_PORT']) or not 1024 <= int(values['PAWTALK_PORT']) <= 65532:
        raise ValueError('Port must be 1024..65532')
    for key in ['PAWTALK_E2EE','PAWTALK_UPDATE_PROXY','PAWTALK_SERVER_AUTO_UPDATE','PAWTALK_MANAGER_AUTO_UPDATE']:
        if values[key] not in ('true','false'):
            raise ValueError('Invalid boolean: '+key)
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
            if not WINDOWS:
                os.fchmod(out.fileno(),mode)
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        secure(temporary)
        os.replace(temporary,file)
        sync_directory(file.parent)
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
    sync_directory(file.parent)


@contextlib.contextmanager
def lock(file):
    Path(file).parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    with open(file,'a+b') as stream:
        secure(file)
        os.chmod(file,0o600)
        try:
            if WINDOWS:
                stream.seek(0)
                if not stream.read(1):
                    stream.write(b'0')
                    stream.flush()
                stream.seek(0)
                msvcrt.locking(stream.fileno(),msvcrt.LK_NBLCK,1)
            else:
                fcntl.flock(stream,fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ValueError('Another PawTalk operation is running') from None
        locked = True
        def release_lock():
            nonlocal locked
            if not locked:
                return
            if WINDOWS:
                stream.seek(0)
                msvcrt.locking(stream.fileno(),msvcrt.LK_UNLCK,1)
            else:
                fcntl.flock(stream,fcntl.LOCK_UN)
            locked = False
        try:
            yield release_lock
        finally:
            release_lock()
