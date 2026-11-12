"""Desktop policy fault tests; signed installer verification is real."""
import base64
import hashlib
import json
import os
import unittest
import xml.etree.ElementTree as ET
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path
import controller_test as controller_fixtures
import release_contract_test as crypto_fixtures
from pawtalk_manager import cli, native, bundles
from pawtalk_manager.config import save


class ManagerDesktopTests(unittest.TestCase):
    def setUp(self):
        self.fixture=controller_fixtures.ControllerTests();self.fixture.setUp();self.c=self.fixture.c
        self.crypto=crypto_fixtures.ReleaseTests();self.crypto.setUp()
        save(self.c.etc/'trust.json',self.crypto.keys)

    def tearDown(self):
        self.crypto.tearDown();self.fixture.tearDown()

    def manifest(self,data):
        raw=self.crypto.signed('manager',windowsInstaller=dict(name='PawTalk.Server.Manager.Setup.0.9.0.exe',size=len(data),sha256=hashlib.sha256(data).hexdigest()))
        return dict(version='0.9.0',_signed=raw)

    def test_disabled_auto_install_still_discovers_and_reports_available(self):
        with patch.object(cli.release,'discover',return_value=dict(version='0.9.0')) as discover,patch.object(native,'installed_desktop_version',return_value='0.3.0'),patch.object(cli,'publish_desktop_status'),patch.object(bundles,'activate') as activate,patch.object(cli,'WINDOWS',True):
            result=cli.desktop_updates(self.c,self.crypto.keys,install=False)
            self.assertEqual(result['status'],'available')
            discover.assert_called_once_with('manager',self.crypto.keys)
            activate.assert_not_called()
            cli.desktop_updates(self.c,self.crypto.keys,install=True)
            activate.assert_called_once()

    def test_verified_installer_is_queued_once_and_never_executed_in_the_service_job(self):
        data=b'synthetic signed installer payload, never executed'
        with patch.object(native,'installed_desktop_version',return_value='0.3.0'),patch.object(native,'fetch',return_value=data),patch.object(native,'schedule_manager_installer') as schedule:
            self.assertTrue(native.queue_manager_installer(self.c,self.manifest(data)))
            self.assertTrue(native.queue_manager_installer(self.c,self.manifest(data)))
            schedule.assert_called_once()
            self.assertEqual(schedule.call_args.args[1].read_bytes(),data)

    def test_installer_size_and_hash_mismatch_never_reaches_scheduler(self):
        with patch.object(native,'installed_desktop_version',return_value='0.3.0'),patch.object(native,'fetch',return_value=b'corrupt'),patch.object(native,'schedule_manager_installer') as schedule:
            with self.assertRaises(ValueError):native.queue_manager_installer(self.c,self.manifest(b'expected'))
            schedule.assert_not_called()

    def test_installer_task_is_system_on_demand_without_a_second_clock_trigger(self):
        installer=self.c.directory/'updates'/'synthetic installer.exe'
        installer.parent.mkdir(parents=True,exist_ok=True)
        calls=[]
        def scheduler(args,**kwargs):
            calls.append(args)
            if '/XML' in args:
                task=ET.parse(args[args.index('/XML')+1])
                ns={'t':'http://schemas.microsoft.com/windows/2004/02/mit/task'}
                self.assertEqual(len(task.find('t:Triggers',ns)),0)
                self.assertEqual(task.find('t:Principals/t:Principal/t:UserId',ns).text,'S-1-5-18')
                self.assertEqual(task.find('t:Actions/t:Exec/t:Command',ns).text,str(installer))
                self.assertIn('/CONFIG=',task.find('t:Actions/t:Exec/t:Arguments',ns).text)
            return SimpleNamespace(returncode=0)
        with patch.object(native.subprocess,'run',side_effect=scheduler):
            native.schedule_manager_installer(self.c,installer)
        self.assertEqual([call[1] for call in calls],['/Create','/Run'])
        self.assertFalse((installer.parent/'install-task.xml').exists())

    def test_modified_signature_never_downloads_or_schedules(self):
        value=self.manifest(b'expected');signed=json.loads(value['_signed']);payload=json.loads(base64.b64decode(signed['payload']));payload['windowsInstaller']['sha256']='b'*64;signed['payload']=base64.b64encode(json.dumps(payload).encode()).decode();value['_signed']=json.dumps(signed)
        with patch.object(native,'fetch') as fetch,patch.object(native,'schedule_manager_installer') as schedule:
            with self.assertRaises(ValueError):native.queue_manager_installer(self.c,value)
            fetch.assert_not_called();schedule.assert_not_called()

    def test_equal_or_older_desktop_release_never_installs(self):
        with patch.object(native,'installed_desktop_version',return_value='0.9.0'),patch.object(native,'fetch') as fetch,patch.object(native,'schedule_manager_installer') as schedule:
            self.assertFalse(native.queue_manager_installer(self.c,self.manifest(b'expected')))
            fetch.assert_not_called();schedule.assert_not_called()

    def test_update_network_failure_preserves_retryable_status(self):
        with patch.object(cli.release,'discover',side_effect=RuntimeError('synthetic network failure')),patch.object(cli,'publish_desktop_status'):
            with self.assertRaises(RuntimeError):cli.desktop_updates(self.c,self.crypto.keys)
        self.assertEqual(json.loads((self.c.directory/'manager-update.json').read_text())['status'],'check-failed')

    def test_password_and_invitation_are_not_in_overview_snapshot(self):
        with patch.object(cli,'publish_desktop_status'):
            snapshot=cli.desktop_execute(self.c,'snapshot',{})
        self.assertEqual(set(snapshot),{'values','serverVersion','managerVersion','update','backups'})
        self.assertNotIn('password',json.dumps(snapshot).lower())

    def test_backup_of_a_stopped_room_does_not_start_it(self):
        self.fixture.room.running=False
        self.c.create_backup()
        self.assertFalse(self.fixture.room.running)

    def test_windows_server_update_keeps_manually_stopped_room_off(self):
        self.fixture.room.running=False
        from pawtalk_manager import controller
        with patch.object(controller,'WINDOWS',True):
            manifest={**self.fixture.manifest,'version':'0.9.1'}
            self.assertTrue(self.c.update_server(manifest))
        self.assertFalse(self.fixture.room.running)
        self.assertEqual(self.c.state()['version'],'0.9.1')
