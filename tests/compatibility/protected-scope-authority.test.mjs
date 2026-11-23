import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import test from 'node:test';
import authority from '../../apps/client/windows/electron/protected-scope-authority.cjs';
import attestations from '../../apps/client/windows/electron/protected-policy-attestation.cjs';
import policyCheckpoint from '../../apps/client/windows/electron/protected-policy-checkpoint.cjs';
import membership from '../../shared/membership.cjs';

const { scopeAuthorityGenesis, signScopeAuthorityLink, advanceScopeAuthority, verifyScopeAuthorityChain } = authority;
const { signatureFrame } = membership;
const hash = value => createHash('sha256').update(value).digest('hex');
const privateKey = seed => createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]),
  format: 'der',
  type: 'pkcs8',
});
const publicKey = key => createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const hex = (number, width) => number.toString(16).padStart(width, '0');

function fixture() {
  const genesis = privateKey(1), device = privateKey(2), nextDevice = privateKey(3);
  const recovery = privateKey(4), nextRecovery = privateKey(5);
  const genesisKey = publicKey(genesis);
  const trust = { serverId: '1'.repeat(32), cutoverDigest: '2'.repeat(64), anchorDigest: '3'.repeat(64),
    ownerProfileId: '4'.repeat(64), ownerDeviceId: hash(Buffer.from(genesisKey, 'hex')) };
  const recoveryId = '5'.repeat(64), nextRecoveryId = '6'.repeat(64);
  const checkpoints = [scopeAuthorityGenesis(trust, genesisKey)];
  const links = [
    ['recovery.authorize', 2, recoveryId, recovery, genesis, genesis],
    ['recovery.device', 9, recoveryId, recovery, device, recovery, device],
    ['recovery.authorize', 18, nextRecoveryId, nextRecovery, device, device],
    ['recovery.device', 42, nextRecoveryId, nextRecovery, nextDevice, nextRecovery, nextDevice],
  ].map(([action, revision, recoveryId, recovery, device, authorizer, consent]) => {
    const cursor = checkpoints.at(-1);
    const link = signScopeAuthorityLink(trust, cursor, { action, revision, policyHead: hex(revision - 1, 64),
      operationId: hex(revision, 32), recoveryId, recoveryKey: publicKey(recovery), deviceKey: publicKey(device) }, authorizer, consent);
    checkpoints.push(advanceScopeAuthority(trust, cursor, link));
    return link;
  });
  return { trust, genesis, genesisKey, device, nextDevice, recovery, nextRecovery, links, checkpoints };
}

// Independent framing keeps invalid test links correctly signed by the intended (or retired) key.
function withProofs(trust, link, authorizer, device) {
  const { serverId, cutoverDigest, anchorDigest, ownerProfileId } = trust;
  const { sequence, previous, action, revision, policyHead, operationId, recoveryId, recoveryKey, deviceKey } = link;
  const frame = signatureFrame('pawtalk-scope-authority-link-v1', serverId, cutoverDigest, anchorDigest, ownerProfileId,
    String(sequence), previous, action, String(revision), policyHead, operationId, recoveryId, recoveryKey, deviceKey);
  const authorization = sign(null, frame, authorizer).toString('base64url');
  const consent = signatureFrame('pawtalk-scope-authority-device-consent-v1', hash(frame), authorization);
  return { ...link, authorization, deviceProof: device ? sign(null, consent, device).toString('base64url') : '' };
}

