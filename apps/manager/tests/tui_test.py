import contextlib
import io
import json
import os
import select
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'linux'))
from pawtalk_manager import cli


class TerminalMenuTests(unittest.TestCase):
    def test_restore_confirmation_shows_the_rollback_detection_limit(self):
        for lang in ('ru', 'en'):
            with self.subTest(lang=lang):
                prompts = []
                backup = 'backup-0123456789ab'

                def execute(*command):
                    self.assertEqual(command, ('backup', 'list', '--json'))
                    return 0, json.dumps([{'name': backup, 'created': 1000000000}])

                ui = SimpleNamespace(choose=lambda heading, choices: 0,
                                     approve=lambda heading, message: prompts.append(message))
                cli.tui_extra('tui_restore', lang, execute, ui)
                self.assertEqual(len(prompts), 1)
                self.assertIn(backup, prompts[0])
                self.assertIn(cli.text('restore_freshness', lang), prompts[0])

    def test_update_applies_the_exact_manifest_presented_for_confirmation(self):
        original = '{"signed":"candidate-a"}'
        executed = []

        def execute(*command):
            executed.append(command)
            return 0,json.dumps(dict(available=True,version='1.2.3',manifest=original,digest='sha256:example'))

        def run(heading,command):
            self.assertEqual(command[:3],('update','now','--manifest'))
            self.assertEqual(Path(command[3]).read_text(),original)
            return 0

        ui = SimpleNamespace(approve=lambda heading,message:'1.2.3' in message,run=run)
        cli.tui_install_update('en',execute,ui,'Server update','update','/tmp/source.json')
        self.assertEqual(executed,[('update','check','--details','--manifest','/tmp/source.json')])

    def test_first_setup_wizard_accepts_independent_update_preferences(self):
        answers = ['203.0.113.10','','','yes','no']
        with patch('builtins.input',side_effect=answers), patch.object(cli.preflight,'public_candidates',return_value=[]), \
             contextlib.redirect_stdout(io.StringIO()):
            values = cli.wizard('en',independent_updates=True)
        self.assertEqual(values['PAWTALK_SERVER_AUTO_UPDATE'],'true')
        self.assertEqual(values['PAWTALK_MANAGER_AUTO_UPDATE'],'false')

    @unittest.skipUnless(sys.platform == 'linux','Requires a Linux PTY')
    def test_fullscreen_arrows_and_mouse_in_xterm(self):
        import curses
        import fcntl
        import pty
        import struct
        import termios

        try:
            curses.setupterm('xterm-256color')
        except curses.error:
            self.skipTest('xterm-256color terminfo unavailable')

        script = '''
from pawtalk_manager.cli import fullscreen_tui
def execute(*command):
    if command == ('settings',):
        return 0, '{"values":{"PAWTALK_PUBLIC_IP":"203.0.113.10","PAWTALK_PORT":"18443"}}'
    if command == ('backup','list','--json'):
        return 0, '[{"name":"backup-111111111111","created":2000000000},{"name":"backup-222222222222","created":1000000000}]'
    if command[0] == 'backup':
        assert command == ('backup','restore','backup-222222222222','--yes'), command
        return 0, 'RESTORE_ACTION_RESULT'
    return 0, {'status':'{"installed":false}', 'doctor':'KEYBOARD_ACTION_RESULT',
               'logs':'MOUSE_ACTION_RESULT'}[command[0]]
raise SystemExit(fullscreen_tui('en',execute))
'''
        master,slave = pty.openpty()
        self.addCleanup(os.close,master)
        env = {**os.environ,'TERM':'xterm-256color','PYTHONPATH':str(Path(__file__).resolve().parents[1]/'linux')}
        try:
            fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0))
            process = subprocess.Popen([sys.executable,'-B','-c',script],stdin=slave,stdout=slave,stderr=slave,env=env)
        finally:
            os.close(slave)

        def wait_for(marker):
            output = bytearray()
            deadline = time.monotonic()+5
            while marker not in output and time.monotonic()<deadline:
                if select.select([master],[],[],0.1)[0]:
                    output.extend(os.read(master,65536))
            self.assertIn(marker,output)
            return output

        try:
            wait_for(b'Mouse click')
            os.write(master,b'\x1bOA\x1bOA\r')
            wait_for(b'Recent logs')
            os.write(master,b'\r')
            wait_for(b'KEYBOARD_ACTION_RESULT')
            os.write(master,b'\r')
            wait_for(b'Mouse click')
            os.write(master,b'\x1b[<0;5;6M')
            wait_for(b'MOUSE_ACTION_RESULT')
            os.write(master,b'\x1b[<0;5;6m\r\x1b')
            wait_for(b'PawTalk Manager')
            os.write(master,b'\x1bOA\r')
            wait_for(b'Delete backup')
            os.write(master,b'\x1bOB\r')
            wait_for(b'backup-222222222222')
            os.write(master,b'\x1bOB\r')
            wait_for(b'Later changes')
            os.write(master,b'\r')
            wait_for(b'Mouse click')
            os.write(master,b'\r')
            wait_for(b'backup-222222222222')
            os.write(master,b'\x1bOB\r')
            wait_for(b'Later changes')
            os.write(master,b'\x1bOB\r')
            wait_for(b'RESTORE_ACTION_RESULT')
            os.write(master,b'\r\x1b')
            wait_for(b'PawTalk Manager')
            os.write(master,b'\x1bOA'*3+b'\r')
            wait_for(b'Edit IP and port')
            os.write(master,b'\x1bOB\r')
            wait_for(b'Confirm public IPv4 [203.0.113.10]: ')
            os.write(master,b'203.0.113.10\r')
            port_prompt = wait_for(b'Base port [18443]: ')
            self.assertIn(b'\r\nBase port [18443]: ',port_prompt)
            os.write(master,b'\r')
            wait_for(b'Edit IP and port')
            os.write(master,b'\x1b')
            wait_for(b'PawTalk Manager')
            os.write(master,b'\x1b')
            self.assertEqual(process.wait(timeout=5),0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

    def test_menu_confirms_interruptions_and_renders_safe_output(self):
        commands = []

        def execute(*command):
            commands.append(command)
            if command == ('status',):
                return 0,json.dumps(dict(installed=True,serverVersion='1.2.3',managerVersion='4.5.6',
                                         running=True,health='Healthy'))
            if command == ('logs',):
                return 0,'log\x1b[31m\r\nnext line\x9b0m'
            if command == ('update','check','--details'):
                return 1,'Update check failed'
            return 0,'Done'

        output = io.StringIO()
        choices = ['unknown','1','3','','3','yes','','0','5','1','no','1','yes','','0',
                   '6','2','','0','4','1','','0','0']
        with patch('builtins.input',side_effect=choices), patch.object(sys.stdin,'isatty',return_value=True), contextlib.redirect_stdout(output):
            self.assertEqual(cli.tui('en',execute),0)

        self.assertEqual([command for command in commands if command != ('status',)],
                         [('stop','--yes'),('backup','create'),('logs',),('update','check','--details')])
        rendered = output.getvalue()
        self.assertIn('Server 1.2.3 · Manager 4.5.6 · Healthy',rendered)
        self.assertIn('Choose a number from the menu.',rendered)
        self.assertIn('Update check failed',rendered)
        self.assertEqual(rendered.count('Cancelled.'),2)
        self.assertNotIn('\x1b',rendered)
        self.assertNotIn('\x9b',rendered)

    def test_requires_interactive_terminal_and_admin(self):
        with tempfile.TemporaryDirectory() as root, patch.object(cli,'WINDOWS',False):
            for admin,message in [(True,'Use an interactive terminal'),(False,'Run with sudo/root')]:
                with self.subTest(admin=admin), patch.object(cli,'admin',return_value=admin), \
                     patch.object(sys.stdin,'isatty',return_value=False), contextlib.redirect_stderr(io.StringIO()) as error:
                    self.assertEqual(cli.main(['--root',root,'--lang','en','tui']),1)
                    self.assertIn(message,error.getvalue())
                    self.assertFalse((Path(root)/'var/lib/pawtalk-manager/operation.lock').exists())


if __name__ == '__main__':
    unittest.main()
