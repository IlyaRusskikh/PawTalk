import assert from 'node:assert/strict';
import { createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import membership from '../../shared/membership.cjs';
import checkpoint from '../../apps/client/windows/electron/protected-policy-checkpoint.cjs';
import authority from '../../apps/client/windows/electron/protected-scope-authority.cjs';
import migration from '../../apps/client/windows/electron/protected-migration-recovery.cjs';
import recoveryDevice from '../../apps/client/windows/electron/protected-recovery-device.cjs';
import replay from '../../apps/client/windows/electron/protected-policy-replay.cjs';

const { signatureFrame } = membership;
const { protectedPolicySignatureFrame, ProtectedPolicyCheckpoint } = checkpoint;
const { deriveRecoveryIdentity } = migration;
const { prepareProtectedRecoveryDevice, verifyProtectedRecoveryDevice } = recoveryDevice;
const { replayPolicyTransition } = replay;
const raw = key => key.export({ format: 'der', type: 'spki' }).subarray(-32);
const digest = value => createHash('sha256').update(value).digest('hex');
const code = Buffer.alloc(32, 21).toString('base64url');
const operationId = '1'.repeat(32);

function fixture() {
  const server = generateKeyPairSync('ed25519'), agreement = generateKeyPairSync('x25519');
  const old = generateKeyPairSync('ed25519'), dead = generateKeyPairSync('ed25519'), replacement = generateKeyPairSync('ed25519');
  const replacedAgreement = generateKeyPairSync('x25519');
  const oldAgreement = generateKeyPairSync('x25519');
  const serverId = digest(raw(server.publicKey)).slice(0, 32), profileId = '2'.repeat(64), cutoverDigest = '3'.repeat(64);
  const oldId = digest(raw(old.publicKey)), deadId = digest(raw(dead.publicKey)), deviceId = digest(raw(replacement.publicKey));
  const recovery = deriveRecoveryIdentity(code, serverId, profileId);
  const expected = { serverId, cutoverDigest, profileId, policyHead: '4'.repeat(64) };
  const keys = { device: replacement.privateKey, agreement: replacedAgreement.privateKey };
  const challenge = { ...expected, deviceId, recoveryId: recovery.recoveryId, nonce: '5'.repeat(64), expiresAt: 180_000,
    serverAgreementKey: raw(agreement.publicKey).toString('base64url') };
  const trust = { serverId, cutoverDigest, ownerProfileId: profileId, ownerDeviceId: oldId, anchorDigest: expected.policyHead };
  const actor = { ProfileID: profileId, DeviceID: deviceId };
  const oldAgreementKey = raw(oldAgreement.publicKey).toString('hex');
  const prepare = (basis = challenge) => prepareProtectedRecoveryDevice({ ...expected, policyHead: basis.policyHead }, basis, operationId, code, keys);
  const draft = (basis = challenge) => ({
    OperationID: operationId, Action: 'recovery.device', Revision: 2, PreviousDigest: basis.policyHead, PublicKey: '', RoleUpdate: null,
    ResourceChange: { ID: profileId, RecoveryDevice: { ...prepare(basis).claims, ServerKey: raw(server.publicKey).toString('base64url') } },
  });
  const before = {
    Owner: profileId, Members: { [profileId]: { ID: profileId, Active: true, Roles: ['member'] } },
    PolicyDevices: { [oldId]: { ProfileID: profileId, PublicKey: raw(old.publicKey).toString('hex') },
      [deadId]: { ProfileID: profileId, PublicKey: raw(dead.publicKey).toString('hex') } },
    KeyRecipients: { [oldId]: { ProfileID: profileId, Kind: 'device', PublicKey: oldAgreementKey },
      [recovery.recoveryId]: { ProfileID: profileId, Kind: 'recovery', PublicKey: recovery.agreementKey } },
    RecoveryReady: { [profileId]: true },
    RecoveryIdentities: { [profileId]: { ID: recovery.recoveryId, SigningKey: recovery.signingKey, AgreementKey: recovery.agreementKey } },
    Channels: {}, Admissions: {},
  };
  const after = {
    ...before, PolicyDevices: {
      [oldId]: { ...before.PolicyDevices[oldId], Revoked: true },
      [deadId]: { ...before.PolicyDevices[deadId], Revoked: true },
      [deviceId]: { ProfileID: profileId, PublicKey: raw(replacement.publicKey).toString('hex') },
    },
    KeyRecipients: { [recovery.recoveryId]: before.KeyRecipients[recovery.recoveryId],
      [deviceId]: { ProfileID: profileId, Kind: 'device', PublicKey: raw(replacedAgreement.publicKey).toString('hex') } },
    RetiredRecipientKeys: { [oldAgreementKey]: true },
  };
  return { server, agreement, expected, challenge, keys, trust, actor, old, replacement, recovery, prepare, draft, before, after, oldId, deadId };
}

test('recovery device request proves both fresh keys and recovery ownership without sending the code', () => {
  const { agreement, expected, challenge, keys, trust, actor, replacement, recovery, prepare, draft, before } = fixture();
  const { proposal, claims } = prepare();
  const { serverId, cutoverDigest, profileId, deviceId, recoveryId, policyHead, nonce, expiresAt } = challenge;
  const frame = signatureFrame('pawtalk-protected-recovery-device-v1', serverId, cutoverDigest, profileId, deviceId, recoveryId,
    policyHead, operationId, nonce, String(expiresAt), proposal.signingKey, proposal.agreementKey);
  assert.ok(verify(null, frame, replacement.publicKey, Buffer.from(proposal.deviceProof, 'base64url')));
  assert.ok(verify(null, frame, createPublicKey(recovery.signing), Buffer.from(proposal.recoveryProof, 'base64url')));
  const shared = diffieHellman({ privateKey: agreement.privateKey, publicKey: createPublicKey(keys.agreement) });
  try { assert.equal(createHmac('sha256', shared).update(frame).digest('base64url'), proposal.agreementProof); }
  finally { shared.fill(0); }
  assert.equal(claims.RecoveryID, recoveryId);
  assert.ok(!JSON.stringify(proposal).includes(code));
  assert.throws(() => prepareProtectedRecoveryDevice(expected, { ...challenge, policyHead: 'a'.repeat(64) }, operationId, code, keys),
    { code: 'INVALID_PROTECTED_RECOVERY_DEVICE_PROOF' });
  assert.throws(() => prepareProtectedRecoveryDevice(expected, challenge, operationId, code,
    { ...keys, device: generateKeyPairSync('ed25519').privateKey }), { code: 'INVALID_PROTECTED_RECOVERY_DEVICE_PROOF' });
  verifyProtectedRecoveryDevice(trust, actor, draft(), before.RecoveryIdentities[profileId]);
  for (const field of ['RecoveryProof', 'DeviceProof', 'Nonce']) {
    const altered = draft();
    altered.ResourceChange.RecoveryDevice[field] = field === 'Nonce' ? 'f'.repeat(64) : Buffer.alloc(64).toString('base64url');
    assert.throws(() => verifyProtectedRecoveryDevice(trust, actor, altered, before.RecoveryIdentities[profileId]),
      { code: 'INVALID_PROTECTED_RECOVERY_DEVICE_PROOF' });
  }
});

test('device recovery replay revokes every old device and preserves roles and the recovery identity', () => {
  const { trust, actor, before, after, draft, oldId, deadId } = fixture();
  const owner = trust.ownerProfileId;
  replayPolicyTransition(before, after, actor, draft(), owner);
  for (const id of [oldId, deadId]) {
    assert.throws(() => replayPolicyTransition(before,
      { ...after, PolicyDevices: { ...after.PolicyDevices, [id]: before.PolicyDevices[id] } }, actor, draft(), owner),
    { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  }
  assert.throws(() => replayPolicyTransition(before, { ...after, Members: { [owner]: { ...after.Members[owner], Roles: [] } } },
    actor, draft(), owner), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  const pending = { ...before, RecoveryReady: {} };
  assert.throws(() => replayPolicyTransition(pending, { ...after, RecoveryReady: {} }, actor, draft(), owner),
    { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  const banned = { ...before, MemberRemovals: { [owner]: { Action: 'member.ban', ExpiresAt: 1 } } };
  assert.throws(() => replayPolicyTransition(banned, { ...after, MemberRemovals: banned.MemberRemovals }, actor, draft(), owner),
    { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  const reused = { ...before, RetiredRecipientKeys: { [draft().ResourceChange.RecoveryDevice.AgreementKey]: true } };
  assert.throws(() => replayPolicyTransition(reused, after, actor, draft(), owner), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });

  const otherOwner = 'd'.repeat(64);
  const otherMember = { ID: otherOwner, Active: true };
  const admin = { [owner]: { ...before.Members[owner], Roles: ['administrator'] }, [otherOwner]: otherMember };
  const roles = { administrator: { Grants: ['server.administrator'] } };
  // A current non-owner keeps existing grants and may recover while the
  // new backup packages are pending. Only current ownership requires ready.
  replayPolicyTransition({ ...pending, Owner: otherOwner, Members: admin, Roles: roles },
    { ...after, Owner: otherOwner, Members: admin, Roles: roles, RecoveryReady: {} }, actor, draft(), otherOwner);
});

test('full chain accepts the new policy actor only through the verified recovery server wrapper', async () => {
  const { actor, trust, old, oldId, server, challenge, before, after, draft, recovery, replacement } = fixture();
  const encode = (principal, payload, snapshot, key, recovery = false) => {
    const applied = Buffer.from(JSON.stringify(snapshot));
    const draft = { ...payload, ResultDigest: digest(applied) };
    const change = payload.ResourceChange && Buffer.from(JSON.stringify(payload.ResourceChange));
    let frame = protectedPolicySignatureFrame(trust.serverId, principal, draft, Buffer.from('null'), change ? [digest(change)] : []);
    if (recovery) frame = signatureFrame('pawtalk-protected-recovery-device-proof-v1', digest(frame));
    const signature = sign(null, frame, key);
    draft.Signature = signature.toString('base64');
    return { digest: digest(signature), entry: { snapshot: applied.toString('base64'), roleUpdate: 'bnVsbA==',
      record: Buffer.from(JSON.stringify({ Principal: principal, Draft: draft })).toString('base64'),
      ...(change && { resourceChange: change.toString('base64') }) } };
  };
  const anchorOperation = 'b'.repeat(32);
  const anchor = encode({ ProfileID: actor.ProfileID, DeviceID: oldId },
    { Action: 'policy.anchor', Revision: 1, PreviousDigest: '', OperationID: anchorOperation, PublicKey: '', RoleUpdate: null },
    before, old.privateKey);
  const basis = { ...challenge, policyHead: anchor.digest };
  const signed = draft(basis);
  const valid = encode(actor, signed, after, server.privateKey, true);
  const page = proof => ({ headRevision: 2, headDigest: proof.digest, proofs: [anchor.entry, proof.entry] });
  const proofTrust = { ...trust, anchorDigest: anchor.digest };
  const storage = { async load() {}, async save() {} };
  assert.equal((await new ProtectedPolicyCheckpoint(storage).accept(page(valid), proofTrust)).digest, valid.digest);
  const tampered = structuredClone(signed);
  tampered.ResourceChange.RecoveryDevice.RecoveryProof = Buffer.alloc(64).toString('base64url');
  const malicious = encode(actor, tampered, after, server.privateKey, true);
  await assert.rejects(new ProtectedPolicyCheckpoint(storage).accept(page(malicious), proofTrust),
    { code: 'INVALID_PROTECTED_RECOVERY_DEVICE_PROOF' });

  const oldKey = raw(old.publicKey).toString('hex');
  const genesis = authority.scopeAuthorityGenesis(proofTrust, oldKey);
  const genesisFields = { action: 'recovery.authorize', revision: 1, policyHead: anchor.digest,
    operationId: anchorOperation, recoveryId: recovery.recoveryId, recoveryKey: recovery.signingKey, deviceKey: oldKey };
  const detached = authority.signScopeAuthorityLink(proofTrust, genesis, genesisFields, old.privateKey);
  const detachedState = authority.advanceScopeAuthority(proofTrust, genesis, detached);
  const next = structuredClone(signed);
  next.ResourceChange.RecoveryDevice.ScopeAuthority = authority.signScopeAuthorityLink(proofTrust, detachedState, {
    ...genesisFields, action: 'recovery.device', revision: next.Revision, operationId: next.OperationID,
    deviceKey: raw(replacement.publicKey).toString('hex'),
  }, recovery.signing, replacement.privateKey);
  const transferred = encode(actor, next, after, server.privateKey, true);
  const detachedPage = { ...page(transferred), genesisScopeAuthority: detached };
  let saved;
  const credentials = { async load() { return saved; }, async save(_key, text) { saved = text; } };
  const verifier = new ProtectedPolicyCheckpoint(credentials);
  // The import can seed the anchor checkpoint before its detached receipt is available.
  await verifier.accept({ headRevision: 1, headDigest: anchor.digest, proofs: [anchor.entry] }, proofTrust);
  await verifier.accept({ ...detachedPage, proofs: [transferred.entry] }, proofTrust);
  const current = await verifier.load(proofTrust);
  assert.equal(current.scopeAuthority.deviceId, actor.DeviceID);
  assert.equal(current.genesisScopeAuthorityDigest, detachedState.digest);
  const historical = await verifier.verifyHistory(proofTrust, current, 1, async () => detachedPage);
  assert.deepEqual(historical.scopeAuthority, detachedState);
  await assert.rejects(verifier.accept({ headRevision: 2, headDigest: transferred.digest, proofs: [] }, proofTrust),
    { code: 'POLICY_ROLLBACK' });

  const wrongOperation = authority.signScopeAuthorityLink(proofTrust, genesis, {
    ...genesisFields, operationId: 'f'.repeat(32),
  }, old.privateKey);
  await assert.rejects(verifier.accept({ ...detachedPage, proofs: [], genesisScopeAuthority: wrongOperation }, proofTrust),
    { code: 'POLICY_FORK' });
  await assert.rejects(new ProtectedPolicyCheckpoint(storage).accept({ ...detachedPage, genesisScopeAuthority: wrongOperation }, proofTrust),
    { code: 'INVALID_SCOPE_AUTHORITY' });
  const differentRecovery = deriveRecoveryIdentity(Buffer.alloc(32, 22).toString('base64url'), trust.serverId, actor.ProfileID);
  const substitute = authority.signScopeAuthorityLink(proofTrust, genesis, {
    ...genesisFields, recoveryKey: differentRecovery.signingKey, recoveryId: differentRecovery.recoveryId,
  }, old.privateKey);
  await assert.rejects(new ProtectedPolicyCheckpoint(storage).accept({ ...detachedPage, genesisScopeAuthority: substitute }, proofTrust),
    { code: 'INVALID_SCOPE_AUTHORITY' });

  // A checkpoint written by an older Client lacks the anchor's operation ID.
  saved = undefined;
  await verifier.accept({ headRevision: 1, headDigest: anchor.digest, proofs: [anchor.entry] }, proofTrust);
  const oldCheckpoint = JSON.parse(saved);
  delete oldCheckpoint.genesisOperationId;
  saved = JSON.stringify(oldCheckpoint);
  let fetched = 0;
  await verifier.accept({ ...detachedPage, proofs: [transferred.entry] }, proofTrust, async afterRevision => {
    assert.equal(afterRevision, 0);
    fetched += 1;
    return detachedPage;
  });
  assert.equal(fetched, 1);
  assert.equal((await verifier.load(proofTrust)).scopeAuthority.deviceId, actor.DeviceID);
});
