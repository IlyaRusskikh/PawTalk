const { createHash, createPublicKey, sign, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { channelSettingsDigest, channelSettingsProjectionVersion, verifyChannelOrderAuthority } = require('./protected-channel-policy-commitments.cjs');
const { validAuthorityKey } = require('./protected-scope-authority.cjs');

const spki = Buffer.from('302a300506032b6570032100', 'hex');
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => Object.assign(new Error('INVALID_PROTECTED_CHANNEL_SETTINGS_EDIT'), { code: 'INVALID_PROTECTED_CHANNEL_SETTINGS_EDIT' });

function protectedChannelSettingsEditFrame(trust, actor, basis, settings, operationId) {
  if (!hex(trust?.serverId, 32) || !hex(trust.cutoverDigest, 64) || !hex(actor?.ProfileID, 64) || !hex(actor.DeviceID, 64) ||
      !hex(operationId, 32) || !Number.isSafeInteger(basis?.revision) || basis.revision < 1 || !hex(basis.digest, 64) ||
      !hex(basis.channelId, 32) || typeof basis.categoryId !== 'string' || /\p{Cs}/u.test(basis.categoryId) || !settings) throw invalid();
  const previousSettingsDigest = basis.settingsDigest ?? channelSettingsDigest(basis.kind, basis.settings);
  if (!hex(previousSettingsDigest, 64)) throw invalid();
  return signatureFrame('pawtalk-protected-channel-settings-edit-v1', trust.serverId, trust.cutoverDigest, actor.ProfileID, actor.DeviceID,
    operationId, String(basis.revision), basis.digest, basis.channelId, basis.kind, basis.categoryId,
    previousSettingsDigest, channelSettingsDigest(basis.kind, settings));
}

function signProtectedChannelSettingsEdit(trust, actor, basis, settings, operationId, privateKey) {
  const frame = protectedChannelSettingsEditFrame(trust, actor, basis, settings, operationId);
  if (privateKey?.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519' ||
      digest(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32)) !== actor.DeviceID) throw invalid();
  return sign(null, frame, privateKey).toString('base64url');
}

function verifyProtectedChannelSettingsEdit(trust, actor, draft, previous, channel, signingKey) {
  const change = draft?.ResourceChange;
  const claim = change?.SettingsEdit;
  if (draft?.Action !== 'channel.settings.scoped' || !change || Object.keys(change).length !== 3 ||
      !claim || Object.keys(claim).length !== 4 || claim.CutoverDigest !== trust.cutoverDigest ||
      !(previous?.textProjectionVersion >= channelSettingsProjectionVersion) || !channel ||
      draft.PreviousDigest !== previous.digest || draft.Revision !== previous.revision + 1 ||
      !validAuthorityKey(signingKey) || !/^[A-Za-z0-9_-]{86}$/.test(claim.EditorProof) ||
      !/^[A-Za-z0-9_-]{43}$/.test(claim.ServerKey)) throw invalid();
  const proof = Buffer.from(claim.EditorProof, 'base64url');
  const rawKey = Buffer.from(signingKey, 'hex');
  const basis = { revision: previous.revision, digest: previous.digest, channelId: change.ID, kind: channel.Kind,
    categoryId: channel.CategoryID ?? '', settings: channel.Settings ?? null };
  if (proof.toString('base64url') !== claim.EditorProof || digest(rawKey) !== actor.DeviceID ||
      claim.PreviousSettingsDigest !== channelSettingsDigest(basis.kind, basis.settings)) throw invalid();
  const frame = protectedChannelSettingsEditFrame(trust, actor, basis, change.Settings, draft.OperationID);
  const key = createPublicKey({ key: Buffer.concat([spki, rawKey]), type: 'spki', format: 'der' });
  if (!verify(null, frame, key, proof)) throw invalid();
}

function verifyProtectedChannelSettingsReceipt(trust, actor, channelId, attestation, request, receipt, evidence) {
  if (evidence?.digest !== receipt.digest || evidence.revision !== receipt.revision ||
      evidence.revision !== attestation.revision + 1 || evidence.policyHead !== attestation.digest ||
      evidence.operationId !== request.operationId || evidence.editorProof !== request.editorProof) throw invalid();
  const basis = verifyChannelOrderAuthority(attestation, channelId, evidence.authority, actor);
  if (basis.settingsDigest !== request.previousSettingsDigest ||
      channelSettingsDigest(basis.kind, evidence.settings) !== channelSettingsDigest(basis.kind, request.settings)) throw invalid();
  const signingKey = createPublicKey({ key: Buffer.concat([spki, Buffer.from(evidence.authority.signingKey, 'hex')]),
    type: 'spki', format: 'der' });
  const frame = protectedChannelSettingsEditFrame(trust, actor, { ...basis, digest: attestation.digest }, evidence.settings, evidence.operationId);
  const signature = Buffer.from(evidence.editorProof, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== evidence.editorProof || !verify(null, frame, signingKey, signature)) throw invalid();
}

module.exports = { signProtectedChannelSettingsEdit, verifyProtectedChannelSettingsEdit, verifyProtectedChannelSettingsReceipt };
