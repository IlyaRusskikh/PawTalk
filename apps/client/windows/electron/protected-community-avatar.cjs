const { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, sign, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { openKeyPackage, sealKeyPackage } = require('./protected-epoch-packages.cjs');
const { verifyAttestedProfileRoleAuthority, verifyProfileAgreementKey, verifyProfileSigningKey } = require('./protected-policy-profile-ranks.cjs');

const maxAvatarBytes = 12_000;
const ed25519Header = Buffer.from('302a300506032b6570032100', 'hex');
const hex = (value, size) => typeof value === 'string' && value.length === size && /^[0-9a-f]+$/.test(value);
const invalid = () => Object.assign(new Error('INVALID_PROTECTED_AVATAR'), { code: 'INVALID_PROTECTED_AVATAR' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rawKey = key => createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);

function binding({ serverId, revision, operationId, policyHead, profileId, deviceId, scope }) {
  if (!hex(serverId, 32) || !hex(operationId, 32) || ![policyHead, profileId, deviceId].every(value => hex(value, 64)) ||
      !Number.isSafeInteger(revision) || revision < 2 || (scope !== undefined && scope !== 'profile')) throw invalid();
  return [serverId, String(revision), operationId, policyHead, profileId, deviceId, ...(scope ? [scope] : [])];
}

function decode(value, min, max = min) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(max / 3)) throw invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < min || bytes.length > max || bytes.toString('base64') !== value) throw invalid();
  return bytes;
}

const keyCommitment = key => createHash('sha256').update('pawtalk-community-avatar-key-v1\0').update(key).digest('hex');
const contentFrame = (fields, commitment) => signatureFrame('pawtalk-community-avatar-content-v1', ...fields, commitment);
const authorFrame = (fields, commitment, nonce, ciphertext) => signatureFrame('pawtalk-community-avatar-signature-v1',
  ...fields, commitment, nonce.toString('base64url'), hash(ciphertext));

function recipientFrame(fields, signature, { id, publicKey, kind = 'device' }) {
  if (!hex(id, 64) || !hex(publicKey, 64) || !['device', 'recovery'].includes(kind)) throw invalid();
  const domain = kind === 'recovery' ? 'pawtalk-community-avatar-recovery-v1' : 'pawtalk-community-avatar-device-v1';
  return signatureFrame(domain, ...fields, hash(signature), id, publicKey);
}

function wrapKey(fields, signature, secret, recipient) {
  const info = recipientFrame(fields, signature, recipient);
  return sealKeyPackage(secret, Buffer.from(recipient.publicKey, 'hex'), info).toString('base64');
}

// Callers must validate recipient keys against the verified community audience.
function sealCommunityAvatar(context, image, recipients, authorKey) {
  const fields = binding(context);
  if (!Buffer.isBuffer(image) || image.length < 1 || image.length > maxAvatarBytes ||
      authorKey?.asymmetricKeyType !== 'ed25519' || hash(rawKey(authorKey)) !== context.deviceId ||
      !Array.isArray(recipients) || recipients.length < 1 || recipients.length > 8192 ||
      recipients.some(recipient => !hex(recipient?.id, 64) || !hex(recipient?.publicKey, 64))) throw invalid();
  const ordered = [...recipients].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (ordered.some((recipient, index) => index > 0 && recipient.id === ordered[index - 1].id)) throw invalid();
  const secret = randomBytes(32);
  try {
    const commitment = keyCommitment(secret);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(contentFrame(fields, commitment));
    const ciphertext = Buffer.concat([cipher.update(image), cipher.final(), cipher.getAuthTag()]);
    const signature = sign(null, authorFrame(fields, commitment, nonce, ciphertext), authorKey);
    return {
      packet: { keyCommitment: commitment, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'),
        signature: signature.toString('base64') },
      packages: ordered.map(recipient => ({ id: recipient.id, ciphertext: wrapKey(fields, signature, secret, recipient) })),
    };
  } finally {
    secret.fill(0);
  }
}

