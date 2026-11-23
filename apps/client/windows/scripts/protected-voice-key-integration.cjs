const assert = require('node:assert/strict');
const { createPrivateKey } = require('node:crypto');
const fs = require('node:fs');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { sealKeyPackage } = require('../electron/protected-epoch-packages.cjs');
const { voiceRosterSigners } = require('../electron/protected-policy-replay.cjs');
const { voiceRosterDigest, createVoiceKeyOffer, openVoiceKeyPackage } = require('../electron/protected-voice-keys.cjs');

const { basis, roster, authorSession, snapshot, now } = JSON.parse(fs.readFileSync(0, 'utf8'));
const ed25519Seed = '302e020100300506032b657004220420';
const x25519Seed = '302e020100300506032b656e04220420';
const privateKey = (prefix, value) => createPrivateKey({
  key: Buffer.concat([Buffer.from(prefix, 'hex'), Buffer.alloc(32, value)]), format: 'der', type: 'pkcs8',
});
const author = roster.find(recipient => recipient.sessionId === authorSession);
const reader = roster.find(recipient => recipient.sessionId !== authorSession);
const signers = voiceRosterSigners(snapshot, basis.channelId, roster, now);
const signer = signers.get(authorSession);
assert.equal(voiceRosterDigest([...roster].reverse()), basis.rosterDigest);
assert.throws(() => voiceRosterDigest([author, { ...reader, profileId: author.profileId }]));
assert.throws(() => voiceRosterSigners(snapshot, basis.channelId, [author, { ...reader, publicKey: author.publicKey }], now));
const deafened = structuredClone(snapshot);
deafened.VoiceRestrictions = { [basis.channelId]: { [reader.profileId]: { Deafened: true } } };
assert.throws(() => voiceRosterSigners(deafened, basis.channelId, roster, now));

const offer = createVoiceKeyOffer(basis, roster, authorSession, privateKey(ed25519Seed, 101), now);
const deliver = session => ({ ...offer, ciphertext: offer.packages[session] });
const ownerKey = privateKey(x25519Seed, 11);
const readerKey = privateKey(x25519Seed, 22);
const open = (delivery, keyBasis = basis, stamp = now) =>
  openVoiceKeyPackage(delivery, keyBasis, roster, reader.sessionId, signer, readerKey, stamp);
const ownerSecret = openVoiceKeyPackage(deliver(authorSession), basis, roster, authorSession, signer, ownerKey, now);
const readerSecret = open(deliver(reader.sessionId));
assert.equal(ownerSecret.length, 32);
assert.deepEqual(ownerSecret, readerSecret);
ownerSecret.fill(0);
readerSecret.fill(0);
assert.throws(() => open(deliver(authorSession)));
assert.throws(() => open(deliver(reader.sessionId), { ...basis, epochId: 'f'.repeat(32) }));
assert.throws(() => open(deliver(reader.sessionId), { ...basis, channelId: 'f'.repeat(32) }));
assert.throws(() => open(deliver(reader.sessionId), basis, basis.expiresAt));
const substituted = sealKeyPackage(Buffer.alloc(32, 3), Buffer.from(reader.publicKey, 'hex'),
  signatureFrame('pawtalk-protected-voice-package-v1', basis.serverId, basis.channelId, basis.binding, basis.epochId,
    String(basis.revision), basis.policyDigest, basis.rosterDigest, String(basis.expiresAt),
    reader.sessionId, reader.profileId, reader.deviceId, reader.publicKey, offer.commitment));
assert.throws(() => open({ ...deliver(reader.sessionId), ciphertext: substituted.toString('base64') }), /INVALID_PROTECTED_VOICE_KEY/);

fs.writeFileSync(1, JSON.stringify(offer));
