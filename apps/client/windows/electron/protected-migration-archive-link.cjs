const { createCipheriv, createDecipheriv, createHash, createPublicKey, hkdfSync, randomBytes, sign, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const isID = (value, size) => typeof value === 'string' && value.length === size && /^[a-f0-9]+$/.test(value);
const invalid = () => Object.assign(new Error('INVALID_MIGRATION_HISTORY_LINK'), { code: 'INVALID_MIGRATION_HISTORY_LINK' });

function historyLinkContext(context, archiveSecret) {
  const { serverId, archiveSha256, anchorDigest, channelId, archiveKeyId, epochDigest, importedKeyId, deviceId } = context;
  if (!isID(serverId, 32) || !isID(channelId, 32) ||
      ![archiveSha256, anchorDigest, archiveKeyId, epochDigest, importedKeyId, deviceId].every(id => isID(id, 64)) ||
      !Buffer.isBuffer(archiveSecret) || archiveSecret.length !== 32 || digest(archiveSecret) !== archiveKeyId ||
      archiveKeyId === importedKeyId) throw invalid();
  const info = signatureFrame('pawtalk-migration-history-link-v1', serverId, archiveSha256, anchorDigest, channelId,
    archiveKeyId, epochDigest, importedKeyId, deviceId);
  const label = signatureFrame('pawtalk-migration-history-link-key-v1', digest(info));
  return { info, key: Buffer.from(hkdfSync('sha256', archiveSecret, Buffer.alloc(0), label, 32)) };
}

function proofFrame(info, packet) {
  return signatureFrame('pawtalk-migration-history-link-signature-v1', digest(info), digest(packet));
}

function sealMigrationHistoryLink(archiveSecret, importedSecret, context, device) {
  if (!Buffer.isBuffer(importedSecret) || importedSecret.length !== 32 || digest(importedSecret) !== context.importedKeyId) throw invalid();
  const { info, key } = historyLinkContext(context, archiveSecret);
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(info);
    const packet = Buffer.concat([nonce, cipher.update(importedSecret), cipher.final(), cipher.getAuthTag()]);
    return { ciphertext: packet.toString('base64url'), signature: sign(null, proofFrame(info, packet), device).toString('base64url') };
  } finally {
    key.fill(0);
  }
}

function openSignedMigrationHistoryLink(archiveSecret, context, link, publicKey) {
  const { info, key } = historyLinkContext(context, archiveSecret);
  let clear;
  try {
    if (!isID(publicKey, 64) || digest(Buffer.from(publicKey, 'hex')) !== context.deviceId ||
        typeof link?.ciphertext !== 'string' || link.ciphertext.length !== 80 ||
        typeof link.signature !== 'string' || link.signature.length !== 86) throw invalid();
    const packet = Buffer.from(link.ciphertext, 'base64url');
    const signature = Buffer.from(link.signature, 'base64url');
    if (packet.length !== 60 || packet.toString('base64url') !== link.ciphertext ||
        signature.length !== 64 || signature.toString('base64url') !== link.signature) throw invalid();
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'hex')]);
    const signer = createPublicKey({ key: der, type: 'spki', format: 'der' });
    if (!verify(null, proofFrame(info, packet), signer, signature)) throw invalid();
    const decipher = createDecipheriv('aes-256-gcm', key, packet.subarray(0, 12));
    decipher.setAAD(info);
    decipher.setAuthTag(packet.subarray(44));
    clear = decipher.update(packet.subarray(12, 44));
    const result = Buffer.concat([clear, decipher.final()]);
    if (digest(result) === context.importedKeyId) return result;
    result.fill(0);
    throw invalid();
  } finally {
    clear?.fill(0);
    key.fill(0);
  }
}

module.exports = { sealMigrationHistoryLink, openSignedMigrationHistoryLink };
