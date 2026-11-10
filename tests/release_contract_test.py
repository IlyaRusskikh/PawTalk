import base64
import json
import subprocess
import tempfile
import time
import urllib.parse
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
from pawtalk_agent import release


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.keys = {'server': {}, 'deploy': {}}
        for component in self.keys:
            key = self.directory / component
            subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(key)], check=True, capture_output=True)
            public = subprocess.check_output(['openssl','pkey','-in',str(key),'-pubout']).decode()
            self.keys[component]['test'] = public

    def tearDown(self):
        self.temp.cleanup()

    def signed(self, component='server', **changes):
        now = int(time.time())
        value = dict(schema=1,component=component,repository=release.REPO,version='0.9.0',channel='preview',
                     publishedAt=now,expiresAt=now+3600,apiProtocol=1,dataSchema=1,image=release.IMAGE,digest='sha256:'+'a'*64)
        if component == 'deploy':
            value.update(bundle='PawTalk.Deploy.0.9.0.tar.gz',size=42,sha256='a'*64,launcherProtocol=1,configSchema=1)
        value.update(changes)
        data = json.dumps(value).encode()
        (self.directory/'payload').write_bytes(data)
        signature = subprocess.check_output(['openssl','pkeyutl','-sign','-rawin','-inkey',str(self.directory/component),'-in',str(self.directory/'payload')])
        return json.dumps(dict(keyId='test',payload=base64.b64encode(data).decode(),signature=base64.b64encode(signature).decode())).encode()

    def test_component_trust_and_manifest_guards(self):
        for component in self.keys:
            raw = self.signed(component)
            self.assertEqual(release.verify(raw,component,self.keys)['component'],component)
            with self.assertRaises(ValueError):
                release.verify(raw, 'server' if component == 'deploy' else 'deploy', self.keys)
        for changes in [dict(expiresAt=0),dict(dataSchema=2),dict(apiProtocol=2),dict(schema=True),dict(apiProtocol=True),dict(image='evil/image'),dict(digest=None),dict(repository='other/repo'),dict(channel='stable',version='1.0.0-beta.1')]:
            with self.assertRaises(ValueError):
                release.verify(self.signed(**changes),'server',self.keys)
        raw = json.loads(self.signed())
        raw['payload'] = base64.b64encode(b'{}').decode()
        with self.assertRaises(ValueError):
            release.verify(json.dumps(raw).encode(),'server',self.keys)

    def test_routing_semver_channels(self):
        entries = [dict(tag_name=tag,prerelease=preview) for tag,preview in [
            ('v99.0.0',False),('client-v99.0.0',False),('deploy-v99.0.0',False),
            ('server-v0.9.0',False),('server-v0.10.0-beta.10',True),('server-v0.10.0-beta.2',True),
            ('server-v01.2.3',False),('server-v1.0.0-01',True)]]
        self.assertEqual(release.select(entries,'server','preview')[0][2],'0.10.0-beta.10')
        self.assertEqual(release.select(entries,'server','stable')[0][2],'0.9.0')
        self.assertFalse(release.select(entries[:3],'server','preview'))
        with self.assertRaises(ValueError):
            release.loads('{"a":1,"a":2}')

    def test_historical_restore_requires_signed_server_reference(self):
        raw = self.signed()
        meta = {'state':dict(version='0.9.0',image=release.IMAGE+'@sha256:'+'a'*64,dataSchema=1,serverManifest=raw.decode())}
        self.assertEqual(release.verify_snapshot(meta,self.keys)['version'],'0.9.0')
        meta['state']['image'] = release.IMAGE+'@sha256:'+'b'*64
        with self.assertRaises(ValueError): release.verify_snapshot(meta,self.keys)
        old = self.signed(publishedAt=1,expiresAt=3601)
        with self.assertRaises(ValueError): release.verify(old,'server',self.keys)
        self.assertEqual(release.verify_historical(old,'server',self.keys)['version'],'0.9.0')

    def test_pagination_and_bound_assets(self):
        raw = self.signed()
        asset_url = f'https://github.com/{release.REPO}/releases/download/server-v0.9.0/server-manifest.json'
        selected = dict(tag_name='server-v0.9.0',prerelease=True,assets=[dict(name='server-manifest.json',state='uploaded',browser_download_url=asset_url)])
        calls = []
        def get(url, limit, **kwargs):
            calls.append(url)
            page = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).get('page')
            if page == ['1']:
                return json.dumps([dict(tag_name='client-v9.0.0')]*100).encode()
            if page == ['2']:
                return json.dumps([selected]).encode()
            self.assertEqual(url,asset_url)
            return raw
        self.assertEqual(release.discover('server','preview',self.keys,get)['version'],'0.9.0')
        self.assertEqual(len(calls),3)
        selected['assets'][0]['browser_download_url'] = asset_url.replace('IlyaRusskikh/PawTalk','ilyarusskikh/pawtalk')
        def case_get(url, limit, **kwargs):
            return raw if '/download/' in url else get(url,limit,**kwargs)
        self.assertEqual(release.discover('server','preview',self.keys,case_get)['version'],'0.9.0')
        selected['assets'][0]['browser_download_url'] = 'https://evil.example/manifest'
        with self.assertRaises(ValueError):
            release.discover('server','preview',self.keys,get)


if __name__ == '__main__':
    unittest.main()
