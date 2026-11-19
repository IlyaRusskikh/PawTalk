import test from 'node:test';
import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import { signatureFrame } from '../../shared/framing.mjs';
import { randomSecret, rootKeyID, deriveChannelBytes, sealInvitation, openInvitation, sealContent, openContent, hex } from '../../shared/server-crypto.mjs';

test('derived keys match standard HKDF and separate channel/purpose/server', async () => {
  const secret = randomSecret(), server = 'a'.repeat(32), channel = 'b'.repeat(32);
  const keyId = await rootKeyID(secret);
  const key = await deriveChannelBytes(secret, server, 'chat', channel);
  const expected = hkdfSync('sha256', Buffer.from(secret, 'hex'), Buffer.from(server, 'hex'), signatureFrame('pawtalk-key-v2', 'chat', channel, keyId), 32);
  assert.equal(hex(key), hex(expected));
  for (const [sid, purpose, cid] of [[server, 'voice', channel], [server, 'chat', 'c'.repeat(32)], ['d'.repeat(32), 'chat', channel]]) assert.notEqual(hex(await deriveChannelBytes(secret, sid, purpose, cid)), hex(key));
});

test('invitation package opens offline and rejects wrong key, server, invite or digest', async () => {
  const secret = randomSecret(), opening = randomSecret(), server = 'a'.repeat(32), invite = 'b'.repeat(32);
  const { packet, digest } = await sealInvitation(secret, server, invite, opening);
  assert.equal(await openInvitation(packet, digest, server, invite, opening), secret);
  assert.ok(!JSON.stringify(packet).includes(secret));
  await assert.rejects(openInvitation(packet, digest, server, invite, randomSecret()));
  await assert.rejects(openInvitation(packet, digest, 'c'.repeat(32), invite, opening));
  await assert.rejects(openInvitation(packet, digest, server, 'c'.repeat(32), opening));
  await assert.rejects(openInvitation(packet, '0'.repeat(64), server, invite, opening));
});

test('message content is bound to original author, resource and channel and edits use fresh nonce', async () => {
  const secret = randomSecret(), server = 'a'.repeat(32), channel = 'b'.repeat(32), author = 'c'.repeat(64), text = new TextEncoder().encode('Test message');
  const packet = await sealContent(secret, server, 'chat', channel, 'request', author, text);
  assert.deepEqual(await openContent(secret, server, 'chat', channel, 'request', author, packet), text);
  const edit = await sealContent(secret, server, 'chat', channel, 'request', author, text);
  assert.notEqual(edit.nonce, packet.nonce);
  await assert.rejects(openContent(secret, server, 'chat', channel, 'other', author, packet));
  await assert.rejects(openContent(secret, server, 'chat', channel, 'request', 'd'.repeat(64), packet));
  await assert.rejects(openContent(secret, server, 'chat', 'd'.repeat(32), 'request', author, packet));
  await assert.rejects(openContent(secret, server, 'chat', channel, 'request', author, { ...packet, version: 1 }));
});
