import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import membership from '../../shared/membership.cjs';
import clientModule from '../../apps/client/windows/electron/membership-client.cjs';
import checkpoint from '../../apps/client/windows/electron/protected-policy-checkpoint.cjs';
import { default as packages } from '../../apps/client/windows/electron/protected-epoch-packages.cjs';
import recovery from '../../apps/client/windows/electron/protected-migration-recovery.cjs';
import runtime from '../../apps/client/windows/electron/protected-runtime-recovery.cjs';

const { signatureFrame } = membership;
const { MembershipClient } = clientModule;
const { protectedPolicySignatureFrame, ProtectedPolicyCheckpoint } = checkpoint;
const { recoveryPackageOpeningFrame } = packages;
const { deriveRecoveryIdentity } = recovery;
const { recoveryConfirmationManifest, prepareProtectedRecoveryConfirmation } = runtime;
const raw = key => key.export({ type: 'spki', format: 'der' }).subarray(-32);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const code = Buffer.alloc(32, 17).toString('base64url');
const operationId = '1'.repeat(32);
const channelId = '2'.repeat(32);

function fixture() {
  const server = generateKeyPairSync('ed25519'), device = generateKeyPairSync('ed25519');
  const deviceKey = raw(device.publicKey).toString('hex'), deviceId = digest(raw(device.publicKey));
  const serverId = digest(raw(server.publicKey)).slice(0, 32);
  const profileId = '3'.repeat(64), cutoverDigest = '4'.repeat(64), policyHead = '5'.repeat(64);
  const recovery = deriveRecoveryIdentity(code, serverId, profileId);
  const connection = {
    serverId, cutoverDigest, profileId, deviceId, fingerprint: '6'.repeat(64), base: 'https://127.0.0.1:18888',
    token: 'synthetic-session',
    policyTrust: { serverId, cutoverDigest, ownerProfileId: profileId, ownerDeviceId: deviceId, anchorDigest: policyHead },
  };
  const actor = { ProfileID: profileId, DeviceID: deviceId };
  const identity = { deviceId, device: device.privateKey };
  const challenge = { serverId, cutoverDigest, profileId, deviceId, policyHead,
    recoveryId: recovery.recoveryId, nonce: '7'.repeat(64), expiresAt: 160_000, challengeToken: Buffer.alloc(32, 14).toString('base64url') };
  const item = (purpose, basis = challenge) => {
    const opening = generateKeyPairSync('ed25519');
    const reference = { channelId, purpose, generation: 1, epochDigest: '8'.repeat(64), packageDigest: '9'.repeat(64),
      openingKey: raw(opening.publicKey).toString('hex') };
    const frame = recoveryPackageOpeningFrame({ ...basis, ...reference });
    return { ...reference, openingProof: sign(null, frame, opening.privateKey).toString('base64url'),
      recoveryProof: sign(null, frame, recovery.signing).toString('base64url') };
  };
  const draft = (proposal, basis = challenge) => ({
    Action: 'recovery.confirm', Revision: 2, OperationID: operationId, PreviousDigest: basis.policyHead, PublicKey: '', RoleUpdate: null,
    ResourceChange: { ID: profileId, RecoveryConfirmation: { RecoveryID: recovery.recoveryId, CutoverDigest: cutoverDigest,
      Nonce: basis.nonce, ExpiresAt: basis.expiresAt, ServerKey: raw(server.publicKey).toString('base64url'),
      Items: proposal.items.map(item => ({ ChannelID: item.channelId, Purpose: item.purpose, Generation: item.generation,
        EpochDigest: item.epochDigest, PackageDigest: item.packageDigest, OpeningKey: item.openingKey,
        OpeningProof: item.openingProof, RecoveryProof: item.recoveryProof })),
      RecoveryProof: proposal.recoveryProof, DeviceProof: proposal.deviceProof } },
  });
  return { server, device, deviceKey, actor, identity, recovery, connection, challenge, item, draft };
}

