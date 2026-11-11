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

    def test_pasted_true_requests_key_before_history_in_both_languages(self):
        for lang in ['ru','en']:
            with self.subTest(lang=lang):
                values,output = self.wizard(lang,['203.0.113.10','','\x1b[200~true\x1b[201~','A'*64,'1024','TRUE'])
                self.assertEqual(values['PAWTALK_E2EE'],'true')
                self.assertEqual(values['PAWTALK_E2EE_KEY_ID'],'a'*64)
                self.assertEqual(values['PAWTALK_CHAT_MAX_MB'],'1024')
                self.assertEqual(values['PAWTALK_SERVER_AUTO_UPDATE'],'true')
                self.assertEqual(values['PAWTALK_MANAGER_AUTO_UPDATE'],'true')
                self.assertLess(output.index('SHA-256 key ID'),output.index('Лимит истории' if lang == 'ru' else 'History limit'))

    def test_invalid_boolean_and_key_are_reprompted_before_continuing(self):
        for lang in ['ru','en']:
            with self.subTest(lang=lang):
                values,output = self.wizard(lang,['203.0.113.10','','tru\u0435','true','invalid-id','b'*64,'1024','false'])
                self.assertEqual(values['PAWTALK_E2EE'],'true')
                self.assertEqual(values['PAWTALK_E2EE_KEY_ID'],'b'*64)
                self.assertIn('Введите да или нет' if lang == 'ru' else 'Enter yes or no',output)
                self.assertIn('64 шестнадцатеричных символа' if lang == 'ru' else '64 hexadecimal characters',output)
                self.assertNotIn('Traceback',output)

    def test_defaults_enable_encryption_and_both_update_components(self):
        for lang in ['ru','en']:
            with self.subTest(lang=lang):
                values,output = self.wizard(lang,['203.0.113.10','','','c'*64,'',''])
                for field in ['PAWTALK_E2EE','PAWTALK_SERVER_AUTO_UPDATE','PAWTALK_MANAGER_AUTO_UPDATE']:
                    self.assertEqual(values[field],'true')
                self.assertIn('(да/нет) [да]' if lang == 'ru' else '(yes/no) [yes]',output)
                self.assertEqual(output.count('Включить автоматическое обновление сервера?' if lang == 'ru' else 'Enable automatic server updates?'),1)
                self.assertNotIn('stable/preview',output)
                self.assertNotIn('PAWTALK_SERVER_CHANNEL',values)
                self.assertNotIn('PAWTALK_MANAGER_CHANNEL',values)

    def test_localized_answers_disable_encryption_and_both_updates(self):
        for lang,yes,no in [('ru','ДА','НЕТ'),('en','YES','NO')]:
            for encrypted in [True,False]:
                with self.subTest(lang=lang,encrypted=encrypted):
                    answers = ['203.0.113.10','',yes if encrypted else no]
                    if encrypted:
                        answers.append('d'*64)
                    values,output = self.wizard(lang,answers+['',no])
                    self.assertEqual(values['PAWTALK_E2EE'],'true' if encrypted else 'false')
                    self.assertEqual(values['PAWTALK_SERVER_AUTO_UPDATE'],'false')
                    self.assertEqual(values['PAWTALK_MANAGER_AUTO_UPDATE'],'false')
                    self.assertEqual('SHA-256 key ID' in output,encrypted)


if __name__ == '__main__': unittest.main()