function openAvatarKey(context, packet, keyPackage, recipient, privateKey, authorPublicKey) {
  const fields = binding(context);
  if (!hex(authorPublicKey, 64) || hash(Buffer.from(authorPublicKey, 'hex')) !== context.deviceId ||
      !hex(packet?.keyCommitment, 64) || keyPackage?.id !== recipient.id || privateKey?.asymmetricKeyType !== 'x25519' ||
      rawKey(privateKey).toString('hex') !== recipient.publicKey) throw invalid();
  const signer = createPublicKey({ key: Buffer.concat([ed25519Header, Buffer.from(authorPublicKey, 'hex')]),
    type: 'spki', format: 'der' });
  const nonce = decode(packet.nonce, 12);
  const ciphertext = decode(packet.ciphertext, 17, maxAvatarBytes + 16);
  const signature = decode(packet.signature, 64);
  if (!verify(null, authorFrame(fields, packet.keyCommitment, nonce, ciphertext), signer, signature)) throw invalid();
  let secret;
  try {
    secret = openKeyPackage(decode(keyPackage.ciphertext, 80), privateKey, Buffer.from(recipient.publicKey, 'hex'),
      recipientFrame(fields, signature, recipient));
    if (keyCommitment(secret) !== packet.keyCommitment) throw invalid();
    return { fields, nonce, ciphertext, signature, secret };
  } catch {
    secret?.fill(0);
    throw invalid();
  }
}

function openCommunityAvatar(context, packet, keyPackage, recipient, privateKey, authorPublicKey) {
  const { fields, nonce, ciphertext, secret } = openAvatarKey(context, packet, keyPackage, recipient, privateKey, authorPublicKey);
  let clear, last;
  try {
    const decipher = createDecipheriv('aes-256-gcm', secret, nonce);
    decipher.setAAD(contentFrame(fields, packet.keyCommitment));
    decipher.setAuthTag(ciphertext.subarray(-16));
    clear = decipher.update(ciphertext.subarray(0, -16));
    last = decipher.final();
    return Buffer.concat([clear, last]);
  } catch {
    throw invalid();
  } finally {
    clear?.fill(0);
    last?.fill(0);
    secret.fill(0);
  }
}

function rewrapCommunityAvatar(context, packet, keyPackage, holder, privateKey, authorPublicKey, target) {
  const { fields, signature, secret } = openAvatarKey(context, packet, keyPackage, holder, privateKey, authorPublicKey);
  try {
    return { id: target.id, ciphertext: wrapKey(fields, signature, secret, target) };
  } finally {
    secret.fill(0);
  }
}

function verifyCommunityAvatarAudience(attestation, audience, after = '') {
  const { policyRevision, policyHead, basis, recipients, next } = audience ?? {};
  if (!attestation || attestation.revision !== policyRevision || attestation.digest !== policyHead || !hex(policyHead, 64) || !basis ||
      !Array.isArray(recipients) || recipients.length > 16 || (next !== undefined && !recipients.length)) throw invalid();
  let previous = after;
  const keys = recipients.map(({ id, kind, profile, parts, key } = {}) => {
    if (!hex(id, 64) || id <= previous || !hex(profile?.profileId, 64)) throw invalid();
    const verified = verifyAttestedProfileRoleAuthority(attestation, { ...basis, profile }, profile.profileId, {}, parts);
    const publicKey = verifyProfileAgreementKey(verified.keyRoot, id, key, kind);
    previous = id;
    return { id, publicKey, kind };
  });
  if (next !== undefined && next !== previous) throw invalid();
  return keys;
}

function verifyCommunityAvatarPublisher(attestation, context, publisher) {
  const { device, basis, grants, grantsSalt } = publisher ?? {};
  if (!attestation || attestation.digest !== context?.policyHead || !basis || !device?.parts ||
      device.id !== context.deviceId || device.kind !== 'signing' || device.profile?.profileId !== context.profileId) throw invalid();
  if (context.scope === 'profile' && grants === null && grantsSalt === '') {
    const verified = verifyAttestedProfileRoleAuthority(attestation, { ...basis, profile: device.profile }, context.profileId, {}, device.parts);
    return verifyProfileSigningKey(verified.keyRoot, context.deviceId, device.key);
  }
  if (!Array.isArray(grants) || !hex(grantsSalt, 64)) throw invalid();
  const { grants: committedGrants, ...unopened } = device.parts;
  const verified = verifyAttestedProfileRoleAuthority(attestation, { ...basis, profile: device.profile }, context.profileId,
    { grants, grantsSalt }, unopened);
  if (!hex(committedGrants, 64) || (context.scope !== 'profile' && !verified.bypassesACL && !verified.grants.includes('server.edit'))) throw invalid();
  return verifyProfileSigningKey(verified.keyRoot, context.deviceId, device.key);
}

module.exports = { sealCommunityAvatar, openCommunityAvatar, rewrapCommunityAvatar, verifyCommunityAvatarAudience, verifyCommunityAvatarPublisher };
