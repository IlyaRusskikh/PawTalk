import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'manager'))
from pawtalk_manager.admission import initial_invitation, status


class AdmissionTest(unittest.TestCase):
    def fixture(self, initialized=False, address=None):
        calls = []
        link = address or ('pawtalk://192.0.2.10:18443/' + 'a' * 64
                           + '#v=2&server=' + 'b' * 32 + '&invite=' + 'c' * 32
                           + '&token=' + 'd' * 43 + '&setup=1')

        def command(action):
            calls.append(action)
            if action == 'status':
                return json.dumps(dict(apiProtocolVersion=2, dataSchema=2,
                                       serverId='b' * 32, initialized=initialized)).encode()
            if action == 'initial-admin':
                return link.encode()
            raise AssertionError(action)
        return command, calls

    def test_initial_link_is_generated_only_before_setup(self):
        command, calls = self.fixture()
        self.assertTrue(initial_invitation(command)['url'].startswith('pawtalk://'))
        self.assertEqual(calls, ['status', 'initial-admin'])
        command, calls = self.fixture(initialized=True)
        self.assertIsNone(initial_invitation(command))
        self.assertEqual(calls, ['status'])

    def test_legacy_and_malformed_status_do_not_authorize_bootstrap(self):
        for value in [dict(apiProtocolVersion=1, dataSchema=1, serverId='b' * 32, initialized=False),
                      dict(apiProtocolVersion=2, dataSchema=2, serverId='b' * 32, initialized=0)]:
            with self.assertRaises(ValueError):
                status(lambda action: json.dumps(value).encode())
        with self.assertRaises(RuntimeError):
            initial_invitation(lambda action: (_ for _ in ()).throw(RuntimeError('offline')))

    def test_no_password_plaintext_http_or_duplicate_invite_fields(self):
        for address in ['http://192.0.2.10/', 'pawtalk://192.0.2.10:18443/' + 'a' * 64 + '#password=synthetic',
                        self.fixture()[0]('initial-admin').decode() + '&setup=1',
                        self.fixture()[0]('initial-admin').decode().replace('setup=1', 'setup=0')]:
            with self.assertRaises(ValueError):
                initial_invitation(self.fixture(address=address)[0])


if __name__ == '__main__':
    unittest.main()
