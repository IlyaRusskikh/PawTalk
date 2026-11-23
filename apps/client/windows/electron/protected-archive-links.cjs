const { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');

const hexID = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const position = value => Number.isSafeInteger(value) && value > 0;

function archiveContext(secret, source, target) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32 || !hexID(source?.serverId, 32) ||
      typeof source.channelId !== 'string' || !source.channelId.length || source.channelId.length > 64 ||
      !position(source.generation) || !hexID(source.keyId, 64) || !position(target?.Generation) ||
      !hexID(target.KeyID, 64) || !['archive', 'live'].includes(target.Purpose) ||
      target.Purpose === 'archive' && target.Generation !== source.generation - 1) {
    throw new Error('INVALID_ARCHIVE_LINK');
  }
  const sourceFields = [source.serverId, source.channelId, String(source.generation), source.keyId];
  const info = signatureFrame('pawtalk-archive-wrap-key-v1', ...sourceFields);
  const aad = signatureFrame('pawtalk-archive-link-v1', ...sourceFields, target.Purpose, String(target.Generation), target.KeyID);
  return { key: hkdfSync('sha256', secret, Buffer.alloc(0), info, 32), aad };
}

function sealArchiveLink(archiveSecret, source, target, targetSecret) {
  if (!Buffer.isBuffer(targetSecret) || targetSecret.length !== 32) throw new Error('INVALID_ARCHIVE_SECRET');
  const { key, aad } = archiveContext(archiveSecret, source, target);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([nonce, cipher.update(targetSecret), cipher.final(), cipher.getAuthTag()]);
  return { Purpose: target.Purpose, Generation: target.Generation, KeyID: target.KeyID, Ciphertext: ciphertext.toString('base64') };
}

// The digest and source must come from the verified archive epoch, not from
// unauthenticated fields in a response containing links.
function openArchiveLinks(archiveSecret, source, links, digest) {
  if (!Array.isArray(links) || links.length < 1 || links.length > 129 || !hexID(digest, 64)) {
    throw new Error('INVALID_ARCHIVE_LINKS');
  }
  const manifest = links.map(({ Purpose, Generation, KeyID, Ciphertext }) => {
    if (typeof Ciphertext !== 'string' || Ciphertext.length !== 80) throw new Error('INVALID_ARCHIVE_LINK');
    return { Purpose, Generation, KeyID, Ciphertext };
  });
  if (createHash('sha256').update(JSON.stringify(manifest)).digest('hex') !== digest) {
    throw new Error('INVALID_ARCHIVE_LINKS');
  }
  return manifest.map(link => {
    const { key, aad } = archiveContext(archiveSecret, source, link);
    const packet = Buffer.from(link.Ciphertext, 'base64');
    if (packet.length !== 60 || packet.toString('base64') !== link.Ciphertext) throw new Error('INVALID_ARCHIVE_LINK');
    const decipher = createDecipheriv('aes-256-gcm', key, packet.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(packet.subarray(44));
    return { purpose: link.Purpose, generation: link.Generation, keyId: link.KeyID,
      secret: Buffer.concat([decipher.update(packet.subarray(12, 44)), decipher.final()]) };
  });
}

module.exports = { sealArchiveLink, openArchiveLinks };