test('scope authority uses the pinned genesis and extends a saved prefix across repeated recovery', () => {
  const { trust, genesisKey, links, checkpoints, nextDevice } = fixture();
  const head = verifyScopeAuthorityChain(trust, genesisKey, links, checkpoints[2]);
  assert.deepEqual(head, checkpoints[4]);
  assert.equal(head.deviceKey, publicKey(nextDevice));
  assert.equal(head.revision, 42);
  assert.equal(head.digest, '91ddbc511ccd4d2605b9720852c8adc650031ddc46f1487436e9c6ea98053697');
  assert.deepEqual(head.retiredKeys, [genesisKey, links[0].recoveryKey, links[1].deviceKey]);
  const omitted = { ...links[0] };
  delete omitted.deviceProof;
  assert.deepEqual(verifyScopeAuthorityChain(trust, genesisKey, [omitted, ...links.slice(1)]), head);
  assert.throws(() => verifyScopeAuthorityChain(trust, genesisKey, links.slice(0, 2), head), { code: 'SCOPE_AUTHORITY_ROLLBACK' });
  assert.throws(() => verifyScopeAuthorityChain(trust, genesisKey, links, { ...checkpoints[2], digest: '9'.repeat(64) }),
    { code: 'SCOPE_AUTHORITY_FORK' });
  assert.throws(() => verifyScopeAuthorityChain(trust, publicKey(nextDevice), links), { code: 'INVALID_SCOPE_AUTHORITY' });
  assert.throws(() => verifyScopeAuthorityChain({ ...trust, cutoverDigest: '8'.repeat(64) }, genesisKey, links),
    { code: 'INVALID_SCOPE_AUTHORITY' });
});

test('scope authority rejects replayed operations, retired keys, ill-formed public points and unauthorized consent', () => {
  const { trust, genesis, genesisKey, device, nextDevice, recovery, nextRecovery, links } = fixture();
  const variations = [
    [0, { recoveryKey: '02' + '00'.repeat(31) }, genesis],
    [0, { recoveryKey: '01' + '00'.repeat(31) }, genesis],
    [0, { deviceProof: links[1].deviceProof }],
    [0, { authorization: links[0].authorization + '=' }],
    [1, { deviceProof: '' }],
    [1, {}, recovery, nextDevice],
    [2, { policyHead: 'b'.repeat(64) }],
    [2, { operationId: links[0].operationId }, device],
    [2, { recoveryId: links[0].recoveryId }, device],
    [2, { recoveryKey: genesisKey }, device],
    [2, {}, genesis],
    [3, {}, recovery, nextDevice],
    [3, { deviceKey: links[0].recoveryKey }, nextRecovery, recovery],
  ];
  for (const [index, patch, signer, consent] of variations) {
    let altered = { ...links[index], ...patch };
    if (signer) altered = withProofs(trust, altered, signer, consent);
    assert.throws(() => verifyScopeAuthorityChain(trust, genesisKey, [...links.slice(0, index), altered]),
      { code: 'INVALID_SCOPE_AUTHORITY' });
  }
});

test('detached authority can introduce the recovery key at genesis only against the pinned anchor', () => {
  const { trust, genesis, genesisKey, recovery, device, checkpoints, links } = fixture();
  const fields = { ...links[0], revision: 1, policyHead: trust.anchorDigest };
  const detached = signScopeAuthorityLink(trust, checkpoints[0], fields, genesis);
  const authorized = advanceScopeAuthority(trust, checkpoints[0], detached);
  assert.equal(authorized.revision, 1);
  assert.equal(authorized.deviceKey, genesisKey);
  assert.throws(() => signScopeAuthorityLink(trust, checkpoints[0], { ...fields, policyHead: '7'.repeat(64) }, genesis),
    { code: 'INVALID_SCOPE_AUTHORITY' });
  assert.throws(() => signScopeAuthorityLink(trust, authorized, { ...fields, operationId: 'a'.repeat(32) }, genesis),
    { code: 'INVALID_SCOPE_AUTHORITY' });
  const transfer = signScopeAuthorityLink(trust, authorized, { ...links[1], revision: 2, policyHead: trust.anchorDigest }, recovery, device);
  const second = verifyScopeAuthorityChain(trust, genesisKey, [detached, transfer], authorized);
  assert.equal(second.deviceKey, publicKey(device));
  assert.equal(second.revision, 2);
});

