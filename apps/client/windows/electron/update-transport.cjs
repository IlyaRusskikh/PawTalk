const REPOSITORY = 'IlyaRusskikh/PawTalk';
function endpoint(source, pathname) {
  return source ? source.base + '/api/updates/' + pathname : pathname.startsWith('releases?')
    ? `https://api.github.com/repos/${REPOSITORY}/${pathname}`
    : `https://github.com/${REPOSITORY}/releases/download/${pathname.slice('assets/'.length)}`;
}
async function readBounded(response, max) {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('Update HTTP ' + response.status); }
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > max) throw Error('Update response too large'); chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}
async function metadata(fetcher, source, pathname, max = 8 * 1024 * 1024) {
  return readBounded(await fetcher(endpoint(source, pathname), { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PawTalk' },
    redirect: source ? 'error' : 'follow', signal: AbortSignal.timeout(15000) }), max);
}
async function download(options) {
  return require('./update-race.cjs').downloadFastest({ ...options, rooms: [],
    tag: options.tag || `v${options.manifest.version}`, fetchFor: () => options.fetcher });
}
module.exports = { endpoint, metadata, download, readBounded };
