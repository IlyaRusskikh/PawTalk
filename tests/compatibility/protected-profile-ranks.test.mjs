import assert from 'node:assert/strict';
import test from 'node:test';
import commitments from '../../apps/client/windows/electron/protected-channel-policy-commitments.cjs';
import replay from '../../apps/client/windows/electron/protected-policy-replay.cjs';
import ranks from '../../apps/client/windows/electron/protected-policy-profile-ranks.cjs';

test('v11 commits only active effective profiles and matches the Go rank and policy roots', () => {
  const [owner, editor, guest, other, inactive, alias] = ['1', '2', '3', '4', '5', '6'].map(value => value.repeat(64));
  const seed = 'aa'.repeat(32);
  const snapshot = {
    Owner: owner, Order: ['guest', 'editor'], ProfileBindings: { [alias]: owner },
    Members: {
      [owner]: { ID: owner, Active: true }, [editor]: { ID: editor, Active: true, Roles: ['editor'] },
      [guest]: { ID: guest, Active: true, Roles: ['guest'] }, [other]: { ID: other, Active: true },
      [inactive]: { ID: inactive, Active: false }, [alias]: { ID: alias, Active: true },
    },
  };
  const rankRoot = ranks.profileRankRoot(snapshot, seed);
  assert.equal(rankRoot, 'afc6f9bcd037fcfc95dbe86a932beee2cd2ad076edf4520e78ab0cdcf00a4d05');
  assert.equal(ranks.profileRankRoot({}, seed), 'c96106a2e86d7e0388f05f85cb9b329a6bbebd2337a7fed3b9750ba3c0208924');
  assert.deepEqual(replay.channelPolicyProjectionDigests(snapshot, seed, commitments.channelACLProjectionVersion), {});
  const projections = replay.channelPolicyProjectionDigests(snapshot, seed, commitments.profileRankProjectionVersion);
  assert.deepEqual(projections, { [ranks.profileRankProjection]: rankRoot });
  assert.equal(commitments.channelPolicyRoot(projections, seed), 'ae854c87a0aa6e12356ba0877ce9be6082b91d64ec5601e23c4c2963bc6e5a55');
});