test('confirmation manifest matches canonical framing, rejects weak opening keys and scales to full room scope', () => {
  const { item } = fixture();
  const short = [item('archive'), item('live')];
  const fields = value => [value.channelId, value.purpose, String(value.generation), value.epochDigest, value.packageDigest,
    value.openingKey, value.openingProof, value.recoveryProof];
  const domain = 'pawtalk-protected-recovery-confirmation-items-v1';
  assert.equal(recoveryConfirmationManifest([]), digest(signatureFrame(domain)));
  assert.equal(recoveryConfirmationManifest(short), digest(signatureFrame(domain, ...short.flatMap(fields))));
  assert.throws(() => recoveryConfirmationManifest([...short].reverse()), { code: 'INVALID_PROTECTED_RECOVERY_PROOF' });
  assert.throws(() => recoveryConfirmationManifest([{ ...short[0], openingKey: '01' + '00'.repeat(31) }]),
    { code: 'INVALID_PROTECTED_RECOVERY_PROOF' });
  const many = Array.from({ length: 1000 }, (_, index) =>
    short.map(item => ({ ...item, channelId: index.toString(16).padStart(32, '0') }))).flat();
  const framed = [domain, ...many.flatMap(fields)].map(value => {
    const bytes = Buffer.from(value), size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    return Buffer.concat([size, bytes]);
  });
  assert.equal(recoveryConfirmationManifest(many), digest(Buffer.concat(framed)));
});

test('full confirmation replay requires global and per-package approval and complete authorized channel scope', async () => {
  const state = fixture();
  const { server, device, deviceKey, actor, identity, recovery, connection, challenge, item, draft } = state;
  const { profileId, deviceId, serverId } = connection;
  const before = {
    Owner: profileId, Members: { [profileId]: { ID: profileId, Active: true, Roles: [] } },
    PolicyDevices: { [deviceId]: { ProfileID: profileId, PublicKey: deviceKey } },
    Channels: { [channelId]: { Kind: 'text' } },
    Admissions: { [channelId]: { [profileId]: { FirstPosition: 1 } } }, RecoveryReady: {},
    RecoveryIdentities: { [profileId]: { ID: recovery.recoveryId, SigningKey: recovery.signingKey, AgreementKey: recovery.agreementKey } },
    KeyRecipients: { [recovery.recoveryId]: { ProfileID: profileId, Kind: 'recovery', PublicKey: recovery.agreementKey } },
  };
  const makeProof = (payload, state, key, serverSigned = false) => {
    const snapshot = Buffer.from(JSON.stringify(state));
    const draft = { ...payload, ResultDigest: digest(snapshot) };
    const resource = draft.ResourceChange && Buffer.from(JSON.stringify(draft.ResourceChange));
    let frame = protectedPolicySignatureFrame(serverId, actor, draft, Buffer.from('null'), resource ? [digest(resource)] : []);
    if (serverSigned) frame = signatureFrame('pawtalk-protected-recovery-confirmation-proof-v1', digest(frame));
    const signature = sign(null, frame, key);
    draft.Signature = signature.toString('base64');
    return { digest: digest(signature), entry: { snapshot: snapshot.toString('base64'), roleUpdate: Buffer.from('null').toString('base64'),
      record: Buffer.from(JSON.stringify({ Principal: actor, Draft: draft })).toString('base64'),
      ...(resource && { resourceChange: resource.toString('base64') }) } };
  };
  const anchor = makeProof({ Action: 'policy.anchor', OperationID: 'b'.repeat(32), Revision: 1, PreviousDigest: '', PublicKey: '',
    RoleUpdate: null }, before, device.privateKey);
  const basis = { ...challenge, policyHead: anchor.digest };
  const trust = { ...connection.policyTrust, anchorDigest: anchor.digest };
  const items = [item('archive', basis), item('live', basis)];
  const ready = { ...before, RecoveryReady: { [profileId]: true } };
  const proposal = items => prepareProtectedRecoveryConfirmation(connection, basis, operationId, recovery, identity, items);
  const asProof = approval => makeProof(approval, ready, server.privateKey, true);
  const page = proof => ({ headRevision: 2, headDigest: proof.digest, proofs: [anchor.entry, proof.entry] });
  const storage = { async load() {}, async save() {} };
  const valid = asProof(draft(proposal(items), basis));
  assert.equal((await new ProtectedPolicyCheckpoint(storage).accept(page(valid), trust)).digest, valid.digest);
  const missing = asProof(draft(proposal(items.slice(1)), basis));
  await assert.rejects(new ProtectedPolicyCheckpoint(storage).accept(page(missing), trust), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });

  // Even a new server signature and freshly approved manifest cannot replace
  // the opening signature for a specific encrypted package.
  const forged = draft(proposal(items), basis);
  const wrong = { ...items[0], openingProof: Buffer.alloc(64, 15).toString('base64url') };
  forged.ResourceChange.RecoveryConfirmation.Items[0].OpeningProof = wrong.openingProof;
  const frame = signatureFrame('pawtalk-protected-recovery-confirmation-v1', serverId, basis.cutoverDigest,
    profileId, deviceId, operationId, basis.policyHead, basis.recoveryId, basis.nonce, String(basis.expiresAt),
    recoveryConfirmationManifest([wrong, items[1]]));
  const recoveryProof = sign(null, frame, recovery.signing).toString('base64url');
  forged.ResourceChange.RecoveryConfirmation.RecoveryProof = recoveryProof;
  forged.ResourceChange.RecoveryConfirmation.DeviceProof = sign(null,
    signatureFrame('pawtalk-protected-recovery-confirmation-device-v1', digest(frame), recoveryProof), device.privateKey).toString('base64url');
  await assert.rejects(new ProtectedPolicyCheckpoint(storage).accept(page(asProof(forged)), trust), { code: 'INVALID_PROTECTED_RECOVERY_PROOF' });
});

