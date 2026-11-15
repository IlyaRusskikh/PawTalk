"""Exercise actual Python input through a Linux PTY, including terminal paste bytes."""
import errno
import json
import os
from pathlib import Path
import pty
import re
import select
import subprocess
import sys
import time
import unittest


class WizardTTYTests(unittest.TestCase):
    def wizard(self,lang,answers):
        master,slave = pty.openpty()
        env = {**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1]/'manager'),
               'PYTHONDONTWRITEBYTECODE':'1'}
        script = ('import json; from pawtalk_manager import cli; '
                  'cli.preflight.public_candidates=lambda: []; '
                  f'value=cli.wizard({lang!r}); print("RESULT:"+json.dumps(value))')
        child = subprocess.Popen([sys.executable,'-c',script],stdin=slave,stdout=slave,stderr=slave,env=env)
        os.close(slave)
        output = bytearray()
        try:
            os.write(master,('\n'.join(answers)+'\n').encode())
            deadline = time.monotonic()+15
            while time.monotonic()<deadline:
                if select.select([master],[],[],0.1)[0]:
                    try:
                        data = os.read(master,65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if not data:
                        break
                    output.extend(data)
            child.wait(timeout=2)
            decoded = output.decode(errors='replace')
            self.assertEqual(child.returncode,0,decoded)
            result = re.search(r'RESULT:(\{[^\r\n]+\})',decoded)
            self.assertIsNotNone(result,decoded)
            return json.loads(result[1]),decoded
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            os.close(master)

    def test_pasted_port_is_normalized_without_manual_key_prompts(self):
        for lang in ['ru','en']:
            with self.subTest(lang=lang):
                values,output = self.wizard(lang,['203.0.113.10','\x1b[200~18443\x1b[201~','1024','TRUE'])
                self.assertEqual(values['PAWTALK_PORT'],'18443')
                self.assertEqual(values['PAWTALK_CHAT_MAX_MB'],'1024')
                self.assertNotIn('PAWTALK_E2EE',values)
                self.assertNotIn('PAWTALK_E2EE_KEY_ID',values)
                self.assertNotIn('SHA-256 key ID',output)

    def test_invalid_history_and_boolean_are_reprompted(self):
        for lang in ['ru','en']:
            with self.subTest(lang=lang):
                values,output = self.wizard(lang,['203.0.113.10','','invalid-limit','1024','tru\u0435','true'])
                self.assertEqual(values['PAWTALK_CHAT_MAX_MB'],'1024')
                self.assertEqual(values['PAWTALK_SERVER_AUTO_UPDATE'],'true')
                self.assertIn('Введите да или нет' if lang == 'ru' else 'Enter yes or no',output)
                self.assertNotIn('Traceback',output)

    def test_defaults_enable_both_update_components_with_mandatory_encryption(self):
        for lang in ['ru','en']:
            with self.subTest(lang=lang):
                values,output = self.wizard(lang,['203.0.113.10','','',''])
                for field in ['PAWTALK_SERVER_AUTO_UPDATE','PAWTALK_MANAGER_AUTO_UPDATE']:
                    self.assertEqual(values[field],'true')
                self.assertIn('Сквозное шифрование обязательно' if lang == 'ru' else 'End-to-end encryption is mandatory',output)
                self.assertNotIn('PAWTALK_E2EE',values)
                self.assertNotIn('stable/preview',output)

    def test_localized_no_disables_updates_without_disabling_encryption(self):
        for lang,no in [('ru','НЕТ'),('en','NO')]:
            with self.subTest(lang=lang):
                values,output = self.wizard(lang,['203.0.113.10','','',no])
                self.assertEqual(values['PAWTALK_SERVER_AUTO_UPDATE'],'false')
                self.assertEqual(values['PAWTALK_MANAGER_AUTO_UPDATE'],'false')
                self.assertNotIn('SHA-256 key ID',output)
                self.assertNotIn('PAWTALK_E2EE',values)


if __name__ == '__main__': unittest.main()
