const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const id = () => randomBytes(16).toString('hex');
const denies = (...permissions) => ({ Roles: { '@everyone': { Allow: null, Deny: permissions } }, Profiles: null });
const settings = (kind, name) => ({ Name: name, Description: `Fixture ${kind}`, SlowmodeSeconds: 0, VoiceCapacity: kind === 'voice' ? 2 : 0 });
const denied = { code: 'PROTECTED_ACCESS_DENIED' };

function sharedLoopbackQuota(fetcher) {
  return async (url, options) => {
    const response = await fetcher(url, options);
    if (response.status !== 429) return response;
    const seconds = Number(response.headers.get('retry-after'));
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 60) return response;
    await response.body?.cancel();
    await delay(seconds * 1000 + 100);
    return fetcher(url, { ...options, signal: AbortSignal.timeout(10000) });
  };
}

async function checkProtectedChannelLifecycle(fetcher, createClient, host, owner, defaultText) {
  const privateCategory = id(), publicCategory = id(), source = id(), voice = id(), copiedText = id(), copiedVoice = id();
  host.fetcher = sharedLoopbackQuota(host.fetcher);
  const guest = createClient(sharedLoopbackQuota(fetcher));
  const { link } = await host.createProtectedInvite(owner);
  await guest.redeemProtectedInvite(link, 'Channel lifecycle observer');
  const reader = await guest.openStoredProtectedRuntime(owner.serverId);
  const apply = async (action, resource, inspect) => {
    await host.readProtectedOwnerPolicy(owner);
    const intent = { Action: action, OperationID: id(), ResourceChange: resource };
    const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
    if (inspect) await inspect(JSON.parse(Buffer.from(preview.snapshot, 'base64')));
    return host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
  };
  const projection = () => guest.readProtectedRuntimeState(reader);
  const hidden = async ids => {
    const { channels } = await projection();
    assert.ok(channels.some(({ id }) => id === defaultText));
    assert.ok(channels.every(({ id }) => !ids.includes(id)));
  };
  await apply('category.create', { ID: privateCategory, Name: 'Synthetic closed category' });
  await apply('category.create', { ID: publicCategory, Name: 'Synthetic open category' });
  await apply('category.acl.update', { ID: privateCategory, ACL: denies('channel.view') });
  await apply('category.acl.update', { ID: publicCategory, ACL: denies('history.full') });
  await apply('channel.create', { ID: source, CategoryID: privateCategory,
    Channel: { Kind: 'text', Settings: settings('text', 'Synthetic restricted text') } });
  await apply('channel.create', { ID: voice, CategoryID: privateCategory,
    Channel: { Kind: 'voice', Settings: settings('voice', 'Synthetic restricted voice') } });
  await hidden([source, voice]);

  await apply('voice.mute', { ID: voice, TargetProfileID: reader.profileId });
  const sourceLive = await host.rotateProtectedRuntimeText(owner, source, 'live');
  const sourceArchive = await host.rotateProtectedRuntimeText(owner, source, 'archive');
  const text = 'Synthetic private original';
  const { Position: first } = await host.withCurrentProtectedChatPolicy(owner, trust =>
    host.sendProtectedRuntimeText(owner, source, text, id(), trust));
  await host.setProtectedMessagePin(owner, source, first, true);
  const originalCiphertext = (await host.readProtectedRuntimeText(owner, source)).messages;
  assert.ok(originalCiphertext.some(message => message.Position === first && message.Packet?.Ciphertext));

  const baseline = (await host.readProtectedOwnerPolicy(owner)).snapshot;
  assert.equal(baseline.Channels[source].Synchronized, true);
  assert.equal(baseline.Channels[voice].Synchronized, true);
  assert.equal(baseline.VoiceRestrictions[voice][reader.profileId].Muted, true);
  const verifyDefinition = (snapshot, original, copy) => {
    const { NextPosition: _counter, ...definition } = baseline.Channels[original];
    const { NextPosition: _copyCounter, ...copied } = snapshot.Channels[copy];
    assert.deepEqual(copied, definition);
  };
  const fetchWithQuota = host.fetcher;
  host.fetcher = (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === 'GET' &&
      ['current', 'admitted', 'archive'].some(route => path.startsWith(`/api/v3/keys/${route}/${source}/`))) {
      return Promise.resolve(Response.json({ error: { code: 'PROTECTED_KEY_PENDING' } }, { status: 409 }));
    }
    return fetchWithQuota(url, options);
  };
  for (const purpose of ['live', 'archive']) {
    await assert.rejects(host.loadProtectedRuntimeKey(owner, source, purpose, { policyTrust: owner.policyTrust }),
      { code: 'PROTECTED_KEY_PENDING' });
  }
  const waiting = (await host.readProtectedOwnerPolicy(owner)).snapshot;
  assert.deepEqual(waiting.Channels, baseline.Channels);
  assert.deepEqual((await host.readProtectedRuntimeText(owner, source)).messages, originalCiphertext);
  await apply('channel.copy', { ID: copiedText, SourceID: source }, async snapshot => {
    verifyDefinition(snapshot, source, copiedText);
    await hidden([source, voice, copiedText]);
    const current = await host.readProtectedRuntimeState(owner);
    assert.ok(current.channels.every(({ id }) => id !== copiedText));
  });
  await apply('channel.copy', { ID: copiedVoice, SourceID: voice }, snapshot => {
    verifyDefinition(snapshot, voice, copiedVoice);
    assert.equal(snapshot.VoiceRestrictions[copiedVoice], undefined);
  });
  await hidden([source, voice, copiedText, copiedVoice]);
  await assert.rejects(guest.readProtectedChatPage(reader, copiedText, 0), denied);
  const copiedLive = await host.rotateProtectedRuntimeText(owner, copiedText, 'live');
  const copiedArchive = await host.rotateProtectedRuntimeText(owner, copiedText, 'archive');
  assert.equal(copiedLive.generation, 1);
  assert.equal(copiedArchive.generation, 1);
  assert.notEqual(copiedLive.keyId, sourceLive.keyId);
  assert.notEqual(copiedArchive.keyId, sourceArchive.keyId);
  assert.deepEqual((await host.readProtectedChatPage(owner, copiedText, 0)).messages, []);
  assert.deepEqual((await host.readProtectedPins(owner, copiedText)).items, []);
  const restartText = 'Synthetic message in the new channel';
  await host.withCurrentProtectedChatPolicy(owner, trust =>
    host.sendProtectedRuntimeText(owner, copiedText, restartText, id(), trust));
  assert.deepEqual((await host.readProtectedChatPage(owner, copiedText, 0)).messages.map(message => message.text), [restartText]);
  assert.deepEqual((await host.readProtectedRuntimeText(owner, source)).messages, originalCiphertext);
  host.fetcher = fetchWithQuota;
  assert.equal((await host.readProtectedPinnedMessage(owner, source, first)).text, text);

  const local = denies('channel.view', 'message.send');
  await apply('channel.acl.update', { ID: source, ACL: local });
  await apply('category.acl.update', { ID: privateCategory, ACL: denies('channel.view', 'history.full') }, snapshot => {
    assert.equal(snapshot.Channels[source].Synchronized, false);
    assert.deepEqual(snapshot.Channels[source].ACL.Roles, local.Roles);
    assert.equal(snapshot.Channels[copiedText].Synchronized, true);
  });
  const move = { ID: source, CategoryID: publicCategory };
  await assert.rejects(apply('channel.move', move), { code: 'INVALID_PROTECTED_ACTION' });
  await apply('channel.move', { ...move, Mode: 'preserve' }, async snapshot => {
    assert.equal(snapshot.Channels[source].CategoryID, publicCategory);
    assert.deepEqual(snapshot.Channels[source].ACL.Roles, local.Roles);
    await hidden([source]);
  });
  await hidden([source]);
  await apply('channel.acl.sync', { ID: source }, async snapshot => {
    assert.equal(snapshot.Channels[source].Synchronized, true);
    await hidden([source]);
  });
  assert.ok((await projection()).channels.some(({ id }) => id === source));
  console.log('PASS continuation with source key delivery unavailable kept source ciphertext and opened independently encrypted new messages');
  await apply('category.delete', { ID: publicCategory, Mode: 'keep_children' }, snapshot => {
    assert.equal(snapshot.Categories[publicCategory], undefined);
    assert.equal(snapshot.Channels[source].CategoryID, '');
    assert.equal(snapshot.Channels[source].Synchronized, false);
    assert.deepEqual(snapshot.Channels[source].ACL.Roles, denies('history.full').Roles);
  });
  assert.equal((await host.readProtectedPinnedMessage(owner, source, first)).text, text);
  assert.ok((await projection()).channels.some(({ id }) => id === source));
  console.log('PASS channel copy has independent keys, restrictions and history; preserve, sync and keep-children apply only after signed preview');
}

module.exports = { checkProtectedChannelLifecycle };
