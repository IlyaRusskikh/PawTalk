const { createHash, createPublicKey, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { validRecipientKey } = require('./protected-recipient-key.cjs');

const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

function fixed(value, size, encoding, invalid) {
  const length = encoding === 'base64url' ? Math.ceil(size * 4 / 3) : 4 * Math.ceil(size / 3);
  if (typeof value !== 'string' || value.length !== length) throw invalid();
  const raw = Buffer.from(value, encoding);
  if (raw.length !== size || raw.toString(encoding) !== value) throw invalid();
  return raw;
}

function verifySignature(rawKey, signature, frame, invalid) {
  const key = createPublicKey({ key: Buffer.concat([spkiPrefix, rawKey]), format: 'der', type: 'spki' });
  if (!verify(null, frame, key, signature)) throw invalid();
}

function verifyInviteApplicant(trust, admission) {
  const invalid = () => fail('INVALID_PROTECTED_INVITE_PROOF');
  const { Claim: claim, CutoverDigest: cutover } = admission ?? {};
  if (!claim || !hex(cutover, 64) || cutover !== trust.cutoverDigest ||
      !hex(claim.inviteId, 32) || !hex(claim.operationId, 32) || !validRecipientKey(claim.agreementKey) ||
      typeof claim.nickname !== 'string' || !claim.nickname.length || [...claim.nickname].length > 32 ||
      /[\p{Cc}\p{Cs}]/u.test(claim.nickname) || claim.nickname.trim() !== claim.nickname) throw invalid();
  const claims = [[claim.invitePublicKey, claim.inviteSignature], [claim.profilePublicKey, claim.profileSignature],
    [claim.devicePublicKey, claim.deviceSignature]];
  const keys = claims.map(([key]) => fixed(key, 32, 'base64url', invalid));
  if (new Set(claims.map(([key]) => key)).size !== 3) throw invalid();
  const frame = signatureFrame('pawtalk-protected-invite-redeem-v1', trust.serverId, cutover, claim.inviteId, claim.operationId,
    claim.invitePublicKey, claim.profilePublicKey, claim.devicePublicKey, claim.agreementKey, claim.nickname);
  for (const [index, [, signature]] of claims.entries()) {
    verifySignature(keys[index], fixed(signature, 64, 'base64url', invalid), frame, invalid);
  }
  const [tokenHash, profileId, deviceId] = keys.map(digest);
  return { tokenHash, profileId, deviceId, agreementKey: claim.agreementKey };
}

function verifyInviteIssuanceTranscript(trust, issuance, inviteId, tokenHash, rawKey) {
  const invalid = () => fail('INVALID_PROTECTED_INVITE_ISSUER');
  const { Issuer, PolicyDigest, PolicyRevision, RequestedExpiry, CreatedAt, ExpiresAt, AcceptedAt, MaxUses, Signature } = issuance ?? {};
  if (!hex(inviteId, 32) || !hex(tokenHash, 64) || !hex(Issuer?.ProfileID, 64) || !hex(Issuer?.DeviceID, 64) ||
      !hex(PolicyDigest, 64) || !positive(PolicyRevision) || !positive(CreatedAt) || !hex(rawKey, 64) ||
      !Number.isSafeInteger(RequestedExpiry) || RequestedExpiry < 0 || !positive(ExpiresAt) ||
      ExpiresAt > 8_640_000_000_000_000 || ExpiresAt !== (RequestedExpiry || CreatedAt + 86_400_000) ||
      !positive(AcceptedAt) || AcceptedAt < CreatedAt || AcceptedAt >= ExpiresAt ||
      !Number.isSafeInteger(MaxUses) || MaxUses < 0 || digest(Buffer.from(rawKey, 'hex')) !== Issuer.DeviceID) throw invalid();
  const frame = signatureFrame('pawtalk-protected-invite-v1', trust.serverId, Issuer.ProfileID, Issuer.DeviceID,
    PolicyDigest, inviteId, tokenHash, String(RequestedExpiry), String(MaxUses));
  verifySignature(Buffer.from(rawKey, 'hex'), fixed(Signature, 64, 'base64', invalid), frame, invalid);
}

function verifyScopedInviteReceipt(trust, draft) {
  const invalid = () => fail('INVALID_PROTECTED_INVITE_PROOF');
  const { revision, previousDigest, resultDigest, projectionRoot, digest: head, operationId, actor, admission, signature } = draft ?? {};
  const { Claim: claim, Issuance: issuance } = admission ?? {};
  if (!positive(revision) || ![previousDigest, resultDigest, projectionRoot, head, actor?.ProfileID, actor?.DeviceID].every(value => hex(value, 64)) ||
      !hex(operationId, 32) || !claim || !issuance?.Issuer) throw invalid();
  const raw = fixed(admission.ServerKey, 32, 'base64url', invalid);
  if (digest(raw).slice(0, 32) !== trust.serverId) throw invalid();
  const frame = signatureFrame('pawtalk-protected-invite-scoped-receipt-v1', trust.serverId, String(revision), previousDigest,
    resultDigest, projectionRoot, head, operationId, actor.ProfileID, actor.DeviceID, admission.CutoverDigest, admission.ServerKey,
    claim.inviteId, claim.operationId, claim.invitePublicKey, claim.profilePublicKey, claim.devicePublicKey,
    claim.agreementKey, claim.nickname, claim.inviteSignature, claim.profileSignature, claim.deviceSignature,
    issuance.Issuer.ProfileID, issuance.Issuer.DeviceID, String(issuance.PolicyRevision), issuance.PolicyDigest,
    String(issuance.RequestedExpiry), String(issuance.CreatedAt), String(issuance.ExpiresAt), String(issuance.AcceptedAt),
    String(issuance.MaxUses), issuance.Signature);
  verifySignature(raw, fixed(signature, 64, 'base64', invalid), frame, invalid);
}

module.exports = { verifyInviteApplicant, verifyInviteIssuanceTranscript, verifyScopedInviteReceipt };
