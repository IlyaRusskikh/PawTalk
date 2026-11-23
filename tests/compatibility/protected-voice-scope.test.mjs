import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import frames from '../../shared/membership.cjs';
import attestations from '../../apps/client/windows/electron/protected-policy-attestation.cjs';
import commitments from '../../apps/client/windows/electron/protected-channel-policy-commitments.cjs';
import replay from '../../apps/client/windows/electron/protected-policy-replay.cjs';
import voice from '../../apps/client/windows/electron/protected-voice-keys.cjs';

const { signatureFrame } = frames;
const { verifyAttestedVoiceRoster } = attestations;
const { channelPolicyCombinedDigest, voiceRecipientProjectionVersion, channelSettingsProjectionVersion } = commitments;
const { voiceRosterDigest, verifyVoiceKeyBasis, createVoiceKeyOffer, openVoiceKeyPackage } = voice;
const hash = (...parts) => {
  const state = createHash('sha256');
  for (const part of parts) state.update(part);
  return state.digest();
};
const raw = key => key.export({ type: 'spki', format: 'der' }).subarray(-32);

test('the owner and an administrator can lift their own signed server voice restrictions', () => {
  const owner = '1'.repeat(64), admin = '2'.repeat(64), member = '3'.repeat(64), channel = '4'.repeat(32);
  const before = { Owner: owner, Order: ['administrator'], Roles: {
    '@everyone': { Grants: ['channel.view'] },
    administrator: { Grants: ['server.administrator'] },
  }, Members: {
    [owner]: { ID: owner, Active: true },
    [admin]: { ID: admin, Active: true, Roles: ['administrator'] },
    [member]: { ID: member, Active: true },
  }, Channels: { [channel]: { Kind: 'voice' } }, Admissions: {} };
  const after = { ...before, VoiceRestrictions: { '*': { [owner]: { Muted: true, Deafened: false } } } };
  const mute = { Action: 'voice.mute', PublicKey: '', RoleUpdate: null, ResourceChange: {
    ID: channel, Mode: 'server', TargetProfileID: owner, VoiceTargetSessionID: '5'.repeat(32),
  } };
  replay.replayPolicyTransition(before, after, { ProfileID: admin }, mute, owner);
  assert.throws(() => replay.replayPolicyTransition(before, after, { ProfileID: member }, mute, owner));
  assert.throws(() => replay.replayPolicyTransition(before, after, { ProfileID: owner }, mute, owner));
  replay.replayPolicyTransition(after, before, { ProfileID: owner }, { ...mute, ResourceChange: { ...mute.ResourceChange, Lift: true } }, owner);
  for (const [action, mode, restriction] of [
    ['voice.mute', 'server', { Muted: true, Deafened: false }],
    ['voice.deafen', 'server', { Muted: false, Deafened: true }],
    ['voice.deafen', 'server-media', { Muted: false, Deafened: false, MediaDeafened: true }],
  ]) {
    const restrictedAdmin = { ...before, VoiceRestrictions: { '*': { [admin]: restriction } } };
    const impose = { ...mute, Action: action, ResourceChange: { ...mute.ResourceChange, TargetProfileID: admin, Mode: mode } };
    const lift = { ...impose, ResourceChange: { ...impose.ResourceChange, Lift: true } };
    replay.replayPolicyTransition(before, restrictedAdmin, { ProfileID: owner }, impose, owner);
    replay.replayPolicyTransition(restrictedAdmin, before, { ProfileID: admin }, lift, owner);
    assert.throws(() => replay.replayPolicyTransition(before, restrictedAdmin, { ProfileID: admin }, impose, owner));
    const restrictedMember = { ...before, VoiceRestrictions: { '*': { [member]: restriction } } };
    assert.throws(() => replay.replayPolicyTransition(restrictedMember, before, { ProfileID: member },
      { ...lift, ResourceChange: { ...lift.ResourceChange, TargetProfileID: member } }, owner));
  }
});

