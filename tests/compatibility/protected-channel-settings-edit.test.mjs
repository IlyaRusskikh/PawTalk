import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import settingsEdit from '../../apps/client/windows/electron/protected-channel-settings-edit.cjs';
import commitments from '../../apps/client/windows/electron/protected-channel-policy-commitments.cjs';
import checkpoint from '../../apps/client/windows/electron/protected-policy-checkpoint.cjs';
import replay from '../../apps/client/windows/electron/protected-policy-replay.cjs';
import frames from '../../shared/membership.cjs';

const { signProtectedChannelSettingsEdit } = settingsEdit;
const { signatureFrame } = frames;
const { protectedPolicySignatureFrame, ProtectedPolicyCheckpoint } = checkpoint;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const publicBytes = key => key.export({ type: 'spki', format: 'der' }).subarray(-32);
const channelId = '13'.repeat(16), categoryId = '17'.repeat(16), operationId = '19'.repeat(16);
const nextSettings = { Name: 'Meeting', Description: 'Reviewed capacity', SlowmodeSeconds: 0, VoiceCapacity: 10 };

function fixture({ denied, version = 9 } = {}) {
  const server = generateKeyPairSync('ed25519'), owner = generateKeyPairSync('ed25519'), editor = generateKeyPairSync('ed25519');
  const ownerProfileId = '25'.repeat(32), ownerDeviceId = hash(publicBytes(owner.publicKey));
  const actor = { ProfileID: '27'.repeat(32), DeviceID: hash(publicBytes(editor.publicKey)) };
  const ownerActor = { ProfileID: ownerProfileId, DeviceID: ownerDeviceId };
  const trust = { serverId: hash(publicBytes(server.publicKey)).slice(0, 32), cutoverDigest: '29'.repeat(32), ownerProfileId, ownerDeviceId };
  const before = {
    Owner: ownerProfileId,
    Members: { [ownerProfileId]: { ID: ownerProfileId, Active: true }, [actor.ProfileID]: { ID: actor.ProfileID, Active: true } },
    PolicyDevices: { [ownerDeviceId]: { ProfileID: ownerProfileId, PublicKey: publicBytes(owner.publicKey).toString('hex') },
      [actor.DeviceID]: { ProfileID: actor.ProfileID, PublicKey: publicBytes(editor.publicKey).toString('hex') } },
    Roles: { '@everyone': { Grants: ['channel.view', 'channel.edit'] } },
    Categories: { [categoryId]: { Profiles: denied ? { [actor.ProfileID]: { Deny: [denied] } } : null } },
    CategoryOrder: [categoryId], ChannelOrder: [channelId], Admissions: {},
    Channels: { [channelId]: { Kind: 'voice', CategoryID: categoryId, Synchronized: true, ACL: { Profiles: null } } },
  };

  function encode(snapshot, fields, principal, privateKey, projectionVersion) {
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const seed = (fields.Revision === 1 ? '37' : '39').repeat(32);
    const root = commitments.channelPolicyRoot(replay.channelPolicyProjectionDigests(snapshot, seed, projectionVersion), seed);
    const draft = { PublicKey: '', RoleUpdate: null, ...fields, ResultDigest: hash(bytes),
      TextProjectionVersion: projectionVersion, TextProjectionRoot: root, TextProjectionSeed: seed };
    const resource = fields.ResourceChange && Buffer.from(JSON.stringify(fields.ResourceChange));
    let frame = protectedPolicySignatureFrame(trust.serverId, principal, draft, Buffer.from('null'), resource ? [hash(resource)] : []);
    if (resource) frame = signatureFrame('pawtalk-protected-channel-settings-edit-proof-v1', hash(frame));
    const signature = sign(null, frame, privateKey);
    draft.Signature = signature.toString('base64');
    return { digest: hash(signature), entry: { snapshot: bytes.toString('base64'), roleUpdate: 'bnVsbA==',
      record: Buffer.from(JSON.stringify({ Principal: principal, Draft: draft })).toString('base64'),
      ...(resource && { resourceChange: resource.toString('base64') }) } };
  }

  const genesis = encode(before, { Action: 'policy.anchor', Revision: 1, OperationID: '41'.repeat(16), PreviousDigest: '' },
    ownerActor, owner.privateKey, version);
  const pinned = { ...trust, anchorDigest: genesis.digest };
  const basis = { revision: 1, digest: genesis.digest, channelId, kind: 'voice', categoryId, settings: null };
  const signEdit = (chosen = basis, trust = pinned, operation = operationId) =>
    signProtectedChannelSettingsEdit(trust, actor, chosen, nextSettings, operation, editor.privateKey);
  const draft = { Action: 'channel.settings.scoped', Revision: 2, OperationID: operationId, PreviousDigest: genesis.digest,
    ResourceChange: { ID: channelId, Settings: nextSettings, SettingsEdit: { CutoverDigest: trust.cutoverDigest,
      PreviousSettingsDigest: commitments.channelSettingsDigest('voice', null), EditorProof: signEdit(),
      ServerKey: publicBytes(server.publicKey).toString('base64url') } } };
  const after = structuredClone(before);
  after.Channels[channelId].Settings = nextSettings;

  function accept(change = draft, snapshot = after) {
    const proof = encode(snapshot, change, actor, server.privateKey, 9);
    const storage = { async load() {}, async save() {} };
    const page = { headRevision: 2, headDigest: proof.digest, proofs: [genesis.entry, proof.entry] };
    return new ProtectedPolicyCheckpoint(storage).accept(page, pinned);
  }
  return { draft, after, accept, basis, signEdit, pinned, actor, editorKey: editor.publicKey };
}

