const { createHash, createHmac, createPublicKey, diffieHellman, sign, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { deriveRecoveryIdentity, recoveryIdentityId } = require('./protected-migration-recovery.cjs');
const { validRecoveryEd25519Key } = require('./protected-runtime-recovery.cjs');

const signingHeader = Buffer.from('302a300506032b6570032100', 'hex');
const agreementHeader = Buffer.from('302a300506032b656e032100', 'hex');
const raw = key => createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
const digest = value => createHash('sha256').update(value).digest('hex');
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const invalid = () => Object.assign(new Error('INVALID_PROTECTED_RECOVERY_DEVICE_PROOF'), { code: 'INVALID_PROTECTED_RECOVERY_DEVICE_PROOF' });

function decode(value, size) {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== value) throw invalid();
  return bytes;
}

function publicKey(header, bytes) {
  return createPublicKey({ key: Buffer.concat([header, bytes]), format: 'der', type: 'spki' });
}

function recoveryDeviceFrame({ serverId, cutoverDigest, profileId, deviceId, recoveryId, policyHead, operationId, nonce, expiresAt,
  signingKey, agreementKey }) {
  if (!hex(serverId, 32) || !hex(operationId, 32) ||
      ![cutoverDigest, profileId, deviceId, recoveryId, policyHead, nonce, signingKey, agreementKey].every(value => hex(value, 64)) ||
      !validRecoveryEd25519Key(signingKey) || signingKey === agreementKey || digest(Buffer.from(signingKey, 'hex')) !== deviceId ||
      !Number.isSafeInteger(expiresAt) || expiresAt < 1 || expiresAt > 8_640_000_000_000_000) throw invalid();
  return signatureFrame('pawtalk-protected-recovery-device-v1', serverId, cutoverDigest, profileId, deviceId, recoveryId,
    policyHead, operationId, nonce, String(expiresAt), signingKey, agreementKey);
}

function prepareProtectedRecoveryDevice(expected, challenge, operationId, codeOrRecovery, { device, agreement }) {
  const { serverId, cutoverDigest, profileId } = expected;
  if (challenge?.serverId !== serverId || challenge.cutoverDigest !== cutoverDigest || challenge.profileId !== profileId ||
      expected.policyHead !== undefined && challenge.policyHead !== expected.policyHead ||
      device?.type !== 'private' || device.asymmetricKeyType !== 'ed25519' ||
      agreement?.type !== 'private' || agreement.asymmetricKeyType !== 'x25519') throw invalid();
  const recovery = typeof codeOrRecovery === 'string' ? deriveRecoveryIdentity(codeOrRecovery, serverId, profileId) : codeOrRecovery;
  const { recoveryId, deviceId, policyHead, nonce, expiresAt, serverAgreementKey } = challenge;
  const signingKey = raw(device).toString('hex'), agreementKey = raw(agreement).toString('hex');
  if (recovery?.recoveryId !== recoveryId || recovery.signing?.type !== 'private' || recovery.signing.asymmetricKeyType !== 'ed25519' ||
      recovery.signingKey !== raw(recovery.signing).toString('hex') ||
      recoveryIdentityId(serverId, profileId, recovery.signingKey, recovery.agreementKey) !== recoveryId ||
      [recovery.signingKey, recovery.agreementKey].some(key => key === signingKey || key === agreementKey)) throw invalid();
  const frame = recoveryDeviceFrame({ serverId, cutoverDigest, profileId, deviceId, recoveryId, policyHead, operationId, nonce, expiresAt,
    signingKey, agreementKey });
  const serverKey = publicKey(agreementHeader, decode(serverAgreementKey, 32));
  const shared = diffieHellman({ privateKey: agreement, publicKey: serverKey });
  try {
    const recoveryProof = sign(null, frame, recovery.signing).toString('base64url');
    const deviceProof = sign(null, frame, device).toString('base64url');
    const agreementProof = createHmac('sha256', shared).update(frame).digest('base64url');
    return {
      proposal: { profileId, recoveryId, operationId, policyHead, nonce, expiresAt, signingKey, agreementKey, recoveryProof, agreementProof, deviceProof },
      claims: { RecoveryID: recoveryId, CutoverDigest: cutoverDigest, Nonce: nonce, ExpiresAt: expiresAt,
        SigningKey: signingKey, AgreementKey: agreementKey, RecoveryProof: recoveryProof, AgreementProof: agreementProof, DeviceProof: deviceProof },
    };
  } finally {
    shared.fill(0);
  }
}

function verifyProtectedRecoveryDevice(trust, actor, draft, recovery) {
  const { ID, RecoveryDevice } = draft?.ResourceChange ?? {};
  if (draft?.Action !== 'recovery.device' || ID !== actor.ProfileID || !RecoveryDevice ||
      RecoveryDevice.CutoverDigest !== trust.cutoverDigest || recovery?.ID !== RecoveryDevice.RecoveryID ||
      !hex(recovery.SigningKey, 64) || !hex(recovery.AgreementKey, 64) ||
      recoveryIdentityId(trust.serverId, ID, recovery.SigningKey, recovery.AgreementKey) !== recovery.ID) throw invalid();
  const { RecoveryID, CutoverDigest, Nonce, ExpiresAt, SigningKey, AgreementKey, RecoveryProof, AgreementProof, DeviceProof } = RecoveryDevice;
  const frame = recoveryDeviceFrame({ serverId: trust.serverId, cutoverDigest: CutoverDigest, profileId: ID, deviceId: actor.DeviceID,
    recoveryId: RecoveryID, policyHead: draft.PreviousDigest, operationId: draft.OperationID, nonce: Nonce, expiresAt: ExpiresAt,
    signingKey: SigningKey, agreementKey: AgreementKey });
  decode(AgreementProof, 32);
  if (!verify(null, frame, publicKey(signingHeader, Buffer.from(recovery.SigningKey, 'hex')), decode(RecoveryProof, 64)) ||
      !verify(null, frame, publicKey(signingHeader, Buffer.from(SigningKey, 'hex')), decode(DeviceProof, 64))) throw invalid();
}

module.exports = { prepareProtectedRecoveryDevice, verifyProtectedRecoveryDevice };
