const { createHash, createPublicKey, randomBytes, sign, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { sealKeyPackage, openKeyPackage } = require('./protected-epoch-packages.cjs');

const spkiEd25519 = Buffer.from('302a300506032b6570032100', 'hex');
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const invalid = cause => Object.assign(new Error('INVALID_PROTECTED_VOICE_KEY', { cause }), { code: 'INVALID_PROTECTED_VOICE_KEY' });

function voiceRosterDigest(recipients) {
  if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > 8192 ||
      recipients.some(recipient => !recipient || typeof recipient !== 'object')) throw invalid();
  const hash = createHash('sha256').update(signatureFrame('pawtalk-protected-voice-roster-v1', String(recipients.length)));
  const sessions = new Set(), profiles = new Set(), devices = new Set();
  for (const { sessionId, profileId, deviceId, publicKey } of [...recipients].sort((a, b) =>
    a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)) {
    if (!hex(sessionId, 32) || !hex(profileId, 64) || !hex(deviceId, 64) || !hex(publicKey, 64) ||
        sessions.has(sessionId) || profiles.has(profileId) || devices.has(deviceId)) throw invalid();
    sessions.add(sessionId);
    profiles.add(profileId);
    devices.add(deviceId);
    hash.update(signatureFrame(sessionId, profileId, deviceId, publicKey));
  }
  return hash.digest('hex');
}

function basisFields(basis) {
  const { serverId, channelId, binding, epochId, revision, policyDigest, rosterDigest, expiresAt } = basis ?? {};
  if (!hex(serverId, 32) || !hex(channelId, 32) || !hex(binding, 64) || !hex(epochId, 32) ||
      !positive(revision) || !hex(policyDigest, 64) || !hex(rosterDigest, 64) || !positive(expiresAt)) throw invalid();
  return [serverId, channelId, binding, epochId, String(revision), policyDigest, rosterDigest, String(expiresAt)];
}

function checkBasis(basis, recipients, now) {
  if (!positive(now) || basis.expiresAt <= now || basis.expiresAt > now + 60_000 ||
      basis.rosterDigest !== voiceRosterDigest(recipients)) {
    throw invalid();
  }
}

function verifyVoiceKeyBasis(basis, recipients, now, expected) {
  basisFields(basis);
  const { serverId, channelId, binding } = expected;
  if (basis.serverId !== serverId || basis.channelId !== channelId || basis.binding !== binding) throw invalid();
  checkBasis(basis, recipients, now);
}

function offerFrame(basis, author, commitment) {
  return signatureFrame('pawtalk-protected-voice-key-v1', ...basisFields(basis),
    author.sessionId, author.profileId, author.deviceId, commitment);
}

function packageFrame(basis, recipient, commitment) {
  return signatureFrame('pawtalk-protected-voice-package-v1', ...basisFields(basis),
    recipient.sessionId, recipient.profileId, recipient.deviceId, recipient.publicKey, commitment);
}

function secretCommitment(basis, secret) {
  return createHash('sha256').update(signatureFrame('pawtalk-protected-voice-secret-v1', ...basisFields(basis)))
    .update(secret).digest('hex');
}

// The roster and author must already have been checked against the current signed policy.
function createVoiceKeyOffer(basis, recipients, authorSession, signingKey, now = Date.now()) {
  checkBasis(basis, recipients, now);
  const author = recipients.find(recipient => recipient.sessionId === authorSession);
  if (!author || signingKey?.asymmetricKeyType !== 'ed25519') throw invalid();
  const actualDevice = createHash('sha256').update(createPublicKey(signingKey).export({ format: 'der', type: 'spki' }).subarray(-32))
    .digest('hex');
  if (actualDevice !== author.deviceId) throw invalid();
  const secret = randomBytes(32);
  try {
    const commitment = secretCommitment(basis, secret);
    const packages = Object.fromEntries(recipients.map(recipient => [recipient.sessionId,
      sealKeyPackage(secret, Buffer.from(recipient.publicKey, 'hex'), packageFrame(basis, recipient, commitment)).toString('base64')]));
    const signature = sign(null, offerFrame(basis, author, commitment), signingKey).toString('base64');
    return { basis, commitment, signature, packages };
  } catch (cause) {
    throw invalid(cause);
  } finally {
    secret.fill(0);
  }
}

function openVoiceKeyPackage(delivery, basis, recipients, recipientSession, signer, agreementKey, now = Date.now()) {
  checkBasis(basis, recipients, now);
  const { commitment, signature, ciphertext } = delivery ?? {};
  const recipient = recipients.find(entry => entry.sessionId === recipientSession);
  const author = recipients.find(entry => entry.sessionId === signer?.sessionId);
  if (!author || author.profileId !== signer.profileId || author.deviceId !== signer.deviceId || !hex(signer.key, 64) ||
      !recipient || agreementKey?.asymmetricKeyType !== 'x25519' ||
      createPublicKey(agreementKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') !== recipient.publicKey ||
      !hex(commitment, 64) || typeof signature !== 'string' || signature.length !== 88 ||
      typeof ciphertext !== 'string' || ciphertext.length !== 108) throw invalid();
  const rawSigner = Buffer.from(signer.key, 'hex');
  const signed = Buffer.from(signature, 'base64');
  const sealed = Buffer.from(ciphertext, 'base64');
  const key = createPublicKey({ key: Buffer.concat([spkiEd25519, rawSigner]), format: 'der', type: 'spki' });
  if (createHash('sha256').update(rawSigner).digest('hex') !== author.deviceId ||
      signed.length !== 64 || signed.toString('base64') !== signature ||
      sealed.length !== 80 || sealed.toString('base64') !== ciphertext ||
      !verify(null, offerFrame(basis, author, commitment), key, signed)) throw invalid();
  let secret;
  try {
    secret = openKeyPackage(sealed, agreementKey, Buffer.from(recipient.publicKey, 'hex'), packageFrame(basis, recipient, commitment));
  } catch (cause) {
    throw invalid(cause);
  }
  if (secretCommitment(basis, secret) !== commitment) {
    secret.fill(0);
    throw invalid();
  }
  return secret;
}

module.exports = { voiceRosterDigest, verifyVoiceKeyBasis, createVoiceKeyOffer, openVoiceKeyPackage };
