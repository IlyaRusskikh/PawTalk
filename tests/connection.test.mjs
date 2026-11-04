import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
const { localInvitation, verifyInvitation, connectionError } = createRequire(import.meta.url)('../electron/connection.cjs');
const pin = 'a'.repeat(64), external = `voicecord://203.0.113.10:18443/${pin}`, local = `voicecord://127.0.0.1:18443/${pin}`;
const host = { running: true, invitations: [external], localAddress: local };
test('own current public invitation uses loopback without relying on NAT reflection', () => {
  assert.equal(localInvitation(external, host), local);
  assert.equal(localInvitation(external, { ...host, running: false }), external);
  assert.equal(localInvitation(external, {}), external);
});
test('old, foreign and modified invitations never bypass certificate verification', () => {
  for (const address of [external.replace(pin, 'b'.repeat(64)), external.replace('203.0.113.10', '203.0.113.11')]) assert.equal(localInvitation(address, host), address);
  assert.equal(localInvitation(external, { ...host, localAddress: local.replace(pin, 'b'.repeat(64)) }), external);
  assert.throws(() => localInvitation('voicecord://example.com:18443/invalid', host));
});
test('diagnostics distinguish TLS stalls from unopened TCP ports', async () => {
  const connections = new Set();
  const server = net.createServer(socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `voicecord://127.0.0.1:${server.address().port}/${pin}`;
  try { await assert.rejects(verifyInvitation(address, 70), { code: 'VOICECORD_TLS_TIMEOUT' }); }
  finally { for (const socket of connections) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(verifyInvitation(address, 1000), { code: 'ECONNREFUSED' });
  assert.match(connectionError({ code: 'VOICECORD_CERTIFICATE_PIN' }), /устарело/);
  assert.match(connectionError({ code: 'VOICECORD_TLS_TIMEOUT' }), /TCP/);
  assert.match(connectionError({ code: 'ECONNREFUSED' }), /отклонил/);
  assert.match(connectionError({ code: 'ETIMEDOUT' }), /VPN/);
});

test('bookmarked invitations without embedded passwords still use the current host loopback', () => {
 const live = { ...host, invitations: [external + '#password=secret'], localAddress: local + '#password=secret' };
 assert.equal(localInvitation(external, live), live.localAddress);
 assert.equal(localInvitation(external.replace(pin, 'b'.repeat(64)), live), external.replace(pin, 'b'.repeat(64)));
});
