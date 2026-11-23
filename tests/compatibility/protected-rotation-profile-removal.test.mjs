import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import test from 'node:test';
import membership from '../../shared/membership.cjs';
import commitments from '../../apps/client/windows/electron/protected-channel-policy-commitments.cjs';
import replay from '../../apps/client/windows/electron/protected-policy-replay.cjs';
import audiences from '../../apps/client/windows/electron/protected-revision-audience.cjs';
import { roleViewDenyCommitment, roleViewDenyDigest } from '../../apps/client/windows/electron/protected-role-view-deny.cjs';

const { signatureFrame } = membership;
const { textRecipientBlind, textRotationDigest, verifyRotationProfiles, verifyRotationProfileRemoval, verifyRotationProfileRemovals } = commitments;
const fixed = digit => digit.repeat(64);
const [survivor, target] = ['1', '2'].map(fixed);
const [device, recovery, removedDevice, removedRecovery] = ['3', '4', '5', '6'].map(fixed);
const [deviceKey, recoveryKey, removedDeviceKey, removedRecoveryKey] = ['7', '8', '9', 'a'].map(fixed);
const survivors = {
  [device]: { ProfileID: survivor, Kind: 'device', PublicKey: deviceKey },
  [recovery]: { ProfileID: survivor, Kind: 'recovery', PublicKey: recoveryKey },
};
const removed = {
  [removedDevice]: { ProfileID: target, Kind: 'device', PublicKey: removedDeviceKey },
  [removedRecovery]: { ProfileID: target, Kind: 'recovery', PublicKey: removedRecoveryKey },
};
const seed = Buffer.from(fixed('b'), 'hex');
const channel = Buffer.from('c'.repeat(32));
const opening = profile => ({ salt: textRecipientBlind(seed, channel, 14, profile).toString('hex'),
  contentSalt: textRecipientBlind(seed, channel, 15, profile).toString('hex') });
const kept = opening(survivor);
const excluded = opening(target);
const removedGroup = { salt: excluded.salt, digest: textRotationDigest(removed, excluded.contentSalt) };
const leaf = (profile, salt, digest) => createHash('sha256')
  .update(signatureFrame('pawtalk-live-rotation-profile-v1', profile, salt, digest)).digest();
const root = (...leaves) => createHash('sha256').update('pawtalk-live-rotation-profiles-v1:')
  .update(Buffer.concat(leaves.sort(Buffer.compare))).digest('hex');
const keptLeaf = leaf(survivor, kept.salt, textRotationDigest(survivors, kept.contentSalt));
const previousRoot = root(keptLeaf, leaf(target, removedGroup.salt, removedGroup.digest));

test('v15 grouped revision positions match the Go vector with two devices on one limited profile', () => {
  const channelId = Buffer.from('9'.repeat(32));
  const blind = (mode, data) => textRecipientBlind(Buffer.from(fixed('a'), 'hex'), channelId, mode, data);
  const statements = [
    ['2', 'f', 'a', 12, false], ['2', 'e', 'b', 12, false], ['4', 'd', 'c', 29, false],
    ['6', 'c', 'd', 12, false], ['8', 'b', 'e', 1, true],
  ].map(([profile, id, key, firstPosition, archive]) => ({ profileId: fixed(profile), id: fixed(id), publicKey: fixed(key), firstPosition, archive }));
  assert.equal(audiences.groupedRevisionAudienceRoot(statements,
    profile => ({ salt: blind(18, profile).toString('hex'), contentSalt: blind(19, profile).toString('hex') }),
    set => blind(20, set.toString('hex'))), 'ee431fdc55e183915a10f747387559cef785da4df7e6aa64158feea35fbecef0');
});

