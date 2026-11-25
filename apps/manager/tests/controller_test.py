"""Deterministic fault injection complements, rather than replaces, real Compose tests."""
import io
import hashlib
import json
import tempfile
import tarfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout,redirect_stderr
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'apps/manager/linux'))
from pawtalk_manager.config import read_config, write_config, save, validate, lock
from pawtalk_manager.controller import Controller
from pawtalk_manager import release, bundles, cli


class PowerLoss(BaseException):
    pass


class MemoryRoom:
    def __init__(self):
        self.identity_value = 'fixed-identity'
        self.data = b'original SQLite snapshot'
        self.fail_start = False
        self.crash = False
        self.fault_version = '0.9.1'
        self.backup_error = False
        self.starts = []
        self.running = True
        self.status = 'healthy'
        self.restarts = 0

    def initialized(self,state,config): return True
    def pull(self,state): pass
    def verify_image(self,state): pass
    def create_volume(self,state): pass
    def project_exists(self,state,config): return False
    def data_size(self,state): return 0
    def start(self,state,config):
        self.starts.append(state['image'])
        self.running = True
        if state['version'] == self.fault_version and (self.fail_start or self.crash):
            self.data = b'changed by failed rollout'
            if self.crash:
                raise PowerLoss()
            raise RuntimeError('injected unhealthy rollout')
    def stop(self,state,config): self.running = False
    def healthy(self,state,config,expected=None):
        if expected and expected != self.identity_value:
            raise ValueError('identity changed')
        return self.identity_value
    def export(self,state,file):
        if self.backup_error:
            raise OSError('injected full disk')
        with tarfile.open(file,'w') as archive:
            for name,data in [('state.json',b'identity'),('membership-v2.sqlite',self.data)]:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info,io.BytesIO(data))
    def import_backup(self,state,file):
        with tarfile.open(file) as archive:
            self.data = archive.extractfile('membership-v2.sqlite').read()
    def container(self,state,config):
        return {'State':{'Running':self.running,'Health':{'Status':self.status}}}
    def compose(self,state,config,*args): self.restarts += 1


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.room = MemoryRoom()
        self.c = Controller(self.temp.name,self.room)
        template = Path(self.temp.name)/'source.yaml'
        template.write_text('services: {}')
        self.manifest = dict(version='0.9.0',digest='sha256:'+'a'*64,dataSchema=2,apiProtocol=2,windows={'name':'synthetic.zip','sha256':'a'*64,'size':1},_signed='synthetic receipt; verification tested separately')
        self.c.install({'PAWTALK_PUBLIC_IP':'203.0.113.10'},self.manifest,template,'0.1.0')

    def tearDown(self): self.temp.cleanup()

    def migration_command(self,state,config,*args,archive=None):
        server_id = 'a'*32
        if args == ('migration-check',):
            self.assertIsNone(archive)
            return json.dumps(dict(dataSchema=2,serverId=server_id,ownerProfileId='b'*64))
        action,digest = args
        self.assertEqual(action,'migration-prepare')
        if self.room.data == b'original SQLite snapshot':
            self.assertFalse(self.room.running)
        backup = archive.read()
        self.assertEqual(hashlib.sha256(backup).hexdigest(),digest)
        with tarfile.open(fileobj=io.BytesIO(backup)) as contents:
            source = contents.extractfile('membership-v2.sqlite').read()
        self.assertEqual(source,b'original SQLite snapshot')
        self.room.data = b'frozen SQLite snapshot'
        self.archive_digest = digest
        return json.dumps(dict(maintenance=True,dataSchema=3,serverId=server_id,ownerProfileId='b'*64,
                               backupArchiveSha256=digest,backupSha256=hashlib.sha256(source).hexdigest()))

    def migration_healthcheck(self,state,config,*args):
        self.assertTrue(self.room.running)
        self.assertEqual(self.room.data,b'frozen SQLite snapshot')
        self.assertEqual(args,('migration-healthcheck',self.archive_digest))

    def install_cutover_fixture(self):
        self.room.migration_command = self.migration_command
        self.room.command = self.migration_healthcheck
        prepared = self.c.prepare_protected_migration()
        checkpoint = prepared['checkpoint']
        self.cutover_receipt = dict(serverId=checkpoint['serverId'],archiveSha256=self.archive_digest,
                                    cutoverDigest='c'*64,deviceId='d'*64)
        self.cutover_approved = False
        self.crash_cutover = False
        self.cutover_commands = []

        def command(state,config,action,digest,archive=None):
            self.assertEqual(digest,self.archive_digest)
            self.cutover_commands.append(action)
            if action == 'migration-approve-cutover':
                self.assertEqual(archive.read(),b'{"test":"synthetic signed approval"}')
                self.cutover_approved = True
                return json.dumps(self.cutover_receipt)
            if action == 'migration-verify':
                review = {key:self.cutover_receipt[key] for key in ('serverId','archiveSha256','cutoverDigest')}
                if self.cutover_approved:
                    review['cutoverApproval'] = self.cutover_receipt
                return json.dumps(review)
            self.assertEqual(action,'migration-activate')
            self.assertTrue(self.cutover_approved)
            self.assertFalse(self.room.running)
            self.room.data = b'activated SQLite snapshot'
            if self.crash_cutover:
                raise PowerLoss()
            return json.dumps(self.cutover_receipt)

        self.room.migration_command = command
        return prepared

    def test_protected_activation_requires_owner_approval_and_preserves_backup(self):
        prepared = self.install_cutover_fixture()
        with self.assertRaisesRegex(ValueError,'no verified owner approval'):
            self.c.activate_protected_migration()
        self.assertTrue(self.room.running)
        self.assertEqual(self.c.migration_status(),prepared)
        active = self.c.activate_protected_migration(io.BytesIO(b'{"test":"synthetic signed approval"}'))
        self.assertEqual(active['phase'],'migration-active')
        self.assertEqual(active['backup'],prepared['backup'])
        self.assertEqual(self.c.state()['protectedRuntime']['cutoverDigest'],self.cutover_receipt['cutoverDigest'])
        self.assertEqual(self.c.state()['dataSchema'],2) # Signed installed image metadata.
        self.assertEqual(self.room.data,b'activated SQLite snapshot')
        self.assertTrue(self.room.running)
        self.assertTrue((self.c.backups/prepared['backup']/'data.tar').is_file())
        self.assertEqual(self.c.activate_protected_migration(),active)
        self.assertEqual(self.cutover_commands.count('migration-activate'),1)
        with self.assertRaisesRegex(ValueError,'Unsupported server data/protocol transition'):
            self.c.update_server({**self.manifest,'version':'0.9.1'})
        self.assertTrue(self.room.running)

    def activate_protected_room_at_0_14_1(self):
        save(self.c.state_file,{**self.c.state(),'version':'0.14.1'})
        self.install_cutover_fixture()
        self.c.activate_protected_migration(io.BytesIO(b'{"test":"synthetic signed approval"}'))
        return {
            **self.manifest,
            'version':'0.15.0',
            'digest':'sha256:29d57e9ea010945c4127da433a2309a5a19482f9ef37eb55e990ffa61d6fc7f9',
            'windows': {
                'name':'PawTalk.Server.0.15.0.windows-x64.zip',
                'sha256':'744c388a15dd574bb2b097f6b188a41dba1c3f36c0da7d0342400ae78c856aeb',
                'size':32731842,
            },
        }

    def test_protected_update_preserves_active_cutover_and_data(self):
        manifest = self.activate_protected_room_at_0_14_1()
        previous = self.c.state()
        previous_data = self.room.data
        for changed in ({'version':'0.15.1'}, {'digest':'sha256:'+'c'*64},
                        {'windows':{**manifest['windows'],'sha256':'c'*64}}):
            with self.subTest(changed=changed), patch.object(self.room,'pull') as pull:
                with self.assertRaisesRegex(ValueError,'Unsupported server data/protocol transition'):
                    self.c.update_server({**manifest,**changed})
                pull.assert_not_called()
        self.room.running = False
        with self.assertRaisesRegex(ValueError,'Start the protected room'):
            self.c.update_server(manifest)
        self.room.running = True

        self.assertTrue(self.c.update_server(manifest))
        current = self.c.state()
        self.assertEqual(current['version'],'0.15.0')
        self.assertEqual(current['image'],release.IMAGE+'@'+manifest['digest'])
        for key in ('protectedRuntime','identity','volume','dataSchema'):
            self.assertEqual(current[key],previous[key])
        self.assertEqual(self.room.data,previous_data)
        self.assertTrue(self.room.running)

    def test_protected_update_failure_restores_previous_image_and_active_data(self):
        manifest = self.activate_protected_room_at_0_14_1()
        previous = self.c.state()
        previous_data = self.room.data
        self.room.fault_version = manifest['version']
        self.room.fail_start = True

        with self.assertRaisesRegex(RuntimeError,'previous image/data restored and verified'):
            self.c.update_server(manifest)
        restored = self.c.state()
        self.assertNotEqual(restored['volume'],previous['volume'])
        self.assertEqual(restored,{**previous,'volume':restored['volume']})
        self.assertEqual(self.room.starts[-2:],[release.IMAGE+'@'+manifest['digest'],previous['image']])
        self.assertEqual(self.room.data,previous_data)
        self.assertTrue(self.room.running)
        self.assertFalse(self.c.journal.exists())

    def test_protected_activation_resumes_without_restoring_pre_cutover_data(self):
        prepared = self.install_cutover_fixture()
        self.cutover_approved = True
        self.crash_cutover = True
        with self.assertRaises(PowerLoss):
            self.c.activate_protected_migration()
        self.assertEqual(self.room.data,b'activated SQLite snapshot')
        self.assertEqual(self.c.migration_status()['phase'],'migration-activating')
        with self.assertRaisesRegex(RuntimeError,'activation is in progress'):
            self.c.recover()
        with self.assertRaisesRegex(RuntimeError,'activation is in progress'):
            self.c.rollback_protected_migration()
        self.crash_cutover = False
        resumed = Controller(self.temp.name,self.room)
        self.assertEqual(resumed.activate_protected_migration()['phase'],'migration-active')
        self.assertEqual(self.room.data,b'activated SQLite snapshot')
        self.assertTrue((resumed.backups/prepared['backup']/'data.tar').is_file())
        self.assertEqual(self.cutover_commands,['migration-verify','migration-activate','migration-activate'])

    def test_protected_activation_rechecks_tls_and_keeps_the_pre_cutover_archive(self):
        prepared = self.install_cutover_fixture()
        self.cutover_approved = True
        original = self.c.state()
        _, archive = self.c.snapshot(prepared['backup'])
        pre_cutover_data = archive.read_bytes()
        expected_cutover = self.cutover_receipt['cutoverDigest']

        def wrong_cutover(state, config, expected):
            self.assertTrue(self.room.running)
            self.assertEqual(state['protectedRuntime']['cutoverDigest'], expected_cutover)
            self.assertEqual(expected, original['identity'])
            raise RuntimeError('Protected TLS healthcheck did not confirm the requested cutover')

        with patch.object(self.room, 'healthy', side_effect=wrong_cutover):
            with self.assertRaisesRegex(RuntimeError, 'did not confirm the requested cutover'):
                self.c.activate_protected_migration()
        self.assertEqual(self.c.migration_status()['phase'],'migration-activating')
        self.assertEqual(self.c.state(),original)
        self.assertEqual(archive.read_bytes(),pre_cutover_data)
        self.assertEqual(self.room.data,b'activated SQLite snapshot')

        resumed = Controller(self.temp.name,self.room)
        self.room.running = False
        with patch.object(self.room, 'healthy', wraps=self.room.healthy) as check:
            self.assertEqual(resumed.activate_protected_migration()['phase'],'migration-active')
            state, _, identity = check.call_args.args
            self.assertEqual(state['protectedRuntime']['cutoverDigest'],expected_cutover)
            self.assertEqual(identity,original['identity'])
        self.assertTrue(self.room.running)
        self.assertEqual(self.cutover_commands,['migration-verify','migration-activate'])
        active_state = resumed.state()
        with patch.object(self.room, 'stop', wraps=self.room.stop) as stop, patch.object(self.room, 'pull') as pull:
            with self.assertRaisesRegex(ValueError,'Cannot restore an API 2 backup'):
                resumed.restore(prepared['backup'])
            stop.assert_not_called()
            pull.assert_not_called()
        self.assertEqual(resumed.state(),active_state)
        self.assertEqual(self.room.data,b'activated SQLite snapshot')
        self.assertEqual(archive.read_bytes(),pre_cutover_data)

    def test_protected_migration_pins_backup_until_explicit_rollback(self):
        self.room.migration_command = self.migration_command
        self.room.command = self.migration_healthcheck
        installed = self.c.state()
        prepared = self.c.prepare_protected_migration()
        self.assertEqual(prepared['phase'],'migration-prepared')
        self.assertTrue(self.room.running)
        self.assertEqual(self.room.data,b'frozen SQLite snapshot')
        self.assertEqual(self.c.state(),installed)
        self.assertEqual(self.c.prepare_protected_migration(),prepared)
        self.room.running = False
        self.assertEqual(self.c.prepare_protected_migration(),prepared)
        self.assertTrue(self.room.running)
        self.assertEqual(len(list(self.c.backups.glob('backup-*'))),1)
        with self.assertRaisesRegex(ValueError,'required for pending recovery'):
            self.c.delete_backup(prepared['backup'])
        with self.assertRaisesRegex(RuntimeError,'Protected migration is prepared'):
            self.c.watchdog()
        self.assertTrue(self.room.running)
        self.c.rollback_protected_migration()
        self.assertEqual(self.c.migration_status(),dict(phase='inactive'))
        self.assertEqual(self.room.data,b'original SQLite snapshot')
        self.assertTrue(self.room.running)
        self.assertNotEqual(self.c.state()['volume'],installed['volume'])
        self.assertTrue((self.c.backups/prepared['backup']/'data.tar').is_file())

    def test_protected_migration_readiness_failure_rolls_back_before_ready(self):
        self.room.migration_command = self.migration_command
        original = self.c.state()
        self.room.running = False

        def blocked_probe(state,config,*args):
            self.migration_healthcheck(state,config,*args)
            self.assertEqual(self.c.migration_status()['phase'],'applying')
            raise RuntimeError('wrong migration checkpoint')

        self.room.command = blocked_probe
        later = iter((0,0,100))
        with patch('pawtalk_manager.controller.time.monotonic',side_effect=lambda:next(later)), patch('pawtalk_manager.controller.time.sleep'):
            with self.assertRaisesRegex(RuntimeError,'expected migration checkpoint'):
                self.c.prepare_protected_migration()
        self.assertEqual(self.c.migration_status(),dict(phase='inactive'))
        self.assertEqual(self.room.data,b'original SQLite snapshot')
        self.assertFalse(self.room.running)
        self.assertNotEqual(self.c.state()['volume'],original['volume'])
        self.assertEqual(len(list(self.c.backups.glob('backup-*'))),1)

    def test_interrupted_protected_migration_recovers_from_verified_archive(self):
        def crash_after_commit(state,config,*args,archive=None):
            result = self.migration_command(state,config,*args,archive=archive)
            if archive is not None:
                raise PowerLoss()
            return result

        self.room.migration_command = crash_after_commit
        with self.assertRaises(PowerLoss):
            self.c.prepare_protected_migration()
        self.assertEqual(self.c.migration_status()['phase'],'applying')
        self.assertEqual(self.room.data,b'frozen SQLite snapshot')
        self.assertFalse(self.room.running)
        restarted = Controller(self.temp.name,self.room)
        self.assertTrue(restarted.recover())
        self.assertEqual(restarted.migration_status(),dict(phase='inactive'))
        self.assertEqual(self.room.data,b'original SQLite snapshot')
        self.assertTrue(self.room.running)

    def test_protected_migration_backup_failure_resumes_source(self):
        self.room.migration_command = self.migration_command
        self.room.backup_error = True
        with self.assertRaisesRegex(OSError,'full disk'):
            self.c.prepare_protected_migration()
        self.assertEqual(self.c.migration_status(),dict(phase='inactive'))
        self.assertEqual(self.room.data,b'original SQLite snapshot')
        self.assertTrue(self.room.running)

    def test_protected_migration_rejects_owner_blocker_before_stopping_source(self):
        output = json.dumps(dict(dataSchema=2,serverId='a'*32,ownerBlocker='NO_ELIGIBLE_ADMINISTRATOR'))
        with patch.object(self.room,'migration_command',return_value=output,create=True):
            with self.assertRaisesRegex(ValueError,'NO_ELIGIBLE_ADMINISTRATOR'):
                self.c.prepare_protected_migration()
        self.assertTrue(self.room.running)
        self.assertEqual(self.c.migration_status(),dict(phase='inactive'))
        self.assertFalse(list(self.c.backups.glob('backup-*')))

    def test_update_rollback_restores_data_and_keeps_old_volume(self):
        original = self.c.state()
        self.room.fail_start = True
        with self.assertRaisesRegex(RuntimeError,'restored and verified'):
            self.c.update_server({**self.manifest,'version':'0.9.1','digest':'sha256:'+'b'*64})
        self.assertEqual(self.room.data,b'original SQLite snapshot')
        self.assertEqual(self.c.state()['version'],'0.9.0')
        self.assertNotEqual(self.c.state()['volume'],original['volume'])
        self.assertFalse(self.c.journal.exists())

    def test_power_loss_recovers_journal_in_a_new_controller(self):
        self.room.crash = True
        with self.assertRaises(PowerLoss):
            self.c.update_server({**self.manifest,'version':'0.9.1','digest':'sha256:'+'b'*64})
        self.assertTrue(self.c.journal.exists())
        self.room.crash = False
        self.assertTrue(Controller(self.temp.name,self.room).recover())
        self.assertEqual(self.room.data,b'original SQLite snapshot')
        self.assertEqual(self.c.state()['identity'],'fixed-identity')

    def test_failed_backup_resumes_without_rollout(self):
        self.room.backup_error = True
        with self.assertRaises(OSError):
            self.c.create_backup()
        self.assertTrue(self.room.running)
        self.assertFalse(self.c.journal.exists())
        self.assertFalse(list(self.c.backups.glob('backup-*')))

    def test_recovery_discards_only_an_interrupted_private_backup(self):
        self.c.transaction(self.c.state(),self.c.config(),'backup')
        partial = self.c.backups/('.backup-'+'a'*12)
        partial.mkdir(parents=True)
        (partial/'data.tar').write_bytes(b'incomplete archive')
        foreign = self.c.backups/'operator-notes'
        foreign.mkdir()
        self.room.running = False
        self.assertTrue(self.c.recover())
        self.assertTrue(self.room.running)
        self.assertFalse(partial.exists())
        self.assertTrue(foreign.exists())

    def test_config_never_downgrades_and_update_settings_do_not_restart(self):
        before = len(self.room.starts)
        self.assertFalse(self.c.configure({'PAWTALK_SERVER_AUTO_UPDATE':'true'}))
        self.assertEqual(len(self.room.starts),before)
        self.assertTrue(self.c.configure({'PAWTALK_CHAT_MAX_MB':'64'}))
        self.assertEqual(self.room.starts[-1],release.IMAGE+'@'+self.manifest['digest'])
        with self.assertRaises(ValueError):
            self.c.configure({'PAWTALK_PUBLIC_IP':'203.0.113.11'})
        with self.assertRaises(ValueError):
            self.c.configure({'PAWTALK_IMAGE':'old-image'})

    def test_configuring_stopped_room_preserves_stopped_state(self):
        self.room.running = False
        before = len(self.room.starts)
        self.assertTrue(self.c.configure({'PAWTALK_CHAT_MAX_MB':'64'}))
        self.assertFalse(self.room.running)
        self.assertEqual(len(self.room.starts),before)
        self.assertEqual(self.c.config()['PAWTALK_CHAT_MAX_MB'],'64')

    def test_failed_stopped_configuration_rolls_back_without_starting(self):
        self.room.running = False
        self.room.backup_error = True
        with self.assertRaises(OSError):
            self.c.configure({'PAWTALK_CHAT_MAX_MB':'64'})
        self.assertFalse(self.room.running)
        self.assertEqual(self.c.config()['PAWTALK_CHAT_MAX_MB'],'128')

    def test_reinstall_keeps_identity_data_and_config(self):
        state,config = self.c.state(),self.c.config()
        self.assertFalse(self.c.install({'PAWTALK_PUBLIC_IP':'198.51.100.12'},None,None,None))
        self.assertEqual(self.c.state(),state)

        self.assertEqual(self.c.config(),config)

    def test_settings_language_change_does_not_restart_room(self):
        old=self.c.config()
        values={key:old[key] for key in cli.SETTINGS_FIELDS}
        values['PAWTALK_LANGUAGE']='en' if old['PAWTALK_LANGUAGE']=='ru' else 'ru'
        starts=len(self.room.starts)
        self.assertTrue(cli.apply_settings(self.c,dict(expected=old,values=values)))
        self.assertEqual(len(self.room.starts),starts)
        self.assertEqual(self.c.config(),{**old,'PAWTALK_LANGUAGE':values['PAWTALK_LANGUAGE']})

    def test_settings_reject_stale_window_and_preserve_advanced_fields(self):
        old=self.c.config()
        values={key:old[key] for key in cli.SETTINGS_FIELDS}
        request=dict(expected=old,values=values)
        self.assertFalse(cli.apply_settings(self.c,request))
        values['PAWTALK_SERVER_AUTO_UPDATE']='true'
        self.assertTrue(cli.apply_settings(self.c,request))
        self.assertEqual(self.c.config()['PAWTALK_UPDATE_PROXY'],old['PAWTALK_UPDATE_PROXY'])
        with self.assertRaisesRegex(ValueError,'elsewhere'):
            cli.apply_settings(self.c,request)
        with self.assertRaises(ValueError):
            cli.apply_settings(self.c,dict(expected=self.c.config(),values={**values,'PAWTALK_IMAGE':'untrusted'}))

    def test_settings_pipe_protocol_load_apply_and_conflict(self):
        old=self.c.config()
        values={key:old[key] for key in cli.SETTINGS_FIELDS}
        values['PAWTALK_MANAGER_AUTO_UPDATE']='true'
        request=json.dumps(dict(expected=old,values=values)).encode()
        with patch.object(cli,'WINDOWS',True),patch.object(cli,'admin',return_value=True),patch.object(cli,'protect'),patch.object(cli,'Controller',return_value=self.c):
            output=io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(cli.main(['--root',str(self.c.root),'settings']),0)
            self.assertEqual(json.loads(output.getvalue())['values'],old)
            for expected in [0,1]:
                output,error=io.StringIO(),io.StringIO()
                with patch.object(cli.sys,'stdin',io.TextIOWrapper(io.BytesIO(request))),redirect_stdout(output),redirect_stderr(error):
                    self.assertEqual(cli.main(['--root',str(self.c.root),'settings','--apply']),expected)
                if expected==0:
                    self.assertTrue(json.loads(output.getvalue())['changed'])
                else:
                    self.assertIn('elsewhere',error.getvalue())

    def test_native_network_change_updates_identity_and_failure_restores_pair(self):
        old=self.c.config()
        original=self.c.state()
        # Only the native runtime offers this operation; generic Compose still
        # rejects a network rebind before taking a backup or stopping anything.
        self.room.reconfigure_network=lambda state,previous,new:self.room.identity_value
        self.assertTrue(self.c.configure({'PAWTALK_PORT':'19443'}))
        self.assertEqual(self.c.config()['PAWTALK_PORT'],'19443')
        self.assertEqual(self.c.state()['identity'],original['identity'])
        def fail(state,previous,new):
            self.room.data=b'partially modified state'
            raise RuntimeError('injected rebind failure')
        self.room.reconfigure_network=fail
        with self.assertRaisesRegex(RuntimeError,'rebind failure'):
            self.c.configure({'PAWTALK_PUBLIC_IP':'198.51.100.22'})
        self.assertEqual(self.c.config()['PAWTALK_PUBLIC_IP'],old['PAWTALK_PUBLIC_IP'])
        self.assertEqual(self.c.config()['PAWTALK_PORT'],'19443')
        self.assertEqual(self.room.data,b'original SQLite snapshot')
        self.assertTrue(self.room.running)

    def test_schema_and_downgrade_blocked_before_stopping(self):
        self.assertFalse(self.c.update_server({**self.manifest,'version':'0.8.0'}))
        with self.assertRaises(ValueError):
            self.c.update_server({**self.manifest,'version':'0.9.1','dataSchema':3})
        self.assertTrue(self.room.running)
        self.assertFalse(self.c.journal.exists())

    def test_watchdog_is_bounded_and_locked(self):
        self.room.status = 'unhealthy'
        for now in [100,200,1000,3000,10000]:
            self.c.watchdog(now)
        self.assertEqual(self.room.restarts,3)
        with lock(self.c.directory/'lock'):
            with self.assertRaises(ValueError):
                with lock(self.c.directory/'lock'): pass

    def test_bad_backup_and_paths_leave_room_untouched(self):
        name = self.c.create_backup()
        (self.c.backups/name/'data.tar').write_bytes(b'corrupt')
        for bad in [name,'../elsewhere','backup-'+('a'*12)+'/..']:
            with self.assertRaises((ValueError,OSError)):
                self.c.restore(bad)
        self.assertTrue(self.room.running)

    def test_restore_cannot_replace_another_existing_project(self):
        name = self.c.create_backup()
        file = self.c.backups/name/'metadata.json'
        metadata = json.loads(file.read_text())
        metadata['state']['project'] = 'pawtalk-'+'f'*12
        save(file,metadata)
        self.room.project_exists = lambda state,config: True
        with self.assertRaisesRegex(ValueError,'another existing Docker project'):
            self.c.restore(name)
        self.assertTrue(self.room.running)

    def test_config_is_data_not_shell_and_e2ee_requires_key_id(self):
        file = Path(self.temp.name)/'bad.env'
        for content in ['PAWTALK_PUBLIC_IP=$(touch secret)','PAWTALK_PUBLIC_IP=203.0.113.10\nPAWTALK_PUBLIC_IP=1.1.1.1',
                        'PAWTALK_PUBLIC_IP=203.0.113.10\nPAWTALK_E2EE=true']:
            file.write_text(content)
            with self.assertRaises(ValueError): read_config(file)

    def test_obsolete_channels_are_removed_without_changing_other_settings(self):
        file = Path(self.temp.name)/'old.env'
        for channel in ['stable','preview']:
            file.write_text('PAWTALK_PUBLIC_IP=203.0.113.10\nPAWTALK_SERVER_CHANNEL='+channel+
                            '\nPAWTALK_MANAGER_CHANNEL='+channel+'\nPAWTALK_SERVER_AUTO_UPDATE=true\n')
            config = read_config(file)
            self.assertNotIn('PAWTALK_SERVER_CHANNEL',config)
            self.assertNotIn('PAWTALK_MANAGER_CHANNEL',config)
            self.assertEqual(config['PAWTALK_SERVER_AUTO_UPDATE'],'true')
            write_config(file,config)
            self.assertNotIn('_CHANNEL',file.read_text())
            self.assertEqual(read_config(file),config)


if __name__ == '__main__': unittest.main()
