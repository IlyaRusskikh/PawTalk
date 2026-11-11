"""Deterministic fault injection complements, rather than replaces, real Compose tests."""
import io
import json
import tempfile
import tarfile
import unittest
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'manager'))
from pawtalk_manager.config import read_config, write_config, save, validate, lock
from pawtalk_manager.controller import Controller
from pawtalk_manager import release, bundles


class PowerLoss(BaseException):
    pass


class MemoryRoom:
    def __init__(self):
        self.identity_value = 'fixed-identity'
        self.data = b'original SQLite snapshot'
        self.fail_start = False
        self.crash = False
        self.backup_error = False
        self.starts = []
        self.running = True
        self.status = 'healthy'
        self.restarts = 0

    def pull(self,state): pass
    def verify_image(self,state): pass
    def create_volume(self,state): pass
    def project_exists(self,state,config): return False
    def data_size(self,state): return 0
    def start(self,state,config):
        self.starts.append(state['image'])
        self.running = True
        if state['version'] == '0.9.1' and (self.fail_start or self.crash):
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
            for name,data in [('state.json',b'identity'),('chat.sqlite',self.data)]:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info,io.BytesIO(data))
    def import_backup(self,state,file):
        with tarfile.open(file) as archive:
            self.data = archive.extractfile('chat.sqlite').read()
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
        self.manifest = dict(version='0.9.0',digest='sha256:'+'a'*64,dataSchema=1,apiProtocol=1,_signed='synthetic receipt; verification tested separately')
        self.c.install({'PAWTALK_PUBLIC_IP':'203.0.113.10'},self.manifest,template,'0.1.0')

    def tearDown(self): self.temp.cleanup()

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

    def test_reinstall_keeps_identity_data_and_config(self):
        state,config = self.c.state(),self.c.config()
        self.assertFalse(self.c.install({'PAWTALK_PUBLIC_IP':'198.51.100.12'},None,None,None))
        self.assertEqual(self.c.state(),state)
        self.assertEqual(self.c.config(),config)

    def test_schema_and_downgrade_blocked_before_stopping(self):
        self.assertFalse(self.c.update_server({**self.manifest,'version':'0.8.0'}))
        with self.assertRaises(ValueError):
            self.c.update_server({**self.manifest,'version':'0.9.1','dataSchema':2})
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
