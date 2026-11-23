import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import membership from '../../shared/membership.cjs';
import archiveSession from '../../apps/client/windows/electron/protected-archive-session.cjs';
import packages from '../../apps/client/windows/electron/protected-epoch-packages.cjs';
import recovery from '../../apps/client/windows/electron/protected-migration-recovery.cjs';

const { signatureFrame } = membership;
const { runLiveRotation, packageContext } = archiveSession;
const { epochSignatureFrame, packagesDigest, openSignedEpochPackage, sealRecoveryEpochPackage,
  openSignedRecoveryEpochPackage, recoveryPackageOpeningFrame, proveSignedRecoveryEpochOpening, sealKeyPackage } = packages;
const digest = (...values) => {
  const hash = createHash('sha256');
  for (const value of values) hash.update(value);
  return hash.digest('hex');
};
const raw = key => key.export({ type: 'spki', format: 'der' }).subarray(-32);
const openingPublicKey = encoded => createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), encoded]), type: 'spki', format: 'der',
});

function fixture() {
  const serverId = '1'.repeat(32), profileId = '2'.repeat(64), cutoverDigest = '3'.repeat(64), policyHead = '4'.repeat(64);
  const member = generateKeyPairSync('ed25519'), memberAgreement = generateKeyPairSync('x25519');
  const alternate = generateKeyPairSync('x25519');
  const deviceId = digest(raw(member.publicKey));
  const signer = { profileId, deviceId, key: raw(member.publicKey).toString('hex') };
  const principal = { ProfileID: profileId, DeviceID: deviceId };
  const identity = recovery.deriveRecoveryIdentity(Buffer.alloc(32, 5).toString('base64url'), serverId, profileId);
  const secret = Buffer.alloc(32, 11);
  const base = {
    ChannelID: '6'.repeat(32), Purpose: 'live', Generation: 1, Revision: 2, PolicyDigest: policyHead, PreviousDigest: '',
    TaskID: '7'.repeat(32), LeaseID: '8'.repeat(32), KeyID: digest(secret), ArchiveThrough: 0, ArchiveLinksDigest: '',
  };
  const context = { ...packageContext(serverId, base, identity.recoveryId, identity.agreementKey), cutoverDigest, profileId, deviceId, policyHead };
  const bundle = (ciphertext, record = base, other) => {
    const first = { RecipientID: context.recipientId, Purpose: context.purpose, Ciphertext: ciphertext.toString('base64') };
    const all = other ? [first, other] : [first];
    const value = { ...record, PackagesDigest: packagesDigest(all) };
    value.Signature = sign(null, epochSignatureFrame(serverId, profileId, deviceId, value), member.privateKey).toString('base64');
    const Proof = other
      ? { index: first.RecipientID < other.RecipientID ? 0 : 1, count: 2, siblings: [leaf(other)] }
      : { index: 0, count: 1, siblings: [] };
    return { Epoch: { Principal: principal, Record: value }, Package: first, Proof };
  };
  const frame = value => signatureFrame('pawtalk-epoch-package-v1', value.serverId, value.channelId, String(value.generation),
    String(value.revision), value.policyDigest, value.previousDigest, value.taskId, value.leaseId, value.keyId, value.recipientId,
    value.recipientKey, value.purpose);
  const challenge = (ciphertext, delivery) => ({
    serverId, cutoverDigest, profileId, deviceId, recoveryId: context.recipientId, policyHead,
    channelId: context.channelId, purpose: context.purpose, generation: context.generation,
    epochDigest: digest(Buffer.from(delivery.Epoch.Record.Signature, 'base64')), packageDigest: digest(ciphertext),
    nonce: '9'.repeat(64), expiresAt: 160_000,
  });
  return { serverId, profileId, deviceId, signer, member, memberAgreement, alternate, identity, secret, base, context, bundle, frame, challenge };
}

function leaf(item) {
  return digest(Buffer.from([0, item.Purpose === 'archive' ? 0 : 1]), Buffer.from(item.RecipientID, 'hex'),
    Buffer.from(item.Ciphertext, 'base64'));
}

test('opening a committed recovery epoch verifies each proof independently without returning the seed', () => {
  const { context, signer, identity, secret, bundle, challenge } = fixture();
  const ciphertext = sealRecoveryEpochPackage(secret, context);
  assert.equal(ciphertext.length, 144);
  const another = sealRecoveryEpochPackage(secret, context);
  assert.notDeepEqual(another.subarray(112), ciphertext.subarray(112));
  const delivery = bundle(ciphertext);
  const material = openSignedRecoveryEpochPackage(delivery, context, identity.agreement, signer);
  assert.deepEqual(material, secret);
  material.fill(0);

  const order = challenge(ciphertext, delivery);
  const proof = proveSignedRecoveryEpochOpening(delivery, context, identity.agreement, signer, order, identity.signing);
  assert.deepEqual(Object.keys(proof).sort(), ['openingKey', 'openingProof', 'recoveryProof']);
  assert.equal(proof.openingKey, ciphertext.subarray(112).toString('hex'));
  const transcript = recoveryPackageOpeningFrame(order);
  const opening = openingPublicKey(ciphertext.subarray(112));
  assert.ok(verify(null, transcript, opening, Buffer.from(proof.openingProof, 'base64url')));
  assert.ok(verify(null, transcript, createPublicKey(identity.signing), Buffer.from(proof.recoveryProof, 'base64url')));
  assert.equal(verify(null, transcript, openingPublicKey(another.subarray(112)), Buffer.from(proof.openingProof, 'base64url')), false);
  assert.throws(() => proveSignedRecoveryEpochOpening(delivery, context, identity.agreement, signer,
    { ...order, packageDigest: digest(another) }, identity.signing), /INVALID_RECOVERY_OPENING_CHALLENGE/);
  assert.throws(() => proveSignedRecoveryEpochOpening(delivery, context, identity.agreement, signer,
    { ...order, policyHead: 'a'.repeat(64) }, identity.signing), /INVALID_RECOVERY_OPENING_CHALLENGE/);
  assert.throws(() => proveSignedRecoveryEpochOpening(delivery, context, identity.agreement, signer,
    order, generateKeyPairSync('ed25519').privateKey), /INVALID_RECOVERY_OPENING_CHALLENGE/);
});

