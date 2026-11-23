import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import main from '../../apps/client/windows/electron/membership-client.cjs';
import binding from '../../apps/client/windows/electron/protected-device-binding.cjs';
import codec from '../../apps/client/windows/electron/protected-device-binding-card.cjs';
import agreements from '../../apps/client/windows/electron/protected-device-agreement.cjs';

const { MembershipClient } = main;
const { prepareProtectedDeviceBindingApplicant, prepareProtectedDeviceBindingApproval } = binding;
const { deviceBindingCard, openDeviceBindingCard } = codec;
const { deviceAgreementPrivateKey, deviceAgreementKeySlot } = agreements;
const hash = value => createHash('sha256').update(value).digest('hex');
const raw = key => createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
const previousSeed = '14'.repeat(32);

function fixture() {
  const device = generateKeyPairSync('ed25519').privateKey;
  const approver = generateKeyPairSync('ed25519').privateKey;
  const serverKey = generateKeyPairSync('x25519').privateKey;
  const deviceId = hash(raw(device)), serverId = '1'.repeat(32), cutoverDigest = '2'.repeat(64), profileId = '3'.repeat(64);
  const trust = { serverId, cutoverDigest, anchorDigest: '4'.repeat(64), ownerProfileId: profileId, ownerDeviceId: hash(raw(approver)) };
  const fingerprint = '5'.repeat(64), address = 'https://pawtalk.test:8443', binding = '6'.repeat(64);
  const canonical = deviceAgreementKeySlot(serverId, deviceId);
  const stored = new Map([[canonical, previousSeed]]);
  const state = { approved: new Map(), canonicalFailure: false, writes: [], sessionProfileId: profileId };
  const credentials = {
    async load(slot) { return stored.get(slot); },
    async save(slot, value) {
      if (slot === canonical && state.canonicalFailure) throw Error('interrupted canonical write');
      state.writes.push(slot);
      if (value === null) stored.delete(slot);
      else stored.set(slot, value);
    },
  };
  const makeCard = (operation = '7'.repeat(32)) => deviceBindingCard('challenge', {
    fingerprint, address, trust, challenge: { serverId, cutoverDigest, profileId, approverDeviceId: trust.ownerDeviceId,
      expiresAt: 1_700_000_000_000, nonce: '8'.repeat(64), policyHead: trust.anchorDigest, operationId: operation,
      serverAgreementKey: raw(serverKey).toString('hex') },
  });
  const approve = (requestCard, revision = 2) => {
    const { challenge, proposal } = openDeviceBindingCard('request', requestCard);
    const signature = prepareProtectedDeviceBindingApproval(challenge, challenge, proposal, approver);
    const receipt = { ...signature, operationId: proposal.operationId, profileId, deviceId, revision,
      digest: hash(requestCard), approverSigningKey: raw(approver).toString('hex'), agreementKey: proposal.agreementKey };
    state.approved.set(receipt.operationId, receipt);
    return receipt;
  };
  function client() {
    const value = new MembershipClient({ credentials });
    value.identity = async () => ({ deviceId, device, profileId });
    value.records = async () => [];
    value.discoverMembership = async (address, expectedId, expectedFingerprint) => {
      assert.equal(expectedId, serverId);
      assert.equal(expectedFingerprint, fingerprint);
      return { base: address, fingerprint: expectedFingerprint, config: { apiProtocolVersion: 3, cutoverDigest, anchorDigest: trust.anchorDigest, binding } };
    };
    value.readProtectedRuntimeState = async () => ({ serverId, profileId: state.sessionProfileId });
    value.remember = async () => {};
    value.fetchJSON = async (_base, path, options) => {
      assert.equal(options.fingerprint, fingerprint);
      if (path === '/api/v3/session/challenge') {
        return { apiProtocolVersion: 3, serverId, cutoverDigest, binding, nonce: '9'.repeat(64), expiresAt: 1_700_000_000_000 };
      }
      const token = Buffer.alloc(32, 9).toString('base64url');
      if (path === '/api/v3/session/open') {
        if (!state.approved.size) throw Object.assign(Error('Invalid session proof'), { code: 'INVALID_PROTECTED_SESSION_PROOF' });
        return { deviceId, profileId: state.sessionProfileId, token, sessionId: 'a'.repeat(32), expiresAt: Date.now() + 3600000 };
      }
      const resultPath = '/api/v3/devices/bind/result/';
      assert.ok(path.startsWith(resultPath));
      assert.equal(options.headers.Authorization, 'Bearer ' + token);
      assert.equal(options.method ?? 'GET', 'GET');
      return state.approved.get(path.slice(resultPath.length));
    };
    return value;
  }
  return { device, canonical, stored, state, makeCard, approve, client };
}

