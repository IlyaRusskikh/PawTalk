"""Small OS boundary; transaction and release policy remain shared."""
import os
import subprocess
from pathlib import Path

WINDOWS = os.name == 'nt'


def admin():
    if WINDOWS:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    return os.geteuid() == 0


def sync_directory(path):
    if WINDOWS:
        return # File fsync + atomic replacement; directory fsync is not supported by Windows.
    fd = os.open(path,os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def host(*args,input=None):
    executable = os.environ.get('PAWTALK_MANAGER_HOST')
    if not executable or not Path(executable).is_absolute():
        raise ValueError('Run through the installed pawtalkctl.exe')
    return subprocess.run([executable,*map(str,args)],input=input,capture_output=True,timeout=180)


def secure(path):
    if WINDOWS and admin() and host('secure-tree',Path(os.path.abspath(path))).returncode:
        raise ValueError('Unable to secure managed files')


def protect(path):
    if WINDOWS:
        path = Path(path)
        path.mkdir(parents=True,exist_ok=True)
        # Replace ACLs/owner rather than retaining an explicit grant from a
        # pre-created directory. The host rejects links and unowned nonempty roots.
        if host('protect',Path(os.path.abspath(path))).returncode:
            raise ValueError('Unable to protect Manager directory; use a dedicated empty root')


def default_root():
    return str(Path(os.environ.get('ProgramData',r'C:\ProgramData'))/'PawTalk') if WINDOWS else '/'