function transferFixture() {
  const owner = privateKey(81), recipient = privateKey(82), other = privateKey(83), third = privateKey(84);
  const ownerRecovery = privateKey(85), recipientRecovery = privateKey(86);
  const deviceId = key => hash(Buffer.from(publicKey(key), 'hex'));
  const ownerProfileId = '4'.repeat(64), targetProfileId = '5'.repeat(64);
  const trust = { serverId: '1'.repeat(32), cutoverDigest: '2'.repeat(64), anchorDigest: '3'.repeat(64),
    ownerProfileId, ownerDeviceId: deviceId(owner) };
  const ownerRecoveryId = '6'.repeat(64), targetRecoveryId = '7'.repeat(64);
  const snapshot = {
    Owner: ownerProfileId,
    Members: { [ownerProfileId]: { ID: ownerProfileId, Active: true, Roles: [] },
      [targetProfileId]: { ID: targetProfileId, Active: true, Roles: [] } },
    PolicyDevices: Object.fromEntries([owner, recipient, other, third].map((key, index) => [deviceId(key), {
      ProfileID: index === 0 ? ownerProfileId : targetProfileId, PublicKey: publicKey(key),
    }])),
    RecoveryReady: { [ownerProfileId]: true, [targetProfileId]: true },
    RecoveryIdentities: {
      [ownerProfileId]: { ID: ownerRecoveryId, SigningKey: publicKey(ownerRecovery), AgreementKey: 'b'.repeat(64) },
      [targetProfileId]: { ID: targetRecoveryId, SigningKey: publicKey(recipientRecovery), AgreementKey: 'c'.repeat(64) },
    },
    KeyRecipients: {
      [ownerRecoveryId]: { ProfileID: ownerProfileId, Kind: 'recovery', PublicKey: 'b'.repeat(64) },
      [targetRecoveryId]: { ProfileID: targetProfileId, Kind: 'recovery', PublicKey: 'c'.repeat(64) },
    },
    Channels: {}, Admissions: {},
  };
  const preview = (cursor, pending, { headRevision, policyHead, operationId, expiresAt }) => {
    const candidates = authority.ownerTransferCandidates(snapshot, pending);
    const leaves = candidates.map(candidate => candidate.signingKey).sort().map(key => hash(signatureFrame('pawtalk-owner-transfer-candidate-v1', key)));
    let level = leaves;
    while (level.length > 1) {
      const parents = [];
      for (let offset = 0; offset < level.length; offset += 2) {
        const left = level[offset], right = level[offset + 1] ?? left;
        parents.push(hash(signatureFrame('pawtalk-owner-transfer-node-v1', left, right)));
      }
      level = parents;
    }
    const identity = snapshot.RecoveryIdentities[pending];
    return { headRevision, policyHead, operationId, expiresAt, authorization: '', targetProfileId: pending,
      ownerProfileId: cursor.ownerProfileId, ownerDeviceId: cursor.deviceId, sequence: cursor.sequence + 1, previous: cursor.digest,
      recoveryId: identity.ID, recoveryKey: identity.SigningKey, candidates,
      candidatesRoot: hash(signatureFrame('pawtalk-owner-transfer-root-v1', String(leaves.length), level[0])) };
  };
  return { trust, snapshot, preview, owner, ownerRecovery, recipient, recipientRecovery, ownerProfileId, targetProfileId };
}

