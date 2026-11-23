const { createHash, createHmac, createPublicKey, diffieHellman, sign, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { recipientPublicKey, validRecipientKey } = require('./protected-recipient-key.cjs');
const { validAuthorityKey } = require('./protected-scope-authority.cjs');

const signingHeader = Buffer.from('302a300506032b6570032100', 'hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const invalid = () => Object.assign(new Error('INVALID_PROTECTED_DEVICE_BINDING'), { code: 'INVALID_PROTECTED_DEVICE_BINDING' });
const rawKey = key => createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const privateKey = (value, type) => value?.type === 'private' && value.asymmetricKeyType === type;

function decodeProof(value, size) {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3)) throw invalid();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== value) throw invalid();
  return bytes;
}

function signingKey(value) {
  if (!validAuthorityKey(value)) throw invalid();
  return createPublicKey({ key: Buffer.concat([signingHeader, Buffer.from(value, 'hex')]), type: 'spki', format: 'der' });
}

function applicantFrame(challenge, signingKey, agreementKey) {
  const { serverId, cutoverDigest, profileId, approverDeviceId, policyHead, operationId, nonce, expiresAt, serverAgreementKey } = challenge ?? {};
  if (!hex(serverId, 32) || !hex(operationId, 32) ||
      ![cutoverDigest, profileId, approverDeviceId, policyHead, nonce].every(value => hex(value, 64)) ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || expiresAt > 8_640_000_000_000_000 ||
      !validAuthorityKey(signingKey) || !validRecipientKey(agreementKey) || !validRecipientKey(serverAgreementKey) ||
      signingKey === agreementKey || digest(Buffer.from(signingKey, 'hex')) === approverDeviceId) throw invalid();
  return signatureFrame('pawtalk-protected-device-bind-v1', serverId, cutoverDigest, profileId, approverDeviceId,
    policyHead, operationId, nonce, String(expiresAt), serverAgreementKey, signingKey, agreementKey);
}

function approvalFrame(frame, applicantProof, agreementProof) {
  return signatureFrame('pawtalk-protected-device-bind-approval-v1', digest(frame), applicantProof, agreementProof);
}

function checkChallenge(expected, challenge) {
  if (!expected || !challenge || ['serverId', 'cutoverDigest', 'profileId', 'approverDeviceId']
    .some(field => !hex(expected[field], field === 'serverId' ? 32 : 64) || expected[field] !== challenge[field]) ||
      ['policyHead', 'operationId'].some(field => expected[field] !== undefined && expected[field] !== challenge[field])) throw invalid();
}

function verifyApplicant(challenge, proposal) {
  if (!proposal || proposal.operationId !== challenge?.operationId) throw invalid();
  const { signingKey: key, agreementKey, applicantProof, agreementProof } = proposal;
  const frame = applicantFrame(challenge, key, agreementKey);
  decodeProof(agreementProof, 32);
  if (!verify(null, frame, signingKey(key), decodeProof(applicantProof, 64))) throw invalid();
  return approvalFrame(frame, applicantProof, agreementProof);
}

function prepareProtectedDeviceBindingApplicant(expected, challenge, { device, agreement }) {
  checkChallenge(expected, challenge);
  if (!privateKey(device, 'ed25519') || !privateKey(agreement, 'x25519')) throw invalid();
  const signingKey = rawKey(device), agreementKey = rawKey(agreement);
  const frame = applicantFrame(challenge, signingKey, agreementKey);
  const { operationId, cutoverDigest, nonce, expiresAt, serverAgreementKey } = challenge;
  const shared = diffieHellman({ privateKey: agreement, publicKey: recipientPublicKey(serverAgreementKey) });
  try {
    const applicantProof = sign(null, frame, device).toString('base64url');
    const agreementProof = createHmac('sha256', shared).update(frame).digest('base64url');
    return {
      proposal: { operationId, signingKey, agreementKey, applicantProof, agreementProof },
      claims: { SigningKey: signingKey, AgreementKey: agreementKey, CutoverDigest: cutoverDigest, Nonce: nonce,
        ExpiresAt: expiresAt, ServerAgreementKey: serverAgreementKey, AgreementProof: agreementProof, ApplicantProof: applicantProof },
    };
  } finally {
    shared.fill(0);
  }
}

