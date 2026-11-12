import test from 'node:test';
import assert from 'node:assert/strict';
import downloads from '../shared/build-download.cjs';

test('build downloads authenticate GitHub API metadata/assets and keep CI tokens off other origins', () => {
  const token = 'synthetic-ci-token';
  for (const url of ['https://api.github.com/repos/livekit/livekit/releases/tags/v1.13.11', 'https://api.github.com/repos/livekit/livekit/releases/assets/123']) {
    const headers = downloads.buildDownloadHeaders(url, { Accept: 'application/octet-stream' }, token);
    assert.equal(headers.Authorization, 'Bearer ' + token);
    assert.equal(headers.Accept, 'application/octet-stream');
  }
  for (const url of ['https://raw.githubusercontent.com/livekit/livekit/main/LICENSE', 'https://release-assets.githubusercontent.com/example', 'https://api.github.com.example/releases', 'http://api.github.com/releases', 'https://api.github.com:444/releases']) {
    assert.equal(downloads.buildDownloadHeaders(url, {}, token).Authorization, undefined);
  }
  assert.equal(downloads.buildDownloadHeaders('https://api.github.com/releases', {}, '').Authorization, undefined, 'local builds need no token');
});
