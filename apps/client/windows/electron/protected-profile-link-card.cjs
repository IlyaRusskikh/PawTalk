const prefixes = { participant: 'pawtalk-profile-participant-v1.', link: 'pawtalk-profile-link-v1.' };
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);
const signature = value => typeof value === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value) &&
  Buffer.from(value, 'base64url').toString('base64url') === value;
const expiry = value => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
const invalid = () => Object.assign(Error('INVALID_PROFILE_LINK_CARD'), { code: 'INVALID_PROFILE_LINK_CARD' });

function participant(value) {
  const { profileId, deviceId, expiresAt, proof } = value ?? {};
  if (!hex(profileId, 64) || !hex(deviceId, 64) || !expiry(expiresAt) || !signature(proof)) throw invalid();
  return { profileId, deviceId, expiresAt, proof };
}

function cardFields(kind, value) {
  const { serverId, cutoverDigest } = value ?? {};
  if (!hex(serverId, 32) || !hex(cutoverDigest, 64)) throw invalid();
  if (kind === 'participant') return { serverId, cutoverDigest, participant: participant(value.participant) };
  const primary = participant(value.primary), secondary = participant(value.secondary);
  const { policyHead, operationId, expiresAt, primaryProof = '', secondaryProof = '' } = value;
  if (primary.profileId === secondary.profileId || primary.deviceId === secondary.deviceId || !hex(policyHead, 64) ||
      !hex(operationId, 32) || !expiry(expiresAt) || expiresAt > Math.min(primary.expiresAt, secondary.expiresAt) ||
      (primaryProof !== '' && !signature(primaryProof)) || (secondaryProof !== '' && !signature(secondaryProof))) throw invalid();
  return { serverId, cutoverDigest, primary, secondary, policyHead, operationId, expiresAt, primaryProof, secondaryProof };
}

function makeProfileLinkCard(kind, value) {
  return prefixes[kind] + Buffer.from(JSON.stringify(cardFields(kind, value))).toString('base64url');
}

function openProfileLinkCard(kind, card, connection) {
  const prefix = prefixes[kind];
  if (typeof card !== 'string' || card.length > 4096 || !card.startsWith(prefix)) throw invalid();
  try {
    const value = JSON.parse(Buffer.from(card.slice(prefix.length), 'base64url').toString('utf8'));
    if (makeProfileLinkCard(kind, value) !== card || value.serverId !== connection.serverId || value.cutoverDigest !== connection.cutoverDigest) {
      throw invalid();
    }
    return value;
  } catch { throw invalid(); }
}

function linkDraft(value) {
  return { Action: 'profile.link', OperationID: value.operationId, PreviousDigest: value.policyHead,
    ResourceChange: { ID: value.primary.profileId, ProfileLink: {
      CutoverDigest: value.cutoverDigest, PrimaryDeviceID: value.primary.deviceId, SecondaryProfileID: value.secondary.profileId,
      SecondaryDeviceID: value.secondary.deviceId, ExpiresAt: value.expiresAt,
    } } };
}

module.exports = { makeProfileLinkCard, openProfileLinkCard, linkDraft };
