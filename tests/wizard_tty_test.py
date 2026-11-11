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
        env = {**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1]/'deploy'),
               'PYTHONDONTWRITEBYTECODE':'1'}
        script = ('import json; from pawtalk_agent import cli; '
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
                values,output = self.wizard(lang,['203.0.113.10','','\x1b[200~true\x1b[201~','A'*64,'1024','TRUE','True','',''])
                self.assertEqual(values['PAWTALK_E2EE'],'true')
                self.assertEqual(values['PAWTALK_E2EE_KEY_ID'],'a'*64)
                self.assertEqual(values['PAWTALK_CHAT_MAX_MB'],'1024')
                self.assertEqual(values['PAWTALK_SERVER_AUTO_UPDATE'],'true')
                self.assertEqual(values['PAWTALK_DEPLOY_AUTO_UPDATE'],'true')
                self.assertLess(output.index('SHA-256 key ID'),output.index('Лимит истории' if lang == 'ru' else 'History limit'))

    def test_invalid_boolean_and_key_are_reprompted_before_continuing(self):
        for lang in ['ru','en']:
            with self.subTest(lang=lang):
                values,output = self.wizard(lang,['203.0.113.10','','tru\u0435','true','invalid-id','b'*64,'1024','false','false','',''])
                self.assertEqual(values['PAWTALK_E2EE'],'true')
                self.assertEqual(values['PAWTALK_E2EE_KEY_ID'],'b'*64)
                self.assertIn('Введите true или false.' if lang == 'ru' else 'Enter true or false.',output)
                self.assertIn('64 шестнадцатеричных символа' if lang == 'ru' else '64 hexadecimal characters',output)
                self.assertNotIn('Traceback',output)


if __name__ == '__main__': unittest.main()
