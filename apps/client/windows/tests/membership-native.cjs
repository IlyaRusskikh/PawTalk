const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, session, net, safeStorage } = require('electron');
const { CredentialStore } = require('../electron/credentials.cjs');
const { MembershipClient } = require('../electron/membership-client.cjs');
const { membershipTransport } = require('../electron/membership-transport.cjs');
const { serverCertificate } = require('../electron/connection.cjs');
const { VoiceSignal } = require('../electron/voice-signal.cjs');
app.disableHardwareAcceleration();
app.setPath('userData', process.env.PAWTALK_NATIVE_TEST_DIR);
const trace=value=>require('node:fs').appendFileSync(process.env.PAWTALK_NATIVE_TEST_LOG,value+'\n');
trace('script loaded');
app.on('certificate-error', (_event, _contents, _url, _error, _certificate, callback) => callback(false));
app.whenReady().then(async () => {
  trace('app ready');
  const fixture = JSON.parse(await fs.readFile(process.env.PAWTALK_NATIVE_TEST_INPUT,'utf8'));
  trace('fixture loaded');
  assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true, 'actual OS-protected storage is unavailable');
  trace('OS encryption available');
  const directory = path.join(app.getPath('userData'), 'credentials');
  const credentials = new CredentialStore(directory, {
    isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    encryptString: value => safeStorage.encryptStringAsync(value),
    decryptString: async value => (await safeStorage.decryptStringAsync(value)).result,
  });
  const transport = membershipTransport(session, (...args) => net.fetch(...args));
  const client = new MembershipClient({ credentials, fetcher: transport, verify: address => serverCertificate(address), trust: async () => {} });
  const secrets = [];
  for (const entry of fixture.servers) {
    trace('joining server');
    const link = `${entry.address}#${new URLSearchParams({ v: '2', server: entry.serverId, invite: entry.inviteId, token: entry.token, setup: '1' })}`;
    const state = await client.join(link, 'Synthetic native admin', 'Synthetic PC');
    assert.equal(state.self.role, 'admin');
    secrets.push(JSON.parse(await credentials.load('pawtalk:server:v2:' + entry.serverId)).secret);
    trace('server joined');
  }
  assert.notEqual(secrets[0], secrets[1], 'different servers reused root secret');
  for (const entry of fixture.servers) assert.equal((await client.state(entry.serverId)).serverId, entry.serverId);
  const second = fixture.servers[1];
  await assert.rejects(transport(second.base + '/healthz', { pawtalkTLSFingerprint: fixture.servers[0].fingerprint, headers: { 'X-PawTalk-Should-Not-Arrive': 'yes' } }),{code:'SERVER_KEY_CHANGED'});
  const bridge = new VoiceSignal();
  try {
    for (const entry of fixture.servers) {
      const local = await bridge.open(entry.base.replace('https:', 'wss:') + '/rtc', entry.fingerprint);
      const response = await fetch(local.replace('ws:', 'http:') + '/rtc/v1');
      assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
      const wrongPath = new URL(local); wrongPath.pathname='/wrong/rtc/v1';
      assert.equal((await fetch(wrongPath.toString().replace('ws:', 'http:'))).status, 404);
      const socket = new WebSocket(local + '/rtc/v1');
      await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});}); socket.close();
    }
    const wrong = await bridge.open(second.base.replace('https:', 'wss:') + '/rtc', fixture.servers[0].fingerprint);
    assert.equal((await fetch(wrong.replace('ws:', 'http:') + '/rtc/v1',{headers:{'X-PawTalk-Should-Not-Arrive':'yes'}})).status,502);
  } finally { bridge.close(); }
  for (const file of await fs.readdir(directory)) {
    const data = await fs.readFile(path.join(directory, file));
    for (const secret of secrets) assert.ok(!data.includes(Buffer.from(secret)), 'credential file contains plaintext root');
  }
  console.log('PASS native Electron Session.fetch + real TLS pins + HTTP/WebSocket voice bridge pin-before-bytes + actual async OS safeStorage');
  trace('PASS native Electron Session.fetch + real TLS pins on two same-IP ports + actual async OS safeStorage');
  app.exit(0);
}).catch(error => { trace(error.stack); console.error(error.stack); app.exit(1); });
