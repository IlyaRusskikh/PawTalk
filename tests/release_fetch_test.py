"""Download regressions; injected faults do not verify external network access."""
import http.client
import io
import ssl
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'manager'))
from pawtalk_manager import cli, release


class FetchTests(unittest.TestCase):
    url = f'https://github.com/{release.REPO}/releases/download/manager-v0.1.0/manager-manifest.json'

    def test_interactive_metadata_request_has_short_timeout_without_retries(self):
        with patch.object(release.urllib.request,'build_opener') as build,patch.object(release.time,'sleep') as sleep:
            build.return_value.open.side_effect=TimeoutError()
            with self.assertRaises(release.DownloadError):
                release.fetch(self.url,timeout=5,attempts=1)
            self.assertEqual(build.return_value.open.call_count,1)
            self.assertEqual(build.return_value.open.call_args.kwargs['timeout'],5)
            sleep.assert_not_called()

    def response(self, data=b'complete', length=None):
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = data
        response.headers = {'Content-Length': str(len(data) if length is None else length)}
        return response

    def test_transient_failures_retry_with_fresh_response(self):
        for error in [urllib.error.URLError(ConnectionResetError(10054, 'reset')),
                      ConnectionResetError(10054, 'reset'), TimeoutError(),
                      urllib.error.URLError(TimeoutError()), ssl.SSLEOFError(),
                      http.client.IncompleteRead(b'partial')]:
            with self.subTest(error=type(error).__name__), patch.object(release.urllib.request, 'build_opener') as build, patch.object(release.time, 'sleep') as sleep:
                broken = self.response()
                broken.read.side_effect = error
                build.return_value.open.side_effect = [broken, self.response()]
                self.assertEqual(release.fetch(self.url), b'complete')
                self.assertEqual(build.return_value.open.call_count, 2)
                sleep.assert_called_once_with(1)
                broken.__exit__.assert_called_once()

    def test_short_content_length_restarts_download(self):
        with patch.object(release.urllib.request, 'build_opener') as build, patch.object(release.time, 'sleep'):
            build.return_value.open.side_effect = [self.response(b'part', 8), self.response()]
            self.assertEqual(release.fetch(self.url), b'complete')
            self.assertEqual(build.return_value.open.call_count, 2)

    def test_http_retry_policy(self):
        for code in [408, 429, 500, 502, 503, 504, 403, 404]:
            with self.subTest(code=code), patch.object(release.urllib.request, 'build_opener') as build, patch.object(release.time, 'sleep'):
                body = io.BytesIO(b'error')
                error = urllib.error.HTTPError(self.url, code, 'failure', {}, body)
                build.return_value.open.side_effect = [error, self.response()]
                if code in [403, 404]:
                    with self.assertRaises(urllib.error.HTTPError):
                        release.fetch(self.url)
                    self.assertEqual(build.return_value.open.call_count, 1)
                else:
                    self.assertEqual(release.fetch(self.url), b'complete')
                self.assertTrue(body.closed)

    def test_exhaustion_is_bounded_and_localized(self):
        with patch.object(release.urllib.request, 'build_opener') as build, patch.object(release.time, 'sleep') as sleep:
            build.return_value.open.side_effect = urllib.error.URLError(ConnectionResetError(10054, 'secret-query'))
            with self.assertRaises(release.DownloadError) as caught:
                release.fetch(self.url)
            self.assertEqual(build.return_value.open.call_count, 3)
            self.assertEqual([c.args for c in sleep.call_args_list], [(1,), (2,)])
            error = caught.exception
            self.assertNotIn('secret-query', str(error))
            for language in ['ru', 'en']:
                message = cli.text('download_error', language).format(host=error.host, attempts=error.attempts)
                self.assertIn('github.com', message)
                self.assertIn('3', message)
            self.assertNotEqual(cli.text('download_error', 'ru'), cli.text('download_error', 'en'))

    def test_validation_and_certificate_failures_are_not_retried(self):
        for error in [ssl.SSLCertVerificationError('bad certificate'),
                      urllib.error.URLError(ssl.SSLCertVerificationError('bad certificate'))]:
            with patch.object(release.urllib.request, 'build_opener') as build, patch.object(release.time, 'sleep') as sleep:
                build.return_value.open.side_effect = error
                with self.assertRaises(OSError):
                    release.fetch(self.url)
                sleep.assert_not_called()
        with patch.object(release.urllib.request, 'build_opener') as build, patch.object(release.time, 'sleep') as sleep:
            with self.assertRaises(ValueError):
                release.fetch('https://example.com/untrusted')
            build.assert_not_called()
            build.return_value.open.return_value = self.response(b'oversize')
            with self.assertRaises(ValueError):
                release.fetch(self.url, 2)
            sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
