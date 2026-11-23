const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const {
  channelPolicyRoot, verifyChannelPolicyProof, textChannelKeyProjectionDigest,
} = require('../electron/protected-channel-policy-commitments.cjs');
const { textChannelKeyProjection, textChannelKeyDigests } = require('../electron/protected-policy-replay.cjs');

const { root, proof, snapshot, projection, visible, hidden, seed, readerDevice } = JSON.parse(readFileSync(0, 'utf8'));
const blindingSeed = Buffer.from(seed, 'base64').toString('hex');
assert.deepEqual(textChannelKeyProjection(snapshot, visible), projection);
assert.equal(projection.recipients.find(recipient => recipient.id === readerDevice).archive, false);
const hiddenView = textChannelKeyProjection(snapshot, hidden);
assert.equal(hiddenView.recipients.some(recipient => recipient.id === readerDevice), false);
const visibleDigest = textChannelKeyProjectionDigest(projection);
const all = textChannelKeyDigests(snapshot);
assert.equal(all[visible], visibleDigest);
assert.equal(channelPolicyRoot(all, blindingSeed), root);
assert.notEqual(channelPolicyRoot({ [visible]: visibleDigest }, blindingSeed), root);
assert.notEqual(channelPolicyRoot(all, 'f'.repeat(64)), root);

verifyChannelPolicyProof(root, visible, visibleDigest, proof);
assert.equal(proof.siblings.length, 10);
assert.throws(() => verifyChannelPolicyProof(root, hidden, visibleDigest, proof), /INVALID_CHANNEL_POLICY_PROOF/);
assert.throws(() => verifyChannelPolicyProof(root, visible, all[hidden], proof), /INVALID_CHANNEL_POLICY_PROOF/);
assert.throws(() => verifyChannelPolicyProof(root, visible, visibleDigest, { ...proof, index: proof.index ^ 1 }), /INVALID_CHANNEL_POLICY_PROOF/);
assert.throws(() => verifyChannelPolicyProof(root, visible, visibleDigest, { ...proof, salt: '0'.repeat(64) }), /INVALID_CHANNEL_POLICY_PROOF/);
const altered = structuredClone(projection);
altered.recipients.find(recipient => recipient.id === readerDevice).archive = true;
assert.throws(() => verifyChannelPolicyProof(root, visible, textChannelKeyProjectionDigest(altered), proof), /INVALID_CHANNEL_POLICY_PROOF/);
altered.recipients.push(altered.recipients.at(-1));
assert.throws(() => textChannelKeyProjectionDigest(altered), /INVALID_CHANNEL_POLICY_PROOF/);
