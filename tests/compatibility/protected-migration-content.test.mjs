import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { rootKeyID, sealContent } from '../../shared/server-crypto.mjs';

const require = createRequire(import.meta.url);
const { MembershipClient } = require('../../apps/client/windows/electron/membership-client.cjs');
const { openMigratedHistoryRecord } = require('../../apps/client/windows/electron/protected-migration-content.cjs');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const serverId = '1'.repeat(32), archiveSha256 = '2'.repeat(64), channelId = '3'.repeat(32);
const authorProfileId = '4'.repeat(64), authorDeviceId = '5'.repeat(64), messageId = '9007199254740993';

function makeClient(secret) {
  const seeds = { root: randomBytes(32).toString('hex'), device: randomBytes(32).toString('hex') };
  return new MembershipClient({
    credentials: { async load(key) {
      if (key === 'pawtalk:identity:v2') return JSON.stringify(seeds);
      if (key === 'pawtalk:server:v2:' + serverId && secret !== undefined) return JSON.stringify({ secret });
    } },
    fetcher() { assert.fail('record conversion used the network'); },
  });
}

async function source(legacySecret, id, kind, resourceId, metadata, plaintext) {
  const legacy = await sealContent(legacySecret, serverId, kind === 'attachments' ? 'attachment' : 'chat',
    metadata.channelId, resourceId, metadata.authorProfileId, plaintext);
  return { id, metadata: { ...metadata, keyId: legacy.keyId },
    nonce: Buffer.from(legacy.nonce, 'base64url').toString('base64'), ciphertext: Buffer.from(legacy.ciphertext, 'base64url').toString('base64') };
}

function archiveKey(secret = randomBytes(32)) {
  return { channelId, purpose: 'archive', generation: 1, secret, keyId: sha256(secret) };
}

test('migration re-encrypts API 2 messages, attachments and prepared poll results under the channel archive', async () => {
  const legacySecret = randomBytes(32).toString('hex'), archive = archiveKey();
  const client = makeClient(legacySecret);
  const identity = await client.identity();
  const migratorPublicKey = createPublicKey(identity.device).export({ format: 'der', type: 'spki' }).subarray(-32);
  const messageRequestId = '6'.repeat(32), attachmentId = '7'.repeat(32), pollId = '8'.repeat(32), resultRequestId = '9'.repeat(32);
  const fixtures = [
    { kind: 'messages', id: messageId, originalRequest: messageRequestId, plaintext: Buffer.from('{"text":"Старое сообщение"}'),
      metadata: { messageId, channelId, authorProfileId, authorDeviceId, requestId: messageRequestId, sentAt: 100, editedAt: 200 } },
    { kind: 'attachments', id: attachmentId, originalRequest: attachmentId, plaintext: randomBytes(2 * 1024 * 1024 + 31),
      metadata: { attachmentId, channelId, messageId, authorProfileId, ownerDeviceId: authorDeviceId, createdAt: 300 } },
    { kind: 'polls', id: pollId, originalRequest: resultRequestId, plaintext: Buffer.from('{"pollResult":true,"text":"Старый опрос"}'),
      metadata: { pollId, messageId, resultMessageId: null, channelId, authorProfileId, authorDeviceId, resultRequestId,
        optionCount: 2, multiple: 1, anonymous: 1, intermediate: 0, closesAt: 400, closedAt: null, createHash: 'a'.repeat(64) } },
  ];
  for (const fixture of fixtures) {
    const { kind, id, originalRequest, plaintext, metadata } = fixture;
    const record = await source(legacySecret, id, kind, originalRequest, metadata, plaintext);
    const packet = await client.reencryptProtectedMigrationRecord(serverId, { archiveSha256, archive, kind, record });
    assert.notEqual(packet.ciphertext, record.ciphertext);
    assert.equal(packet.migratorDeviceId, identity.deviceId);
    assert.equal(packet.metadata.authorProfileId, authorProfileId);
    assert.notEqual(packet.migratorDeviceId, authorDeviceId);
    assert.deepEqual(packet.metadata, record.metadata);
    const legacyBytes = Buffer.concat([Buffer.from(record.nonce, 'base64'), Buffer.from(record.ciphertext, 'base64')]);
    assert.equal(packet.sourceDigest, sha256(legacyBytes));
    assert.equal(Object.hasOwn(packet, 'plaintext'), false);
    const context = { serverId, archiveSha256, kind, id, archive, migratorPublicKey };
    assert.deepEqual(openMigratedHistoryRecord(packet, context), plaintext);
    assert.throws(() => openMigratedHistoryRecord(packet, { ...context, archive: archiveKey() }), { code: 'INVALID_MIGRATION_PACKET' });
    assert.throws(() => openMigratedHistoryRecord(packet, { ...context, archive: { ...archive, purpose: 'live' } }), { code: 'INVALID_MIGRATION_ARCHIVE_KEY' });
    assert.throws(() => openMigratedHistoryRecord({ ...packet, sourceDigest: 'f'.repeat(64) }, context), { code: 'INVALID_MIGRATION_SIGNATURE' });
  }
});

