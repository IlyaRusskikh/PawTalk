import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import test from 'node:test';
import commitments from '../../apps/client/windows/electron/protected-channel-policy-commitments.cjs';
import replay from '../../apps/client/windows/electron/protected-policy-replay.cjs';

test('v10 scoped ACL role rules and distinct editor authority match the Go vector', () => {
  const channel = '9'.repeat(32), category = '8'.repeat(32), seed = 'aa'.repeat(32);
  const owner = '1'.repeat(64), editor = '2'.repeat(64), personal = '3'.repeat(64);
  const device = (profileId, byte) => {
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, byte)]),
      format: 'der', type: 'pkcs8' });
    const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
    return { id: createHash('sha256').update(publicKey).digest('hex'), profileId, key: publicKey.toString('hex') };
  };
  const devices = [device(owner, 1), device(editor, 2)];
  const rules = { editor: { Allow: ['channel.view', 'voice.speak'], Deny: ['message.send'] } };
  const policy = {
    Owner: owner, Order: ['editor'], Roles: { '@everyone': {}, editor: { Grants: ['channel.view', 'channel.access.edit'] } },
    Members: { [owner]: { ID: owner, Active: true }, [editor]: { ID: editor, Active: true, Roles: ['editor'] },
      [personal]: { ID: personal, Active: true } },
    PolicyDevices: Object.fromEntries(devices.map(({ id, profileId, key }) => [id, { ProfileID: profileId, PublicKey: key }])),
    Channels: { [channel]: { Kind: 'text', CategoryID: category, Synchronized: true } },
    Categories: { [category]: { Roles: rules, Profiles: { [personal]: { Deny: ['channel.view'] } } } },
  };
  assert.equal(commitments.channelACLCommitment(channel, 'text', true, rules, devices, seed),
    'fdede65ba9106f84afd8d907d83aff1adf3ad4c02e693361978cf43ac65fdeb6');
  const projection = replay.channelPolicyProjectionDigests(policy, seed, commitments.channelACLProjectionVersion);
  assert.equal(commitments.channelPolicyRoot(projection, seed), 'd4fe65c8854eb2e2cdaae16f7114ad05035cfe61bed295bbe596b27dd688d821');
});
