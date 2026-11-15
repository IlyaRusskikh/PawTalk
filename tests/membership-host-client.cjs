// Real API 2 crypto/lifecycle client for Linux host integration. Synthetic keys
// are stored only in the disposable fixture, not in production credential storage.
const fs = require('node:fs/promises');
const https = require('node:https');
const tls = require('node:tls');
const assert = require('node:assert/strict');
const { MembershipClient } = require('../electron/membership-client.cjs');
const { invitation } = require('../electron/address.cjs');
const [mode, directory, address] = process.argv.slice(2);
async function pinnedSocket(url, pin) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: url.hostname, port: url.port || 443, rejectUnauthorized: false });
    socket.setTimeout(10000, () => socket.destroy(Error('TLS timeout')));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const actual = socket.getPeerCertificate().fingerprint256.replaceAll(':', '').toLowerCase();
      if (actual !== pin) { socket.destroy(); reject(Error('TLS pin mismatch')); } else resolve(socket);
    });
  });
}
(async () => {
  const file = directory + '/client-keys.json';
  const entries = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}'));
  const credentials = { load: async key => entries[key] ?? null, save: async (key, value) => {
    entries[key] = value; await fs.writeFile(file, JSON.stringify(entries), { mode: 0o600 });
  }};
  const client = new MembershipClient({ credentials, trust: async () => {}, verify: async value => {
    const room = invitation(value); assert.ok(room); const socket = await pinnedSocket(new URL(room.origin), room.fingerprint); socket.destroy(); return room.fingerprint;
  }, fetcher: async (value, options) => {
    const url = new URL(value), socket = await pinnedSocket(url, options.pawtalkTLSFingerprint);
    const agent = new https.Agent(); agent.createConnection = (_options, callback) => callback(null, socket);
    return new Promise((resolve, reject) => {
      const request = https.request(url, { method: options.method || 'GET', headers: options.headers, agent }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
        response.once('end', () => { agent.destroy(); resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })); });
      });
      request.once('error', error => { agent.destroy(); reject(error); }); request.end(options.body);
    });
  }});
  if(mode==='reject-legacy'){
    await assert.rejects(client.verified(address),error=>error.code==='UNSUPPORTED_PROTOCOL');
    assert.deepEqual(entries,{},'legacy peer received or created a device identity');
    console.log('PASS frozen API 1 peer rejected before identity or admission');return;
  }
  const state = mode === 'join' ? await client.join(address, 'Synthetic Linux admin', 'Synthetic Linux device') : await client.connect((await client.registry())[0]);
  assert.equal(state.self.role, 'admin');
  const channel = state.channels.find(value => value.kind === 'text');
  if (mode === 'join') await client.send(state.serverId, channel.id, { text: 'Linux host encrypted lifecycle fixture' });
  const page = await client.messages(state.serverId, channel.id);
  assert.ok(page.messages.some(message => message.content.text === 'Linux host encrypted lifecycle fixture'));
  console.log('PASS real API 2 membership and encrypted history: ' + mode);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
