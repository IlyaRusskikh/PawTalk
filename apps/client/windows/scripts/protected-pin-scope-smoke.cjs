const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { VoiceSignal } = require('../electron/voice-signal.cjs');

const operationId = () => randomBytes(16).toString('hex');
const denied = { code: 'PROTECTED_ACCESS_DENIED' };

async function checkProtectedPinScope({ fetcher, createClient, host, owner, channelId }) {
  const setACL = async ACL => {
    const intent = { Action: 'channel.acl.update', OperationID: operationId(), ResourceChange: { ID: channelId, ACL } };
    await host.readProtectedOwnerPolicy(owner);
    const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
    await host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
  };
  const limitedRoles = { '@everyone': { Allow: null, Deny: ['history.full'] } };
  await setACL({ Roles: limitedRoles, Profiles: null });

  const send = (policy, text, { checklist, poll, mentions } = {}) =>
    host.sendProtectedRuntimeText(owner, channelId, text, operationId(), policy, undefined, checklist, poll, undefined, mentions);
  const sendCurrent = (text, content) => host.withCurrentProtectedChatPolicy(owner, policy => send(policy, text, content));
  const pin = (position, pinned = true) => host.setProtectedMessagePin(owner, channelId, position, pinned);
  const ownerPins = () => host.readProtectedPins(owner, channelId);
  const ownerOriginal = position => host.readProtectedPinnedMessage(owner, channelId, position);

  const checklist = { everyone: true, items: [{ id: operationId(), text: 'Synthetic task' }] };
  const poll = { duration: 3600, anonymous: false, multiple: false, intermediate: true, options: ['First', 'Second'] };
  const [plainPosition, listPosition, pollPosition] = await host.withCurrentProtectedChatPolicy(owner, async policy => [
    (await send(policy, 'Synthetic original text')).Position,
    (await send(policy, 'Synthetic checklist', { checklist })).Position,
    (await send(policy, 'Synthetic poll', { poll })).Position,
  ]);
  for (const position of [plainPosition, listPosition, pollPosition]) await pin(position);
  assert.deepEqual((await ownerPins()).items, [pollPosition, listPosition, plainPosition].map(position => ({ position, revision: 1 })));
  assert.deepEqual((await ownerOriginal(listPosition)).checklist, checklist);
  assert.deepEqual((await ownerOriginal(pollPosition)).poll, poll);

  await host.editProtectedChatMessage(owner, channelId, plainPosition, 1, operationId(), 'Synthetic revised text');
  assert.equal((await ownerPins()).items.find(pin => pin.position === plainPosition).revision, 2);
  const edited = await ownerOriginal(plainPosition);
  assert.deepEqual([edited.position, edited.revision, edited.text], [plainPosition, 2, 'Synthetic revised text']);
  await host.deleteProtectedMessage(owner, channelId, listPosition);
  assert.deepEqual((await ownerPins()).items.map(pin => pin.position), [pollPosition, plainPosition]);
  assert.equal(await ownerOriginal(listPosition), undefined);

  const guest = createClient((url, options) => {
    assert.notEqual(new URL(url).pathname, '/api/v3/policy/proofs', 'ordinary pin readers must use scoped evidence');
    return fetcher(url, options);
  });
  const { link } = await host.createProtectedInvite(owner);
  await guest.redeemProtectedInvite(link, 'Late reader');
  const late = await guest.openStoredProtectedRuntime(owner.serverId);
  const lateOriginal = position => guest.readProtectedPinnedMessage(late, channelId, position);
  const latePins = () => guest.readProtectedPins(late, channelId);
  const latePin = (position, pinned = true) => guest.setProtectedMessagePin(late, channelId, position, pinned);
  assert.deepEqual(await latePins(), { canPin: false, items: [], next: undefined });
  assert.equal((await guest.readProtectedHistoryWindow(late, channelId)).first, pollPosition + 1);
  await delay(5300);
  await host.rotateProtectedRuntimeText(owner, channelId, 'live');
  const target = '@Late reader';
  const { Position: recent } = await sendCurrent(target, { mentions: [{ kind: 'profile', id: late.profileId, start: 0, end: target.length }] });
  assert.equal(recent, pollPosition + 1);
  await assert.rejects(latePin(recent), denied);
  await setACL({ Roles: limitedRoles, Profiles: { [late.profileId]: { Allow: ['message.pin'], Deny: null } } });
  await host.syncProtectedPolicyAttestations(owner);
  assert.deepEqual(await latePins(), { canPin: true, items: [], next: undefined });
  await assert.rejects(latePin(plainPosition), denied);
  assert.equal(await lateOriginal(plainPosition), undefined);
  const inbox = await guest.pollProtectedMentions(late);
  assert.deepEqual(inbox.alerts, [{ channelId, position: recent, kind: 'direct' }]);

  const bridge = new VoiceSignal();
  const remote = new URL(late.base);
  remote.protocol = 'wss:';
  const eventPath = '/api/v3/events?after=0';
  const endpoint = await bridge.open(remote.href, late.fingerprint, { eventPath, eventToken: late.token });
  const socket = new WebSocket(endpoint + eventPath);
  const frames = [];
  socket.addEventListener('message', event => { frames.push(JSON.parse(event.data)); });
  const waitFor = async type => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const frame = frames.find(frame => frame.type === type);
      if (frame) return frame;
      await delay(25);
    }
    assert.fail('Missing protected event ' + type);
  };
  try {
    await waitFor('resync');
    await latePin(recent);
    const invalidation = await waitFor('chat');
    assert.deepEqual(invalidation, { type: 'chat', sequence: invalidation.sequence, channelId });
    assert.deepEqual((await latePins()).items, [{ position: recent, revision: 1 }]);
    assert.equal((await lateOriginal(recent)).text, target);
    await latePin(recent, false);
    assert.deepEqual((await latePins()).items, []);
    assert.deepEqual((await guest.pollProtectedMentions(late, inbox.cursor)).alerts, []);

    const { Position: next } = await sendCurrent('Synthetic notification control');
    assert.equal(next, recent + 1, 'pin and unpin must not create announcement messages');
    for (const frame of frames.filter(frame => frame.type === 'chat')) {
      assert.deepEqual(frame, { type: 'chat', sequence: frame.sequence, channelId });
    }
  } finally {
    socket.close();
    bridge.close();
  }
  console.log('PASS scoped pins follow original revisions, deletion and history floors without announcement messages or mention alerts');
}

module.exports = { checkProtectedPinScope };
