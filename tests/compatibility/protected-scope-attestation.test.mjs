import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import attestations from '../../apps/client/windows/electron/protected-policy-attestation.cjs';
import authority from '../../apps/client/windows/electron/protected-scope-authority.cjs';
import membership from '../../shared/membership.cjs';

const { PolicyAttestationCheckpoint, policyAttestationFrame, verifyPolicyAttestation } = attestations;

test('attested scope checkpoint detects known rollback, forks and signer substitution', async () => {
  const owner = generateKeyPairSync('ed25519');
  const publicKey = key => key.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const signerKey = publicKey(owner.publicKey);
  const trust = { serverId: '1'.repeat(32), anchorDigest: '2'.repeat(64), ownerProfileId: '3'.repeat(64),
    ownerDeviceId: createHash('sha256').update(Buffer.from(signerKey, 'hex')).digest('hex') };
  const signed = claims => ({ ...claims, signerKey,
    signature: sign(null, policyAttestationFrame(trust, claims), owner.privateKey).toString('base64') });
  const genesis = signed({ revision: 1, digest: trust.anchorDigest, previous: '', policyDigest: '4'.repeat(64), root: '5'.repeat(64) });
  const second = signed({ revision: 2, digest: '6'.repeat(64), previous: genesis.digest, policyDigest: '7'.repeat(64), root: '8'.repeat(64) });
  const fork = signed({ ...second, digest: '9'.repeat(64) });
  const unrelated = signed({ ...second, revision: 3, previous: fork.digest });

  let saved;
  const storage = { load: async () => saved, save: async (_id, value) => { saved = value; } };
  await new PolicyAttestationCheckpoint(storage).acceptCurrent(trust, genesis);
  const checkpoint = new PolicyAttestationCheckpoint(storage);
  assert.deepEqual(await checkpoint.acceptCurrent(trust, second), second);
  await assert.rejects(checkpoint.acceptCurrent(trust, genesis), { code: 'POLICY_ROLLBACK' });
  await assert.rejects(checkpoint.acceptCurrent(trust, fork), { code: 'POLICY_FORK' });
  await assert.rejects(checkpoint.acceptCurrent(trust, unrelated), { code: 'POLICY_FORK' });
  assert.throws(() => verifyPolicyAttestation({ ...trust, serverId: '0'.repeat(32) }, second), { code: 'INVALID_POLICY_ATTESTATION' });
  assert.throws(() => verifyPolicyAttestation(trust, { ...second, signerKey: publicKey(generateKeyPairSync('ed25519').publicKey) }),
    { code: 'INVALID_POLICY_ATTESTATION' });
  assert.deepEqual(JSON.parse(saved), second);
  const legacy = signed({ ...second, revision: 3, digest: 'a'.repeat(64), previous: second.digest, projectionVersion: 8 });
  await checkpoint.acceptCurrent(trust, legacy);
  const current = signed({ ...second, revision: 4, digest: 'b'.repeat(64), previous: legacy.digest, projectionVersion: 9 });
  await checkpoint.acceptCurrent(trust, current);
  const intermediateReceipt = { digest: current.digest, previousDigest: current.previous, resultDigest: current.policyDigest,
    projectionRoot: current.root };
  const inviteBase = signed({ ...second, projectionVersion: current.projectionVersion });
  assert.deepEqual(await checkpoint.acceptCurrent(trust, inviteBase, undefined, new Map([[4, intermediateReceipt]])), inviteBase);
  assert.deepEqual(JSON.parse(saved), current, 'historical invite base must never lower the durable checkpoint');
  await assert.rejects(checkpoint.acceptCurrent(trust, inviteBase, undefined, new Map([[4, { ...intermediateReceipt, projectionRoot: genesis.root }]])),
    { code: 'POLICY_FORK' });
  await assert.rejects(checkpoint.acceptCurrent(trust, inviteBase, undefined, new Map([[3, intermediateReceipt]])), { code: 'POLICY_ROLLBACK' });
  const downgrade = signed({ ...second, revision: 5, previous: current.digest, projectionVersion: 8 });
  await assert.rejects(checkpoint.acceptCurrent(trust, downgrade), { code: 'POLICY_ROLLBACK' });
});