test('migration rejects a missing legacy key, swapped provenance, archive replay and untrusted signatures', async () => {
  const legacySecret = randomBytes(32).toString('hex'), archive = archiveKey();
  const kind = 'messages', id = messageId, requestId = '6'.repeat(32);
  const record = await source(legacySecret, id, kind, requestId,
    { messageId, channelId, authorProfileId, authorDeviceId, requestId, sentAt: 100, editedAt: null }, Buffer.from('source'));
  const input = { kind, record, archiveSha256, archive };
  const client = makeClient(legacySecret);
  await assert.rejects(makeClient(undefined).reencryptProtectedMigrationRecord(serverId, input), { code: 'MIGRATION_LEGACY_KEY_UNAVAILABLE' });
  await assert.rejects(makeClient(randomBytes(32).toString('hex')).reencryptProtectedMigrationRecord(serverId, input), /Invalid encrypted packet/);
  await assert.rejects(client.reencryptProtectedMigrationRecord(serverId, { ...input, record: {
    ...record, metadata: { ...record.metadata, requestId: 'f'.repeat(32) },
  } }));
  const stale = archiveKey(Buffer.from(legacySecret, 'hex'));
  assert.equal(stale.keyId, await rootKeyID(legacySecret));
  await assert.rejects(client.reencryptProtectedMigrationRecord(serverId, { ...input, archive: stale }), { code: 'INVALID_MIGRATION_ARCHIVE_KEY' });
  const packet = await client.reencryptProtectedMigrationRecord(serverId, input);
  const { device } = await client.identity();
  const migratorPublicKey = createPublicKey(device).export({ format: 'der', type: 'spki' }).subarray(-32);
  const context = { serverId, archiveSha256, kind, id, archive, migratorPublicKey };
  assert.throws(() => openMigratedHistoryRecord(packet, { ...context, archiveSha256: 'f'.repeat(64) }), { code: 'INVALID_MIGRATION_PACKET' });
  assert.throws(() => openMigratedHistoryRecord(packet, { ...context, migratorPublicKey: randomBytes(32) }), { code: 'INVALID_MIGRATION_PACKET' });
  assert.throws(() => openMigratedHistoryRecord({ ...packet, metadata: { ...packet.metadata, sentAt: 999 } }, context), { code: 'INVALID_MIGRATION_SIGNATURE' });
  const changedCiphertext = Buffer.from(packet.ciphertext, 'base64');
  changedCiphertext[0] ^= 1;
  assert.throws(() => openMigratedHistoryRecord({ ...packet, ciphertext: changedCiphertext.toString('base64') }, context), { code: 'INVALID_MIGRATION_SIGNATURE' });
});