function prepareProtectedDeviceBindingApproval(expected, challenge, proposal, approverDevicePrivate) {
  checkChallenge(expected, challenge);
  if (!privateKey(approverDevicePrivate, 'ed25519') ||
      digest(Buffer.from(rawKey(approverDevicePrivate), 'hex')) !== expected.approverDeviceId) throw invalid();
  const frame = verifyApplicant(challenge, proposal);
  return { approverProof: sign(null, frame, approverDevicePrivate).toString('base64url') };
}

function checkProtectedDeviceBindingApplicant(expected, challenge, proposal) {
  checkChallenge(expected, challenge);
  verifyApplicant(challenge, proposal);
  return { deviceId: digest(Buffer.from(proposal.signingKey, 'hex')), expiresAt: challenge.expiresAt };
}

// The original challenge can be old at this point. We verify the stored
// transcript and the approval of a binding already committed by the server.
function verifyProtectedDeviceBindingReceipt(challenge, proposal, receipt) {
  const frame = verifyApplicant(challenge, proposal);
  const deviceId = digest(Buffer.from(proposal.signingKey, 'hex'));
  const { operationId, profileId, revision, digest: receiptDigest, agreementKey,
    approverSigningKey, approverProof, effectiveProfileId } = receipt ?? {};
  if (operationId !== challenge.operationId || profileId !== challenge.profileId || receipt?.deviceId !== deviceId ||
      !Number.isSafeInteger(revision) || revision < 2 || !hex(receiptDigest, 64) || agreementKey !== proposal.agreementKey ||
      (Object.hasOwn(receipt, 'effectiveProfileId') && !hex(effectiveProfileId, 64)) ||
      !hex(approverSigningKey, 64) || digest(Buffer.from(approverSigningKey, 'hex')) !== challenge.approverDeviceId ||
      !verify(null, frame, signingKey(approverSigningKey), decodeProof(approverProof, 64))) throw invalid();
  return { operationId, profileId, deviceId, revision, digest: receiptDigest, agreementKey, effectiveProfileId: effectiveProfileId ?? profileId };
}

function verifyProtectedDeviceBinding(trust, actor, draft, approverSigningKey) {
  const { ID, DeviceBinding } = draft?.ResourceChange ?? {};
  const rebind = DeviceBinding && Object.hasOwn(DeviceBinding, 'RebindAt');
  if (draft?.Action !== 'device.bind' || !actor || ID !== actor.ProfileID || !DeviceBinding ||
      Object.keys(draft.ResourceChange).length !== 2 || Object.keys(DeviceBinding).length !== (rebind ? 11 : 10) ||
      (rebind && (!Number.isSafeInteger(DeviceBinding.RebindAt) || DeviceBinding.RebindAt <= 0 ||
        DeviceBinding.RebindAt >= DeviceBinding.ExpiresAt)) ||
      DeviceBinding.CutoverDigest !== trust?.cutoverDigest || !hex(approverSigningKey, 64) ||
      digest(Buffer.from(approverSigningKey, 'hex')) !== actor.DeviceID) throw invalid();
  const { SigningKey, AgreementKey, Nonce, ExpiresAt, ServerAgreementKey, ApplicantProof, AgreementProof, ApproverProof, ServerKey } = DeviceBinding;
  decodeProof(ServerKey, 32);
  const challenge = { serverId: trust.serverId, cutoverDigest: trust.cutoverDigest, profileId: ID, approverDeviceId: actor.DeviceID,
    policyHead: draft.PreviousDigest, operationId: draft.OperationID, nonce: Nonce, expiresAt: ExpiresAt, serverAgreementKey: ServerAgreementKey };
  const frame = verifyApplicant(challenge, { operationId: draft.OperationID, signingKey: SigningKey, agreementKey: AgreementKey,
    applicantProof: ApplicantProof, agreementProof: AgreementProof });
  if (!verify(null, frame, signingKey(approverSigningKey), decodeProof(ApproverProof, 64))) throw invalid();
}

module.exports = {
  prepareProtectedDeviceBindingApplicant, prepareProtectedDeviceBindingApproval, checkProtectedDeviceBindingApplicant,
  verifyProtectedDeviceBindingReceipt, verifyProtectedDeviceBinding,
};
