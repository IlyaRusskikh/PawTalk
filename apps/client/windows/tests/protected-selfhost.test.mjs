import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import transport from '../electron/protected-selfhost.cjs';
import checkpoint from '../electron/protected-policy-checkpoint.cjs';
import attestation from '../electron/protected-policy-attestation.cjs';
import commitments from '../electron/protected-channel-policy-commitments.cjs';
import replay from '../electron/protected-policy-replay.cjs';
import membership from '../../../../shared/membership.cjs';

const { signatureFrame } = membership;
const fingerprint = 'f'.repeat(64);
const binding = '1'.repeat(64);
const serverId = '2'.repeat(32);
const text = '3'.repeat(32);
const voice = '4'.repeat(32);
const digest = value => createHash('sha256').update(value).digest('hex');

function setup() {
  const profile = generateKeyPairSync('ed25519'), device = generateKeyPairSync('ed25519');
  const raw = key => key.export({ type: 'spki', format: 'der' }).subarray(-32);
  const ownerProfileId = digest(raw(profile.publicKey)), ownerDeviceId = digest(raw(device.publicKey));
  const identity = { profileId: ownerProfileId, deviceId: ownerDeviceId, profileKey: raw(profile.publicKey).toString('base64url'),
    deviceKey: raw(device.publicKey).toString('base64url'), device: device.privateKey, signProfile: bytes => sign(null, bytes, profile.privateKey) };
  const handshake = transport.prepareProtectedSelfHost(identity, 'Synthetic host', 'Synthetic PC');
  function offer(change = () => {}, TextProjectionVersion = commitments.channelSettingsProjectionVersion) {
    const channel = (Kind, Name, VoiceCapacity) => ({ Kind, CategoryID: '', Synchronized: false, ACL: { Roles: null, Profiles: null },
      Settings: { Name, Description: '', SlowmodeSeconds: 0, VoiceCapacity }, NextPosition: 0 });
    const snapshot = {
      Owner: ownerProfileId, PolicyAnchored: false, Order: null, Categories: null,
      Members: { [ownerProfileId]: { ID: ownerProfileId, Roles: null, Active: true, TimeoutUntil: 0 } },
      PolicyDevices: { [ownerDeviceId]: { ProfileID: ownerProfileId, PublicKey: handshake.input.deviceKey } },
      KeyRecipients: { [ownerDeviceId]: { ProfileID: ownerProfileId, Kind: 'device', PublicKey: handshake.input.agreementKey } },
      Roles: { '@everyone': { Grants: ['channel.view', 'history.full', 'profile.edit-self', 'message.send', 'message.attach',
        'message.voice', 'poll.create', 'poll.vote', 'checklist.create', 'checklist.check', 'voice.connect', 'voice.speak'] } },
      Channels: { [text]: channel('text', 'General', 0), [voice]: channel('voice', 'Voice', 30) }, ChannelOrder: [text, voice],
      Admissions: { [text]: { [ownerProfileId]: { FirstPosition: 1 } } },
    };
    change(snapshot);
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const TextProjectionSeed = '5'.repeat(64);
    const TextProjectionRoot = commitments.channelPolicyRoot(replay.channelPolicyProjectionDigests(snapshot, TextProjectionSeed,
      TextProjectionVersion), TextProjectionSeed);
    const draft = {
      OperationID: '6'.repeat(32), Action: 'policy.anchor', Revision: 1, PreviousDigest: '', ResultDigest: digest(bytes),
      TextProjectionRoot, TextProjectionSeed, TextProjectionVersion, PublicKey: '', RoleUpdate: null, Signature: null,
    };
    const cutoverDigest = digest(signatureFrame('pawtalk-selfhost-cutover-v1', serverId, fingerprint, binding, ownerProfileId,
      ownerDeviceId, handshake.input.agreementKey, draft.ResultDigest));
    return { fingerprint, protected: { serverId, binding, cutoverDigest, ownerProfileId, ownerDeviceId, draft, snapshot: bytes.toString('base64') } };
  }
  return { handshake, offer, profile, device };
}

test('protected selfhost approves only the independently verified owner policy and matching receipt', () => {
  const { handshake, offer, profile, device } = setup();
  const ready = offer();
  const { draft, snapshot, cutoverDigest, ownerProfileId, ownerDeviceId, ...basis } = ready.protected;
  const approval = handshake.authorize(ready);
  const actor = { ProfileID: ownerProfileId, DeviceID: ownerDeviceId };
  const deviceFrame = checkpoint.protectedPolicySignatureFrame(serverId, actor, draft, Buffer.from('null'));
  const policySignature = Buffer.from(approval.policySignature, 'base64url');
  assert.ok(verify(null, deviceFrame, device.publicKey, policySignature));
  const profileFrame = signatureFrame('pawtalk-selfhost-owner-v1', serverId, fingerprint, binding, cutoverDigest,
    ownerProfileId, ownerDeviceId, handshake.input.agreementKey, draft.ResultDigest);
  assert.ok(verify(null, profileFrame, profile.publicKey, Buffer.from(approval.profileSignature, 'base64url')));
  const scopeFrame = attestation.policyAttestationFrame({ serverId, anchorDigest: digest(policySignature), ownerProfileId, ownerDeviceId },
    { revision: 1, digest: digest(policySignature), previous: '', policyDigest: draft.ResultDigest,
      root: draft.TextProjectionRoot, projectionVersion: draft.TextProjectionVersion });
  assert.ok(verify(null, scopeFrame, device.publicKey, Buffer.from(approval.scopeAttestation, 'base64url')));
  const receipt = { fingerprint, protected: { ...basis, cutoverDigest, ownerProfileId, ownerDeviceId, anchorDigest: digest(policySignature) } };
  assert.throws(() => handshake.confirm({ ...receipt, protected: { ...receipt.protected, binding: '9'.repeat(64) } }));
  const verified = handshake.confirm(receipt);
  assert.equal(verified.trust.anchorDigest, receipt.protected.anchorDigest);
  assert.match(verified.agreementSeed, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(handshake.input), new RegExp(verified.agreementSeed));
  handshake.clear();
  assert.throws(() => handshake.confirm(receipt), { code: 'INVALID_PROTECTED_SELFHOST' });
});

test('protected selfhost verifies legacy v8 offers and rejects a v9 commitment labelled v8', () => {
  const { handshake, offer } = setup();
  const current = offer();
  const legacyVersion = commitments.voiceRecipientProjectionVersion;
  current.protected.draft.TextProjectionVersion = legacyVersion;
  assert.throws(() => handshake.authorize(current));
  assert.ok(handshake.authorize(offer(undefined, legacyVersion)).scopeAttestation);
  handshake.clear();
});

test('protected selfhost rejects legacy readiness and validly committed but unexpected grants or recipients', () => {
  const { handshake, offer } = setup();
  assert.throws(() => handshake.authorize({ fingerprint, bootstrap: { serverId } }), { code: 'INVALID_PROTECTED_SELFHOST' });
  assert.throws(() => handshake.authorize(offer(snapshot => snapshot.Roles['@everyone'].Grants.push('administrator'))));
  assert.throws(() => handshake.authorize(offer(snapshot => { snapshot.KeyRecipients['9'.repeat(64)] = {
    ProfileID: snapshot.Owner, Kind: 'device', PublicKey: '8'.repeat(64),
  }; })));
  const ready = offer();
  assert.throws(() => handshake.authorize({ ...ready, protected: { ...ready.protected, cutoverDigest: '8'.repeat(64) } }));
  handshake.clear();
});