test('v16 role deny effects match the Go vector with named and personal exceptions', () => {
  const channelId = '9'.repeat(32);
  const categoryId = '7'.repeat(32);
  const view = 'channel.view';
  const roleRules = {
    blocked: { Allow: [view, 'message.pin'] },
    vip: { Allow: [view] },
    latent: { Deny: [view] },
  };
  const profileRules = { [fixed('3')]: { Allow: [view] }, [fixed('6')]: { Deny: [view] } };
  const normalize = rules => Object.fromEntries(Object.entries(rules).map(([id, rule]) =>
    [id, { allow: rule.Allow ?? [], deny: rule.Deny ?? [] }]));
  const memberships = {
    1: ['blocked'], 2: ['blocked', 'silent'], 3: ['blocked'], 4: ['blocked', 'vip'],
    5: ['blocked', 'administrator'], 6: ['blocked'], 8: ['blocked', 'blocked'], 9: ['latent'],
    a: ['vip'], b: ['silent'],
  };
  const policy = {
    owner: fixed('1'), order: ['blocked', 'vip', 'silent', 'administrator', 'latent'],
    roles: { '@everyone': { grants: [view] }, blocked: { grants: [] }, vip: { grants: [] }, silent: { grants: [] },
      administrator: { grants: ['server.administrator'] }, latent: { grants: [] } },
    members: Object.fromEntries(Object.entries(memberships).map(([id, roles]) => [fixed(id), { id: fixed(id), roles, active: true }])),
  };
  const snapshot = {
    Channels: { [channelId]: { Kind: 'text', CategoryID: categoryId, Synchronized: true } },
    Categories: { [categoryId]: { Roles: roleRules, Profiles: profileRules } },
  };
  assert.equal(roleViewDenyCommitment(snapshot, channelId, fixed('a'), policy, {
    kind: 'text', synchronized: true, category: { roles: normalize(roleRules), profiles: normalize(profileRules) },
  }), '23025da480593b5770bccf21919c4363e1bcb34b2e15fb4d9997d2942eb6786f');
});

test('v16 role transition markers match the Go live and archive domains', () => {
  const record = { ChannelID: '4'.repeat(32), Revision: 8, PolicyDigest: fixed('c') };
  const proof = {
    previousRevision: 7, previousHead: fixed('a'), successorHead: fixed('b'), operationId: '1'.repeat(32),
    actor: { ProfileID: fixed('d'), DeviceID: fixed('e') },
    effect: { roleId: 'quarantine', previousRulesDigest: fixed('3'), nextRulesDigest: fixed('2') },
    editorProof: 'a'.repeat(86),
  };
  assert.equal(roleViewDenyDigest({ ...record, Purpose: 'live' }, proof),
    '91a86c3300f2f56d0cee69cc551070c613363b2a38360cf6e17607c6b70476cb');
  assert.equal(roleViewDenyDigest({ ...record, Purpose: 'archive' }, proof),
    '94cd7554b404d3300628e262a2fa1fca2b379ca7bf9ec17354855dfd12cb7ffd');
});

test('a live recipient proof removes the entire authorized group without opening its device or recovery IDs', () => {
  const openings = { [survivor]: kept };
  assert.equal(verifyRotationProfileRemoval('live', previousRoot, survivors, openings, target, removedGroup), root(keptLeaf));
  const transmitted = JSON.stringify({ survivors, openings, removedGroup });
  for (const privateField of [removedDevice, removedRecovery, removedDeviceKey, removedRecoveryKey, excluded.contentSalt]) {
    assert.ok(!transmitted.includes(privateField));
  }
});

test('a live recipient proof rejects keeping a removed device or altering any survivor', () => {
  const openings = { [survivor]: kept };
  const propose = (recipients, proposedOpenings = openings, profile = target, group = removedGroup) =>
    verifyRotationProfileRemoval('live', previousRoot, recipients, proposedOpenings, profile, group);
  const invalid = { code: 'INVALID_CHANNEL_POLICY_PROOF' };
  assert.throws(() => propose({ ...survivors, [removedDevice]: removed[removedDevice] }), invalid);
  assert.throws(() => propose({ ...survivors, [removedDevice]: { ...removed[removedDevice], ProfileID: survivor } }), invalid);
  assert.throws(() => propose({ [device]: survivors[device] }), invalid);
  assert.throws(() => propose({ ...survivors, [device]: { ...survivors[device], PublicKey: removedDeviceKey } }), invalid);
  assert.throws(() => propose(survivors, { ...openings, [target]: excluded }), invalid);
  assert.throws(() => propose(survivors, { [survivor]: { ...kept, contentSalt: excluded.contentSalt } }), invalid);
  assert.throws(() => propose(survivors, openings, fixed('e')), invalid);
  assert.throws(() => propose(survivors, openings, target, { ...removedGroup, digest: fixed('f') }), invalid);
  assert.throws(() => propose(survivors, openings, target, { ...removedGroup, contentSalt: excluded.contentSalt }), invalid);
});