test('editor signs the exact scoped settings frame accepted by the server', () => {
  const { basis, pinned, actor, editorKey, signEdit } = fixture();
  const oldDigest = hash(signatureFrame('pawtalk-channel-settings-v1'));
  const newDigest = hash(signatureFrame('pawtalk-channel-settings-v1', 'Meeting', 'Reviewed capacity', '0', '10'));
  const expected = signatureFrame('pawtalk-protected-channel-settings-edit-v1', pinned.serverId, pinned.cutoverDigest, actor.ProfileID,
    actor.DeviceID, operationId, '1', basis.digest, channelId, 'voice', categoryId, oldDigest, newDigest);
  assert.ok(verify(null, expected, editorKey, Buffer.from(signEdit(), 'base64url')));
});

test('delegated editor changes only settings, with prior v9 visibility and inherited channel.edit', async () => {
  const allowed = fixture();
  assert.equal((await allowed.accept()).revision, 2);
  for (const denied of ['channel.view', 'channel.edit']) {
    await assert.rejects(fixture({ denied }).accept(), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  }
  await assert.rejects(fixture({ version: 8 }).accept(), { code: 'INVALID_PROTECTED_CHANNEL_SETTINGS_EDIT' });
  const modified = structuredClone(allowed.after);
  modified.Channels[channelId].ACL.Profiles = {};
  await assert.rejects(allowed.accept(undefined, modified), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  const reordered = structuredClone(allowed.after);
  reordered.ChannelOrder = [];
  await assert.rejects(allowed.accept(undefined, reordered), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
});

test('server wrapper cannot replay editor proof at another head, channel, category, operation or cutover', async () => {
  const { draft, accept, basis, signEdit, pinned } = fixture();
  const changes = [
    () => signEdit({ ...basis, digest: '49'.repeat(32) }),
    () => signEdit({ ...basis, revision: 2 }),
    () => signEdit({ ...basis, channelId: '49'.repeat(16) }),
    () => signEdit({ ...basis, categoryId: '' }),
    () => signEdit({ ...basis, settings: nextSettings }),
    () => signEdit(basis, pinned, '49'.repeat(16)),
    () => signEdit(basis, { ...pinned, cutoverDigest: '49'.repeat(32) }),
  ];
  for (const makeProof of changes) {
    const changed = structuredClone(draft);
    changed.ResourceChange.SettingsEdit.EditorProof = makeProof();
    await assert.rejects(accept(changed), { code: 'INVALID_PROTECTED_CHANNEL_SETTINGS_EDIT' });
  }
  const forged = structuredClone(draft);
  forged.ResourceChange.Settings.VoiceCapacity += 1;
  await assert.rejects(accept(forged), { code: 'INVALID_PROTECTED_CHANNEL_SETTINGS_EDIT' });
});
