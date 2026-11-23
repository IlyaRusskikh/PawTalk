const { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes, sign, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { sealKeyPackage, openKeyPackage } = require('./protected-epoch-packages.cjs');

const ed25519SeedHeader = Buffer.from('302e020100300506032b657004220420', 'hex');
const x25519SeedHeader = Buffer.from('302e020100300506032b656e04220420', 'hex');
const x25519PublicHeader = Buffer.from('302a300506032b656e032100', 'hex');
const ed25519PublicHeader = Buffer.from('302a300506032b6570032100', 'hex');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const rawPublic = privateKey => createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);
const invalid = () => Object.assign(new Error('INVALID_MIGRATION_RECOVERY'), { code: 'INVALID_MIGRATION_RECOVERY' });

function createMigrationRecoveryCode() {
  return randomBytes(32).toString('base64url');
}

function deriveRecoveryKey(code, serverId, ownerProfileId, purpose, header) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw invalid();
  const secret = Buffer.from(code, 'base64url');
  try {
    if (secret.length !== 32 || secret.toString('base64url') !== code) throw invalid();
    const info = signatureFrame('pawtalk-recovery-seed-v1', serverId, ownerProfileId, purpose);
    const seed = Buffer.from(hkdfSync('sha256', secret, Buffer.from(serverId, 'hex'), info, 32));
    const material = Buffer.concat([header, seed]);
    try { return createPrivateKey({ key: material, type: 'pkcs8', format: 'der' }); }
    finally { seed.fill(0); material.fill(0); }
  } finally {
    secret.fill(0);
  }
}

function importPublicKey(header, key) {
  return createPublicKey({ key: Buffer.concat([header, Buffer.from(key, 'hex')]), type: 'spki', format: 'der' });
}

function recoveryIdentityId(serverId, profileId, signingKey, agreementKey) {
  if (!hex(serverId, 32) || ![profileId, signingKey, agreementKey].every(value => hex(value, 64))) throw invalid();
  return digest(signatureFrame('pawtalk-recovery-identity-v1', serverId, profileId, signingKey, agreementKey));
}

function deriveRecoveryIdentity(code, serverId, profileId) {
  if (!hex(serverId, 32) || !hex(profileId, 64)) throw invalid();
  const signing = deriveRecoveryKey(code, serverId, profileId, 'signing', ed25519SeedHeader);
  const agreement = deriveRecoveryKey(code, serverId, profileId, 'agreement', x25519SeedHeader);
  const signingKey = rawPublic(signing), agreementKey = rawPublic(agreement);
  return { signing, agreement, signingKey, agreementKey, recoveryId: recoveryIdentityId(serverId, profileId, signingKey, agreementKey) };
}

function verifyMigrationRecoveryCode(code, serverId, ownerProfileId, recovery) {
  const { recoveryId, signingKey, agreementKey } = deriveRecoveryIdentity(code, serverId, ownerProfileId);
  if (recovery.recoveryId !== recoveryId || recovery.signingKey !== signingKey || recovery.agreementKey !== agreementKey) throw invalid();
}

function proposeMigrationRecovery({ serverId, archiveSha256, ownerProfileId, nonce, serverAgreementKey, code, identity }) {
  if (!hex(serverId, 32) || ![archiveSha256, ownerProfileId, nonce, serverAgreementKey, identity?.deviceId].every(value => hex(value, 64))) throw invalid();
  const { signing, agreement, signingKey, agreementKey, recoveryId } = deriveRecoveryIdentity(code, serverId, ownerProfileId);
  const { deviceId, device } = identity;
  const serverKey = importPublicKey(x25519PublicHeader, serverAgreementKey);
  const shared = diffieHellman({ privateKey: agreement, publicKey: serverKey });
  try {
    const frame = signatureFrame('pawtalk-migration-owner-recovery-v1', serverId, archiveSha256, ownerProfileId,
      deviceId, nonce, signingKey, agreementKey, serverAgreementKey);
    const agreementProof = createHmac('sha256', shared).update(frame).digest('base64url');
    const recoveryProof = sign(null, frame, signing).toString('base64url');
    const deviceProof = sign(null, signatureFrame('pawtalk-migration-owner-recovery-device-v1', digest(frame),
      recoveryProof, agreementProof), device).toString('base64url');
    return { recoveryId, proposal: { archiveSha256, ownerProfileId, nonce, deviceId, signingKey, agreementKey, agreementProof, recoveryProof, deviceProof } };
  } finally {
    shared.fill(0);
  }
}

