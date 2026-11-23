import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import linking from '../../apps/client/windows/electron/protected-profile-linking.cjs';
import checkpoint from '../../apps/client/windows/electron/protected-policy-checkpoint.cjs';
import replay from '../../apps/client/windows/electron/protected-policy-replay.cjs';
import migration from '../../apps/client/windows/electron/protected-migration-recovery.cjs';
import membership from '../../shared/membership.cjs';

const { signatureFrame } = membership;
const { protectedPolicySignatureFrame, ProtectedPolicyCheckpoint } = checkpoint;
const { signProtectedProfileLinkConsent, signProtectedProfileUnlinkConsent, verifyProtectedProfileLinking, policyProfileForDevice } = linking;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const raw = key => key.export({ type: 'spki', format: 'der' }).subarray(-32);
const numericId = (value, length) => value.toString(16).padStart(length, '0');

function fixture() {
  const server = generateKeyPairSync('ed25519');
  const trust = { serverId: hash(raw(server.publicKey)).slice(0, 32), cutoverDigest: '9'.repeat(64) };
  const member = index => {
    const key = generateKeyPairSync('ed25519'), agreement = generateKeyPairSync('x25519');
    const ProfileID = numericId(index, 64), DeviceID = hash(raw(key.publicKey));
    return { key, principal: { ProfileID, DeviceID }, agreement: raw(agreement.publicKey).toString('hex'),
      recovery: migration.deriveRecoveryIdentity(Buffer.alloc(32, index).toString('base64url'), trust.serverId, ProfileID) };
  };
  const primary = member(1), secondary = member(2), source = member(3);
  const [A, B, C] = [primary, secondary, source].map(profile => profile.principal.ProfileID);
  const [a, b, c] = [primary, secondary, source].map(profile => profile.principal.DeviceID);
  Object.assign(trust, { ownerProfileId: A, ownerDeviceId: a, anchorDigest: 'f'.repeat(64) });
  const categoryB = 'a'.repeat(32), categoryC = 'b'.repeat(32), channel = 'c'.repeat(32);
  const snapshot = {
    Owner: A, Roles: { existing: { Grants: ['channel.view'] } },
    Members: Object.fromEntries([A, B, C].map((ID, index) => [ID, { ID, Roles: ['existing'], Active: true, TimeoutUntil: index }])),
    PolicyDevices: Object.fromEntries([primary, secondary, source].map(profile => [profile.principal.DeviceID,
      { ProfileID: profile.principal.ProfileID, PublicKey: raw(profile.key.publicKey).toString('hex') }])),
    KeyRecipients: Object.fromEntries([primary, secondary, source].flatMap(({ principal, agreement, recovery }) => [
      [principal.DeviceID, { ProfileID: principal.ProfileID, Kind: 'device', PublicKey: agreement }],
      [recovery.recoveryId, { ProfileID: principal.ProfileID, Kind: 'recovery', PublicKey: recovery.agreementKey }],
    ])),
    RecoveryIdentities: Object.fromEntries([primary, secondary, source].map(({ principal, recovery }) => [principal.ProfileID,
      { ID: recovery.recoveryId, SigningKey: recovery.signingKey, AgreementKey: recovery.agreementKey }])),
    RecoveryReady: { [A]: true, [B]: true, [C]: true },
    Categories: {
      [categoryB]: { Profiles: { [B]: { Allow: ['channel.view'], Deny: ['message.send'] } } },
      [categoryC]: { Profiles: { [C]: { Allow: ['channel.view'], Deny: null } } },
    },
    CategoryCreators: { [categoryB]: B, [categoryC]: C },
    Channels: { [channel]: { Kind: 'text', ACL: { Profiles: { [C]: { Allow: ['history.full'], Deny: ['message.send'] } } } } },
    Admissions: { [channel]: { [A]: { FirstPosition: 1 }, [B]: { FirstPosition: 1 }, [C]: { FirstPosition: 1 } } },
  };
  const draft = (action, revision, policyHead, approver, other) => {
    const common = { CutoverDigest: trust.cutoverDigest, ExpiresAt: 1001, At: 1000, ServerKey: raw(server.publicKey).toString('base64url') };
    const value = { Action: action, Revision: revision, PreviousDigest: policyHead, OperationID: numericId(revision, 32), PublicKey: '', RoleUpdate: null };
    if (action === 'profile.link') {
      const link = { ...common, PrimaryDeviceID: approver.principal.DeviceID, SecondaryProfileID: other.principal.ProfileID,
        SecondaryDeviceID: other.principal.DeviceID };
      value.ResourceChange = { ID: approver.principal.ProfileID, ProfileLink: link };
      link.PrimaryProof = signProtectedProfileLinkConsent(trust, value, approver.principal, approver.key.privateKey);
      link.SecondaryProof = signProtectedProfileLinkConsent(trust, value, other.principal, other.key.privateKey);
    } else {
      value.ResourceChange = { ID: other.principal.ProfileID, ProfileUnlink: common };
      common.DeviceProof = signProtectedProfileUnlinkConsent(trust, approver.principal, value, approver.key.privateKey);
    }
    return value;
  };
  return { trust, server, primary, secondary, source, A, B, C, a, b, c, channel, categoryB, categoryC, snapshot, draft };
}

