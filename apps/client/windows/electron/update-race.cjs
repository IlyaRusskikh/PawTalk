const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { endpoint } = require('./update-transport.cjs');
const { UpdateSecurityError } = require('./update-manifest.cjs');

// Keep the sampled stream open: the selected prefix is written once, then the
// very same reader continues. Probes never execute or trust downloaded bytes.
async function downloadFastest({ fetchFor, rooms, source: initialSource = null, manifest, tag, partial, onProgress, policy = {} }) {
  if (tag !== `v${manifest.version}` && tag !== `client-v${manifest.version}`) throw new UpdateSecurityError('GitHub');
  const { sampleMs = 1500, sampleBytes = 1024 * 1024, headerMs = 5000,
    idleMs = 20000, windowMs = 30000, minBytesPerSecond = 64 * 1024, totalMs = 15 * 60 * 1000 } = policy;
  const overall = AbortSignal.timeout(totalMs), active = new Set(), excluded = new Set();
  const name = source => source?.name || 'GitHub';
  const key = source => source?.base || 'GitHub';
  const abortable = (promise, signal) => new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return abort(); }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  const close = candidate => {
    if (!candidate) return;
    candidate.abort.abort(); active.delete(candidate);
    // Some injected transports ignore abort. Cancellation must not hold up a
    // successful download while their outstanding read is being unwound.
    candidate.reader?.cancel().catch(() => {});
  };
  async function probe(source) {
    const candidate = { source, abort: new AbortController(), chunks: [], size: 0, hash: createHash('sha256'), done: false };
    active.add(candidate);
    const signal = AbortSignal.any([overall, candidate.abort.signal]);
    candidate.signal = signal;
    const started = performance.now(); let header;
    try {
      header = setTimeout(() => candidate.abort.abort(Error('Update source timed out')), Math.min(headerMs, idleMs));
      const request = Promise.resolve(fetchFor(source)(endpoint(source, `assets/${tag}/${manifest.name}`), {
        redirect: source ? 'error' : 'follow', signal,
      }));
      request.then(response => { if (signal.aborted) response.body?.cancel().catch(() => {}); }, () => {});
      const response = await abortable(request, signal);
      if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('Download HTTP ' + response.status); }
      candidate.reader = response.body.getReader(); clearTimeout(header);
      const deadline = performance.now() + sampleMs;
      while (candidate.size < sampleBytes) {
        candidate.pending ||= candidate.reader.read();
        let timer;
        const result = await abortable(Promise.race([candidate.pending,
          new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - performance.now())); })]), signal)
          .finally(() => clearTimeout(timer));
        if (!result) break;
        candidate.pending = null;
        if (result.done) { finish(candidate); break; }
        accept(candidate, result.value); candidate.chunks.push(result.value);
      }
      if (!candidate.size) throw Error('Update source supplied no data');
      candidate.speed = candidate.done ? Infinity : candidate.size * 1000 / Math.max(1, performance.now() - started);
      return candidate;
    } catch (error) { close(candidate); throw error; }
    finally { clearTimeout(header); }
  }
  function accept(candidate, bytes) {
    candidate.size += bytes.length;
    if (candidate.size > manifest.size) throw new UpdateSecurityError(name(candidate.source));
    candidate.hash.update(bytes);
    if (candidate.size === manifest.size && candidate.hash.copy().digest('hex') !== manifest.sha256) throw new UpdateSecurityError(name(candidate.source));
  }
  function finish(candidate) {
    if (candidate.size !== manifest.size) throw Error('Incomplete update download');
    if (candidate.hash.digest('hex') !== manifest.sha256) throw new UpdateSecurityError(name(candidate.source));
    candidate.done = true;
  }
  const prepared = new Map();
  async function select() {
    let best, fatal;
    const consider = async source => {
      if (excluded.has(key(source)) || overall.aborted || best?.done || fatal) return;
      try {
        const candidate = await probe(source);
        if (fatal || best?.done) { close(candidate); return; }
        if (!best || candidate.speed > best.speed) {
          close(best); best = candidate;
          if (best.done) for (const other of active) if (other !== best) close(other);
        }
        else close(candidate);
      } catch (error) { if (error.code === 'UPDATE_SECURITY') { fatal = error; for (const candidate of active) close(candidate); } }
    };
    // GitHub gets the first measurement. A complete authenticated small file
    // needs no further connections; otherwise every configured room is eligible.
    await consider(initialSource);
    let index = 0; const seen = new Set();
    await Promise.all(Array.from({ length: Math.min(2, rooms.length) }, async () => {
      while (index < rooms.length && !best?.done && !fatal && !overall.aborted) {
        const room = rooms[index++];
        try {
          if (!prepared.has(room)) prepared.set(room, Promise.resolve().then(() => room.prepare()));
          const source = await abortable(prepared.get(room), AbortSignal.any([overall, AbortSignal.timeout(headerMs)]));
          if (!source || seen.has(source.base)) continue;
          seen.add(source.base); await consider({ ...source, name: room.name });
        } catch { /* Unreachable or untrusted rooms cannot participate. */ }
      }
    }));
    if (fatal) throw fatal;
    if (!best) throw Error('No update source available');
    return best;
  }
  try {
    for (;;) {
      const winner = await select(); let file, monitor, idle;
      const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => winner.abort.abort(Error('Update download stalled')), idleMs); };
      try {
        file = await fs.open(partial, 'w', 0o600);
        onProgress(0, name(winner.source));
        for (const chunk of winner.chunks) await file.writeFile(chunk);
        winner.chunks = [];
        let windowBytes = winner.size;
        if (!winner.done) {
          resetIdle();
          monitor = setInterval(() => {
            if ((winner.size - windowBytes) * 1000 / windowMs < minBytesPerSecond) winner.abort.abort(Error('Update download too slow'));
            windowBytes = winner.size;
          }, windowMs);
        }
        onProgress(Math.floor(winner.size / manifest.size * 100), name(winner.source));
        while (!winner.done) {
          const result = await abortable(winner.pending || winner.reader.read(), winner.signal); winner.pending = null;
          if (result.done) { finish(winner); break; }
          resetIdle(); accept(winner, result.value); await file.writeFile(result.value);
          onProgress(Math.floor(winner.size / manifest.size * 100), name(winner.source));
        }
        return;
      } catch (error) {
        if (error.code === 'UPDATE_SECURITY' || ['ENOSPC', 'EACCES', 'EPERM'].includes(error.code) || overall.aborted) throw error;
        excluded.add(key(winner.source));
      } finally { clearInterval(monitor); clearTimeout(idle); close(winner); await file?.close(); }
    }
  } finally { for (const candidate of active) close(candidate); }
}
module.exports = { downloadFastest };