function recoveryPackageFrame(context) {
  const { serverId, archiveSha256, ownerProfileId, recoveryId, agreementKey, channelId, keyId, deviceId } = context;
  if (!hex(serverId, 32) || !hex(channelId, 32) ||
      ![archiveSha256, ownerProfileId, recoveryId, agreementKey, keyId, deviceId].every(value => hex(value, 64))) throw invalid();
  if (context.purpose !== undefined) {
    const { purpose, epochDigest, anchorDigest } = context;
    if (!['live', 'archive'].includes(purpose) || !hex(epochDigest, 64) || !hex(anchorDigest, 64)) throw invalid();
    return signatureFrame('pawtalk-migration-recovery-epoch-package-v1', serverId, archiveSha256, anchorDigest, ownerProfileId,
      recoveryId, agreementKey, channelId, purpose, '1', keyId, epochDigest, deviceId);
  }
  return signatureFrame('pawtalk-migration-recovery-archive-package-v1', serverId, archiveSha256, ownerProfileId,
    recoveryId, agreementKey, channelId, keyId, deviceId);
}

function archivePackageSignatureFrame(info, ciphertext) {
  return signatureFrame('pawtalk-migration-recovery-archive-signature-v1', digest(info), digest(ciphertext));
}

function sealMigrationRecoveryPackage(secret, context, device) {
  const info = recoveryPackageFrame(context);
  if (!Buffer.isBuffer(secret) || secret.length !== 32 || digest(secret) !== context.keyId ||
      device?.type !== 'private' || device.asymmetricKeyType !== 'ed25519' || digest(Buffer.from(rawPublic(device), 'hex')) !== context.deviceId) throw invalid();
  const ciphertext = sealKeyPackage(secret, Buffer.from(context.agreementKey, 'hex'), info);
  return {
    ciphertext: ciphertext.toString('base64url'),
    signature: sign(null, archivePackageSignatureFrame(info, ciphertext), device).toString('base64url'),
  };
}

function decodePackageField(value, size) {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== size || decoded.toString('base64url') !== value) throw invalid();
  return decoded;
}

function openMigrationRecoveryPackage(packet, context, code, signerKey) {
  const info = recoveryPackageFrame(context);
  if (!hex(signerKey, 64) || digest(Buffer.from(signerKey, 'hex')) !== context.deviceId) throw invalid();
  const ciphertext = decodePackageField(packet?.ciphertext, 80);
  const signature = decodePackageField(packet?.signature, 64);
  const signer = importPublicKey(ed25519PublicHeader, signerKey);
  if (!verify(null, archivePackageSignatureFrame(info, ciphertext), signer, signature)) throw invalid();
  const agreement = deriveRecoveryKey(code, context.serverId, context.ownerProfileId, 'agreement', x25519SeedHeader);
  if (rawPublic(agreement) !== context.agreementKey) throw invalid();
  const secret = openKeyPackage(ciphertext, agreement, Buffer.from(context.agreementKey, 'hex'), info);
  if (digest(secret) === context.keyId) return secret;
  secret.fill(0);
  throw invalid();
}

function confirmMigrationRecoveryPackage(packet, context, code, signerKey, recoverySigningKey) {
  const opened = openMigrationRecoveryPackage(packet, context, code, signerKey);
  opened.fill(0);
  const signer = deriveRecoveryKey(code, context.serverId, context.ownerProfileId, 'signing', ed25519SeedHeader);
  if (rawPublic(signer) !== recoverySigningKey) throw invalid();
  return sign(null, signatureFrame('pawtalk-migration-recovery-archive-confirmation-v1',
    digest(recoveryPackageFrame(context)), digest(decodePackageField(packet.ciphertext, 80))), signer).toString('base64url');
}

module.exports = { createMigrationRecoveryCode, proposeMigrationRecovery, sealMigrationRecoveryPackage,
  openMigrationRecoveryPackage, confirmMigrationRecoveryPackage, verifyMigrationRecoveryCode,
  deriveRecoveryIdentity, recoveryIdentityId };
