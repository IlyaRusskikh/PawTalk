import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('server_fixture', Path(__file__).resolve().parents[1] / 'scripts/prepare-server-fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class ServerFixtureTests(unittest.TestCase):
    def manifest(self, data):
        return dict(version='0.9.7', image=fixture.release.IMAGE, digest='sha256:'+'a'*64,
                    windows=dict(name='PawTalk.Server.0.9.7.windows-x64.zip', size=len(data),
                                 sha256=hashlib.sha256(data).hexdigest()))

    def test_uses_discovered_signed_version_and_digest_without_building_source(self):
        data=b'synthetic fixture bytes'
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/'server.zip'
            keys={'server':{'test':'synthetic public root'}}
            def get(url, limit):
                self.assertEqual(url, 'https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.9.7/PawTalk.Server.0.9.7.windows-x64.zip')
                self.assertEqual(limit, len(data))
                return data
            with patch.object(fixture.release, 'discover', return_value=self.manifest(data)) as discover:
                result=fixture.prepare(keys,target,get=get)
                discover.assert_called_once_with('server',keys,get=get)
            self.assertEqual(target.read_bytes(), data)
            self.assertEqual(result, dict(version='0.9.7',image=fixture.release.IMAGE+'@sha256:'+'a'*64))

    def test_rejects_corrupt_or_short_download_without_replacing_existing_fixture(self):
        data=b'synthetic fixture bytes'
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/'server.zip';target.write_bytes(b'existing')
            with patch.object(fixture.release, 'discover', return_value=self.manifest(data)):
                for bad in [b'x'*len(data), data[:-1], data+b'x']:
                    with self.assertRaises(ValueError):fixture.prepare({},target,get=lambda *args:bad)
                    self.assertEqual(target.read_bytes(), b'existing')

    def test_linux_image_mode_never_downloads_zip_and_missing_release_fails(self):
        with patch.object(fixture.release, 'discover', return_value=self.manifest(b'x')):
            result=fixture.prepare({},get=lambda *args:self.fail('Linux image mode downloaded a ZIP'))
            self.assertEqual(result['version'],'0.9.7')
        with patch.object(fixture.release, 'discover', return_value=None):
            with self.assertRaises(ValueError):fixture.prepare({})
