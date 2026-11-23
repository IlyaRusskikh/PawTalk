import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import test from 'node:test';
import revisionCrypto from '../../apps/client/windows/electron/protected-text-revision.cjs';
import revisionAudience from '../../apps/client/windows/electron/protected-revision-audience.cjs';
import epochCrypto from '../../apps/client/windows/electron/protected-epoch-packages.cjs';
import archiveLinks from '../../apps/client/windows/electron/protected-archive-links.cjs';
import archiveSession from '../../apps/client/windows/electron/protected-archive-session.cjs';
import checkpointModule from '../../apps/client/windows/electron/protected-epoch-checkpoint.cjs';
import membershipWire from '../../shared/membership.cjs';

const { sealProtectedRevision, openProtectedRevisionForArchive, openProtectedRevisionForDevice } = revisionCrypto;
const { revisionAudienceRoot, verifyRevisionAudience, groupedRevisionAudienceRoot, verifyGroupedRevisionAudience } = revisionAudience;
const { archiveRevisionPrivateKey, archiveRevisionPublicKey, epochSignatureFrame, openKeyPackage, verifySignedEpoch } = epochCrypto;
const { signatureFrame } = membershipWire;
const { sealArchiveLink, openArchiveLinks } = archiveLinks;
const { packageContext } = archiveSession;
const { ProtectedEpochCheckpoint } = checkpointModule;
const digest = value => createHash('sha256').update(value).digest('hex');
const pub = key => key.export({ type: 'spki', format: 'der' }).subarray(-32);
const device = () => {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return { id: digest(pub(publicKey)), publicKey: pub(publicKey).toString('hex'), privateKey };
};
const archive = (serverId, channelId, Generation, secret) => {
  const record = { ChannelID: channelId, Purpose: 'archive', Generation, Revision: Generation + 2, KeyID: digest(secret) };
  return { ...record, ArchiveWrapKey: archiveRevisionPublicKey(serverId, record, secret) };
};

test('a revision audience proof authenticates the full set at the original position', () => {
  const bufferHash = (...inputs) => {
    const state = createHash('sha256');
    for (const input of inputs) state.update(input);
    return state.digest();
  };
  const node = (kind, bit, left, right) => bufferHash(Buffer.from([kind, bit]), left, right);
  const leaf = recipient => node(0, 0, Buffer.from(recipient.id, 'hex'), Buffer.from(recipient.publicKey, 'hex'));
  const alice = { id: '10'.repeat(32), publicKey: 'a1'.repeat(32) };
  const bob = { id: '40'.repeat(32), publicKey: 'b2'.repeat(32) };
  const carol = { id: '80'.repeat(32), publicKey: 'c3'.repeat(32) };
  const saltForSet = set => bufferHash('test-salt', set);
  const salted = set => node(3, 0, saltForSet(set), set);
  const empty = salted(bufferHash('pawtalk-revision-audience-empty-v1'));
  const first = salted(leaf(alice));
  const everything = salted(node(1, 0, node(1, 1, leaf(alice), leaf(bob)), leaf(carol)));
  let root = node(2, 2, node(2, 1, empty, first), everything);
  for (let level = 3; level <= 53; level += 1) root = node(2, level, root, everything);
  const rootHex = root.toString('hex');
  assert.equal(revisionAudienceRoot([
    { ...carol, firstPosition: 2 }, { ...alice, firstPosition: 1 }, { ...bob, firstPosition: 2 },
    { ...device(), firstPosition: 1, archive: true },
  ], saltForSet), rootHex);
  const proof = { salt: saltForSet(leaf(alice)).toString('hex'), siblings: [empty, ...Array(52).fill(everything)].map(item => item.toString('hex')) };
  assert.deepEqual(verifyRevisionAudience(rootHex, 1, [alice], proof), [alice]);
  for (const [position, recipients] of [[1, []], [1, [alice, bob]], [1, [{ ...alice, publicKey: bob.publicKey }]], [2, [alice]]]) {
    assert.throws(() => verifyRevisionAudience(rootHex, position, recipients, proof), { code: 'UNVERIFIED_EPOCH_RECIPIENTS' });
  }
});