test('owner transfer proves the chosen key using the full roster and preserves authority after a transfer back', () => {
  const { trust, snapshot, preview, owner, ownerRecovery, recipient, targetProfileId } = transferFixture();
  const origin = scopeAuthorityGenesis(trust, publicKey(owner));
  const original = signScopeAuthorityLink(trust, origin, { action: 'recovery.authorize', revision: 2, policyHead: trust.anchorDigest,
    operationId: '8'.repeat(32), recoveryId: '6'.repeat(64), recoveryKey: publicKey(ownerRecovery), deviceKey: publicKey(owner) }, owner);
  const prior = advanceScopeAuthority(trust, origin, original);
  const unsigned = preview(prior, targetProfileId, {
    headRevision: 6, policyHead: '9'.repeat(64), operationId: 'a'.repeat(32), expiresAt: 5678,
  });
  const offer = authority.buildScopeOwnerTransferOffer(trust, prior, unsigned, snapshot, owner);
  const link = authority.acceptScopeOwnerTransferOffer(trust, prior, offer, recipient);
  assert.equal(link.transfer.count, 3);
  assert.equal(link.transfer.siblings.length, 2);
  const next = advanceScopeAuthority(trust, prior, link);
  assert.equal(next.ownerProfileId, targetProfileId);
  assert.equal(next.deviceKey, publicKey(recipient));
  assert.equal(next.ownershipTransferred, true);
  const reversed = preview(next, trust.ownerProfileId, {
    headRevision: 7, policyHead: 'b'.repeat(64), operationId: 'c'.repeat(32), expiresAt: 5679,
  });
  const reverse = authority.buildScopeOwnerTransferOffer(trust, next, reversed, { ...snapshot, Owner: targetProfileId }, recipient);
  const back = authority.acceptScopeOwnerTransferOffer(trust, next, reverse, owner);
  const end = verifyScopeAuthorityChain(trust, publicKey(owner), [original, link, back], next);
  assert.equal(end.ownerProfileId, trust.ownerProfileId);
  assert.equal(end.deviceId, trust.ownerDeviceId);
  assert.equal(end.ownershipTransferred, true);
  assert.equal(end.digest, '5335ef6a3fd1c8c52c16237bb8ae3b50e23966b5309f0770d139b3a1c8e44bdb');
  assert.deepEqual(end.retiredKeys, []);

  assert.throws(() => authority.buildScopeOwnerTransferOffer(trust, prior,
    { ...unsigned, candidates: unsigned.candidates.slice(0, 1) }, snapshot, owner), { code: 'INVALID_SCOPE_AUTHORITY' });
  assert.throws(() => authority.acceptScopeOwnerTransferOffer(trust, prior, offer, owner), { code: 'INVALID_SCOPE_AUTHORITY' });
  for (const changed of [{ ...link, targetProfileId: 'd'.repeat(64) },
    { ...link, transfer: { ...link.transfer, cutoverDigest: 'd'.repeat(64) } },
    { ...link, transfer: { ...link.transfer, siblings: ['d'.repeat(64), link.transfer.siblings[1]] } },
    { ...link, deviceProof: back.deviceProof }]) {
    assert.throws(() => advanceScopeAuthority(trust, prior, changed), { code: 'INVALID_SCOPE_AUTHORITY' });
  }

  const { policyAttestationFrame, verifyPolicyAttestation } = attestations;
  const view = { revision: 7, digest: 'a'.repeat(64), previous: '9'.repeat(64), policyDigest: 'b'.repeat(64),
    root: 'c'.repeat(64), authorityHead: next.digest, authorityRevision: next.revision, signerProfileId: next.ownerProfileId,
    signerDeviceId: next.deviceId, signerKey: next.deviceKey, projectionVersion: 8 };
  view.signature = sign(null, policyAttestationFrame(trust, view), recipient).toString('base64');
  assert.deepEqual(verifyPolicyAttestation(trust, view, { state: next }), view);
  assert.throws(() => verifyPolicyAttestation(trust, { ...view, signerProfileId: trust.ownerProfileId }, { state: next }),
    { code: 'INVALID_POLICY_ATTESTATION' });
});

