import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import test from 'node:test';
import { signatureFrame } from '../../shared/membership.cjs';
import { MembershipClient } from '../../apps/client/windows/electron/membership-client.cjs';
import { commitmentRoot } from '../../apps/client/windows/electron/protected-epoch-packages.cjs';
import { auxiliaryPolicyDigest, channelPolicyCombinedDigest, scopedChannelRoleProjectionDigest, textNewcomerAdmissionDigest,
  textRecipientBlind, textRotationDigest }
  from '../../apps/client/windows/electron/protected-channel-policy-commitments.cjs';
import { inviteAdmissionDigest, inviteIssuerRoot } from '../../apps/client/windows/electron/protected-invite-admission-commitment.cjs';
import { profileRankProjection } from '../../apps/client/windows/electron/protected-policy-profile-ranks.cjs';
import { inviteAdmissionEpochDigest, verifyInviteAdmissionRotation, verifyInviteAdmissionEpochSigner, verifyInviteAdmissionDelivery,
  liveInviteAdmissionDigest, verifyLiveInviteAdmission, verifyLiveInviteEpochSigner, verifyLiveInviteAdmissionDelivery,
  verifyLiveInviteAdmissionAuthor } from '../../apps/client/windows/electron/protected-live-invite-admission.cjs';
import { inviteAdmissionBatchDigest, verifyInviteAdmissionBatchRotation, verifyInviteAdmissionBatchDelivery,
  verifyLiveInviteAdmissionBatchAuthor } from '../../apps/client/windows/electron/protected-invite-admission-batch.cjs';


const fixed = digit => digit.repeat(64);
const hash = (...parts) => createHash('sha256').update(Buffer.concat(parts.map(part => Buffer.from(part)))).digest();
const hex = value => value.toString('hex');
const branch = (a, b) => hash([1], a, b);
const key = seed => {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]),
    format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey, publicKey, id: hex(hash(publicKey)) };
};
const encoded = ({ publicKey }) => publicKey.toString('base64url');
const signature = (key, frame, encoding = 'base64') => sign(null, frame, key.privateKey).toString(encoding);
const position = (kind, id) => hash(signatureFrame('pawtalk-invite-credential-position-v1', kind, id));
const bit = (id, depth) => Boolean(id[depth >> 3] & (128 >> (depth % 8)));

test('scoped epoch proof paging retries an oversized prefix without skipping generations', async () => {
  const client = new MembershipClient({});
  const channel = 'a'.repeat(32);
  const requests = [];
  client.fetchJSON = async (_base, path) => {
    const query = new URL(path, 'https://example.test').searchParams;
    const after = Number(query.get('after')), through = Number(query.get('through'));
    requests.push([after, through]);
    if (through - after > 2 || after === 32) {
      throw Object.assign(Error('proof response too large'), { code: 'PROTECTED_PROOF_RESPONSE_TOO_LARGE' });
    }
    return Array.from({ length: through - after }, (_, index) =>
      ({ Record: { ChannelID: channel, Purpose: 'live', Generation: after + index + 1 } }));
  };
  const proofs = await client.fetchProtectedRuntimeEpochProofs({}, channel, 'live', 7, 70, true);
  assert.deepEqual(proofs.map(({ Record }) => Record.Generation), [8, 9]);
  assert.deepEqual(requests, [[7, 70], [7, 23], [7, 15], [7, 11], [7, 9]]);
  await assert.rejects(client.fetchProtectedRuntimeEpochProofs({}, channel, 'live', 32, 33, true),
    { code: 'PROTECTED_PROOF_RESPONSE_TOO_LARGE' });
});

function credentialProofs(entries) {
  const empty = Array(257);
  empty[256] = hash('pawtalk-invite-credential-empty-v1');
  for (let level = 255; level >= 0; level--) empty[level] = branch(empty[level + 1], empty[level + 1]);
  const leaves = entries.map(([kind, id, leaf]) => ({ id: position(kind, id), leaf }));
  const tree = (nodes, depth, selected, path) => {
    if (!nodes.length) return empty[depth];
    if (depth === 256) return nodes[0].leaf;
    const right = selected && bit(selected, depth);
    const lower = tree(nodes.filter(node => !bit(node.id, depth)), depth + 1, right ? null : selected, path);
    const upper = tree(nodes.filter(node => bit(node.id, depth)), depth + 1, right ? selected : null, path);
    const sibling = right ? lower : upper;
    if (selected && sibling !== empty[depth + 1]) path.push({ depth, digest: hex(sibling) });
    return branch(lower, upper);
  };
  return { root: hex(tree(leaves, 0)), opening(kind, id) {
    const path = [];
    tree(leaves, 0, position(kind, id), path);
    return path;
  } };
}

