const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { profileRoleAuthorityProjectionVersion } = require('../electron/protected-channel-policy-commitments.cjs');

const id = () => randomBytes(16).toString('hex');

async function checkProtectedRoleAssignmentOffline({ fetcher, createClient, retryAfterFixtureQuota, host, owner, source }) {
  const affected = id();
  const readerRole = id();
  const delegateRole = id();
  const limitedRole = id();
  const operation = (Action, fields) => ({ Action, OperationID: id(), ...fields });
  const liveClaim = `/api/v3/keys/rotate/${affected}/live/claim`;
  const livePackage = `/api/v3/keys/current/${affected}/live`;
  let online = true;
  let corruptRoster = false;
  let historyPending = false;
  let corruptReceipt = false;
  let checkedDeliveries = 0;
  const ownerFetch = host.fetcher;
  host.fetcher = (url, options) => {
    assert.equal(online, true, 'the owner client must stay offline during delegated changes and rotation');
    return ownerFetch(url, options);
  };
  const scoped = async (url, options) => {
    const { pathname } = new URL(url);
    assert.notEqual(pathname, '/api/v3/policy/proofs', 'ordinary members must use scoped proofs');
    const response = await fetcher(url, options);
    if (!response.ok || online || (pathname !== liveClaim && pathname !== livePackage)) return response;
    const data = await response.clone().json();
    if (historyPending && pathname === livePackage) {
      const evidence = data.liveRoleHistory;
      assert.ok(evidence?.transition.assignment.roster);
      assert.ok(!JSON.stringify(evidence).includes(source));
      assert.equal(evidence.archive, undefined);
      assert.match(evidence.receipt, /^[A-Za-z0-9+/]{86}==$/);
      if (corruptReceipt) {
        const receipt = Buffer.from(evidence.receipt, 'base64');
        receipt[0] ^= 1;
        evidence.receipt = receipt.toString('base64');
        return Response.json(data);
      }
      return response;
    }
    const proof = data.roleAssignment;
    assert.ok(proof?.assignment.roster);
    assert.ok(!JSON.stringify(proof).includes(source), 'the affected key proof must hide the source roster ID');
    if (pathname === livePackage) checkedDeliveries++;
    if (corruptRoster && pathname === liveClaim) {
      proof.assignment.roster.actor.salt = '0'.repeat(64);
      return Response.json(data);
    }
    return response;
  };
  const enroll = async nickname => {
    const client = createClient(scoped);
    const { link } = await retryAfterFixtureQuota(() => host.createProtectedInvite(owner));
    await retryAfterFixtureQuota(() => client.redeemProtectedInvite(link, nickname));
    const connection = await retryAfterFixtureQuota(() => client.openStoredProtectedRuntime(owner.serverId));
    return { client, connection };
  };
  const editor = await enroll('Synthetic role delegate');
  const target = await enroll('Synthetic role recipient');
  const observer = await enroll('Synthetic live reader');
  const apply = async intent => {
    await retryAfterFixtureQuota(() => host.readProtectedOwnerPolicy(owner));
    const preview = await retryAfterFixtureQuota(() => host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust));
    assert.equal(preview.draft.TextProjectionVersion, profileRoleAuthorityProjectionVersion);
    await retryAfterFixtureQuota(() => host.commitProtectedRuntimePolicy(owner,
      { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust));
  };
  const { snapshot } = await host.readProtectedOwnerPolicy(owner);
  await apply(operation('roles.update', { RoleUpdate: {
    Roles: { ...snapshot.Roles, [readerRole]: { Grants: [] }, [limitedRole]: { Grants: [] }, [delegateRole]: { Grants: ['role.assign'] } },
    Order: [...(snapshot.Order ?? []), readerRole, limitedRole, delegateRole],
    Assignments: { [editor.connection.profileId]: [readerRole, delegateRole], [observer.connection.profileId]: [readerRole] },
  } }));
  await apply(operation('channel.acl.update', { ResourceChange: {
    ID: source, ACL: { Roles: null, Profiles: { [observer.connection.profileId]: { Allow: null, Deny: ['channel.view'] } } },
  } }));
  await apply(operation('channel.create', { ResourceChange: {
    ID: affected,
    Channel: { Kind: 'text', Settings: { Name: 'Synthetic protected room', Description: '', SlowmodeSeconds: 0, VoiceCapacity: 0 } },
    ACL: { Roles: { '@everyone': { Allow: null, Deny: ['channel.view'] }, [readerRole]: { Allow: ['channel.view'], Deny: null },
      [limitedRole]: { Allow: null, Deny: ['history.full'] } },
      Profiles: { [observer.connection.profileId]: { Allow: null, Deny: ['history.full'] } } },
  } }));
  const rotate = ({ client, connection }, purpose) =>
    retryAfterFixtureQuota(() => client.rotateProtectedRuntimeText(connection, affected, purpose));
  const load = async ({ client, connection }, purpose = 'live') => {
    const { record, secret } = await retryAfterFixtureQuota(() =>
      client.loadProtectedRuntimeKey(connection, affected, purpose, { policyTrust: connection.policyTrust }));
    secret.fill(0);
    return record;
  };
  const send = ({ client, connection }, text) => {
    const operationId = id();
    return retryAfterFixtureQuota(() =>
      client.withCurrentProtectedChatPolicy(connection, options => client.sendProtectedRuntimeText(connection, affected, text, operationId, options)));
  };
  const initial = { client: host, connection: owner };
  await rotate(initial, 'live');
  const firstText = 'Synthetic history from before role assignment';
  const original = await send(initial, firstText);
  await rotate(initial, 'archive');
  assert.ok(!(await observer.client.readProtectedRuntimeState(observer.connection)).channels.some(channel => channel.id === source));
  assert.equal((await observer.client.readProtectedRuntimeState(observer.connection)).canAssignRoles, false);
  const originalLive = await load(observer);
  await assert.rejects(load(target), { code: 'PROTECTED_ACCESS_DENIED' });
  const changeAssignment = async (add, remove) => {
    const { client, connection } = editor;
    const basis = await retryAfterFixtureQuota(() => client.readScopedRoles(connection, target.connection.profileId, source));
    const change = { revision: basis.revision, policyHead: basis.policyHead, rosterChannelId: source,
      targetProfileId: target.connection.profileId, add, remove };
    const preview = await retryAfterFixtureQuota(() => client.previewScopedRoles(connection, change));
    assert.ok(preview.some(channel => channel.id === affected && channel.keyUpdate));
    const operationId = id();
    await retryAfterFixtureQuota(() => client.commitScopedRoles(connection, operationId, change));
    await assert.rejects(client.readProtectedPolicyAttestation(connection), { code: 'POLICY_ATTESTATION_UNAVAILABLE' });
  };
  const checkMessages = async ({ client, connection }, after, expected) => {
    const page = await retryAfterFixtureQuota(() => client.readProtectedChatPage(connection, affected, after));
    assert.deepEqual(page.messages.map(message => message.text), expected);
  };
  online = false;
  await changeAssignment([readerRole], []);
  // The original delegate has the initial lease priority. An ordinary
  // live-only reader can take over after the production priority interval.
  await delay(5_100);
  corruptRoster = true;
  try { await assert.rejects(rotate(observer, 'live'), { code: 'INVALID_SCOPED_ROLE_ROSTER' }); }
  finally { corruptRoster = false; }
  await rotate(observer, 'live');
  await rotate(editor, 'archive');
  const grantedLive = await load(target);
  assert.equal(grantedLive.Generation, originalLive.Generation + 1);
  assert.notEqual(grantedLive.KeyID, originalLive.KeyID);
  await load(target, 'archive');
  await assert.rejects(load(observer, 'archive'), { code: 'PROTECTED_ACCESS_DENIED' });
  await checkMessages(target, 0, [firstText]);
  const nextText = 'Synthetic message from the newly authorized profile';
  const newcomer = await send(target, nextText);
  await checkMessages(observer, original.Position, [nextText]);
  assert.ok(checkedDeliveries > 0);

  // The next independent transition starts from a newly attested base.
  const attestBase = async () => {
    online = true;
    await retryAfterFixtureQuota(() => host.refreshProtectedRuntimePolicy(owner, owner.policyTrust));
    await retryAfterFixtureQuota(() => host.syncProtectedPolicyAttestations(owner));
    online = false;
  };
  await attestBase();
  await changeAssignment([limitedRole], []);
  historyPending = true;
  corruptReceipt = true;
  try { await assert.rejects(load(target), { code: 'INVALID_ROLE_ASSIGNMENT_TRANSITION' }); }
  finally { corruptReceipt = false; }
  assert.equal((await load(target)).KeyID, grantedLive.KeyID);
  await assert.rejects(load(target, 'archive'), { code: 'PROTECTED_ACCESS_DENIED' });
  const duringText = 'Synthetic live message while the archive task is pending';
  const during = await send(target, duringText);
  await checkMessages(observer, newcomer.Position, [duringText]);
  await checkMessages(target, original.Position, [nextText, duringText]);
  await rotate(editor, 'archive');
  historyPending = false;
  assert.equal((await load(target)).KeyID, grantedLive.KeyID);

  await attestBase();
  await changeAssignment([], [readerRole]);
  await rotate(editor, 'live');
  await rotate(editor, 'archive');
  const revokedLive = await load(observer);
  assert.equal(revokedLive.Generation, grantedLive.Generation + 1);
  assert.notEqual(revokedLive.KeyID, grantedLive.KeyID);
  await assert.rejects(load(target), { code: 'PROTECTED_ACCESS_DENIED' });
  const lastText = 'Synthetic message after scoped role removal';
  await send(editor, lastText);
  await checkMessages(observer, during.Position, [lastText]);
  console.log('PASS v18 offline role changes rotate both key types and preserve live access before archive publication');
}

module.exports = { checkProtectedRoleAssignmentOffline };
