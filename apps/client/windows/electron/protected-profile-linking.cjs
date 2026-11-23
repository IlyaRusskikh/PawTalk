const { createHash, createPublicKey, sign, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { validAuthorityKey } = require('./protected-scope-authority.cjs');

const signingHeader = Buffer.from('302a300506032b6570032100', 'hex');
const hex = (value, size) => typeof value === 'string' && value.length === size && /^[0-9a-f]+$/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => Object.assign(new Error('INVALID_PROTECTED_PROFILE_LINKING'), { code: 'INVALID_PROTECTED_PROFILE_LINKING' });
const own = (record, key) => record && Object.hasOwn(record, key) ? record[key] : undefined;
const maxDate = 8_640_000_000_000_000;

function proofBytes(value, size) {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3)) throw invalid();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== value) throw invalid();
  return bytes;
}

function consentContext(trust, draft, claim) {
  if (!hex(trust?.serverId, 32) || !hex(trust.cutoverDigest, 64) || claim?.CutoverDigest !== trust.cutoverDigest ||
      !hex(draft?.PreviousDigest, 64) || !hex(draft.OperationID, 32) ||
      !Number.isSafeInteger(claim.ExpiresAt) || claim.ExpiresAt < 1 || claim.ExpiresAt > maxDate) throw invalid();
  return [trust.serverId, trust.cutoverDigest, draft.PreviousDigest, draft.OperationID];
}

function profileLinkConsentFrame(trust, draft) {
  const { ID, ProfileLink } = draft?.ResourceChange ?? {};
  const context = consentContext(trust, draft, ProfileLink);
  const { PrimaryDeviceID, SecondaryProfileID, SecondaryDeviceID, ExpiresAt } = ProfileLink;
  if (draft.Action !== 'profile.link' || ![ID, PrimaryDeviceID, SecondaryProfileID, SecondaryDeviceID].every(value => hex(value, 64)) ||
      ID === SecondaryProfileID || PrimaryDeviceID === SecondaryDeviceID) throw invalid();
  return signatureFrame('pawtalk-protected-profile-link-consent-v1', ...context, ID, PrimaryDeviceID, SecondaryProfileID, SecondaryDeviceID,
    String(ExpiresAt));
}

function profileUnlinkConsentFrame(trust, actor, draft) {
  const { ID, ProfileUnlink } = draft?.ResourceChange ?? {};
  const context = consentContext(trust, draft, ProfileUnlink);
  if (draft.Action !== 'profile.unlink' || ![ID, actor?.ProfileID, actor?.DeviceID].every(value => hex(value, 64)) ||
      ID === actor.ProfileID) throw invalid();
  return signatureFrame('pawtalk-protected-profile-unlink-consent-v1', ...context, actor.ProfileID, actor.DeviceID, ID,
    String(ProfileUnlink.ExpiresAt));
}

function signConsent(frame, deviceId, privateKey) {
  if (privateKey?.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw invalid();
  const raw = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
  if (digest(raw) !== deviceId) throw invalid();
  return sign(null, frame, privateKey).toString('base64url');
}

function signProtectedProfileLinkConsent(trust, draft, participant, privateKey) {
  const frame = profileLinkConsentFrame(trust, draft);
  const { ID, ProfileLink: claim } = draft.ResourceChange;
  if (!(participant?.ProfileID === ID && participant.DeviceID === claim.PrimaryDeviceID) &&
      !(participant?.ProfileID === claim.SecondaryProfileID && participant.DeviceID === claim.SecondaryDeviceID)) throw invalid();
  return signConsent(frame, participant.DeviceID, privateKey);
}

function signProtectedProfileUnlinkConsent(trust, actor, draft, privateKey) {
  return signConsent(profileUnlinkConsentFrame(trust, actor, draft), actor.DeviceID, privateKey);
}

function policyProfileForDevice(snapshot, deviceId) {
  const device = own(snapshot?.PolicyDevices, deviceId);
  if (!device || device.Revoked || !own(snapshot.Members, device.ProfileID)?.Active || own(snapshot.ProfileBindings, device.ProfileID)) return;
  const origin = own(snapshot.ProfileDeviceOrigins, deviceId);
  if (origin !== undefined && own(snapshot.ProfileBindings, origin) !== device.ProfileID) return;
  return device.ProfileID;
}

function verifyDeviceConsent(frame, prior, profileId, deviceId, proof) {
  const device = own(prior?.PolicyDevices, deviceId);
  if (policyProfileForDevice(prior, deviceId) !== profileId || !validAuthorityKey(device?.PublicKey)) throw invalid();
  const raw = Buffer.from(device.PublicKey, 'hex');
  if (digest(raw) !== deviceId) throw invalid();
  const key = createPublicKey({ key: Buffer.concat([signingHeader, raw]), type: 'spki', format: 'der' });
  if (!verify(null, frame, key, proofBytes(proof, 64))) throw invalid();
}

function validCommittedProfileLinkTime(at, expiresAt) {
  return Number.isSafeInteger(at) && Number.isSafeInteger(expiresAt) && at > 0 && expiresAt > at && expiresAt <= maxDate;
}

function verifyProtectedProfileLinking(trust, actor, draft, priorSnapshot) {
  const change = draft?.ResourceChange;
  const linking = draft?.Action === 'profile.link';
  if (!change || Object.keys(change).length !== 2 || (!linking && draft?.Action !== 'profile.unlink')) throw invalid();
  const claim = linking ? change.ProfileLink : change.ProfileUnlink;
  const rebind = !linking && claim && Object.hasOwn(claim, 'GrantDeviceRebind');
  if (!claim || Object.keys(claim).length !== (linking ? 9 : rebind ? 6 : 5) ||
      (rebind && claim.GrantDeviceRebind !== true) || !validCommittedProfileLinkTime(claim.At, claim.ExpiresAt)) throw invalid();
  proofBytes(claim.ServerKey, 32);
  if (linking) {
    if (actor?.ProfileID !== change.ID || actor.DeviceID !== claim.PrimaryDeviceID) throw invalid();
    const frame = profileLinkConsentFrame(trust, draft);
    verifyDeviceConsent(frame, priorSnapshot, actor.ProfileID, actor.DeviceID, claim.PrimaryProof);
    verifyDeviceConsent(frame, priorSnapshot, claim.SecondaryProfileID, claim.SecondaryDeviceID, claim.SecondaryProof);
  } else {
    const frame = profileUnlinkConsentFrame(trust, actor, draft);
    verifyDeviceConsent(frame, priorSnapshot, actor.ProfileID, actor.DeviceID, claim.DeviceProof);
  }
}

module.exports = {
  profileLinkConsentFrame, profileUnlinkConsentFrame, signProtectedProfileLinkConsent, signProtectedProfileUnlinkConsent,
  verifyProtectedProfileLinking, validCommittedProfileLinkTime, policyProfileForDevice,
};