function policyProofs(channelId, channelDigest, auxiliaryDigest) {
  const salt = fixed('7');
  const leaf = (id, digest) => hash([0], hash(id), Buffer.from(salt, 'hex'), Buffer.from(digest, 'hex'));
  const channel = leaf(channelId, channelDigest), auxiliary = leaf(profileRankProjection, auxiliaryDigest);
  const upper = Array(9).fill(fixed('8'));
  const root = hex(upper.reduce((current, side) => branch(current, Buffer.from(side, 'hex')), branch(channel, auxiliary)));
  return { root, channel: { index: 0, salt, siblings: [hex(auxiliary), ...upper] },
    auxiliary: { index: 1, salt, siblings: [hex(channel), ...upper] } };
}

function fixture({ consumed = false, knownAgreement = false, archive = false, canSend = true, incumbentArchive = archive,
  maxUses = 1, revision = 10, previousDigest = fixed('d'), applicantSeeds = [4, 5], agreementKey = '0a' + '00'.repeat(31),
  previousStatement, firstPosition = 8, version = 17, issuerVersion = version } = {}) {
  const [server, incumbent, invite, profile, device] = [1, 2, 3, ...applicantSeeds].map(key);
  const trust = { serverId: server.id.slice(0, 32), cutoverDigest: fixed('a') };
  const channelId = 'b'.repeat(32), profileId = fixed('c'), policyHead = fixed('d'), issuerHead = fixed('b');
  const successor = revision === 10 ? fixed('e') : hex(hash(`head:${revision}`));
  const recipientKey = '09' + '00'.repeat(31);
  const inviteId = '1'.repeat(32), operationId = revision.toString(16).padStart(32, '0');
  const issuer = { ProfileID: profileId, DeviceID: incumbent.id };
  const claim = { inviteId, operationId, invitePublicKey: encoded(invite), profilePublicKey: encoded(profile),
    devicePublicKey: encoded(device), agreementKey, nickname: 'Newcomer' };
  const claimFrame = signatureFrame('pawtalk-protected-invite-redeem-v1', trust.serverId, trust.cutoverDigest,
    inviteId, operationId, claim.invitePublicKey, claim.profilePublicKey, claim.devicePublicKey, agreementKey, claim.nickname);
  for (const [name, signer] of Object.entries({ invite, profile, device })) claim[`${name}Signature`] = signature(signer, claimFrame, 'base64url');
  const issuance = { Issuer: issuer, PolicyRevision: 8, PolicyDigest: issuerHead, RequestedExpiry: 10_000, CreatedAt: 1,
    ExpiresAt: 10_000, AcceptedAt: 20, MaxUses: maxUses };
  issuance.Signature = signature(incumbent, signatureFrame('pawtalk-protected-invite-v1', trust.serverId, issuer.ProfileID,
    issuer.DeviceID, issuerHead, inviteId, invite.id, '10000', String(maxUses)));
  const actor = { ProfileID: profile.id, DeviceID: device.id };
  const draft = { revision, previousDigest, resultDigest: hex(hash(`state:${revision}`)), digest: successor, operationId: revision.toString().padStart(32, '0'),
    actor, admission: { CutoverDigest: trust.cutoverDigest, ServerKey: encoded(server), Claim: claim, Issuance: issuance } };

  const present = hash('pawtalk-invite-credential-present-v1');
  const entries = [['profile', profileId, present], ['device', incumbent.id, present], ['agreement', recipientKey, present]];
  const issuedCredentials = credentialProofs(entries);
  if (knownAgreement) entries.push(['agreement', agreementKey, present]);
  if (consumed) entries.push(['invite-use', inviteId, hash(signatureFrame('pawtalk-invite-use-leaf-v1', '1', issuance.Signature))]);
  const credentials = credentialProofs(entries);
  const signingKey = hex(incumbent.publicKey), seed = Buffer.from(fixed('9'), 'hex');
  const issuers = inviteIssuerRoot([{ deviceId: incumbent.id, profileId, signingKey }], hex(seed));
  const salt = hex(textRecipientBlind(seed, Buffer.alloc(0), 23, incumbent.id));
  const ranks = fixed('2');
  const successorAux = version === 18 ? { catalogue: fixed('c'), rosters: fixed('d') } : {};
  const issuerAux = issuerVersion === 18 ? { catalogue: fixed('a'), rosters: fixed('b') } : {};
  const previousOpenings = { [profileId]: { salt: fixed('3'), contentSalt: fixed('4') } };
  const archiveOpenings = { [profileId]: { salt: fixed('0'), contentSalt: fixed('1') } };
  const old = { [incumbent.id]: { ProfileID: profileId, Kind: 'device', PublicKey: recipientKey } };
  const rotationGroup = (purpose, openings) => {
    const { salt, contentSalt } = openings[profileId];
    const leaf = hash(signatureFrame(`pawtalk-${purpose}-rotation-profile-v1`, profileId, salt, textRotationDigest(old, contentSalt)));
    return hex(hash(`pawtalk-${purpose}-rotation-profiles-v1:`, leaf));
  };
  const liveProfiles = rotationGroup('live', previousOpenings);
  const archiveProfiles = incumbentArchive ? rotationGroup('archive', archiveOpenings) : hex(hash('pawtalk-archive-rotation-profiles-v1:'));
  const newcomer = { salt: fixed('5'), visible: true, archive, canSend };
  const rotation = { live: fixed('4'), archive: fixed('5'), liveProfiles, archiveProfiles, limitedProfiles: fixed('7'),
    roleViewDenies: fixed('8'), newcomer: textNewcomerAdmissionDigest(newcomer) };
  const statement = { id: incumbent.id, profileId, kind: 'device', publicKey: recipientKey, signingKey,
    archive: incumbentArchive, firstPosition: 1, canSend: true };
  const recipientSalt = fixed('1');
  const textLeaf = (salt, value) => hash('pawtalk-text-recipient-leaf-v1', Buffer.from(salt, 'hex'), JSON.stringify(value));
  const oldLeaf = textLeaf(recipientSalt, statement);
  const recipientRoot = commitmentRoot([oldLeaf]);
  const archiveAudience = fixed('3'), limitedAudience = fixed('2'), orderAuthority = fixed('9');
  const roleRulesDigest = fixed('e');
  const policyDigestFor = (root, projectionVersion = version) => {
    const combined = channelPolicyCombinedDigest(hex(hash('pawtalk-text-revision-policy-v8:', root, archiveAudience,
      limitedAudience, ...Object.values(rotation))), orderAuthority);
    return projectionVersion === 18 ? scopedChannelRoleProjectionDigest(combined, roleRulesDigest) : combined;
  };
  const scopedAux = (credentials, parts) => auxiliaryPolicyDigest(ranks, inviteAdmissionDigest(issuers, credentials),
    parts.catalogue, parts.rosters);
  const channelDigest = policyDigestFor(recipientRoot);
  const prior = policyProofs(channelId, channelDigest, scopedAux(credentials.root, successorAux));
  const issued = policyProofs(channelId, policyDigestFor(recipientRoot, issuerVersion), scopedAux(issuedCredentials.root, issuerAux));
  const predecessor = { revision: 9, digest: policyHead, policyDigest: fixed('6'), projectionVersion: version, root: prior.root };
  const issuerView = { revision: 8, digest: issuerHead, projectionVersion: issuerVersion, root: issued.root };
  const previousTextPolicy = { channelId, revision: 9, policyDigest: predecessor.policyDigest, rotation, archiveAudience, limitedAudience, orderAuthority,
    ...(version === 18 && { roleRulesDigest }),
    inclusion: prior.channel, recipient: { statement, salt: recipientSalt, index: 0, count: 1, siblings: [] } };
  const newcomerStatement = { id: device.id, profileId: profile.id, kind: 'device', publicKey: agreementKey, signingKey: hex(device.publicKey),
    archive, firstPosition, canSend };
  const previousLeaves = previousStatement ? [oldLeaf, textLeaf(recipientSalt, previousStatement)] : [oldLeaf];
  const current = policyProofs(channelId,
    policyDigestFor(commitmentRoot([...previousLeaves, textLeaf(recipientSalt, newcomerStatement)])),
    scopedAux(credentials.root, successorAux));
  const priorSibling = previousLeaves.length === 2 ? branch(...previousLeaves) : oldLeaf;
  const newcomerTextPolicy = { ...previousTextPolicy, revision, policyDigest: draft.resultDigest, inclusion: current.channel,
    recipient: { statement: newcomerStatement, salt: recipientSalt, index: previousLeaves.length,
      count: previousLeaves.length + 1, siblings: [hex(priorSibling)] } };
  draft.projectionRoot = current.root;
  draft.signature = signature(server, signatureFrame('pawtalk-protected-invite-scoped-receipt-v1', trust.serverId, String(revision),
    draft.previousDigest, draft.resultDigest, draft.projectionRoot, draft.digest, draft.operationId, actor.ProfileID, actor.DeviceID,
    trust.cutoverDigest, draft.admission.ServerKey, inviteId, operationId, claim.invitePublicKey, claim.profilePublicKey,
    claim.devicePublicKey, agreementKey, claim.nickname, claim.inviteSignature, claim.profileSignature, claim.deviceSignature,
    issuer.ProfileID, issuer.DeviceID, '8', issuerHead, '10000', '1', '10000', '20', String(maxUses), issuance.Signature));
  const freshness = { issuers, credentials: credentials.root, ranks, ...successorAux, inclusion: prior.auxiliary };
  for (const [kind, id] of [['profile', profile.id], ['device', device.id], ['agreement', agreementKey]]) freshness[kind] = credentials.opening(kind, id);
  freshness.use = { ...(consumed ? { count: 1, issueSignature: issuance.Signature } : { count: 0 }), path: credentials.opening('invite-use', inviteId) };
  const issuerAuthority = { issuers, credentials: issuedCredentials.root, ranks, ...issuerAux, inclusion: issued.auxiliary,
    opening: { signingKey, salt, proof: { index: 0, count: 1, siblings: [] } } };
  const task = { ChannelID: channelId, Purpose: 'live', Revision: revision, PolicyDigest: draft.resultDigest,
    Recipients: { ...old, [device.id]: { ProfileID: profile.id, Kind: 'device', PublicKey: agreementKey } },
    inviteAdmission: { previousRevision: 9, previousHead: policyHead, successorHead: successor, draft, previousTextPolicy,
      newcomer, newcomerTextPolicy, previousOpenings, issuerAuthority, freshness } };
  return { trust, predecessor, issuerView, task, recipient: { recipientId: incumbent.id, profileId, recipientKey, purpose: 'live' }, actor,
    newcomerRecipient: { recipientId: device.id, profileId: profile.id, recipientKey: agreementKey, purpose: 'live' }, archiveOpenings };
}

