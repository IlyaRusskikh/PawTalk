"""Supported host checks and opt-in Docker bootstrap from its official apt repository."""
import ipaddress
import os
import platform
import shlex
import shutil
import socket
import subprocess
import urllib.request
from pathlib import Path
from .config import atomic
from .runtime import run


def supported(file='/etc/os-release',machine=None):
    values = {}
    for line in Path(file).read_text().splitlines():
        key,sep,value = line.partition('=')
        if sep:
            parsed = shlex.split(value)
            if len(parsed) == 1:
                values[key] = parsed[0]
    distro = values.get('ID'),values.get('VERSION_ID')
    if distro not in [('debian','12'),('ubuntu','24.04')]:
        raise ValueError('Supported systems: Debian 12 / Ubuntu 24.04')
    arch = {'x86_64':'amd64','aarch64':'arm64'}.get(machine or platform.machine())
    if not arch:
        raise ValueError('Supported architectures: amd64 / arm64')
    return distro[0], 'bookworm' if distro[0] == 'debian' else 'noble', arch


def bootstrap(distro,codename,arch):
    # Refuse conflicts; never automatically uninstall workloads or host packages.
    for name in ['docker.io','docker-compose','docker-compose-v2','podman-docker','containerd','runc']:
        result = subprocess.run(['dpkg-query','-W','-f=${Status}',name],capture_output=True)
        if b'install ok installed' in result.stdout:
            raise ValueError('Conflicting package '+name+'; review Docker official installation instructions')
    run(['apt-get','update'],timeout=600)
    run(['apt-get','install','-y','ca-certificates','curl','openssl'],timeout=600)
    key = Path('/etc/apt/keyrings/docker.asc')
    sources = Path('/etc/apt/sources.list.d/docker.sources')
    if key.exists() or sources.exists():
        raise ValueError('Existing Docker apt configuration; review it rather than overwriting')
    key.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
    with urllib.request.urlopen(f'https://download.docker.com/linux/{distro}/gpg',timeout=30) as response:
        public = response.read(65537)
    if len(public)>65536 or not public.startswith(b'-----BEGIN PGP PUBLIC KEY BLOCK-----'):
        raise ValueError('Invalid Docker repository key')
    atomic(key,public,0o644)
    atomic(sources,(f'Types: deb\nURIs: https://download.docker.com/linux/{distro}\nSuites: {codename}\nComponents: stable\nArchitectures: {arch}\nSigned-By: {key}\n').encode(),0o644)
    run(['apt-get','update'],timeout=600)
    run(['apt-get','install','-y','docker-ce','docker-ce-cli','containerd.io','docker-buildx-plugin','docker-compose-plugin'],timeout=600)
    run(['systemctl','enable','--now','docker'])


def check(config,bootstrap_docker=False,no_systemd=False):
    if os.geteuid() != 0:
        raise ValueError('Run with sudo/root')
    distro,codename,arch = supported()
    if not shutil.which('docker'):
        if not bootstrap_docker:
            raise ValueError('Docker missing; allow --bootstrap-docker or install it from Docker official apt repository')
        bootstrap(distro,codename,arch)
    if run(['docker','info','--format','{{.OSType}}']).strip() != b'linux':
        raise ValueError('Linux Docker Engine required')
    version = run(['docker','compose','version','--short']).decode().strip().lstrip('v')
    if int(version.split('.')[0]) < 2:
        raise ValueError('Docker Compose plugin v2 or newer required')
    run(['openssl','version'])
    if not no_systemd and not Path('/run/systemd/system').is_dir():
        raise ValueError('systemd is required; --no-systemd is for container/local verification only')
    check_ports(int(config['PAWTALK_PORT']))
    if shutil.disk_usage('/').free < 1024*1024*1024:
        raise ValueError('At least 1 GiB of free disk space is required')


def check_ports(port):
    sockets = []
    try:
        for kind,host,p in [(socket.SOCK_STREAM,'0.0.0.0',port),(socket.SOCK_STREAM,'0.0.0.0',port+1),
                            (socket.SOCK_DGRAM,'0.0.0.0',port+2),(socket.SOCK_STREAM,'127.0.0.1',port+3)]:
            connection = socket.socket(socket.AF_INET,kind)
            sockets.append(connection)
            if kind == socket.SOCK_STREAM:
                # TIME_WAIT from a stopped room is not an active listener.
                connection.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            connection.bind((host,p))
            if kind == socket.SOCK_STREAM:
                connection.listen(1)
    except OSError:
        raise ValueError('Room TCP/UDP ports are occupied; choose another port') from None
    finally:
        for connection in sockets:
            connection.close()


def public_candidates():
    candidates = []
    for url in ['https://api.ipify.org','https://checkip.amazonaws.com']:
        try:
            with urllib.request.urlopen(url,timeout=3) as response:
                candidate = response.read(65).decode().strip()
            ip = ipaddress.ip_address(candidate)
            if ip.version == 4 and ip.is_global and candidate not in candidates:
                candidates.append(candidate)
        except (OSError,ValueError):
            pass
    return candidates
