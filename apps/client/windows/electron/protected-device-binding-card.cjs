const { serverURL } = require('./address.cjs');

const prefixes = { challenge: 'pawtalk-device-challenge-v1.', request: 'pawtalk-device-request-v1.' };
const isHex = (value, size) => typeof value === 'string' && value.length === size && /^[a-f0-9]+$/.test(value);
const error = () => Object.assign(Error('INVALID_DEVICE_BINDING_CARD'), { code: 'INVALID_DEVICE_BINDING_CARD' });

function fields(kind, value) {
  const { challenge } = value ?? {};
  const { serverId, cutoverDigest, profileId, approverDeviceId, policyHead, operationId, nonce, expiresAt, serverAgreementKey } = challenge ?? {};
  if (!isHex(serverId, 32) || !isHex(operationId, 32) ||
      ![cutoverDigest, profileId, approverDeviceId, policyHead, nonce, serverAgreementKey].every(field => isHex(field, 64)) ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || expiresAt > 8_640_000_000_000_000) throw error();
  const checked = { serverId, cutoverDigest, profileId, approverDeviceId, policyHead, operationId, nonce, expiresAt, serverAgreementKey };
  if (kind === 'challenge') {
    const { address, fingerprint, trust } = value;
    if (typeof address !== 'string' || address.length > 1900 || !address || address.includes('#') || address !== address.trim() ||
        !isHex(fingerprint, 64) || trust?.serverId !== serverId || trust.cutoverDigest !== cutoverDigest ||
        ![trust.anchorDigest, trust.ownerProfileId, trust.ownerDeviceId].every(field => isHex(field, 64))) throw error();
    try {
      if (!serverURL(address).startsWith('https://')) throw error();
    } catch { throw error(); }
    const { anchorDigest, ownerProfileId, ownerDeviceId } = trust;
    return { address, fingerprint, trust: { serverId, cutoverDigest, anchorDigest, ownerProfileId, ownerDeviceId }, challenge: checked };
  }
  const { operationId: proposalOperation, signingKey, agreementKey, applicantProof, agreementProof } = value.proposal ?? {};
  if (proposalOperation !== operationId || !isHex(signingKey, 64) || !isHex(agreementKey, 64) ||
      typeof applicantProof !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(applicantProof) ||
      typeof agreementProof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(agreementProof)) throw error();
  return { challenge: checked, proposal: { operationId, signingKey, agreementKey, applicantProof, agreementProof } };
}

function deviceBindingCard(kind, value) {
  const card = prefixes[kind] + Buffer.from(JSON.stringify(fields(kind, value)), 'utf8').toString('base64url');
  if (card.length > 4096) throw error();
  return card;
}

function openDeviceBindingCard(kind, card) {
  const prefix = prefixes[kind];
  if (typeof card !== 'string' || card.length > 4096 || !card.startsWith(prefix)) throw error();
  const encoded = card.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw error();
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (deviceBindingCard(kind, value) !== card) throw error();
    return value;
  } catch { throw error(); }
}

module.exports = { deviceBindingCard, openDeviceBindingCard };