function fixture() {
  const a = generateKeyPairSync('ed25519'), b = generateKeyPairSync('ed25519');
  const x = generateKeyPairSync('x25519'), y = generateKeyPairSync('x25519');
  const channelId = '9'.repeat(32);
  const items = [a, b].map(({ publicKey }, index) => ({
    sessionId: String(index + 1).repeat(32), profileId: String(index + 1).repeat(64),
    deviceId: hash(raw(publicKey)).toString('hex'), publicKey: raw([x, y][index].publicKey).toString('hex'),
  }));
  const fields = items.map((item, index) => {
    const signingKey = raw([a, b][index].publicKey).toString('hex'), salt = String(index + 7).repeat(64);
    return { deviceId: item.deviceId, signingKey, salt,
      leaf: hash(signatureFrame('pawtalk-voice-recipient-v1', item.deviceId, item.profileId, item.publicKey, signingKey, salt)) };
  });
  const recipients = fields.map(({ leaf, ...entry }, index) => ({
    ...entry, proof: { count: 2, index, siblings: [fields[1-index].leaf.toString('hex')] },
  }));
  const orderDigest = 'c'.repeat(64);
  const recipientRoot = hash(Buffer.from([2, 0, 0, 0, 2]), hash(Buffer.from([1]), fields[0].leaf, fields[1].leaf));
  const projection = channelPolicyCombinedDigest(recipientRoot.toString('hex'), orderDigest);
  const salt = '6'.repeat(64);
  const inclusion = { index: 341, salt, siblings: Array.from({ length: 10 }, (_, index) => index.toString(16).repeat(64)) };
  let root = hash(Buffer.from([0]), hash(channelId), Buffer.from(salt, 'hex'), Buffer.from(projection, 'hex'));
  for (let level = 0, index = inclusion.index; level < 10; level++, index >>= 1) {
    const side = Buffer.from(inclusion.siblings[level], 'hex');
    root = hash(Buffer.from([1]), ...(index & 1 ? [side, root] : [root, side]));
  }
  const basis = { serverId: '1'.repeat(32), channelId, binding: 'b'.repeat(64), epochId: '2'.repeat(32),
    revision: 2, policyDigest: '9'.repeat(64), rosterDigest: voiceRosterDigest(items), expiresAt: 160_000 };
  const view = { revision: basis.revision, policyDigest: basis.policyDigest, projectionVersion: voiceRecipientProjectionVersion,
    root: root.toString('hex') };
  return { basis, view, items, policy: { inclusion, orderDigest, recipients }, author: a.privateKey, reader: y.privateKey };
}

test('only the active roster with every v8 recipient proof can publish and decrypt voice keys', () => {
  const { basis, view, items, policy, author, reader } = fixture();
  verifyVoiceKeyBasis(basis, items, 100_000, basis);
  assert.throws(() => verifyVoiceKeyBasis(basis, items, 100_000, { ...basis, binding: 'e'.repeat(64) }));
  const signers = verifyAttestedVoiceRoster(view, basis, items, policy);
  assert.deepEqual(verifyAttestedVoiceRoster({ ...view, projectionVersion: channelSettingsProjectionVersion }, basis, items, policy),
    signers);
  const offer = createVoiceKeyOffer(basis, items, items[0].sessionId, author, 100_000);
  const received = openVoiceKeyPackage({ ...offer, ciphertext: offer.packages[items[1].sessionId] }, basis, items,
    items[1].sessionId, signers.get(items[0].sessionId), reader, 100_000);
  assert.equal(received.length, 32);
  received.fill(0);
  assert.throws(() => openVoiceKeyPackage({ ...offer, ciphertext: offer.packages[items[1].sessionId] }, basis, items,
    items[1].sessionId, signers.get(items[1].sessionId), reader, 100_000));
});

test('scoped voice rejects stale revisions, missing recipients, injected keys and a swapped channel', () => {
  const { basis, view, items, policy } = fixture();
  const check = (bundle, roster = items, proposal = basis, scope = view) => verifyAttestedVoiceRoster(scope, proposal, roster, bundle);
  assert.throws(() => check(undefined));
  assert.throws(() => check({ ...policy, recipients: policy.recipients.slice(1) }));
  assert.throws(() => check({ ...policy, recipients: [...policy.recipients].reverse() }));
  assert.throws(() => check({ ...policy, orderDigest: 'd'.repeat(64) }));
  assert.throws(() => check(policy, items, { ...basis, revision: basis.revision - 1 }));
  assert.throws(() => check(policy, items, { ...basis, channelId: '2'.repeat(32) }));
  assert.throws(() => check(policy, items, basis, { ...view, projectionVersion: 7 }));
  const modified = [{ ...items[0], publicKey: items[1].publicKey }, items[1]];
  assert.throws(() => check(policy, modified, { ...basis, rosterDigest: voiceRosterDigest(modified) }));
});

