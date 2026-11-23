import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import test from 'node:test';
import authority from '../../apps/client/windows/electron/protected-scope-authority.cjs';
import checkpoint from '../../apps/client/windows/electron/protected-policy-checkpoint.cjs';
import attestations from '../../apps/client/windows/electron/protected-policy-attestation.cjs';
import membership from '../../shared/membership.cjs';

const { scopeAuthorityGenesis, buildScopeDeviceHandoverOffer, verifyScopeDeviceHandoverOffer, acceptScopeDeviceHandoverOffer,
  advanceScopeAuthority, verifyScopeAuthorityChain, scopeAuthorityRequiresV2, signScopeAuthorityLink } = authority;
const { protectedPolicySignatureFrame, ProtectedPolicyCheckpoint } = checkpoint;
const { policyAttestationFrame, verifyPolicyAttestation, PolicyAttestationCheckpoint } = attestations;
const { signatureFrame } = membership;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const key = seed => createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8',
});
const raw = privateKey => createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
const publicKey = privateKey => raw(privateKey).toString('hex');
const keyId = privateKey => hash(raw(privateKey));
const numericId = (number, width) => number.toString(16).padStart(width, '0');

function fixture() {
  const old = key(91), next = key(92), other = key(93);
  const trust = { serverId: '1'.repeat(32), cutoverDigest: '2'.repeat(64), anchorDigest: '3'.repeat(64),
    ownerProfileId: '4'.repeat(64), ownerDeviceId: keyId(old) };
  const fields = (revision, target) => ({
    revision, policyHead: numericId(revision - 1, 64), operationId: numericId(revision, 32), deviceKey: publicKey(target), expiresAt: 7890,
  });
  return { trust, old, next, other, fields };
}

test('scope device handover follows the Go vector and retains the v2 floor when authority returns to genesis', async () => {
  const { trust, old, next, other, fields } = fixture();
  const genesis = scopeAuthorityGenesis(trust, publicKey(old));
  const first = buildScopeDeviceHandoverOffer(trust, genesis, fields(2, next), old);
  const offer = verifyScopeDeviceHandoverOffer(trust, genesis, first);
  assert.deepEqual(offer, signatureFrame('pawtalk-scope-device-handover-v1', trust.serverId, trust.cutoverDigest, trust.anchorDigest,
    trust.ownerProfileId, '1', trust.anchorDigest, '2', first.policyHead, first.operationId, keyId(old), keyId(next), publicKey(next), '', '', '7890'));
  assert.throws(() => acceptScopeDeviceHandoverOffer(trust, genesis, first, other), { code: 'INVALID_SCOPE_AUTHORITY' });
  const accepted = acceptScopeDeviceHandoverOffer(trust, genesis, first, next);
  const middle = advanceScopeAuthority(trust, genesis, accepted);
  assert.equal(middle.recoveryId, '');
  assert.deepEqual(middle.usedRecoveryIds, []);
  const reverse = buildScopeDeviceHandoverOffer(trust, middle, fields(7, old), next);
  const returned = acceptScopeDeviceHandoverOffer(trust, middle, reverse, old);
  const head = verifyScopeAuthorityChain(trust, publicKey(old), [accepted, returned], middle);
  assert.equal(head.digest, '3f77578100c7774dfb8a6a0b279153bd9d3b89e0085c4e4d65652b72a03d6e54');
  assert.equal(head.deviceId, trust.ownerDeviceId);
  assert.equal(head.ownerProfileId, trust.ownerProfileId);
  assert.equal(head.ownershipTransferred, undefined);
  assert.equal(head.signerMoved, true);
  assert.equal(scopeAuthorityRequiresV2(trust, head), true);
  const v1 = { revision: 7, previous: 'a'.repeat(64), digest: 'b'.repeat(64),
    policyDigest: 'c'.repeat(64), root: 'd'.repeat(64), signerKey: publicKey(old) };
  v1.signature = sign(null, policyAttestationFrame(trust, v1), old).toString('base64');
  assert.deepEqual(verifyPolicyAttestation(trust, v1), v1, 'historical v1 still verifies');
  const storage = { async load() {}, async save() {} };
  const floor = new PolicyAttestationCheckpoint(storage);
  await assert.rejects(floor.acceptCurrent(trust, v1, { state: head }), { code: 'POLICY_ROLLBACK' });
  const v2 = { ...v1, authorityHead: head.digest, authorityRevision: head.revision, signerDeviceId: keyId(old) };
  v2.signature = sign(null, policyAttestationFrame(trust, v2), old).toString('base64');
  assert.deepEqual(await floor.acceptCurrent(trust, v2, { state: head }), v2);

  for (const patch of [{ previous: trust.anchorDigest }, { policyHead: 'e'.repeat(64) }, { sourceDeviceId: keyId(other) },
    { expiresAt: 7891 }, { deviceProof: accepted.deviceProof }, { targetProfileId: '' }]) {
    assert.throws(() => advanceScopeAuthority(trust, middle, { ...returned, ...patch }), { code: 'INVALID_SCOPE_AUTHORITY' });
  }
  assert.throws(() => verifyScopeDeviceHandoverOffer(trust, middle, first), { code: 'INVALID_SCOPE_AUTHORITY' });
});

