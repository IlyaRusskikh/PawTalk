"""Windows QA cleanup restricted to an explicitly owned test directory."""
import os
from pathlib import Path
import shutil
import stat
import sys
import time


def remove_owned_tree(path,expected_parent,prefix):
    path=Path(os.path.abspath(path))
    if path.is_symlink() or (hasattr(path,'is_junction') and path.is_junction()):
        raise ValueError('Refusing to clean a linked test root')
    if path.resolve().parent!=Path(expected_parent).resolve() or not path.name.startswith(prefix):
        raise ValueError('Unsafe test cleanup path')
    if not path.exists():
        return

    def retry_readonly(function,name,error):
        target=Path(os.path.abspath(name))
        if not target.is_relative_to(path):
            raise ValueError('Cleanup callback escaped test directory')
        info=os.stat(target,follow_symlinks=False)
        attributes=getattr(info,'st_file_attributes',0)
        if attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise error
        if os.name=='nt' and attributes & stat.FILE_ATTRIBUTE_READONLY:
            os.chmod(target,info.st_mode|stat.S_IWRITE)
            function(target)
        else:
            raise error

    for attempt in range(20):
        try:
            if sys.version_info >= (3,12):
                shutil.rmtree(path,onexc=retry_readonly)
            else:
                shutil.rmtree(path,onerror=lambda fn,name,error:retry_readonly(fn,name,error[1]))
            return
        except FileNotFoundError:
            if not path.exists():return
            raise
        except PermissionError:
            if attempt==19:raise
            time.sleep(0.2)