test('both signed consents capture participant roles, devices, exact policy head, and deadline', () => {
  const { trust, primary, secondary, snapshot, draft, A, a, B, b } = fixture();
  const link = draft('profile.link', 2, trust.anchorDigest, primary, secondary);
  const claim = link.ResourceChange.ProfileLink;
  const request = signatureFrame('pawtalk-protected-profile-link-consent-v1', trust.serverId, trust.cutoverDigest,
    trust.anchorDigest, link.OperationID, A, a, B, b, String(claim.ExpiresAt));
  assert.ok(verify(null, request, primary.key.publicKey, Buffer.from(claim.PrimaryProof, 'base64url')));
  assert.ok(verify(null, request, secondary.key.publicKey, Buffer.from(claim.SecondaryProof, 'base64url')));
  verifyProtectedProfileLinking(trust, primary.principal, link, snapshot);
  assert.throws(() => signProtectedProfileLinkConsent(trust, link, secondary.principal, primary.key.privateKey),
    { code: 'INVALID_PROTECTED_PROFILE_LINKING' });
  assert.throws(() => verifyProtectedProfileLinking(trust, primary.principal, {
    ...link, PreviousDigest: 'e'.repeat(64),
  }, snapshot), { code: 'INVALID_PROTECTED_PROFILE_LINKING' });
  assert.throws(() => verifyProtectedProfileLinking(trust, primary.principal, {
    ...link, ResourceChange: { ID: A, ProfileLink: { ...claim, At: claim.ExpiresAt } },
  }, snapshot), { code: 'INVALID_PROTECTED_PROFILE_LINKING' });
  const unlink = draft('profile.unlink', 3, trust.anchorDigest, primary, secondary);
  const detach = signatureFrame('pawtalk-protected-profile-unlink-consent-v1', trust.serverId, trust.cutoverDigest,
    trust.anchorDigest, unlink.OperationID, A, a, B, String(unlink.ResourceChange.ProfileUnlink.ExpiresAt));
  assert.ok(verify(null, detach, primary.key.publicKey, Buffer.from(unlink.ResourceChange.ProfileUnlink.DeviceProof, 'base64url')));
});