test('scope device may bootstrap a recovery pair but cannot replace or clear it', () => {
  const { trust, old, next, fields } = fixture();
  const genesis = scopeAuthorityGenesis(trust, publicKey(old));
  const recoveryId = '5'.repeat(64), recoveryKey = publicKey(key(95));
  const bootstrap = buildScopeDeviceHandoverOffer(trust, genesis, { ...fields(2, next), recoveryId, recoveryKey }, old);
  const first = acceptScopeDeviceHandoverOffer(trust, genesis, bootstrap, next);
  const middle = advanceScopeAuthority(trust, genesis, first);
  assert.equal(middle.recoveryKey, recoveryKey);
  const retained = buildScopeDeviceHandoverOffer(trust, middle, fields(4, old), next);
  assert.equal(retained.recoveryId, recoveryId);
  assert.equal(retained.recoveryKey, recoveryKey);
  for (const changed of [{ recoveryId: '' }, { recoveryId: '6'.repeat(64) }, { recoveryKey: publicKey(key(96)) }, { recoveryId: '', recoveryKey: '' }]) {
    assert.throws(() => buildScopeDeviceHandoverOffer(trust, middle, { ...fields(4, old), ...changed }, next),
      { code: 'INVALID_SCOPE_AUTHORITY' });
  }
  const authorityOnly = signScopeAuthorityLink(trust, genesis, { action: 'recovery.authorize', revision: 3,
    policyHead: numericId(2, 64), operationId: numericId(3, 32), recoveryId, recoveryKey, deviceKey: publicKey(old) }, old);
  const enrolled = advanceScopeAuthority(trust, genesis, authorityOnly);
  assert.equal(scopeAuthorityRequiresV2(trust, enrolled), false, 'recovery authorization does not change the attestation signer');
  const moveWithoutKit = buildScopeDeviceHandoverOffer(trust, genesis, fields(2, next), old);
  const newSigner = advanceScopeAuthority(trust, genesis, acceptScopeDeviceHandoverOffer(trust, genesis, moveWithoutKit, next));
  const enrolledAfterMove = signScopeAuthorityLink(trust, newSigner, { action: 'recovery.authorize', revision: 3,
    policyHead: numericId(2, 64), operationId: numericId(3, 32), recoveryId, recoveryKey, deviceKey: publicKey(next) }, next);
  assert.equal(enrolledAfterMove.recoveryId, recoveryId, 'an owner without a kit can enroll after an empty-pair handover');
});

