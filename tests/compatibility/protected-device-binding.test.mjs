import assert from 'node:assert/strict';
import { createHash, createHmac, diffieHellman, generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import binding from '../../apps/client/windows/electron/protected-device-binding.cjs';
import checkpoint from '../../apps/client/windows/electron/protected-policy-checkpoint.cjs';
import replay from '../../apps/client/windows/electron/protected-policy-replay.cjs';
import membership from '../../shared/membership.cjs';

const { prepareProtectedDeviceBindingApplicant, prepareProtectedDeviceBindingApproval,
  checkProtectedDeviceBindingApplicant, verifyProtectedDeviceBinding } = binding;
const { protectedPolicySignatureFrame, ProtectedPolicyCheckpoint } = checkpoint;
const { signatureFrame } = membership;
const digest = value => createHash('sha256').update(value).digest('hex');
const raw = key => key.export({ type: 'spki', format: 'der' }).subarray(-32);

function fixture() {
  const approver = generateKeyPairSync('ed25519'), candidate = generateKeyPairSync('ed25519'), server = generateKeyPairSync('ed25519');
  const agreement = generateKeyPairSync('x25519'), serverAgreement = generateKeyPairSync('x25519');
  const serverId = digest(raw(server.publicKey)).slice(0, 32), profileId = '1'.repeat(64), cutoverDigest = '2'.repeat(64);
  const approverDeviceId = digest(raw(approver.publicKey)), candidateId = digest(raw(candidate.publicKey)), policyHead = '3'.repeat(64);
  const operationId = '4'.repeat(32), nonce = '5'.repeat(64), expiresAt = 1_700_000_000_000;
  const signingKey = raw(candidate.publicKey).toString('hex'), agreementKey = raw(agreement.publicKey).toString('hex');
  const trust = { serverId, cutoverDigest, anchorDigest: policyHead, ownerProfileId: profileId, ownerDeviceId: approverDeviceId };
  const expected = { serverId, cutoverDigest, profileId, approverDeviceId };
  const challenge = { ...expected, policyHead, operationId, nonce, expiresAt, serverAgreementKey: raw(serverAgreement.publicKey).toString('hex') };
  const keys = { device: candidate.privateKey, agreement: agreement.privateKey };
  const actor = { ProfileID: profileId, DeviceID: approverDeviceId };
  const before = {
    Owner: profileId, Members: { [profileId]: { ID: profileId, Active: true, Roles: ['existing'] } },
    Roles: { existing: { Grants: ['channel.view'] } }, PolicyDevices: { [approverDeviceId]: { ProfileID: profileId, PublicKey: raw(approver.publicKey).toString('hex') } },
    Channels: {}, Admissions: {}, KeyRecipients: null, RecoveryReady: { [profileId]: true },
  };
  const after = {
    ...before, PolicyDevices: { ...before.PolicyDevices, [candidateId]: { ProfileID: profileId, PublicKey: signingKey } },
    KeyRecipients: { [candidateId]: { ProfileID: profileId, Kind: 'device', PublicKey: agreementKey } },
  };
  const makeDraft = (basis = challenge) => {
    const { proposal, claims } = prepareProtectedDeviceBindingApplicant(expected, basis, keys);
    const { approverProof } = prepareProtectedDeviceBindingApproval(expected, basis, proposal, approver.privateKey);
    return { Action: 'device.bind', OperationID: basis.operationId, Revision: 2, PreviousDigest: basis.policyHead, PublicKey: '',
      RoleUpdate: null, ResourceChange: { ID: profileId,
        DeviceBinding: { ...claims, ApproverProof: approverProof, ServerKey: raw(server.publicKey).toString('base64url') } } };
  };
  return { trust, expected, challenge, keys, actor, approver, candidate, server, agreement, serverAgreement, candidateId, before, after, makeDraft };
}

test('device binding sends only public applicant proof and signs approval for the exact challenge', () => {
  const { expected, challenge, keys, approver, candidate, agreement, serverAgreement, actor, trust, makeDraft } = fixture();
  const { proposal } = prepareProtectedDeviceBindingApplicant(expected, challenge, keys);
  assert.deepEqual(Object.keys(proposal).sort(), ['agreementKey', 'agreementProof', 'applicantProof', 'operationId', 'signingKey']);
  assert.deepEqual(checkProtectedDeviceBindingApplicant(expected, challenge, proposal), {
    deviceId: digest(raw(candidate.publicKey)), expiresAt: challenge.expiresAt,
  });
  const request = signatureFrame('pawtalk-protected-device-bind-v1', challenge.serverId, challenge.cutoverDigest, challenge.profileId,
    challenge.approverDeviceId, challenge.policyHead, challenge.operationId, challenge.nonce, String(challenge.expiresAt),
    challenge.serverAgreementKey, proposal.signingKey, proposal.agreementKey);
  assert.ok(verify(null, request, candidate.publicKey, Buffer.from(proposal.applicantProof, 'base64url')));
  const shared = diffieHellman({ privateKey: serverAgreement.privateKey, publicKey: agreement.publicKey });
  try { assert.equal(createHmac('sha256', shared).update(request).digest('base64url'), proposal.agreementProof); }
  finally { shared.fill(0); }
  const { approverProof } = prepareProtectedDeviceBindingApproval(expected, challenge, proposal, approver.privateKey);
  const approval = signatureFrame('pawtalk-protected-device-bind-approval-v1', digest(request), proposal.applicantProof, proposal.agreementProof);
  assert.ok(verify(null, approval, approver.publicKey, Buffer.from(approverProof, 'base64url')));
  verifyProtectedDeviceBinding(trust, actor, makeDraft(), raw(approver.publicKey).toString('hex'));

  assert.throws(() => prepareProtectedDeviceBindingApproval(expected, challenge, proposal, candidate.privateKey),
    { code: 'INVALID_PROTECTED_DEVICE_BINDING' });
  for (const field of ['cutoverDigest', 'profileId', 'approverDeviceId', 'policyHead', 'nonce', 'serverAgreementKey']) {
    assert.throws(() => prepareProtectedDeviceBindingApproval(expected, { ...challenge, [field]: 'a'.repeat(64) }, proposal, approver.privateKey),
      { code: 'INVALID_PROTECTED_DEVICE_BINDING' });
  }
  assert.throws(() => prepareProtectedDeviceBindingApplicant(expected, { ...challenge, serverAgreementKey: '0'.repeat(64) }, keys),
    { code: 'INVALID_PROTECTED_DEVICE_BINDING' });
  assert.throws(() => prepareProtectedDeviceBindingApproval(expected, challenge, { ...proposal, agreementProof: proposal.agreementProof + '=' },
    approver.privateKey), { code: 'INVALID_PROTECTED_DEVICE_BINDING' });
});

test('binding replay adds exactly one device to the same active profile and rejects retired key material', () => {
  const { trust, actor, candidateId, before, after, makeDraft } = fixture();
  const draft = makeDraft();
  const { SigningKey, AgreementKey } = draft.ResourceChange.DeviceBinding;
  const apply = (prior, snapshot = after) => replay.replayPolicyTransition(prior, snapshot, actor, draft, trust.ownerProfileId);
  apply(before);
  for (const prior of [
    { ...before, MemberRemovals: { [trust.ownerProfileId]: { Action: 'member.ban', ExpiresAt: 1 } } },
    { ...before, PolicyDevices: { [actor.DeviceID]: { ...before.PolicyDevices[actor.DeviceID], Revoked: true } } },
    { ...before, PolicyDevices: { ...before.PolicyDevices, [candidateId]: { ProfileID: actor.ProfileID, PublicKey: SigningKey, Revoked: true } } },
    { ...before, RetiredRecipientKeys: { [AgreementKey]: true } },
    { ...before, RetiredRecoverySigningKeys: { [SigningKey]: true } },
  ]) {
    assert.throws(() => apply(prior), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  }
  assert.throws(() => apply(before, { ...after, RecoveryReady: {} }), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  assert.throws(() => apply(before, { ...after, KeyRecipients: null }), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
});

test('explicit detach permits a fresh agreement key for only the eligible original signing device', () => {
  const { trust, actor, candidateId, before, makeDraft } = fixture();
  const source = '8'.repeat(64), target = actor.ProfileID;
  const sibling = generateKeyPairSync('ed25519'), revoked = generateKeyPairSync('ed25519');
  const siblingId = digest(raw(sibling.publicKey)), revokedId = digest(raw(revoked.publicKey));
  const oldAgreement = raw(generateKeyPairSync('x25519').publicKey).toString('hex');
  const draft = makeDraft();
  const binding = draft.ResourceChange.DeviceBinding;
  const linked = structuredClone(before);
  linked.Members[source] = { ID: source, Roles: null, Active: false, TimeoutUntil: 0 };
  linked.ProfileBindings = { [source]: target };
  linked.ProfileDeviceOrigins = { [candidateId]: source, [siblingId]: source, [revokedId]: source };
  linked.PolicyDevices[candidateId] = { ProfileID: target, PublicKey: binding.SigningKey };
  linked.PolicyDevices[siblingId] = { ProfileID: target, PublicKey: raw(sibling.publicKey).toString('hex') };
  linked.PolicyDevices[revokedId] = { ProfileID: target, PublicKey: raw(revoked.publicKey).toString('hex'), Revoked: true };
  linked.KeyRecipients = { [candidateId]: { ProfileID: target, Kind: 'device', PublicKey: oldAgreement } };
  const detached = structuredClone(linked);
  delete detached.ProfileBindings;
  delete detached.ProfileDeviceOrigins;
  delete detached.KeyRecipients[candidateId];
  detached.RetiredRecipientKeys = { [oldAgreement]: true };
  for (const id of [candidateId, siblingId, revokedId]) {
    detached.PolicyDevices[id].ProfileID = source;
    detached.PolicyDevices[id].Revoked = true;
  }
  const unlinkClaim = { CutoverDigest: trust.cutoverDigest, ServerKey: binding.ServerKey, ExpiresAt: binding.ExpiresAt,
    At: binding.ExpiresAt - 2, DeviceProof: binding.ApplicantProof };
  const unlink = { Action: 'profile.unlink', Revision: 2, OperationID: '6'.repeat(32), RoleUpdate: null, PublicKey: '',
    ResourceChange: { ID: source, ProfileUnlink: unlinkClaim } };
  const apply = (prior, next, operation, approver = actor) => replay.replayPolicyTransition(prior, next, approver, operation, trust.ownerProfileId);
  apply(linked, detached, unlink);
  const allowed = structuredClone(detached);
  allowed.DetachedPolicyDevices = { [candidateId]: source, [siblingId]: source };
  unlink.ResourceChange.ProfileUnlink.GrantDeviceRebind = true;
  apply(linked, allowed, unlink);
  assert.throws(() => apply(linked, { ...allowed, DetachedPolicyDevices: { ...allowed.DetachedPolicyDevices, [revokedId]: source } }, unlink),
    { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  unlink.ResourceChange.ProfileUnlink.GrantDeviceRebind = false;
  assert.throws(() => apply(linked, detached, unlink), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });

  binding.RebindAt = binding.ExpiresAt - 1;
  draft.Revision = 3;
  const attached = structuredClone(allowed);
  attached.ProfileBindings = { [source]: target };
  attached.ProfileDeviceOrigins = { [candidateId]: source };
  delete attached.DetachedPolicyDevices[candidateId];
  attached.PolicyDevices[candidateId] = { ProfileID: target, PublicKey: binding.SigningKey };
  attached.KeyRecipients[candidateId] = { ProfileID: target, Kind: 'device', PublicKey: binding.AgreementKey };
  apply(allowed, attached, draft);
  assert.deepEqual(attached.Members, allowed.Members);
  const lostAuthority = { ...allowed, DetachedPolicyDevices: { [siblingId]: source } };
  const activeSource = structuredClone(allowed);
  activeSource.Members[source].Active = true;
  const differentPrimary = { ...allowed, ProfileBindings: { [source]: '9'.repeat(64) } };
  const activeBan = { ...allowed, MemberRemovals: { [source]: { Action: 'member.ban', ExpiresAt: binding.ExpiresAt } } };
  const expiredBan = { ...allowed, MemberRemovals: { [source]: { Action: 'member.ban', ExpiresAt: binding.RebindAt } } };
  apply(expiredBan, { ...attached, MemberRemovals: expiredBan.MemberRemovals }, draft);
  for (const invalid of [detached, lostAuthority, activeSource, differentPrimary, activeBan]) {
    assert.throws(() => apply(invalid, attached, draft), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  }
  const reused = structuredClone(draft);
  reused.ResourceChange.DeviceBinding.AgreementKey = oldAgreement;
  assert.throws(() => apply(allowed, attached, reused), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  const late = structuredClone(draft);
  late.ResourceChange.DeviceBinding.RebindAt = binding.ExpiresAt;
  assert.throws(() => apply(allowed, attached, late), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  const restoredRoles = structuredClone(attached);
  restoredRoles.Members[target].Roles.push('old-role');
  assert.throws(() => apply(allowed, restoredRoles, draft), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });

  const normalAdmission = structuredClone(allowed);
  const freshRoot = generateKeyPairSync('ed25519');
  const originalId = digest(raw(freshRoot.publicKey));
  const originalDevice = generateKeyPairSync('ed25519');
  const originalDeviceId = digest(raw(originalDevice.publicKey));
  normalAdmission.Members[originalId] = { ID: originalId, Roles: null, Active: false, TimeoutUntil: 0 };
  normalAdmission.PolicyDevices[originalDeviceId] = { ProfileID: originalId, PublicKey: raw(originalDevice.publicKey).toString('hex'), Revoked: true };
  normalAdmission.DetachedPolicyDevices[originalDeviceId] = originalId;
  const readmitted = structuredClone(normalAdmission);
  readmitted.Members[originalId].Active = true;
  delete readmitted.PolicyDevices[originalDeviceId].Revoked;
  delete readmitted.DetachedPolicyDevices[originalDeviceId];
  readmitted.KeyRecipients[originalDeviceId] = { ProfileID: originalId, Kind: 'device', PublicKey: binding.AgreementKey };
  readmitted.InvitationUses = { invite: { IssueSignature: 'verification fixture', Count: 1 } };
  const admission = { Action: 'member.redeem', Revision: 3, RoleUpdate: null, PublicKey: '', ResourceChange: { ID: originalId, Admission: {
    CutoverDigest: trust.cutoverDigest, Issuance: { AcceptedAt: 1, MaxUses: 0, Signature: 'verification fixture' }, Claim: {
      inviteId: 'invite', profilePublicKey: raw(freshRoot.publicKey).toString('base64url'),
      devicePublicKey: raw(originalDevice.publicKey).toString('base64url'), agreementKey: binding.AgreementKey,
    },
  } } };
  apply(normalAdmission, readmitted, admission, { ProfileID: originalId, DeviceID: originalDeviceId });
  assert.throws(() => apply(normalAdmission, { ...readmitted, DetachedPolicyDevices: normalAdmission.DetachedPolicyDevices }, admission,
    { ProfileID: originalId, DeviceID: originalDeviceId }), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
});

test('a valid server wrapper cannot waive applicant or approver proof in full replay', async () => {
  const { trust, actor, approver, server, challenge, before, after, makeDraft } = fixture();
  const encode = (draft, snapshot, privateKey) => {
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const record = { ...draft, ResultDigest: digest(bytes) };
    const resource = draft.ResourceChange && Buffer.from(JSON.stringify(draft.ResourceChange));
    let frame = protectedPolicySignatureFrame(trust.serverId, actor, record, Buffer.from('null'), resource ? [digest(resource)] : []);
    if (resource) frame = signatureFrame('pawtalk-protected-device-bind-proof-v1', digest(frame));
    const signature = sign(null, frame, privateKey).toString('base64');
    record.Signature = signature;
    return { digest: digest(Buffer.from(signature, 'base64')), entry: { snapshot: bytes.toString('base64'), roleUpdate: 'bnVsbA==',
      record: Buffer.from(JSON.stringify({ Principal: actor, Draft: record })).toString('base64'),
      ...(resource && { resourceChange: resource.toString('base64') }) } };
  };
  const genesis = encode({ Action: 'policy.anchor', Revision: 1, OperationID: 'a'.repeat(32), PreviousDigest: '', PublicKey: '', RoleUpdate: null },
    before, approver.privateKey);
  const pinned = { ...trust, anchorDigest: genesis.digest };
  const approved = makeDraft({ ...challenge, policyHead: genesis.digest });
  const page = proof => ({ headRevision: 2, headDigest: proof.digest, proofs: [genesis.entry, proof.entry] });
  const storage = { async load() {}, async save() {} };
  const valid = encode(approved, after, server.privateKey);
  assert.equal((await new ProtectedPolicyCheckpoint(storage).accept(page(valid), pinned)).digest, valid.digest);
  for (const field of ['ApplicantProof', 'ApproverProof', 'AgreementProof']) {
    const changed = structuredClone(approved);
    changed.ResourceChange.DeviceBinding[field] = Buffer.alloc(field === 'AgreementProof' ? 32 : 64).toString('base64url');
    const wrapped = encode(changed, after, server.privateKey);
    await assert.rejects(new ProtectedPolicyCheckpoint(storage).accept(page(wrapped), pinned), { code: 'INVALID_PROTECTED_DEVICE_BINDING' });
  }
});
