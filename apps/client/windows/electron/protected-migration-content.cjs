const { createCipheriv, createDecipheriv, createHash, createPublicKey, hkdfSync, randomBytes, sign, verify, webcrypto } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { openContentBytes } = require('../../../../shared/server-crypto.mjs');

const failures = code => Object.assign(new Error(code), { code });
const hexID = (value, length) => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);
const shortID = value => hexID(value, 32);
const longID = value => hexID(value, 64);
const messageID = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const time = value => Number.isSafeInteger(value) && value >= 0;
const optional = validate => value => value === null || validate(value);
const requestID = value => typeof value === 'string' && value.length >= 1 && Buffer.byteLength(value) <= 64;
const flag = value => value === 0 || value === 1;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ed25519Header = Buffer.from('302a300506032b6570032100', 'hex');

const relations = new Map([
  ['messages', { purpose: 'chat', id: 'messageId', resource: 'requestId', metadata: {
    messageId: messageID, channelId: shortID, authorProfileId: longID, authorDeviceId: longID,
    requestId: requestID, sentAt: time, editedAt: optional(time), keyId: longID,
  } }],
  ['attachments', { purpose: 'attachment', id: 'attachmentId', resource: 'attachmentId', metadata: {
    attachmentId: shortID, channelId: shortID, messageId: messageID, authorProfileId: longID,
    ownerDeviceId: longID, keyId: longID, createdAt: time,
  } }],
  ['polls', { purpose: 'chat', id: 'pollId', resource: 'resultRequestId', metadata: {
    pollId: shortID, messageId: messageID, resultMessageId: optional(messageID), channelId: shortID,
    authorProfileId: longID, authorDeviceId: longID, resultRequestId: shortID, keyId: longID,
    optionCount: value => Number.isInteger(value) && value >= 2 && value <= 10,
    multiple: flag, anonymous: flag, intermediate: flag, closesAt: time, closedAt: optional(time), createHash: longID,
  } }],
]);

function readSourceMetadata(kind, id, input) {
  const relation = relations.get(kind);
  if (!relation || !input || typeof input !== 'object' || Object.keys(input).length !== Object.keys(relation.metadata).length) {
    throw failures('INVALID_MIGRATION_RECORD');
  }
  const metadata = {};
  for (const [field, validate] of Object.entries(relation.metadata)) {
    if (!Object.hasOwn(input, field) || !validate(input[field])) throw failures('INVALID_MIGRATION_RECORD');
    metadata[field] = input[field];
  }
  if (metadata[relation.id] !== id) throw failures('INVALID_MIGRATION_RECORD');
  return { relation, metadata };
}

function decodeBase64(value, min, max, encoding = 'base64') {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4) throw failures('INVALID_MIGRATION_PACKET');
  const decoded = Buffer.from(value, encoding);
  if (decoded.length < min || decoded.length > max || decoded.toString(encoding) !== value) throw failures('INVALID_MIGRATION_PACKET');
  return decoded;
}

const maximumCiphertext = relation => relation.purpose === 'attachment' ? 50 * 1024 * 1024 + 16 : 12304;

function archiveFields(serverId, archiveSha256, archive, kind, id, metadata, sourceDigest) {
  if (!shortID(serverId) || !longID(archiveSha256) || !longID(sourceDigest) || archive?.purpose !== 'archive' ||
      archive.channelId !== metadata.channelId || !Number.isSafeInteger(archive.generation) || archive.generation < 1 ||
      !longID(archive.keyId) || !Buffer.isBuffer(archive.secret) || archive.secret.length !== 32 ||
      archive.keyId !== hash(archive.secret) || archive.keyId === metadata.keyId) throw failures('INVALID_MIGRATION_ARCHIVE_KEY');
  return [serverId, archiveSha256, archive.channelId, String(archive.generation), archive.keyId, kind, id, sourceDigest,
    ...Object.values(metadata).map(value => value === null ? '' : String(value))];
}

function deriveRecordKey(archive, serverId, fields) {
  return Buffer.from(hkdfSync('sha256', archive.secret, Buffer.from(serverId, 'hex'), signatureFrame('pawtalk-migrated-history-key-v1', ...fields), 32));
}

function signature(fields, deviceId, nonce, ciphertextDigest) {
  return signatureFrame('pawtalk-migrated-history-signature-v1', ...fields, deviceId, nonce, ciphertextDigest);
}

function removeLegacyQuoteExcerpt(plaintext) {
  let content;
  try {
    content = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    return plaintext;
  }
  if (!content?.reply || typeof content.reply !== 'object' || Array.isArray(content.reply)) return plaintext;
  // Rebuild the quote from the permitted original, even after an edit.
  const original = content.reply?.id;
  content.reply = Number.isSafeInteger(original) && original > 0 ? { id: original } : {};
  const normalized = Buffer.from(JSON.stringify(content));
  try {
    if (normalized.length > plaintext.length) throw failures('INVALID_MIGRATION_RECORD');
    // The import verifies source and migrated ciphertext have equal lengths.
    // JSON permits padding after the document, without retaining the excerpt.
    plaintext.fill(0x20);
    normalized.copy(plaintext);
    return plaintext;
  } finally {
    normalized.fill(0);
  }
}

