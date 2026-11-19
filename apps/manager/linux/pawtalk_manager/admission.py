"""Host-only first administrator admission; no saved invitations or E2EE keys."""
import ipaddress
import json
import re
from urllib.parse import urlsplit, parse_qs


def inspect_status(command):
    try:
        raw = command('status')
    except RuntimeError:
        return None
    if len(raw) > 4096:
        raise ValueError('Invalid Server status')
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {'apiProtocolVersion', 'dataSchema', 'serverId', 'initialized'}
            or type(value['apiProtocolVersion']) is not int or value['apiProtocolVersion'] != 2
            or type(value['dataSchema']) is not int or value['dataSchema'] != 2
            or type(value['initialized']) is not bool
            or not re.fullmatch(r'[a-f0-9]{32}', value['serverId'])):
        raise ValueError('Unsupported Server admission status')
    return value


def status(command):
    value = inspect_status(command)
    return None if value is None else value['initialized']


def initial_invitation(command):
    initialized = status(command)
    if initialized is True:
        return None
    if initialized is None:
        raise RuntimeError('Server status unavailable; start a compatible API 2 server first')
    raw = command('initial-admin')
    if len(raw) > 14000:
        raise ValueError('Invalid administrator invitation')
    address = raw.decode('utf-8').strip()
    url = urlsplit(address)
    if (url.scheme != 'pawtalk' or url.username or url.password or url.query
            or not url.port or not 1024 <= url.port <= 65532 or not re.fullmatch(r'/[a-f0-9]{64}', url.path)):
        raise ValueError('Invalid administrator invitation')
    ipaddress.ip_address(url.hostname)
    values = parse_qs(url.fragment, keep_blank_values=True, strict_parsing=True)
    if (set(values) != {'v', 'server', 'invite', 'token', 'setup'} or any(len(value) != 1 for value in values.values())
            or values['v'] != ['2'] or values['setup'] != ['1']
            or not re.fullmatch(r'[a-f0-9]{32}', values['server'][0])
            or not re.fullmatch(r'[a-f0-9]{32}', values['invite'][0])
            or not re.fullmatch(r'[A-Za-z0-9_-]{43}', values['token'][0])):
        raise ValueError('Invalid administrator invitation')
    return {'url': address}
