"""Map immutable installed bundle entries to their repository source files."""
from pathlib import Path
import shutil

REPOSITORY = Path(__file__).resolve().parents[3]


def bundle_source(name):
    if name == 'manager/VERSION':
        return REPOSITORY/'apps/manager/VERSION'
    if name.startswith('manager/'):
        relative = name[len('manager/'):]
        source = REPOSITORY/'apps/manager/linux'
        if relative == 'compose.server.yaml' or relative.endswith(('.service', '.timer')):
            source = source/'deploy'
        return source/relative
    return REPOSITORY/name


def copy_manager(destination):
    from pawtalk_manager.bundles import FILES
    for name in FILES:
        target = Path(destination)/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(bundle_source(name), target)
