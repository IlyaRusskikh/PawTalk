import io
import json
import os
import subprocess
import socket
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deploy'))
from pawtalk_agent import bundles, cli, preflight, release
from pawtalk_agent.config import save
import controller_test


class BundleTests(unittest.TestCase):
    def test_bilingual_wizard_keeps_secret_keys_off_the_server(self):
        import contextlib
        for lang in ['ru','en']:
            answers = ['203.0.113.10','18443','true','a'*64,'128','true','false','stable','preview']
            with patch.object(preflight,'public_candidates',return_value=['203.0.113.10']),patch('builtins.input',side_effect=answers),contextlib.redirect_stdout(io.StringIO()):
                values = cli.wizard(lang)
            self.assertEqual(values['PAWTALK_LANGUAGE'],lang)
            self.assertEqual(values['PAWTALK_E2EE_KEY_ID'],'a'*64)
            self.assertNotIn('PAWTALK_E2EE_KEY',values)
            self.assertEqual(values['PAWTALK_SERVER_CHANNEL'],'stable')
            self.assertEqual(values['PAWTALK_DEPLOY_AUTO_UPDATE'],'false')
    def test_port_preflight_distinguishes_tcp_time_wait_from_active_listeners(self):
        server = socket.socket()
        server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        server.bind(('127.0.0.1',0))
        port = server.getsockname()[1]
        server.listen(1)
        client = socket.create_connection(('127.0.0.1',port))
        accepted,_ = server.accept()
        accepted.close() # Server actively closes: leave its port in TIME_WAIT.
        client.close()
        server.close()
        preflight.check_ports(port)
        for kind,blocked in [(socket.SOCK_STREAM,port+1),(socket.SOCK_DGRAM,port+2)]:
            listener = socket.socket(socket.AF_INET,kind)
            try:
                listener.bind(('0.0.0.0',blocked))
                if kind == socket.SOCK_STREAM: listener.listen(1)
                with self.assertRaises(ValueError): preflight.check_ports(port)
            finally:
                listener.close()
    def test_archive_traversal_links_and_missing_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            for name,kind in [('../escape',tarfile.REGTYPE),('deploy/pawtalkctl',tarfile.SYMTYPE),('deploy/VERSION',tarfile.REGTYPE)]:
                archive = p/'bad.tar.gz'
                with tarfile.open(archive,'w:gz') as output:
                    item = tarfile.TarInfo(name)
                    item.type = kind
                    item.size = 1 if kind == tarfile.REGTYPE else 0
                    item.linkname = '/etc/passwd'
                    output.addfile(item,io.BytesIO(b'x') if item.size else None)
                with self.assertRaises(ValueError): bundles.unpack(archive,p/'output')

    def test_unsupported_os_and_architecture_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory)/'os-release'
            file.write_text('ID=debian\nVERSION_ID="12"\n')
            self.assertEqual(preflight.supported(file,'x86_64'),('debian','bookworm','amd64'))
            self.assertEqual(preflight.supported(file,'aarch64'),('debian','bookworm','arm64'))
            with self.assertRaises(ValueError): preflight.supported(file,'mips')
            file.write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
            self.assertEqual(preflight.supported(file,'aarch64')[1],'noble')
            file.write_text('ID=ubuntu\nVERSION_ID="22.04"\n')
            with self.assertRaises(ValueError): preflight.supported(file,'x86_64')

    def test_launcher_restores_previous_and_cancels_operation(self):
        source = Path(__file__).resolve().parents[1]/'deploy'
        with tempfile.TemporaryDirectory() as directory:
            agent = Path(directory)/'opt/pawtalk-agent'
            versions = agent/'versions'
            good,bad = versions/'0.1.0',versions/'0.1.1'
            import shutil
            shutil.copytree(source,good/'deploy',ignore=shutil.ignore_patterns('__pycache__'))
            (bad/'deploy').mkdir(parents=True)
            (bad/'deploy/pawtalkctl').write_text('raise RuntimeError("broken")')
            (agent/'current').symlink_to('versions/0.1.1')
            (agent/'previous').symlink_to('versions/0.1.0')
            process = subprocess.run([sys.executable,str(source/'launcher'),'--root',directory,'periodic'],capture_output=True)
            self.assertEqual(process.returncode,1)
            self.assertEqual(os.readlink(agent/'current'),'versions/0.1.0')

    @unittest.skipUnless(os.geteuid() == 0,'CLI administrative path requires root')
    def test_failed_metadata_check_records_no_payload_or_secret(self):
        import contextlib
        fixture = controller_test.ControllerTests()
        fixture.setUp()
        try:
            save(fixture.c.etc/'trust.json',{'server':{},'deploy':{}})
            manifest = Path(fixture.temp.name)/'bad-manifest.json'
            manifest.write_text('{"keyId":"unknown","payload":"synthetic-sensitive-input","signature":""}')
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cli.main(['--root',fixture.temp.name,'update','check','--manifest',str(manifest)]),1)
            raw = (fixture.c.directory/'last-error.json').read_text()
            self.assertNotIn('synthetic-sensitive-input',raw)
            self.assertEqual(json.loads(raw)['category'],'validation')
        finally:
            fixture.tearDown()

    @unittest.skipUnless(os.geteuid() == 0,'CLI administrative path requires root')
    def test_disabled_periodic_performs_no_fetch(self):
        fixture = controller_test.ControllerTests()
        fixture.setUp()
        try:
            save(fixture.c.etc/'trust.json',{'server':{},'deploy':{}})
            with patch.object(release,'discover',side_effect=AssertionError('Unexpected network request')):
                self.assertEqual(cli.main(['--root',fixture.temp.name,'periodic']),0)
        finally:
            fixture.tearDown()


if __name__ == '__main__': unittest.main()