test('a grouped revision position proof excludes a profile without opening its devices', () => {
  const fixed = digit => digit.repeat(64);
  const bufferHash = (...parts) => {
    const state = createHash('sha256');
    for (const part of parts) state.update(part);
    return state.digest();
  };
  const node = (tag, bit, left, right) => bufferHash(Buffer.from([tag, bit]), left, right);
  const saltForSet = set => bufferHash('synthetic position salt', set);
  const openingFor = profile => ({ salt: digest(`outer ${profile}`), contentSalt: digest(`inner ${profile}`) });
  const [kept, removed, late, full] = ['1', '9', '3', '4'].map(fixed);
  const [device, lostDevice, lostRecovery, lateDevice, fullDevice] = ['5', '6', '7', '8', 'a'].map(id => ({ id: fixed(id), publicKey: fixed('d') }));
  const members = (profile, devices) => bufferHash('pawtalk-revision-profile-members-v1:', openingFor(profile).contentSalt,
    JSON.stringify(devices.map(({ id, publicKey }) => [id, publicKey]))).toString('hex');
  const leaf = (profile, devices) => bufferHash(signatureFrame('pawtalk-revision-profile-v1', profile,
    openingFor(profile).salt, members(profile, devices)));
  const oldSet = node(1, 0, leaf(kept, [device]), leaf(removed, [lostDevice, lostRecovery]));
  const withLate = node(1, 0, node(1, 2, leaf(kept, [device]), leaf(late, [lateDevice])), leaf(removed, [lostDevice, lostRecovery]));
  const salted = root => node(3, 0, saltForSet(root), root);
  const initial = salted(bufferHash('pawtalk-revision-profile-empty-v1'));
  const eligible = salted(oldSet);
  const afterJoin = salted(withLate);
  let expected = node(2, 2, node(2, 1, initial, eligible), afterJoin);
  for (let height = 3; height <= 53; height++) expected = node(2, height, expected, afterJoin);
  const statements = [
    { ...lostRecovery, profileId: removed, firstPosition: 1 }, { ...lateDevice, profileId: late, firstPosition: 2 },
    { ...device, profileId: kept, firstPosition: 1 }, { ...lostDevice, profileId: removed, firstPosition: 1 },
    { ...fullDevice, profileId: full, firstPosition: 1, archive: true },
  ];
  const root = groupedRevisionAudienceRoot(statements, openingFor, saltForSet);
  assert.equal(root, expected.toString('hex'));
  const proof = { salt: saltForSet(oldSet).toString('hex'), siblings: [initial, ...Array(52).fill(afterJoin)].map(d => d.toString('hex')) };
  const audience = { profiles: { [device.id]: kept }, openings: { [kept]: openingFor(kept) } };
  const opening = { salt: openingFor(removed).salt, digest: members(removed, [lostDevice, lostRecovery]) };
  const exclusion = { excludedProfiles: [removed, full], removedGroups: { [removed]: opening } };
  assert.deepEqual(verifyGroupedRevisionAudience(root, 1, [device], proof, audience, exclusion), [device]);
  assert.ok(!JSON.stringify(exclusion).includes(lostRecovery.id));
  const invalid = { code: 'UNVERIFIED_EPOCH_RECIPIENTS' };
  assert.throws(() => verifyGroupedRevisionAudience(root, 1, [device], proof, audience), invalid);
  assert.throws(() => verifyGroupedRevisionAudience(root, 2, [device], proof, audience, exclusion), invalid);
  assert.throws(() => verifyGroupedRevisionAudience(root, 1, [device, lostDevice, lostRecovery], proof, {
    profiles: { ...audience.profiles, [lostDevice.id]: removed, [lostRecovery.id]: removed },
    openings: { ...audience.openings, [removed]: openingFor(removed) },
  }, exclusion), invalid);
  assert.throws(() => verifyGroupedRevisionAudience(root, 1, [device], proof, audience,
    { ...exclusion, excludedProfiles: [late, full] }), invalid);
  assert.throws(() => verifyGroupedRevisionAudience(root, 1, [device], proof, audience,
    { ...exclusion, removedGroups: {} }), invalid);
  assert.throws(() => verifyGroupedRevisionAudience(root, 1, [device], proof, audience,
    { ...exclusion, removedGroups: { ...exclusion.removedGroups, [full]: opening } }), invalid);
});

