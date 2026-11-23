const { createHash, randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { verifyMigrationRecoveryCode } = require('./protected-migration-recovery.cjs');

const fail = code => Object.assign(new Error(code), { code });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hexID = (value, length) => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);

async function retryThrottled(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 2) throw error;
      if (error.code === 'RATE_LIMIT' || error.code === 'CHALLENGE_LIMIT') await delay(60000);
      else if (error.code === 'MIGRATION_IMPORT_BUSY') await delay(1000);
      else throw error;
    }
  }
}

function isNextRecord(kind, cursor, id) {
  if (kind === 'messages') {
    return /^[1-9][0-9]{0,18}$/.test(id) &&
      (id.length > cursor.length || (id.length === cursor.length && id > cursor));
  }
  return hexID(id, 32) && id > cursor;
}

async function loadMigrationArchiveKey(credentials, serverId, archiveSha256, channelId, boundKeyId) {
  const slot = `pawtalk:migration-archive:v1:${serverId}:${archiveSha256}:${channelId}`;
  const saved = await credentials.load(slot, { required: true });
  if (saved == null && boundKeyId) throw fail('MIGRATION_ARCHIVE_KEY_UNAVAILABLE');
  if (saved != null && !hexID(saved, 64)) throw fail('INVALID_LOCAL_MIGRATION_KEY');
  const secret = saved == null ? randomBytes(32) : Buffer.from(saved, 'hex');
  try {
    const keyId = digest(secret);
    if (boundKeyId && keyId !== boundKeyId) throw fail('MIGRATION_ARCHIVE_KEY_CONFLICT');
    if (saved == null) await credentials.save(slot, secret.toString('hex'));
    return { purpose: 'archive', channelId, generation: 1, secret, keyId };
  } catch (error) {
    secret.fill(0);
    throw error;
  }
}

async function runProtectedMigrationResume(client, serverId, archiveSha256) {
  const readProgress = () => retryThrottled(() => client.protectedMigrationProgress(serverId, archiveSha256));
  await readProgress(); // Confirm the frozen source before creating local keys.
  let archive;
  try {
    for (const kind of ['messages', 'attachments', 'polls']) {
      let cursor = '';
      do {
        const limit = kind === 'attachments' ? 1 : 64;
        const page = await retryThrottled(() => client.readProtectedMigrationHistory(serverId, { kind, cursor, limit, archiveSha256 }));
        let previous = cursor;
        for (const record of page.records) {
          const { channelId } = record.metadata;
          const boundKeyId = record.archiveKeyId;
          if (!isNextRecord(kind, previous, record.id) || !hexID(channelId, 32) ||
              (boundKeyId !== undefined && !hexID(boundKeyId, 64)) ||
              (record.imported !== undefined && typeof record.imported !== 'boolean') ||
              (record.imported && !boundKeyId)) throw fail('INVALID_MIGRATION_PAGE');
          previous = record.id;
          if (archive?.channelId !== channelId) {
            archive?.secret.fill(0);
            archive = await loadMigrationArchiveKey(client.credentials, serverId, archiveSha256, channelId, boundKeyId);
          } else if (boundKeyId && archive.keyId !== boundKeyId) {
            throw fail('MIGRATION_ARCHIVE_KEY_CONFLICT');
          }
          if (record.imported) continue;
          const packet = await client.reencryptProtectedMigrationRecord(serverId, { archiveSha256, archive, kind, record });
          await retryThrottled(() => client.submitProtectedMigrationRecord(serverId, packet));
        }
        cursor = page.next;
      } while (cursor);
    }
    const progress = await readProgress();
    if (!progress.complete) throw fail('MIGRATION_IMPORT_INCOMPLETE');
    return progress;
  } finally {
    archive?.secret.fill(0);
  }
}

async function runProtectedMigrationRecoveryArchive(client, serverId, archiveSha256, code) {
  const readPolicy = () => retryThrottled(() => client.protectedMigrationPolicyDraft(serverId, archiveSha256));
  const { ownerProfileId, ownerRecovery: recovery } = await readPolicy();
  if (!recovery) throw fail('MIGRATION_RECOVERY_NOT_ENROLLED');
  verifyMigrationRecoveryCode(code, serverId, ownerProfileId, recovery);

  let cursor = '';
  do {
    const page = await retryThrottled(() => client.pendingProtectedMigrationRecoveryArchive(serverId, { archiveSha256, cursor }));
    if (page.recoveryId !== recovery.recoveryId) throw fail('MIGRATION_RECOVERY_IDENTITY_CHANGED');
    for (const { channelId, keyId } of page.keys) {
      const archive = await loadMigrationArchiveKey(client.credentials, serverId, archiveSha256, channelId, keyId);
      try {
        await retryThrottled(() => client.stageProtectedMigrationRecoveryArchive(serverId, {
          archiveSha256, ownerProfileId, code, recovery, archive,
        }));
      } finally {
        archive.secret.fill(0);
      }
    }
    cursor = page.next;
  } while (cursor);

  const policy = await readPolicy();
  if (policy.ownerProfileId !== ownerProfileId || policy.ownerRecovery?.recoveryId !== recovery.recoveryId ||
      policy.ownerRecovery.agreementKey !== recovery.agreementKey || policy.ownerRecovery.signingKey !== recovery.signingKey) {
    throw fail('MIGRATION_RECOVERY_IDENTITY_CHANGED');
  }
  const coverage = policy.ownerRecoveryArchive;
  if (!Number.isSafeInteger(coverage?.stagedKeys) || coverage.stagedKeys < 0 || coverage.confirmedPackages !== coverage.stagedKeys) {
    throw fail('MIGRATION_RECOVERY_ARCHIVE_INCOMPLETE');
  }
  return coverage;
}

module.exports = { runProtectedMigrationResume, runProtectedMigrationRecoveryArchive, loadMigrationArchiveKey, retryThrottled };
