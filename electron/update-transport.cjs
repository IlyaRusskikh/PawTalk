const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { UpdateSecurityError } = require('./update-manifest.cjs');
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
async function download({ fetcher, source, manifest, partial, onProgress, policy = {} }) {
  const { idleMs = 20000, windowMs = 30000, minBytesPerSecond = 64 * 1024, totalMs = 15 * 60 * 1000 } = policy;
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(totalMs)]);
  let idle, monitor, reader, file;
  let size = 0, windowBytes = 0;
  const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => abort.abort(Error('Update download stalled')), idleMs); };
  try {
    resetIdle();
    const response = await fetcher(endpoint(source, `assets/v${manifest.version}/${manifest.name}`), { redirect: source ? 'error' : 'follow', signal });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('Download HTTP ' + response.status); }
    file = await fs.open(partial, 'w', 0o600);
    reader = response.body.getReader(); const hash = createHash('sha256'); let progress = -1;
    monitor = setInterval(() => {
      if ((size - windowBytes) * 1000 / windowMs < minBytesPerSecond) abort.abort(Error('Update download too slow'));
      windowBytes = size;
    }, windowMs);
    for (;;) {
      // Race explicitly: injected transports and Electron must also stop on abort.
      const result = await new Promise((resolve, reject) => {
        const cancel = () => reject(signal.reason);
        if (signal.aborted) return cancel();
        signal.addEventListener('abort', cancel, { once: true });
        reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
      });
      if (result.done) break;
      resetIdle(); size += result.value.length;
      if (size > manifest.size) throw new UpdateSecurityError(source?.name || 'GitHub');
      hash.update(result.value); await file.writeFile(result.value);
      const next = Math.floor(size / manifest.size * 100); if (next !== progress) { progress = next; onProgress(next); }
    }
    // Truncation is a transport failure; a full-sized file with a wrong hash is a security failure.
    if (size !== manifest.size) throw Error('Incomplete update download');
    if (hash.digest('hex') !== manifest.sha256) throw new UpdateSecurityError(source?.name || 'GitHub');
  } finally {
    clearTimeout(idle); clearInterval(monitor); abort.abort();
    if (reader) await reader.cancel().catch(() => {});
    await file?.close();
  }
}
module.exports = { endpoint, metadata, download, readBounded };
