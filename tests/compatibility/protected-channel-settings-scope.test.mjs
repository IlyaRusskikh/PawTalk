import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import frames from '../../shared/membership.cjs';
import commitments from '../../apps/client/windows/electron/protected-channel-policy-commitments.cjs';
import packages from '../../apps/client/windows/electron/protected-epoch-packages.cjs';
import replay from '../../apps/client/windows/electron/protected-policy-replay.cjs';

const { signatureFrame } = frames;
const { channelOrderCommitment, channelPolicyCombinedDigest, channelSettingsDigest, channelSettingsProjectionVersion,
  verifyChannelSettings, verifyChannelOrderAuthority } = commitments;
const seed = 'aa'.repeat(32), channelId = '9'.repeat(32);
const textSettings = { Name: 'Общий', Description: '🦊 rules', SlowmodeSeconds: 21600, VoiceCapacity: 0 };
const voiceSettings = { Name: 'Voice', Description: '', SlowmodeSeconds: 0, VoiceCapacity: 4294967295 };
const hash = (...parts) => parts.reduce((digest, part) => digest.update(part), createHash('sha256')).digest();

test('v9 settings and channel authority match fixed vectors for legacy nil, text and voice', () => {
  const vectors = [
    ['text', null, '985ebf040f0bc5dd755ecc41b430d45819bc592de10906246399aff9b45dfc2f',
      'e81f7b290f1d4e4a543acd2f121fe57eece3880062919cd93e642ce1289a970c'],
    ['text', textSettings, '7ea730c7ca2a61f1c6f238d1ddb263bf7bdd3cf46f4a045012695d79827984f8',
      '0d72c664b1d2b3f579e5c5424b17da468eb5fb152dd03babbc1308b73dcc43e8'],
    ['voice', voiceSettings, 'c81d2aae49933ccfa86440c3520564cda9bda63966933e7016eceb9996f6d92f',
      '6e9f7e767a924c7d0583fe8b855841a401bdda04d1cef7898594a1111aea21af'],
  ];
  for (const [kind, settings, digest, authority] of vectors) {
    assert.equal(channelSettingsDigest(kind, settings), digest);
    assert.equal(channelOrderCommitment(channelId, kind, '', [], seed, channelSettingsProjectionVersion, settings), authority);
  }
  assert.throws(() => channelSettingsDigest('text', voiceSettings));
  assert.throws(() => channelSettingsDigest('voice', { ...voiceSettings, VoiceCapacity: 4294967296 }));
  assert.equal(channelSettingsDigest('voice', { ...voiceSettings, VoiceCapacity: 30, Description: '🦊'.repeat(18000) }),
    '07fb48e9978dbaa2ea2c724d5b14a0fedfdef170e0669c1d1dfc4ba7f7142369');
});

function scope(version, settings) {
  const signingKey = '57'.repeat(32), salt = '41'.repeat(32), categoryId = 'd'.repeat(32);
  const actor = { ProfileID: '17'.repeat(32), DeviceID: hash(Buffer.from(signingKey, 'hex')).toString('hex') };
  const editorLeaf = hash(signatureFrame('pawtalk-channel-order-editor-v1', actor.DeviceID, actor.ProfileID, signingKey, salt));
  const editorsRoot = packages.commitmentRoot([editorLeaf]);
  const settingsDigest = channelSettingsDigest('text', settings);
  const authorityArgs = ['text', categoryId, editorsRoot];
  if (version === 9) authorityArgs.push(settingsDigest);
  const authority = hash(signatureFrame(`pawtalk-channel-order-resource-v${version === 9 ? 2 : 1}`, ...authorityArgs)).toString('hex');
  const textDigest = '1a'.repeat(32);
  const projection = channelPolicyCombinedDigest(textDigest, authority);
  const inclusion = { index: 341, salt: '88'.repeat(32), siblings: Array(10).fill('ef'.repeat(32)) };
  let root = hash(Buffer.from([0]), hash(channelId), Buffer.from(inclusion.salt, 'hex'), Buffer.from(projection, 'hex'));
  for (let level = 0, index = inclusion.index; level < 10; level++, index >>= 1) {
    const sibling = Buffer.from(inclusion.siblings[level], 'hex');
    root = hash(Buffer.from([1]), ...(index & 1 ? [sibling, root] : [root, sibling]));
  }
  const revision = 3, policyDigest = '47'.repeat(32);
  const attestation = { revision, policyDigest, projectionVersion: version, root: root.toString('hex') };
  const common = { channelId, revision, policyDigest, kind: 'text', categoryId, textDigest, inclusion };
  const editor = { ...common, actor, signingKey, salt, editors: { index: 0, count: 1, siblings: [] },
    ...(version === 9 && { settingsDigest }) };
  return { attestation, viewer: { ...common, editorsRoot, settings }, editor, actor };
}

test('a v9 viewer opens settings with an opaque editor root, while editor proof binds the same settings', () => {
  const { attestation, viewer, editor, actor } = scope(9, textSettings);
  assert.deepEqual(verifyChannelSettings(attestation, channelId, viewer).settings, textSettings);
  assert.equal(verifyChannelOrderAuthority(attestation, channelId, editor, actor).settingsDigest,
    channelSettingsDigest('text', textSettings));
  assert.throws(() => verifyChannelSettings(attestation, channelId, { ...viewer, settings: null }));
  assert.throws(() => verifyChannelSettings(attestation, channelId, { ...viewer, revision: 2 }));
  assert.throws(() => verifyChannelSettings(attestation, '07'.repeat(16), viewer));
  assert.throws(() => verifyChannelOrderAuthority(attestation, channelId, { ...editor, settingsDigest: 'aa'.repeat(32) }, actor));
  assert.throws(() => verifyChannelOrderAuthority(attestation, channelId, { ...editor, settingsDigest: undefined }, actor));
});

test('v8 order verification stays valid and cannot be used to authenticate a settings opening', () => {
  const { attestation, viewer, editor, actor } = scope(8, textSettings);
  assert.equal(verifyChannelOrderAuthority(attestation, channelId, editor, actor).settingsDigest, undefined);
  assert.throws(() => verifyChannelSettings(attestation, channelId, viewer));
  assert.throws(() => verifyChannelOrderAuthority(attestation, channelId, { ...editor, settingsDigest: 'aa'.repeat(32) }, actor));
});

test('only v9 full replay binds the channel settings from the signed snapshot', () => {
  const snapshot = { Channels: { [channelId]: { Kind: 'voice', ACL: { Profiles: {} } } } };
  const project = version => replay.channelPolicyProjectionDigest(snapshot, channelId, seed, version);
  const oldV8 = project(8), oldV9 = project(9);
  snapshot.Channels[channelId].Settings = voiceSettings;
  assert.equal(project(8), oldV8);
  assert.notEqual(project(9), oldV9);
});
