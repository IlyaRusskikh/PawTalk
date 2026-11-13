"""Desktop policy fault tests; signed installer verification is real."""
import base64
import hashlib
import json
import os
import io
import unittest
import xml.etree.ElementTree as ET
import zipfile
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path
from contextlib import redirect_stdout
import controller_test as controller_fixtures
import release_contract_test as crypto_fixtures
from pawtalk_manager import cli, native, bundles
from pawtalk_manager.config import save,lock


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
        with patch.object(cli,'discover_desktop',return_value=dict(version='0.9.0')) as discover,patch.object(native,'installed_desktop_version',return_value='0.3.0'),patch.object(cli,'publish_desktop_status'),patch.object(bundles,'activate') as activate,patch.object(cli,'WINDOWS',True):
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
        with patch.object(cli,'discover_desktop',side_effect=RuntimeError('synthetic network failure')),patch.object(cli,'publish_desktop_status'):
            with self.assertRaises(RuntimeError):cli.desktop_updates(self.c,self.crypto.keys)
        self.assertEqual(json.loads((self.c.directory/'manager-update.json').read_text())['status'],'check-failed')

    def test_password_and_invitation_are_not_in_overview_snapshot(self):
        with patch.object(cli,'publish_desktop_status'):
            snapshot=cli.desktop_execute(self.c,'snapshot',{})
        self.assertEqual(set(snapshot),{'values','serverVersion','serverLocal','managerVersion','update','serverUpdate','backups'})
        self.assertNotIn('password',json.dumps(snapshot).lower())

    def test_network_discovery_does_not_hold_room_lock_and_check_never_installs(self):
        def discover(component,keys):
            with lock(self.c.directory/'operation.lock'):
                pass # Another process/action can acquire the same lock during I/O.
            return dict(version='0.9.1')
        with patch.object(cli,'discover_desktop',side_effect=discover),patch.object(cli,'publish_desktop_status'),patch.object(bundles,'activate') as activate:
            result=cli.desktop_check(self.c,'server')
        self.assertEqual(result['status'],'available')
        activate.assert_not_called()
        self.assertEqual(self.c.state()['version'],'0.9.0')

    def test_read_only_desktop_actions_work_while_mutation_lock_is_held(self):
        for action in ('snapshot','logs','diagnostics'):
            output=io.StringIO()
            with self.subTest(action=action),lock(self.c.directory/'operation.lock'),patch.object(cli,'WINDOWS',True),patch.object(cli,'admin',return_value=True),patch.object(cli,'protect'),patch.object(cli,'Controller',return_value=self.c),patch.object(cli,'publish_desktop_status'),patch.object(cli,'doctor',return_value=dict(running=True)),patch.object(cli.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(b'{}'))),redirect_stdout(output):
                self.assertEqual(cli.desktop_main(self.c.root,action),0)
            self.assertIn('value',json.loads(output.getvalue()))

    def test_backup_returns_refreshed_list_without_a_second_request(self):
        with patch.object(cli,'publish_desktop_status'):
            result=cli.desktop_execute(self.c,'backup-create',{})
        self.assertIn(result['name'],[item['name'] for item in result['backups']])

    def test_delete_backup_returns_updated_list_and_keeps_room_running(self):
        name=self.c.create_backup()
        before=self.c.state()
        with patch.object(cli,'publish_desktop_status'):
            result=cli.desktop_execute(self.c,'backup-delete',dict(name=name))
        self.assertNotIn(name,[item['name'] for item in result['backups']])
        self.assertFalse((self.c.backups/name).exists())
        self.assertEqual(self.c.state(),before)
        self.assertTrue(self.fixture.room.running)

    def test_delete_backup_refuses_paths_missing_names_and_recovery_source(self):
        name=self.c.create_backup()
        for invalid in (None,'../'+name,'',name+'/child','backup-'+'f'*12):
            with self.subTest(name=invalid),self.assertRaises(ValueError):self.c.delete_backup(invalid)
        save(self.c.journal,dict(backup=name))
        with self.assertRaisesRegex(ValueError,'pending recovery'):self.c.delete_backup(name)
        self.c.journal.unlink()
        self.assertTrue((self.c.backups/name).is_dir())

    def test_delete_backup_rejects_nested_links_without_touching_target(self):
        name=self.c.create_backup()
        outside=self.c.root/'outside'
        outside.mkdir();(outside/'keep.txt').write_text('keep')
        linked=self.c.backups/name/'linked'
        if os.name=='nt':
            import subprocess
            subprocess.run(['cmd','/c','mklink','/J',str(linked),str(outside)],check=True,capture_output=True)
        else:linked.symlink_to(outside,target_is_directory=True)
        try:
            with self.assertRaisesRegex(ValueError,'unsafe link'):self.c.delete_backup(name)
            self.assertEqual((outside/'keep.txt').read_text(),'keep')
        finally:
            if os.name=='nt':linked.rmdir()
            else:linked.unlink()

    def test_installer_has_no_access_data_page_or_invitation_command(self):
        script=(Path(__file__).resolve().parents[1]/'manager/windows/installer.nsi').read_text(encoding='utf-8')
        self.assertNotIn('InvitationCreate',script)
        self.assertNotIn('invitation --url',script)

    def local_archive(self,version='0.9.0'):
        file=self.c.root/f'PawTalk.Server.{version}.windows-x64.zip'
        with zipfile.ZipFile(file,'w') as archive:
            for name in native.SERVER_FILES: archive.writestr(name,b'synthetic fixture, never executed')
        return file

    def test_local_same_version_install_is_offline_and_does_not_replace_release_directory(self):
        file=self.local_archive()
        with patch.object(native,'fetch',side_effect=AssertionError('offline')),patch.object(cli.release,'fetch',side_effect=AssertionError('offline')):
            info=native.inspect_server_package(self.c,file)
            self.assertFalse(info['verified'])
            # The inspected bytes remain usable after the original is removed.
            file.unlink()
            from pawtalk_manager import controller
            with patch.object(controller,'WINDOWS',True):
                self.assertTrue(native.install_server_package(self.c,info['id']))
        self.assertEqual(self.c.state()['localPackage'],info['id'])
        self.assertEqual(self.c.config()['PAWTALK_SERVER_AUTO_UPDATE'],'false')
        runtime=native.NativeRuntime(self.c.root)
        self.assertNotEqual(runtime.binary(self.c.state()),runtime.binary({**self.c.state(),'localPackage':None}))
        self.assertTrue(list(self.c.backups.glob('backup-*')))

    def test_local_package_checksum_and_archive_traversal_fail_before_install(self):
        file=self.local_archive()
        with zipfile.ZipFile(file,'a') as archive: archive.writestr('../outside.exe',b'bad')
        with self.assertRaises(ValueError):native.inspect_server_package(self.c,file)
        self.assertNotIn('localPackage',self.c.state())

    def test_local_failed_update_restores_previous_state_and_data(self):
        info=native.inspect_server_package(self.c,self.local_archive('0.9.1'))
        self.fixture.room.fail_start=True
        from pawtalk_manager import controller
        with patch.object(controller,'WINDOWS',True):
            with self.assertRaisesRegex(RuntimeError,'restored'):
                native.install_server_package(self.c,info['id'])
        self.assertEqual(self.c.state()['version'],'0.9.0')
        self.assertNotIn('localPackage',self.c.state())
        self.assertEqual(self.fixture.room.data,b'original SQLite snapshot')

    def test_signed_local_package_cannot_fall_back_to_unsigned(self):
        file=self.local_archive()
        file.with_name('server-manifest.json').write_text('{"signature":"invalid"}')
        with self.assertRaises((ValueError,KeyError)):native.inspect_server_package(self.c,file)

    def test_signed_local_archive_verifies_offline_against_existing_trust_roots(self):
        file=self.local_archive()
        artifact=dict(name=file.name,size=file.stat().st_size,sha256=hashlib.sha256(file.read_bytes()).hexdigest())
        file.with_name('server-manifest.json').write_bytes(self.crypto.signed('server',windows=artifact))
        with patch.object(cli.release,'fetch',side_effect=AssertionError('offline')):
            info=native.inspect_server_package(self.c,file)
        self.assertTrue(info['verified'])
        saved=json.loads((self.c.directory/'packages'/(info['id']+'.json')).read_text())
        self.assertNotIn('_local',saved)

    def test_staged_package_tampering_is_rejected(self):
        info=native.inspect_server_package(self.c,self.local_archive())
        (self.c.directory/'packages'/(info['id']+'.zip')).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'changed'):native.install_server_package(self.c,info['id'])

    def test_portable_package_binds_metadata_to_inner_archive(self):
        raw=self.local_archive().read_bytes()
        package=self.c.root/'portable.zip'
        meta=dict(format='pawtalk-server-package-v1',version='0.9.0',apiProtocol=1,dataSchema=1,sha256=hashlib.sha256(raw).hexdigest())
        with zipfile.ZipFile(package,'w') as archive:
            archive.writestr('package.json',json.dumps(meta))
            archive.writestr('server.zip',raw)
        info=native.inspect_server_package(self.c,package)
        self.assertEqual(info['sha256'],meta['sha256'])
        meta['sha256']='f'*64
        with zipfile.ZipFile(package,'w') as archive:
            archive.writestr('package.json',json.dumps(meta))
            archive.writestr('server.zip',raw)
        with self.assertRaisesRegex(ValueError,'checksum'):native.inspect_server_package(self.c,package)

    def test_public_status_uses_host_instead_of_private_file_acl(self):
        with patch.object(cli,'WINDOWS',True),patch.object(cli,'host',return_value=SimpleNamespace(returncode=0)) as host:
            snapshot=cli.desktop_execute(self.c,'snapshot',{})
        args=host.call_args
        self.assertEqual(args.args,('publish-desktop-status',self.c.root))
        status=json.loads(args.kwargs['input'])
        self.assertEqual(set(status),{'update','language','autoManager','serverVersion','managerVersion'})
        self.assertEqual(status['serverVersion'],snapshot['serverVersion'])
        self.assertNotIn('values',status)

    def test_public_status_host_failure_is_reported(self):
        with patch.object(cli,'WINDOWS',True),patch.object(cli,'host',return_value=SimpleNamespace(returncode=1)):
            with self.assertRaisesRegex(ValueError,'Unable to publish'):
                cli.publish_desktop_status(self.c)

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