test('whole policy replays two merged groups and unlinks only the requested device origin', async () => {
  const { trust, server, primary, secondary, source, A, B, C, a, b, c, channel, categoryB, categoryC, snapshot, draft } = fixture();
  const encode = (actor, payload, applied, key) => {
    const snapshot = Buffer.from(JSON.stringify(applied));
    const roles = Buffer.from('null');
    const claims = payload.ResourceChange && Buffer.from(JSON.stringify(payload.ResourceChange));
    const value = { ...payload, ResultDigest: hash(snapshot) };
    let frame = protectedPolicySignatureFrame(trust.serverId, actor, value, roles, claims ? [hash(claims)] : []);
    if (claims) frame = signatureFrame(payload.Action === 'profile.link' ? 'pawtalk-protected-profile-link-proof-v1' : 'pawtalk-protected-profile-unlink-proof-v1', hash(frame));
    const signature = sign(null, frame, key);
    value.Signature = signature.toString('base64');
    return { digest: hash(signature), wire: {
      record: Buffer.from(JSON.stringify({ Principal: actor, Draft: value })).toString('base64'),
      roleUpdate: roles.toString('base64'), snapshot: snapshot.toString('base64'), ...(claims && { resourceChange: claims.toString('base64') }),
    } };
  };
  const genesisDraft = { Action: 'policy.anchor', Revision: 1, OperationID: numericId(1, 32), PreviousDigest: '', RoleUpdate: null, PublicKey: '' };
  const genesis = encode(primary.principal, genesisDraft, snapshot, primary.key.privateKey);
  trust.anchorDigest = genesis.digest;
  const retire = (state, profile) => {
    const { principal, recovery } = profile;
    const id = principal.ProfileID;
    state.Members[id] = { ...state.Members[id], Active: false, Roles: null };
    delete state.RecoveryReady[id];
    delete state.RecoveryIdentities[id];
    delete state.KeyRecipients[recovery.recoveryId];
    delete state.Admissions[channel][id];
    state.RetiredRecoverySigningKeys = { ...state.RetiredRecoverySigningKeys, [recovery.signingKey]: true };
    state.RetiredRecipientKeys = { ...state.RetiredRecipientKeys, [recovery.agreementKey]: true };
  };
  const two = structuredClone(snapshot);
  retire(two, source);
  two.ProfileBindings = { [C]: B };
  two.ProfileDeviceOrigins = { [c]: C };
  two.PolicyDevices[c].ProfileID = B;
  two.KeyRecipients[c].ProfileID = B;
  delete two.CategoryCreators[categoryC];
  delete two.Categories[categoryC].Profiles[C];
  two.Channels[channel].ACL.Profiles[C].Allow = null;
  const linkOne = draft('profile.link', 2, genesis.digest, secondary, source);
  const proofTwo = encode(secondary.principal, linkOne, two, server.privateKey);
  assert.throws(() => replay.replayPolicyTransition(undefined, two, primary.principal, genesisDraft, A),
    { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  replay.replayPolicyTransition(undefined, { ...two, ImportedProfileBindings: true }, primary.principal, genesisDraft, A);
  assert.throws(() => replay.replayPolicyTransition(undefined, { ...two, ImportedProfileBindings: 'true' }, primary.principal, genesisDraft, A),
    { code: 'UNAUTHORIZED_POLICY_TRANSITION' });

  const three = structuredClone(two);
  retire(three, secondary);
  three.ProfileBindings = { [C]: A, [B]: A };
  three.ProfileDeviceOrigins[b] = B;
  for (const deviceId of [b, c]) {
    three.PolicyDevices[deviceId].ProfileID = A;
    three.KeyRecipients[deviceId].ProfileID = A;
  }
  delete three.CategoryCreators;
  three.Categories[categoryB].Profiles[B].Allow = null;
  assert.equal(policyProfileForDevice(two, c), B);
  const movedApprover = { ...source, principal: { ProfileID: B, DeviceID: c } };
  const linkTwo = draft('profile.link', 3, proofTwo.digest, primary, movedApprover);
  const proofThree = encode(primary.principal, linkTwo, three, server.privateKey);

  const four = structuredClone(three);
  delete four.ProfileBindings[B];
  delete four.ProfileDeviceOrigins[b];
  four.PolicyDevices[b].ProfileID = B;
  four.PolicyDevices[b].Revoked = true;
  delete four.KeyRecipients[b];
  four.RetiredRecipientKeys[secondary.agreement] = true;
  const unlink = draft('profile.unlink', 4, proofThree.digest, primary, secondary);
  assert.throws(() => replay.replayPolicyTransition({ ...three, ImportedProfileBindings: true }, four, primary.principal, unlink, A),
    { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  const proofFour = encode(primary.principal, unlink, four, server.privateKey);
  const prefix = [genesis.wire, proofTwo.wire, proofThree.wire];
  const page = proof => ({ headRevision: 4, headDigest: proof.digest, proofs: [...prefix, proof.wire] });
  let saved;
  const storage = { async load() { return saved; }, async save(_key, value) { saved = value; } };
  const client = new ProtectedPolicyCheckpoint(storage);
  assert.equal((await client.accept(page(proofFour), trust)).digest, proofFour.digest);
  assert.equal(policyProfileForDevice(four, a), A);
  assert.equal(policyProfileForDevice(four, b), undefined);
  assert.equal(policyProfileForDevice(four, c), A);

  saved = undefined;
  const forged = structuredClone(unlink);
  forged.ResourceChange.ProfileUnlink.DeviceProof = Buffer.alloc(64).toString('base64url');
  const invalid = encode(primary.principal, forged, four, server.privateKey);
  await assert.rejects(client.accept(page(invalid), trust), { code: 'INVALID_PROTECTED_PROFILE_LINKING' });
  const restored = structuredClone(four);
  restored.Members[B] = snapshot.Members[B];
  await assert.rejects(client.accept(page(encode(primary.principal, unlink, restored, server.privateKey)), trust),
    { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  const inheritedBan = { ...two, MemberRemovals: { [C]: { Action: 'member.ban', ExpiresAt: 0 } } };
  assert.throws(() => replay.replayPolicyTransition(inheritedBan, {
    ...three, MemberRemovals: inheritedBan.MemberRemovals,
  }, primary.principal, linkTwo, A), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  const injected = encode(primary.principal, genesisDraft, { ...four, PolicyDevices: snapshot.PolicyDevices }, primary.key.privateKey);
  await assert.rejects(client.accept({ headRevision: 1, headDigest: injected.digest, proofs: [injected.wire] },
    { ...trust, anchorDigest: injected.digest }), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
});
