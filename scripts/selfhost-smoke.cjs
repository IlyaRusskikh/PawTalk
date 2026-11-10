const assert = require('node:assert/strict');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { randomBytes, X509Certificate } = require('node:crypto');
const { SelfHost } = require('../electron/selfhost.cjs');
const { invitation } = require('../electron/address.cjs');
const port = 29443;
const host = new SelfHost(path.resolve('resources/server'));
function request(address, endpoint, body) {
  const { origin, fingerprint } = invitation(address);
  return new Promise((resolve, reject) => {
    const r = https.request(origin+endpoint, { method: body ? 'POST' : 'GET', rejectUnauthorized: false, agent: false, headers: body ? { 'Content-Type': 'application/json' } : {} }, response => {
      const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    r.on('socket', socket => socket.on('secureConnect', () => {
      const nameError = require('node:tls').checkServerIdentity(new URL(origin).hostname, socket.getPeerCertificate());
      if (nameError) { r.destroy(nameError); return; }
      const actual = new X509Certificate(socket.getPeerCertificate().raw).fingerprint256.replaceAll(':','').toLowerCase();
      if (actual !== fingerprint) r.destroy(new Error('Certificate pin mismatch'));
    }));
    r.setTimeout(5000, () => r.destroy(new Error('Request timeout'))); r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
  });
}
(async () => {
  const password = randomBytes(24).toString('base64url');
  try {
    const status = await host.start({ port, password });
    assert.equal(status.running, true);
    assert.equal((await request(status.localAddress, '/healthz')).status, 200);
    assert.equal((await request(status.localAddress, '/api/connect', { nickname: 'Smoke', password: 'incorrect' })).status, 401);
    const joined = await request(status.localAddress, '/api/connect', { nickname: 'Smoke', password });
    assert.equal(joined.status, 200);
    assert.equal(JSON.parse(joined.body).url, `wss://127.0.0.1:${port}/rtc`);
    assert.equal((await request(status.localAddress, '/rtc')).status, 200);
    const stale = new URL(status.localAddress);
    stale.pathname = '/' + status.fingerprint.slice(0, -1) + (status.fingerprint.endsWith('a') ? 'b' : 'a');
    await assert.rejects(request(stale.href, '/healthz'), /Certificate pin mismatch/);
    console.log(`PASS selfhost startup, pinned TLS, password rejection, token, LiveKit proxy (router mappings: ${status.mapped})`);
  } finally { await host.stop(); }
  for (const p of [port, port+1, port+3]) {
    await new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(p, '0.0.0.0', () => s.close(resolve)); });
  }
  console.log('PASS selfhost shutdown releases API and LiveKit listeners');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
