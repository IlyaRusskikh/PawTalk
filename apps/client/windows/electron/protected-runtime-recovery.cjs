const { createHash, createHmac, createPublicKey, diffieHellman, sign, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { deriveRecoveryIdentity, recoveryIdentityId } = require('./protected-migration-recovery.cjs');
const { recoveryPackageOpeningFrame } = require('./protected-epoch-packages.cjs');

const ed25519Header = Buffer.from('302a300506032b6570032100', 'hex');
const x25519Header = Buffer.from('302a300506032b656e032100', 'hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const invalid = () => Object.assign(new Error('INVALID_PROTECTED_RECOVERY_PROOF'), { code: 'INVALID_PROTECTED_RECOVERY_PROOF' });

function publicKey(header, key) {
  return createPublicKey({ key: Buffer.concat([header, Buffer.from(key, 'hex')]), type: 'spki', format: 'der' });
}

function proofBytes(value, size) {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== value) throw invalid();
  return bytes;
}

function enrollmentFrame(serverId, actor, operationId, policyHead, recovery) {
  const { CutoverDigest, Nonce, ExpiresAt, RecoveryID, SigningKey, AgreementKey, ServerAgreementKey } = recovery;
  if (!hex(serverId, 32) || !hex(operationId, 32) ||
      ![CutoverDigest, actor.ProfileID, actor.DeviceID, policyHead, Nonce, RecoveryID, SigningKey, AgreementKey, ServerAgreementKey]
        .every(value => hex(value, 64)) || SigningKey === AgreementKey || SigningKey === '0'.repeat(64) ||
      !Number.isSafeInteger(ExpiresAt) || ExpiresAt < 1 || ExpiresAt > 8_640_000_000_000_000 ||
      recoveryIdentityId(serverId, actor.ProfileID, SigningKey, AgreementKey) !== RecoveryID) throw invalid();
  const signerId = digest(Buffer.from(SigningKey, 'hex'));
  if (signerId === actor.ProfileID || signerId === actor.DeviceID) throw invalid();
  return signatureFrame('pawtalk-protected-recovery-enrollment-v1', serverId, CutoverDigest, actor.ProfileID, actor.DeviceID,
    operationId, policyHead, Nonce, String(ExpiresAt), RecoveryID, SigningKey, AgreementKey, ServerAgreementKey);
}

function deviceFrame(frame, recoveryProof, agreementProof) {
  return signatureFrame('pawtalk-protected-recovery-device-v1', digest(frame), recoveryProof, agreementProof);
}

function prepareProtectedRecoveryEnrollment(connection, challenge, operationId, code, identity) {
  const { serverId, cutoverDigest, profileId, deviceId } = connection;
  if (challenge?.serverId !== serverId || challenge.cutoverDigest !== cutoverDigest || challenge.profileId !== profileId ||
      challenge.deviceId !== deviceId || identity?.deviceId !== deviceId || identity.device?.asymmetricKeyType !== 'ed25519' ||
      identity.device.type !== 'private' || digest(createPublicKey(identity.device).export({ type: 'spki', format: 'der' }).subarray(-32)) !== deviceId) {
    throw invalid();
  }
  const { nonce, expiresAt, policyHead, serverAgreementKey } = challenge;
  const { signing, agreement, signingKey, agreementKey, recoveryId } = deriveRecoveryIdentity(code, serverId, profileId);
  const claims = { RecoveryID: recoveryId, SigningKey: signingKey, AgreementKey: agreementKey, CutoverDigest: cutoverDigest,
    Nonce: nonce, ExpiresAt: expiresAt, ServerAgreementKey: serverAgreementKey };
  const frame = enrollmentFrame(serverId, { ProfileID: profileId, DeviceID: deviceId }, operationId, policyHead, claims);
  const shared = diffieHellman({ privateKey: agreement, publicKey: publicKey(x25519Header, serverAgreementKey) });
  try {
    const agreementProof = createHmac('sha256', shared).update(frame).digest('base64url');
    const recoveryProof = sign(null, frame, signing).toString('base64url');
    const deviceProof = sign(null, deviceFrame(frame, recoveryProof, agreementProof), identity.device).toString('base64url');
    return {
      proposal: { operationId, policyHead, nonce, expiresAt, signingKey, agreementKey, recoveryProof, agreementProof, deviceProof },
      claims: { ...claims, RecoveryProof: recoveryProof, AgreementProof: agreementProof, DeviceProof: deviceProof },
    };
  } finally {
    shared.fill(0);
  }
}

function verifyProtectedRecoveryEnrollment(trust, actor, draft, deviceKey) {
  const { ID, Recovery } = draft?.ResourceChange ?? {};
  if (draft?.Action !== 'recovery.enroll' || ID !== actor.ProfileID || !Recovery ||
      Recovery.CutoverDigest !== trust.cutoverDigest || !hex(deviceKey, 64) ||
      digest(Buffer.from(deviceKey, 'hex')) !== actor.DeviceID) throw invalid();
  const frame = enrollmentFrame(trust.serverId, actor, draft.OperationID, draft.PreviousDigest, Recovery);
  const { RecoveryProof, AgreementProof, DeviceProof, SigningKey } = Recovery;
  proofBytes(AgreementProof, 32);
  if (!verify(null, frame, publicKey(ed25519Header, SigningKey), proofBytes(RecoveryProof, 64)) ||
      !verify(null, deviceFrame(frame, RecoveryProof, AgreementProof), publicKey(ed25519Header, deviceKey), proofBytes(DeviceProof, 64))) {
    throw invalid();
  }
}

const confirmationItemFields = ['channelId', 'purpose', 'generation', 'epochDigest', 'packageDigest', 'openingKey', 'openingProof', 'recoveryProof'];
const maxConfirmationItems = 2000;
// The same canonical Ed25519 y-coordinates as the server's opening-key check.
const smallOrderOpeningKeys = new Set([
  '0'.repeat(64),
  '01' + '00'.repeat(31),
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ec' + 'ff'.repeat(30) + '7f',
]);

function validRecoveryEd25519Key(value) {
  if (!hex(value, 64)) return false;
  const y = Buffer.from(value, 'hex');
  y[31] &= 0x7f;
  if (y[31] === 0x7f && y[0] >= 0xed && y.subarray(1, 31).every(byte => byte === 0xff)) return false;
  return !smallOrderOpeningKeys.has(y.toString('hex'));
}

function recoveryConfirmationManifest(items) {
  if (!Array.isArray(items) || items.length > maxConfirmationItems) throw invalid();
  const hash = createHash('sha256').update(signatureFrame('pawtalk-protected-recovery-confirmation-items-v1'));
  let previous = '';
  for (const item of items) {
    const { channelId, purpose, generation, epochDigest, packageDigest, openingKey, openingProof, recoveryProof } = item ?? {};
    const identity = `${channelId}:${purpose}`;
    if (!hex(channelId, 32) || !['live', 'archive'].includes(purpose) || identity <= previous ||
        !Number.isSafeInteger(generation) || generation < 1 ||
        ![epochDigest, packageDigest].every(value => hex(value, 64)) || !validRecoveryEd25519Key(openingKey) ||
        Object.keys(item).length !== confirmationItemFields.length) throw invalid();
    proofBytes(openingProof, 64);
    proofBytes(recoveryProof, 64);
    hash.update(signatureFrame(channelId, purpose, String(generation), epochDigest, packageDigest, openingKey, openingProof, recoveryProof));
    previous = identity;
  }
  return hash.digest('hex');
}

function confirmationFrame(context, operationId, manifestDigest) {
  const { serverId, cutoverDigest, profileId, deviceId, policyHead, recoveryId, nonce, expiresAt } = context;
  if (!hex(serverId, 32) || !hex(operationId, 32) ||
      ![cutoverDigest, profileId, deviceId, policyHead, recoveryId, nonce, manifestDigest].every(value => hex(value, 64)) ||
      !Number.isSafeInteger(expiresAt) || expiresAt < 1 || expiresAt > 8_640_000_000_000_000) throw invalid();
  return signatureFrame('pawtalk-protected-recovery-confirmation-v1', serverId, cutoverDigest, profileId, deviceId,
    operationId, policyHead, recoveryId, nonce, String(expiresAt), manifestDigest);
}

function confirmationDeviceFrame(frame, recoveryProof) {
  return signatureFrame('pawtalk-protected-recovery-confirmation-device-v1', digest(frame), recoveryProof);
}

function verifyOpeningProofs(context, items, recoveryKey) {
  const usedOpeningKeys = new Set();
  for (const item of items) {
    const frame = recoveryPackageOpeningFrame({ ...context, ...item });
    if (usedOpeningKeys.has(item.openingKey) ||
        !verify(null, frame, publicKey(ed25519Header, item.openingKey), proofBytes(item.openingProof, 64)) ||
        !verify(null, frame, recoveryKey, proofBytes(item.recoveryProof, 64))) throw invalid();
    usedOpeningKeys.add(item.openingKey);
  }
}

function prepareProtectedRecoveryConfirmation(connection, challenge, operationId, recovery, identity, items) {
  const { serverId, cutoverDigest, profileId, deviceId } = connection;
  if (challenge?.serverId !== serverId || challenge.cutoverDigest !== cutoverDigest || challenge.profileId !== profileId ||
      challenge.deviceId !== deviceId || challenge.recoveryId !== recovery.recoveryId || identity?.deviceId !== deviceId ||
      identity.device?.type !== 'private' || identity.device.asymmetricKeyType !== 'ed25519' ||
      digest(createPublicKey(identity.device).export({ type: 'spki', format: 'der' }).subarray(-32)) !== deviceId) {
    throw invalid();
  }
  const { policyHead, recoveryId, nonce, expiresAt, challengeToken } = challenge;
  proofBytes(challengeToken, 32);
  const frame = confirmationFrame(challenge, operationId, recoveryConfirmationManifest(items));
  verifyOpeningProofs(challenge, items, createPublicKey(recovery.signing));
  const recoveryProof = sign(null, frame, recovery.signing).toString('base64url');
  const deviceProof = sign(null, confirmationDeviceFrame(frame, recoveryProof), identity.device).toString('base64url');
  return { operationId, policyHead, recoveryId, nonce, expiresAt, challengeToken, items, recoveryProof, deviceProof };
}

function verifyProtectedRecoveryConfirmation(trust, actor, draft, deviceKey, identity) {
  const { ID, RecoveryConfirmation } = draft?.ResourceChange ?? {};
  if (draft?.Action !== 'recovery.confirm' || ID !== actor.ProfileID || !RecoveryConfirmation ||
      Object.keys(draft.ResourceChange).length !== 2 || Object.keys(RecoveryConfirmation).length !== 8 ||
      RecoveryConfirmation.CutoverDigest !== trust.cutoverDigest || !hex(deviceKey, 64) ||
      digest(Buffer.from(deviceKey, 'hex')) !== actor.DeviceID ||
      identity?.ID !== RecoveryConfirmation.RecoveryID || !hex(identity.SigningKey, 64) || !hex(identity.AgreementKey, 64) ||
      recoveryIdentityId(trust.serverId, actor.ProfileID, identity.SigningKey, identity.AgreementKey) !== identity.ID) throw invalid();
  const { RecoveryID, CutoverDigest, Nonce, ExpiresAt, Items, RecoveryProof, DeviceProof } = RecoveryConfirmation;
  if (!Array.isArray(Items) || Items.length > maxConfirmationItems) throw invalid();
  const items = Items.map(item => {
    if (!item || Object.keys(item).length !== confirmationItemFields.length) throw invalid();
    return Object.fromEntries(confirmationItemFields.map(field =>
      [field, item[field === 'channelId' ? 'ChannelID' : field[0].toUpperCase() + field.slice(1)]]));
  });
  const context = { serverId: trust.serverId, cutoverDigest: CutoverDigest, profileId: actor.ProfileID, deviceId: actor.DeviceID,
    policyHead: draft.PreviousDigest, recoveryId: RecoveryID, nonce: Nonce, expiresAt: ExpiresAt };
  const recoveryKey = publicKey(ed25519Header, identity.SigningKey);
  const frame = confirmationFrame(context, draft.OperationID, recoveryConfirmationManifest(items));
  if (!verify(null, frame, recoveryKey, proofBytes(RecoveryProof, 64)) ||
      !verify(null, confirmationDeviceFrame(frame, RecoveryProof), publicKey(ed25519Header, deviceKey), proofBytes(DeviceProof, 64))) throw invalid();
  verifyOpeningProofs(context, items, recoveryKey);
}

module.exports = { prepareProtectedRecoveryEnrollment, verifyProtectedRecoveryEnrollment, recoveryConfirmationManifest,
  prepareProtectedRecoveryConfirmation, verifyProtectedRecoveryConfirmation, validRecoveryEd25519Key };
