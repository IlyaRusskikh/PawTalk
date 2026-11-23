import assert from 'node:assert/strict';
import test from 'node:test';
import credentials from '../../apps/client/windows/electron/protected-invite-admission-commitment.cjs';
import commitments from '../../apps/client/windows/electron/protected-channel-policy-commitments.cjs';
import replay from '../../apps/client/windows/electron/protected-policy-replay.cjs';

const fixed = digit => digit.repeat(64);
const owner = fixed('1');
const signingKey = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';
const deviceId = '34750f98bd59fcfc946da45aaabe933be154a4b5094e1c4abf42866505f3c97e';
const channelId = '9'.repeat(32);
const seed = fixed('a');
const snapshot = {
  Owner: owner,
  Roles: { '@everyone': { Grants: ['channel.view', 'message.send'] } },
  Members: { [owner]: { ID: owner, Active: true } },
  Channels: { [channelId]: { Kind: 'text', NextPosition: 1 } },
  PolicyDevices: { [deviceId]: { ProfileID: owner, PublicKey: signingKey } },
  RetiredRecipientKeys: { [fixed('8')]: true },
};

test('invitation v17 channel and server commitments match Go', () => {
  const evidence = { credentials: credentials.inviteCredentialRoot(snapshot),
    issuers: credentials.inviteIssuerRoot([{ deviceId, profileId: owner, signingKey }], seed) };
  assert.equal(evidence.credentials, '54c34a1d17e00056bc7a83957916f6032bb5c9662132ecca2c7d355bc06ebce4');
  assert.equal(evidence.issuers, '616c2688a731c2e19bbdb96fdb9010b012ffe9b0a47751af55899e5eeef87cee');
  const digests = replay.channelPolicyProjectionDigests(snapshot, seed, 17);
  const root = commitments.channelPolicyRoot(digests, seed);
  assert.equal(root, 'c7e06a18b3ac3624c3d7f6f9e0d420fbc789c7a94b647e33d6c854af23a46151');
  evidence.ranks = 'e11384d0677edeb1aa124f8dae11d46bfbf52279364b37221c98e189d9b3a920';
  evidence.inclusion = { index: 388, salt: '3f1621d358613ee79e1295935d6a242daba4298a1b0fccae24bd5c6907f4eded', siblings: [
    '9b03ce363f5289d77a15f30c90f0d76aa1d8d9bac76b03da786c4e99e4da8cb4',
    'd1d93677b570bcaaf375544da055d37dab110bb4d145a31dd301077198983204',
    'c0b0ab6504735552f28ea8438097deb1b93fa8968d8fa2e28d06b09cf86a0258',
    '39c5cb1b9b5643627f4dc94fcc9f931be2f5363719944fb1297056947a9c091a',
    'd478ad7de28cada9a5dc8e2a61289049378b0b858659a3ba86131112ee37b448',
    '070057b51ce6681d86101a11d8b7ba9d705bcbac2da701992d4dedbfa81f4835',
    '9f3ca857f3d3e04621750afd8cc8aea5a31be99913885a16cffeb7a591fdf6a5',
    'e00c9792dcfe7aaa2df977a4dc8d019d2a9882f6609319fb11f80806964bee21',
    'd3dfdbcd721fdb9e47b1b23eff6f10c5212bb2cae7f9cabb83ca6ba6e58ddf4b',
    '95a1eec533949ab27e36cbcf1f42cfcd42742c7dee892425a8df65c024cd4651',
  ] };
  assert.doesNotThrow(() => credentials.verifyInviteAdmissionProjection({ root, projectionVersion: 17 }, evidence));
  assert.throws(() => credentials.verifyInviteAdmissionProjection({ root, projectionVersion: 17 }, { ...evidence, credentials: fixed('f') }),
    { code: 'INVALID_CHANNEL_POLICY_PROOF' });
  assert.throws(() => credentials.verifyInviteAdmissionProjection({ root, projectionVersion: 16 }, evidence),
    { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  assert.equal(commitments.hasTextRecipientProjection(17), true);
  assert.equal(commitments.hasTextRecipientProjection(18), true);
  assert.equal(commitments.hasTextRecipientProjection(19), false);
  assert.deepEqual(Object.keys(digests), Object.keys(replay.channelPolicyProjectionDigests(snapshot, seed, 16)));
});

test('Go invitation use proof rejects exhausted or replayed issuance', () => {
  const id = '3'.repeat(32), signature = 'fixture-signature';
  const root = credentials.inviteCredentialRoot({ ...snapshot, InvitationUses: { [id]: { Count: 1, IssueSignature: signature } } });
  const proof = { count: 1, issueSignature: signature, path: [
    { depth: 2, digest: '1ca387c08e6e31a17957f705c12fc4252fa0dbe123590cb7f7d253f41e903e51' },
    { depth: 1, digest: 'ab9f899825d6f797140704a38246f3935b63f8553d1a53bf8c55abd35e18671a' },
  ] };
  assert.equal(root, 'a39061c56f890cbfb7d9b2f8b257e099913e4ca425a8094bfb52f2d2c20b1a44');
  assert.equal(credentials.verifyInviteUse(root, id, proof, signature, 2), 1);
  assert.equal(credentials.verifyInviteUse(root, id, proof, signature, 0), 1);
  for (const [candidate, issued, limit] of [[proof, signature, 1], [proof, 'wrong-issuance', 2],
    [{ count: 0, path: proof.path }, signature, 2]]) {
    assert.throws(() => credentials.verifyInviteUse(root, id, candidate, issued, limit), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  }
});

test('Go invite absence proof authenticates a fresh profile and rejects a used credential', () => {
  const path = [{ depth: 0, digest: 'e9966f5cc5ffcbd67cb9b91f604c9918b8e3e707cc67fa1d76e758f560823860' }];
  const root = credentials.inviteCredentialRoot(snapshot);
  assert.doesNotThrow(() => credentials.verifyFreshInviteCredential(root, 'profile', fixed('f'), path));
  for (const [kind, id] of [['profile', owner], ['device', deviceId], ['agreement', fixed('8')]]) {
    assert.throws(() => credentials.verifyFreshInviteCredential(root, kind, id, path), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  }
  assert.throws(() => credentials.verifyFreshInviteCredential(root, 'profile', fixed('f'), [{ ...path[0], digest: fixed('d') }]),
    { code: 'INVALID_PROTECTED_INVITE_PROOF' });
  assert.throws(() => credentials.verifyFreshInviteCredential(root, 'profile', fixed('f'), [...path, ...path]),
    { code: 'INVALID_PROTECTED_INVITE_PROOF' });
});

test('Go issuer proof binds the issuing effective profile to its signing device', () => {
  const root = credentials.inviteIssuerRoot([{ deviceId, profileId: owner, signingKey }], seed);
  const opening = { signingKey, salt: 'efdc658f1219174f1985384af9efaff41bab91119501f8b1552909bd850b4164',
    proof: { index: 0, count: 1, siblings: [] } };
  assert.equal(credentials.verifyInviteIssuer(root, { ProfileID: owner, DeviceID: deviceId }, opening), signingKey);
  assert.throws(() => credentials.verifyInviteIssuer(root, { ProfileID: fixed('f'), DeviceID: deviceId }, opening),
    { code: 'INVALID_PROTECTED_INVITE_PROOF' });
});
