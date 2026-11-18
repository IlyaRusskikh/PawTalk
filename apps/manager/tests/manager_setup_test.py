"""First-run faults: installing Manager must never fetch or execute Server."""
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import controller_test as fixtures
from windows_smoke_support import assert_manager_only_layout
from pawtalk_manager import cli, native, release, preflight
from pawtalk_manager.controller import Controller


class SetupRoom(fixtures.MemoryRoom):
    def __init__(self):
        super().__init__()
        self.projects=[]
        self.fail=False
        self.crash=False
    def start(self,state,config):
        self.projects.append(state['project'])
        self.running=True
        if self.crash: raise fixtures.PowerLoss()
        if self.fail: raise RuntimeError('synthetic failed startup')
    def prepare(self,state,config): pass


class ManagerSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.room=SetupRoom()
        self.c=Controller(Path(self.temp.name)/'root',self.room)
        self.source=Path(__file__).resolve().parents[3]/'apps/manager/linux'
        self.version=patch.object(native,'installed_desktop_version',return_value='0.4.0')
        self.version.start()
        self.host=patch.object(native,'host',return_value=SimpleNamespace(returncode=0))
        self.calls=self.host.start()
        self.preflight=patch.object(preflight,'check')
        self.preflight.start()
    def tearDown(self):
        self.preflight.stop();self.host.stop();self.version.stop();self.temp.cleanup()
    def install(self): native.install_manager_only(self.c,self.source,'en')
    def package(self):
        file=Path(self.temp.name)/'PawTalk.Server.0.10.1.windows-x64.zip'
        with zipfile.ZipFile(file,'w') as archive:
            for name in native.SERVER_FILES: archive.writestr(name,b'synthetic archive; never executed')
        return native.inspect_server_package(self.c,str(file))
    def request(self,package=None):
        old=native.manager_values(self.c)
        fields=cli.SETTINGS_FIELDS
        return dict(source='local' if package else 'published',id=package['id'] if package else None,expected=old,
                    values={k:old[k] for k in fields})
    def test_manager_only_has_no_network_server_config_or_service(self):
        # Windows protectRoot creates this empty directory before Manager setup.
        (self.c.root/'opt/pawtalk-server').mkdir(parents=True)
        with patch.object(release,'discover') as discover,patch.object(native,'fetch') as fetch,patch.object(self.room,'start') as start:
            self.install()
            assert_manager_only_layout(self.c.root)
            self.calls.assert_not_called();discover.assert_not_called();fetch.assert_not_called();start.assert_not_called()
        with patch.object(cli,'WINDOWS',True),patch.object(cli,'publish_desktop_status'):
            snapshot=cli.desktop_execute(self.c,'snapshot',{})
            diagnostics=cli.desktop_execute(self.c,'diagnostics',{})
        self.assertTrue(snapshot['setupRequired']);self.assertFalse(diagnostics['installed'])
        self.assertEqual(snapshot['values']['PAWTALK_LANGUAGE'],'en')
        self.assertEqual(snapshot['values']['PAWTALK_SERVER_AUTO_UPDATE'],'false')
        self.assertEqual(snapshot['values']['PAWTALK_MANAGER_AUTO_UPDATE'],'false')
    def test_reinstall_preserves_trust_config_identity_and_stopped_state(self):
        self.install();package=self.package();native.setup_server(self.c,self.request(package),self.source)
        old=self.c.state();config=self.c.config();trust=(self.c.etc/'trust.json').read_bytes()
        self.room.running=False;self.calls.reset_mock()
        with patch.dict(native.os.environ,PAWTALK_INSTALL_KEEP_STOPPED='1'),patch.object(self.room,'start') as start:
            self.install();start.assert_not_called()
        self.assertEqual(self.c.state(),old);self.assertEqual(self.c.config(),config)
        self.assertEqual((self.c.etc/'trust.json').read_bytes(),trust)
        self.assertEqual([c.args[0] for c in self.calls.call_args_list],['install-server','install-manager','start-manager'])
    def test_local_inspection_does_not_start_core_then_explicit_setup_works(self):
        self.install();package=self.package();self.assertEqual(self.room.projects,[])
        request=self.request(package);request['values']['PAWTALK_PUBLIC_IP']='203.0.113.10'
        request['values']['PAWTALK_SERVER_AUTO_UPDATE']='true'
        with patch.object(release,'discover') as discover,patch.object(native,'fetch') as fetch:
            native.setup_server(self.c,request,self.source)
            discover.assert_not_called();fetch.assert_not_called()
        self.assertEqual(self.c.config()['PAWTALK_PUBLIC_IP'],'203.0.113.10')
        self.assertEqual(self.c.config()['PAWTALK_SERVER_AUTO_UPDATE'],'false')
        self.assertEqual(self.c.state()['localPackage'],package['id'])
        self.assertFalse((self.c.directory/'setup.json').exists())
        with self.assertRaisesRegex(ValueError,'already configured'): native.setup_server(self.c,request,self.source)
    def test_failed_start_keeps_data_journal_and_retry_reuses_same_project(self):
        self.install();package=self.package();request=self.request(package);old=request['expected']
        self.room.fail=True
        with self.assertRaises(RuntimeError): native.setup_server(self.c,request,self.source)
        self.assertFalse(self.c.state_file.exists());self.assertFalse(self.room.running)
        self.assertEqual(native.manager_values(self.c),old)
        project=json.loads((self.c.directory/'setup.json').read_text())['project']
        self.room.fail=False;native.setup_server(self.c,request,self.source)
        self.assertEqual(self.room.projects,[project,project])
        self.assertEqual(self.c.state()['identity'],'fixed-identity')
    def test_process_crash_is_not_reported_as_configured_and_can_retry(self):
        self.install();package=self.package();request=self.request(package);self.room.crash=True
        with self.assertRaises(fixtures.PowerLoss): native.setup_server(self.c,request,self.source)
        with patch.object(cli,'WINDOWS',True),patch.object(cli,'publish_desktop_status'):
            self.assertTrue(cli.desktop_execute(self.c,'snapshot',{})['setupRequired'])
        self.room.crash=False;native.setup_server(self.c,request,self.source)
        self.assertEqual(len(set(self.room.projects)),1)
    def test_modified_quarantined_zip_never_starts(self):
        self.install();package=self.package()
        (self.c.directory/'packages'/(package['id']+'.zip')).write_bytes(b'modified')
        with self.assertRaisesRegex(ValueError,'changed'):native.setup_server(self.c,self.request(package),self.source)
        self.assertEqual(self.room.projects,[]);self.assertFalse(self.c.state_file.exists())
    def test_published_discovery_only_on_explicit_request_no_match_preserves_setup(self):
        self.install()
        with patch.object(release,'discover',return_value=None) as discover:
            with self.assertRaisesRegex(ValueError,'No compatible published'):native.setup_server(self.c,self.request(),self.source)
            discover.assert_called_once()
        self.assertFalse(self.c.state_file.exists());self.assertEqual(self.room.projects,[])
    def test_legacy_published_core_never_installs(self):
        self.install()
        with patch.object(release,'discover',return_value=dict(apiProtocol=1,dataSchema=1)):
            with self.assertRaisesRegex(ValueError,'Unsupported Server'):native.setup_server(self.c,self.request(),self.source)
        self.assertEqual(self.room.projects,[]);self.assertFalse(self.c.state_file.exists())
    def test_stale_config_request_never_discovers_or_starts(self):
        self.install();request=self.request();request['expected']['PAWTALK_PORT']='19000'
        with patch.object(release,'discover') as discover:
            with self.assertRaisesRegex(ValueError,'changed elsewhere'):native.setup_server(self.c,request,self.source)
            discover.assert_not_called()
        self.assertEqual(self.room.projects,[])
