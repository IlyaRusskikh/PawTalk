import assert from 'node:assert/strict';
import { createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import membershipClient from '../../apps/client/windows/electron/membership-client.cjs';
import runtime from '../../apps/client/windows/electron/protected-runtime-recovery.cjs';
import migration from '../../apps/client/windows/electron/protected-migration-recovery.cjs';
import checkpoint from '../../apps/client/windows/electron/protected-policy-checkpoint.cjs';
import authority from '../../apps/client/windows/electron/protected-scope-authority.cjs';
import replay from '../../apps/client/windows/electron/protected-policy-replay.cjs';
import membership from '../../shared/membership.cjs';

const { signatureFrame } = membership;
const { prepareProtectedRecoveryEnrollment, verifyProtectedRecoveryEnrollment } = runtime;
const { protectedPolicySignatureFrame, ProtectedPolicyCheckpoint } = checkpoint;
const { MembershipClient } = membershipClient;
const digest = value => createHash('sha256').update(value).digest('hex');
const raw = key => key.export({ type: 'spki', format: 'der' }).subarray(-32);
const code = Buffer.alloc(32, 11).toString('base64url');
const oldCode = Buffer.alloc(32, 22).toString('base64url');
const operationId = '2'.repeat(32);

function fixture() {
  const server = generateKeyPairSync('ed25519');
  const device = generateKeyPairSync('ed25519');
  const challengeKey = generateKeyPairSync('x25519');
  const deviceKey = raw(device.publicKey).toString('hex');
  const deviceId = digest(raw(device.publicKey)), serverId = digest(raw(server.publicKey)).slice(0, 32);
  const profileId = '3'.repeat(64), cutoverDigest = '4'.repeat(64), policyHead = '5'.repeat(64);
  const connection = { serverId, profileId, deviceId, cutoverDigest, base: 'https://127.0.0.1:18888',
    fingerprint: '6'.repeat(64), token: 'synthetic-session',
    policyTrust: { serverId, cutoverDigest, ownerProfileId: profileId, ownerDeviceId: deviceId, anchorDigest: policyHead },
  };
  const challenge = { serverId, profileId, deviceId, cutoverDigest, policyHead, nonce: '7'.repeat(64), expiresAt: 160_000,
    serverAgreementKey: raw(challengeKey.publicKey).toString('hex') };
  const identity = { profileId: 'f'.repeat(64), deviceId, device: device.privateKey };
  const actor = { ProfileID: profileId, DeviceID: deviceId };
  const prepare = (head = policyHead) => prepareProtectedRecoveryEnrollment(connection, { ...challenge, policyHead: head }, operationId, code, identity);
  const draft = (head = policyHead) => ({
    Action: 'recovery.enroll', OperationID: operationId, PreviousDigest: head, Revision: 2, PublicKey: '', RoleUpdate: null,
    ResourceChange: { ID: profileId, Recovery: { ...prepare(head).claims, ServerKey: raw(server.publicKey).toString('base64url') } },
  });
  return { server, device, deviceKey, actor, connection, challenge, challengeKey, identity, prepare, draft };
}

test('runtime recovery derives the migration identity for the effective profile and binds all challenge fields', () => {
  const { deviceKey, actor, connection, challenge, challengeKey, identity, prepare, draft } = fixture();
  const { proposal, claims } = prepare();
  const { serverId, cutoverDigest, profileId, deviceId, policyHead, nonce, expiresAt, serverAgreementKey } = challenge;
  const sameIdentity = migration.proposeMigrationRecovery({ serverId, archiveSha256: '8'.repeat(64), ownerProfileId: profileId,
    nonce, serverAgreementKey, code, identity });
  assert.equal(claims.RecoveryID, sameIdentity.recoveryId);
  assert.equal(proposal.signingKey, sameIdentity.proposal.signingKey);
  assert.equal(proposal.agreementKey, sameIdentity.proposal.agreementKey);
  assert.ok(!JSON.stringify(proposal).includes(code));
  assert.notEqual(claims.RecoveryID, migration.deriveRecoveryIdentity(code, serverId, identity.profileId).recoveryId);
  const frame = signatureFrame('pawtalk-protected-recovery-enrollment-v1', serverId, cutoverDigest, profileId, deviceId,
    operationId, policyHead, nonce, String(expiresAt), claims.RecoveryID, proposal.signingKey, proposal.agreementKey, serverAgreementKey);
  const recoveryKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(proposal.agreementKey, 'hex')]),
    type: 'spki', format: 'der',
  });
  const shared = diffieHellman({ privateKey: challengeKey.privateKey, publicKey: recoveryKey });
  try { assert.equal(createHmac('sha256', shared).update(frame).digest('base64url'), proposal.agreementProof); }
  finally { shared.fill(0); }
  const signed = draft();
  verifyProtectedRecoveryEnrollment(connection.policyTrust, actor, signed, deviceKey);
  for (const [key, value] of [['Nonce', '9'.repeat(64)], ['ExpiresAt', 161_000], ['AgreementProof', Buffer.alloc(32).toString('base64url')],
    ['RecoveryProof', Buffer.alloc(64).toString('base64url')], ['CutoverDigest', '9'.repeat(64)]]) {
    const changed = structuredClone(signed);
    changed.ResourceChange.Recovery[key] = value;
    assert.throws(() => verifyProtectedRecoveryEnrollment(connection.policyTrust, actor, changed, deviceKey),
      { code: 'INVALID_PROTECTED_RECOVERY_PROOF' });
  }
});