test('wrong key, leaf changes, invalid ciphertext and inconsistent decrypted identities never prove opening', () => {
  const { context, signer, identity, secret, alternate, base, frame, bundle } = fixture();
  const ciphertext = sealRecoveryEpochPackage(secret, context);
  const delivery = bundle(ciphertext);
  assert.throws(() => openSignedRecoveryEpochPackage(delivery, context, alternate.privateKey, signer), /INVALID_RECOVERY_EPOCH_PACKAGE/);
  assert.throws(() => openSignedEpochPackage(delivery, context, identity.agreement, signer), /INVALID_EPOCH_PACKAGE_ENCODING/);
  assert.throws(() => openSignedRecoveryEpochPackage({ ...delivery, Proof: { index: 0, count: 1, siblings: ['a'.repeat(64)] } },
    context, identity.agreement, signer), /INVALID_EPOCH_PACKAGE_PROOF/);

  const changedTail = Buffer.from(ciphertext);
  changedTail[143] ^= 1;
  assert.throws(() => openSignedRecoveryEpochPackage({ ...delivery, Package: { ...delivery.Package, Ciphertext: changedTail.toString('base64') } },
    context, identity.agreement, signer), /INVALID_EPOCH_PACKAGE_PROOF/);
  assert.throws(() => openSignedRecoveryEpochPackage(bundle(changedTail), context, identity.agreement, signer), /INVALID_RECOVERY_OPENING_KEY/);
  const malformed = Buffer.from(ciphertext);
  malformed[100] ^= 1;
  assert.throws(() => openSignedRecoveryEpochPackage(bundle(malformed), context, identity.agreement, signer));

  const keyId = 'a'.repeat(64);
  const wrongContext = { ...context, keyId };
  const wrongSecret = Buffer.concat([secret, Buffer.alloc(32, 7)]);
  try {
    const recipient = Buffer.from(identity.agreementKey, 'hex');
    const sealed = Buffer.concat([sealKeyPackage(wrongSecret, recipient, frame(wrongContext)), ciphertext.subarray(112)]);
    assert.throws(() => openSignedRecoveryEpochPackage(bundle(sealed, { ...base, KeyID: keyId }), wrongContext, identity.agreement, signer),
      /INVALID_RECOVERY_EPOCH_KEY/);
  } finally {
    wrongSecret.fill(0);
  }
});

test('runtime rotation produces 144 bytes only for eligible marked recovery recipients', async () => {
  const { serverId, profileId, deviceId, identity, base, member, memberAgreement, signer } = fixture();
  const deviceKey = raw(memberAgreement.publicKey).toString('hex');
  const recipients = {
    [identity.recoveryId]: { ProfileID: profileId, Kind: 'recovery', PublicKey: identity.agreementKey },
    [deviceId]: { ProfileID: profileId, Kind: 'device', PublicKey: deviceKey },
  };
  let committed;
  const run = openingProofRecipients => runLiveRotation({
    serverId, channelId: base.ChannelID, profileId, identity: { deviceId, device: member.privateKey },
    claim: async () => ({ ...base, Recipients: recipients, openingProofRecipients }),
    async authorizeTask() {},
    async commit(record, packages) { committed = { record, packages }; },
  });
  await assert.rejects(run([deviceId]), { code: 'INVALID_EPOCH_PACKAGES' });
  await assert.rejects(run([identity.recoveryId, identity.recoveryId]), { code: 'INVALID_EPOCH_PACKAGES' });
  assert.equal(committed, undefined);
  await run([identity.recoveryId]);
  const { record, packages } = committed;
  const runtime = packages.find(item => item.RecipientID === identity.recoveryId);
  const device = packages.find(item => item.RecipientID === deviceId);
  assert.equal(Buffer.from(runtime.Ciphertext, 'base64').length, 144);
  assert.equal(Buffer.from(device.Ciphertext, 'base64').length, 80);
  const delivery = (item, other) => ({
    Epoch: { Principal: { ProfileID: profileId, DeviceID: deviceId }, Record: record },
    Package: item, Proof: { count: 2, index: item.RecipientID < other.RecipientID ? 0 : 1, siblings: [leaf(other)] },
  });
  const readDevice = openSignedEpochPackage(delivery(device, runtime), packageContext(serverId, record, deviceId, deviceKey),
    memberAgreement.privateKey, signer);
  const readRuntime = openSignedRecoveryEpochPackage(delivery(runtime, device),
    packageContext(serverId, record, identity.recoveryId, identity.agreementKey), identity.agreement, signer);
  try { assert.deepEqual(readDevice, readRuntime); }
  finally { readDevice.fill(0); readRuntime.fill(0); }
  await run(undefined);
  assert.ok(committed.packages.every(item => Buffer.from(item.Ciphertext, 'base64').length === 80));
});
