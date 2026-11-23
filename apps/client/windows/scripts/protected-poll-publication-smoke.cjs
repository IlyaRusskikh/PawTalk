const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const operationID = () => randomBytes(16).toString('hex');
const taskPath = '/api/v3/history/poll-results/tasks';

async function checkProtectedPollPublication(fetcher, createClient, host, owner, channelId) {
  const intent = { Action: 'channel.acl.update', OperationID: operationID(), ResourceChange: {
    ID: channelId, ACL: { Roles: { '@everyone': { Allow: null, Deny: ['history.full'] } }, Profiles: null },
  } };
  await host.readProtectedOwnerPolicy(owner);
  const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
  await host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
  const join = async (client, nickname) => {
    const { link } = await host.createProtectedInvite(owner);
    await client.redeemProtectedInvite(link, nickname);
    return client.openStoredProtectedRuntime(owner.serverId);
  };
  let publication, publishPath, pending;
  const reader = createClient(async (url, options) => {
    const { pathname } = new URL(url);
    assert.notEqual(pathname, '/api/v3/policy/proofs');
    if (pathname === publishPath) {
      assert.equal(options.method, 'POST');
      if (publication === undefined) publication = options.body;
      else assert.equal(options.body, publication);
    }
    const response = await fetcher(url, options);
    if (pathname === taskPath && response.ok) pending = await response.clone().json();
    return response;
  });
  const readerConnection = await join(reader, 'Original poll reader');
  assert.equal(readerConnection.config.protectedPollResultTasks, true);
  await host.serviceProtectedRuntimeRotations(owner);
  const question = 'Synthetic original question';
  const options = ['Synthetic option A', 'Synthetic option B'];
  const poll = { options, duration: 3600, anonymous: true, multiple: false, intermediate: false };
  const { Position: original } = await host.withCurrentProtectedChatPolicy(owner, trust =>
    host.sendProtectedRuntimeText(owner, channelId, question, operationID(), trust, undefined, undefined, poll));
  publishPath = `/api/v3/history/poll-results/${channelId}/${original}`;
  await reader.protectedPoll(readerConnection, channelId, original, { operationId: operationID(), choices: [1] });
  const late = createClient(fetcher);
  const lateConnection = await join(late, 'Late poll reader');
  await host.syncProtectedPolicyAttestations(owner);
  await host.protectedPoll(owner, channelId, original, undefined, true);

  const request = (client, connection, path, method, body) => client.fetchJSON(connection.base, path, {
    method, body, fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
  });
  assert.deepEqual(await request(reader, readerConnection, taskPath), []);
  const closed = await reader.protectedPoll(readerConnection, channelId, original);
  assert.equal(closed.canVote, false);
  assert.deepEqual(closed.counts, [0, 1]);
  assert.equal(publication, undefined);

  // The later admission has initial priority. The author makes no further calls.
  await delay(5300);
  await reader.serviceProtectedRuntimeRotations(readerConnection);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].originalPosition, original);
  assert.deepEqual(pending[0].counts, [0, 1]);
  for (const text of [question, ...options]) assert.ok(!JSON.stringify(pending).includes(text));
  assert.ok(publication);
  assert.deepEqual(await request(reader, readerConnection, publishPath, 'POST', publication), { ok: true });
  assert.deepEqual(await request(reader, readerConnection, taskPath), []);
  const result = (await reader.readProtectedChatPage(readerConnection, channelId, 0)).messages;
  assert.equal(result.length, 2);
  assert.equal(result[0].text, question);
  assert.equal(result[1].originalPollPosition, original);
  assert.deepEqual(result[1].pollResult.winners, [options[1]]);
  assert.deepEqual(await request(late, lateConnection, taskPath), []);
  const limited = await late.readProtectedChatPage(lateConnection, channelId, 0);
  assert.ok(limited.first > original);
  assert.deepEqual(limited.messages, []);
  console.log('PASS closed poll waits for key rotation and an ordinary client publishes a single scoped result without the author');
}

module.exports = { checkProtectedPollPublication };
