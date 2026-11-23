import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { MembershipClient } = require('../../apps/client/windows/electron/membership-client.cjs');
const serverId = '1'.repeat(32), archiveSha256 = '2'.repeat(64), channelId = '3'.repeat(32);
const firstId = '9007199254740993', secondId = '9007199254740994';
const sha256 = value => createHash('sha256').update(value).digest('hex');

function fixture() {
  const persisted = new Map(), staged = new Map(), converted = [];
  let boundKeyId;
  let loseReply = true;
  const credentials = { async load(key) { return persisted.get(key); }, async save(key, value) { persisted.set(key, value); } };
  function connect(storage = credentials) {
    const client = new MembershipClient({ credentials: storage });
    client.protectedMigrationProgress = async (server, archive) => {
      assert.equal(server, serverId);
      assert.equal(archive, archiveSha256);
      return { complete: staged.size === 2, counts: { messages: { source: 2, imported: staged.size },
        attachments: { source: 0, imported: 0 }, polls: { source: 0, imported: 0 } } };
    };
    client.readProtectedMigrationHistory = async (server, { kind, cursor, archiveSha256: archive }) => {
      assert.equal(server, serverId);
      assert.equal(archive, archiveSha256);
      assert.equal(cursor, '');
      return { records: kind === 'messages' ? [firstId, secondId].map(id => ({
        id, metadata: { channelId }, archiveKeyId: boundKeyId, imported: staged.has(id),
      })) : [] };
    };
    client.reencryptProtectedMigrationRecord = async (server, { archive, record }) => {
      assert.equal(server, serverId);
      assert.equal(archive.keyId, sha256(archive.secret));
      assert.equal(persisted.values().next().value, archive.secret.toString('hex'), 'key must be saved before conversion');
      converted.push(record.id);
      return { id: record.id, keyId: archive.keyId };
    };
    client.submitProtectedMigrationRecord = async (server, packet) => {
      assert.equal(server, serverId);
      boundKeyId ??= packet.keyId;
      assert.equal(packet.keyId, boundKeyId);
      assert.equal(staged.has(packet.id), false, 'resume should skip an already committed packet');
      staged.set(packet.id, packet.keyId);
      if (loseReply) { loseReply = false; throw Error('reply lost after commit'); }
    };
    return client;
  }
  return { connect, converted, staged, credentials, persisted };
}

test('resuming after a lost response preserves the channel key and skips committed data', async () => {
  const { connect, converted, staged, persisted } = fixture();
  const first = connect();
  const inFlight = first.resumeProtectedMigrationHistory(serverId, archiveSha256);
  assert.equal(first.resumeProtectedMigrationHistory(serverId, archiveSha256), inFlight);
  await assert.rejects(first.resumeProtectedMigrationHistory(serverId, 'f'.repeat(64)), { code: 'MIGRATION_CHECKPOINT_CHANGED' });
  await assert.rejects(inFlight, /reply lost after commit/);
  const retainedKey = persisted.values().next().value;
  assert.equal(staged.size, 1);
  const resumed = await connect().resumeProtectedMigrationHistory(serverId, archiveSha256);
  assert.equal(resumed.complete, true);
  assert.deepEqual(converted, [firstId, secondId]);
  assert.deepEqual([...staged.values()], [sha256(Buffer.from(retainedKey, 'hex')), sha256(Buffer.from(retainedKey, 'hex'))]);
});

test('resume fails closed on a missing or mismatched key or failed credential save', async () => {
  const { connect, staged, persisted } = fixture();
  await assert.rejects(connect({ async load() {}, async save() { throw Error('credential save failed'); } })
    .resumeProtectedMigrationHistory(serverId, archiveSha256), /credential save failed/);
  assert.equal(staged.size, 0);
  await assert.rejects(connect().resumeProtectedMigrationHistory(serverId, archiveSha256), /reply lost after commit/);
  const slot = persisted.keys().next().value;
  persisted.delete(slot);
  await assert.rejects(connect().resumeProtectedMigrationHistory(serverId, archiveSha256), { code: 'MIGRATION_ARCHIVE_KEY_UNAVAILABLE' });
  persisted.set(slot, 'f'.repeat(64));
  await assert.rejects(connect().resumeProtectedMigrationHistory(serverId, archiveSha256), { code: 'MIGRATION_ARCHIVE_KEY_CONFLICT' });
  assert.equal(staged.size, 1);
});
