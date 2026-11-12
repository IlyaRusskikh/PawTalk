const assert = require('node:assert/strict');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { randomBytes, createHash, X509Certificate } = require('node:crypto');
const { SelfHost } = require('../electron/selfhost.cjs');
const { invitation } = require('../electron/address.cjs');
const port = 29443;
const host = new SelfHost(path.resolve('resources/server'));
function request(address, endpoint, body, token) {
  const { origin, fingerprint } = invitation(address);
  return new Promise((resolve, reject) => {
    const r = https.request(origin+endpoint, { method: body ? 'POST' : 'GET', rejectUnauthorized: false, agent: false, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer '+token } : {}) } }, response => {
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
  let previousFingerprint, previousToken;
  for (const e2ee of [false, true]) {
  try {
    const status = await host.start({ port, password, e2ee });
    assert.equal(status.running, true);
    assert.notEqual(status.fingerprint, previousFingerprint, 'recreating a room rotates TLS identity');
    const key = invitation(status.localAddress).e2eeKey;
    const policy = e2ee ? { e2ee: true, e2eeKeyId: createHash('sha256').update(Buffer.from(key,'hex')).digest('hex') } : {};
    assert.equal((await request(status.localAddress, '/healthz')).status, 200);
    assert.equal(JSON.parse((await request(status.localAddress, '/api/config')).body).e2eeRequired, e2ee);
    for (const endpoint of ['/api/presence','/api/preview','/api/chat']) {
      const denied = await request(status.localAddress, endpoint);
      assert.equal(denied.status, 401, 'anonymous activity/chat denied');
      assert.doesNotMatch(denied.body, /participants|messages/);
    }
    if (previousToken) assert.equal((await request(status.localAddress,'/api/chat',undefined,previousToken)).status,401,'old room access is not reused');
    assert.equal((await request(status.localAddress, '/api/connect', { nickname: 'Smoke', password: 'incorrect', ...policy })).status, 401);
    if(e2ee) assert.equal((await request(status.localAddress,'/api/connect',{nickname:'Smoke',password})).status,426,'E2EE cannot downgrade');
    const joined = await request(status.localAddress, '/api/connect', { nickname: 'Smoke', password, ...policy });
    assert.equal(joined.status, 200);
    const credentials = JSON.parse(joined.body);
    assert.equal(credentials.url, `wss://127.0.0.1:${port}/rtc`);
    assert.equal(credentials.chatEphemeral,true,'temporary chat stays in memory');
    const token=credentials.chatToken;
    assert.equal((await request(status.localAddress,'/api/presence',undefined,token)).status,200);
    const packet={requestId:randomBytes(16).toString('hex'),nonce:e2ee?randomBytes(12).toString('base64'):'',ciphertext:(e2ee?randomBytes(32):Buffer.from('synthetic chat')).toString('base64')};
    assert.equal((await request(status.localAddress,'/api/chat',packet,token)).status,200,'shared chat accepts temporary-room packets');
    const page=JSON.parse((await request(status.localAddress,'/api/chat?limit=100',undefined,token)).body);
    assert.equal(page.messages.length,1);
    assert.equal(page.messages[0].ciphertext,packet.ciphertext,'chat round trip preserves payload');
    previousFingerprint=status.fingerprint;previousToken=token;
    assert.equal((await request(status.localAddress, '/rtc')).status, 200);
    const stale = new URL(status.localAddress);
    stale.pathname = '/' + status.fingerprint.slice(0, -1) + (status.fingerprint.endsWith('a') ? 'b' : 'a');
    await assert.rejects(request(stale.href, '/healthz'), /Certificate pin mismatch/);
    console.log(`PASS shared selfhost TLS, auth, private activity, ephemeral chat, E2EE=${e2ee} and LiveKit proxy`);
  } finally { await host.stop(); }
  for (const p of [port, port+1, port+3]) {
    await new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(p, '0.0.0.0', () => s.close(resolve)); });
  }
  console.log('PASS selfhost shutdown releases API and LiveKit listeners');
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
