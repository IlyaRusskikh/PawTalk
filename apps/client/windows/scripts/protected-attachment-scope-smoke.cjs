const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { sealProtectedText } = require('../electron/protected-live-text.cjs');

const operationId = () => randomBytes(16).toString('hex');
const denied = { code: 'PROTECTED_ACCESS_DENIED' };
const conflict = { code: 'ATTACHMENT_CONFLICT' };

async function checkProtectedAttachmentScope({ fetcher, createClient, retryAfterFixtureQuota, host, owner, recordingChannel }) {
  const fileChannel = operationId(), otherChannel = operationId();
  const commit = async (action, resource) => {
    const intent = { Action: action, OperationID: operationId(), ResourceChange: resource };
    await host.readProtectedOwnerPolicy(owner);
    const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
    await host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
  };
  const everyoneDenies = grant => ({ Roles: { '@everyone': { Allow: null, Deny: [grant] } }, Profiles: null });
  await commit('channel.acl.update', { ID: recordingChannel, ACL: everyoneDenies('message.attach') });
  for (const [ID, Name] of [[fileChannel, 'Synthetic file channel'], [otherChannel, 'Synthetic other channel']]) {
    await commit('channel.create', { ID, Channel: { Kind: 'text',
      Settings: { Name, Description: '', SlowmodeSeconds: 0, VoiceCapacity: 0 } } });
  }
  await commit('channel.acl.update', { ID: fileChannel, ACL: everyoneDenies('message.voice') });

  const uploads = new Map();
  let substitutesFile;
  const observedFetch = async (url, options) => {
    const pathname = new URL(url).pathname;
    assert.notEqual(pathname, '/api/v3/policy/proofs', 'ordinary devices must use scoped evidence');
    const response = await fetcher(url, options);
    if (response.ok && pathname.startsWith('/api/v3/history/live-attachments/')) {
      if (options.method === 'PUT') uploads.set(pathname.split('/').at(-1), JSON.parse(options.body));
      if (substitutesFile && pathname.endsWith('/' + substitutesFile.target)) {
        const body = await response.json();
        assert.equal(body.total, substitutesFile.source.total);
        return new Response(JSON.stringify({ ...body, bytes: substitutesFile.source.bytes }), { status: response.status });
      }
    }
    return response;
  };
  const writerClient = createClient(observedFetch);
  const readerClient = createClient(observedFetch);
  const { link } = await host.createProtectedInvite(owner);
  await writerClient.redeemProtectedInvite(link, 'Synthetic attachment author');
  const writer = await writerClient.openStoredProtectedRuntime(owner.serverId);
  const challenge = await writerClient.makeProtectedDeviceChallenge(writer);
  const request = await readerClient.makeProtectedDeviceRequest(challenge);
  await writerClient.approveProtectedDeviceRequest(writer, request);
  const linked = await readerClient.finishProtectedDeviceBinding(challenge);
  assert.equal(linked.profileId, writer.profileId);
  assert.notEqual(linked.deviceId, writer.deviceId);
  await delay(5300);
  for (const channel of [recordingChannel, fileChannel, otherChannel]) await host.rotateProtectedRuntimeText(owner, channel, 'live');
  await host.syncProtectedPolicyAttestations(owner);

  const windowFlags = async channel => {
    const window = await writerClient.readProtectedHistoryWindow(writer, channel);
    return [window.canSend, window.canAttach === true, window.canSendVoice === true];
  };
  assert.deepEqual(await windowFlags(recordingChannel), [true, false, true]);
  assert.deepEqual(await windowFlags(fileChannel), [true, true, false]);

  const audio = { name: 'audio.webm', mime: 'audio/webm', bytes: Buffer.from('synthetic audio attachment') };
  const recorded = { ...audio, voice: { duration: 1, waveform: [0.1, 0.2] } };
  const stage = (channel, operation, file) => retryAfterFixtureQuota(() =>
    writerClient.stageProtectedAttachment(writer, channel, operation, 0, file));
  const send = (channel, operation, id) => retryAfterFixtureQuota(() => writerClient.withCurrentProtectedChatPolicy(writer, options =>
    writerClient.sendProtectedRuntimeText(writer, channel, '', operation, options, undefined, undefined, undefined, [id])));
  const read = (channel, position, id) => retryAfterFixtureQuota(() => readerClient.readProtectedFile(linked, channel, position, id));
  const reference = (channel, position) => retryAfterFixtureQuota(() => readerClient.readProtectedChatReference(linked, channel, position));
  await assert.rejects(stage(recordingChannel, operationId(), audio), denied);
  await assert.rejects(stage(fileChannel, operationId(), recorded), denied);
  const recordingOperation = operationId();
  const recordingId = await stage(recordingChannel, recordingOperation, recorded);
  const recording = await send(recordingChannel, recordingOperation, recordingId);
  assert.equal(uploads.get(recordingId).kind, 'voice');

  const fileOperation = operationId();
  const fileId = await stage(fileChannel, fileOperation, audio);
  const block = uploads.get(fileId);
  assert.equal(block.kind, 'file');

  const raw = (client, connection, route, method, body) => client.fetchJSON(connection.base, route, {
    method, body: JSON.stringify(body), fingerprint: connection.fingerprint, headers: { Authorization: 'Bearer ' + connection.token },
  });
  const assertForeignUpload = (client, connection, channel) => assert.rejects(raw(client, connection,
    '/api/v3/history/live-attachments/' + channel + '/' + fileId, 'PUT', block), conflict);
  await assertForeignUpload(writerClient, writer, otherChannel);
  await assertForeignUpload(readerClient, linked, fileChannel);
  await assertForeignUpload(host, owner, fileChannel);

  const assertBindingDenied = async (client, connection, channel, ref, error) => {
    const packet = await client.withCurrentProtectedChatPolicy(connection, async options => {
      const { secret, record } = await client.loadProtectedRuntimeKey(connection, channel, 'live', options);
      try {
        const { device } = await client.identity();
        return sealProtectedText(secret, connection.serverId, { ProfileID: connection.profileId, DeviceID: connection.deviceId },
          { ChannelID: channel, KeyID: record.KeyID, OperationID: operationId(), Attachments: [ref] },
          'Synthetic attachment binding check', device);
      } finally { secret.fill(0); }
    });
    await assert.rejects(raw(client, connection, '/api/v3/history/live/' + channel, 'POST', packet), error);
  };
  const fileRef = { id: fileId, kind: 'file' };
  await assertBindingDenied(writerClient, writer, recordingChannel, fileRef, denied);
  await assertBindingDenied(writerClient, writer, fileChannel, { id: recordingId, kind: 'voice' }, denied);
  await assertBindingDenied(writerClient, writer, otherChannel, fileRef, conflict);
  await assertBindingDenied(readerClient, linked, fileChannel, fileRef, conflict);
  await assertBindingDenied(host, owner, fileChannel, fileRef, conflict);
  const file = await send(fileChannel, fileOperation, fileId);
  assert.equal(file.Position, 1, 'failed bindings must not consume a message position');

  const checkReceived = async (channel, receipt, id, voice) => {
    const message = await reference(channel, receipt.Position);
    assert.equal(message.files[0].id, id);
    assert.deepEqual(message.files[0].voice, voice);
    assert.deepEqual(Buffer.from(await read(channel, receipt.Position, id)), audio.bytes);
  };
  await checkReceived(recordingChannel, recording, recordingId, recorded.voice);
  await checkReceived(fileChannel, file, fileId, undefined);

  substitutesFile = { target: fileId, source: uploads.get(recordingId) };
  try {
    await assert.rejects(read(fileChannel, file.Position, fileId), { code: 'INVALID_ATTACHMENT' });
  } finally { substitutesFile = undefined; }

  const preview = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v89WAAAAA==', 'base64');
  const original = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEAAAAABJRU5ErkJggg==', 'base64'), Buffer.alloc(64)]);
  const photo = { name: 'Photo.png', mime: 'image/png', bytes: original, preview: { bytes: preview }, view: { bytes: preview } };
  const mediaOperation = operationId();
  const mediaId = await stage(fileChannel, mediaOperation, photo);
  assert.equal(await stage(fileChannel, mediaOperation, photo), mediaId);
  await assert.rejects(stage(fileChannel, mediaOperation, { ...photo, view: { bytes: Buffer.concat([preview, Buffer.of(0)]) } }), conflict);
  const media = await send(fileChannel, mediaOperation, mediaId);
  const { files: [received] } = await reference(fileChannel, media.Position);
  assert.equal(received.id, mediaId);
  assert.equal(new Set([received.id, received.preview.id, received.view.id]).size, 3);
  for (const [part, expected] of [[received, original], [received.preview, preview], [received.view, preview]]) {
    assert.deepEqual(Buffer.from(await read(fileChannel, media.Position, part.id)), expected);
    await assert.rejects(read(fileChannel, file.Position, part.id), denied);
  }
  console.log('PASS preview, viewing copy and original are individually encrypted and bound to their message');
  console.log('PASS scoped voice and file grants are independent; encrypted attachments bind channel, profile, device and kind');
}

module.exports = { checkProtectedAttachmentScope };