function verify({ trust, predecessor, issuerView, task, recipient }) {
  return verifyLiveInviteAdmission(trust, predecessor, issuerView, task, recipient);
}

test('v17 scoped invite claim authenticates historical issuer, acceptance and exact live audience', () => {
  const basis = fixture();
  const { admission, liveTransitionDigest } = verify(basis);
  assert.equal(admission.id, basis.recipient.recipientId);
  assert.equal(liveTransitionDigest, liveInviteAdmissionDigest(basis.task, basis.task.inviteAdmission));
  assert.equal(basis.task.Recipients[basis.actor.DeviceID].Kind, 'device');
});

test('v17 scoped invite LIVE epoch marker matches the Go vector', () => {
  const record = { ChannelID: '9'.repeat(32), Purpose: 'live', Revision: 7, PolicyDigest: fixed('f') };
  const proof = { previousRevision: 6, previousHead: fixed('b'), successorHead: fixed('e'), draft: {
    operationId: '4'.repeat(32), actor: { ProfileID: key(3).id, DeviceID: key(2).id }, signature: Buffer.alloc(64, 5).toString('base64'),
  } };
  assert.equal(liveInviteAdmissionDigest(record, proof), '9cc7fea094540ae6b11988cdae16fb02fe2d1535a34858253870eff8f6a0dc37');
});