test('confirmation waits for coverage, honors endpoint rate limit and retries a lost receipt byte for byte', async () => {
  const { connection, challenge, identity } = fixture();
  const client = new MembershipClient({ credentials: { async save() { assert.fail('unexpected credential write'); } } });
  client.identity = async () => identity;
  let pending = true;
  client.readProtectedRecoveryCoverage = async () => ({ policyHead: challenge.policyHead, recoveryId: challenge.recoveryId,
    items: pending ? [{ pending: true }] : [] });
  client.readProtectedPolicyAttestation = async () => ({ digest: challenge.policyHead, revision: 1 });
  let issuance = 0;
  const confirmations = [];
  client.fetchJSON = async (_base, path, { body }) => {
    assert.ok(!body.includes(code));
    if (path.endsWith('/confirmation-challenge')) {
      if (++issuance === 1) throw Object.assign(new Error('RATE_LIMIT'), { code: 'RATE_LIMIT', retryAfter: 1 });
      return challenge;
    }
    assert.ok(path.endsWith('/confirm'));
    confirmations.push(body);
    if (confirmations.length === 1) throw Object.assign(new Error('lost receipt'), { code: 'ECONNRESET' });
    const { operationId, recoveryId } = JSON.parse(body);
    return { operationId, recoveryId, revision: 2, digest: 'a'.repeat(64) };
  };
  await assert.rejects(client.confirmProtectedRuntimeRecovery(connection, code), { code: 'PROTECTED_RECOVERY_PENDING' });
  assert.equal(issuance, 0);
  pending = false;
  await assert.rejects(client.confirmProtectedRuntimeRecovery(connection, code), { code: 'ECONNRESET' });
  const confirmed = await client.confirmProtectedRuntimeRecovery(connection, code);
  assert.equal(issuance, 2);
  assert.equal(confirmations[0], confirmations[1]);
  assert.equal(confirmed.ready, true);
});
