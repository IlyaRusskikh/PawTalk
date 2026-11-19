"""Extract only a bounded, flat allowlist from an already digest-verified artifact."""
import os
from pathlib import Path
import shutil
import stat
import sys
import zipfile


def extract(archive, destination, expected, max_bytes):
    destination = Path(destination)
    expected = set(expected)
    if not expected or any(not name or name in ('.', '..') or '/' in name or '\\' in name or ':' in name for name in expected):
        raise ValueError('Unsafe expected artifact names')
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if len(entries) != len(expected) or {entry.filename for entry in entries} != expected:
            raise ValueError('Unexpected, duplicate or missing archive entries')
        total = 0
        for entry in entries:
            mode = entry.external_attr >> 16
            if entry.is_dir() or stat.S_IFMT(mode) not in (0, stat.S_IFREG) or entry.flag_bits & 1:
                raise ValueError('Linked, special or encrypted archive entry')
            if entry.file_size <= 0:
                raise ValueError('Empty artifact entry')
            total += entry.file_size
            if total > max_bytes:
                raise ValueError('Artifact exceeds extraction limit')
        destination.mkdir(parents=True, exist_ok=False)
        for entry in entries:
            # Flat exact names, fresh directory and exclusive opens: no overwrite or traversal.
            with source.open(entry) as reader, (destination / entry.filename).open('xb') as writer:
                shutil.copyfileobj(reader, writer, length=1024 * 1024)
        if set(os.listdir(destination)) != expected:
            raise ValueError('Unexpected extracted files')


if __name__ == '__main__':
    extract(sys.argv[1], sys.argv[2], sys.argv[4:], int(sys.argv[3]))