test('v17 scoped invite claim rejects forged witnesses, historic access and a roster widened beyond one fresh device', () => {
  for (const change of [
    ({ task }) => { task.inviteAdmission.draft.signature = Buffer.alloc(64).toString('base64'); },
    ({ task }) => { task.inviteAdmission.draft.projectionRoot = fixed('0'); },
    ({ task }) => { task.inviteAdmission.newcomerTextPolicy.recipient.statement.firstPosition = 2; },
    ({ task }) => { task.inviteAdmission.draft.admission.Claim.profileSignature = Buffer.alloc(64).toString('base64url'); },
    ({ task }) => { task.inviteAdmission.issuerAuthority.opening.signingKey = fixed('0'); },
    ({ task }) => { task.inviteAdmission.freshness.use.path = []; },
    ({ task, recipient }) => { task.Recipients[recipient.recipientId].PublicKey = fixed('f'); },
    ({ task, actor }) => { task.Recipients[fixed('f')] = { ...task.Recipients[actor.DeviceID] }; },
    ({ task }) => { task.ArchiveThrough = 1; },
    ({ task }) => { task.Purpose = 'archive'; },
    ({ recipient, actor }) => { recipient.profileId = actor.ProfileID; recipient.recipientId = actor.DeviceID; },
    ({ predecessor }) => { predecessor.projectionVersion = 16; },
    ({ issuerView }) => { issuerView.revision = 9; },
  ]) {
    const basis = fixture();
    change(basis);
    assert.throws(() => verify(basis));
  }
  assert.throws(() => verify(fixture({ consumed: true })), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  assert.throws(() => verify(fixture({ knownAgreement: true })), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
});

function deliveryFixture(basis, newcomer) {
  const { task, recipient } = basis;
  const { previousOpenings, previousTextPolicy, ...proof } = task.inviteAdmission;
  const archive = task.Purpose === 'archive';
  const marker = inviteAdmissionEpochDigest(task, proof);
  const Record = { ChannelID: task.ChannelID, Purpose: task.Purpose, Generation: 4, Revision: task.Revision, PolicyDigest: task.PolicyDigest,
    KeyID: fixed('5'), ...(archive ? { ArchiveThrough: task.ArchiveThrough, ArchiveTransitionDigest: marker } : { LiveTransitionDigest: marker }) };
  return { Epoch: { Record, Principal: { ProfileID: recipient.profileId, DeviceID: recipient.recipientId } },
    [archive ? 'archiveInviteAdmission' : 'liveInviteAdmission']: { ...proof, previousSignerTextPolicy: previousTextPolicy,
      ...(!newcomer && { previousTextPolicy }) } };
}

test('v17 staged marked epoch authorizes only exact incumbent and newcomer reads and authors', () => {
  const basis = fixture();
  const { trust, predecessor, issuerView, recipient, newcomerRecipient, actor } = basis;
  const retained = deliveryFixture(basis, false), newcomer = deliveryFixture(basis, true);
  const { Epoch: { Record: record, Principal: incumbent } } = newcomer;
  const signer = verifyLiveInviteEpochSigner(trust, predecessor, issuerView, newcomer.Epoch, newcomer.liveInviteAdmission);
  assert.equal(signer.signer.deviceId, recipient.recipientId);
  assert.equal(verifyLiveInviteAdmissionDelivery(trust, predecessor, issuerView, retained, recipient).admission.firstPosition, 1);
  const transition = verifyLiveInviteAdmissionDelivery(trust, predecessor, issuerView, newcomer, newcomerRecipient);
  assert.equal(transition.admission.firstPosition, 8);
  assert.equal(transition.admission.archive, false);
  assert.equal(verifyLiveInviteAdmissionAuthor(transition, record, actor, undefined, 8).key, transition.admission.signingKey);
  const prior = newcomer.liveInviteAdmission.previousSignerTextPolicy;
  assert.equal(verifyLiveInviteAdmissionAuthor(transition, record, incumbent, prior, 8).key, signer.signer.key);
  assert.throws(() => verifyLiveInviteAdmissionAuthor(transition, record, actor, undefined, 7), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  assert.throws(() => verifyLiveInviteAdmissionAuthor(transition, { ...record, Generation: 3 }, actor, undefined, 8),
    { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  assert.throws(() => verifyLiveInviteAdmissionAuthor(transition, record, { ...actor, DeviceID: incumbent.DeviceID }, prior, 8));
  assert.throws(() => verifyLiveInviteAdmissionDelivery(trust, predecessor, issuerView, newcomer, recipient));
  assert.throws(() => verifyLiveInviteAdmissionDelivery(trust, predecessor, issuerView, retained, newcomerRecipient));
  assert.throws(() => verifyLiveInviteAdmissionDelivery(trust, predecessor, issuerView, newcomer,
    { ...newcomerRecipient, purpose: 'archive' }), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
});

test('v17 staged marked epoch rejects substituted signer, epoch and newcomer send authority', () => {
  const basis = fixture({ canSend: false });
  const { trust, predecessor, issuerView, newcomerRecipient, actor } = basis;
  const delivery = deliveryFixture(basis, true);
  const { Epoch: { Record: record } } = delivery;
  const transition = verifyLiveInviteAdmissionDelivery(trust, predecessor, issuerView, delivery, newcomerRecipient);
  assert.equal(transition.admission.canSend, false);
  assert.throws(() => verifyLiveInviteAdmissionAuthor(transition, record, actor, undefined, 8), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  assert.throws(() => verifyLiveInviteEpochSigner(trust, predecessor, issuerView, { ...delivery.Epoch, Principal: actor }, delivery.liveInviteAdmission),
    { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  assert.throws(() => verifyLiveInviteEpochSigner(trust, predecessor, issuerView,
    { ...delivery.Epoch, Record: { ...record, LiveTransitionDigest: fixed('0') } }, delivery.liveInviteAdmission),
  { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  delivery.liveInviteAdmission.newcomerTextPolicy.recipient.statement.canSend = true;
  assert.throws(() => verifyLiveInviteAdmissionDelivery(trust, predecessor, issuerView, delivery, newcomerRecipient));
});

function archiveFixture(options) {
  const basis = fixture({ archive: true, ...options });
  basis.task = { ...basis.task, Purpose: 'archive', ArchiveThrough: 6, inviteAdmission: {
    ...basis.task.inviteAdmission, previousOpenings: basis.archiveOpenings,
  } };
  basis.recipient.purpose = 'archive';
  basis.newcomerRecipient.purpose = 'archive';
  return basis;
}

test('v17 full-history invitation authenticates separate LIVE and ARCHIVE claims and addressed deliveries', () => {
  const live = fixture({ archive: true });
  const { liveTransitionDigest } = verify(live);
  const liveDelivery = deliveryFixture(live, true);
  const liveTransition = verifyLiveInviteAdmissionDelivery(live.trust, live.predecessor, live.issuerView, liveDelivery, live.newcomerRecipient);
  assert.equal(liveTransition.admission.archive, true);
  assert.equal(liveTransition.liveTransitionDigest, liveTransitionDigest);
  assert.equal(liveTransition.admission.firstPosition, 8);
  assert.throws(() => verifyLiveInviteAdmissionAuthor(liveTransition, liveDelivery.Epoch.Record, live.actor, undefined, 7));

  const basis = archiveFixture();
  const { trust, predecessor, issuerView, task, recipient, newcomerRecipient, actor } = basis;
  const { archiveTransitionDigest, admission } = verifyInviteAdmissionRotation(trust, predecessor, issuerView, task, recipient);
  assert.equal(admission.archive, true);
  assert.notEqual(archiveTransitionDigest, liveTransitionDigest);
  const delivery = deliveryFixture(basis, true);
  const read = verifyInviteAdmissionDelivery(trust, predecessor, issuerView, delivery, newcomerRecipient);
  assert.equal(read.admission.archive, true);
  assert.equal(read.archiveTransitionDigest, archiveTransitionDigest);
  assert.equal(read.admission.firstPosition, 8);
  assert.equal(verifyInviteAdmissionDelivery(trust, predecessor, issuerView, deliveryFixture(basis, false), recipient).admission.id,
    recipient.recipientId);
  assert.equal(verifyInviteAdmissionEpochSigner(trust, predecessor, issuerView, delivery.Epoch,
    delivery.archiveInviteAdmission).signer.deviceId, recipient.recipientId);
  assert.throws(() => verifyLiveInviteAdmissionAuthor(read, delivery.Epoch.Record, actor, undefined, 8));
});

test('v17 ARCHIVE invitation rejects limited members, the LIVE marker, prior LIVE openings and missing coverage', () => {
  const resolve = ({ trust, predecessor, issuerView, task, recipient }) =>
    verifyInviteAdmissionRotation(trust, predecessor, issuerView, task, recipient);
  assert.throws(() => resolve(archiveFixture({ archive: false, incumbentArchive: true })), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  assert.throws(() => resolve(archiveFixture({ incumbentArchive: false })), { code: 'INVALID_CHANNEL_POLICY_PROOF' });
  const basis = archiveFixture();
  const { trust, predecessor, issuerView, task, newcomerRecipient } = basis;
  task.inviteAdmission.previousOpenings = fixture({ archive: true }).task.inviteAdmission.previousOpenings;
  assert.throws(() => resolve(basis), { code: 'INVALID_CHANNEL_POLICY_PROOF' });
  const delivery = deliveryFixture(basis, true);
  const { Record: record } = delivery.Epoch;
  record.ArchiveTransitionDigest = inviteAdmissionEpochDigest({ ...record, Purpose: 'live' }, delivery.archiveInviteAdmission);
  assert.throws(() => verifyInviteAdmissionDelivery(trust, predecessor, issuerView, delivery, newcomerRecipient),
    { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  task.ArchiveThrough = 0;
  assert.throws(() => resolve(basis), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
});

function batchFixture({ archive = false, maxUses = 3, secondApplicant = [6, 7], secondAgreement = '0b' + '00'.repeat(31),
  secondRevision = 11, secondPreviousHead, version = 17, issuerVersion = version } = {}) {
  const first = fixture({ archive, maxUses, consumed: true, version, issuerVersion });
  const previous = first.task.inviteAdmission;
  const second = fixture({ archive, maxUses, consumed: true, revision: secondRevision, previousDigest: secondPreviousHead ?? previous.draft.digest,
    applicantSeeds: secondApplicant, agreementKey: secondAgreement, previousStatement: previous.newcomerTextPolicy.recipient.statement,
    version, issuerVersion });
  const successor = second.task.inviteAdmission;
  const entry = ({ draft, newcomerTextPolicy, issuerAuthority, freshness }) => ({ draft, newcomerTextPolicy, issuerAuthority, freshness });
  const purpose = archive ? 'archive' : 'live';
  const task = { ...second.task, Purpose: purpose, Recipients: { ...first.task.Recipients, ...second.task.Recipients },
    ...(archive && { ArchiveThrough: 6 }), inviteAdmissions: {
      previousRevision: previous.previousRevision, previousHead: previous.previousHead, successorHead: successor.draft.digest,
      newcomer: previous.newcomer, previousTextPolicy: previous.previousTextPolicy,
      previousOpenings: archive ? first.archiveOpenings : previous.previousOpenings, admissions: [entry(previous), entry(successor)],
    } };
  delete task.inviteAdmission;
  return { trust: first.trust, predecessor: first.predecessor, issuanceViews: new Map([[first.issuerView.revision, first.issuerView]]),
    task, recipient: { ...first.recipient, purpose }, applicants: [first.newcomerRecipient, second.newcomerRecipient] };
}

function verifyBatch({ trust, predecessor, issuanceViews, task, recipient }) {
  return verifyInviteAdmissionBatchRotation(trust, predecessor, issuanceViews, task, recipient);
}

test('v18 uses the authenticated predecessor version for invite recipients and accepts a v17 issuance', () => {
  const basis = archiveFixture({ version: 18, issuerVersion: 17 });
  const { trust, predecessor, issuerView, task, recipient, newcomerRecipient } = basis;
  const { archiveTransitionDigest } = verifyInviteAdmissionRotation(trust, predecessor, issuerView, task, recipient);
  const delivery = deliveryFixture(basis, true);
  const read = verifyInviteAdmissionDelivery(trust, predecessor, issuerView, delivery, newcomerRecipient);
  assert.equal(read.archiveTransitionDigest, archiveTransitionDigest);
  assert.equal(read.admission.archive, true);
  const wrong = structuredClone(basis);
  wrong.task.inviteAdmission.newcomerTextPolicy.roleRulesDigest = fixed('f');
  assert.throws(() => verifyInviteAdmissionRotation(wrong.trust, wrong.predecessor, wrong.issuerView, wrong.task, wrong.recipient));
  const batch = batchFixture({ version: 18, issuerVersion: 17 });
  assert.equal(verifyBatch(batch).liveTransitionDigest, inviteAdmissionBatchDigest(batch.task, batch.task.inviteAdmissions));
  const archiveBatch = batchFixture({ archive: true, version: 18 });
  assert.equal(verifyBatch(archiveBatch).archiveTransitionDigest, inviteAdmissionBatchDigest(archiveBatch.task, archiveBatch.task.inviteAdmissions));
});

test('v17 batches verify two distinct admissions against one attestation and charge their shared invite twice', () => {
  const live = batchFixture();
  const { admission, liveTransitionDigest } = verifyBatch(live);
  assert.equal(admission.id, live.recipient.recipientId);
  assert.equal(live.task.inviteAdmissions.admissions.every(entry => entry.freshness.use.count === 1), true);
  assert.equal(liveTransitionDigest, inviteAdmissionBatchDigest(live.task, live.task.inviteAdmissions));
  const archive = batchFixture({ archive: true });
  assert.equal(verifyBatch(archive).admission.archive, true);
  assert.notEqual(verifyBatch(archive).archiveTransitionDigest, liveTransitionDigest);
  assert.throws(() => verifyBatch(batchFixture({ maxUses: 2 })), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
});

test('v17 batch delivery selects the addressed applicant and authenticates both newcomer authors', () => {
  for (const archive of [false, true]) {
    const { trust, predecessor, issuanceViews, task, applicants, recipient } = batchFixture({ archive });
    const { previousTextPolicy: previousSignerTextPolicy, previousOpenings, ...proof } = task.inviteAdmissions;
    const marker = inviteAdmissionBatchDigest(task, task.inviteAdmissions);
    const Record = { ...task, Generation: 7, KeyID: fixed('9'),
      ...(archive ? { ArchiveTransitionDigest: marker } : { LiveTransitionDigest: marker }) };
    const field = archive ? 'archiveInviteAdmissions' : 'liveInviteAdmissions';
    const delivery = { Epoch: { Record, Principal: { ProfileID: recipient.profileId, DeviceID: recipient.recipientId } },
      [field]: { ...proof, previousSignerTextPolicy } };
    for (const applicant of applicants) {
      const own = { ...applicant, purpose: task.Purpose };
      const transition = verifyInviteAdmissionBatchDelivery(trust, predecessor, issuanceViews, delivery, own);
      assert.equal(transition.admission.id, own.recipientId);
      assert.equal(transition.signer.deviceId, recipient.recipientId);
      if (!archive) {
        const author = { ProfileID: own.profileId, DeviceID: own.recipientId };
        assert.equal(verifyLiveInviteAdmissionBatchAuthor(transition, Record, author, undefined, transition.admission.firstPosition).deviceId,
          own.recipientId);
        assert.throws(() => verifyLiveInviteAdmissionBatchAuthor(transition, Record, author, undefined,
          transition.admission.firstPosition - 1), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
      }
    }
    assert.throws(() => verifyInviteAdmissionBatchDelivery(trust, predecessor, issuanceViews, delivery,
      { ...applicants[0], recipientId: applicants[1].recipientId, purpose: task.Purpose }), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  }
});

test('v17 invitation batch markers match the Go vectors in receipt order', () => {
  const record = { ChannelID: '9'.repeat(32), Revision: 7, PolicyDigest: fixed('d') };
  const proof = { previousRevision: 5, previousHead: fixed('a'), successorHead: fixed('c'), admissions: [
    { draft: { revision: 6, previousDigest: fixed('a'), digest: fixed('b'), signature: Buffer.alloc(64, 1).toString('base64') } },
    { draft: { revision: 7, previousDigest: fixed('b'), digest: fixed('c'), resultDigest: fixed('d'), signature: Buffer.alloc(64, 2).toString('base64') } },
  ] };
  assert.equal(inviteAdmissionBatchDigest({ ...record, Purpose: 'live' }, proof),
    'ac68232ad3b2ae6f5573d002e96d0e0af8b3be935507bd8145f1e6d44ace59bc');
  assert.equal(inviteAdmissionBatchDigest({ ...record, Purpose: 'archive' }, proof),
    '99ce1b8e3e7faaffd1211d30d9eaa059b0cbe26b1e88093914a153c736dea536');
});

test('v17 batches reject skipped receipts, re-used credentials and widened membership', () => {
  for (const options of [{ secondRevision: 12 }, { secondPreviousHead: fixed('f') }, { secondApplicant: [4, 7] },
    { secondApplicant: [6, 5] }, { secondAgreement: '0a' + '00'.repeat(31) }]) {
    assert.throws(() => verifyBatch(batchFixture(options)), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  }
  const reversed = batchFixture();
  const proof = reversed.task.inviteAdmissions;
  proof.admissions.reverse();
  assert.throws(() => inviteAdmissionBatchDigest(reversed.task, proof), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  assert.throws(() => verifyBatch(reversed), { code: 'INVALID_PROTECTED_INVITE_PROOF' });

  for (const change of [
    ({ issuanceViews }) => issuanceViews.clear(),
    ({ task }) => { task.inviteAdmissions.admissions[1].freshness.use.count = 0; },
    ({ task }) => { task.inviteAdmissions.admissions[1].newcomerTextPolicy.recipient.statement.firstPosition = 1; },
    ({ task }) => { task.inviteAdmissions.admissions[1].draft.signature = Buffer.alloc(64).toString('base64'); },
    ({ task, applicants }) => { delete task.Recipients[applicants[1].recipientId]; },
    ({ task, recipient }) => { task.Recipients[fixed('f')] = { ...task.Recipients[recipient.recipientId] }; },
    basis => { basis.recipient = basis.applicants[0]; },
  ]) {
    const basis = batchFixture();
    change(basis);
    assert.throws(() => verifyBatch(basis));
  }
});