test('recovery replay removes retired credentials and leaves recovery readiness pending', () => {
  const { connection, actor, deviceKey, draft } = fixture();
  const { profileId, deviceId } = connection;
  const old = migration.deriveRecoveryIdentity(oldCode, connection.serverId, profileId);
  const before = { Owner: profileId, Members: { [profileId]: { ID: profileId, Active: true, Roles: [] } },
    PolicyDevices: { [deviceId]: { ProfileID: profileId, PublicKey: deviceKey } },
    KeyRecipients: { [old.recoveryId]: { ProfileID: profileId, Kind: 'recovery', PublicKey: old.agreementKey } },
    RecoveryIdentities: { [profileId]: { ID: old.recoveryId, SigningKey: old.signingKey, AgreementKey: old.agreementKey } },
    RecoveryReady: { [profileId]: true }, Channels: {}, Admissions: {},
  };
  const commitment = draft();
  const { RecoveryID, SigningKey, AgreementKey } = commitment.ResourceChange.Recovery;
  const after = { ...before, RecoveryReady: {}, RetiredRecipientKeys: { [old.agreementKey]: true },
    RetiredRecoverySigningKeys: { [old.signingKey]: true },
    RecoveryIdentities: { [profileId]: { ID: RecoveryID, SigningKey, AgreementKey } },
    KeyRecipients: { [RecoveryID]: { ProfileID: profileId, Kind: 'recovery', PublicKey: AgreementKey } },
  };
  replay.replayPolicyTransition(before, after, actor, commitment, profileId);
  assert.throws(() => replay.replayPolicyTransition(before, { ...after, RecoveryReady: before.RecoveryReady },
    actor, commitment, profileId), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  const retired = { ...before, RetiredRecoverySigningKeys: { [SigningKey]: true } };
  assert.throws(() => replay.replayPolicyTransition(retired, after, actor, commitment, profileId),
    { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
});

test('the full policy checkpoint verifies recovery and device approval independently of the outer server signature', async () => {
  const { connection, actor, deviceKey, device, server, draft, challenge, identity } = fixture();
  const { profileId, deviceId } = connection;
  const anchor = { Owner: profileId, Members: { [profileId]: { ID: profileId, Active: true, Roles: [] } },
    PolicyDevices: { [deviceId]: { ProfileID: profileId, PublicKey: deviceKey } }, KeyRecipients: null, Channels: {}, Admissions: {} };
  const makeProof = (payload, state, signer, serverSigned = false) => {
    const snapshot = Buffer.from(JSON.stringify(state));
    const draft = { ...payload, ResultDigest: digest(snapshot) };
    const resource = draft.ResourceChange && Buffer.from(JSON.stringify(draft.ResourceChange));
    let frame = protectedPolicySignatureFrame(connection.serverId, actor, draft, Buffer.from('null'), resource ? [digest(resource)] : []);
    if (serverSigned) frame = signatureFrame('pawtalk-protected-recovery-enrollment-proof-v1', digest(frame));
    const signature = sign(null, frame, signer);
    draft.Signature = signature.toString('base64');
    return { digest: digest(signature), entry: { snapshot: snapshot.toString('base64'), roleUpdate: Buffer.from('null').toString('base64'),
      record: Buffer.from(JSON.stringify({ Principal: actor, Draft: draft })).toString('base64'),
      ...(resource && { resourceChange: resource.toString('base64') }) } };
  };
  const first = makeProof({ Action: 'policy.anchor', OperationID: '1'.repeat(32), Revision: 1, PreviousDigest: '', PublicKey: '',
    RoleUpdate: null }, anchor, device.privateKey);
  const trust = { ...connection.policyTrust, anchorDigest: first.digest };
  const good = draft(first.digest);
  const { RecoveryID, SigningKey, AgreementKey } = good.ResourceChange.Recovery;
  const updated = { ...anchor, RecoveryIdentities: { [profileId]: { ID: RecoveryID, SigningKey, AgreementKey } },
    KeyRecipients: { [RecoveryID]: { ProfileID: profileId, Kind: 'recovery', PublicKey: AgreementKey } },
  };
  const second = makeProof(good, updated, server.privateKey, true);
  const tampered = structuredClone(good);
  tampered.ResourceChange.Recovery.RecoveryProof = Buffer.alloc(64).toString('base64url');
  const malicious = makeProof(tampered, updated, server.privateKey, true);
  const page = proof => ({ headRevision: 2, headDigest: proof.digest, proofs: [first.entry, proof.entry] });
  const storage = { async load() {}, async save() {} };
  assert.equal((await new ProtectedPolicyCheckpoint(storage).accept(page(second), trust)).digest, second.digest);
  await assert.rejects(new ProtectedPolicyCheckpoint(storage).accept(page(malicious), trust),
    { code: 'INVALID_PROTECTED_RECOVERY_PROOF' });

  const linked = structuredClone(good);
  const genesis = authority.scopeAuthorityGenesis(trust, deviceKey);
  linked.ResourceChange.Recovery.ScopeAuthority = authority.signScopeAuthorityLink(trust, genesis, {
    action: 'recovery.authorize', revision: 2, operationId, policyHead: first.digest, recoveryId: RecoveryID,
    recoveryKey: SigningKey, deviceKey,
  }, device.privateKey);
  const extended = makeProof(linked, updated, server.privateKey, true);
  let saved;
  const cache = { async load() { return saved; }, async save(_key, payload) { saved = payload; } };
  assert.equal((await new ProtectedPolicyCheckpoint(cache).accept(page(extended), trust)).digest, extended.digest);
  assert.equal(JSON.parse(saved).scopeAuthority.recoveryId, RecoveryID);

  const nextOperationId = 'a'.repeat(32);
  const replacement = prepareProtectedRecoveryEnrollment(connection, { ...challenge, policyHead: extended.digest },
    nextOperationId, oldCode, identity).claims;
  const bypass = makeProof({ ...good, Revision: 3, OperationID: nextOperationId, PreviousDigest: extended.digest,
    ResourceChange: { ID: profileId, Recovery: { ...replacement, ServerKey: raw(server.publicKey).toString('base64url') } } },
  updated, server.privateKey, true);
  await assert.rejects(new ProtectedPolicyCheckpoint(cache).accept({ headRevision: 3, headDigest: bypass.digest,
    proofs: [bypass.entry] }, trust), { code: 'INVALID_SCOPE_AUTHORITY' });
});

test('archive epochs reuse one verified historical policy chain across revisions and head updates', async () => {
  const { connection, actor, device, deviceKey } = fixture();
  const base = { Owner: actor.ProfileID, Members: { [actor.ProfileID]: { ID: actor.ProfileID, Active: true, Roles: [] } },
    PolicyDevices: { [actor.DeviceID]: { ProfileID: actor.ProfileID, PublicKey: deviceKey } },
    Channels: {}, Admissions: {}, Order: [] };
  const proofs = [];
  for (let revision = 1; revision <= 81; revision++) {
    const Roles = { '@everyone': { Grants: revision % 2 ? ['channel.view'] : [] } };
    const snapshot = Buffer.from(JSON.stringify({ ...base, Roles }));
    const roleUpdate = revision === 1 ? null : { Roles, Order: [], Assignments: null };
    const roles = Buffer.from(JSON.stringify(roleUpdate));
    const draft = { Action: revision === 1 ? 'policy.anchor' : 'roles.update', OperationID: revision.toString(16).padStart(32, '0'),
      Revision: revision, PreviousDigest: proofs.at(-1)?.digest ?? '', ResultDigest: digest(snapshot), PublicKey: '', RoleUpdate: roleUpdate };
    const signature = sign(null, protectedPolicySignatureFrame(connection.serverId, actor, draft, roles), device.privateKey);
    draft.Signature = signature.toString('base64');
    proofs.push({ digest: digest(signature), draft, entry: { snapshot: snapshot.toString('base64'), roleUpdate: roles.toString('base64'),
      record: Buffer.from(JSON.stringify({ Principal: actor, Draft: draft })).toString('base64') } });
  }
  const trust = { ...connection.policyTrust, anchorDigest: proofs[0].digest };
  let saved, head = 80;
  const credentials = { async load() { return saved; }, async save(_key, value) { saved = value; } };
  const page = after => ({ headRevision: head, headDigest: proofs[head - 1].digest,
    proofs: proofs.slice(after, Math.min(head, after + 32)).map(proof => proof.entry) });
  const previousProcess = new ProtectedPolicyCheckpoint(credentials);
  for (const after of [0, 32, 64]) await previousProcess.accept(page(after), trust);
  const checkpoint = new ProtectedPolicyCheckpoint(credentials);
  const reads = [];
  const fetchPage = async after => { reads.push(after); return page(after); };
  const basis = (revision, fetch = fetchPage) => checkpoint.policyBasis({ Revision: revision,
    PolicyDigest: proofs[revision - 1].draft.ResultDigest }, trust, fetch, false);
  const revisions = [2, 3, 4, 7, 35, 56, 74];
  const snapshots = await Promise.all(revisions.map(revision => basis(revision)));
  assert.deepEqual(snapshots.map(snapshot => snapshot.Roles['@everyone'].Grants.length), revisions.map(revision => revision % 2));
  assert.equal(reads.filter(after => after === 0).length, 1);
  assert.equal(reads.length, 3 + revisions.length - 1, 'one replay followed by one snapshot request for each other revision');

  head++;
  await checkpoint.accept(page(80), trust);
  reads.length = 0;
  await basis(12);
  assert.deepEqual(reads, [11], 'a verified extension can reuse the previous chain');
  await assert.rejects(basis(22, async after => {
    const response = page(after);
    response.proofs[0] = { ...response.proofs[0], snapshot: Buffer.from('{}').toString('base64') };
    return response;
  }), { code: 'INVALID_POLICY_SNAPSHOT' });
  assert.ok(await basis(22), 'a bad snapshot response is not cached');
});

test('a lost enrollment response retries the same public proposal without persisting the code', async () => {
  const { challenge, identity, connection } = fixture();
  const approvals = [];
  let issued = 0;
  const client = new MembershipClient({ credentials: { async save() { assert.fail('unexpected credential write'); } } });
  client.identity = async () => identity;
  client.fetchJSON = async (_base, path, { body }) => {
    assert.ok(!body.includes(code));
    if (path.endsWith('/challenge')) { issued++; return challenge; }
    approvals.push(body);
    if (approvals.length === 1) throw Object.assign(new Error('lost response'), { code: 'ECONNRESET' });
    const { operationId, signingKey, agreementKey } = JSON.parse(body);
    return { operationId, recoveryId: migration.recoveryIdentityId(connection.serverId, connection.profileId, signingKey, agreementKey),
      revision: 2, digest: 'a'.repeat(64) };
  };
  await assert.rejects(client.enrollProtectedRuntimeRecovery(connection, code), { code: 'ECONNRESET' });
  const pending = await client.enrollProtectedRuntimeRecovery(connection, code);
  assert.equal(issued, 1);
  assert.equal(approvals[0], approvals[1]);
  assert.equal(pending.ready, false);
});
