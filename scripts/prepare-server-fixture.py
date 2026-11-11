"""Use a published, trusted Server for independent Client/Manager CI; never publish."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'manager'))
from pawtalk_manager import release


def prepare(keys, destination=None, get=release.fetch):
    manifest = release.discover('server', keys, get=get)
    if manifest is None:
        raise ValueError('A published signed Server is required for component CI')
    if destination is not None:
        artifact = manifest.get('windows')
        if artifact is None:
            raise ValueError('The published Server has no Windows artifact')
        url = f'https://github.com/{release.REPO}/releases/download/server-v{manifest["version"]}/{artifact["name"]}'
        data = get(url, artifact['size'])
        if len(data) != artifact['size'] or hashlib.sha256(data).hexdigest() != artifact['sha256']:
            raise ValueError('Published Server fixture hash/size mismatch')
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    return dict(image=manifest['image'] + '@' + manifest['digest'], version=manifest['version'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--windows-zip', type=Path)
    parser.add_argument('--github-output', action='store_true')
    args = parser.parse_args()
    result = prepare(json.loads((ROOT / 'manager/trust.json').read_text()), args.windows_zip)
    if args.github_output:
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
            for key, value in result.items():
                output.write(f'{key}={value}\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