async function reencryptMigratedHistoryRecord({ serverId, archiveSha256, legacySecret, archive, kind, record, identity }) {
  const id = record?.id;
  const { relation, metadata } = readSourceMetadata(kind, id, record?.metadata);
  const legacyNonce = decodeBase64(record.nonce, 12, 12);
  const legacyCiphertext = decodeBase64(record.ciphertext, 17, maximumCiphertext(relation));
  const sourceDigest = createHash('sha256').update(legacyNonce).update(legacyCiphertext).digest('hex');
  const fields = archiveFields(serverId, archiveSha256, archive, kind, id, metadata, sourceDigest);
  const { generation, keyId } = archive;
  const { device, deviceId } = identity;
  const migratorPublicKey = createPublicKey(device).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (device.asymmetricKeyType !== 'ed25519' || hash(migratorPublicKey) !== deviceId) throw failures('INVALID_MIGRATION_SIGNER');
  const key = deriveRecordKey(archive, serverId, fields);
  let plaintext;
  try {
    plaintext = await openContentBytes(legacySecret, serverId, relation.purpose, metadata.channelId,
      metadata[relation.resource], metadata.authorProfileId, { keyId: metadata.keyId, nonce: legacyNonce, ciphertext: legacyCiphertext });
    if (kind === 'messages') plaintext = removeLegacyQuoteExcerpt(plaintext);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(signatureFrame('pawtalk-migrated-history-content-v1', ...fields));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const encodedNonce = nonce.toString('base64');
    const proof = sign(null, signature(fields, deviceId, encodedNonce, hash(ciphertext)), device);
    return { version: 1, archiveSha256, kind, id, generation, keyId,
      metadata, sourceDigest, nonce: encodedNonce, ciphertext: ciphertext.toString('base64'),
      migratorDeviceId: deviceId, signature: proof.toString('base64url') };
  } finally {
    plaintext?.fill(0);
    key.fill(0);
  }
}

// The signed migration record and device key are separate from the original
// author metadata. The caller supplies the verified archive context and signer.
function migratedHistoryMaterial(packet, { serverId, archiveSha256, kind, id, archive, migratorPublicKey }, encrypted) {
  if (!packet || !archive || packet.version !== 1 || packet.archiveSha256 !== archiveSha256 || packet.kind !== kind || packet.id !== id ||
      packet.generation !== archive.generation || packet.keyId !== archive.keyId ||
      !Buffer.isBuffer(migratorPublicKey) || migratorPublicKey.length !== 32 || packet.migratorDeviceId !== hash(migratorPublicKey)) {
    throw failures('INVALID_MIGRATION_PACKET');
  }
  const { relation, metadata } = readSourceMetadata(kind, id, packet.metadata);
  const fields = archiveFields(serverId, archiveSha256, archive, kind, id, metadata, packet.sourceDigest);
  const nonce = decodeBase64(packet.nonce, 12, 12);
  if (encrypted !== undefined && (!Buffer.isBuffer(encrypted) || encrypted.length < 17 || encrypted.length > maximumCiphertext(relation))) {
    throw failures('INVALID_MIGRATION_PACKET');
  }
  const ciphertext = encrypted ?? decodeBase64(packet.ciphertext, 17, maximumCiphertext(relation));
  const proof = decodeBase64(packet.signature, 64, 64, 'base64url');
  const signer = createPublicKey({ key: Buffer.concat([ed25519Header, migratorPublicKey]), format: 'der', type: 'spki' });
  return { fields, nonce, ciphertext, signer, proof };
}

function openMigratedHistoryRecord(packet, context, encrypted) {
  const { fields, nonce, ciphertext, signer, proof } = migratedHistoryMaterial(packet, context, encrypted);
  if (!verify(null, signature(fields, packet.migratorDeviceId, packet.nonce, hash(ciphertext)), signer, proof)) throw failures('INVALID_MIGRATION_SIGNATURE');
  const key = deriveRecordKey(context.archive, context.serverId, fields);
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(signatureFrame('pawtalk-migrated-history-content-v1', ...fields));
    decipher.setAuthTag(ciphertext.subarray(-16));
    plaintext = decipher.update(ciphertext.subarray(0, -16));
    decipher.final();
    return plaintext;
  } catch (error) {
    plaintext?.fill(0);
    throw error;
  } finally {
    key.fill(0);
  }
}

async function openMigratedAttachment(packet, context, encrypted) {
  if (encrypted.length <= 256 * 1024) return openMigratedHistoryRecord(packet, context, encrypted);
  const { fields, nonce, ciphertext, signer, proof } = migratedHistoryMaterial(packet, context, encrypted);
  const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', ciphertext)).toString('hex');
  if (!verify(null, signature(fields, packet.migratorDeviceId, packet.nonce, digest), signer, proof)) throw failures('INVALID_MIGRATION_SIGNATURE');
  const key = deriveRecordKey(context.archive, context.serverId, fields);
  try {
    const imported = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
    const clear = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce,
      additionalData: signatureFrame('pawtalk-migrated-history-content-v1', ...fields) }, imported, ciphertext);
    return Buffer.from(clear);
  } finally {
    key.fill(0);
  }
}

module.exports = { reencryptMigratedHistoryRecord, openMigratedHistoryRecord, openMigratedAttachment };