test('v2 authority moves attestation signing to a fresh device and preserves both rollback floors', async () => {
  const { scopeAuthorityGenesis, signScopeAuthorityLink, advanceScopeAuthority } = authority;
  const { signatureFrame } = membership;
  const owner = generateKeyPairSync('ed25519'), recovery = generateKeyPairSync('ed25519'), device = generateKeyPairSync('ed25519');
  const raw = key => key.export({ type: 'spki', format: 'der' }).subarray(-32);
  const publicKey = pair => raw(pair.publicKey).toString('hex');
  const trust = { serverId: '1'.repeat(32), anchorDigest: '2'.repeat(64), ownerProfileId: '3'.repeat(64), cutoverDigest: '4'.repeat(64),
    ownerDeviceId: createHash('sha256').update(raw(owner.publicKey)).digest('hex') };
  const genesis = scopeAuthorityGenesis(trust, publicKey(owner));
  const recoveryFields = { recoveryId: '5'.repeat(64), recoveryKey: publicKey(recovery) };
  const authorize = signScopeAuthorityLink(trust, genesis, { action: 'recovery.authorize', revision: 2, policyHead: trust.anchorDigest,
    operationId: '5'.repeat(32), deviceKey: publicKey(owner), ...recoveryFields }, owner.privateKey);
  const first = advanceScopeAuthority(trust, genesis, authorize);
  const transfer = signScopeAuthorityLink(trust, first, { action: 'recovery.device', revision: 5, policyHead: '6'.repeat(64),
    operationId: '6'.repeat(32), deviceKey: publicKey(device), ...recoveryFields }, recovery.privateKey, device.privateKey);
  const second = advanceScopeAuthority(trust, first, transfer);
  const branch = states => ({ state: states.at(-1), prefixes: new Map(states.map(state => [state.digest, state])) });
  const initial = branch([genesis, first]), next = branch([genesis, first, second]);
  const claims = { revision: 2, digest: '7'.repeat(64), previous: trust.anchorDigest,
    policyDigest: '8'.repeat(64), projectionVersion: 8, root: '9'.repeat(64) };
  const signed = (key, view, state) => {
    const fields = { ...view, ...(state && { authorityHead: state.digest, authorityRevision: state.revision, signerDeviceId: state.deviceId }) };
    const frame = policyAttestationFrame(trust, fields);
    if (state) {
      assert.deepEqual(frame, signatureFrame('pawtalk-policy-scope-attestation-v2', trust.serverId, trust.anchorDigest,
        trust.ownerProfileId, state.deviceId, String(fields.revision), fields.digest, fields.previous,
        fields.policyDigest, '8', fields.root, state.digest, String(state.revision)));
    }
    return { ...fields, signerKey: publicKey(key), signature: sign(null, frame, key.privateKey).toString('base64') };
  };
  const v1 = signed(owner, claims);
  const approved = signed(owner, claims, first);
  const renewed = signed(device, claims, second);
  assert.throws(() => verifyPolicyAttestation(trust, renewed), { code: 'INVALID_POLICY_ATTESTATION' });
  assert.throws(() => verifyPolicyAttestation(trust, signed(owner, claims, second), next), { code: 'INVALID_POLICY_ATTESTATION' });
  assert.throws(() => verifyPolicyAttestation(trust, { ...renewed, authorityHead: first.digest }, next), { code: 'INVALID_POLICY_ATTESTATION' });
  const { signerDeviceId, ...partial } = renewed;
  assert.throws(() => verifyPolicyAttestation(trust, partial, next), { code: 'INVALID_POLICY_ATTESTATION' });
  assert.deepEqual(verifyPolicyAttestation(trust, approved, next), approved, 'historical signers remain verifiable');
  assert.deepEqual(verifyPolicyAttestation(trust, renewed, next), renewed, 'a new device can re-attest a historical policy');

  let saved;
  const storage = { load: async () => saved, save: async (_id, value) => { saved = value; } };
  const checkpoint = new PolicyAttestationCheckpoint(storage);
  await checkpoint.acceptCurrent(trust, v1);
  await checkpoint.acceptCurrent(trust, approved, initial);
  await checkpoint.acceptCurrent(trust, renewed, next);
  await assert.rejects(checkpoint.acceptCurrent(trust, v1), { code: 'POLICY_ROLLBACK' });
  await assert.rejects(checkpoint.acceptCurrent(trust, approved, initial), { code: 'POLICY_ROLLBACK' });
  const different = advanceScopeAuthority(trust, first, signScopeAuthorityLink(trust, first,
    { ...transfer, revision: 6, operationId: 'a'.repeat(32) }, recovery.privateKey, device.privateKey));
  await assert.rejects(checkpoint.acceptCurrent(trust, signed(device, claims, different), branch([genesis, first, different])),
    { code: 'POLICY_FORK' });
  assert.deepEqual(JSON.parse(saved), renewed);
  saved = JSON.stringify({ ...renewed, signerKey: publicKey(owner) });
  await assert.rejects(checkpoint.acceptCurrent(trust, renewed, next), { code: 'INVALID_LOCAL_POLICY_ATTESTATION' });
});