test('a live role exclusion proves every removed group and keeps keyless exclusions opaque', () => {
  const [secondTarget, keylessTarget, unrelated] = ['c', 'd', 'e'].map(fixed);
  const secondDevice = fixed('0');
  const secondRecipient = { ProfileID: secondTarget, Kind: 'device', PublicKey: fixed('f') };
  const secondOpening = opening(secondTarget);
  const secondRemovedGroup = {
    salt: secondOpening.salt,
    digest: textRotationDigest({ [secondDevice]: secondRecipient }, secondOpening.contentSalt),
  };
  const oldRoot = root(keptLeaf, leaf(target, removedGroup.salt, removedGroup.digest),
    leaf(secondTarget, secondRemovedGroup.salt, secondRemovedGroup.digest));
  const excludedProfiles = [target, secondTarget, keylessTarget];
  const removedGroups = { [target]: removedGroup, [secondTarget]: secondRemovedGroup };
  const openings = { [survivor]: kept };
  const propose = (recipients = survivors, proposedOpenings = openings, proposedRemoval = removedGroups) =>
    verifyRotationProfileRemovals('live', oldRoot, recipients, proposedOpenings, excludedProfiles, proposedRemoval);
  assert.equal(propose(), root(keptLeaf));
  const transmitted = JSON.stringify({ survivors, openings, excludedProfiles, removedGroups });
  for (const privateField of [removedDevice, removedRecovery, removedDeviceKey, removedRecoveryKey, excluded.contentSalt,
    secondDevice, secondRecipient.PublicKey, secondOpening.contentSalt]) {
    assert.ok(!transmitted.includes(privateField));
  }

  const invalid = { code: 'INVALID_CHANNEL_POLICY_PROOF' };
  assert.throws(() => propose(survivors, openings, { [target]: removedGroup }), invalid);
  assert.throws(() => propose(survivors, openings, { ...removedGroups, [unrelated]: secondRemovedGroup }), invalid);
  assert.throws(() => propose(survivors, openings, { ...removedGroups, [keylessTarget]: secondRemovedGroup }), invalid);
  assert.throws(() => propose(survivors, openings, { ...removedGroups, [secondTarget]: { ...secondRemovedGroup, digest: fixed('a') } }), invalid);
  assert.throws(() => propose(survivors, { [survivor]: { ...kept, contentSalt: secondOpening.contentSalt } }), invalid);
  assert.throws(() => propose({ ...survivors, [secondDevice]: secondRecipient },
    { ...openings, [secondTarget]: secondOpening }, { [target]: removedGroup }), invalid);
});

