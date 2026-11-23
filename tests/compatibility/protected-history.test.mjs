import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signatureFrame } from '../../shared/framing.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const secret = () => crypto.getRandomValues(new Uint8Array(32));

async function seal(key, data, ...context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const imported = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: signatureFrame('pawtalk-history-design-test', ...context),
  }, imported, data);
  return { iv, ciphertext, context };
}

async function open(key, packet, context = packet.context) {
  const imported = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: packet.iv,
    additionalData: signatureFrame('pawtalk-history-design-test', ...context),
  }, imported, packet.ciphertext));
}

test('live access does not open old epochs or the archive chain', async () => {
  const archiveKeys = [secret(), secret(), secret()];
  const liveKeys = [secret(), secret(), secret()];
  const packets = [];
  for (const [index, key] of archiveKeys.entries()) {
    const epoch = String(index + 1);
    packets.push({
      live: await seal(key, liveKeys[index], 'server', 'channel', epoch, 'archive-live'),
      previous: index === 0 ? null
        : await seal(key, archiveKeys[index - 1], 'server', 'channel', epoch, 'archive-backlink'),
      message: await seal(liveKeys[index], encoder.encode(epoch), 'server', 'channel', epoch, 'message'),
    });
  }

  // The limited reader entered at the second epoch and obtained both live
  // keys for that continuous admission, plus every stored ciphertext.
  for (const key of liveKeys.slice(1)) {
    await assert.rejects(open(key, packets[0].message));
    for (const packet of packets) {
      await assert.rejects(open(key, packet.live));
      if (packet.previous) await assert.rejects(open(key, packet.previous));
    }
  }
  assert.equal(decoder.decode(await open(liveKeys[1], packets[1].message)), '2');
  assert.equal(decoder.decode(await open(liveKeys[2], packets[2].message)), '3');

  // A full-history entrant receives one archive head for its device.
  // Traversal and all historical decryption happen on that device.
  let key = archiveKeys[2];
  for (let index = packets.length - 1; index >= 0; index--) {
    const packet = packets[index];
    assert.equal(decoder.decode(await open(await open(key, packet.live), packet.message)), String(index + 1));
    if (packet.previous) key = await open(key, packet.previous);
  }
  await assert.rejects(open(archiveKeys[0], packets[2].live));
  await assert.rejects(open(archiveKeys[2], packets[2].live, ['server', 'other-channel', '3', 'archive-live']));
});

test('a revision key is available at the intersection of current and original access', async () => {
  const oldLive = secret();
  const oldArchive = secret();
  const currentLive = secret();
  const currentArchive = secret();
  const formerDevice = secret();
  const newcomerDevice = secret();
  const continuingDevice = secret();
  const revisionKey = secret();
  const context = ['server', 'channel', 'message-12', 'original-epoch-1', 'edit-epoch-3', 'revision-2'];
  // The wrapping keys here model confidential device delivery. Recipient
  // proofs, public-key encapsulation and signatures are outside this test.
  const revision = await seal(revisionKey, encoder.encode('edited'), ...context, 'content');
  const archivePackage = await seal(currentArchive, revisionKey, ...context, 'archive-edits');
  const continuingPackage = await seal(continuingDevice, revisionKey, ...context, 'device', 'continuing-device');

  assert.equal(decoder.decode(await open(await open(currentArchive, archivePackage), revision)), 'edited');
  assert.equal(decoder.decode(await open(await open(continuingDevice, continuingPackage), revision)), 'edited');

  // Even pooling the keys of a former full reader and a new limited reader
  // does not open a revision made after the completed epoch transition.
  for (const key of [oldLive, oldArchive, currentLive, formerDevice, newcomerDevice]) {
    for (const packet of [revision, archivePackage, continuingPackage]) {
      await assert.rejects(open(key, packet));
    }
  }
  await assert.rejects(open(continuingDevice, continuingPackage, [...context, 'device', 'newcomer-device']));
});

test('a newly admitted reader can read eligible messages during grace without the old live key', async () => {
  const previousLive = secret();
  const newcomer = secret();
  const currentMessageKey = secret();
  const previousMessage = await seal(previousLive, encoder.encode('before admission'),
    'server', 'channel', 'message-49');
  const context = ['server', 'channel', 'message-51', 'policy-50'];
  const currentMessage = await seal(currentMessageKey, encoder.encode('written during grace'), ...context, 'content');
  const gracePackage = await seal(previousLive, currentMessageKey, ...context, 'live-grace');
  const newcomerPackage = await seal(newcomer, currentMessageKey, ...context, 'device', 'newcomer-device');

  const admittedKey = await open(newcomer, newcomerPackage);
  assert.equal(decoder.decode(await open(admittedKey, currentMessage)), 'written during grace');
  await assert.rejects(open(newcomer, gracePackage));
  await assert.rejects(open(newcomer, previousMessage));
  await assert.rejects(open(admittedKey, previousMessage));

  // The grace form of a new send retains the accepted exposure to holders
  // of the previous live secret if they obtain its ciphertext.
  assert.equal(decoder.decode(await open(await open(previousLive, gracePackage), currentMessage)), 'written during grace');
});