test('archive write address opens a revision only with its archive secret or an intended device package', () => {
  const serverId = '1'.repeat(32), channelId = '2'.repeat(32);
  const oldArchive = randomBytes(32), currentArchive = randomBytes(32), futureArchive = randomBytes(32);
  const continuing = device(), excluded = device(), newLimited = device();
  const author = generateKeyPairSync('ed25519');
  const publicAuthor = pub(author.publicKey).toString('hex');
  const context = {
    serverId, channelId, position: 14, revision: 2, originalDigest: 'c'.repeat(64), previousDigest: 'd'.repeat(64),
    operationId: '3'.repeat(32), authorProfileId: '4'.repeat(64), authorDeviceId: digest(pub(author.publicKey)),
    policyRevision: 7, policyDigest: '5'.repeat(64), archive: archive(serverId, channelId, 3, currentArchive), archiveDigest: '6'.repeat(64),
  };
  // The writer is given the verified public address and eligible device keys.
  // The sealing path receives no archive secret.
  const { packet, packages } = sealProtectedRevision(context, 'Edited synthetic text', [continuing], author.privateKey);
  const delivery = { ...packages[0], proof: { count: 1, index: 0, siblings: [] } };
  assert.deepEqual(packages.map(item => item.id), [continuing.id]);
  assert.equal(openProtectedRevisionForDevice(context, packet, delivery, continuing, continuing.privateKey, publicAuthor), 'Edited synthetic text');
  assert.equal(openProtectedRevisionForArchive(context, packet, currentArchive, publicAuthor), 'Edited synthetic text');
  assert.throws(() => openProtectedRevisionForArchive(context, packet, oldArchive, publicAuthor), /INVALID_ARCHIVE_REVISION_KEY/);
  for (const unauthorized of [excluded, newLimited]) {
    assert.throws(() => openProtectedRevisionForDevice(context, packet, delivery, unauthorized, unauthorized.privateKey, publicAuthor),
      /INVALID_PROTECTED_REVISION/);
  }
  const binding = [serverId, channelId, String(context.position), context.originalDigest, String(context.revision),
    context.previousDigest, context.operationId, context.authorProfileId, context.authorDeviceId, String(context.policyRevision),
    context.policyDigest, String(context.archive.Generation), context.archive.KeyID, context.archiveDigest, context.archive.ArchiveWrapKey];
  const deviceInfo = signatureFrame('pawtalk-text-revision-device-v1', ...binding, continuing.id, continuing.publicKey);
  const archiveInfo = signatureFrame('pawtalk-text-revision-archive-v1', ...binding);
  for (const unauthorized of [excluded, newLimited]) {
    assert.throws(() => openKeyPackage(Buffer.from(delivery.ciphertext, 'base64'), unauthorized.privateKey,
      Buffer.from(continuing.publicKey, 'hex'), deviceInfo), /authenticate data/);
  }
  const previousArchive = archive(serverId, channelId, 2, oldArchive);
  assert.throws(() => openKeyPackage(Buffer.from(packet.archivePackage, 'base64'),
    archiveRevisionPrivateKey(serverId, previousArchive, oldArchive), Buffer.from(context.archive.ArchiveWrapKey, 'hex'),
    archiveInfo), /authenticate data/);
  assert.throws(() => openProtectedRevisionForDevice(context, packet, delivery, continuing, excluded.privateKey, publicAuthor),
    /INVALID_PROTECTED_REVISION/);
  for (const mutation of [
    { position: 15 }, { originalDigest: 'a'.repeat(64) }, { previousDigest: 'a'.repeat(64) },
    { policyRevision: 8 }, { operationId: 'a'.repeat(32) }, { archiveDigest: 'a'.repeat(64) },
  ]) {
    assert.throws(() => openProtectedRevisionForArchive({ ...context, ...mutation }, packet, currentArchive, publicAuthor),
      /INVALID_PROTECTED_REVISION/);
  }
  assert.throws(() => openProtectedRevisionForArchive(context, { ...packet, archivePackage: Buffer.alloc(80).toString('base64') },
    currentArchive, publicAuthor), /INVALID_PROTECTED_REVISION/);
  assert.throws(() => openProtectedRevisionForDevice(context, packet, { ...delivery, proof: { ...delivery.proof, count: 2 } },
    continuing, continuing.privateKey, publicAuthor), /INVALID_PROTECTED_REVISION/);

  const source = { serverId, channelId, generation: 4, keyId: digest(futureArchive) };
  const link = sealArchiveLink(futureArchive, source, context.archive, currentArchive);
  const [recovered] = openArchiveLinks(futureArchive, source, [link], digest(JSON.stringify([link])));
  try {
    assert.equal(openProtectedRevisionForArchive(context, packet, recovered.secret, publicAuthor), 'Edited synthetic text');
  } finally {
    recovered.secret.fill(0);
  }
});