test('full scope-device proof matches the consenting devices and existing recovery, without changing policy', async () => {
  const { trust, old, next, other, fields } = fixture();
  const server = key(97), owner = trust.ownerProfileId, secondary = '5'.repeat(64);
  trust.serverId = keyId(server).slice(0, 32);
  const principal = { ProfileID: owner, DeviceID: keyId(old) };
  const recoveryId = '6'.repeat(64), recoveryKey = publicKey(key(96)), agreement = '7'.repeat(64);
  const snapshot = {
    Owner: owner, Members: { [owner]: { ID: owner, Active: true, Roles: [] }, [secondary]: { ID: secondary, Active: true, Roles: [] } },
    PolicyDevices: {
      [keyId(old)]: { ProfileID: owner, PublicKey: publicKey(old) },
      [keyId(next)]: { ProfileID: owner, PublicKey: publicKey(next) },
      [keyId(other)]: { ProfileID: secondary, PublicKey: publicKey(other) },
    },
    Channels: {}, Admissions: {},
    RecoveryIdentities: { [owner]: { ID: recoveryId, SigningKey: recoveryKey, AgreementKey: agreement } },
    KeyRecipients: { [recoveryId]: { ProfileID: owner, Kind: 'recovery', PublicKey: agreement } },
  };
  const record = (fields, applied, privateKey) => {
    const snapshot = Buffer.from(JSON.stringify(applied)), roles = Buffer.from('null');
    const claims = fields.ResourceChange && Buffer.from(JSON.stringify(fields.ResourceChange));
    const draft = { ...fields, ResultDigest: hash(snapshot), PublicKey: '', RoleUpdate: null };
    let frame = protectedPolicySignatureFrame(trust.serverId, principal, draft, roles, claims ? [hash(claims)] : []);
    if (claims) frame = signatureFrame('pawtalk-protected-scope-device-handover-proof-v1', hash(frame));
    const signature = sign(null, frame, privateKey);
    draft.Signature = signature.toString('base64');
    return { digest: hash(signature), wire: { roleUpdate: roles.toString('base64'), snapshot: snapshot.toString('base64'),
      record: Buffer.from(JSON.stringify({ Principal: principal, Draft: draft })).toString('base64'),
      ...(claims && { resourceChange: claims.toString('base64') }) } };
  };
  const anchor = record({ Action: 'policy.anchor', Revision: 1, PreviousDigest: '', OperationID: numericId(1, 32) }, snapshot, old);
  trust.anchorDigest = anchor.digest;
  const genesis = scopeAuthorityGenesis(trust, publicKey(old));
  const applied = (candidate, pair = { recoveryId, recoveryKey }) => {
    const offer = buildScopeDeviceHandoverOffer(trust, genesis, { ...fields(2, candidate), policyHead: anchor.digest, ...pair }, old);
    return acceptScopeDeviceHandoverOffer(trust, genesis, offer, candidate);
  };
  const draft = (Link, change = {}) => ({
    Action: 'scope.device', Revision: 2, PreviousDigest: anchor.digest, OperationID: Link.operationId,
    ResourceChange: { ID: owner, ScopeDeviceHandover: { Link, At: 1000, ServerKey: raw(server).toString('base64url'),
      CutoverDigest: trust.cutoverDigest, ...change } },
  });
  const page = proof => ({ headRevision: 2, headDigest: proof.digest, proofs: [anchor.wire, proof.wire] });
  const storage = { async load() {}, async save() {} };
  const verifier = new ProtectedPolicyCheckpoint(storage);
  const correct = applied(next);
  const proof = record(draft(correct), snapshot, server);
  assert.equal((await verifier.accept(page(proof), trust)).digest, proof.digest);
  const inheritedUnboundRecovery = applied(next, { recoveryId: '', recoveryKey: '' });
  for (const bad of [draft(applied(other)), draft(inheritedUnboundRecovery), draft(correct, { At: correct.expiresAt })]) {
    const invalid = record(bad, snapshot, server);
    await assert.rejects(verifier.accept(page(invalid), trust), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  }
  const changedCutover = record(draft(correct, { CutoverDigest: '9'.repeat(64) }), snapshot, server);
  await assert.rejects(verifier.accept(page(changedCutover), trust), { code: 'INVALID_SCOPE_AUTHORITY' });
  const stale = buildScopeDeviceHandoverOffer(trust, genesis, { ...fields(2, next), policyHead: 'a'.repeat(64), recoveryId, recoveryKey }, old);
  const wrongPredecessor = record(draft(acceptScopeDeviceHandoverOffer(trust, genesis, stale, next)), snapshot, server);
  await assert.rejects(verifier.accept(page(wrongPredecessor), trust), { code: 'INVALID_SCOPE_AUTHORITY' });
  const changedRole = record(draft(correct), { ...snapshot, RecoveryReady: { [owner]: true } }, server);
  await assert.rejects(verifier.accept(page(changedRole), trust), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  const invalidProof = record(draft({ ...correct, deviceProof: Buffer.alloc(64).toString('base64url') }), snapshot, server);
  await assert.rejects(verifier.accept(page(invalidProof), trust), { code: 'INVALID_SCOPE_AUTHORITY' });
});