test('archive group deletion excludes live-only devices and has separate openings from the live roster', () => {
  const retainedLiveOnly = fixed('c');
  const retainedLiveDevice = fixed('d');
  const archiveOpening = profile => ({ salt: textRecipientBlind(seed, channel, 16, profile).toString('hex'),
    contentSalt: textRecipientBlind(seed, channel, 17, profile).toString('hex') });
  const archiveLeaf = (profile, salt, digest) => createHash('sha256')
    .update(signatureFrame('pawtalk-archive-rotation-profile-v1', profile, salt, digest)).digest();
  const archiveRoot = (...leaves) => createHash('sha256').update('pawtalk-archive-rotation-profiles-v1:')
    .update(Buffer.concat(leaves.sort(Buffer.compare))).digest('hex');
  const survivingArchive = { ...survivors };
  const liveOnlyRecipient = { ProfileID: retainedLiveOnly, Kind: 'device', PublicKey: fixed('e') };
  const survivorOpening = archiveOpening(survivor);
  const targetOpening = archiveOpening(target);
  const removedArchive = { salt: targetOpening.salt, digest: textRotationDigest(removed, targetOpening.contentSalt) };
  const survivorLeaf = archiveLeaf(survivor, survivorOpening.salt, textRotationDigest(survivingArchive, survivorOpening.contentSalt));
  const rootWithTarget = archiveRoot(survivorLeaf, archiveLeaf(target, removedArchive.salt, removedArchive.digest));
  const rootWithoutTarget = archiveRoot(survivorLeaf);
  const openings = { [survivor]: survivorOpening };
  assert.equal(verifyRotationProfileRemoval('archive', rootWithTarget, survivingArchive, openings, target, removedArchive), rootWithoutTarget);
  assert.equal(verifyRotationProfileRemovals('archive', rootWithTarget, survivingArchive, openings,
    [target, retainedLiveOnly], { [target]: removedArchive }), rootWithoutTarget);
  assert.equal(verifyRotationProfileRemovals('archive', rootWithoutTarget, survivingArchive, openings,
    [retainedLiveOnly], {}), rootWithoutTarget);
  assert.doesNotThrow(() => verifyRotationProfiles('archive', rootWithoutTarget, survivingArchive, openings));
  const invalid = { code: 'INVALID_CHANNEL_POLICY_PROOF' };
  assert.throws(() => verifyRotationProfiles('archive', rootWithTarget, survivingArchive, openings), invalid);
  assert.throws(() => verifyRotationProfiles('archive', rootWithoutTarget, survivingArchive, { [survivor]: kept }), invalid);
  assert.throws(() => verifyRotationProfiles('live', rootWithoutTarget, survivingArchive, openings), invalid);
  assert.throws(() => verifyRotationProfileRemovals('archive', rootWithTarget, survivingArchive, openings,
    [target, retainedLiveOnly], { [target]: removedGroup }), invalid);
  assert.throws(() => verifyRotationProfileRemoval('archive', rootWithTarget, {
    ...survivingArchive, [retainedLiveDevice]: liveOnlyRecipient,
  }, { ...openings, [retainedLiveOnly]: archiveOpening(retainedLiveOnly) }, target, removedArchive), invalid);
});

test('v12 through v15 policy roots match the frozen Go vectors with mixed device and recovery recipients', () => {
  const channelId = '9'.repeat(32);
  const [owner, reader] = ['1', '2'].map(fixed);
  const snapshot = {
    Owner: owner, Roles: { '@everyone': { Grants: ['channel.view'] } },
    Members: { [owner]: { ID: owner, Active: true }, [reader]: { ID: reader, Active: true } },
    Channels: { [channelId]: { Kind: 'text', NextPosition: 5 } },
    Admissions: { [channelId]: { [owner]: { FirstPosition: 1 }, [reader]: { FirstPosition: 4 } } },
    PolicyDevices: {}, KeyRecipients: { [fixed('4')]: { ProfileID: owner, Kind: 'recovery', PublicKey: fixed('d') } },
  };
  for (const [seed, profileId, agreement] of [[1, owner, 'a'], [2, owner, 'b'], [3, reader, 'c']]) {
    const privateKey = createPrivateKey({ type: 'pkcs8', format: 'der',
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]) });
    const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
    const id = createHash('sha256').update(publicKey).digest('hex');
    snapshot.PolicyDevices[id] = { ProfileID: profileId, PublicKey: publicKey.toString('hex') };
    snapshot.KeyRecipients[id] = { ProfileID: profileId, Kind: 'device', PublicKey: fixed(agreement) };
  }
  for (const [version, expected] of [
    [commitments.profileACLBypassProjectionVersion, '3b9d784a07e13daedad3970a6d4b5261c41d62b26f85197443a5ec797430a62f'],
    [commitments.textGroupedRotationProjectionVersion, '612390f085de73981935cadfbb6b292eaf8d6beb560834bd78c818e9fe1d688f'],
    [commitments.textGroupedArchiveRotationProjectionVersion, '67120f0c109f4d83fa34f60134cd2de084031fc53016dfa6efed93d7df338060'],
    [commitments.textGroupedRevisionAudienceProjectionVersion, '49d21487e9592a70f764484744439b966d0974a5d5b28e7c0769150589c5a581'],
  ]) {
    const seed = fixed('a');
    assert.equal(commitments.channelPolicyRoot(replay.channelPolicyProjectionDigests(snapshot, seed, version), seed), expected);
  }
});