test('voice verification exposes canonical codes for malformed proofs and corrupted ciphertext', () => {
  const { basis, view, items, policy, author, reader } = fixture();
  const invalid = { code: 'INVALID_PROTECTED_VOICE_KEY' };
  assert.throws(() => verifyVoiceKeyBasis(basis, [items[0], items[0]], 100_000, basis), invalid);
  assert.throws(() => verifyAttestedVoiceRoster(view, basis, items, { ...policy, recipients: [] }),
    { code: 'UNVERIFIED_VOICE_ROSTER' });
  const signer = verifyAttestedVoiceRoster(view, basis, items, policy).get(items[0].sessionId);
  const offer = createVoiceKeyOffer(basis, items, items[0].sessionId, author, 100_000);
  const delivery = { ...offer, ciphertext: offer.packages[items[1].sessionId] };
  const open = packet => openVoiceKeyPackage(packet, basis, items, items[1].sessionId, signer, reader, 100_000);
  const signature = Buffer.from(delivery.signature, 'base64');
  signature[0] ^= 1;
  assert.throws(() => open({ ...delivery, signature: signature.toString('base64') }), invalid);
  assert.throws(() => open({ ...delivery, ciphertext: '' }), invalid);
  const ciphertext = Buffer.from(delivery.ciphertext, 'base64');
  ciphertext[ciphertext.length - 1] ^= 1;
  assert.throws(() => open({ ...delivery, ciphertext: ciphertext.toString('base64') }), invalid);
});

test('v8 voice projection matches the Go vector and legacy v7 voice hashes stay independent of recipients', () => {
  const voice = 'voice';
  const seed = hash('voice-projection-vector').toString('hex');
  const snapshot = {
    Roles: { '@everyone': { Grants: ['channel.view', 'voice.connect'] } },
    Members: {}, PolicyDevices: {}, KeyRecipients: {},
    Channels: { [voice]: { Kind: 'voice', ACL: { Profiles: {} } } },
    VoiceRestrictions: { [voice]: {} },
  };
  const profileId = index => index.toString(16).padStart(64, '0');
  const records = Array.from({ length: 8 }, (_, offset) => {
    const index = offset+1;
    const key = hash(`fixture voice signer ${index}`).toString('hex');
    const deviceId = hash(Buffer.from(key, 'hex')).toString('hex');
    const profile = profileId(index);
    snapshot.Members[profile] = { ID: profile, Active: true };
    snapshot.PolicyDevices[deviceId] = { ProfileID: profile, PublicKey: key };
    snapshot.KeyRecipients[deviceId] = { ProfileID: profile, Kind: 'device', PublicKey: profileId(index+10) };
    return { id: deviceId, profileId: profile, key };
  });
  const [owner, listener, muted, deafened, hidden, denied, revoked, recovery] = records;
  snapshot.Owner = owner.profileId;
  snapshot.Members[listener.profileId].TimeoutUntil = 10_000;
  snapshot.VoiceRestrictions[voice][muted.profileId] = { Muted: true };
  snapshot.VoiceRestrictions[voice][deafened.profileId] = { Deafened: true };
  snapshot.Channels[voice].ACL.Profiles[hidden.profileId] = { Deny: ['channel.view'] };
  snapshot.Channels[voice].ACL.Profiles[denied.profileId] = { Deny: ['voice.connect'] };
  snapshot.PolicyDevices[revoked.id].Revoked = true;
  snapshot.KeyRecipients[recovery.id].Kind = 'recovery';
  const order = commitments.channelOrderCommitment(voice, 'voice', '', [owner], seed);
  // TestVoiceRecipientProjection in Go independently computes this three-leaf root.
  const expected = '51cf65a624cbe815319859e96246a140e116f8955cd4a0a7fd176c6733511df6';
  const project = version => replay.channelPolicyProjectionDigest(snapshot, voice, seed, version);
  const legacy = channelPolicyCombinedDigest('0'.repeat(64), order);
  assert.equal(project(7), legacy);
  assert.equal(project(8), channelPolicyCombinedDigest(expected, order));
  snapshot.VoiceRestrictions[voice][listener.profileId] = { Deafened: true };
  assert.equal(project(7), legacy);
  assert.notEqual(project(8), channelPolicyCombinedDigest(expected, order));
});
