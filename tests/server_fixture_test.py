import hashlib
import importlib.util
import io
import http.client
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('server_fixture', Path(__file__).resolve().parents[1] / 'scripts/prepare-server-fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class ServerFixtureTests(unittest.TestCase):
    def test_ci_metadata_auth_is_bounded_and_never_used_for_assets_or_redirects(self):
        url='https://api.github.com/repos/IlyaRusskikh/PawTalk/releases'
        def response(data,length=None):
            result=io.BytesIO(data);result.headers={} if length is None else {'Content-Length':str(length)}
            return result
        with patch.dict(fixture.os.environ,{'GH_TOKEN':'synthetic-ci-token'}),patch.object(fixture.urllib.request,'build_opener') as opener:
            opener.return_value.open.return_value=response(b'ok',2)
            self.assertEqual(fixture.fetch_ci(url,2,api=True),b'ok')
            request=opener.return_value.open.call_args.args[0]
            self.assertEqual(request.get_header('Authorization'),'Bearer synthetic-ci-token')
            with self.assertRaises(ValueError):fixture.fetch_ci('https://api.github.com.example/releases',api=True)
            with self.assertRaises(ValueError):
                fixture.NoAuthenticatedRedirect().redirect_request(request,None,302,'redirect',{},'https://release-assets.githubusercontent.com/example')
            with patch.object(fixture.release,'fetch',return_value=b'asset') as public:
                self.assertEqual(fixture.fetch_ci('https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.9.0/example',api=False),b'asset')
                self.assertEqual(public.call_count,1)
            opener.return_value.open.return_value=response(b'oversized')
            with self.assertRaises(ValueError):fixture.fetch_once_ci(url,2,True)
            opener.return_value.open.return_value=response(b'x',2)
            with self.assertRaises(http.client.IncompleteRead):fixture.fetch_once_ci(url,2,True)

    def test_transient_network_failures_retry_but_missing_assets_and_invalid_data_do_not(self):
        with patch.object(fixture.time, 'sleep'), patch.object(fixture.release, 'fetch', side_effect=[TimeoutError(), b'ok']) as fetch:
            self.assertEqual(fixture.fetch_ci('https://example.test'), b'ok')
            self.assertEqual(fetch.call_count, 2)
        for error in [urllib.error.HTTPError('https://example.test',404,'missing',{},None), ValueError('invalid metadata')]:
            with patch.object(fixture.release,'fetch',side_effect=error) as fetch:
                with self.assertRaises(type(error)):fixture.fetch_ci('https://example.test')
                self.assertEqual(fetch.call_count, 1)
        with patch.object(fixture.time, 'sleep'), patch.object(fixture.release,'fetch',side_effect=TimeoutError()) as fetch:
            with self.assertRaises(TimeoutError):fixture.fetch_ci('https://example.test')
            self.assertEqual(fetch.call_count, 3)

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