test('archive wrapping key is signed and a checkpoint rejects omission in a later epoch', async () => {
  const serverId = '1'.repeat(32), channelId = '2'.repeat(32), ProfileID = '3'.repeat(64);
  const key = generateKeyPairSync('ed25519');
  const DeviceID = digest(pub(key.publicKey));
  const signer = { profileId: ProfileID, deviceId: DeviceID, key: pub(key.publicKey).toString('hex') };
  const record = {
    ...archive(serverId, channelId, 1, randomBytes(32)), PreviousDigest: '', PolicyDigest: '4'.repeat(64),
    TaskID: '5'.repeat(32), LeaseID: '6'.repeat(32), PackagesDigest: '7'.repeat(64), ArchiveThrough: 1, ArchiveLinksDigest: '8'.repeat(64),
  };
  const signed = draft => ({ Principal: { ProfileID, DeviceID }, Record: {
    ...draft, Signature: sign(null, epochSignatureFrame(serverId, ProfileID, DeviceID, draft), key.privateKey).toString('base64'),
  } });
  const first = signed(record), context = packageContext(serverId, first.Record);
  const verify = entry => verifySignedEpoch(entry, packageContext(serverId, entry.Record), signer);
  const firstDigest = verify(first);
  const alternate = archive(serverId, channelId, 1, randomBytes(32)).ArchiveWrapKey;
  assert.throws(() => verifySignedEpoch({ ...first, Record: { ...first.Record, ArchiveWrapKey: alternate } }, context, signer),
    /INVALID_EPOCH_SIGNATURE/);
  const { ArchiveWrapKey, ...v1 } = first.Record;
  assert.throws(() => verifySignedEpoch({ ...first, Record: v1 }, context, signer), /INVALID_EPOCH_SIGNATURE/);
  assert.match(verify(signed(v1)), /^[0-9a-f]{64}$/);

  let stored;
  const checkpoint = new ProtectedEpochCheckpoint({
    load: async () => stored, save: async (_key, next) => { stored = next; },
  });
  const trust = { serverId, anchorDigest: 'a'.repeat(64) };
  await checkpoint.run(trust, channelId, 'archive', continuity => continuity.accept(first, verify));
  const secondWithoutWrap = signed({ ...v1, Generation: 2, KeyID: 'b'.repeat(64), PreviousDigest: firstDigest });
  await assert.rejects(checkpoint.run(trust, channelId, 'archive', continuity => continuity.accept(secondWithoutWrap, verify)),
    { code: 'EPOCH_CHAIN_CONFLICT' });
});

test('opening earlier live history requires the signed ancestor of the current epoch', async () => {
  const serverId = '1'.repeat(32), channelId = '2'.repeat(32), ProfileID = '3'.repeat(64);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const DeviceID = digest(pub(publicKey));
  const signer = { profileId: ProfileID, deviceId: DeviceID, key: pub(publicKey).toString('hex') };
  const signed = (Generation, PreviousDigest, KeyID) => {
    const record = { ChannelID: channelId, Generation, PreviousDigest, KeyID, Purpose: 'live', Revision: Generation + 1,
      PolicyDigest: '4'.repeat(64), TaskID: '5'.repeat(32), LeaseID: '6'.repeat(32), PackagesDigest: '7'.repeat(64),
      ArchiveThrough: 0, ArchiveLinksDigest: '' };
    record.Signature = sign(null, epochSignatureFrame(serverId, ProfileID, DeviceID, record), privateKey).toString('base64');
    return { Principal: { ProfileID, DeviceID }, Record: record };
  };
  const verify = entry => verifySignedEpoch(entry, packageContext(serverId, entry.Record), signer);
  const first = signed(1, '', 'a'.repeat(64));
  const second = signed(2, verify(first), 'b'.repeat(64));
  const third = signed(3, verify(second), 'c'.repeat(64));
  const fork = signed(2, verify(first), 'd'.repeat(64));
  let stored;
  const checkpoint = new ProtectedEpochCheckpoint({ load: async () => stored, save: async (_key, next) => { stored = next; } });
  const trust = { serverId, anchorDigest: 'a'.repeat(64) };
  await checkpoint.run(trust, channelId, 'live', continuity => continuity.accept(third, verify));
  const run = (candidate, fetchPage) => checkpoint.run(trust, channelId, 'live',
    continuity => continuity.verifyAncestor(candidate, third.Record, verify, fetchPage));
  await run(first, async (channel, purpose, after, through) => {
    assert.deepEqual([channel, purpose, after, through], [channelId, 'live', 1, 2]);
    return [second];
  });
  await run(second);
  await assert.rejects(run(fork), { code: 'EPOCH_CHAIN_CONFLICT' });
  await assert.rejects(run(first, async () => [fork]), { code: 'EPOCH_CHAIN_CONFLICT' });
  assert.equal(JSON.parse(stored).digest, verify(third));
});