test('full policy verifies owner.transfer, leaves roles intact and rejects a fabricated roster', async () => {
  const { trust: binding, snapshot, preview, owner, recipient, targetProfileId } = transferFixture();
  const { ProtectedPolicyCheckpoint, protectedPolicySignatureFrame } = policyCheckpoint;
  const server = privateKey(87);
  const channelId = '3'.repeat(32);
  snapshot.Channels[channelId] = { Kind: 'text', ACL: {} };
  snapshot.Admissions[channelId] = { [binding.ownerProfileId]: { FirstPosition: 1 } };
  const ownerActor = { ProfileID: binding.ownerProfileId, DeviceID: binding.ownerDeviceId };
  const trust = { ...binding, serverId: hash(Buffer.from(publicKey(server), 'hex')).slice(0, 32) };
  const record = (proof, state, privateKey, change) => {
    const raw = Buffer.from(JSON.stringify(state));
    const draft = { ...proof, ResultDigest: hash(raw), RoleUpdate: null, PublicKey: '', Signature: '' };
    let details;
    if (change) {
      draft.PublicKey = Buffer.from(publicKey(server), 'hex').toString('base64url');
      draft.ResourceChange = change;
      details = Buffer.from(JSON.stringify(change));
    }
    let frame = protectedPolicySignatureFrame(trust.serverId, ownerActor, draft, Buffer.from('null'), details ? [hash(details)] : []);
    if (details) frame = signatureFrame('pawtalk-protected-owner-transfer-proof-v1', hash(frame));
    const proofSignature = sign(null, frame, privateKey);
    draft.Signature = proofSignature.toString('base64');
    return { digest: hash(proofSignature), entry: { record: Buffer.from(JSON.stringify({ Principal: ownerActor, Draft: draft })).toString('base64'),
      snapshot: raw.toString('base64'), roleUpdate: 'bnVsbA==', ...(details && { resourceChange: details.toString('base64') }) } };
  };
  const anchored = record({ Action: 'policy.anchor', Revision: 1, OperationID: '1'.repeat(32), PreviousDigest: '' }, snapshot, owner);
  trust.anchorDigest = anchored.digest;
  const cursor = scopeAuthorityGenesis(trust, publicKey(owner));
  const unsigned = preview(cursor, targetProfileId, {
    headRevision: 1, policyHead: anchored.digest, operationId: '2'.repeat(32), expiresAt: 6000,
  });
  const offer = authority.buildScopeOwnerTransferOffer(trust, cursor, unsigned, snapshot, owner);
  const link = authority.acceptScopeOwnerTransferOffer(trust, cursor, offer, recipient);
  const draft = { Action: 'owner.transfer', Revision: 2, OperationID: unsigned.operationId, PreviousDigest: anchored.digest };
  const next = { ...snapshot, Owner: targetProfileId, Admissions: { [channelId]: { [targetProfileId]: { FirstPosition: 5 } } } };
  const policy = record(draft, next, server, { ID: targetProfileId, OwnershipTransfer: link });
  const page = proof => ({ headRevision: 2, headDigest: proof.digest, proofs: [anchored.entry, proof.entry] });
  let saved;
  const storage = { async load() { return saved; }, async save(_key, text) { saved = text; } };
  const checkpoint = new ProtectedPolicyCheckpoint(storage);
  assert.equal((await checkpoint.accept(page(policy), trust)).digest, policy.digest);
  assert.equal((await checkpoint.load(trust)).scopeAuthority.ownerProfileId, targetProfileId);
  const changedRoles = { ...next, Members: { ...next.Members, [targetProfileId]: { ...next.Members[targetProfileId], Roles: ['administrator'] } } };
  const inflated = record(draft, changedRoles, server, { ID: targetProfileId, OwnershipTransfer: link });
  saved = undefined;
  await assert.rejects(checkpoint.accept(page(inflated), trust), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  const staleAdmissions = record(draft, { ...next, Admissions: snapshot.Admissions }, server, { ID: targetProfileId, OwnershipTransfer: link });
  await assert.rejects(checkpoint.accept(page(staleAdmissions), trust), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  const corruptedLink = { ...link, transfer: { ...link.transfer, candidatesRoot: 'f'.repeat(64) } };
  const fabricated = record(draft, next, server, { ID: targetProfileId, OwnershipTransfer: corruptedLink });
  await assert.rejects(checkpoint.accept(page(fabricated), trust), { code: 'INVALID_SCOPE_AUTHORITY' });
});
