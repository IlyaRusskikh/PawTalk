const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { MembershipClient } = require('../electron/membership-client.cjs');

const { base, serverId, source, destination, readerToken, ownerToken, profileId } =
  JSON.parse(readFileSync(0, 'utf8'));

function connect(token, fetcher = fetch) {
  const client = new MembershipClient({ allowLoopback: true, fetcher });
  client.connections.set(serverId, { base, token });
  return client;
}

async function main() {
  const reader = connect(readerToken);
  const owner = connect(ownerToken);
  await assert.rejects(connect('invalid').protectedVoiceGrant(serverId, source), { code: 'INVALID_SESSION' });
  const original = await reader.protectedVoiceGrant(serverId, source);
  assert.equal(original.url, base.replace('http:', 'ws:') + '/rtc');
  await reader.protectedVoiceHeartbeat(serverId);
  const wrongOrigin = connect(readerToken, async (...args) => {
    const response = await fetch(...args);
    const grant = await response.json();
    return Response.json({ ...grant, url: 'ws://127.0.0.1:1/rtc' }, { status: response.status });
  });
  await assert.rejects(wrongOrigin.protectedVoiceGrant(serverId, source), { code: 'PAWTALK_MEDIA_ADDRESS' });
  await assert.rejects(reader.moveProtectedVoice(serverId, profileId, source, destination), { code: 'VOICE_ACCESS_DENIED' });
  await owner.moveProtectedVoice(serverId, profileId, source, destination);
  let ready = '';
  for (let i = 0; i < 80 && ready === ''; i++) {
    ready = await reader.protectedVoiceDestination(serverId);
    if (!ready) await delay(25);
  }
  assert.equal(ready, destination);
  assert.equal(await owner.protectedVoiceDestination(serverId), '');
  const moved = await reader.protectedVoiceGrant(serverId, ready);
  const claims = JSON.parse(Buffer.from(moved.token.split('.')[1], 'base64url'));
  assert.equal(claims.video.canPublish, false);
  assert.equal(claims.video.canSubscribe, true);
  assert.equal(await reader.protectedVoiceDestination(serverId), '');
  await reader.leaveProtectedVoice(serverId);
  await reader.leaveProtectedVoice(serverId);
  await assert.rejects(reader.protectedVoiceHeartbeat(serverId), { code: 'VOICE_SLOT_LOST' });
  let rejoined;
  for (let i = 0; i < 80 && !rejoined; i++) {
    try {
      rejoined = await reader.protectedVoiceGrant(serverId, ready);
    } catch (error) {
      if (error.code !== 'VOICE_OCCUPIED') throw error;
      await delay(25);
    }
  }
  assert.ok(rejoined?.token);
  assert.notEqual(rejoined.token, moved.token);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
