const { createCipheriv, createDecipheriv, randomBytes, webcrypto } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');

const attachmentBlockSize = 1024 * 1024;
const attachmentMaxSize = 50 * attachmentBlockSize;
const invalidAttachment = () => Object.assign(Error('INVALID_ATTACHMENT'), { code: 'INVALID_ATTACHMENT' });

function attachmentAAD(serverId, channelId, author, { id, kind }) {
  return signatureFrame('pawtalk-protected-attachment-v1', serverId, channelId, author.ProfileID, author.DeviceID, id, kind);
}

function newAttachmentSecret() {
  return { key: randomBytes(32).toString('base64url'), nonce: randomBytes(12).toString('base64url') };
}

function decodeSecret(value, size) {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3)) throw invalidAttachment();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== value) throw invalidAttachment();
  return bytes;
}

function validateAttachmentSecret(secret) {
  decodeSecret(secret?.key, 32).fill(0);
  decodeSecret(secret?.nonce, 12);
  return { key: secret.key, nonce: secret.nonce };
}

function sealAttachment(serverId, channelId, author, ref, secret, bytes) {
  const key = decodeSecret(secret.key, 32);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, decodeSecret(secret.nonce, 12));
    cipher.setAAD(attachmentAAD(serverId, channelId, author, ref));
    return Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  } finally {
    key.fill(0);
  }
}

function openAttachment(serverId, channelId, author, ref, secret, encrypted) {
  const key = decodeSecret(secret.key, 32);
  let partial;
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, decodeSecret(secret.nonce, 12));
    cipher.setAAD(attachmentAAD(serverId, channelId, author, ref));
    cipher.setAuthTag(encrypted.subarray(-16));
    partial = cipher.update(encrypted.subarray(0, -16));
    return Buffer.concat([partial, cipher.final()]);
  } catch {
    throw invalidAttachment();
  } finally {
    key.fill(0);
    partial?.fill(0);
  }
}

async function openAttachmentAsync(serverId, channelId, author, ref, secret, encrypted) {
  if (encrypted.length <= 256 * 1024) return openAttachment(serverId, channelId, author, ref, secret, encrypted);
  const key = decodeSecret(secret.key, 32);
  try {
    const imported = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
    const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeSecret(secret.nonce, 12),
      additionalData: attachmentAAD(serverId, channelId, author, ref) }, imported, encrypted);
    return Buffer.from(plaintext);
  } catch {
    throw invalidAttachment();
  } finally {
    key.fill(0);
  }
}

module.exports = { attachmentBlockSize, attachmentMaxSize, newAttachmentSecret, validateAttachmentSecret, sealAttachment, openAttachment, openAttachmentAsync };