test('binding keeps one durable new key for a repeated card and promotes only an approved matching receipt', async () => {
  const { canonical, stored, state, makeCard, approve, client } = fixture();
  const card = makeCard();
  const initial = client();
  const [first, repeated] = await Promise.all([initial.makeProtectedDeviceRequest(card), initial.makeProtectedDeviceRequest(card)]);
  assert.equal(first, repeated);
  assert.equal(stored.get(canonical), previousSeed);
  const requested = openDeviceBindingCard('request', first);
  assert.notEqual(requested.proposal.agreementKey, raw(deviceAgreementPrivateKey(previousSeed)).toString('hex'));
  const restarted = client();
  assert.equal(await restarted.makeProtectedDeviceRequest(card), first);
  await assert.rejects(restarted.finishProtectedDeviceBinding(card), { code: 'INVALID_PROTECTED_SESSION_PROOF' });
  assert.equal(stored.get(canonical), previousSeed);
  const receipt = approve(first);
  for (const patch of [
    { agreementKey: raw(deviceAgreementPrivateKey(previousSeed)).toString('hex') },
    { approverSigningKey: requested.proposal.signingKey },
    { approverProof: Buffer.alloc(64).toString('base64url') },
  ]) {
    state.approved.set(receipt.operationId, { ...receipt, ...patch });
    await assert.rejects(restarted.finishProtectedDeviceBinding(card), { code: 'INVALID_PROTECTED_DEVICE_BINDING' });
    assert.equal(stored.get(canonical), previousSeed);
  }
  state.approved.set(receipt.operationId, receipt);
  state.canonicalFailure = true;
  await assert.rejects(restarted.finishProtectedDeviceBinding(card), /interrupted canonical write/);
  assert.equal(stored.get(canonical), previousSeed);
  assert.ok([...stored.keys()].some(key => key.includes('device-binding-pending')));
  state.canonicalFailure = false;
  const resumed = client();
  assert.equal((await resumed.finishProtectedDeviceBinding(card)).profileId, requested.challenge.profileId);
  assert.equal(raw(deviceAgreementPrivateKey(stored.get(canonical))).toString('hex'), receipt.agreementKey);
  assert.ok(![...stored.keys()].some(key => key.includes('device-binding-pending')));
  assert.equal(await resumed.makeProtectedDeviceRequest(card), first);
  assert.equal((await resumed.finishProtectedDeviceBinding(card)).deviceId, receipt.deviceId);
});

test('a previously approved operation cannot overwrite the active seed for a newer binding', async () => {
  const { canonical, stored, makeCard, approve, client } = fixture();
  const older = makeCard('1'.repeat(32)), newer = makeCard('2'.repeat(32));
  const current = client();
  approve(await current.makeProtectedDeviceRequest(older), 2);
  const latest = approve(await current.makeProtectedDeviceRequest(newer), 4);
  await current.finishProtectedDeviceBinding(newer);
  await assert.rejects(current.finishProtectedDeviceBinding(older), { code: 'POLICY_ROLLBACK' });
  assert.equal(raw(deviceAgreementPrivateKey(stored.get(canonical))).toString('hex'), latest.agreementKey);
});

test('a legacy pending request finishes with its verified canonical key even after challenge expiration', async () => {
  const { device, canonical, stored, state, makeCard, approve, client } = fixture();
  const card = makeCard();
  const { challenge } = openDeviceBindingCard('challenge', card);
  const { proposal } = prepareProtectedDeviceBindingApplicant(challenge, challenge, { device, agreement: deviceAgreementPrivateKey(previousSeed) });
  const request = deviceBindingCard('request', { challenge, proposal });
  approve(request);
  const resumed = client();
  await resumed.finishProtectedDeviceBinding(card);
  assert.equal(stored.get(canonical), previousSeed);
  assert.ok(!state.writes.includes(canonical));
  assert.equal(await resumed.makeProtectedDeviceRequest(card), request);
});

test('a legacy receipt can complete even after the upgraded Client generated a different pending key', async () => {
  const { device, canonical, stored, state, makeCard, approve, client } = fixture();
  const card = makeCard();
  const { challenge } = openDeviceBindingCard('challenge', card);
  const { proposal } = prepareProtectedDeviceBindingApplicant(challenge, challenge, { device, agreement: deviceAgreementPrivateKey(previousSeed) });
  const approvedLegacy = deviceBindingCard('request', { challenge, proposal });
  approve(approvedLegacy);
  const upgraded = client();
  assert.notEqual(await upgraded.makeProtectedDeviceRequest(card), approvedLegacy);
  assert.equal((await upgraded.finishProtectedDeviceBinding(card)).profileId, challenge.profileId);
  assert.equal(stored.get(canonical), previousSeed);
  assert.ok(!state.writes.includes(canonical));
  assert.ok(![...stored.keys()].some(key => key.includes('device-binding-pending')));
  assert.equal(await upgraded.makeProtectedDeviceRequest(card), approvedLegacy);
});

test('receipt completion follows a merged profile only when the active session confirms it', async () => {
  const { canonical, stored, state, makeCard, approve, client } = fixture();
  const card = makeCard();
  const current = client();
  const receipt = approve(await current.makeProtectedDeviceRequest(card));
  const merged = 'b'.repeat(64);
  state.sessionProfileId = merged;
  await assert.rejects(current.finishProtectedDeviceBinding(card), { code: 'INVALID_PROTECTED_SESSION' });
  assert.equal(stored.get(canonical), previousSeed);
  state.approved.set(receipt.operationId, { ...receipt, effectiveProfileId: 'invalid' });
  await assert.rejects(current.finishProtectedDeviceBinding(card), { code: 'INVALID_PROTECTED_DEVICE_BINDING' });
  state.approved.set(receipt.operationId, { ...receipt, effectiveProfileId: merged });
  assert.equal((await current.finishProtectedDeviceBinding(card)).profileId, merged);
  assert.equal(raw(deviceAgreementPrivateKey(stored.get(canonical))).toString('hex'), receipt.agreementKey);
});
