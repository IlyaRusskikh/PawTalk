import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { test } from 'node:test';
import { openArchiveLinks } from '../../apps/client/windows/electron/protected-archive-links.cjs';
import { packageContext, runArchiveRotation } from '../../apps/client/windows/electron/protected-archive-session.cjs';
import {
  epochSignatureFrame, openSignedEpochPackage, packagesDigest, sealEpochPackage, sealRecoveryEpochPackage,
} from '../../apps/client/windows/electron/protected-epoch-packages.cjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const publicBytes = key => key.export({ format: 'der', type: 'spki' }).subarray(-32);

test('a replacement device can fold recovery and ordinary targets into the same archive lease', async () => {
  const serverId = 'a'.repeat(32), channelId = 'b'.repeat(32), profileId = 'c'.repeat(64), recoveryId = 'd'.repeat(64);
  const previousSigner = generateKeyPairSync('ed25519');
  const replacementSigner = generateKeyPairSync('ed25519');
  const previousDeviceId = hash(publicBytes(previousSigner.publicKey));
  const deviceId = hash(publicBytes(replacementSigner.publicKey));
  const agreement = generateKeyPairSync('x25519');
  const deviceAgreement = generateKeyPairSync('x25519');
  const agreementKey = publicBytes(agreement.publicKey).toString('hex');
  const deviceAgreementKey = publicBytes(deviceAgreement.publicKey).toString('hex');
  const archiveSecret = randomBytes(32), liveSecret = randomBytes(32);
  const policyDigest = 'e'.repeat(64);
  const textPolicy = { syntheticScopedRecipient: recoveryId };

  function makeDelivery(purpose, generation, secret, recipientId, recipientKey, seal) {
    const record = { ChannelID: channelId, Purpose: purpose, Generation: generation, Revision: 1, PolicyDigest: policyDigest,
      PreviousDigest: generation === 1 ? '' : 'f'.repeat(64), KeyID: hash(secret), TaskID: '1'.repeat(32), LeaseID: '2'.repeat(32),
      ArchiveThrough: purpose === 'archive' ? 1 : 0, ArchiveLinksDigest: purpose === 'archive' ? 'b'.repeat(64) : '' };
    const packet = { RecipientID: recipientId, Purpose: purpose,
      Ciphertext: seal(secret, packageContext(serverId, record, recipientId, recipientKey)).toString('base64') };
    record.PackagesDigest = packagesDigest([packet]);
    record.Signature = sign(null, epochSignatureFrame(serverId, profileId, previousDeviceId, record), previousSigner.privateKey).toString('base64');
    return { Epoch: { Principal: { ProfileID: profileId, DeviceID: previousDeviceId }, Record: record },
      Package: packet, Proof: { index: 0, count: 1, siblings: [] }, ...(purpose === 'archive' && { textPolicy }) };
  }
  const archive = makeDelivery('archive', 1, archiveSecret, recoveryId, agreementKey, sealRecoveryEpochPackage);
  const live = makeDelivery('live', 2, liveSecret, deviceId, deviceAgreementKey, sealEpochPackage);
  const deliveries = [archive, live];
  const targets = deliveries.map(({ Epoch: { Record } }) => ({ Purpose: Record.Purpose, Generation: Record.Generation, KeyID: Record.KeyID }));
  const task = { ChannelID: channelId, Purpose: 'archive', Generation: 2, Revision: 2, PolicyDigest: 'a'.repeat(64),
    PreviousDigest: hash(Buffer.from(archive.Epoch.Record.Signature, 'base64')), TaskID: '3'.repeat(32), LeaseID: '4'.repeat(32),
    ArchiveThrough: 2, ArchiveTargets: targets, Recipients: { [deviceId]: { Kind: 'device', ProfileID: profileId, PublicKey: deviceAgreementKey } } };
  let verified = 0;
  const recovery = {
    recoveryId, agreementKey, agreement: agreement.privateKey,
    authorizeRecipient(expected, disclosure) {
      assert.deepEqual(expected, { serverId, profileId, channelId, recipientId: recoveryId, recipientKey: agreementKey,
        kind: 'recovery', purpose: 'archive' });
      assert.equal(disclosure, textPolicy);
      verified++;
    },
  };
  let committed = false;
  const options = {
    serverId, channelId, profileId, identity: { deviceId, device: replacementSigner.privateKey }, privateKey: deviceAgreement.privateKey,
    claim: async () => task, authorizeTask: async value => assert.equal(value, task),
    authorizeEpoch(epoch, context) {
      const found = deliveries.find(entry => entry.Epoch === epoch);
      assert.equal(context.recipientId, found.Package.RecipientID);
      return { profileId, deviceId: previousDeviceId, key: publicBytes(previousSigner.publicKey).toString('hex') };
    },
    async loadTargets(record, requested) {
      assert.equal(record, task);
      assert.deepEqual(requested, targets);
      return deliveries;
    },
    commit(record, packages, links) {
      const head = { Epoch: { Principal: { ProfileID: profileId, DeviceID: deviceId }, Record: record },
        Package: packages[0], Proof: { index: 0, count: 1, siblings: [] } };
      const context = packageContext(serverId, record, deviceId, deviceAgreementKey);
      const secret = openSignedEpochPackage(head, context, deviceAgreement.privateKey,
        { profileId, deviceId, key: publicBytes(replacementSigner.publicKey).toString('hex') });
      try {
        const opened = openArchiveLinks(secret, context, links, record.ArchiveLinksDigest);
        assert.deepEqual(opened.map(link => link.secret), [archiveSecret, liveSecret]);
        committed = true;
      } finally {
        secret.fill(0);
      }
    },
  };
  await assert.rejects(() => runArchiveRotation(options), { code: 'UNVERIFIED_EPOCH_RECIPIENT' });
  assert.equal(committed, false);
  await runArchiveRotation({ ...options, recovery });
  assert.equal(verified, 2);
  assert.equal(committed, true);

  await assert.rejects(() => runArchiveRotation({ ...options,
    recovery: { ...recovery, authorizeRecipient() { throw new Error('current full history denied'); } },
    commit() { assert.fail('revoked recovery access produced archive links'); },
  }), /current full history denied/);
});
