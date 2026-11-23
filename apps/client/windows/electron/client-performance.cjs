const { AsyncLocalStorage } = require('node:async_hooks');
const { appendFile, mkdir, rename, stat } = require('node:fs/promises');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');

const actions = new Set(['connect', 'servers', 'join', 'chat.protected.read', 'chat.protected.window',
  'chat.protected.edition', 'chat.protected.attachment', 'chat.protected.send', 'roster.protected.read', 'protection.protected.read']);
const rendererStages = new Set(['chat.open.rendered', 'media.preview.decoded', 'media.preview.failed']);
const clientStages = new Set(['history.verify', 'history.policy.replay', 'history.edits', 'attachment.decrypt', 'attachment.imported.decrypt']);
const routes = [
  [/^\/api\/v[23]\/(config|session|activity)(?:\/|$)/, 'session'],
  [/^\/api\/v3\/history\/(live-attachments|attachments)\//, 'attachment'],
  [/^\/api\/v3\/history\/window\//, 'history.window'],
  [/^\/api\/v3\/history\/imported\/[^/]+\/link$/, 'history.archive-link'],
  [/^\/api\/v3\/history\/imported\//, 'history.imported'],
  [/^\/api\/v3\/history\/live\//, 'history.live'],
  [/^\/api\/v3\/history\/revisions\//, 'history.revisions'],
  [/^\/api\/v3\/keys\/([^/]+)\//, 'keys'],
  [/^\/api\/v3\/policy\/([^/]+)(?:\/|$)/, 'policy'],
  [/^\/api\/v3\/roster\//, 'roster'],
  [/^\/api\/v3\/(profiles\/self|community)\/avatar(?:\/|$)/, 'avatar'],
];
const categories = new Set(['current', 'admitted', 'proofs', 'archive', 'rotate', 'attestations', 'scope-authority', 'channel-proof']);
const codes = new Set(['RATE_LIMIT', 'CONNECTION_FAILED', 'ETIMEDOUT', 'ECONNRESET', 'NOT_CONNECTED',
  'INVALID_API_RESPONSE', 'PROTECTED_ACCESS_DENIED', 'PROTECTED_KEY_PENDING', 'POLICY_ATTESTATION_UNAVAILABLE', 'UNVERIFIED_EPOCH_POLICY']);

function clientPerformance(directory) {
  const context = new AsyncLocalStorage();
  const prefix = randomBytes(4).toString('hex');
  const file = join(directory, 'client-performance.jsonl');
  let sequence = 0, pending = [], timer, writing;
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (writing || !pending.length) return writing;
    const body = pending.join('');
    pending = [];
    writing = (async () => {
      await mkdir(directory, { recursive: true });
      const size = (await stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; }))?.size ?? 0;
      if (size + Buffer.byteLength(body) > 1024 * 1024) await rename(file, file + '.1');
      await appendFile(file, body, { mode: 0o600 });
    })().catch(() => {}).finally(() => { writing = undefined; if (pending.length) schedule(); });
    return writing;
  }
  function schedule() {
    if (!timer && !writing) timer = setTimeout(flush, 400).unref();
  }
  function record(entry) {
    if (pending.length >= 512) return;
    pending.push(JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
    schedule();
  }
  async function measure(stage, operation, fields = {}) {
    const started = performance.now(), trace = context.getStore();
    let outcome = 'ok', status, code;
    try { return await operation(); }
    catch (error) {
      outcome = 'error';
      if (codes.has(error?.code)) code = error.code;
      if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) status = error.status;
      throw error;
    }
    finally { record({ stage, ...fields, trace, outcome, status, code, ms: Math.round(performance.now() - started) }); }
  }
  return {
    action(name, operation) {
      if (!actions.has(name)) return operation();
      return context.run(`${prefix}-${++sequence}`, () => measure(`ipc.${name}`, operation));
    },
    request(path, method, operation) {
      if (typeof path !== 'string') return operation();
      const pathname = path.split('?', 1)[0];
      for (const [pattern, stage] of routes) {
        const match = pattern.exec(pathname);
        if (match) return measure(`http.${stage}${categories.has(match[1]) ? '.' + match[1] : ''}`, operation,
          { method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : 'other' });
      }
      return operation();
    },
    renderer(stage, ms) {
      if (rendererStages.has(stage) && Number.isFinite(ms) && ms >= 0 && ms <= 600_000) record({ stage, ms: Math.round(ms) });
    },
    stage(stage, operation) { return clientStages.has(stage) ? measure(stage, operation) : operation(); },
    async close() {
      await writing;
      await flush();
    },
  };
}

module.exports = { clientPerformance };
