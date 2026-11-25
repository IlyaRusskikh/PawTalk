// Start the actual bundled core on loopback without port mapping.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, createPublicKey, randomBytes, randomInt, sign, verify } = require('node:crypto');
const { once } = require('node:events');
const { writeFileSync } = require('node:fs');
const { readFile, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const { app, BrowserWindow, net, session } = require('electron');
const { checkPorts, childReady } = require('../electron/selfhost.cjs');
const { serverCertificate } = require('../electron/connection.cjs');
const { MembershipClient } = require('../electron/membership-client.cjs');
const { profileRoleAuthorityProjectionVersion } = require('../electron/protected-channel-policy-commitments.cjs');
const { registerMembershipIPC } = require('../electron/membership-ipc.cjs');
const { ProtectedMembershipLive } = require('../electron/protected-membership-live.cjs');
const { membershipTransport } = require('../electron/membership-transport.cjs');
const { archiveRevisionPrivateKey, epochSignatureFrame, openKeyPackage, openSignedEpochPackage, recoveryPackageOpeningFrame } =
  require('../electron/protected-epoch-packages.cjs');
const { packageContext } = require('../electron/protected-archive-session.cjs');
const { loadDeviceAgreementKey } = require('../electron/protected-device-agreement.cjs');
const { roleViewDenyDigest } = require('../electron/protected-role-view-deny.cjs');
const { inviteAdmissionEpochDigest } = require('../electron/protected-live-invite-admission.cjs');
const { inviteAdmissionBatchDigest } = require('../electron/protected-invite-admission-batch.cjs');
const { ProtectedPolicyCheckpoint, protectedPolicySignatureFrame } = require('../electron/protected-policy-checkpoint.cjs');
const { createMigrationRecoveryCode, deriveRecoveryIdentity } = require('../electron/protected-migration-recovery.cjs');
const { createRecoveryBundle } = require('../electron/protected-recovery-bundle.cjs');
const { prepareProtectedRecoveryConfirmation } = require('../electron/protected-runtime-recovery.cjs');
const { checkProtectedAttachmentScope } = require('./protected-attachment-scope-smoke.cjs');
const { checkProtectedPinScope } = require('./protected-pin-scope-smoke.cjs');
const { checkProtectedPollPublication } = require('./protected-poll-publication-smoke.cjs');
const { checkProtectedChannelLifecycle } = require('./protected-channel-lifecycle-smoke.cjs');
const { checkProtectedRoleAssignmentOffline } = require('./protected-role-assignment-smoke.cjs');
const { VoiceSignal } = require('../electron/voice-signal.cjs');
const { signatureFrame } = require('../../../../shared/membership.cjs');

app.on('window-all-closed', () => {});

async function freePorts() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = randomInt(22000, 35000);
    try { await checkPorts(port); return port; } catch {}
  }
  throw new Error('No free loopback port group');
}

function createClient(fetcher, saved = new Map()) {
  return new MembershipClient({ fetcher, verify: serverCertificate, trust() {},
    credentials: {
      async load(key) { return saved.get(key); },
      async save(key, value) { saved.set(key, value); },
    },
  });
}

async function retryAfterFixtureQuota(operation) {
  try { return await operation(); }
  catch (error) {
    if (error.code !== 'RATE_LIMIT' || !Number.isInteger(error.retryAfter) || error.retryAfter < 1 || error.retryAfter > 60) throw error;
    await delay(error.retryAfter * 1000);
    return operation();
  }
}

async function startMediaPeer(input) {
  const provider = new LivekitClient.ExternalE2EEKeyProvider();
  const worker = new Worker('/worker.js');
  const room = new LivekitClient.Room({ encryption: { keyProvider: provider, worker } });
  const audio = new AudioContext();
  const peer = { room, worker, audio, provider };
  window.smokePeer = peer;
  const bytes = new Uint8Array(input.key);
  try { await provider.setKey(bytes.buffer); } finally { bytes.fill(0); }
  await room.setE2EEEnabled(true);
  await room.connect(input.endpoint, input.token, { autoSubscribe: true, maxRetries: 0, websocketTimeout: 4000 });
  return { identity: room.localParticipant.identity, encrypted: room.isE2EEEnabled };
}

async function publishSyntheticAudio() {
  const publication = await window.smokePeer.room.localParticipant.setMicrophoneEnabled(true, {
    echoCancellation: false, noiseSuppression: false, autoGainControl: false,
  });
  if (!publication?.trackSid) throw new Error('The synthetic microphone was not published');
}

async function waitForDecodedAudio(input) {
  const { room, audio } = window.smokePeer;
  const { remoteId, source } = typeof input === 'string'
    ? { remoteId: input, source: LivekitClient.Track.Source.Microphone } : input;
  await audio.resume();
  const until = Date.now() + 6000;
  let remoteTrack, inbound, baseline;
  while (Date.now() < until) {
    const remote = room.remoteParticipants.get(remoteId);
    const track = remote?.getTrackPublication(source)?.track;
    if (track && !remoteTrack) {
      remoteTrack = track;
      const element = document.createElement('audio');
      const silent = audio.createGain();
      silent.gain.value = 0;
      audio.createMediaElementSource(element).connect(silent).connect(audio.destination);
      document.body.append(element);
      track.attach(element);
      await element.play();
    }
    const stats = await remoteTrack?.getRTCStatsReport();
    inbound = stats && [...stats.values()].find(value => value.type === 'inbound-rtp' && value.kind === 'audio');
    // Confirm decoded non-silent audio and non-concealed samples without relying on a playback device.
    if (inbound) {
      const samples = inbound.totalSamplesReceived - inbound.concealedSamples;
      baseline ??= { samples, energy: inbound.totalAudioEnergy };
      if (inbound.totalAudioEnergy - baseline.energy > 0.01 && samples - baseline.samples >= 4800) return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('The remote encrypted track did not produce decoded audio: ' + JSON.stringify({
    track: Boolean(remoteTrack), packets: inbound?.packetsReceived, samples: inbound?.totalSamplesReceived,
    concealed: inbound?.concealedSamples, energy: inbound?.totalAudioEnergy,
  }));
}

async function publishProtectedScreen() {
  const { room, audio } = window.smokePeer;
  await audio.resume();
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext('2d');
  const timer = setInterval(() => {
    context.fillStyle = Math.floor(performance.now() / 100) % 2 ? '#ff7700' : '#3455dd';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 75);
  const video = canvas.captureStream(15).getVideoTracks()[0];
  const output = audio.createMediaStreamDestination();
  const tone = audio.createOscillator();
  tone.connect(output);
  tone.start();
  const sound = output.stream.getAudioTracks()[0];
  const peer = room.localParticipant;
  window.smokePeer.stopScreen = async () => {
    clearInterval(timer);
    tone.stop();
    await Promise.all([peer.unpublishTrack(video, true), peer.unpublishTrack(sound, true)]);
  };
  await peer.publishTrack(video, { source: LivekitClient.Track.Source.ScreenShare });
  await peer.publishTrack(sound, { source: LivekitClient.Track.Source.ScreenShareAudio });
}

async function waitForProtectedScreen(remoteId) {
  const { room } = window.smokePeer;
  const deadline = performance.now() + 8000;
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  document.body.append(video);
  let current;
  try {
    while (performance.now() < deadline) {
      const track = room.remoteParticipants.get(remoteId)?.getTrackPublication(LivekitClient.Track.Source.ScreenShare)?.track;
      if (track && !current) {
        current = track;
        current.attach(video);
      }
      if (video.videoWidth === 320 && video.videoHeight === 180 && video.readyState >= 2) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('The remote encrypted screen did not produce decoded video');
  } finally {
    current?.detach(video);
    video.remove();
  }
}

async function checkProtectedScreenPause({ id, paused }) {
  const { room } = window.smokePeer;
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    const track = room.remoteParticipants.get(id)?.getTrackPublication(LivekitClient.Track.Source.ScreenShare);
    if (track?.isMuted === paused) return track.trackSid;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Protected viewer did not receive the screen ${paused ? 'pause' : 'resume'}`);
}

async function stopMediaPeer() {
  const peer = window.smokePeer;
  if (!peer) return;
  await peer.stopScreen?.();
  await peer.room.disconnect();
  peer.worker.terminate();
  await peer.audio.close();
}

async function waitForMixedVoiceAudio(remoteId) {
  const { room, audio } = window.smokePeer;
  const deadline = performance.now() + 6000;
  let source, meter;
  try {
    while (performance.now() < deadline) {
      const track = room.remoteParticipants.get(remoteId)?.getTrackPublication(LivekitClient.Track.Source.Microphone)?.track;
      if (track && !meter) {
        source = audio.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
        meter = audio.createAnalyser();
        source.connect(meter);
      }
      if (meter) {
        const samples = new Float32Array(meter.fftSize);
        meter.getFloatTimeDomainData(samples);
        if (samples.some(sample => Math.abs(sample) > 0.01)) return;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('VoiceSession did not receive decoded tone');
  } finally { source?.disconnect(); }
}

function runPeer(window, fn, input) {
  return window.webContents.executeJavaScript('(' + fn.toString() + ')(' + (input === undefined ? '' : JSON.stringify(input)) + ')');
}

async function waitForVoiceDeafen(input) {
  const { room } = window.smokePeer;
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const local = room.localParticipant;
    const source = LivekitClient.Track.Source.Microphone;
    const remoteTrack = room.remoteParticipants.get(input.remoteId)?.getTrackPublication(source)?.track;
    if (local.permissions?.canPublish === input.publish && local.permissions?.canSubscribe === input.receive &&
        !local.getTrackPublication(source) && Boolean(remoteTrack) === input.receive) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`LiveKit did not apply listen=${input.receive}, publish=${input.publish} with no microphone track`);
}

async function waitForVoiceBan(remoteId) {
  const { room } = window.smokePeer;
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    if (remoteId === undefined && room.state === LivekitClient.ConnectionState.Disconnected) return;
    if (remoteId !== undefined && room.state === LivekitClient.ConnectionState.Connected &&
        room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone)?.track &&
        !room.remoteParticipants.has(remoteId)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(remoteId === undefined ? 'Banned peer remained connected to LiveKit' : 'Ban did not remove only the targeted stream');
}

async function checkVoiceDeafen(host, owner, guest, visitor, channelId, guestWindow) {
  const scope = { serverId: owner.serverId, sourceChannelId: channelId, channels: [] };
  const target = visitor.sessionId;
  const menu = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const voiceEvents = [];
  const subscription = new ProtectedMembershipLive(event => voiceEvents.push(event));
  const waitForEvent = async (type, start = 0) => {
    const deadline = performance.now() + 2500;
    while (performance.now() < deadline) {
      const event = voiceEvents.slice(start).find(event => event.type === type);
      if (event) return event;
      await delay(20);
    }
    assert.fail(`Timed out waiting for ${type} over the protected WebSocket`);
  };
  const checkVoiceEvent = async operation => {
    const start = voiceEvents.length;
    await operation();
    assert.deepEqual(await waitForEvent('voice', start), { serverId: owner.serverId, channelId, type: 'voice' });
  };
  const checkMenu = (language, restrictions, labels, selected = '') => runPeer(menu, async input => {
    const fixture = window.protectedVoiceStatusFixture;
    const wait = async predicate => {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Voice restriction menu did not update');
    };
    await fixture.showParticipantMenu(input);
    await wait(() => document.querySelector('.person-card') && !document.querySelector('.person-menu'));
    document.querySelector('.person-card').dispatchEvent(new KeyboardEvent('keydown', {
      key: 'F10', shiftKey: true, bubbles: true, cancelable: true,
    }));
    await wait(() => fixture.moveCalls().some(call => call.action === 'voice.protected.restriction-choices'));
    const buttons = () => [...document.querySelectorAll('.person-voice-restrictions button')];
    await wait(() => buttons().length === input.labels.length);
    if (JSON.stringify(buttons().map(button => button.textContent.trim())) !== JSON.stringify(input.labels)) {
      throw new Error(`Incorrect ${input.language} restriction actions`);
    }
    if (!input.selected) return;
    buttons().find(button => button.textContent.trim() === input.selected).click();
    await wait(() => fixture.moveCalls().some(call => call.action === 'voice.protected.restriction'));
    return fixture.moveCalls().find(call => call.action === 'voice.protected.restriction').input;
  }, { scope, targetSessionId: target, language, restrictions, labels, selected });
  const waitForDeafen = (receive, publish = false) => runPeer(guestWindow, waitForVoiceDeafen, { receive, publish, remoteId: owner.sessionId });
  const legacyOwner = Object.assign(Object.create(owner), { config: { ...owner.config, protectedVoiceChannelControls: false } });
  const choices = async () => (await host.protectedRuntimeVoiceRestrictionChoices(owner, channelId, target)).actions.filter(choice => !choice.serverWide);
  const apply = async (action, lift, choice, labels) => {
    const request = await checkMenu('en', await choices(), labels, choice);
    assert.deepEqual(request, { serverId: owner.serverId, sourceChannelId: channelId, targetSessionId: target, action, lift });
    await host.changeProtectedRuntimeVoiceRestriction(legacyOwner, channelId, target, request.action, request.lift);
  };
  try {
    await menu.loadURL(`${process.env.PAWTALK_UI_TEST_URL}/tests/protected-voice-status.html`);
    const denied = await guest.protectedRuntimeVoiceRestrictionChoices(visitor, channelId, owner.sessionId);
    assert.deepEqual(denied, { actions: [], profileId: undefined });
    const voiceRoster = await guest.readProtectedRuntimeRoster(visitor, undefined, undefined, undefined, false, true);
    assert.deepEqual(voiceRoster.members.map(member => member.id).sort(), [owner.profileId, visitor.profileId].sort());
    assert.ok(voiceRoster.members.every(member => member.roles.length === 1 && member.roles[0].id === '@everyone'));
    await host.protectedRuntimeVoiceTelemetry(owner, channelId, { rtt: 46, loss: 0 });
    assert.deepEqual(await guest.protectedRuntimeVoiceTelemetry(visitor, channelId, { rtt: 63, loss: 1 }),
      [{ sessionId: owner.sessionId, rtt: 46, loss: 0 }]);
    assert.deepEqual(await host.protectedRuntimeVoiceTelemetry(owner, channelId, { rtt: 48, loss: 0 }),
      [{ sessionId: visitor.sessionId, rtt: 63, loss: 1 }]);
    await assert.rejects(guest.protectedRuntimeVoiceTelemetry(visitor, randomBytes(16).toString('hex'), { rtt: 63, loss: 1 }),
      { code: 'VOICE_SLOT_LOST' });
    const sample = { rtt: 63, loss: 1 };
    await guest.protectedRuntimeVoiceTelemetry(visitor, channelId, { ...sample, muted: true }, true);
    const voiceState = await host.readProtectedRuntimeState(owner);
    const peerStatus = voiceState.channels.find(channel => channel.id === channelId).voiceParticipants.find(person => person.sessionId === target);
    assert.equal(peerStatus.selfMuted, true);
    assert.equal(peerStatus.serverMuted, undefined);
    subscription.ensure(visitor);
    await waitForEvent('resync');
    await checkVoiceEvent(() => host.changeProtectedRuntimeVoiceRestriction(owner, channelId, target, 'voice.mute', false));
    const { commands } = await guest.protectedRuntimeVoiceTelemetry(visitor, channelId, sample, true);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].action, 'voice.mute');
    assert.deepEqual((await host.protectedRuntimeVoiceTelemetry(owner, channelId, sample, true)).commands, []);
    assert.equal((await host.readProtectedOwnerPolicy(owner)).snapshot.VoiceRestrictions?.[channelId], undefined);
    await assert.rejects(guest.changeProtectedRuntimeVoiceRestriction(visitor, channelId, owner.sessionId, 'voice.deafen', false),
      { code: 'PROTECTED_ACCESS_DENIED' });
    await checkMenu('ru', denied.actions, []);
    await checkMenu('en', denied.actions, []);
    await checkMenu('ru', await choices(), ['Заглушить', 'Откл. звук']);
    await apply('voice.mute', false, 'Mute', ['Mute', 'Deafen']);
    await waitForDeafen(true);
    await runPeer(guestWindow, waitForDecodedAudio, owner.sessionId);
    await apply('voice.deafen', false, 'Deafen', ['Unmute', 'Deafen']);
    await waitForDeafen(false);
    await checkMenu('ru', await choices(), ['Снять заглушение', 'Вкл. звук']);
    await apply('voice.deafen', true, 'Undeafen', ['Unmute', 'Undeafen']);
    await waitForDeafen(true);
    await runPeer(guestWindow, waitForDecodedAudio, owner.sessionId);
    const { snapshot } = await host.readProtectedOwnerPolicy(owner);
    assert.deepEqual(snapshot.VoiceRestrictions[channelId][visitor.profileId], { Muted: true, Deafened: false });
    await apply('voice.mute', true, 'Unmute', ['Unmute', 'Deafen']);
    await waitForDeafen(true, true);
    await checkVoiceEvent(() => host.changeProtectedRuntimeVoiceRestriction(owner, channelId, target, 'voice.deafen', false, true));
    await waitForDeafen(false);
    await checkVoiceEvent(() => host.changeProtectedRuntimeVoiceRestriction(owner, channelId, target, 'voice.deafen', true, true));
    await waitForDeafen(true, true);
    console.log('PASS channel and server moderation controls encrypted media; lifting deafen preserves any channel mute');
  } finally {
    subscription.stop();
    menu.destroy();
  }
}

async function checkSustainedVoiceDeafen(host, owner, guest, visitor, channelId, ownerWindow, guestWindow, grant, localExpiry, reconnectEndpoint) {
  const call = (method, value) => runPeer(guestWindow, ({ method, value }) => window.protectedVoiceStatusFixture[method](value), { method, value });
  const until = async (predicate, description) => {
    const deadline = Date.now() + 17_000;
    while (Date.now() < deadline) {
      const state = await call('read');
      if (predicate(state)) return state;
      await delay(30);
    }
    assert.fail(`Timed out waiting for ${description}: ${JSON.stringify(await call('read'))}`);
  };
  const legacyOwner = Object.assign(Object.create(owner), { config: {
    ...owner.config, protectedVoiceChannelControls: false, protectedVoiceMediaDeafen: false,
  } });
  const apply = (action, lift) => host.changeProtectedRuntimeVoiceRestriction(legacyOwner, channelId, visitor.sessionId,
    action, lift, action === 'voice.deafen');
  await runPeer(ownerWindow, async () => {
    const { room, audio } = window.smokePeer;
    const oscillator = audio.createOscillator();
    const output = audio.createMediaStreamDestination();
    oscillator.connect(output);
    oscillator.start();
    await audio.resume();
    await room.localParticipant.publishTrack(output.stream.getAudioTracks()[0], { source: LivekitClient.Track.Source.Microphone });
  });
  await runPeer(guestWindow, waitForMixedVoiceAudio, owner.sessionId);
  await apply('voice.mute', false);
  await apply('voice.deafen', false);
  await runPeer(guestWindow, waitForVoiceDeafen, { receive: false, publish: false, remoteId: owner.sessionId });
  const expectedEpoch = reconnectEndpoint ? null : grant.epoch.epochId;
  if (reconnectEndpoint) {
    const original = visitor;
    await call('disconnect');
    await guest.leaveProtectedRuntimeVoice(original);
    visitor = await guest.openStoredProtectedRuntime(owner.serverId);
    assert.equal(visitor.deviceId, original.deviceId);
    assert.notEqual(visitor.sessionId, original.sessionId);
    let parked;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { parked = await guest.joinProtectedRuntimeVoice(visitor, channelId, visitor.policyTrust); break; }
      catch (error) { if (error.code !== 'VOICE_OCCUPIED' || attempt === 4) throw error; }
      await delay(300);
    }
    const reconnected = await guest.reconnectProtectedRuntimeVoice(visitor, channelId, visitor.policyTrust);
    for (const access of [parked, reconnected]) {
      assert.equal(access.serverDeafened, true);
      for (const value of [access.epoch, access.key, access.keyEpoch]) assert.equal(value, undefined);
      const claims = JSON.parse(Buffer.from(access.token.split('.')[1], 'base64url'));
      assert.equal(claims.sub, visitor.sessionId);
      assert.equal(claims.attributes['pawtalk.voice-parked'], 'true');
      assert.equal(claims.attributes['pawtalk.voice-epoch'], undefined);
      for (const privilege of ['canPublish', 'canSubscribe', 'canPublishData']) assert.equal(claims.video[privilege], false);
    }
    assert.notEqual(parked.token, reconnected.token);
    await call('begin', { serverId: owner.serverId, channelId, controlRefresh: true });
    await call('grant', { ...reconnected, url: reconnectEndpoint });
    assert.equal(await call('joined'), true);
    await call('bindMedia');
    const current = await until(state => state.states.at(-1)?.reason === 'VOICE_SERVER_DEAFENED' && state.encrypted, 'parked media connection');
    assert.equal(current.checkpointEpoch, undefined);
    assert.equal(current.canSubscribe, false);
    assert.equal(current.canPublish, false);
  }
  for (let pass = 0; pass < (reconnectEndpoint ? 1 : 2); pass++) {
    const pending = await until(state => state.heartbeatPending, 'actual VoiceSession heartbeat during deafen');
    const result = await guest.refreshProtectedRuntimeVoiceKey(visitor, channelId, visitor.policyTrust, pending.heartbeatEpoch);
    assert.deepEqual(result, { serverDeafened: true });
    await call('respondHeartbeat', result);
    const suspended = await until(state => state.states.at(-1)?.reason === 'VOICE_SERVER_DEAFENED', 'deafened VoiceSession status');
    assert.equal(pending.heartbeatEpoch, expectedEpoch);
    assert.equal(suspended.connection, 'connected');
    assert.equal(suspended.canPublish, false);
    assert.equal(suspended.canSubscribe, false);
    assert.equal(suspended.microphone, false);
  }
  if (!reconnectEndpoint) assert.ok(Date.now() > localExpiry, 'deafened slot survived its local media key deadline');
  await assert.rejects(guest.exchangeProtectedRuntimeVoiceKey(visitor, channelId, visitor.policyTrust), { code: 'PROTECTED_ACCESS_DENIED' });

  await apply('voice.deafen', true);
  await until(state => state.canSubscribe === true, 'LiveKit receive permission after lifting deafen');
  const ownerKey = await host.refreshProtectedRuntimeVoiceKey(owner, channelId, owner.policyTrust, grant.epoch.epochId);
  assert.ok(ownerKey?.key);
  await runPeer(ownerWindow, async key => {
    const bytes = new Uint8Array(key);
    try { await window.smokePeer.provider.setKey(bytes.buffer); } finally { bytes.fill(0); }
  }, [...Buffer.from(ownerKey.key, 'hex')]);
  const pending = await until(state => state.heartbeatPending, 'VoiceSession heartbeat after deafen lift');
  const next = await guest.refreshProtectedRuntimeVoiceKey(visitor, channelId, visitor.policyTrust, pending.heartbeatEpoch);
  assert.ok(next?.key && next.epochId !== grant.epoch.epochId);
  assert.equal(next.epochId, ownerKey.epochId);
  assert.equal(next.key, ownerKey.key);
  await call('holdWorkerProof');
  await call('respondHeartbeat', next);
  const confirming = await until(state => state.pendingWorkerMessages, 'fresh worker key confirmation');
  assert.equal(confirming.states.at(-1)?.state, 'yellow');
  if (reconnectEndpoint) assert.equal(confirming.remoteTracks, 0, 'parked renderer must not subscribe before its first verified key');
  await call('releaseWorkerProof');
  const resumed = await until(state => state.heartbeatEpoch === next.epochId || state.states.at(-1)?.state === 'green', 'new epoch installation');
  if (resumed.heartbeatEpoch) {
    const healthy = await guest.refreshProtectedRuntimeVoiceKey(visitor, channelId, visitor.policyTrust, resumed.heartbeatEpoch);
    assert.equal(healthy, null);
    await call('respondHeartbeat', healthy);
  }
  const verified = await until(state => state.states.at(-1)?.state === 'green', 'verified media after deafen lift');
  assert.equal(verified.canPublish, false);
  assert.equal(verified.canSubscribe, true);
  assert.equal(verified.microphone, false);
  await runPeer(guestWindow, waitForMixedVoiceAudio, owner.sessionId);
  console.log(reconnectEndpoint
    ? 'PASS a new session and regrant remain parked without media keys under server deafen; signed lift restores audio only under a new verified epoch'
    : 'PASS sustained deafen renews the same media slot without a key across two heartbeats and restores audio only after a fresh verified epoch');
  return visitor;
}

async function checkVoiceModerationKeyContinuity(host, owner, guest, visitor, channelId, epoch, checkMediaPermissions) {
  for (const action of ['voice.mute', 'voice.deafen']) {
    for (const lift of [false, true]) {
      await host.changeProtectedRuntimeVoiceRestriction(owner, channelId, visitor.sessionId, action, lift, true);
      assert.equal(await host.refreshProtectedRuntimeVoiceKey(owner, channelId, owner.policyTrust, epoch), null);
      assert.equal(await guest.refreshProtectedRuntimeVoiceKey(visitor, channelId, visitor.policyTrust, epoch), null);
      const state = await guest.readProtectedRuntimeState(visitor);
      const participant = state.channels.find(channel => channel.id === channelId).voiceParticipants
        .find(person => person.sessionId === visitor.sessionId);
      assert.equal(Boolean(action === 'voice.mute' ? participant.serverMuted : participant.serverDeafened), !lift);
      if (checkMediaPermissions) await checkMediaPermissions(action === 'voice.mute' || lift, lift);
    }
  }
  console.log('PASS server mic mute and deafen retain the same epoch on both clients');
}

async function checkMedia(host, owner, guest, visitor, channelId, checkBadProof, { moderate, sustained, rejoin, banActive, changeCapacity, keysOnly }) {
  const gateways = [new VoiceSignal(), new VoiceSignal()];
  const sdkDirectory = path.dirname(require.resolve('livekit-client'));
  const assets = new Map([
    ['/', ['text/html', '<!doctype html><script src="/sdk.js"></script>']],
    ['/sdk.js', ['text/javascript', await readFile(path.join(sdkDirectory, 'livekit-client.umd.js'))]],
    ['/worker.js', ['text/javascript', await readFile(path.join(sdkDirectory, 'livekit-client.e2ee.worker.js'))]],
  ]);
  const page = createServer((request, response) => {
    const asset = assets.get(request.url);
    if (!asset) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', asset[0]);
    response.end(asset[1]);
  });
  page.listen(0, '127.0.0.1');
  await once(page, 'listening');
  const windows = [];
  let localExpiry, guestEndpoint;
  const setCapacity = async VoiceCapacity => {
    const { snapshot } = await host.readProtectedOwnerPolicy(owner);
    const settings = { ...snapshot.Channels[channelId].Settings, VoiceCapacity };
    const intent = { Action: 'channel.settings.update', OperationID: randomBytes(16).toString('hex'),
      ResourceChange: { ID: channelId, Settings: settings } };
    const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
    await host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
    await host.syncProtectedPolicyAttestations(owner);
  };
  try {
    if (changeCapacity) await setCapacity(1);
    await host.prepareProtectedRuntimeVoice(owner, channelId);
    let guestGrant;
    if (!changeCapacity) {
      await guest.prepareProtectedRuntimeVoice(visitor, channelId);
      await checkBadProof(channelId);
      guestGrant = await guest.joinProtectedRuntimeVoice(visitor, channelId, visitor.policyTrust);
    }
    const ownerGrant = await host.reconnectProtectedRuntimeVoice(owner, channelId, owner.policyTrust);
    if (guestGrant) {
      assert.equal(ownerGrant.epoch.epochId, guestGrant.epoch.epochId);
      assert.ok(ownerGrant.key === guestGrant.key, 'both devices open the same protected epoch');
    }
    if (keysOnly) {
      await checkVoiceModerationKeyContinuity(host, owner, guest, visitor, channelId, ownerGrant.epoch.epochId);
      return;
    }
    const connections = [owner, visitor];
    for (const [index, connection] of connections.entries()) {
      if (changeCapacity && index === 1) {
        const roster = async () => (await guest.readProtectedRuntimeState(visitor)).channels.find(channel => channel.id === channelId);
        for (const capacity of [1, 2]) {
          if (capacity === 2) await setCapacity(capacity);
          const channel = await roster();
          assert.equal(channel.settings.voiceCapacity, capacity);
          assert.deepEqual(channel.voiceParticipants.map(person => person.profileId), [owner.profileId]);
          assert.ok(channel.voiceParticipants[0].name);
          if (capacity === 1) await assert.rejects(guest.prepareProtectedRuntimeVoice(visitor, channelId), { code: 'VOICE_FULL' });
        }
        await guest.prepareProtectedRuntimeVoice(visitor, channelId);
        guestGrant = await guest.joinProtectedRuntimeVoice(visitor, channelId, visitor.policyTrust);
      }
      const access = index === 0 ? ownerGrant : guestGrant;
      assert.equal(access.e2eeRequired, true);
      const endpoint = await gateways[index].open(access.url, connection.fingerprint);
      const window = new BrowserWindow({ show: false, webPreferences: {
        sandbox: true, contextIsolation: true, backgroundThrottling: false,
        partition: 'pawtalk-protected-media-' + index,
      } });
      windows.push(window);
      if (sustained && index === 1) {
        guestEndpoint = endpoint;
        const call = (method, value) => runPeer(window, ({ method, value }) => globalThis.protectedVoiceStatusFixture[method](value), { method, value });
        await window.loadURL(`${process.env.PAWTALK_UI_TEST_URL}/tests/protected-voice-status.html`);
        await call('begin', { serverId: owner.serverId, channelId, controlRefresh: true });
        localExpiry = rejoin ? access.epoch.expiresAt : Date.now() + 9000;
        await call('grant', { ...access, url: endpoint, epoch: { ...access.epoch, expiresAt: localExpiry } });
        assert.equal(await call('joined'), true);
        await call('bindMedia');
        continue;
      }
      await window.loadURL('http://127.0.0.1:' + page.address().port + '/');
      const receipt = await runPeer(window, startMediaPeer, { endpoint, token: access.token, key: [...Buffer.from(access.key, 'hex')] });
      assert.deepEqual(receipt, { identity: connection.sessionId, encrypted: true });
    }
    if (changeCapacity) {
      const roster = async () => (await guest.readProtectedRuntimeState(visitor)).channels.find(channel => channel.id === channelId).voiceParticipants;
      assert.deepEqual((await roster()).map(person => person.profileId).sort(), [owner.profileId, visitor.profileId].sort());
      await host.leaveProtectedRuntimeVoice(owner);
      assert.deepEqual((await roster()).map(person => person.profileId), [visitor.profileId]);
      console.log('PASS second client sees an occupied voice channel at limits 1 and 2 and connects without recreating the LiveKit room');
      return;
    }
    if (sustained) {
      visitor = await checkSustainedVoiceDeafen(host, owner, guest, visitor, channelId, windows[0], windows[1], guestGrant, localExpiry, rejoin ? guestEndpoint : undefined);
      return;
    }
    for (const [sender, receiver] of [[0, 1], [1, 0]]) {
      await runPeer(windows[sender], publishSyntheticAudio);
      await runPeer(windows[receiver], waitForDecodedAudio, connections[sender].sessionId);
    }
    if (moderate) {
      await runPeer(windows[0], publishProtectedScreen);
      await Promise.all([
        runPeer(windows[1], waitForProtectedScreen, owner.sessionId),
        runPeer(windows[1], waitForDecodedAudio, { remoteId: owner.sessionId, source: 'screen_share_audio' }),
      ]);
      const trackSid = await runPeer(windows[1], id => window.smokePeer.room.remoteParticipants.get(id)
        .getTrackPublication(LivekitClient.Track.Source.ScreenShare).trackSid, owner.sessionId);
      for (const paused of [true, false]) {
        await runPeer(windows[0], async value => {
          const screen = window.smokePeer.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.ScreenShare);
          if (value) await screen.pauseUpstream(); else await screen.resumeUpstream();
        }, paused);
        const observed = await runPeer(windows[1], checkProtectedScreenPause, { id: owner.sessionId, paused });
        assert.equal(observed, trackSid);
      }
      console.log('PASS API 3 viewer receives screen pause and resume on the same video publication with data publishing disabled');
      await runPeer(windows[0], async () => {
        await window.smokePeer.stopScreen();
        window.smokePeer.stopScreen = undefined;
      });
      console.log('PASS API 3 encrypted screen frames and screen audio reach a second client alongside its microphone track');
      await checkVoiceModerationKeyContinuity(host, owner, guest, visitor, channelId, ownerGrant.epoch.epochId,
        (receive, publish) => runPeer(windows[1], waitForVoiceDeafen, { receive, publish, remoteId: owner.sessionId }));
      await checkVoiceDeafen(host, owner, guest, visitor, channelId, windows[1]);
    }
    if (banActive) {
      assert.equal(await host.changeProtectedMembership(owner, 'ban', visitor.profileId, { reason: 'Synthetic voice ban' }), true);
      await Promise.all([runPeer(windows[1], waitForVoiceBan), runPeer(windows[0], waitForVoiceBan, visitor.sessionId)]);
      await assert.rejects(guest.refreshProtectedRuntimeVoiceKey(visitor, channelId, visitor.policyTrust, guestGrant.epoch.epochId),
        { code: 'INVALID_PROTECTED_SESSION' });
      await assert.rejects(guest.joinProtectedRuntimeVoice(visitor, channelId, visitor.policyTrust), { code: 'INVALID_PROTECTED_SESSION' });
      console.log('PASS signed API 3 ban disconnects a peer after bidirectional E2EE audio and denies fresh key and grant');
    }
  } finally {
    await Promise.allSettled(windows.map((window, index) => sustained && index === 1
      ? window.webContents.executeJavaScript('window.protectedVoiceStatusFixture?.disconnect()') : runPeer(window, stopMediaPeer)));
    for (const window of windows) window.destroy();
    for (const gateway of gateways) gateway.close();
    page.close();
    await Promise.allSettled([host.leaveProtectedRuntimeVoice(owner), guest.leaveProtectedRuntimeVoice(visitor)]);
  }
}

async function checkRecoveryPackages(host, owner, guest, visitor, recoveryCode, previousCode, recoveryId, channelId) {
  let coverage = await guest.readProtectedRecoveryCoverage(visitor);
  assert.equal(coverage.recoveryId, recoveryId);
  assert.deepEqual(coverage.items.map(({ channelId, purpose }) => [channelId, purpose]).sort(),
    [[channelId, 'archive'], [channelId, 'live']]);
  assert.ok(coverage.items.every(item => item.pending), 'new recovery starts with unrotated packages');
  // The enrolling guest has the initial five-second rotation priority.
  // Let a separate device publish the packages without polling the IP quota.
  await new Promise(resolve => setTimeout(resolve, 5300));
  await host.serviceProtectedRuntimeRotations(owner);
  await host.serviceProtectedRuntimeRotations(owner);
  coverage = await guest.readProtectedRecoveryCoverage(visitor);
  assert.equal(coverage.recoveryId, recoveryId);
  assert.equal(coverage.items.length, 2);
  assert.ok(coverage.items.every(item => !item.pending), 'both live and archive recovery packages must be published');
  const recovery = deriveRecoveryIdentity(recoveryCode, visitor.serverId, visitor.profileId);
  const spkiEd25519 = Buffer.from('302a300506032b6570032100', 'hex');
  for (const item of coverage.items) {
    const challenge = { nonce: randomBytes(32).toString('hex'), expiresAt: Date.now() + 60_000 };
    await assert.rejects(guest.proveProtectedRecoveryPackageOpening(visitor, previousCode, coverage, item, challenge),
      { code: 'INVALID_PROTECTED_RECOVERY' });
    const proof = await guest.proveProtectedRecoveryPackageOpening(visitor, recoveryCode, coverage, item, challenge);
    const delivery = await guest.fetchJSON(visitor.base, `/api/v3/recovery/packages/${item.channelId}/${item.purpose}`, {
      fingerprint: visitor.fingerprint, headers: { Authorization: `Bearer ${visitor.token}` },
    });
    const ciphertext = Buffer.from(delivery.Package.Ciphertext, 'base64');
    assert.equal(ciphertext.length, 144);
    const publicKey = createPublicKey({ key: Buffer.concat([spkiEd25519, ciphertext.subarray(-32)]), format: 'der', type: 'spki' });
    const frame = recoveryPackageOpeningFrame({ ...challenge, ...item, serverId: visitor.serverId, cutoverDigest: visitor.cutoverDigest,
      profileId: visitor.profileId, deviceId: visitor.deviceId, recoveryId, policyHead: coverage.policyHead });
    assert.ok(verify(null, frame, publicKey, Buffer.from(proof.openingProof, 'base64url')));
    assert.ok(verify(null, frame, createPublicKey(recovery.signing), Buffer.from(proof.recoveryProof, 'base64url')));
  }
}

async function run(directory) {
  const pinScopeFlag = '--protected-pin-scope';
  const attachmentScopeFlag = '--protected-attachment-scope';
  const channelLifecycleFlag = '--protected-channel-lifecycle';
  const pollPublicationFlag = '--protected-poll-publication';
  const archiveRecoveryFlag = '--scoped-archive-recovery-deny-offline';
  const archiveRoleDenyFlag = '--scoped-archive-role-deny-offline';
  const revisionAudienceFlag = '--scoped-revision-audience';
  const revisionAudienceOfflineFlag = '--scoped-revision-audience-offline';
  const revisionRoleDenyOfflineFlag = '--scoped-revision-role-deny-offline';
  const roleDenyOfflineFlag = '--scoped-channel-role-deny-offline';
  const roleAssignmentOfflineFlag = '--scoped-role-assignment-offline';
  const protectedEventsFlag = '--protected-events';
  const bulkAdministratorFlag = '--policy-bulk-administrator';
  const bulkChannelReadinessFlag = '--key-bulk-channel-readiness';
  const scopedInviteOfflineFlag = '--scoped-invite-offline';
  const scopedInviteFullOfflineFlag = '--scoped-invite-full-offline';
  const scopedInviteBatchOfflineFlag = '--scoped-invite-batch-offline';
  const scopedInvitePrefixOfflineFlag = '--scoped-invite-batch-prefix-offline';
  const voiceBanActiveFlag = '--voice-ban-active';
  const mentionScopeFlag = '--protected-mentions';
  const recoveryReplacementFlag = '--recovery-replacement';
  const communityAvatarFlag = '--community-avatar';
  const avatarRecoveryFlag = '--avatar-recovery';
  const [, api = 'resources/server/pawtalk-api.exe', media = 'resources/server/livekit-server.exe'] =
    process.argv.slice(2).filter(argument => argument !== roleAssignmentOfflineFlag && !['--recovery-opening', '--device-recovery', '--device-binding', '--owner-recovery', '--owner-transfer', '--owner-transfer-recovery', '--profile-linking', '--scope-device-handover', '--scope-device-detach', '--message-retry', '--scoped-channel-settings', '--scoped-channel-acl', roleDenyOfflineFlag, '--scoped-personal-acl', '--scoped-personal-acl-offline', '--scoped-archive-rotation', '--scoped-archive-personal-deny', '--scoped-archive-personal-deny-offline', '--scoped-archive-live-only-deny-offline', archiveRecoveryFlag, archiveRoleDenyFlag, revisionAudienceFlag, revisionAudienceOfflineFlag, revisionRoleDenyOfflineFlag, protectedEventsFlag, '--policy-administrator', bulkAdministratorFlag, bulkChannelReadinessFlag, scopedInviteOfflineFlag, scopedInviteFullOfflineFlag, scopedInviteBatchOfflineFlag, scopedInvitePrefixOfflineFlag, '--text-protection-status', '--voice-protection-status', '--voice-moderation', '--voice-deafen-sustained', '--voice-deafen-rejoin', '--voice-move', voiceBanActiveFlag, attachmentScopeFlag, pollPublicationFlag, pinScopeFlag, mentionScopeFlag, recoveryReplacementFlag, channelLifecycleFlag, communityAvatarFlag, avatarRecoveryFlag].includes(argument));
  const port = await freePorts();
  const configPath = path.join(directory, 'livekit.yaml');
  const key = 'vc_' + randomBytes(12).toString('hex'), secret = randomBytes(32).toString('hex');
  await writeFile(configPath, `port: ${port+3}
bind_addresses: [127.0.0.1]
rtc:
  tcp_port: ${port+1}
  udp_port: ${port+2}
  use_external_ip: false
  node_ip: 127.0.0.1
  enable_loopback_candidate: true
  stun_servers: []
keys:
  ${key}: ${secret}
logging:
  level: error
`, { mode: 0o600 });
  const fetcher = membershipTransport(session, (...args) => net.fetch(...args));
  const recoveryOpening = process.argv.includes('--recovery-opening');
  const deviceRecovery = process.argv.includes('--device-recovery');
  const deviceBinding = process.argv.includes('--device-binding');
  const profileLinking = process.argv.includes('--profile-linking');
  const messageRetry = process.argv.includes('--message-retry');
  const textProtectionStatus = process.argv.includes('--text-protection-status');
  const voiceProtectionStatus = process.argv.includes('--voice-protection-status');
  const scopedSettings = process.argv.includes('--scoped-channel-settings');
  const scopeDeviceHandover = process.argv.includes('--scope-device-handover');
  const scopeDeviceDetach = process.argv.includes('--scope-device-detach');
  const ownerRecovery = process.argv.includes('--owner-recovery');
  const ownerTransferRecovery = process.argv.includes('--owner-transfer-recovery');
  const ownerTransfer = ownerTransferRecovery || process.argv.includes('--owner-transfer');
  let firstBindingBody;
  let firstBindingReceipt;
  let messageOperation;
  const messageAttempts = [];
  const statusProbe = { tamper: false, tampered: 0, requests: 0 };
  let tamperVoiceKey = false;
  const host = createClient(async (url, options) => {
    const appliesBinding = deviceBinding && new URL(url).pathname === '/api/v3/devices/bind/apply';
    if (appliesBinding && firstBindingBody !== undefined) assert.equal(options.body, firstBindingBody);
    const response = await fetcher(url, options);
    if (appliesBinding && response.ok) {
      if (firstBindingBody === undefined) {
        firstBindingBody = options.body;
        firstBindingReceipt = await response.json();
        throw new Error('synthetic committed device binding response loss');
      }
      assert.deepEqual(await response.clone().json(), firstBindingReceipt);
    }
    if (messageOperation && options.method === 'POST' && new URL(url).pathname.startsWith('/api/v3/history/live/') && response.ok) {
      const packet = JSON.parse(options.body);
      if (packet.OperationID === messageOperation) {
        messageAttempts.push({ packet, receipt: await response.clone().json() });
        if (messageAttempts.length === 1) throw new Error('synthetic committed protected message response loss');
      }
    }
    if (textProtectionStatus) {
      statusProbe.requests++;
      if (statusProbe.tamper && response.ok && /^\/api\/v3\/keys\/current\/[0-9a-f]{32}\/live$/.test(new URL(url).pathname)) {
        const delivery = await response.json();
        const signature = Buffer.from(delivery.Epoch.Record.Signature, 'base64');
        signature[0] ^= 1;
        delivery.Epoch.Record.Signature = signature.toString('base64');
        statusProbe.tampered++;
        return Response.json(delivery);
      }
    }
    if (tamperVoiceKey && response.ok && options.method === 'GET' && /^\/api\/v3\/voice\/[0-9a-f]{32}\/key$/.test(new URL(url).pathname)) {
      const delivery = await response.json();
      const ciphertext = Buffer.from(delivery.ciphertext, 'base64');
      ciphertext[ciphertext.length - 1] ^= 1;
      delivery.ciphertext = ciphertext.toString('base64');
      return Response.json(delivery);
    }
    return response;
  });
  let tamperProof = false;
  let publishedOffers = 0;
  let dropConfirmationReceipt = false;
  let firstConfirmationBody;
  let transferCommitted = false;
  let firstAcceptanceBody;
  let firstAcceptanceReceipt;
  const recoveryCodes = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
  const guest = createClient(async (url, options) => {
    const pathname = new URL(url).pathname;
    if (!transferCommitted) assert.notEqual(pathname, '/api/v3/policy/proofs', 'guest must use scoped policy evidence');
    if (/\/api\/v3\/recovery\/(?:enroll|confirm)$/.test(url)) {
      assert.ok(recoveryCodes.every(code => !options.body.includes(code)), 'recovery code must stay on the device');
    }
    if (options.method === 'PUT' && url.endsWith('/key')) publishedOffers++;
    const acceptsOwnership = ownerTransfer && pathname === '/api/v3/ownership/accept';
    if (acceptsOwnership && firstAcceptanceBody !== undefined) {
      assert.equal(options.body, firstAcceptanceBody, 'retry must reuse the accepted device signature and operation');
    }
    const response = await fetcher(url, options);
    if (acceptsOwnership && response.ok) {
      transferCommitted = true;
      if (firstAcceptanceBody === undefined) {
        firstAcceptanceBody = options.body;
        firstAcceptanceReceipt = await response.json();
        throw new Error('synthetic committed owner acceptance response loss');
      }
    }
    if (url.endsWith('/api/v3/recovery/confirm') && response.ok) {
      if (dropConfirmationReceipt) {
        firstConfirmationBody = options.body;
        await response.body?.cancel();
        throw new Error('synthetic committed recovery confirmation response loss');
      }
      if (firstConfirmationBody !== undefined) {
        assert.ok(options.body === firstConfirmationBody, 'an exact retry is required after the accepted confirmation');
      }
    }
    if (!tamperProof || !url.endsWith('/key/claim') || !response.ok) return response;
    const claim = await response.json();
    const evidence = claim.policy.recipients[0];
    evidence.salt = (evidence.salt.startsWith('0') ? '1' : '0') + evidence.salt.slice(1);
    return new Response(JSON.stringify(claim), { status: response.status });
  });
  const handshake = await host.prepareProtectedSelfHost('Synthetic host', 'Synthetic PC');
  const child = spawn(path.resolve(api), ['selfhost'], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.on('error', () => {});
  try {
    const { fingerprint, protectedBootstrap } = await childReady(child, {
      Port: port, MediaPort: port+3, Key: key, Secret: secret, Name: 'Protected loopback test', Addresses: ['127.0.0.1'],
      MediaExecutable: path.resolve(media), MediaConfig: configPath, Protected: handshake.input,
    }, handshake);
    const address = `pawtalk://127.0.0.1:${port}/${fingerprint}`;
    await handshake.register(address, protectedBootstrap);
    const { serverId } = protectedBootstrap.trust;
    const owner = await host.openStoredProtectedRuntime(serverId);
    await assert.rejects(host.verified(address, serverId), { code: 'PROTECTED_PROTOCOL_REQUIRED' });
    const original = await host.readProtectedRuntimeState(owner);
    assert.equal(original.canManageChannels, true);
    assert.equal(original.channels.length, 2);
    const channelId = original.channels.find(channel => channel.kind === 'text').id;
    if (process.argv.includes(communityAvatarFlag)) {
      await checkCommunityAvatar(host, owner, guest, () => createClient(fetcher));
      return;
    }
    if (process.argv.includes(avatarRecoveryFlag)) {
      await checkCommunityAvatarRecovery(host, owner, () => createClient(fetcher));
      return;
    }
    if (textProtectionStatus) {
      await checkTextProtectionStatus(host, owner, guest, channelId, statusProbe);
      return;
    }
    await host.serviceProtectedRuntimeRotations(owner);
    await host.serviceProtectedRuntimeRotations(owner);
    if (process.argv.includes(roleAssignmentOfflineFlag)) {
      await checkProtectedRoleAssignmentOffline({ fetcher, createClient, retryAfterFixtureQuota, host, owner, source: channelId });
      return;
    }
    if (process.argv.includes(channelLifecycleFlag)) {
      await checkProtectedChannelLifecycle(fetcher, createClient, host, owner, channelId);
      return;
    }
    if (process.argv.includes(attachmentScopeFlag)) {
      await checkProtectedAttachmentScope({ fetcher, createClient, retryAfterFixtureQuota, host, owner, recordingChannel: channelId });
      return;
    }
    if (process.argv.includes(pinScopeFlag)) {
      await checkProtectedPinScope({ fetcher, createClient, host, owner, channelId });
      return;
    }
    if (process.argv.includes(pollPublicationFlag)) {
      await checkProtectedPollPublication(fetcher, createClient, host, owner, channelId);
      return;
    }
    if (process.argv.includes(bulkChannelReadinessFlag)) {
      await checkBulkChannelReadiness(fetcher, host, owner, channelId);
      return;
    }
    const prefixInvite = process.argv.includes(scopedInvitePrefixOfflineFlag);
    const batchInvite = prefixInvite || process.argv.includes(scopedInviteBatchOfflineFlag);
    const fullHistoryInvite = batchInvite || process.argv.includes(scopedInviteFullOfflineFlag);
    if (fullHistoryInvite || process.argv.includes(scopedInviteOfflineFlag)) {
      await checkScopedInviteOffline(fetcher, host, owner, channelId, { fullHistory: fullHistoryInvite, batch: batchInvite, prefix: prefixInvite });
      return;
    }
    if (process.argv.includes(protectedEventsFlag)) {
      await checkProtectedEvents(host, owner, guest, channelId);
      return;
    }
    if (process.argv.includes(mentionScopeFlag)) {
      await checkProtectedMentions(fetcher, host, owner, guest, channelId);
      return;
    }
    if (process.argv.includes(recoveryReplacementFlag)) {
      await checkRecoveryReplacement(fetcher, host, owner, channelId, recoveryCodes);
      return;
    }
    if (voiceProtectionStatus) {
      const voiceChannel = original.channels.find(channel => channel.kind === 'voice').id;
      await checkVoiceProtectionStatus(host, owner, guest, voiceChannel, value => { tamperVoiceKey = value; });
      return;
    }
    if (process.argv.includes('--voice-move')) {
      const voiceChannel = original.channels.find(channel => channel.kind === 'voice').id;
      await checkVoiceMove(host, owner, guest, voiceChannel);
      return;
    }
    if (scopedSettings) {
      await checkScopedChannelSettings(fetcher, host, owner, channelId, original.channels.find(channel => channel.kind === 'voice').id);
      return;
    }
    const roleDenyOffline = process.argv.includes(roleDenyOfflineFlag);
    if (roleDenyOffline || process.argv.includes('--scoped-channel-acl')) {
      await checkScopedChannelACL(fetcher, host, owner, channelId, roleDenyOffline);
      return;
    }
    const revisionRoleDeny = process.argv.includes(revisionRoleDenyOfflineFlag);
    const revisionAudienceOffline = revisionRoleDeny || process.argv.includes(revisionAudienceOfflineFlag);
    if (revisionAudienceOffline || process.argv.includes(revisionAudienceFlag)) {
      await checkScopedRevisionAudience(fetcher, host, owner, channelId, { offline: revisionAudienceOffline, roleDeny: revisionRoleDeny });
      return;
    }
    const liveOnlyArchiveTarget = process.argv.includes('--scoped-archive-live-only-deny-offline');
    const archiveRecovery = process.argv.includes(archiveRecoveryFlag);
    const archiveRoleDeny = process.argv.includes(archiveRoleDenyFlag);
    const archivePersonalOffline = archiveRecovery || liveOnlyArchiveTarget || process.argv.includes('--scoped-archive-personal-deny-offline');
    const archivePersonalDeny = archivePersonalOffline || process.argv.includes('--scoped-archive-personal-deny');
    if (archiveRoleDeny || archivePersonalDeny || process.argv.includes('--scoped-archive-rotation')) {
      await checkScopedArchiveRotation(fetcher, host, owner, channelId, { testPersonalDeny: archivePersonalDeny,
        testRoleDeny: archiveRoleDeny, offline: archiveRoleDeny || archivePersonalOffline,
        liveOnlyTarget: liveOnlyArchiveTarget, useRecovery: archiveRecovery });
      return;
    }
    const offlinePersonalACL = process.argv.includes('--scoped-personal-acl-offline');
    if (offlinePersonalACL || process.argv.includes('--scoped-personal-acl')) {
      await checkScopedPersonalACL(fetcher, host, owner, channelId, recoveryCodes[0], offlinePersonalACL);
      return;
    }
    if (process.argv.includes('--policy-administrator')) {
      let measuring = false;
      const requests = [];
      const policyOffsets = [];
      const measuredGuest = createClient(async (url, options) => {
        if (measuring) {
          const request = new URL(url);
          requests.push(request.pathname);
          if (request.pathname === '/api/v3/policy/proofs') policyOffsets.push(request.searchParams.get('after'));
          await delay(45);
        }
        return fetcher(url, options);
      });
      await checkPolicyAdministrator(host, owner, measuredGuest, guest, channelId, recoveryCodes[0], async operation => {
        requests.length = 0;
        policyOffsets.length = 0;
        measuring = true;
        const start = performance.now();
        try { return { result: await operation(), elapsed: Math.round(performance.now() - start), requests: [...requests], policyOffsets: [...policyOffsets] }; }
        finally { measuring = false; }
      });
      return;
    }
    if (process.argv.includes(bulkAdministratorFlag)) {
      await checkBulkAdministrator(host, owner, guest, createClient(fetcher), recoveryCodes);
      return;
    }
    if (messageRetry) {
      messageOperation = randomBytes(16).toString('hex');
      await checkProtectedMessageRetry(host, owner, guest, channelId, messageOperation, messageAttempts);
      return;
    }
    if (scopeDeviceDetach) {
      await checkScopeDeviceDetach(fetcher, host, owner, guest, channelId, recoveryCodes[0]);
      return;
    }
    const text = 'Synthetic protected selfhost text';
    await host.withCurrentProtectedChatPolicy(owner,
      options => host.sendProtectedRuntimeText(owner, channelId, text, randomBytes(16).toString('hex'), options));
    const page = await host.readProtectedChatPage(owner, channelId, 0);
    assert.ok(page.messages.some(message => message.text === text));
    if (deviceBinding) {
      await checkDeviceBinding(host, owner, createClient(fetcher), channelId, text);
      return;
    }
    if (profileLinking) {
      await checkProfileLinking(fetcher, host, owner, channelId);
      return;
    }
    if (scopeDeviceHandover) {
      await checkScopeDeviceHandover(fetcher, host, owner, guest, channelId);
      return;
    }
    if (ownerRecovery) {
      const bundle = host.prepareRecoveryBundle(owner);
      await host.confirmRecoveryBundle(owner, bundle);
      let recoveryTargetBatches = 0;
      let omitAuthority = true;
      const replacement = createClient(async (url, options) => {
        if (url.includes('/recovery-targets')) recoveryTargetBatches++;
        if (omitAuthority && url.endsWith('/api/v3/recovery/device')) {
          const { scopeAuthority, ...proposal } = JSON.parse(options.body);
          assert.equal(scopeAuthority?.action, 'recovery.device');
          return fetcher(url, { ...options, body: JSON.stringify(proposal) });
        }
        return fetcher(url, options);
      });
      await assert.rejects(replacement.recoverProtectedDeviceFromBundle(bundle), { code: 'RECOVERY_DEVICE_CHANGED' });
      assert.equal((await host.readProtectedRuntimeState(owner)).profileId, owner.profileId);
      omitAuthority = false;
      const recovered = await replacement.recoverProtectedDeviceFromBundle(bundle);
      assert.equal(recovered.profileId, owner.profileId);
      assert.notEqual(recovered.deviceId, owner.deviceId);
      assert.equal((await replacement.readProtectedRuntimeState(recovered)).canManageChannels, true);
      for (let pass = 0; pass < 2; pass++) await replacement.serviceProtectedRuntimeRotations(recovered);
      const recoveredPage = await replacement.readProtectedChatPage(recovered, channelId, 0);
      assert.ok(recoveredPage.messages.some(message => message.text === text));
      assert.ok(recoveryTargetBatches > 0, 'new sole owner used recovery packages to rotate the archive');
      console.log('PASS sole-owner recovery restores archive history on the replacement device');
      const { link } = await replacement.createProtectedInvite(recovered);
      assert.equal((await guest.redeemProtectedInvite(link, 'Synthetic guest')).keysPending, true);
      const visitor = await guest.openStoredProtectedRuntime(serverId);
      for (let pass = 0; pass < 2; pass++) await replacement.serviceProtectedRuntimeRotations(recovered);
      const attestation = await guest.readProtectedPolicyAttestation(visitor);
      assert.equal(attestation.signerDeviceId, recovered.deviceId);
      assert.equal(visitor.policyTrust.ownerDeviceId, owner.deviceId);
      const opened = await guest.loadProtectedRuntimeKey(visitor, channelId, 'archive', { policyTrust: visitor.policyTrust });
      try { assert.equal(opened.record.Purpose, 'archive'); }
      finally { opened.secret.fill(0); }
      console.log('PASS a scoped guest verifies the replacement owner and opens an authorized archive key');
      return;
    }
    const { link } = await host.createProtectedInvite(owner);
    assert.equal((await guest.redeemProtectedInvite(link, 'Synthetic guest')).keysPending, true);
    const visitor = await guest.openStoredProtectedRuntime(serverId);
    assert.equal((await guest.readProtectedRuntimeState(visitor)).canManageChannels, false);
    await host.serviceProtectedRuntimeRotations(owner);
    await host.serviceProtectedRuntimeRotations(owner);
    const joined = await guest.readProtectedChatPage(visitor, channelId, 0);
    assert.ok(joined.messages.some(message => message.text === text));
    if (process.env.PAWTALK_CHECK_REJOIN === '1') {
      const observer = createClient(fetcher);
      await observer.redeemProtectedInvite((await host.createProtectedInvite(owner)).link, 'Synthetic observer');
      const watching = await observer.openStoredProtectedRuntime(serverId);
      for (let pass = 0; pass < 3; pass++) await host.serviceProtectedRuntimeRotations(owner);
      await guest.withCurrentProtectedChatPolicy(visitor, options =>
        guest.sendProtectedRuntimeText(visitor, channelId, 'Before leaving', randomBytes(16).toString('hex'), options));
      await guest.leave(serverId, { protectedConnection: visitor });
      await assert.rejects(observer.rotateProtectedRuntimeText(watching, channelId, 'live'), { code: 'POLICY_ATTESTATION_UNAVAILABLE' });
      await host.syncProtectedPolicyAttestations(owner);
      await host.rotateProtectedRuntimeText(owner, channelId, 'live');
      // A previously privileged client may still have a verified full-policy
      // checkpoint from before readmission. It must use scoped reads now.
      const fetchOwnerPolicy = after => host.fetchProtectedRuntimePolicyPage(owner, after);
      await guest.policyCheckpoint().accept(await fetchOwnerPolicy(0), owner.policyTrust, fetchOwnerPolicy);
      const fresh = await host.createProtectedInvite(owner);
      await guest.redeemProtectedInvite(fresh.link, 'Synthetic guest');
      const rejoined = await guest.openStoredProtectedRuntime(serverId);
      await host.serviceProtectedRuntimeRotations(owner);
      const state = await guest.readProtectedRuntimeState(rejoined);
      assert.equal(state.channels.find(channel => channel.id === channelId)?.keysPending, undefined);
      const history = await guest.readProtectedChatPage(rejoined, channelId, 0);
      assert.ok(history.messages.some(message => message.text === text));
      console.log('PASS protected chat after leaving and rejoining on the same client');
      return;
    }
    if (ownerTransfer) {
      await checkOwnerTransfer(host, owner, guest, visitor, recoveryCodes[0], () => firstAcceptanceReceipt, ownerTransferRecovery ? fetcher : null);
      return;
    }
    if (deviceRecovery) {
      await checkDeviceRecovery(fetcher, host, owner, guest, visitor, { address, fingerprint }, recoveryCodes);
      return;
    }
    if (!recoveryOpening) {
      const voiceChannelId = original.channels.find(channel => channel.kind === 'voice').id;
      const rejoin = process.argv.includes('--voice-deafen-rejoin');
      const sustained = rejoin || process.argv.includes('--voice-deafen-sustained');
      const changeCapacity = process.env.PAWTALK_TEST_VOICE_CAPACITY === '1';
      const moderate = process.argv.includes('--voice-moderation');
      const keysOnly = moderate && process.env.PAWTALK_TEST_VOICE_KEY_CONTINUITY_ONLY === '1';
      await checkMedia(host, owner, guest, visitor, voiceChannelId, async channel => {
        tamperProof = true;
        try {
          await assert.rejects(guest.exchangeProtectedRuntimeVoiceKey(visitor, channel, visitor.policyTrust),
            { code: 'UNVERIFIED_VOICE_ROSTER' });
          assert.equal(publishedOffers, 0);
        } finally {
          tamperProof = false;
        }
      }, { moderate, sustained, rejoin, changeCapacity, keysOnly, banActive: process.argv.includes(voiceBanActiveFlag) });
      if (!sustained && !changeCapacity && !keysOnly) console.log('PASS protected selfhost over pinned TLS: owner anchor, live/archived text, invite, API 2 rejection and bidirectional encrypted owner/guest audio');
      return;
    }
    const initialCoverage = await guest.readProtectedRecoveryCoverage(visitor);
    assert.equal(initialCoverage.recoveryId, '');
    assert.deepEqual(initialCoverage.items, []);
    const firstRecovery = await guest.enrollProtectedRuntimeRecovery(visitor, recoveryCodes[0]);
    const nextRecovery = await guest.enrollProtectedRuntimeRecovery(visitor, recoveryCodes[1]);
    assert.equal(firstRecovery.ready, false);
    assert.equal(nextRecovery.ready, false);
    assert.notEqual(firstRecovery.recoveryId, nextRecovery.recoveryId);
    assert.equal(nextRecovery.revision, firstRecovery.revision + 1);
    const { snapshot, revision } = await host.readProtectedOwnerPolicy(owner);
    assert.equal(revision, nextRecovery.revision);
    assert.equal(snapshot.RecoveryIdentities[visitor.profileId].ID, nextRecovery.recoveryId);
    assert.equal(snapshot.KeyRecipients[firstRecovery.recoveryId], undefined);
    assert.equal(snapshot.KeyRecipients[nextRecovery.recoveryId].Kind, 'recovery');
    assert.ok(!snapshot.RecoveryReady?.[visitor.profileId]);
    console.log('PASS protected recovery enrollment and replacement with independently replayed proofs');
    await checkRecoveryPackages(host, owner, guest, visitor, recoveryCodes[1], recoveryCodes[0], nextRecovery.recoveryId, channelId);
    const afterRecoveryRotation = await guest.readProtectedChatPage(visitor, channelId, 0);
    assert.ok(afterRecoveryRotation.messages.some(message => message.text === text));
    console.log('PASS both committed recovery packages open and produce independently verified signatures');
    const roleId = randomBytes(16).toString('hex');
    const administrator = { Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
      Roles: { ...snapshot.Roles, [roleId]: { Grants: ['server.administrator'] } },
      Order: [roleId, ...(snapshot.Order ?? [])],
      Assignments: { [visitor.profileId]: [roleId] },
    } };
    await assert.rejects(host.previewProtectedRuntimePolicy(owner, administrator, owner.policyTrust),
      { code: 'PROTECTED_RECOVERY_REQUIRED', details: { recoveryProfiles: [visitor.profileId] } });
    dropConfirmationReceipt = true;
    await assert.rejects(guest.confirmProtectedRuntimeRecovery(visitor, recoveryCodes[1]), /synthetic committed recovery confirmation response loss/);
    dropConfirmationReceipt = false;
    const confirmed = await guest.confirmProtectedRuntimeRecovery(visitor, recoveryCodes[1]);
    assert.equal(confirmed.ready, true);
    assert.equal(confirmed.recoveryId, nextRecovery.recoveryId);
    const ready = await host.readProtectedOwnerPolicy(owner);
    assert.equal(ready.revision, confirmed.revision);
    assert.equal(ready.snapshot.RecoveryReady[visitor.profileId], true);
    const preview = await host.previewProtectedRuntimePolicy(owner, administrator, owner.policyTrust);
    await host.commitProtectedRuntimePolicy(owner, { preview, intent: administrator,
      expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
    const promoted = await host.readProtectedOwnerPolicy(owner);
    assert.deepEqual(promoted.snapshot.Members[visitor.profileId].Roles, [roleId]);
    console.log('PASS recovery readiness is signed, retries exactly, and enables administrator assignment');
  } finally {
    handshake.clear();
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
  }
}

async function checkVoiceMove(host, owner, guest, source) {
  const serverId = owner.serverId, destination = randomBytes(16).toString('hex');
  const intent = { Action: 'channel.create', OperationID: randomBytes(16).toString('hex'), ResourceChange: {
    ID: destination, Channel: { Kind: 'voice', Settings: { Name: 'Synthetic listening room', Description: '', SlowmodeSeconds: 0, VoiceCapacity: 0 } },
    ACL: { Roles: { '@everyone': { Allow: null, Deny: ['voice.speak'] } }, Profiles: null },
  } };
  const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
  await host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
  const { link } = await host.createProtectedInvite(owner);
  await guest.redeemProtectedInvite(link, 'Synthetic moved listener');
  for (let pass = 0; pass < 2; pass++) await host.serviceProtectedRuntimeRotations(owner);

  const gateway = new VoiceSignal();
  let invoke;
  const service = registerMembershipIPC({ ipcMain: { handle(name, handler) { assert.equal(name, 'membership'); invoke = handler; } },
    authorized(event) { assert.equal(event.syntheticVoiceMove, true); }, client: guest, links: {}, send() {}, getWindow() {},
    setVoiceEndpoint(url, fingerprint) { if (url) return gateway.open(url, fingerprint); gateway.close(); },
  });
  const ipc = async (action, input) => {
    const result = await invoke({ syntheticVoiceMove: true }, action, input);
    if (result.error) throw Object.assign(new Error(result.error.code), result.error);
    return result.value;
  };
  const window = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, backgroundThrottling: false, partition: 'pawtalk-native-voice-move',
  } });
  const call = (method, value) => runPeer(window, ({ method, value }) => globalThis.protectedVoiceStatusFixture[method](value), { method, value });
  const until = async (predicate, label) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const value = await call('read');
      if (predicate(value)) return value;
      await delay(30);
    }
    assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(await call('read'))}`);
  };
  const scope = { serverId, channelId: source };
  try {
    const { profileId } = await ipc('connect', { serverId });
    const request = { serverId, profileId, sourceChannelId: source, destinationChannelId: destination };
    await window.loadURL(`${process.env.PAWTALK_UI_TEST_URL}/tests/protected-voice-status.html`);
    await call('begin', { ...scope, move: true });
    const incoming = await ipc('voice.protected.join', scope);
    await call('grant', incoming);
    const status = await runPeer(window, async () => ({ joined: await globalThis.protectedVoiceStatusFixture.joined() }));
    assert.deepEqual(status, { joined: true });
    await call('setLocalAudio', { muted: true, ptt: true });
    const before = await until(value => value.states.at(-1)?.state === 'green', 'verified source');
    assert.equal(before.canPublish, true);
    assert.equal(before.muted, true);
    assert.equal(before.ptt, true);
    const { sub: sessionId } = JSON.parse(Buffer.from(incoming.token.split('.')[1], 'base64url'));
    const scopedRequest = { serverId, sourceChannelId: source, targetSessionId: sessionId };
    const ownChoices = await ipc('voice.protected.move-choices', scopedRequest);
    const moderatorChoices = await host.protectedRuntimeVoiceMoveChoices(owner, source, sessionId);
    assert.deepEqual(ownChoices, [destination]);
    assert.deepEqual(moderatorChoices, [destination]);
    assert.deepEqual(await host.protectedRuntimeVoiceMoveChoices(owner, source, randomBytes(16).toString('hex')), []);
    await assert.rejects(ipc('voice.protected.move', request), { code: 'VOICE_ACCESS_DENIED' });
    await ipc('voice.protected.move', { ...scopedRequest, destinationChannelId: destination });
    await until(value => value.reconnect, 'source media removal');
    const moved = await ipc('voice.protected.reconnect', scope);
    assert.equal(moved.channelId, destination);
    assert.notEqual(moved.epoch.epochId, incoming.epoch.epochId);
    assert.notEqual(moved.token, incoming.token);
    assert.notEqual(moved.key, incoming.key);
    await call('resumeMove', moved);
    const after = await until(value => value.movedChannel === destination && value.states.at(-1)?.state === 'green', 'verified destination');
    assert.equal(after.states.at(-1).channelId, destination);
    assert.equal(after.canSubscribe, true);
    assert.equal(after.canPublish, false);
    assert.equal(after.microphone, false);
    assert.equal(after.muted, true);
    assert.equal(after.ptt, true);
    assert.ok(after.mediaStates.slice(before.mediaStates.length).includes('reconnecting'));
    assert.ok(!after.mediaStates.slice(before.mediaStates.length).includes('disconnected'), 'renderer must not release an in-flight move');
    await assert.rejects(ipc('voice.protected.refresh', { ...scope, epochId: moved.epoch.epochId }), { code: 'VOICE_NOT_PREPARED' });
    console.log('PASS protected VoiceSession moves to an encrypted listen-only destination with a new grant and preserves local mute/PTT');
  } finally {
    await ipc('voiceLeave').catch(() => {});
    window.destroy();
    gateway.close();
    service.stop();
  }
}

async function checkVoiceProtectionStatus(host, owner, guest, channelId, setTamper) {
  const gateway = new VoiceSignal();
  const window = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, backgroundThrottling: false,
    partition: 'pawtalk-native-voice-protection',
  } });
  const call = (method, value) => runPeer(window, ({ method, value }) => globalThis.protectedVoiceStatusFixture[method](value), { method, value });
  const waitFor = async (read, description) => {
    const deadline = Date.now() + 15_000;
    do {
      const result = await read();
      if (result) return result;
      await delay(30);
    } while (Date.now() < deadline);
    assert.fail(`Timed out waiting for ${description}: ${JSON.stringify(await call('read'))}`);
  };
  const waitForState = (expected, after = 0) => waitFor(async () => {
    const current = await call('read');
    return current.states.length > after && current.states.at(-1)?.state === expected ? current : undefined;
  }, `${expected} voice protection`);
  const checkWorkerPending = async () => {
    const current = await waitFor(async () => {
      const reading = await call('read');
      return reading.pendingWorkerMessages ? reading : undefined;
    }, 'held voice worker challenge');
    assert.equal(current.connection, 'connected');
    assert.equal(current.encrypted, true);
    await waitForState('yellow');
  };
  const scope = { serverId: owner.serverId, channelId };
  let visitor;
  try {
    await window.loadURL(`${process.env.PAWTALK_UI_TEST_URL}/tests/protected-voice-status.html`);
    await waitFor(() => window.webContents.executeJavaScript('Boolean(window.protectedVoiceStatusFixture)'), 'VoiceSession fixture');
    await call('begin', scope);
    const pending = await waitForState('yellow');
    assert.equal(pending.encrypted, false);
    assert.equal(pending.states.some(status => status?.state === 'green'), false);
    const access = await host.joinProtectedRuntimeVoice(owner, channelId, owner.policyTrust);
    const endpoint = await gateway.open(access.url, owner.fingerprint);
    await call('holdWorkerProof');
    await call('grant', { ...access, url: endpoint });
    await checkWorkerPending();
    await call('releaseWorkerProof');
    assert.equal(await call('joined'), true);
    let verified = await waitForState('green');
    assert.equal(verified.connection, 'connected');
    assert.equal(verified.encrypted, true);
    assert.deepEqual({ serverId: verified.states.at(-1).serverId, channelId: verified.states.at(-1).channelId }, scope);

    await call('shareScreen');
    const beforeScreen = await call('read');
    assert.ok(beforeScreen.screenPublications.every(Boolean));
    assert.equal(beforeScreen.screenTracks.length, 2);
    assert.ok(beforeScreen.screenTracks.every(track => track.enabled && track.state === 'live'));

    const { link } = await host.createProtectedInvite(owner);
    await guest.redeemProtectedInvite(link, 'Synthetic roster successor');
    visitor = await guest.openStoredProtectedRuntime(owner.serverId);
    await guest.prepareProtectedRuntimeVoice(visitor, channelId);
    const next = await host.refreshProtectedRuntimeVoiceKey(owner, channelId, owner.policyTrust, access.epoch.epochId);
    assert.ok(next && next.epochId !== access.epoch.epochId, 'new signed roster must change the voice epoch');
    const previousStates = verified.states.length;
    await call('holdWorkerProof');
    await call('rotate', next);
    await checkWorkerPending();
    const pausedScreen = await call('read');
    assert.deepEqual(pausedScreen.screenPublications, beforeScreen.screenPublications);
    assert.ok(pausedScreen.screenTracks.every(track => !track.enabled && track.state === 'live'));
    await call('releaseWorkerProof');
    verified = await waitForState('green', previousStates);
    assert.ok(verified.states.slice(previousStates, -1).some(status => status?.state === 'yellow'));
    assert.equal(verified.encrypted, true);
    assert.deepEqual(verified.screenPublications, beforeScreen.screenPublications);
    assert.ok(verified.screenTracks.every(track => track.enabled && track.state === 'live'));
    console.log('PASS protected screen video and audio pause until worker proof, then resume with the same publications');
    console.log('PASS VoiceSession reports yellow while joining and rotating, and green with the real LiveKit E2EE worker');

    let proofError;
    setTamper(true);
    try {
      await assert.rejects(host.exchangeProtectedRuntimeVoiceKey(owner, channelId, owner.policyTrust), error => {
        assert.equal(error.code, 'INVALID_PROTECTED_VOICE_KEY');
        proofError = error.code;
        return true;
      });
    } finally { setTamper(false); }
    await call('rejectRefresh', proofError);
    const failed = await waitForState('red');
    assert.equal(failed.states.at(-1).reason, 'VOICE_KEY_INVALID');
    await waitFor(async () => {
      const current = await call('read');
      return current.screenTracks.every(track => track.state === 'ended') && !current.screenPublications.some(Boolean);
    }, 'screen capture teardown after failed voice key proof');
    await call('disconnect');
    await waitForState('red');
    console.log('PASS VoiceSession stops after a confirmed key failure and retains red through disconnect');
  } finally {
    await call('disconnect').catch(() => {});
    window.destroy();
    gateway.close();
    await Promise.allSettled([host.leaveProtectedRuntimeVoice(owner), visitor && guest.leaveProtectedRuntimeVoice(visitor)]);
  }
}

async function checkCommunityAvatarRecovery(host, owner, makeClient) {
  for (let pass = 0; pass < 2; pass++) await host.serviceProtectedRuntimeRotations(owner);
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5e8AAAAASUVORK5CYII=';
  await host.saveProtectedCommunityAvatar(owner, avatar, 1);
  assert.equal((await host.readProtectedRuntimeState(owner)).communityAvatar.avatar, avatar);
  const bundle = host.prepareRecoveryBundle(owner);
  await host.confirmRecoveryBundle(owner, bundle);
  const recoveryView = await host.fetchJSON(owner.base, '/api/v3/community/avatar/recovery', {
    fingerprint: owner.fingerprint, headers: { Authorization: `Bearer ${owner.token}` },
  });
  assert.equal(recoveryView.revision, 2);
  assert.ok(recoveryView.package?.id);
  assert.notEqual(recoveryView.package.id, owner.deviceId);

  const replacement = makeClient();
  const recovered = await replacement.recoverProtectedDeviceFromBundle(bundle);
  assert.equal(recovered.profileId, owner.profileId);
  assert.notEqual(recovered.deviceId, owner.deviceId);
  assert.deepEqual((await replacement.readProtectedRuntimeState(recovered)).communityAvatar, { revision: 2, avatar, pending: false });
  await assert.rejects(host.readProtectedCommunityAvatar(owner), { code: 'INVALID_PROTECTED_SESSION' });
  await assert.rejects(replacement.fetchJSON(recovered.base, '/api/v3/community/avatar/recovery', {
    method: 'PUT', fingerprint: recovered.fingerprint, headers: { Authorization: `Bearer ${recovered.token}` },
    body: JSON.stringify({ revision: 2, policyHead: recoveryView.policyHead, packages: [recoveryView.package] }),
  }), { code: 'PROTECTED_ACCESS_DENIED' });
  console.log('PASS sole-owner recovery restores the avatar to the replacement device');
}

async function checkCommunityAvatar(host, owner, guest, makeClient) {
  const { link } = await host.createProtectedInvite(owner);
  await guest.redeemProtectedInvite(link, 'Synthetic avatar member');
  const member = await guest.openStoredProtectedRuntime(owner.serverId);
  for (let pass = 0; pass < 2; pass++) await host.serviceProtectedRuntimeRotations(owner);
  assert.deepEqual(await guest.readProtectedCommunityAvatar(member), { revision: 1, pending: false });
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5e8AAAAASUVORK5CYII=';
  assert.deepEqual(await host.saveProtectedCommunityAvatar(owner, avatar, 1), { revision: 2, avatar });
  assert.deepEqual(await guest.readProtectedCommunityAvatar(member), { revision: 2, pending: false, avatar });
  assert.equal((await guest.readProtectedRuntimeState(member)).communityAvatar.avatar, avatar);
  await assert.rejects(guest.saveProtectedCommunityAvatar(member, null, 2), { code: 'PROTECTED_ACCESS_DENIED' });
  await assert.rejects(host.saveProtectedCommunityAvatar(owner, null, 1), { code: 'SERVER_AVATAR_CHANGED' });
  await host.saveProtectedCommunityAvatar(owner, null, 2);
  assert.deepEqual(await guest.readProtectedCommunityAvatar(member), { revision: 3, pending: false });
  console.log('PASS protected avatar checks signed device keys and opens only recipient ciphertext over pinned TLS');

  const { snapshot } = await host.readProtectedOwnerPolicy(owner);
  const role = randomBytes(16).toString('hex');
  const intent = { Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
    Roles: { ...snapshot.Roles, [role]: { Grants: ['member.list', 'server.edit'] } }, Order: [role, ...(snapshot.Order ?? [])],
    Assignments: { [member.profileId]: [role] },
  } };
  const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
  await host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
  await host.serviceProtectedRuntimeRotations(owner);
  const channelId = (await host.readProtectedRuntimeState(owner)).channels.find(channel => channel.kind === 'text').id;
  let invoke;
  const events = [];
  const service = registerMembershipIPC({ ipcMain: { handle(_name, handler) { invoke = handler; } },
    authorized: () => {}, client: host, links: {}, send(kind, event) {
      if (kind === 'membership-protected-event') events.push(event.type);
    }, getWindow() {} });
  const ipc = async (action, input) => {
    const result = await invoke({}, action, { serverId: owner.serverId, ...input });
    if (result.error) throw new Error(result.error.code);
    return result.value;
  };
  const rosterAvatar = async () => (await ipc('roster.protected.read', { channelId })).members.find(profile => profile.id === member.profileId)?.avatar;
  const waitForEvent = async (type, from = 0) => {
    for (let attempt = 0; attempt < 120 && !events.includes(type, from); attempt++) await delay(30);
    assert.ok(events.includes(type, from), `Expected live ${type} event`);
  };
  try {
    await ipc('connect');
    await waitForEvent('resync');
    assert.equal(await rosterAvatar(), undefined);
    const beforeSave = events.length;
    assert.deepEqual(await guest.saveProtectedProfileAvatar(member, avatar, 1), { revision: 2, pending: false, avatar });
    await waitForEvent('state', beforeSave);
    assert.equal(await rosterAvatar(), avatar, 'The owner receives a member avatar without reconnecting');
    const beforeClear = events.length;
    await guest.saveProtectedProfileAvatar(member, null, 2);
    await waitForEvent('state', beforeClear);
    assert.equal(await rosterAvatar(), undefined, 'The owner receives the avatar removal without reconnecting');
    console.log('PASS a connected owner receives member avatar changes over live roster invalidation');
  } finally {
    service.stop();
  }
  assert.deepEqual(await guest.saveProtectedCommunityAvatar(member, avatar, 3), { revision: 4, avatar });
  // The delegated publishing Client does no further work after this point.
  assert.equal((await host.readProtectedRuntimeState(owner)).communityAvatar.avatar, avatar);
  const lateClient = makeClient();
  const later = await host.createProtectedInvite(owner);
  await lateClient.redeemProtectedInvite(later.link, 'Synthetic late avatar member');
  const late = await lateClient.openStoredProtectedRuntime(owner.serverId);
  assert.deepEqual((await lateClient.readProtectedRuntimeState(late)).communityAvatar, { revision: 4, pending: true });
  assert.deepEqual(await lateClient.fetchJSON(late.base, '/api/v3/community/avatar/delivery', {
    fingerprint: late.fingerprint, headers: { Authorization: `Bearer ${late.token}` },
  }), { revision: 4 });
  await host.serviceProtectedRuntimeRotations(owner);
  assert.deepEqual((await lateClient.readProtectedRuntimeState(late)).communityAvatar, { revision: 4, pending: false, avatar });
  console.log('PASS another Client delivers the current avatar to a later member without the publishing Client');
}

async function checkTextProtectionStatus(host, owner, guest, channelId, probe) {
  const readStatus = offline => host.readProtectedTextStatus(owner.serverId, channelId, owner, offline);
  const green = { state: 'green', reason: 'CURRENT_VERIFIED', allowSend: true };
  const red = { state: 'red', reason: 'KEY_PROOF_INVALID', allowSend: false };
  const check = ({ deferredBasis, ...status }, expected) => {
    assert.deepEqual(status, expected);
    assert.ok(Number.isSafeInteger(deferredBasis?.revision));
    assert.match(deferredBasis.head, /^[0-9a-f]{64}$/);
    return deferredBasis;
  };
  check(await readStatus(), { state: 'yellow', reason: 'CURRENT_KEY_PENDING', allowSend: false });
  for (let pass = 0; pass < 2; pass++) await host.serviceProtectedRuntimeRotations(owner);
  check(await readStatus(), green);

  probe.tamper = true;
  try { assert.deepEqual(await readStatus(), red); }
  finally { probe.tamper = false; }
  assert.equal(probe.tampered, 1);
  const requests = probe.requests;
  assert.deepEqual(await readStatus(true), red);
  assert.equal(probe.requests, requests, 'offline status must use the known failure without another network request');
  check(await readStatus(), green);
  assert.deepEqual(await readStatus(true), { state: 'grey', reason: 'OFFLINE', allowSend: false });
  console.log('PASS text protection verifies live keys, retains a known proof failure offline, and clears it after re-verification');

  const { link } = await host.createProtectedInvite(owner);
  await guest.redeemProtectedInvite(link, 'Synthetic grace member');
  const visitor = await guest.openStoredProtectedRuntime(owner.serverId);
  for (let pass = 0; pass < 2; pass++) await host.serviceProtectedRuntimeRotations(owner);
  check(await guest.readProtectedTextStatus(owner.serverId, channelId, visitor), green);
  await host.changeProtectedMembership(owner, 'kick', visitor.profileId, { reason: 'Synthetic grace check' });
  check(await readStatus(), { state: 'yellow', reason: 'CURRENT_GRACE', allowSend: true });
  console.log('PASS removing a verified member leaves the remaining sender in the signed current-key grace window');

  // Let the real server deadline pass without servicing the rotation queue.
  const deadline = performance.now() + 65_000;
  let status = await readStatus();
  while (status.reason !== 'CUTOFF_EXPIRED' && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    status = await readStatus();
  }
  const queuedAt = check(status, { state: 'red', reason: 'CUTOFF_EXPIRED', allowSend: false });
  const operation = randomBytes(16).toString('hex');
  const send = () => host.withCurrentProtectedChatPolicy(owner, options =>
    host.sendProtectedRuntimeText(owner, channelId, 'Deferred protected message', operation, options,
      undefined, undefined, undefined, undefined, undefined, queuedAt));
  await assert.rejects(send(), { code: 'PROTECTED_KEY_PENDING' });
  for (let pass = 0; pass < 2; pass++) await host.serviceProtectedRuntimeRotations(owner);
  check(await readStatus(), green);
  const receipt = await send();
  assert.equal(receipt.Existing, false);
  assert.deepEqual(await send(), { Position: receipt.Position, Existing: true });
  assert.equal((await host.readProtectedChatReference(owner, channelId, receipt.Position)).text, 'Deferred protected message');
  console.log('PASS after the real cutoff the Client defers the send until a fresh verified key, then receives one durable receipt');
}

async function checkScopedChannelSettings(fetcher, host, owner, textChannel, voiceChannel) {
  let submitted, committed, alterReceiptEvidence = false, legacyReceiptEndpoint = false;
  const editor = createClient(async (url, options) => {
    const path = new URL(url).pathname;
    assert.notEqual(path, '/api/v3/policy/proofs', 'the editor must stay on scoped policy');
    if (legacyReceiptEndpoint && path === `/api/v3/policy/channel-settings/${voiceChannel}/edit`) {
      return new Response('404 page not found\n', { status: 404 });
    }
    const response = await fetcher(url, options);
    if (alterReceiptEvidence && path === `/api/v3/policy/channel-settings/${textChannel}/edit` && response.ok) {
      const evidence = await response.json();
      evidence.settings.Description = 'Synthetic changed receipt';
      return new Response(JSON.stringify(evidence), { status: 200 });
    }
    if (options.method === 'POST' && path === `/api/v3/policy/channel-settings/${textChannel}` && response.ok) {
      if (!submitted) {
        submitted = options.body;
        committed = await response.clone().json();
        throw new Error('synthetic committed settings response loss');
      }
      assert.equal(options.body, submitted);
      assert.deepEqual(await response.clone().json(), committed);
    }
    return response;
  });
  const { link } = await host.createProtectedInvite(owner);
  await editor.redeemProtectedInvite(link, 'Synthetic channel editor');
  const connection = await editor.openStoredProtectedRuntime(owner.serverId);
  const initial = (await host.readProtectedOwnerPolicy(owner)).snapshot;
  const editorRole = randomBytes(16).toString('hex');
  const intent = { Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
    Roles: { ...initial.Roles, [editorRole]: { Grants: ['channel.edit'] } },
    Order: [...(initial.Order ?? []), editorRole], Assignments: { [connection.profileId]: [editorRole] },
  } };
  const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
  await host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
  await host.syncProtectedPolicyAttestations(owner);
  const state = await editor.readProtectedRuntimeState(connection);
  assert.equal(state.canManageChannels, false);
  assert.ok(state.channels.every(channel => channel.canEditSettings));
  const before = (await host.readProtectedOwnerPolicy(owner)).snapshot;

  const patch = async (channel, changes) => {
    const scoped = await editor.readProtectedChannelSettings(connection, channel);
    const values = { ...scoped.settings, ...changes };
    const settings = { Name: values.name, Description: values.description,
      SlowmodeSeconds: values.slowmodeSeconds, VoiceCapacity: values.voiceCapacity };
    const save = () => editor.commitProtectedChannelSettings(connection, channel, scoped.policyHead, settings);
    if (channel === textChannel) {
      await assert.rejects(save(), /synthetic committed settings response loss/);
      alterReceiptEvidence = true;
      try { await assert.rejects(save(), { code: 'INVALID_PROTECTED_CHANNEL_SETTINGS_EDIT' }); }
      finally { alterReceiptEvidence = false; }
    } else {
      legacyReceiptEndpoint = true;
      try { assert.equal((await save()).confirmed, false, 'an older server still uses ordinary attested confirmation'); }
      finally { legacyReceiptEndpoint = false; }
    }
    const applied = await save();
    assert.equal(applied.revision, scoped.policyRevision + 1);
    assert.equal(applied.confirmed, true, 'scoped confirmation uses the signed predecessor while the owner is offline');
    await assert.rejects(editor.readProtectedChannelSettings(connection, channel), { code: 'POLICY_ATTESTATION_UNAVAILABLE' });
    await host.syncProtectedPolicyAttestations(owner);
    const updated = await editor.readProtectedChannelSettings(connection, channel);
    assert.equal(updated.policyRevision, applied.revision);
    assert.deepEqual(updated.settings, values);
    return settings;
  };
  const text = await patch(textChannel, { description: 'Проверенное описание', slowmodeSeconds: 4 });
  const voice = await patch(voiceChannel, { description: 'Scoped voice settings', voiceCapacity: 3 });
  before.Channels[textChannel].Settings = text;
  before.Channels[voiceChannel].Settings = voice;
  assert.deepEqual((await host.readProtectedOwnerPolicy(owner)).snapshot, before);
  console.log('PASS delegated settings confirm against scoped editor evidence without a new owner signature, retry exactly, and preserve policy');
}

async function checkBulkChannelReadiness(fetcher, host, owner, publicChannel) {
  const scoped = (url, options) => {
    assert.notEqual(new URL(url).pathname, '/api/v3/policy/proofs', 'ordinary recipients must stay on scoped policy');
    return fetcher(url, options);
  };
  const reader = createClient(scoped), revoked = createClient(scoped);
  const { link } = await host.createProtectedInvite(owner, { maxUses: 2 });
  await reader.redeemProtectedInvite(link, 'Multiple channel reader');
  await revoked.redeemProtectedInvite(link, 'Independent revocation target');
  const member = await reader.openStoredProtectedRuntime(owner.serverId);
  const removed = await revoked.openStoredProtectedRuntime(owner.serverId);
  const load = async (client, connection, channel) => {
    const { record, secret } = await client.loadProtectedRuntimeKey(connection, channel, 'live', { policyTrust: connection.policyTrust });
    secret.fill(0);
    return record.KeyID;
  };
  await host.syncProtectedPolicyAttestations(owner);
  const publicEpoch = await host.rotateProtectedRuntimeText(owner, publicChannel, 'live');
  assert.equal(await load(revoked, removed, publicChannel), publicEpoch.keyId);

  const id = () => randomBytes(16).toString('hex');
  const category = id(), role = id();
  const channels = Array.from({ length: 20 }, id);
  const selected = new Set(channels);
  const [ready, pending] = [channels.slice(0, 18), channels.slice(18)];
  const commit = async intent => {
    await host.readProtectedOwnerPolicy(owner);
    const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
    return host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
  };
  const resource = (action, ResourceChange) => commit({ Action: action, OperationID: id(), ResourceChange });
  const { snapshot: initial } = await host.readProtectedOwnerPolicy(owner);
  await commit({ Action: 'roles.update', OperationID: id(), RoleUpdate: {
    Roles: { ...initial.Roles, [role]: { Grants: [] } }, Order: [...(initial.Order ?? []), role], Assignments: {},
  } });
  await resource('category.create', { ID: category, Name: 'Protected activation group' });
  await resource('category.acl.update', { ID: category, ACL: { Roles: {
    '@everyone': { Allow: null, Deny: ['channel.view', 'history.full'] },
    [role]: { Allow: ['channel.view'], Deny: null },
  }, Profiles: null } });
  for (const [index, channel] of channels.entries()) {
    await resource('channel.create', { ID: channel, CategoryID: category, Channel: {
      Kind: 'text', Settings: { Name: `Synthetic gated channel ${index + 1}`, Description: '', SlowmodeSeconds: 0, VoiceCapacity: 0 },
    } });
  }
  const gated = async () => {
    const state = await reader.readProtectedRuntimeState(member);
    return { state, channels: state.channels.filter(channel => selected.has(channel.id)) };
  };
  assert.deepEqual((await gated()).channels, []);
  // Keep the configuration, activation and two package batches within the real
  // request quota shared by all loopback fixture devices.
  await delay(60_100);
  const beforeGrant = await host.readProtectedOwnerPolicy(owner);
  const granted = await commit({ Action: 'roles.update', OperationID: id(), RoleUpdate: {
    Roles: beforeGrant.snapshot.Roles, Order: beforeGrant.snapshot.Order, Assignments: { [member.profileId]: [role] },
  } });
  assert.equal(granted.Draft.Revision, beforeGrant.revision + 1);
  assert.equal(granted.Draft.PreviousDigest, beforeGrant.digest);
  const enabled = await gated();
  assert.deepEqual(enabled.channels.map(channel => channel.id).sort(), [...channels].sort());
  assert.ok(enabled.channels.every(channel => channel.categoryId === category && channel.keysPending === true));

  for (const [index, channel] of ready.entries()) {
    if (index === 9) await delay(60_100);
    const published = await host.rotateProtectedRuntimeText(owner, channel, 'live');
    assert.equal(await load(reader, member, channel), published.keyId);
  }
  const assertPartial = async () => {
    const current = await gated();
    assert.deepEqual(current.channels.filter(channel => channel.keysPending).map(channel => channel.id).sort(), [...pending].sort());
    assert.deepEqual(current.channels.filter(channel => !channel.keysPending).map(channel => channel.id).sort(), [...ready].sort());
    assert.ok((current.state.rotationQueue?.waiting ?? 0) >= pending.length);
  };
  await assertPartial();
  for (const channel of pending) {
    await assert.rejects(load(reader, member, channel), { code: 'PROTECTED_KEY_PENDING' });
  }

  const { snapshot } = await host.readProtectedOwnerPolicy(owner);
  const oldACL = snapshot.Channels[publicChannel].ACL;
  await resource('channel.acl.update', { ID: publicChannel, ACL: { ...oldACL, Profiles: {
    ...oldACL.Profiles, [removed.profileId]: { Allow: null, Deny: ['channel.view'] },
  } } });
  const denied = { code: 'PROTECTED_ACCESS_DENIED' };
  assert.ok(!(await revoked.readProtectedRuntimeState(removed)).channels.some(channel => channel.id === publicChannel));
  await assert.rejects(load(revoked, removed, publicChannel), denied);
  await assert.rejects(revoked.readProtectedRuntimeText(removed, publicChannel), denied);
  await assertPartial();
  console.log('PASS KEY-10 one role opens 20 channels atomically, 18 accept packages, two remain pending, and unrelated revocation is immediate');
}

async function checkScopedInviteOffline(fetcher, host, owner, channelId, { fullHistory, batch, prefix }) {
  const { serverId } = owner;
  const liveClaim = `/api/v3/keys/rotate/${channelId}/live/claim`;
  const liveCommit = `/api/v3/keys/rotate/${channelId}/live/commit`;
  const archiveClaim = `/api/v3/keys/rotate/${channelId}/archive/claim`;
  const archiveCommit = `/api/v3/keys/rotate/${channelId}/archive/commit`;
  const livePackage = `/api/v3/keys/current/${channelId}/live`;
  const archivePackage = `/api/v3/keys/current/${channelId}/archive`;
  const admittedLive = `/api/v3/keys/admitted/${channelId}/`;
  const archiveLinks = `/api/v3/keys/archive/${channelId}/links/`;
  const liveChat = `/api/v3/history/live/${channelId}`;
  const scoped = (url, options) => {
    assert.notEqual(new URL(url).pathname, '/api/v3/policy/proofs', 'ordinary invite participants must stay on scoped policy');
    return fetcher(url, options);
  };
  const inviteCount = batch ? 2 : 1;
  const entrants = Array.from({ length: inviteCount }, () => ({ liveDeliveries: 0, archiveDeliveries: 0, saved: new Map() }));
  const cohort = () => entrants.filter(entrant => entrant.connection);
  const batchActive = () => cohort().length > 1;
  const newMessages = new Map(), verifiedAuthors = new Set();
  const transitionDigest = (record, proof) => (batchActive() ? inviteAdmissionBatchDigest : inviteAdmissionEpochDigest)(record, proof);
  let rotator, issuer, reader, predecessor, oldPosition, inviteID, expectedTransition, markedLive;
  let previousArchive, previousLive, markedArchive, expectedArchiveTransition;
  let prefixLive, prefixArchive, prefixPosition, prefixDirectReads = 0;
  let archiveClaims = 0, archiveCommits = 0;
  let claims = 0, commits = 0, offline = false, tamper = false;
  const checkNewcomer = (proof, members = cohort()) => {
    assert.equal(proof.previousRevision, predecessor.revision);
    assert.equal(proof.previousHead, predecessor.digest);
    assert.equal(proof.newcomer.archive, fullHistory);
    const items = members.length > 1 ? proof.admissions : [proof];
    assert.equal(items.length, members.length);
    let previous = predecessor.digest;
    for (const [index, { draft, newcomerTextPolicy }] of items.entries()) {
      const { connection: entrant, firstPosition: expectedFirst } = members[index];
      assert.deepEqual(Object.keys(draft).sort(), ['actor', 'admission', 'digest', 'operationId', 'previousDigest', 'projectionRoot',
        'resultDigest', 'revision', 'signature']);
      assert.equal(draft.revision, predecessor.revision + index + 1);
      assert.equal(draft.previousDigest, previous);
      previous = draft.digest;
      assert.match(draft.projectionRoot, /^[a-f0-9]{64}$/);
      assert.equal(draft.admission.Claim.inviteId, inviteID);
      assert.equal(draft.admission.Issuance.MaxUses, inviteCount);
      assert.deepEqual(draft.admission.Issuance.Issuer, { ProfileID: issuer.profileId, DeviceID: issuer.deviceId });
      assert.deepEqual(draft.actor, { ProfileID: entrant.profileId, DeviceID: entrant.deviceId });
      assert.equal(newcomerTextPolicy.revision, draft.revision);
      assert.equal(newcomerTextPolicy.policyDigest, draft.resultDigest);
      const { id, profileId, archive, canSend, firstPosition } = newcomerTextPolicy.recipient.statement;
      assert.deepEqual({ id, profileId, archive, canSend, firstPosition }, {
        id: entrant.deviceId, profileId: entrant.profileId, archive: fullHistory, canSend: true, firstPosition: expectedFirst,
      });
    }
    assert.equal(previous, proof.successorHead);
  };
  const worker = createClient(async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === liveCommit || fullHistory && pathname === archiveCommit) {
      const { Record: record, Packages: packages } = JSON.parse(options.body);
      assert.deepEqual(packages.map(pkg => pkg.RecipientID).sort(),
        [owner.deviceId, issuer.deviceId, rotator.deviceId, reader.deviceId, ...cohort().map(item => item.connection.deviceId)].sort());
      assert.equal(verify(null, epochSignatureFrame(serverId, rotator.profileId, rotator.deviceId, record),
        createPublicKey((await worker.identity()).device), Buffer.from(record.Signature, 'base64')), true);
      if (pathname === liveCommit) {
        assert.equal(record.LiveTransitionDigest, expectedTransition);
        markedLive = record;
        commits++;
      } else {
        assert.equal(record.ArchiveTransitionDigest, expectedArchiveTransition);
        assert.notEqual(record.ArchiveTransitionDigest, markedLive.LiveTransitionDigest);
        assert.equal(record.ArchiveThrough, markedLive.Generation);
        markedArchive = record;
        archiveCommits++;
      }
    }
    const response = await scoped(url, options);
    if (!response.ok || (pathname !== liveClaim && !(fullHistory && pathname === archiveClaim))) return response;
    assert.equal(searchParams.get('scoped'), '1');
    const task = await response.json();
    const proof = batchActive() ? task.inviteAdmissions : task.inviteAdmission;
    checkNewcomer(proof);
    assert.deepEqual(Object.keys(proof.previousOpenings).sort(), [owner.profileId, issuer.profileId, rotator.profileId, reader.profileId].sort());
    if (task.Purpose === 'live') {
      assert.equal(task.ArchiveThrough ?? 0, 0);
      assert.equal(task.ArchiveTargets?.length ?? 0, 0);
      expectedTransition = transitionDigest(task, proof);
      claims++;
      if (!fullHistory && tamper) proof.draft.projectionRoot = `${proof.draft.projectionRoot[0] === '0' ? '1' : '0'}${proof.draft.projectionRoot.slice(1)}`;
    } else {
      assert.equal(task.ArchiveThrough, markedLive.Generation);
      const preexistingTargets = prefixArchive ? [['archive', prefixArchive.Generation, prefixArchive.KeyID]] : [
        ['archive', previousArchive.generation, previousArchive.keyId], ['live', previousLive.generation, previousLive.keyId],
      ];
      assert.deepEqual(task.ArchiveTargets.map(target => [target.Purpose, target.Generation, target.KeyID]),
        [...preexistingTargets, ['live', markedLive.Generation, markedLive.KeyID]]);
      expectedArchiveTransition = transitionDigest(task, proof);
      archiveClaims++;
      if (tamper) {
        if (batchActive()) {
          const { draft } = proof.admissions[1];
          draft.projectionRoot = `${draft.projectionRoot[0] === '0' ? '1' : '0'}${draft.projectionRoot.slice(1)}`;
        } else {
          const opening = proof.previousOpenings[rotator.profileId];
          opening.contentSalt = `${opening.contentSalt[0] === '0' ? '1' : '0'}${opening.contentSalt.slice(1)}`;
        }
      }
    }
    return Response.json(task);
  });
  const issuerClient = createClient((url, options) => {
    assert.ok(!offline, 'issuer remained offline after issuing the invitation');
    return scoped(url, options);
  });
  const observer = createClient(async (url, options) => {
    const { pathname } = new URL(url);
    const response = await scoped(url, options);
    if (newMessages.size && response.ok && pathname === liveChat) {
      const { messages } = await response.clone().json();
      for (const sent of messages) {
        const expected = newMessages.get(sent.Position);
        if (!expected) continue;
        assert.deepEqual(sent.Author, expected.author);
        assert.equal(sent.Packet.KeyID, expected.keyId);
        assert.ok(!Object.hasOwn(sent, 'previousAuthorPolicy'));
        verifiedAuthors.add(sent.Author.DeviceID);
      }
    }
    return response;
  });
  const makeApplicant = entrant => createClient(async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    if (entrant.directOnly) assert.ok(pathname !== archivePackage && !pathname.startsWith(archiveLinks),
      'first newcomer must open the prefix from its originally addressed live package');
    if (!fullHistory) assert.ok(!pathname.startsWith(archiveLinks), 'limited newcomer must never receive archive links');
    const response = await scoped(url, options);
    if (!fullHistory && pathname === archivePackage) assert.equal(response.ok, false);
    if (prefixLive && pathname === admittedLive + prefixLive.KeyID && response.ok) {
      const delivery = await response.clone().json();
      assert.equal(entrant, entrants[0]);
      assert.equal(delivery.Package.RecipientID, entrant.connection.deviceId);
      assert.deepEqual(delivery.Epoch.Record, prefixLive);
      checkNewcomer(delivery.liveInviteAdmission, [entrant]);
      prefixDirectReads++;
    }
    if (fullHistory && response.ok && pathname.startsWith(archiveLinks)) {
      assert.equal(searchParams.get('scoped'), '1');
      entrant.archiveStartKey ??= pathname.slice(archiveLinks.length);
    }
    if (response.ok && (pathname === livePackage || fullHistory && pathname === archivePackage)) {
      assert.equal(searchParams.get('scoped'), '1');
      const delivery = await response.clone().json();
      const archive = pathname === archivePackage;
      assert.deepEqual(delivery.Epoch.Record, archive ? markedArchive : markedLive);
      assert.equal(delivery.Package.RecipientID, entrant.connection.deviceId);
      const proof = batchActive() ? (archive ? delivery.archiveInviteAdmissions : delivery.liveInviteAdmissions)
        : (archive ? delivery.archiveInviteAdmission : delivery.liveInviteAdmission);
      checkNewcomer(proof);
      assert.equal(proof.previousSignerTextPolicy.recipient.statement.id, rotator.deviceId);
      for (const field of ['previousTextPolicy', 'previousOpenings', 'Recipients']) assert.ok(!Object.hasOwn(proof, field));
      if (archive) entrant.archiveDeliveries++;
      else entrant.liveDeliveries++;
    }
    return response;
  }, entrant.saved);
  const change = async intent => {
    await host.readProtectedOwnerPolicy(owner);
    const draft = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
    assert.equal(draft.draft.TextProjectionVersion, profileRoleAuthorityProjectionVersion);
    return host.commitProtectedRuntimePolicy(owner, { preview: draft, intent, expectedResultDigest: draft.draft.ResultDigest }, owner.policyTrust);
  };
  const join = async (client, nickname) => {
    const { link } = await host.createProtectedInvite(owner);
    await client.redeemProtectedInvite(link, nickname);
    return client.openStoredProtectedRuntime(serverId);
  };
  const issuerRole = randomBytes(16).toString('hex');
  const grantIssuerRole = async profileId => {
    const { snapshot } = await host.readProtectedOwnerPolicy(owner);
    await change({ Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
      Roles: { ...snapshot.Roles, [issuerRole]: { Grants: ['invite.create'] } },
      Order: snapshot.Roles[issuerRole] ? snapshot.Order : [...(snapshot.Order ?? []), issuerRole],
      Assignments: profileId ? { [profileId]: [issuerRole] } : {},
    } });
  };
  const send = (client, connection, text) => client.withCurrentProtectedChatPolicy(connection, options =>
    client.sendProtectedRuntimeText(connection, channelId, text, randomBytes(16).toString('hex'), options));
  const earlierHistory = [];
  let archivedLive;
  rotator = await join(worker, fullHistory ? 'Full-history invite rotator' : 'Limited invite rotator');
  if (fullHistory) {
    await grantIssuerRole();
    await host.syncProtectedPolicyAttestations(owner);
    archivedLive = await host.rotateProtectedRuntimeText(owner, channelId, 'live');
    const text = 'Synthetic history covered by the retained archive';
    earlierHistory.push([(await send(worker, rotator, text)).Position, text]);
    previousArchive = await host.rotateProtectedRuntimeText(owner, channelId, 'archive');
    assert.equal(previousArchive.through, archivedLive.generation);
    const retainedArchive = await worker.loadProtectedRuntimeKey(rotator, channelId, 'archive', { policyTrust: rotator.policyTrust });
    retainedArchive.secret.fill(0);
    assert.equal(retainedArchive.record.KeyID, previousArchive.keyId);
  }
  issuer = await join(issuerClient, 'Delegated offline issuer');
  reader = await join(observer, 'Independent invite reader');
  await grantIssuerRole(issuer.profileId);
  if (!fullHistory) {
    await change({ Action: 'channel.acl.update', OperationID: randomBytes(16).toString('hex'), ResourceChange: {
      ID: channelId, ACL: { Roles: { '@everyone': { Allow: null, Deny: ['history.full'] } }, Profiles: null },
    } });
  }
  await host.syncProtectedPolicyAttestations(owner);
  previousLive = await host.rotateProtectedRuntimeText(owner, channelId, 'live');
  if (fullHistory) assert.equal(previousLive.generation, previousArchive.through + 1);
  const oldText = 'Synthetic history before the newcomer joined';
  oldPosition = (await send(worker, rotator, oldText)).Position;
  earlierHistory.push([oldPosition, oldText]);
  if (!fullHistory) await host.rotateProtectedRuntimeText(owner, channelId, 'archive');
  assert.deepEqual((await observer.readProtectedChatPage(reader, channelId, oldPosition - 1)).messages.map(message => message.text), [oldText]);
  predecessor = await worker.readProtectedPolicyAttestation(rotator);
  assert.equal(predecessor.projectionVersion, profileRoleAuthorityProjectionVersion);
  const issued = await issuerClient.createProtectedInvite(issuer, { maxUses: inviteCount });
  inviteID = issued.invite.id;
  const ownerFetcher = host.fetcher;
  offline = true;
  host.fetcher = () => assert.fail('owner remained offline after issuing the invitation');
  try {
    // The fixture peers share the server's per-IP request window.
    await delay(60_100);
    const unavailable = { code: 'POLICY_ATTESTATION_UNAVAILABLE' };
    const rotate = purpose => worker.rotateProtectedRuntimeText(rotator, channelId, purpose);
    for (const [index, entrant] of entrants.entries()) {
      const applicant = entrant.client = makeApplicant(entrant);
      const nickname = fullHistory ? `New archive reader ${index + 1}` : 'Brand new limited reader';
      const admitted = await applicant.redeemProtectedInvite(issued.link, nickname);
      entrant.connection = await applicant.openStoredProtectedRuntime(serverId);
      entrant.firstPosition = (prefixPosition ?? oldPosition) + 1;
      assert.equal(admitted.profileId, entrant.connection.profileId);
      if (prefix && index === 0) {
        await assert.rejects(worker.readProtectedPolicyAttestation(rotator), unavailable);
        await delay(5300);
        const live = await rotate('live');
        const archive = await rotate('archive');
        assert.equal(claims, 1);
        assert.equal(commits, 1);
        assert.equal(archiveClaims, 1);
        assert.equal(archiveCommits, 1);
        assert.equal(live.generation, previousLive.generation + 1);
        assert.equal(archive.generation, previousArchive.generation + 1);
        prefixLive = markedLive;
        prefixArchive = markedArchive;
        const text = 'Synthetic message from first newcomer before the second admission';
        const message = await send(applicant, entrant.connection, text);
        prefixPosition = message.Position;
        assert.equal(prefixPosition, entrant.firstPosition);
        earlierHistory.push([prefixPosition, text]);
        newMessages.set(prefixPosition, { text, keyId: prefixLive.KeyID,
          author: { ProfileID: entrant.connection.profileId, DeviceID: entrant.connection.deviceId } });
        assert.ok(entrant.liveDeliveries > 0);
        entrant.liveDeliveries = 0;
        // Start the second admission and the later archive reads in a fresh quota window.
        await delay(60_100);
      }
    }
    if (batch) await assert.rejects(createClient(scoped).redeemProtectedInvite(issued.link, 'Beyond invitation limit'),
      { code: 'PROTECTED_INVITE_UNAVAILABLE' });
    await assert.rejects(worker.readProtectedPolicyAttestation(rotator), unavailable);
    await delay(5300);
    const rejectTampered = async (purpose, code) => {
      tamper = true;
      try {
        await assert.rejects(rotate(purpose), error => {
          if (error.code !== code) throw error;
          return true;
        });
      } finally { tamper = false; }
    };
    if (!fullHistory) await rejectTampered('live', 'INVALID_PROTECTED_INVITE_PROOF');
    assert.equal(commits, prefix ? 1 : 0);
    const rotated = await rotate('live');
    assert.equal(claims, fullHistory && !prefix ? 1 : 2);
    assert.equal(commits, prefix ? 2 : 1);
    assert.equal(rotated.generation, (prefixLive?.Generation ?? previousLive.generation) + 1);
    assert.equal(rotated.keyId, markedLive.KeyID);
    const denied = { code: 'PROTECTED_ACCESS_DENIED' };
    if (fullHistory) {
      await rejectTampered('archive', batch ? 'INVALID_PROTECTED_INVITE_PROOF' : 'INVALID_CHANNEL_POLICY_PROOF');
      assert.equal(archiveCommits, prefix ? 1 : 0);
      const archived = await rotate('archive');
      assert.equal(archiveClaims, prefix ? 3 : 2);
      assert.equal(archiveCommits, prefix ? 2 : 1);
      assert.equal(archived.generation, (prefixArchive?.Generation ?? previousArchive.generation) + 1);
      assert.equal(archived.keyId, markedArchive.KeyID);
    }
    const directLive = ({ client, connection }, keyId) => client.fetchJSON(connection.base, `${admittedLive}${keyId}?scoped=1`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (prefix) {
      const first = entrants[0], last = entrants[1];
      const previousDevice = first.connection.deviceId;
      first.client = makeApplicant(first);
      first.connection = await first.client.openStoredProtectedRuntime(serverId);
      assert.equal(first.connection.deviceId, previousDevice);
      first.directOnly = true;
      try {
        const page = await first.client.readProtectedChatPage(first.connection, channelId, oldPosition);
        assert.deepEqual(page.messages.map(message => [message.position, message.text]), [[prefixPosition, newMessages.get(prefixPosition).text]]);
      } finally { first.directOnly = false; }
      assert.ok(prefixDirectReads > 0);
      await assert.rejects(directLive(last, prefixLive.KeyID), denied);
    }
    for (const [index, { client, connection }] of entrants.entries()) {
      if (fullHistory) {
        for (const key of [archivedLive, previousLive]) {
          await assert.rejects(directLive({ client, connection }, key.keyId), denied);
        }
      } else {
        await assert.rejects(client.loadProtectedRuntimeKey(connection, channelId, 'archive', { policyTrust: connection.policyTrust }), denied);
      }
      const text = `Synthetic first message from newly admitted device ${index + 1}`;
      const message = await send(client, connection, text);
      assert.equal(message.Position, (prefixPosition ?? oldPosition) + index + 1);
      newMessages.set(message.Position, { text, keyId: markedLive.KeyID, author: { ProfileID: connection.profileId, DeviceID: connection.deviceId } });
    }
    const published = [...newMessages].map(([position, { text }]) => [position, text]);
    const recent = published.filter(([position]) => position !== prefixPosition);
    for (const entrant of entrants) {
      const entrantPage = await entrant.client.readProtectedChatPage(entrant.connection, channelId, 0);
      assert.equal(entrantPage.first, fullHistory ? earlierHistory[0][0] : oldPosition + 1);
      assert.deepEqual(entrantPage.messages.map(message => [message.position, message.text]), [...(fullHistory ? earlierHistory : []), ...recent]);
      assert.ok(entrant.liveDeliveries > 0);
      if (fullHistory) {
        assert.ok(entrant.archiveDeliveries > 0);
        assert.equal(entrant.archiveStartKey, markedArchive.KeyID);
      }
    }
    const independentPage = await observer.readProtectedChatPage(reader, channelId, oldPosition);
    assert.deepEqual(independentPage.messages.map(message => [message.position, message.text]), published);
    assert.deepEqual(verifiedAuthors, new Set(entrants.map(entrant => entrant.connection.deviceId)));
    await assert.rejects(observer.readProtectedPolicyAttestation(reader), unavailable);
  } finally {
    host.fetcher = ownerFetcher;
    offline = false;
  }
  console.log(prefix
    ? 'PASS v17 offline batch preserves a completed single-admission prefix and confines the second newcomer to archive access for its message'
    : batch
    ? 'PASS v17 reusable offline invitation admits two full-history devices with distinct packages and authenticated authorship'
    : fullHistory
    ? 'PASS v17 offline full-history invitation rotates marked live and archive keys, opens older history through archive, and authenticates the newcomer as author'
    : 'PASS v17 offline invitation rotates one marked live key, keeps old history private, and authenticates the newcomer as author');
}

async function checkProtectedMentions(fetcher, host, owner, sender, channelId) {
  const { serverId } = owner;
  const recipient = createClient(fetcher);
  const enroll = async (client, label) => {
    const { link } = await host.createProtectedInvite(owner);
    await client.redeemProtectedInvite(link, label);
    return client.openStoredProtectedRuntime(serverId);
  };
  const from = await enroll(sender, 'Synthetic mention sender');
  const to = await enroll(recipient, 'Synthetic mention recipient');
  for (let pass = 0; pass < 2; pass++) await host.serviceProtectedRuntimeRotations(owner);
  const send = (text, target, operation = randomBytes(16).toString('hex')) => sender.withCurrentProtectedChatPolicy(from, options =>
    sender.sendProtectedRuntimeText(from, channelId, text, operation, options, undefined, undefined, undefined, undefined,
      target && [{ ...target, start: 0, end: text.length }]));
  const everyone = { kind: 'everyone' };
  const denied = { code: 'PROTECTED_ACCESS_DENIED' };
  const plain = await send('@everyone');
  const message = await recipient.readProtectedChatReference(to, channelId, plain.Position);
  assert.equal(message.text, '@everyone');
  assert.equal(message.mentions, undefined);
  assert.deepEqual((await recipient.pollProtectedMentions(to)).alerts, []);
  await assert.rejects(send('@everyone', everyone), denied);

  const massRole = randomBytes(16).toString('hex'), targetRole = randomBytes(16).toString('hex');
  const roleName = 'Mention recipients';
  const updateRoles = async makeEdit => {
    const { snapshot } = await host.readProtectedOwnerPolicy(owner);
    const intent = { Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: makeEdit(snapshot) };
    const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
    await host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
    await host.syncProtectedPolicyAttestations(owner);
  };
  await updateRoles(snapshot => ({ Roles: { ...snapshot.Roles, [massRole]: { Grants: ['mention.mass'] }, [targetRole]: { Grants: [] } },
    Order: [...(snapshot.Order ?? []), massRole, targetRole],
    Presentation: { [massRole]: { Name: 'Mass mentions' }, [targetRole]: { Name: roleName, Mentionable: true } },
    Assignments: { [from.profileId]: [massRole], [to.profileId]: [targetRole] } }));
  await assert.rejects(send('@' + roleName, { kind: 'role', id: roleName }), denied);

  const massOperation = randomBytes(16).toString('hex');
  const mass = await send('@everyone', everyone, massOperation);
  const role = await send('@' + roleName, { kind: 'role', id: targetRole });
  const direct = await send('@Synthetic recipient', { kind: 'profile', id: to.profileId });
  await updateRoles(snapshot => ({ Roles: { ...snapshot.Roles, [massRole]: { Grants: [] } }, Order: snapshot.Order, Assignments: null }));
  assert.deepEqual(await send('@everyone', everyone, massOperation), { ...mass, Existing: true });
  await assert.rejects(send('@everyone', everyone), denied);
  await assert.rejects(send('@online', { kind: 'online' }), denied);

  const shown = [];
  class NotificationProbe {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    on() {}
    show() { shown.push(this.options); }
    close() {}
  }
  let invoke;
  const service = registerMembershipIPC({ ipcMain: { handle(_name, handler) { invoke = handler; } }, authorized: () => {},
    client: recipient, links: {}, send() {}, getWindow() {}, Notification: NotificationProbe });
  const ipc = async (action, input) => {
    const result = await invoke({}, action, input);
    if (result.error) throw Object.assign(new Error(result.error.code), result.error);
    return result.value;
  };
  try {
    await ipc('connect', { serverId });
    const inbox = await ipc('chat.protected.mentions', { serverId, serverMuted: false, mutedChannels: [channelId] });
    assert.deepEqual(inbox, [
      { channelId, position: mass.Position, kind: 'group' },
      { channelId, position: role.Position, kind: 'group' },
      { channelId, position: direct.Position, kind: 'direct' },
    ]);
    for (const position of [mass.Position, role.Position]) {
      assert.equal(await ipc('chat.protected.notify', { serverId, channelId, position }), false);
    }
    assert.equal(shown.length, 0);
    assert.equal(await ipc('chat.protected.notify', { serverId, channelId, position: direct.Position }), true);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].body, '@Synthetic recipient');
    assert.equal(shown[0].silent, true);
  } finally {
    service.stop();
  }
  console.log('PASS protected literal, mass, role and direct mentions over pinned TLS; group mute suppresses prompts and preserves direct mentions');
}

async function checkProtectedEvents(host, owner, guest, channelId) {
  const { serverId } = owner;
  const { link } = await host.createProtectedInvite(owner);
  await guest.redeemProtectedInvite(link, 'Synthetic protected event reader');
  await host.serviceProtectedRuntimeRotations(owner);
  const connection = await guest.openStoredProtectedRuntime(serverId);
  assert.equal(connection.config.protectedEvents, true);
  assert.equal(connection.config.protectedMessageDelivery, true);

  const events = [];
  let invoke;
  const service = registerMembershipIPC({ ipcMain: { handle(_name, handler) { invoke = handler; } },
    authorized: () => {}, client: guest, links: {}, send(kind, event) {
      if (kind === 'membership-protected-event') events.push(event);
    }, getWindow() {} });
  const ipc = async (action, input) => {
    const result = await invoke({}, action, input);
    if (result.error) throw Object.assign(new Error(result.error.code), result.error);
    return result.value;
  };
  const until = async (predicate, label) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await delay(30);
    }
    assert.fail(`Timed out waiting for ${label}`);
  };
  const connect = () => ipc('connect', { serverId });
  const page = () => ipc('chat.protected.read', { serverId, channelId, after: 0 });
  const send = text => host.withCurrentProtectedChatPolicy(owner, options =>
    host.sendProtectedRuntimeText(owner, channelId, text, randomBytes(16).toString('hex'), options));

  try {
    await connect();
    await until(() => events.some(event => event.type === 'resync'), 'composer subscription handshake');
    for (const activity of ['typing', 'recording', 'idle']) {
      await host.publishProtectedComposerActivity(owner, channelId, activity);
      await until(() => events.some(event => event.type === 'composer' && event.activity === activity), activity);
      assert.deepEqual(events.find(event => event.type === 'composer' && event.activity === activity),
        { serverId, type: 'composer', channelId, profileId: owner.profileId, activity });
    }
    await until(() => events.some(event => event.type === 'resync'), 'initial authenticated resync');
    assert.ok(events.some(event => event.type === 'status' && event.live));
    assert.equal((await connect()).eventsLive, true);
    const baseline = await page();
    let cursor = baseline.cursor, after = baseline.messages.at(-1)?.position ?? 0;
    const expected = baseline.messages.map(message => message.text);
    const timings = [], requests = [];
    const deliveryChecks = [];
    let firstDelivery;
    const originalPushedRead = guest.readProtectedPushedChatPage;
    guest.readProtectedPushedChatPage = async function (...args) {
      try {
        const value = await originalPushedRead.apply(this, args);
        if (value && !firstDelivery) firstDelivery = args;
        deliveryChecks.push(value ? 'verified' : 'unusable');
        return value;
      } catch (error) {
        deliveryChecks.push(error.code ?? error.message);
        throw error;
      }
    };
    const originalFetch = guest.fetchJSON;
    guest.fetchJSON = function (base, path, ...args) {
      if (path.startsWith('/api/v3/history/')) requests.push(path);
      return originalFetch.call(this, base, path, ...args);
    };
    try {
      for (let index = 0; index < 6; index++) {
        if (index) await delay(220);
        events.length = 0;
        const text = `Synthetic direct delivery ${index}`;
        const started = performance.now();
        const receipt = await send(text);
        await until(() => events.some(event => event.type === 'chat'), 'scoped encrypted delivery');
        assert.deepEqual(events.find(event => event.type === 'chat'), { serverId, type: 'chat', channelId, pushed: true });
        const received = await ipc('chat.protected.read', { serverId, channelId, after, cursor });
        timings.push(Math.round(performance.now() - started));
        assert.deepEqual(received.messages.map(message => message.text), [text]);
        assert.equal(received.messages[0].position, receipt.Position);
        cursor = received.cursor;
        after = receipt.Position;
        expected.push(text);
      }
      assert.deepEqual(requests, [], `direct delivery must not GET any history route (${deliveryChecks.join(', ')})`);
    } finally {
      guest.fetchJSON = originalFetch;
      guest.readProtectedPushedChatPage = originalPushedRead;
    }
    console.log(`Protected delivery on loopback, two independent clients, send to verified read in ms: ${timings.join(', ')}`);
    assert.ok(firstDelivery);
    const altered = structuredClone(firstDelivery[5]);
    const packet = altered[0].page.messages[0].Packet;
    packet.Ciphertext = (packet.Ciphertext[0] === 'A' ? 'B' : 'A') + packet.Ciphertext.slice(1);
    await assert.rejects(guest.readProtectedPushedChatPage(...firstDelivery.slice(0, 5), altered));

    const legacyEvents = [], legacyTimings = [];
    const legacy = new ProtectedMembershipLive(event => legacyEvents.push(event));
    try {
      legacy.ensure({ ...connection, config: { ...connection.config, protectedMessageDelivery: false } });
      await until(() => legacyEvents.some(event => event.type === 'resync'), 'legacy capability negotiation');
      for (let index = 0; index < 3; index++) {
        await delay(220);
        legacyEvents.length = 0;
        const text = `Synthetic notification plus HTTP ${index}`;
        const started = performance.now();
        const receipt = await send(text);
        await until(() => legacyEvents.some(event => event.type === 'chat'), 'legacy scoped invalidation');
        assert.deepEqual(legacyEvents.find(event => event.type === 'chat'), { serverId, type: 'chat', channelId });
        const received = await guest.readProtectedChatPage(connection, channelId, after, cursor);
        legacyTimings.push(Math.round(performance.now() - started));
        assert.deepEqual(received.messages.map(message => message.text), [text]);
        cursor = received.cursor;
        after = receipt.Position;
        expected.push(text);
      }
    } finally { legacy.stop(); }
    console.log(`Legacy invalidation plus HTTP on the same loopback clients in ms: ${legacyTimings.join(', ')}`);

    service.suspend();
    assert.deepEqual(events.at(-1), { serverId, type: 'status', live: false });
    events.length = 0;
    const second = 'Plaintext recovered by polling while event stream is stopped';
    await delay(220);
    await send(second);
    assert.deepEqual((await page()).messages.map(message => message.text), [...expected, second]);
    assert.equal(events.length, 0);

    await connect();
    await until(() => events.some(event => event.type === 'resync'), 'resync after polling fallback');
    let usedHTTP = false;
    guest.fetchJSON = function (base, path, ...args) {
      if (path.startsWith('/api/v3/history/live/')) usedHTTP = true;
      return originalFetch.call(this, base, path, ...args);
    };
    try {
      const recovered = await ipc('chat.protected.read', { serverId, channelId, after, cursor });
      assert.deepEqual(recovered.messages.map(message => message.text), [second]);
      assert.equal(usedHTTP, true, 'a message missed during a disconnect is recovered over HTTP');
    } finally { guest.fetchJSON = originalFetch; }
    events.length = 0;
    const { snapshot } = await host.readProtectedOwnerPolicy(owner);
    const acl = snapshot.Channels[channelId].ACL;
    const deny = { Action: 'channel.acl.update', OperationID: randomBytes(16).toString('hex'), ResourceChange: {
      ID: channelId, ACL: { ...acl, Profiles: { ...acl.Profiles, [connection.profileId]: { Allow: null, Deny: ['channel.view'] } } },
    } };
    const preview = await host.previewProtectedRuntimePolicy(owner, deny, owner.policyTrust);
    await host.commitProtectedRuntimePolicy(owner, { preview, intent: deny, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
    await until(() => events.some(event => event.type === 'state'), 'scoped state invalidation after revoke');
    assert.ok(!(await connect()).channels.some(channel => channel.id === channelId));
    await assert.rejects(page(), { code: 'PROTECTED_ACCESS_DENIED' });
    events.length = 0;
    await host.rotateProtectedRuntimeText(owner, channelId, 'live');
    await send('Message after reader lost permission');
    await delay(350);
    assert.equal(events.some(event => event.type === 'chat'), false);
  } finally {
    service.stop();
  }

  const resumed = [];
  const subscription = new ProtectedMembershipLive(event => resumed.push(event));
  try {
    const { protectedEvents, ...oldConfig } = connection.config;
    subscription.ensure({ ...connection, config: oldConfig });
    assert.equal(subscription.healthy(serverId), false);
    assert.equal(subscription.entries.size, 0);
    subscription.ensure(connection);
    await until(() => resumed.some(event => event.type === 'resync'), 'authenticated cursor baseline');
    const entry = subscription.entries.get(serverId);
    const after = entry.sequence;
    entry.attempt.bridge.close();
    await until(() => resumed.some(event => event.type === 'status' && !event.live), 'fallback after transport loss');
    await until(() => resumed.filter(event => event.type === 'resync').length === 2, 'resync with resumed cursor');
    assert.ok(entry.sequence > after);
  } finally {
    subscription.stop();
  }
  console.log('PASS API3 pinned event IPC, scoped invalidation, polling fallback, revocation and reconnect resync');
}

async function checkScopedChannelACL(fetcher, host, owner, channelId, offline) {
  let alterRules = false, alterClaim, liveClaims = 0, liveCommits = 0, lostCommit, acceptedCommit;
  let oldACL, newPolicy, listener, markedLive, expectedTransitionDigest;
  let roleDeliveries = 0, roleAuthors = 0;
  const recipients = () => [owner.deviceId, connection.deviceId, ...(listener ? [listener.deviceId] : [])].sort();
  const editor = createClient(async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    assert.notEqual(pathname, '/api/v3/policy/proofs', 'a scoped ACL editor must never request full policy');
    if (pathname === `/api/v3/keys/rotate/${channelId}/live/commit`) {
      liveCommits++;
      const { Record, Packages } = JSON.parse(options.body);
      assert.deepEqual(Packages.map(item => item.RecipientID).sort(), recipients());
      if (offline) {
        assert.match(Record.LiveTransitionDigest, /^[a-f0-9]{64}$/);
        assert.equal(Record.LiveTransitionDigest, expectedTransitionDigest);
        const frame = epochSignatureFrame(owner.serverId, connection.profileId, connection.deviceId, Record);
        assert.equal(verify(null, frame, createPublicKey((await editor.identity()).device), Buffer.from(Record.Signature, 'base64')), true);
        markedLive = Record;
      }
    }
    const response = await fetcher(url, options);
    if (pathname === `/api/v3/keys/rotate/${channelId}/live/claim` && response.ok) {
      assert.equal(searchParams.get('scoped'), '1');
      liveClaims++;
      const task = await response.json();
      const transition = task.roleViewDeny;
      assert.equal(transition.previousRevision, oldACL.revision);
      assert.equal(transition.previousHead, oldACL.policyHead);
      assert.equal(transition.successorHead, newPolicy.digest);
      assert.deepEqual(transition.actor, { ProfileID: connection.profileId, DeviceID: connection.deviceId });
      assert.match(transition.authority.rulesDigest, /^[a-f0-9]{64}$/);
      for (const field of ['rules', 'rulesSalt', 'synchronized']) assert.ok(!Object.hasOwn(transition.authority, field));
      assert.match(transition.previousTextPolicy.rotation.roleViewDenies, /^[a-f0-9]{64}$/);
      const { roleId, salt, previousRulesDigest, nextRulesDigest, excludedProfiles, proof } = transition.effect;
      assert.equal(roleId, targetRole);
      assert.deepEqual(excludedProfiles, [target.profileId]);
      for (const digest of [salt, previousRulesDigest, nextRulesDigest]) assert.match(digest, /^[a-f0-9]{64}$/);
      assert.notEqual(previousRulesDigest, nextRulesDigest);
      assert.ok(proof && typeof proof === 'object');
      assert.deepEqual(Object.keys(task.Recipients).sort(), recipients());
      if (offline) {
        expectedTransitionDigest = roleViewDenyDigest(task, transition);
        assert.deepEqual(Object.keys(transition.survivorOpenings).sort(), [owner.profileId, connection.profileId, listener.profileId].sort());
        assert.deepEqual(Object.keys(transition.removedGroups), [target.profileId]);
        const removed = transition.removedGroups[target.profileId];
        assert.deepEqual(Object.keys(removed).sort(), ['digest', 'salt']);
        assert.match(removed.digest, /^[a-f0-9]{64}$/);
        assert.match(removed.salt, /^[a-f0-9]{64}$/);
      }
      alterClaim?.(task);
      return Response.json(task);
    }
    if (options.method === 'POST' && pathname === `/api/v3/policy/channel-acl/${channelId}` && response.ok) {
      const receipt = await response.clone().json();
      if (!lostCommit) {
        lostCommit = options.body;
        acceptedCommit = receipt;
        throw Error('synthetic lost ACL commit response');
      }
      assert.equal(options.body, lostCommit);
      assert.deepEqual(receipt, acceptedCommit);
    }
    if (!alterRules || pathname !== `/api/v3/policy/channel-acl/${channelId}` || !response.ok) return response;
    const proof = await response.json();
    proof.rules['@everyone'].Deny = ['channel.view'];
    return new Response(JSON.stringify(proof), { status: 200 });
  });
  const { link } = await host.createProtectedInvite(owner);
  await editor.redeemProtectedInvite(link, 'Synthetic ACL editor');
  const connection = await editor.openStoredProtectedRuntime(owner.serverId);
  const member = createClient(fetcher);
  const memberInvite = await host.createProtectedInvite(owner);
  await member.redeemProtectedInvite(memberInvite.link, 'Synthetic ACL target');
  const target = await member.openStoredProtectedRuntime(owner.serverId);
  const observer = offline && createClient(async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    assert.notEqual(pathname, '/api/v3/policy/proofs', 'independent reader must stay on scoped policy');
    assert.notEqual(pathname, `/api/v3/keys/current/${channelId}/archive`, 'live-only reader must not use archive');
    const response = await fetcher(url, options);
    if (markedLive && response.ok && pathname === `/api/v3/history/live/${channelId}`) {
      assert.equal(searchParams.get('scoped'), '1');
      const { messages } = await response.clone().json();
      for (const entry of messages) {
        const proof = entry.previousAuthorPolicy;
        assert.equal(proof.revision, oldACL.revision);
        assert.equal(proof.recipient.statement.id, connection.deviceId);
        assert.equal(proof.recipient.statement.canSend, true);
        roleAuthors++;
      }
    }
    if (!markedLive || !response.ok || pathname !== `/api/v3/keys/current/${channelId}/live`) return response;
    assert.equal(searchParams.get('scoped'), '1');
    const delivery = await response.clone().json();
    assert.deepEqual(delivery.Epoch.Record, markedLive);
    const witness = delivery.liveRoleViewDeny;
    assert.equal(witness.previousHead, oldACL.policyHead);
    assert.equal(witness.successorHead, newPolicy.digest);
    assert.equal(witness.previousTextPolicy.recipient.statement.id, listener.deviceId);
    assert.equal(witness.previousSignerTextPolicy.recipient.statement.id, connection.deviceId);
    for (const field of ['survivorOpenings', 'removedGroups']) assert.ok(!Object.hasOwn(witness, field));
    roleDeliveries++;
    return response;
  });
  if (offline) {
    const invite = await host.createProtectedInvite(owner);
    await observer.redeemProtectedInvite(invite.link, 'Independent live-only reader');
    listener = await observer.openStoredProtectedRuntime(owner.serverId);
  }
  const commit = async intent => {
    await host.readProtectedOwnerPolicy(owner);
    const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
    assert.equal(preview.draft.TextProjectionVersion, profileRoleAuthorityProjectionVersion);
    return host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
  };
  const { snapshot } = await host.readProtectedOwnerPolicy(owner);
  const roleId = randomBytes(16).toString('hex');
  const targetRole = randomBytes(16).toString('hex');
  const grant = { Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
    Roles: { ...snapshot.Roles, [roleId]: { Grants: ['channel.access.edit'] }, [targetRole]: { Grants: [] } },
    Order: [...(snapshot.Order ?? []), targetRole, roleId],
    Assignments: { [connection.profileId]: [targetRole, roleId], [target.profileId]: [targetRole] },
  } };
  const legacyPreview = await host.fetchJSON(owner.base, '/api/v3/policy/preview?projection=10', {
    method: 'POST', fingerprint: owner.fingerprint, headers: { Authorization: `Bearer ${owner.token}` }, body: JSON.stringify(grant),
  });
  assert.equal(legacyPreview.draft.TextProjectionVersion, 10);
  await commit(grant);
  const prev = (await host.readProtectedOwnerPolicy(owner)).snapshot;
  const personal = { [connection.profileId]: { Allow: ['channel.view', 'message.send'], Deny: null } };
  if (offline) personal[listener.profileId] = { Allow: null, Deny: ['history.full'] };
  await commit({ Action: 'channel.acl.update', OperationID: randomBytes(16).toString('hex'), ResourceChange: { ID: channelId,
    ACL: { Roles: { '@everyone': { Allow: null, Deny: ['message.send'] } }, Profiles: personal },
  } });
  const state = await editor.readProtectedRuntimeState(connection);
  const channel = state.channels.find(channel => channel.id === channelId);
  assert.equal(state.canManageChannels, false);
  assert.equal(channel.canInspectACL, true);
  assert.equal(channel.canEditSettings, undefined);
  const proof = await editor.readProtectedChannelACL(connection, channelId);
  oldACL = proof;
  assert.equal(proof.synchronized, false);
  assert.deepEqual(proof.rules, { '@everyone': { Allow: null, Deny: ['message.send'] } });
  alterRules = true;
  try { await assert.rejects(editor.readProtectedChannelACL(connection, channelId), { code: 'INVALID_CHANNEL_POLICY_PROOF' }); }
  finally { alterRules = false; }
  assert.ok((await member.readProtectedRuntimeState(target)).channels.some(channel => channel.id === channelId));
  await host.serviceProtectedRuntimeRotations(owner);
  const previousKey = await member.loadProtectedRuntimeKey(target, channelId, 'live', { policyTrust: target.policyTrust });
  previousKey.secret.fill(0);
  if (offline) {
    const preceding = await observer.readProtectedPolicyAttestation(listener);
    assert.equal(preceding.digest, oldACL.policyHead);
    assert.equal(preceding.projectionVersion, profileRoleAuthorityProjectionVersion);
    // All synthetic devices share the production per-IP request window.
    await delay(60_100);
  }
  const changedRules = { ...proof.rules, [targetRole]: { Allow: null, Deny: ['channel.view'] } };
  const save = () => editor.commitProtectedChannelACL(connection, channelId, proof.kind, proof.policyHead, changedRules);
  await assert.rejects(save(), /synthetic lost ACL commit response/);
  assert.deepEqual(await save(), { channelId, revision: proof.revision + 1 });
  assert.ok(!(await member.readProtectedRuntimeState(target)).channels.some(channel => channel.id === channelId));
  await assert.rejects(editor.readProtectedChannelACL(connection, channelId), { code: 'POLICY_ATTESTATION_UNAVAILABLE' });
  const applied = await host.readProtectedOwnerPolicy(owner);
  newPolicy = applied;
  assert.deepEqual(applied.snapshot.Channels[channelId].ACL, { Roles: changedRules, Profiles: personal });
  if (!offline) {
    await host.syncProtectedPolicyAttestations(owner);
    assert.deepEqual((await editor.readProtectedChannelACL(connection, channelId)).rules, changedRules);
  }
  const rotate = () => editor.rotateProtectedRuntimeText(connection, channelId, 'live');
  for (const alter of [task => { task.roleViewDeny.effect.excludedProfiles = [connection.profileId]; }, task => {
    const openings = offline ? task.roleViewDeny.survivorOpenings : task.rotationProfileOpenings;
    const first = openings[connection.profileId];
    first.contentSalt = `${first.contentSalt[0] === '0' ? '1' : '0'}${first.contentSalt.slice(1)}`;
  }]) {
    alterClaim = alter;
    try {
      await assert.rejects(rotate(), error => {
        if (error.code !== 'INVALID_CHANNEL_POLICY_PROOF') throw error;
        return true;
      });
    } finally { alterClaim = undefined; }
    assert.equal(liveCommits, 0, 'invalid role or group evidence must stop publication of replacement keys');
  }
  await rotate();
  assert.equal(liveClaims, 3);
  assert.equal(liveCommits, 1);
  const currentKey = await editor.loadProtectedRuntimeKey(connection, channelId, 'live', { policyTrust: connection.policyTrust });
  currentKey.secret.fill(0);
  assert.equal(currentKey.record.Generation, previousKey.record.Generation + 1);
  assert.notEqual(currentKey.record.KeyID, previousKey.record.KeyID);
  await assert.rejects(member.loadProtectedRuntimeKey(target, channelId, 'live', { policyTrust: target.policyTrust }),
    { code: 'PROTECTED_ACCESS_DENIED' });
  if (offline) {
    assert.deepEqual(currentKey.record, markedLive);
    const observedKey = await observer.loadProtectedRuntimeKey(listener, channelId, 'live', { policyTrust: listener.policyTrust });
    observedKey.secret.fill(0);
    assert.deepEqual(observedKey.record, markedLive);
    const text = 'Synthetic message encrypted during the offline role deny';
    const message = await editor.withCurrentProtectedChatPolicy(connection, options =>
      editor.sendProtectedRuntimeText(connection, channelId, text, randomBytes(16).toString('hex'), options));
    const page = await observer.readProtectedChatPage(listener, channelId, 0);
    assert.deepEqual(page.messages.map(entry => [entry.position, entry.text]), [[message.Position, text]]);
    assert.ok(roleDeliveries > 0 && roleAuthors > 0);
    await assert.rejects(observer.readProtectedPolicyAttestation(listener), { code: 'POLICY_ATTESTATION_UNAVAILABLE' });
    console.log('PASS v16 owner-offline named-role deny rotates a marked live key and an independent limited reader opens new text');
    return;
  }
  await commit({ Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
    Roles: prev.Roles, Order: prev.Order, Assignments: { [connection.profileId]: [] },
  } });
  assert.equal((await editor.readProtectedRuntimeState(connection)).channels.find(channel => channel.id === channelId).canInspectACL, undefined);
  await assert.rejects(editor.readProtectedChannelACL(connection, channelId), { code: 'PROTECTED_ACCESS_DENIED' });
  console.log('PASS v16 scoped role deny rejects altered exclusion and group evidence, then rotates only for the exact retained recipients');
}

async function checkScopedRevisionAudience(fetcher, host, owner, channelId, { offline, roleDeny }) {
  const scoped = (url, options) => {
    assert.notEqual(new URL(url).pathname, '/api/v3/policy/proofs', 'ordinary devices must stay on scoped policy');
    return fetcher(url, options);
  };
  const revisions = `/api/v3/history/revision/${channelId}/`;
  const archiveDelivery = `/api/v3/keys/current/${channelId}/archive`;
  const archiveLinks = `/api/v3/keys/archive/${channelId}/links/`;
  const archiveCommit = `/api/v3/keys/rotate/${channelId}/archive/commit`;
  const liveCommit = `/api/v3/keys/rotate/${channelId}/live/commit`;
  const claimRoot = `/api/v3/keys/rotate/${channelId}/`;
  const denyField = roleDeny ? 'roleViewDeny' : 'personalDeny';
  const deniedRole = roleDeny && randomBytes(16).toString('hex');
  let position, author, eligible, excluded, removed, attestation, predecessor, alterBasis;
  let markedArchive, markedLive, fullReaderArchive, fullReaderDelivery, publishedRevision, deliveredRevision;
  const roleTransitionDigests = {};
  let basisReads = 0, revisionWrites = 0;
  const recipients = () => offline ? [author, eligible] : [eligible];
  const editor = createClient(async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    if (offline) {
      assert.notEqual(pathname, archiveDelivery, 'limited author cannot request an archive key to edit');
      assert.ok(!pathname.startsWith(archiveLinks), 'limited author must use the public archive wrap key');
    }
    if (position && pathname === `${revisions}${position}` && options.method === 'PUT') {
      publishedRevision = JSON.parse(options.body);
      const { packages } = publishedRevision;
      assert.deepEqual(packages.map(({ id }) => id), recipients().map(recipient => recipient.deviceId).sort());
      revisionWrites++;
    }
    const response = await scoped(url, options);
    if (!position || !response.ok || pathname !== `${revisions}${position}/basis`) return response;
    basisReads++;
    assert.equal(searchParams.get('scoped'), '1');
    const basis = await response.json();
    assert.equal(basis.position, position);
    assert.equal(basis.policyRevision, attestation.revision);
    assert.equal(basis.policyDigest, attestation.policyDigest);
    assert.deepEqual(basis.recipients.map(({ id }) => id), recipients().map(recipient => recipient.deviceId).sort());
    const grouped = offline ? basis[denyField].groupedAudience : basis.groupedAudience;
    assert.deepEqual(grouped.profiles, Object.fromEntries(recipients().map(recipient => [recipient.deviceId, recipient.profileId])));
    assert.deepEqual(Object.keys(grouped.openings).sort(), recipients().map(recipient => recipient.profileId).sort());
    for (const { salt, contentSalt } of Object.values(grouped.openings)) {
      assert.match(salt, /^[a-f0-9]{64}$/);
      assert.match(contentSalt, /^[a-f0-9]{64}$/);
    }
    if (offline) {
      const deny = basis[denyField];
      assert.equal(deny.previousRevision, predecessor.revision);
      assert.equal(deny.previousHead, predecessor.digest);
      assert.equal(deny.successorHead, attestation.digest);
      assert.equal(deny.previousTextPolicy.recipient.statement.id, author.deviceId);
      assert.equal(deny.previousTextPolicy.recipient.statement.archive, false);
      assert.equal(deny.previousSignerTextPolicy.recipient.statement.id, rotationReader.deviceId);
      assert.deepEqual(basis.archive.Record, markedArchive);
      assert.match(basis.archive.Record.ArchiveWrapKey, /^[a-f0-9]{64}$/);
      if (roleDeny) {
        assert.equal(deny.effect.roleId, deniedRole);
        assert.deepEqual(deny.effect.excludedProfiles, [removed.profileId]);
        assert.deepEqual(Object.keys(deny.removedGroups), [removed.profileId]);
        const group = deny.removedGroups[removed.profileId];
        assert.deepEqual(Object.keys(group).sort(), ['digest', 'salt']);
        assert.match(group.digest, /^[a-f0-9]{64}$/);
        assert.equal(roleViewDenyDigest(markedArchive, deny), markedArchive.ArchiveTransitionDigest);
      } else {
        assert.equal(deny.targetProfileId, removed.profileId);
        assert.deepEqual(Object.keys(deny.removedGroup).sort(), ['digest', 'salt']);
      }
    }
    const { groupedAudienceProof, rotation } = offline ? basis[denyField].previousTextPolicy : basis.authorPolicy;
    assert.match(rotation.limitedProfiles, /^[a-f0-9]{64}$/);
    assert.match(groupedAudienceProof.salt, /^[a-f0-9]{64}$/);
    assert.equal(groupedAudienceProof.siblings.length, 53);
    assert.ok(groupedAudienceProof.siblings.every(digest => /^[a-f0-9]{64}$/.test(digest)));
    alterBasis?.(basis);
    return Response.json(basis);
  });
  const verifyCompactDelivery = async (url, options, recipient) => {
    const response = await scoped(url, options);
    const { pathname, searchParams } = new URL(url);
    if (offline && position && pathname === `${revisions}${position}` && response.ok) {
      assert.equal(searchParams.get('scoped'), '1');
      const delivery = await response.clone().json();
      const deny = delivery[denyField];
      assert.equal(deny.previousHead, predecessor.digest);
      assert.equal(deny.successorHead, attestation.digest);
      assert.equal(deny.previousTextPolicy.recipient.statement.id, author.deviceId);
      for (const field of ['groupedAudience', 'removedGroup', 'removedGroups']) assert.ok(!Object.hasOwn(deny, field));
      if (recipient) {
        deliveredRevision = delivery.record;
        assert.equal(deny.previousRecipientPolicy.recipient.statement.id, recipient.deviceId);
        assert.equal(delivery.package.id, recipient.deviceId);
      } else {
        assert.ok(!Object.hasOwn(deny, 'previousRecipientPolicy') && !Object.hasOwn(delivery, 'package'));
      }
    }
    return response;
  };
  const limited = createClient((url, options) => verifyCompactDelivery(url, options, eligible));
  const late = createClient(scoped);
  const removedClient = offline && createClient(scoped);
  const rotator = offline && createClient(async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === liveCommit || pathname === archiveCommit) {
      const { Record: record } = JSON.parse(options.body);
      if (pathname === liveCommit) markedLive = record;
      else markedArchive = record;
      if (roleDeny) {
        const digest = record.Purpose === 'live' ? record.LiveTransitionDigest : record.ArchiveTransitionDigest;
        assert.equal(digest, roleTransitionDigests[record.Purpose]);
      }
    }
    const response = await scoped(url, options);
    if (roleDeny && response.ok && [claimRoot + 'live/claim', claimRoot + 'archive/claim'].includes(pathname)) {
      assert.equal(searchParams.get('scoped'), '1');
      const task = await response.clone().json();
      const deny = task.roleViewDeny;
      assert.deepEqual(deny.effect.excludedProfiles, [removed.profileId]);
      if (task.Purpose === 'archive') assert.deepEqual(deny.removedGroups, {});
      else assert.deepEqual(Object.keys(deny.removedGroups), [removed.profileId]);
      roleTransitionDigests[task.Purpose] = roleViewDenyDigest(task, deny);
    }
    return response;
  });
  const observer = offline && createClient(async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    const response = await verifyCompactDelivery(url, options);
    if (pathname === archiveDelivery && response.ok) {
      assert.equal(searchParams.get('scoped'), '1');
      const packet = await response.clone().json();
      fullReaderDelivery = packet;
      fullReaderArchive = packet.Epoch.Record;
      if (roleDeny && markedArchive) {
        const witness = packet.archiveRoleViewDeny;
        assert.equal(witness.previousTextPolicy.recipient.statement.id, archiveReader.deviceId);
        assert.equal(witness.previousSignerTextPolicy.recipient.statement.id, rotationReader.deviceId);
        assert.equal(roleViewDenyDigest(fullReaderArchive, witness), markedArchive.ArchiveTransitionDigest);
      }
    }
    return response;
  });
  const join = async (client, nickname) => {
    const { link } = await host.createProtectedInvite(owner);
    await client.redeemProtectedInvite(link, nickname);
    return client.openStoredProtectedRuntime(owner.serverId);
  };
  author = await join(editor, 'Ordinary revision author');
  eligible = await join(limited, 'Eligible limited reader');
  let rotationReader, archiveReader;
  if (offline) {
    removed = await join(removedClient, 'Removed limited reader');
    rotationReader = await join(rotator, 'Ordinary archive rotator');
    archiveReader = await join(observer, 'Independent archive reader');
    // The independent clients share the production loopback quota.
    await delay(60_100);
  }
  if (roleDeny) {
    const editorRole = randomBytes(16).toString('hex');
    const { snapshot } = await host.readProtectedOwnerPolicy(owner);
    const grant = { Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
      Roles: { ...snapshot.Roles, [deniedRole]: { Grants: [] }, [editorRole]: { Grants: ['channel.access.edit'] } },
      Order: [...(snapshot.Order ?? []), deniedRole, editorRole],
      Assignments: { [rotationReader.profileId]: [editorRole], [removed.profileId]: [deniedRole] },
    } };
    const preview = await host.previewProtectedRuntimePolicy(owner, grant, owner.policyTrust);
    await host.commitProtectedRuntimePolicy(owner, { preview, intent: grant, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
  }
  const fullProfiles = offline ? [rotationReader, archiveReader] : [author];
  const intent = { Action: 'channel.acl.update', OperationID: randomBytes(16).toString('hex'), ResourceChange: {
    ID: channelId, ACL: { Roles: { '@everyone': { Allow: null, Deny: ['history.full'] } },
      Profiles: Object.fromEntries(fullProfiles.map(({ profileId }) => [profileId, { Allow: ['history.full'], Deny: null }])) },
  } };
  await host.readProtectedOwnerPolicy(owner);
  const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
  assert.equal(preview.draft.TextProjectionVersion, profileRoleAuthorityProjectionVersion);
  await host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
  await host.syncProtectedPolicyAttestations(owner);
  await host.rotateProtectedRuntimeText(owner, channelId, 'live');
  const send = text => editor.withCurrentProtectedChatPolicy(author, options =>
    editor.sendProtectedRuntimeText(author, channelId, text, randomBytes(16).toString('hex'), options));
  const originalText = 'Original message for the first limited reader';
  ({ Position: position } = await send(originalText));
  excluded = await join(late, 'Later limited reader');
  await host.syncProtectedPolicyAttestations(owner);
  await host.rotateProtectedRuntimeText(owner, channelId, 'live');
  const previousArchive = await host.rotateProtectedRuntimeText(owner, channelId, 'archive');
  let oldArchivePrivateKey;
  if (roleDeny) {
    const { record, secret } = await host.loadProtectedRuntimeKey(owner, channelId, 'archive', { policyTrust: owner.policyTrust });
    try {
      assert.equal(record.KeyID, previousArchive.keyId);
      oldArchivePrivateKey = archiveRevisionPrivateKey(owner.serverId, record, secret);
    } finally {
      secret.fill(0);
    }
  }
  const unavailable = { code: 'POLICY_ATTESTATION_UNAVAILABLE' };
  if (offline) {
    predecessor = await editor.readProtectedPolicyAttestation(author);
    assert.equal(predecessor.projectionVersion, profileRoleAuthorityProjectionVersion);
    assert.deepEqual((await removedClient.readProtectedChatPage(removed, channelId, 0)).messages.map(message => message.text), [originalText]);
    await delay(60_100);
    if (roleDeny) {
      const basis = await rotator.readProtectedChannelACL(rotationReader, channelId);
      assert.equal(basis.policyHead, predecessor.digest);
      await rotator.commitProtectedChannelACL(rotationReader, channelId, basis.kind, basis.policyHead,
        { ...basis.rules, [deniedRole]: { Allow: null, Deny: ['channel.view'] } });
    } else {
      const basis = await host.readProtectedChannelPersonalACL(owner, channelId, removed.profileId);
      await host.commitProtectedChannelPersonalACL(owner, channelId, removed.profileId, basis.policyHead, 'channel.view', 'deny');
    }
    await host.refreshProtectedRuntimePolicy(owner, owner.policyTrust);
    const head = await host.policyCheckpoint().load(owner.policyTrust);
    attestation = { revision: head.revision, digest: head.digest, policyDigest: head.resultDigest };
    assert.equal(attestation.revision, predecessor.revision + 1);
    await assert.rejects(editor.readProtectedPolicyAttestation(author), unavailable);
    // The policy actor retains priority over the ordinary rotator for five seconds.
    if (!roleDeny) await delay(5300);
    const live = await rotator.rotateProtectedRuntimeText(rotationReader, channelId, 'live');
    const archive = await rotator.rotateProtectedRuntimeText(rotationReader, channelId, 'archive');
    assert.match(markedLive.LiveTransitionDigest, /^[a-f0-9]{64}$/);
    assert.match(markedArchive.ArchiveTransitionDigest, /^[a-f0-9]{64}$/);
    assert.equal(markedArchive.ArchiveThrough, live.generation);
    assert.equal(markedArchive.Generation, previousArchive.generation + 1);
    assert.equal(markedArchive.KeyID, archive.keyId);
  } else {
    attestation = await editor.readProtectedPolicyAttestation(author);
    assert.equal(attestation.projectionVersion, profileRoleAuthorityProjectionVersion);
  }
  const markerText = 'New message shared with both limited readers';
  const marker = await send(markerText);

  const editedText = 'Edited message for the first limited reader';
  const operationId = randomBytes(16).toString('hex');
  const edit = () => editor.editProtectedChatMessage(author, channelId, position, 1, operationId, editedText);
  const flip = value => `${value[0] === '0' ? '1' : '0'}${value.slice(1)}`;
  const invalidAudience = 'UNVERIFIED_EPOCH_RECIPIENTS';
  const mutations = roleDeny ? [
    [basis => { const group = basis.roleViewDeny.removedGroups[removed.profileId]; group.digest = flip(group.digest); }, invalidAudience],
    [basis => { const proof = basis.roleViewDeny.previousTextPolicy.groupedAudienceProof; proof.salt = flip(proof.salt); }, invalidAudience],
  ] : offline ? [[basis => { delete basis.personalDeny; }, unavailable.code],
    [basis => { const opening = basis.personalDeny.groupedAudience.openings[eligible.profileId]; opening.contentSalt = flip(opening.contentSalt); }, invalidAudience]]
    : [[basis => { basis.groupedAudience.profiles[eligible.deviceId] = excluded.profileId; }, invalidAudience],
      [basis => { basis.authorPolicy.groupedAudienceProof.salt = flip(basis.authorPolicy.groupedAudienceProof.salt); }, invalidAudience]];
  for (const [alter, code] of mutations) {
    alterBasis = alter;
    try {
      await assert.rejects(edit(), error => {
        if (error.code !== code) throw error;
        return true;
      });
    } finally { alterBasis = undefined; }
    assert.equal(revisionWrites, 0, 'altered grouped evidence must stop before publishing a revision');
  }
  const receipt = await edit();
  assert.equal(receipt.revision, 2);
  assert.equal(receipt.existing, false);
  assert.equal(basisReads, 3);
  assert.equal(revisionWrites, 1);
  const assertEdited = page => {
    assert.equal(page.messages[0]?.revision, 2);
    assert.deepEqual(page.messages.map(message => [message.position, message.text]), [[position, editedText], [marker.Position, markerText]]);
  };
  assertEdited(await limited.readProtectedChatPage(eligible, channelId, 0));
  if (offline) {
    assertEdited(await observer.readProtectedChatPage(archiveReader, channelId, 0));
    assert.deepEqual(fullReaderArchive, markedArchive);
    await assert.rejects(removedClient.readProtectedRuntimeText(removed, channelId), { code: 'PROTECTED_ACCESS_DENIED' });
    await assert.rejects(observer.readProtectedPolicyAttestation(archiveReader), unavailable);
  }
  if (roleDeny) {
    const { packet, packages } = publishedRevision;
    assert.deepEqual(packet, deliveredRevision.packet);
    const { archive: { Record: record }, archiveDigest, originalDigest, policyDigest, policyRevision,
      previousDigest, revision, author: { ProfileID, DeviceID } } = deliveredRevision;
    assert.deepEqual(record, markedArchive);
    const binding = [owner.serverId, channelId, String(position), originalDigest, String(revision), previousDigest,
      operationId, ProfileID, DeviceID, String(policyRevision), policyDigest, String(record.Generation),
      record.KeyID, archiveDigest, record.ArchiveWrapKey];
    const unwrap = (wrapped, privateKey, recipientKey, info) =>
      openKeyPackage(Buffer.from(wrapped, 'base64'), privateKey, Buffer.from(recipientKey, 'hex'), info);
    const archiveInfo = signatureFrame('pawtalk-text-revision-archive-v1', ...binding);
    const unwrapDevice = ({ id, publicKey, ciphertext }, privateKey) =>
      unwrap(ciphertext, privateKey, publicKey, signatureFrame('pawtalk-text-revision-device-v1', ...binding, id, publicKey));
    const continuing = await loadDeviceAgreementKey(limited.credentials, owner.serverId, eligible.deviceId, false);
    const revoked = await loadDeviceAgreementKey(removedClient.credentials, owner.serverId, removed.deviceId, false);
    const newcomer = await loadDeviceAgreementKey(late.credentials, owner.serverId, excluded.deviceId, false);
    const fullReader = await loadDeviceAgreementKey(observer.credentials, owner.serverId, archiveReader.deviceId, false);
    const fullReaderKey = createPublicKey(fullReader).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const rotatorKey = createPublicKey((await rotator.identity()).device).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const secret = openSignedEpochPackage(fullReaderDelivery,
      packageContext(owner.serverId, record, archiveReader.deviceId, fullReaderKey), fullReader,
      { profileId: rotationReader.profileId, deviceId: rotationReader.deviceId, key: rotatorKey });
    let deviceKey, archiveKey;
    try {
      const newArchivePrivateKey = archiveRevisionPrivateKey(owner.serverId, record, secret);
      archiveKey = unwrap(packet.archivePackage, newArchivePrivateKey, record.ArchiveWrapKey, archiveInfo);
      deviceKey = unwrapDevice(packages.find(({ id }) => id === eligible.deviceId), continuing);
      assert.deepEqual(deviceKey, archiveKey);
      assert.throws(() => unwrap(packet.archivePackage, oldArchivePrivateKey, record.ArchiveWrapKey, archiveInfo), /authenticate/i);
      for (const recipientPackage of packages) {
        assert.throws(() => unwrapDevice(recipientPackage, revoked), /authenticate/i);
        assert.throws(() => unwrapDevice(recipientPackage, newcomer), /authenticate/i);
      }
    } finally {
      secret.fill(0);
      archiveKey?.fill(0);
      deviceKey?.fill(0);
    }
  }
  const withheld = await late.readProtectedChatPage(excluded, channelId, 0);
  assert.ok(withheld.first > position);
  assert.deepEqual(withheld.messages.map(message => [message.position, message.text]), [[marker.Position, markerText]]);
  if (offline && !roleDeny) {
    // Reopen under a later current policy using a fresh shared request window.
    await delay(60_100);
    const { snapshot } = await host.readProtectedOwnerPolicy(owner);
    const settings = { ...snapshot.Channels[channelId].Settings, Description: 'Updated after the offline edit' };
    const update = { Action: 'channel.settings.update', OperationID: randomBytes(16).toString('hex'),
      ResourceChange: { ID: channelId, Settings: settings } };
    const next = await host.previewProtectedRuntimePolicy(owner, update, owner.policyTrust);
    const advanced = await host.commitProtectedRuntimePolicy(owner, { preview: next, intent: update,
      expectedResultDigest: next.draft.ResultDigest }, owner.policyTrust);
    assert.equal(advanced.Draft.Revision, attestation.revision + 1);
    assert.equal((await observer.readProtectedPolicyAttestation(archiveReader)).revision, advanced.Draft.Revision);
    await assert.rejects(observer.readProtectedPolicyAttestation(archiveReader, attestation.revision), unavailable);
    const { secret, record } = await observer.loadProtectedRuntimeKey(archiveReader, channelId, 'live', { policyTrust: archiveReader.policyTrust });
    secret.fill(0);
    assert.deepEqual(record, markedLive);
    fullReaderArchive = undefined;
    assertEdited(await observer.readProtectedChatPage(archiveReader, channelId, 0));
    assert.deepEqual(fullReaderArchive, markedArchive);
  }
  console.log(roleDeny
    ? 'PASS owner-offline role deny authenticates the ordinary revision audience and old archive, revoked device and later device keys cannot open the edit'
    : offline
    ? 'PASS v15 ordinary limited author edits with the marked archive public wrap key before owner attestation and both intended readers open it'
    : 'PASS v15 ordinary scoped author verifies the exact grouped revision audience and only the eligible limited reader opens the edit');
}

async function checkScopedArchiveRotation(fetcher, host, owner, channelId, { testPersonalDeny, testRoleDeny, offline, liveOnlyTarget, useRecovery }) {
  const root = `/api/v3/keys/rotate/${channelId}/archive`;
  const rotate = `/api/v3/keys/rotate/${channelId}`;
  const archivePackage = `/api/v3/keys/current/${channelId}/archive`;
  const archiveLinks = `/api/v3/keys/archive/${channelId}/links/`;
  const testDeny = testPersonalDeny || testRoleDeny;
  const deniedRole = testRoleDeny && randomBytes(16).toString('hex');
  let reader, listener, limitedReader, revokedReader, certifiedPolicy, denyPredecessor;
  let tamperOpening = false, claims = 0, commits = 0, archiveReads = 0, deliveredArchiveKey;
  let omitRecoveryProof = false, originalReader, recoveryIdentity, previousArchiveRecord;
  let pendingDirectTargets = 0, recoveryTargetBatches = 0;
  let markedLive, markedArchive, archiveReceipt, expectedLiveDigest, expectedArchiveDigest, alterArchiveDelivery, archiveStartKey;
  const verifyRoleEffect = (witness, purpose) => {
    assert.equal(witness.previousRevision, denyPredecessor.revision);
    assert.equal(witness.previousHead, denyPredecessor.digest);
    assert.equal(witness.successorHead, certifiedPolicy.digest);
    assert.deepEqual(witness.actor, { ProfileID: reader.profileId, DeviceID: reader.deviceId });
    assert.equal(witness.effect.roleId, deniedRole);
    assert.deepEqual(witness.effect.excludedProfiles, [revokedReader.profileId]);
    assert.match(witness.authority.rulesDigest, /^[a-f0-9]{64}$/);
    for (const field of ['rules', 'rulesSalt', 'synchronized']) assert.ok(!Object.hasOwn(witness.authority, field));
    assert.match(witness.previousTextPolicy.rotation[`${purpose}Profiles`], /^[a-f0-9]{64}$/);
  };
  const archiveReader = createClient(async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    assert.notEqual(pathname, '/api/v3/policy/proofs', 'archive reader must stay on scoped policy');
    if (pathname === `${root}/commit`) {
      commits++;
      if (offline) {
        markedArchive = JSON.parse(options.body).Record;
        assert.match(markedArchive.ArchiveTransitionDigest, /^[0-9a-f]{64}$/);
        assert.equal(markedArchive.ArchiveTransitionDigest, expectedArchiveDigest);
        assert.equal(markedArchive.ArchiveThrough, markedLive.Generation);
        const frame = signatureFrame('pawtalk-protected-epoch-archive-transition-v1', owner.serverId, channelId, 'archive',
          reader.profileId, reader.deviceId, markedArchive.TaskID, markedArchive.LeaseID, String(markedArchive.Revision),
          markedArchive.PolicyDigest, String(markedArchive.Generation), markedArchive.PreviousDigest, markedArchive.KeyID,
          markedArchive.PackagesDigest, String(markedArchive.ArchiveThrough), markedArchive.ArchiveLinksDigest,
          markedArchive.ArchiveWrapKey, markedArchive.ArchiveTransitionDigest);
        assert.equal(verify(null, frame, createPublicKey((await archiveReader.identity()).device),
          Buffer.from(markedArchive.Signature, 'base64')), true);
      }
    }
    if (offline && pathname === `/api/v3/keys/rotate/${channelId}/live/commit`) {
      markedLive = JSON.parse(options.body).Record;
      assert.match(markedLive.LiveTransitionDigest, /^[0-9a-f]{64}$/);
      if (testRoleDeny) {
        assert.equal(markedLive.LiveTransitionDigest, expectedLiveDigest);
        assert.equal(verify(null, epochSignatureFrame(owner.serverId, reader.profileId, reader.deviceId, markedLive),
          createPublicKey((await archiveReader.identity()).device), Buffer.from(markedLive.Signature, 'base64')), true);
      }
    }
    const response = await fetcher(url, options);
    if (testRoleDeny && response.ok && pathname === `${rotate}/live/claim`) {
      assert.equal(searchParams.get('scoped'), '1');
      const task = await response.clone().json();
      verifyRoleEffect(task.roleViewDeny, 'live');
      expectedLiveDigest = roleViewDenyDigest(task, task.roleViewDeny);
      assert.equal(task.Recipients[revokedReader.deviceId], undefined);
    }
    if (useRecovery && pathname === `${rotate}/targets` && !response.ok) {
      assert.equal((await response.clone().json()).error?.code, 'PROTECTED_KEY_PENDING');
      pendingDirectTargets++;
    }
    if (useRecovery && pathname === `${rotate}/recovery-targets`) {
      assert.equal(searchParams.get('scoped'), '1');
      if (!response.ok) return response;
      const request = JSON.parse(options.body);
      assert.equal(request.Record.Revision, certifiedPolicy.revision);
      assert.deepEqual(request.Targets.map(target => target.KeyID), [previousArchiveRecord.KeyID, markedLive.KeyID]);
      const deliveries = await response.json();
      const [source, live] = deliveries;
      assert.equal(deliveries.length, 2);
      assert.deepEqual(source.Epoch.Record, previousArchiveRecord);
      assert.ok(source.Epoch.Record.Revision < denyPredecessor.revision);
      assert.equal(source.Package.RecipientID, recoveryIdentity.recoveryId);
      const prior = source.previousRecoveryPolicy;
      assert.equal(prior.revision, denyPredecessor.revision);
      const { id, profileId, kind, publicKey, archive } = prior.recipient.statement;
      assert.deepEqual({ id, profileId, kind, publicKey, archive }, { id: recoveryIdentity.recoveryId,
        profileId: reader.profileId, kind: 'recovery', publicKey: recoveryIdentity.agreementKey, archive: true });
      assert.deepEqual(live.Epoch.Record, markedLive);
      assert.equal(live.Package.RecipientID, reader.deviceId);
      assert.ok(!Object.hasOwn(live, 'previousRecoveryPolicy'));
      recoveryTargetBatches++;
      if (omitRecoveryProof) delete source.previousRecoveryPolicy;
      return Response.json(deliveries);
    }
    if (offline && response.ok && pathname === `${root}/commit`) archiveReceipt = await response.clone().json();
    if (response.ok && pathname.startsWith(archiveLinks)) archiveReads++;
    if (response.ok && pathname === archivePackage) {
      deliveredArchiveKey = (await response.clone().json()).Epoch.Record.KeyID;
    }
    if (!response.ok || pathname !== `${root}/claim`) return response;
    assert.equal(searchParams.get('scoped'), '1');
    const task = await response.json();
    assert.equal(task.Purpose, 'archive');
    assert.equal(task.Revision, certifiedPolicy.revision);
    assert.equal(task.PolicyDigest, certifiedPolicy.policyDigest);
    if (!offline) {
      assert.match(task.textPolicy.rotation.archiveProfiles, /^[0-9a-f]{64}$/);
      assert.notEqual(task.textPolicy.rotation.archiveProfiles, task.textPolicy.rotation.liveProfiles);
      assert.deepEqual(Object.keys(task.rotationProfileOpenings).sort(), [owner.profileId, reader.profileId].sort());
    }
    const recipients = [owner.deviceId, reader.deviceId, ...(offline ? [listener.deviceId] : []),
      ...(useRecovery ? [recoveryIdentity.recoveryId] : [])];
    assert.deepEqual(Object.keys(task.Recipients).sort(), recipients.sort());
    assert.equal(task.Recipients[limitedReader.deviceId], undefined);
    if (useRecovery) {
      assert.equal(searchParams.get('recovery'), '1');
      assert.equal(task.Recipients[originalReader.deviceId], undefined);
      assert.deepEqual(task.openingProofRecipients, [recoveryIdentity.recoveryId]);
    }
    claims++;
    if (testPersonalDeny) {
      const deny = task.archivePersonalDeny;
      assert.ok(deny, 'rotation must prove the relationship with the previous signed archive audience');
      assert.equal(deny.previousRevision, denyPredecessor.revision);
      assert.equal(deny.previousHead, denyPredecessor.digest);
      assert.equal(deny.successorHead, certifiedPolicy.digest);
      assert.equal(deny.targetProfileId, revokedReader.profileId);
      assert.equal(deny.actor.DeviceID, owner.deviceId);
      assert.equal(task.Recipients[revokedReader.deviceId], undefined);
      assert.match(deny.authority.rulesDigest, /^[0-9a-f]{64}$/);
      for (const field of ['rules', 'rulesSalt', 'synchronized']) assert.ok(!Object.hasOwn(deny.authority, field));
      if (liveOnlyTarget) {
        assert.ok(!Object.hasOwn(deny, 'removedGroup'), 'a live-only target has no archive group to remove');
        assert.match(deny.previousTextPolicy.rotation.archiveProfiles, /^[0-9a-f]{64}$/);
        assert.deepEqual(Object.keys(deny.survivorOpenings).sort(), [owner.profileId, reader.profileId, listener.profileId].sort());
        if (tamperOpening) {
          const opening = deny.survivorOpenings[reader.profileId];
          opening.contentSalt = `${opening.contentSalt[0] === '0' ? '1' : '0'}${opening.contentSalt.slice(1)}`;
        }
      } else {
        assert.deepEqual(Object.keys(deny.removedGroup).sort(), ['digest', 'salt']);
        assert.match(deny.removedGroup.digest, /^[0-9a-f]{64}$/);
        assert.match(deny.removedGroup.salt, /^[0-9a-f]{64}$/);
        if (tamperOpening) deny.removedGroup.digest = '0'.repeat(64);
      }
      if (offline) {
        assert.deepEqual(task.ArchiveTargets.map(({ Purpose, Generation, KeyID }) => [Purpose, Generation, KeyID]),
          [['archive', previousArchive.generation, previousArchive.keyId], ['live', markedLive.Generation, markedLive.KeyID]]);
        expectedArchiveDigest = createHash('sha256').update(signatureFrame('pawtalk-protected-archive-personal-deny-v1', channelId,
          String(deny.previousRevision), deny.previousHead, String(task.Revision), deny.successorHead, task.PolicyDigest,
          deny.operationId, deny.actor.ProfileID, deny.actor.DeviceID, deny.targetProfileId, deny.editorProof)).digest('hex');
      }
    } else if (testRoleDeny) {
      const deny = task.roleViewDeny;
      verifyRoleEffect(deny, 'archive');
      assert.deepEqual(Object.keys(deny.survivorOpenings).sort(), [owner.profileId, reader.profileId, listener.profileId].sort());
      assert.deepEqual(Object.keys(deny.removedGroups), [revokedReader.profileId]);
      const removedGroup = deny.removedGroups[revokedReader.profileId];
      assert.deepEqual(Object.keys(removedGroup).sort(), ['digest', 'salt']);
      assert.match(removedGroup.digest, /^[a-f0-9]{64}$/);
      assert.match(removedGroup.salt, /^[a-f0-9]{64}$/);
      assert.deepEqual(task.ArchiveTargets.map(({ Purpose, Generation, KeyID }) => [Purpose, Generation, KeyID]),
        [['archive', previousArchive.generation, previousArchive.keyId], ['live', markedLive.Generation, markedLive.KeyID]]);
      expectedArchiveDigest = roleViewDenyDigest(task, deny);
      assert.notEqual(expectedArchiveDigest, expectedLiveDigest);
      if (tamperOpening) removedGroup.digest = '0'.repeat(64);
    } else if (tamperOpening) {
      const opening = task.rotationProfileOpenings[reader.profileId];
      opening.contentSalt = `${opening.contentSalt[0] === '0' ? '1' : '0'}${opening.contentSalt.slice(1)}`;
    }
    return Response.json(task);
  });
  const observer = offline && createClient(async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    assert.notEqual(pathname, '/api/v3/policy/proofs', 'independent archive reader must stay on scoped policy');
    const response = await fetcher(url, options);
    if (!response.ok) return response;
    if (pathname.startsWith(archiveLinks)) {
      assert.equal(searchParams.get('scoped'), '1');
      archiveStartKey ??= pathname.slice(archiveLinks.length);
      archiveReads++;
    }
    if (pathname !== archivePackage || !markedArchive) return response;
    assert.equal(searchParams.get('scoped'), '1');
    const delivery = await response.json();
    assert.deepEqual(delivery.Epoch.Record, markedArchive);
    const witness = testRoleDeny ? delivery.archiveRoleViewDeny : delivery.archivePersonalDeny;
    assert.ok(witness, 'offline archive package must carry the narrow reader witness');
    assert.equal(witness.previousHead, denyPredecessor.digest);
    assert.equal(witness.successorHead, certifiedPolicy.digest);
    assert.equal(witness.previousTextPolicy.recipient.statement.id, listener.deviceId);
    assert.equal(witness.previousSignerTextPolicy.recipient.statement.id, reader.deviceId);
    if (testRoleDeny) {
      verifyRoleEffect(witness, 'archive');
      assert.equal(roleViewDenyDigest(markedArchive, witness), expectedArchiveDigest);
      for (const field of ['survivorOpenings', 'removedGroups']) assert.ok(!Object.hasOwn(witness, field));
    }
    deliveredArchiveKey = delivery.Epoch.Record.KeyID;
    alterArchiveDelivery?.(delivery.Epoch.Record);
    return Response.json(delivery);
  });
  const limited = createClient((url, options) => {
    assert.notEqual(new URL(url).pathname, '/api/v3/policy/proofs', 'limited reader must stay on scoped policy');
    return fetcher(url, options);
  });
  const removed = testDeny && createClient((url, options) => {
    assert.notEqual(new URL(url).pathname, '/api/v3/policy/proofs', 'excluded reader must stay on scoped policy');
    return fetcher(url, options);
  });
  const join = async (client, name) => {
    const { link } = await host.createProtectedInvite(owner);
    await client.redeemProtectedInvite(link, name);
    return client.openStoredProtectedRuntime(owner.serverId);
  };
  const send = text => host.withCurrentProtectedChatPolicy(owner, options =>
    host.sendProtectedRuntimeText(owner, channelId, text, randomBytes(16).toString('hex'), options));
  const oldText = 'Synthetic history before either archive test device joined';
  const old = await send(oldText);
  const former = useRecovery && createClient((url, options) => {
    assert.notEqual(new URL(url).pathname, '/api/v3/policy/proofs', 'original reader must stay on scoped policy');
    return fetcher(url, options);
  });
  reader = await join(former || archiveReader, 'Scoped archive reader');
  if (testDeny && !liveOnlyTarget) revokedReader = await join(removed, 'Full-history target');
  if (offline) listener = await join(observer, 'Independent archive reader');
  await host.rotateProtectedRuntimeText(owner, channelId, 'live');
  let previousArchive = await host.rotateProtectedRuntimeText(owner, channelId, 'archive');
  limitedReader = await join(limited, 'Synthetic limited reader');
  if (liveOnlyTarget) revokedReader = await join(removed, 'Live-only target');
  if (testRoleDeny) {
    const editorRole = randomBytes(16).toString('hex');
    const { snapshot } = await host.readProtectedOwnerPolicy(owner);
    const grant = { Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
      Roles: { ...snapshot.Roles, [deniedRole]: { Grants: [] }, [editorRole]: { Grants: ['channel.access.edit'] } },
      Order: [...(snapshot.Order ?? []), deniedRole, editorRole],
      Assignments: { [reader.profileId]: [editorRole], [revokedReader.profileId]: [deniedRole] },
    } };
    const preview = await host.previewProtectedRuntimePolicy(owner, grant, owner.policyTrust);
    await host.commitProtectedRuntimePolicy(owner, { preview, intent: grant, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
  }
  const limitedProfiles = [limitedReader.profileId, ...(liveOnlyTarget ? [revokedReader.profileId] : [])];
  const intent = { Action: 'channel.acl.update', OperationID: randomBytes(16).toString('hex'), ResourceChange: {
    ID: channelId, ACL: { Roles: null, Profiles: Object.fromEntries(limitedProfiles.map(profile => [profile,
      { Allow: null, Deny: ['history.full'] }])) },
  } };
  await host.readProtectedOwnerPolicy(owner);
  const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
  assert.equal(preview.draft.TextProjectionVersion, profileRoleAuthorityProjectionVersion);
  await host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
  await host.syncProtectedPolicyAttestations(owner);
  let recoveryBundle, recoveryCode;
  if (useRecovery) {
    originalReader = reader;
    recoveryCode = createMigrationRecoveryCode();
    recoveryBundle = former.prepareRecoveryBundle(originalReader, recoveryCode);
    recoveryIdentity = deriveRecoveryIdentity(recoveryCode, owner.serverId, originalReader.profileId);
    const prior = await former.readProtectedPolicyAttestation(originalReader);
    await former.enrollProtectedRuntimeRecovery(originalReader, recoveryCode, prior.digest);
    await host.syncProtectedPolicyAttestations(owner);
  }
  let previousLive;
  if (offline) {
    previousLive = await host.rotateProtectedRuntimeText(owner, channelId, 'live');
    previousArchive = await host.rotateProtectedRuntimeText(owner, channelId, 'archive');
    assert.equal(previousArchive.through, previousLive.generation);
    if (liveOnlyTarget) {
      const context = { policyTrust: revokedReader.policyTrust };
      const priorLive = await removed.loadProtectedRuntimeKey(revokedReader, channelId, 'live', context);
      priorLive.secret.fill(0);
      assert.equal(priorLive.record.KeyID, previousLive.keyId);
      await assert.rejects(removed.loadProtectedRuntimeKey(revokedReader, channelId, 'archive', context),
        { code: 'PROTECTED_ACCESS_DENIED' });
      const priorPage = await removed.readProtectedChatPage(revokedReader, channelId, 0);
      assert.ok(priorPage.first > old.Position);
      assert.deepEqual(priorPage.messages, []);
    }
    // All fixture devices share the normal IP quota. Keep the offline
    // transition and archive reads in the next request window.
    await delay(60_100);
    if (useRecovery) {
      const { secret, record } = await former.loadProtectedRuntimeKey(originalReader, channelId, 'archive', { policyTrust: originalReader.policyTrust });
      secret.fill(0);
      assert.equal(record.KeyID, previousArchive.keyId);
      previousArchiveRecord = record;
      assert.equal((await former.confirmProtectedRuntimeRecovery(originalReader, recoveryCode)).ready, true);
      reader = await archiveReader.recoverProtectedDeviceFromBundle(recoveryBundle);
      assert.equal(reader.profileId, originalReader.profileId);
      assert.notEqual(reader.deviceId, originalReader.deviceId);
      await host.syncProtectedPolicyAttestations(owner);
    }
  }
  if (testDeny) {
    if (!liveOnlyTarget) {
      const entitled = await removed.loadProtectedRuntimeKey(revokedReader, channelId, 'archive', { policyTrust: revokedReader.policyTrust });
      entitled.secret.fill(0);
      assert.equal(entitled.record.KeyID, previousArchive.keyId);
    }
    denyPredecessor = await archiveReader.readProtectedPolicyAttestation(reader);
    if (testRoleDeny) {
      const basis = await archiveReader.readProtectedChannelACL(reader, channelId);
      assert.equal(basis.policyHead, denyPredecessor.digest);
      await archiveReader.commitProtectedChannelACL(reader, channelId, basis.kind, basis.policyHead,
        { ...basis.rules, [deniedRole]: { Allow: null, Deny: ['channel.view'] } });
    } else {
      const basis = await host.readProtectedChannelPersonalACL(owner, channelId, revokedReader.profileId);
      await host.commitProtectedChannelPersonalACL(owner, channelId, revokedReader.profileId, basis.policyHead, 'channel.view', 'deny');
    }
    if (!offline) await host.syncProtectedPolicyAttestations(owner);
  }
  assert.equal((await archiveReader.readProtectedRuntimeState(reader)).canManageChannels, false);
  const unavailable = { code: 'POLICY_ATTESTATION_UNAVAILABLE' };
  if (offline) {
    await host.refreshProtectedRuntimePolicy(owner, owner.policyTrust);
    const head = await host.policyCheckpoint().load(owner.policyTrust);
    certifiedPolicy = { revision: head.revision, digest: head.digest, policyDigest: head.resultDigest };
    assert.equal(denyPredecessor.projectionVersion, profileRoleAuthorityProjectionVersion);
    assert.equal(certifiedPolicy.revision, denyPredecessor.revision + 1);
    await assert.rejects(archiveReader.readProtectedPolicyAttestation(reader), unavailable);
  } else {
    certifiedPolicy = await archiveReader.readProtectedPolicyAttestation(reader);
    assert.equal(certifiedPolicy.projectionVersion, profileRoleAuthorityProjectionVersion);
    if (testPersonalDeny) assert.equal(certifiedPolicy.previous, denyPredecessor.digest);
  }
  // The owner retains priority for the first five seconds of its policy change.
  if (offline && !testRoleDeny) await delay(5300);
  const newLive = offline ? await archiveReader.rotateProtectedRuntimeText(reader, channelId, 'live')
    : await host.rotateProtectedRuntimeText(owner, channelId, 'live');
  if (offline) assert.equal(newLive.generation, previousLive.generation + 1);
  const recentText = 'Synthetic text during the retained limited interval';
  const recent = offline ? await archiveReader.withCurrentProtectedChatPolicy(reader, options =>
    archiveReader.sendProtectedRuntimeText(reader, channelId, recentText, randomBytes(16).toString('hex'), options)) : await send(recentText);

  const retainedLive = await limited.loadProtectedRuntimeKey(limitedReader, channelId, 'live', { policyTrust: limitedReader.policyTrust });
  retainedLive.secret.fill(0);
  assert.equal(retainedLive.record.KeyID, newLive.keyId);
  if (!offline) await delay(5300);
  await assert.rejects(limited.rotateProtectedRuntimeText(limitedReader, channelId, 'archive'), { code: 'PROTECTED_ROTATION_UNAVAILABLE' });
  tamperOpening = true;
  try {
    await assert.rejects(archiveReader.rotateProtectedRuntimeText(reader, channelId, 'archive'), error => {
      if (error.code !== 'INVALID_CHANNEL_POLICY_PROOF') throw error;
      return true;
    });
  }
  finally { tamperOpening = false; }
  assert.equal(commits, 0, 'altered archive openings must stop before key publication');
  if (useRecovery) {
    omitRecoveryProof = true;
    try {
      await assert.rejects(archiveReader.rotateProtectedRuntimeText(reader, channelId, 'archive'), error => {
        if (error.code !== 'UNVERIFIED_EPOCH_POLICY') throw error;
        return true;
      });
    }
    finally { omitRecoveryProof = false; }
    assert.equal(recoveryTargetBatches, 1);
    assert.equal(commits, 0, 'missing predecessor recovery proof must stop before key publication');
  }
  const rotated = await archiveReader.rotateProtectedRuntimeText(reader, channelId, 'archive');
  assert.equal(claims, useRecovery ? 3 : 2);
  if (useRecovery) {
    assert.equal(pendingDirectTargets, 2);
    assert.equal(recoveryTargetBatches, 2);
  }
  assert.equal(commits, 1);
  assert.equal(rotated.generation, previousArchive.generation + 1);
  assert.notEqual(rotated.keyId, previousArchive.keyId);
  if (offline) {
    assert.equal(markedArchive.KeyID, rotated.keyId);
    assert.deepEqual(archiveReceipt, { generation: markedArchive.Generation, keyId: markedArchive.KeyID,
      signatureDigest: createHash('sha256').update(Buffer.from(markedArchive.Signature, 'base64')).digest('hex') });
    await assert.rejects(observer.readProtectedPolicyAttestation(listener), unavailable);
    if (!testRoleDeny) {
      for (const [tamper, error] of [[record => { delete record.ArchiveTransitionDigest; }, unavailable],
        [record => { record.ArchiveTransitionDigest = '0'.repeat(64); }, { code: 'INVALID_LIVE_PERSONAL_DENY' }]]) {
        alterArchiveDelivery = tamper;
        try {
          await assert.rejects(observer.loadProtectedRuntimeKey(listener, channelId, 'archive', { policyTrust: listener.policyTrust }), error);
        } finally { alterArchiveDelivery = undefined; }
      }
    }
  }
  await assert.rejects(limited.loadProtectedRuntimeKey(limitedReader, channelId, 'archive', { policyTrust: limitedReader.policyTrust }),
    { code: 'PROTECTED_ACCESS_DENIED' });
  if (testDeny) {
    await assert.rejects(removed.loadProtectedRuntimeKey(revokedReader, channelId, 'archive', { policyTrust: revokedReader.policyTrust }),
      { code: 'PROTECTED_ACCESS_DENIED' });
    if (liveOnlyTarget || testRoleDeny) {
      await assert.rejects(removed.loadProtectedRuntimeKey(revokedReader, channelId, 'live', { policyTrust: revokedReader.policyTrust }),
        { code: 'PROTECTED_ACCESS_DENIED' });
    }
  }
  const previousReads = archiveReads;
  const page = () => offline ? observer.readProtectedChatPage(listener, channelId, 0)
    : archiveReader.readProtectedChatPage(reader, channelId, 0);
  assert.deepEqual((await page()).messages.map(({ position, text }) => [position, text]),
    [[old.Position, oldText], [recent.Position, recentText]]);
  assert.equal(deliveredArchiveKey, rotated.keyId);
  assert.ok(archiveReads > previousReads, 'ordinary client opens the pre-invite ciphertext through the archive chain');
  if (offline) assert.equal(archiveStartKey, rotated.keyId);
  const limitedPage = await limited.readProtectedChatPage(limitedReader, channelId, 0);
  assert.ok(limitedPage.first > old.Position);
  assert.deepEqual(limitedPage.messages.map(({ position, text }) => [position, text]), [[recent.Position, recentText]]);
  if (offline) {
    await assert.rejects(observer.readProtectedPolicyAttestation(listener), unavailable);
    await host.syncProtectedPolicyAttestations(owner);
    assert.equal((await observer.readProtectedPolicyAttestation(listener)).digest, certifiedPolicy.digest);
  }
  console.log(testRoleDeny
    ? 'PASS v16 owner-offline named-role deny rotates marked live and archive keys and an independent ordinary reader opens pre-invite history'
    : useRecovery
    ? 'PASS v14 owner-offline scoped archive rotation validates the recovered ordinary reader predecessor proof and preserves older history'
    : liveOnlyTarget
    ? 'PASS v14 owner-offline live-only deny preserves the archive audience and an independent ordinary reader opens older history'
    : offline
    ? 'PASS v14 owner-offline personal deny rotates marked live and archive keys; independent scoped reader opens pre-invite history before successor attestation'
    : testPersonalDeny
    ? 'PASS v14 ordinary scoped archive rotation rejects an altered personal removal commitment and excludes the denied former full-history device'
    : 'PASS v14 ordinary scoped archive rotation rejects altered openings, publishes one exact recipient set and only full-history reader opens older history');
}

async function checkScopedPersonalACL(fetcher, host, owner, channelId, recoveryCode, offline = false) {
  let firstCommit, dropped, personalPosts = 0, alterProof;
  let alterDenyEvidence, denyBasis, denyClaims = 0, liveCommits = 0;
  let expectedTransitionDigest, committedRecord, lostLiveReceipt, exactProofReads = 0, alterDeliveredRecord;
  let independentReadWitness = false;
  let offlineMessagePacket, offlineMessagePosition, mutatePreviousAuthor, verifyOfflineAuthors = false;
  const livePackagePath = `/api/v3/keys/current/${channelId}/live`;
  const liveChatPath = `/api/v3/history/live/${channelId}`;
  const beforeText = 'Synthetic protected text before personal deny';
  const afterText = 'Synthetic protected text before successor attestation';
  const assertReadWitness = (delivery, recipientDeviceId) => {
    const witness = delivery.livePersonalDeny;
    assert.ok(witness, 'offline current package must carry the narrow reader witness');
    assert.deepEqual(delivery.Epoch.Record, committedRecord);
    assert.equal(witness.previousRevision, denyBasis.predecessor.revision);
    assert.equal(witness.previousHead, denyBasis.predecessor.digest);
    assert.equal(witness.successorHead, denyBasis.successor.digest);
    assert.equal(witness.previousTextPolicy.recipient.statement.id, recipientDeviceId);
    assert.equal(witness.previousSignerTextPolicy.recipient.statement.id, denyBasis.surviving.deviceId);
    assert.match(witness.authority.rulesDigest, /^[0-9a-f]{64}$/);
    for (const field of ['rules', 'rulesSalt', 'synchronized']) assert.ok(!Object.hasOwn(witness.authority, field));
    for (const field of ['survivorOpenings', 'removedGroup', 'Recipients']) assert.ok(!Object.hasOwn(witness, field));
  };
  const disclosedBypass = new Map();
  const editor = createClient(async (url, options) => {
    const { pathname } = new URL(url);
    assert.notEqual(pathname, '/api/v3/policy/proofs', 'personal ACL editor must stay on scoped policy');
    if (options.method === 'POST' && pathname === `/api/v3/policy/channel-acl/${channelId}/personal`) personalPosts++;
    if (offline && committedRecord && options.method === 'POST' && pathname === liveChatPath) {
      assert.equal(offlineMessagePacket, undefined);
      assert.ok(!options.body.includes(afterText), 'protected write sends ciphertext');
      offlineMessagePacket = JSON.parse(options.body);
      assert.equal(offlineMessagePacket.KeyID, committedRecord.KeyID);
    }
    const response = await fetcher(url, options);
    if (offline && committedRecord && response.ok && pathname === livePackagePath) {
      assertReadWitness(await response.clone().json(), denyBasis.delegate.deviceId);
      independentReadWitness = true;
    }
    if (pathname.startsWith(`/api/v3/policy/channel-acl/${channelId}/personal/`) && response.ok) {
      const disclosed = await response.json();
      disclosedBypass.set(disclosed.profileId, disclosed.rankBasis.target.bypassesACL);
      alterProof?.(disclosed.rankBasis.target);
      return new Response(JSON.stringify(disclosed), { status: 200 });
    }
    if (options.method === 'POST' && pathname === `/api/v3/policy/channel-acl/${channelId}/personal` && response.ok) {
      if (!dropped) {
        firstCommit = options.body;
        dropped = await response.clone().json();
        throw Error('synthetic lost personal ACL receipt');
      }
      if (JSON.parse(options.body).rule === 'deny') {
        assert.equal(options.body, firstCommit);
        assert.deepEqual(await response.clone().json(), dropped);
      }
    }
    return response;
  });
  const member = createClient(fetcher);
  const survivor = createClient(async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    assert.notEqual(pathname, '/api/v3/policy/proofs', 'ordinary live rotator must stay on scoped policy');
    if (offline && options.method === 'POST' && pathname === liveChatPath) assert.fail('read-only ordinary device must stop before POST');
    const commitsLive = options.method === 'POST' && pathname === `/api/v3/keys/rotate/${channelId}/live/commit`;
    if (commitsLive) {
      liveCommits++;
      const { Record: record } = JSON.parse(options.body);
      assert.match(record.LiveTransitionDigest, /^[0-9a-f]{64}$/);
      assert.equal(record.LiveTransitionDigest, expectedTransitionDigest);
      const frame = signatureFrame('pawtalk-protected-epoch-live-transition-v1', owner.serverId, channelId, 'live',
        denyBasis.surviving.profileId, denyBasis.surviving.deviceId, record.TaskID, record.LeaseID, String(record.Revision),
        record.PolicyDigest, String(record.Generation), record.PreviousDigest, record.KeyID, record.PackagesDigest,
        String(record.ArchiveThrough), record.ArchiveLinksDigest, record.LiveTransitionDigest);
      assert.equal(verify(null, frame, createPublicKey((await survivor.identity()).device), Buffer.from(record.Signature, 'base64')), true);
      committedRecord = record;
    }
    const response = await fetcher(url, options);
    if (verifyOfflineAuthors && response.ok && pathname === liveChatPath) {
      assert.equal(searchParams.get('scoped'), '1');
      const page = await response.json();
      for (const message of page.messages.filter(row => row.Position === offlineMessagePosition)) {
        assert.equal(message.Generation, committedRecord.Generation);
        assert.equal(message.Author.DeviceID, denyBasis.delegate.deviceId);
        const proof = message.previousAuthorPolicy;
        assert.ok(proof, 'new message must carry predecessor author evidence');
        assert.equal(proof.revision, denyBasis.predecessor.revision);
        assert.equal(proof.policyDigest, denyBasis.predecessor.policyDigest);
        assert.equal(proof.recipient.statement.id, denyBasis.delegate.deviceId);
        assert.equal(proof.recipient.statement.canSend, true);
        mutatePreviousAuthor?.(message);
      }
      return Response.json(page);
    }
    if (commitsLive && response.ok) {
      assert.equal(lostLiveReceipt, undefined, 'the exact signed live record must be committed once');
      lostLiveReceipt = await response.json();
      assert.deepEqual(lostLiveReceipt, { generation: committedRecord.Generation, keyId: committedRecord.KeyID,
        signatureDigest: createHash('sha256').update(Buffer.from(committedRecord.Signature, 'base64')).digest('hex') });
      throw Error('synthetic lost signed live rotation receipt');
    }
    if (lostLiveReceipt && response.ok && pathname === `/api/v3/keys/proofs/${channelId}/live`) {
      const proofs = await response.clone().json();
      const accepted = proofs.find(proof => proof.Record.Generation === committedRecord.Generation);
      if (accepted) {
        assert.deepEqual(accepted.Record, committedRecord);
        assert.equal(accepted.Principal.DeviceID, denyBasis.surviving.deviceId);
        exactProofReads++;
      }
    }
    if (committedRecord && (offline || alterDeliveredRecord) && response.ok && pathname === livePackagePath) {
      const delivery = await response.json();
      assert.deepEqual(delivery.Epoch.Record, committedRecord);
      if (offline) assertReadWitness(delivery, denyBasis.surviving.deviceId);
      alterDeliveredRecord?.(delivery.Epoch.Record);
      return Response.json(delivery);
    }
    if (denyBasis && response.ok && pathname === `/api/v3/keys/rotate/${channelId}/live/claim`) {
      assert.equal(searchParams.get('scoped'), '1');
      const task = await response.json();
      const evidence = task.livePersonalDeny;
      assert.ok(evidence, 'rotation must carry actual LivePersonalDeny evidence');
      assert.equal(evidence.previousRevision, denyBasis.predecessor.revision);
      assert.equal(evidence.previousHead, denyBasis.predecessor.digest);
      assert.equal(evidence.successorHead, denyBasis.successor.digest);
      assert.equal(evidence.targetProfileId, denyBasis.target.profileId);
      assert.equal(evidence.actor.DeviceID, denyBasis.delegate.deviceId);
      assert.equal(task.Recipients[denyBasis.target.deviceId], undefined);
      assert.match(evidence.authority.rulesDigest, /^[0-9a-f]{64}$/);
      for (const field of ['rules', 'rulesSalt', 'synchronized']) assert.ok(!Object.hasOwn(evidence.authority, field));
      assert.deepEqual(Object.keys(evidence.removedGroup).sort(), ['digest', 'salt']);
      assert.match(evidence.removedGroup.digest, /^[0-9a-f]{64}$/);
      assert.match(evidence.removedGroup.salt, /^[0-9a-f]{64}$/);
      expectedTransitionDigest = createHash('sha256').update(signatureFrame('pawtalk-protected-live-personal-deny-v1', channelId,
        String(evidence.previousRevision), evidence.previousHead, String(task.Revision), evidence.successorHead, task.PolicyDigest,
        evidence.operationId, evidence.actor.ProfileID, evidence.actor.DeviceID, evidence.targetProfileId, evidence.editorProof)).digest('hex');
      denyClaims++;
      const delivered = structuredClone(task);
      alterDenyEvidence?.(delivered.livePersonalDeny);
      return Response.json(delivered);
    }
    return response;
  });
  const invite = async (client, name) => {
    const { link } = await host.createProtectedInvite(owner);
    await client.redeemProtectedInvite(link, name);
    return client.openStoredProtectedRuntime(owner.serverId);
  };
  const delegate = await invite(editor, 'Synthetic personal ACL editor');
  const target = await invite(member, 'Synthetic personal ACL subject');
  const surviving = await invite(survivor, 'Synthetic ordinary live rotator');
  const administrator = createClient(fetcher);
  const admin = await invite(administrator, 'Synthetic lower Administrator');
  await administrator.enrollProtectedRuntimeRecovery(admin, recoveryCode);
  await delay(5300);
  await host.serviceProtectedRuntimeRotations(owner);
  await host.serviceProtectedRuntimeRotations(owner);
  assert.equal((await administrator.confirmProtectedRuntimeRecovery(admin, recoveryCode)).ready, true);
  const commit = async intent => {
    await host.readProtectedOwnerPolicy(owner);
    const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
    return host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
  };
  const { snapshot } = await host.readProtectedOwnerPolicy(owner);
  const role = randomBytes(16).toString('hex');
  const adminRole = randomBytes(16).toString('hex');
  await commit({ Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
    Roles: { ...snapshot.Roles, [role]: { Grants: ['channel.access.edit'] }, [adminRole]: { Grants: ['server.administrator'] } },
    Order: [...(snapshot.Order ?? []), adminRole, role], Assignments: { [delegate.profileId]: [role], [admin.profileId]: [adminRole] },
  } });
  const savedElsewhere = { Allow: ['message.send'], Deny: null };
  const RoleRules = { '@everyone': { Allow: null, Deny: ['message.send'] } };
  await commit({ Action: 'channel.acl.update', OperationID: randomBytes(16).toString('hex'), ResourceChange: { ID: channelId,
    ACL: { Roles: RoleRules, Profiles: { [delegate.profileId]: savedElsewhere } },
  } });
  await host.syncProtectedPolicyAttestations(owner);
  assert.equal((await survivor.readProtectedRuntimeState(surviving)).channels.find(channel => channel.id === channelId)?.canInspectACL, undefined);
  const predecessor = await survivor.readProtectedPolicyAttestation(surviving);
  assert.equal(predecessor.projectionVersion, profileRoleAuthorityProjectionVersion);
  const previous = await survivor.loadProtectedRuntimeKey(surviving, channelId, 'live', { policyTrust: surviving.policyTrust });
  previous.secret.fill(0);
  const previousEpoch = await survivor.readProtectedPolicyAttestation(surviving, previous.record.Revision);
  assert.equal(previousEpoch.policyDigest, previous.record.PolicyDigest);
  const read = profileId => editor.readProtectedChannelPersonalACL(delegate, channelId, profileId);
  for (const denied of [owner.profileId, randomBytes(32).toString('hex')]) {
    await assert.rejects(read(denied), { code: 'PROTECTED_ACCESS_DENIED' });
  }
  const initial = await read(target.profileId);
  assert.equal(initial.rules, null);
  assert.equal(disclosedBypass.get(target.profileId), false);
  assert.equal((await read(admin.profileId)).rules, null);
  assert.equal(disclosedBypass.get(admin.profileId), true);
  const edit = (basis, rule) => editor.commitProtectedChannelPersonalACL(delegate, channelId, target.profileId,
    basis.policyHead, 'channel.view', rule);
  for (const alter of [proof => { proof.rank++; }, proof => { proof.bypassesACL = true; }, proof => { delete proof.bypassesACL; }]) {
    alterProof = alter;
    try { await assert.rejects(edit(initial, 'deny'), { code: 'INVALID_PROFILE_RANK_PROOF' }); }
    finally { alterProof = undefined; }
  }
  assert.equal(personalPosts, 0, 'tampered authorization evidence must stop the mutation before POST');
  // All fixture devices share one loopback IP quota. Start the deny and
  // rotation together in a fresh request window, before starting the grace clock.
  await delay(60_100);
  const send = text => editor.withCurrentProtectedChatPolicy(delegate, options =>
    editor.sendProtectedRuntimeText(delegate, channelId, text, randomBytes(16).toString('hex'), options));
  let beforeMessage;
  if (offline) {
    const previousEditorKey = await editor.loadProtectedRuntimeKey(delegate, channelId, 'live', { policyTrust: delegate.policyTrust });
    previousEditorKey.secret.fill(0);
    assert.equal(previousEditorKey.record.KeyID, previous.record.KeyID);
    beforeMessage = await send(beforeText);
    assert.equal(beforeMessage.Existing, false);
  }
  await assert.rejects(edit(initial, 'deny'), /synthetic lost personal ACL receipt/);
  assert.deepEqual(await edit(initial, 'deny'), { channelId, profileId: target.profileId, revision: initial.revision + 1 });
  assert.ok(!(await member.readProtectedRuntimeState(target)).channels.some(channel => channel.id === channelId));
  const committed = await host.readProtectedOwnerPolicy(owner);
  assert.deepEqual(committed.snapshot.Channels[channelId].ACL, { Roles: RoleRules, Profiles: { [delegate.profileId]: savedElsewhere,
    [target.profileId]: { Allow: null, Deny: ['channel.view'] } } });
  const assertNoSuccessorAttestation = () => assert.rejects(survivor.readProtectedPolicyAttestation(surviving),
    { code: 'POLICY_ATTESTATION_UNAVAILABLE' });
  let successor = committed;
  if (offline) await assertNoSuccessorAttestation();
  else {
    await host.syncProtectedPolicyAttestations(owner);
    successor = await survivor.readProtectedPolicyAttestation(surviving);
    assert.equal(successor.previous, predecessor.digest);
  }
  assert.equal(successor.revision, predecessor.revision + 1);
  denyBasis = { predecessor, successor, target, delegate, surviving };
  await delay(5300);
  const rotate = () => survivor.rotateProtectedRuntimeText(surviving, channelId, 'live');
  for (const [tamper, code] of [[proof => {
    const signature = Buffer.from(proof.editorProof, 'base64url');
    signature[0] ^= 1;
    proof.editorProof = signature.toString('base64url');
  }, 'INVALID_PROTECTED_CHANNEL_ACL_EDIT'], [proof => { proof.removedGroup.digest = '0'.repeat(64); }, 'INVALID_CHANNEL_POLICY_PROOF']]) {
    alterDenyEvidence = tamper;
    try { await assert.rejects(rotate(), { code }); }
    finally { alterDenyEvidence = undefined; }
    assert.equal(liveCommits, 0, 'tampered personal deny evidence must stop before committing a live key');
  }
  const rotated = await rotate();
  assert.equal(denyClaims, 3);
  assert.equal(liveCommits, 1);
  assert.ok(lostLiveReceipt && exactProofReads > 0, 'lost response must be reconciled using the exact signed live record');
  assert.equal(rotated.generation, previous.record.Generation + 1);
  assert.notEqual(rotated.keyId, previous.record.KeyID);
  const load = () => survivor.loadProtectedRuntimeKey(surviving, channelId, 'live', { policyTrust: surviving.policyTrust });
  for (const [alter, error] of [[record => { delete record.LiveTransitionDigest; }, 'POLICY_ATTESTATION_UNAVAILABLE'],
    [record => { record.LiveTransitionDigest = '0'.repeat(64); }, 'INVALID_LIVE_PERSONAL_DENY']]) {
    alterDeliveredRecord = alter;
    try { await assert.rejects(load(), offline ? { code: error } : /INVALID_EPOCH_SIGNATURE/); }
    finally { alterDeliveredRecord = undefined; }
  }
  const loaded = await load();
  loaded.secret.fill(0);
  assert.equal(loaded.record.KeyID, rotated.keyId);
  await assert.rejects(member.loadProtectedRuntimeKey(target, channelId, 'live', { policyTrust: target.policyTrust }),
    { code: 'PROTECTED_ACCESS_DENIED' });
  if (offline) {
    const independent = await editor.loadProtectedRuntimeKey(delegate, channelId, 'live', { policyTrust: delegate.policyTrust });
    independent.secret.fill(0);
    assert.ok(independentReadWitness);
    assert.equal(independent.record.KeyID, rotated.keyId);
    assert.equal((await editor.readProtectedTextStatus(owner.serverId, channelId, delegate)).allowSend, true);
    assert.equal((await survivor.readProtectedTextStatus(owner.serverId, channelId, surviving)).allowSend, false);
    await assert.rejects(survivor.withCurrentProtectedChatPolicy(surviving, options =>
      survivor.sendProtectedRuntimeText(surviving, channelId, 'Synthetic read-only draft', randomBytes(16).toString('hex'), options)),
    { code: 'PROTECTED_ACCESS_DENIED' });
    const sent = await send(afterText);
    offlineMessagePosition = sent.Position;
    verifyOfflineAuthors = true;
    assert.deepEqual(sent, { Position: beforeMessage.Position + 1, Existing: false });
    assert.equal(offlineMessagePacket.KeyID, rotated.keyId);
    const readNew = () => survivor.readProtectedChatPage(surviving, channelId, beforeMessage.Position);
    for (const mutate of [message => { delete message.previousAuthorPolicy; }, message => {
      message.previousAuthorPolicy.inclusion.siblings[0] = '0'.repeat(64);
    }]) {
      let tampered = false;
      mutatePreviousAuthor = message => { tampered = true; mutate(message); };
      try {
        await assert.rejects(readNew(), error => ['UNVERIFIED_EPOCH_POLICY', 'INVALID_CHANNEL_POLICY_PROOF',
          'INVALID_LIVE_PERSONAL_DENY'].includes(error.code));
      } finally { mutatePreviousAuthor = undefined; }
      assert.equal(tampered, true, 'negative read must reach the changed author proof');
    }
    const page = await readNew();
    assert.deepEqual(page.messages.map(({ position, text }) => [position, text]), [[offlineMessagePosition, afterText]]);
    const mixed = await survivor.readProtectedChatPage(surviving, channelId, 0);
    assert.deepEqual(mixed.messages.map(({ position, text }) => [position, text]),
      [[beforeMessage.Position, beforeText], [offlineMessagePosition, afterText]]);
    verifyOfflineAuthors = false;
    await assertNoSuccessorAttestation();
    await assert.rejects(editor.readProtectedPolicyAttestation(delegate), { code: 'POLICY_ATTESTATION_UNAVAILABLE' });
    await host.syncProtectedPolicyAttestations(owner);
    const attestation = await survivor.readProtectedPolicyAttestation(surviving);
    assert.equal(attestation.digest, successor.digest);
    assert.equal(attestation.previous, predecessor.digest);
  }
  const hidden = await read(target.profileId);
  assert.deepEqual(hidden.rules, { Allow: null, Deny: ['channel.view'] });
  assert.equal((await edit(hidden, 'inherit')).revision, hidden.revision + 1);
  const restored = (await host.readProtectedOwnerPolicy(owner)).snapshot.Channels[channelId].ACL;
  assert.deepEqual(restored, { Roles: RoleRules, Profiles: { [delegate.profileId]: savedElsewhere } });
  assert.ok((await member.readProtectedRuntimeState(target)).channels.some(channel => channel.id === channelId));
  console.log(offline
    ? 'PASS owner-offline personal deny rotates once and permits signed text before successor attestation; altered author proofs and revoked device denied'
    : 'PASS delegated personal ACL and ordinary live rotation verify scoped deny evidence, reconcile one signed transition after a lost reply, reject altered delivery and exclude the revoked device');
}

async function checkBulkAdministrator(host, owner, first, second, recoveryCodes) {
  const join = async (client, nickname) => {
    const { link } = await host.createProtectedInvite(owner);
    await client.redeemProtectedInvite(link, nickname);
    return client.openStoredProtectedRuntime(owner.serverId);
  };
  const ready = await join(first, 'Recovery-ready candidate');
  const pending = await join(second, 'Recovery-pending candidate');
  const prepare = async (client, connection, code) => {
    await client.enrollProtectedRuntimeRecovery(connection, code);
    await delay(5300);
    await host.serviceProtectedRuntimeRotations(owner);
    await host.serviceProtectedRuntimeRotations(owner);
    assert.equal((await client.confirmProtectedRuntimeRecovery(connection, code)).ready, true);
  };
  const operationId = () => randomBytes(16).toString('hex');
  const read = () => host.readProtectedOwnerPolicy(owner);
  const preview = intent => host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
  const commit = (intent, draft) => host.commitProtectedRuntimePolicy(owner,
    { preview: draft, intent, expectedResultDigest: draft.draft.ResultDigest }, owner.policyTrust);
  const ordinaryRole = operationId(), administratorRole = operationId();
  const { snapshot: initial } = await read();
  const definitions = { Action: 'roles.update', OperationID: operationId(), RoleUpdate: {
    Roles: { ...initial.Roles, [ordinaryRole]: { Grants: ['channel.edit'] }, [administratorRole]: { Grants: ['server.administrator'] } },
    Order: [...(initial.Order ?? []), ordinaryRole, administratorRole], Assignments: { [ready.profileId]: [ordinaryRole] },
    Presentation: { [ordinaryRole]: { Name: 'Channel editor' }, [administratorRole]: { Name: 'Protected administrator' } },
  } };
  await commit(definitions, await preview(definitions));
  await prepare(first, ready, recoveryCodes[0]);
  const before = await read();
  assert.equal(before.snapshot.RolePresentation[ordinaryRole].Name, 'Channel editor');
  assert.equal(before.snapshot.RolePresentation[administratorRole].Name, 'Protected administrator');
  assert.deepEqual(before.snapshot.Order.slice(-2), [ordinaryRole, administratorRole]);
  assert.equal(before.snapshot.RecoveryReady[ready.profileId], true);
  assert.ok(!before.snapshot.RecoveryReady[pending.profileId]);
  const assignments = { [ready.profileId]: [ordinaryRole, administratorRole], [pending.profileId]: [administratorRole] };
  const bulk = { Action: 'roles.update', OperationID: operationId(), RoleUpdate: {
    Roles: before.snapshot.Roles, Order: before.snapshot.Order, Assignments: assignments,
  } };
  const recoveryRequired = { code: 'PROTECTED_RECOVERY_REQUIRED', details: { recoveryProfiles: [pending.profileId] } };
  await assert.rejects(preview(bulk), recoveryRequired);

  // Exercise the server's commit gate as well as its normal preview gate.
  // Retain the harmless preview's result digest to exercise the readiness gate separately.
  const safe = await preview({ ...bulk, RoleUpdate: { ...bulk.RoleUpdate, Assignments: {} } });
  const update = JSON.parse(Buffer.from(safe.roleUpdate, 'base64').toString('utf8'));
  update.Assignments = Object.fromEntries(Object.keys(assignments).sort().map(profile => [profile, assignments[profile]]));
  const rejected = { ...safe.draft, RoleUpdate: update };
  const actor = { ProfileID: owner.profileId, DeviceID: owner.deviceId };
  const frame = protectedPolicySignatureFrame(owner.serverId, actor, rejected, Buffer.from(JSON.stringify(update)));
  const { device } = await host.identity();
  const body = JSON.stringify({ ...rejected, Signature: sign(null, frame, device).toString('base64') });
  await assert.rejects(host.fetchJSON(owner.base, '/api/v3/policy/commit', { method: 'POST', fingerprint: owner.fingerprint,
    headers: { Authorization: `Bearer ${owner.token}` }, body }), recoveryRequired);
  const afterRejected = await read();
  assert.equal(afterRejected.revision, before.revision);
  assert.equal(afterRejected.digest, before.digest);
  assert.deepEqual(afterRejected.snapshot, before.snapshot);
  assert.equal((await first.readProtectedRuntimeState(ready)).canManageChannels, false);
  assert.equal((await second.readProtectedRuntimeState(pending)).canManageChannels, false);

  await prepare(second, pending, recoveryCodes[1]);
  const afterRecovery = await read();
  assert.equal(afterRecovery.snapshot.RecoveryReady[ready.profileId], true);
  assert.equal(afterRecovery.snapshot.RecoveryReady[pending.profileId], true);
  const canceled = await preview(bulk);
  assert.equal(canceled.draft.PreviousDigest, afterRecovery.digest);
  const afterCancel = await read();
  assert.equal(afterCancel.revision, afterRecovery.revision);
  assert.deepEqual(afterCancel.snapshot.Members, afterRecovery.snapshot.Members);

  const rebuilt = await preview(bulk);
  assert.deepEqual(rebuilt.draft.RoleUpdate, canceled.draft.RoleUpdate);
  const receipt = await commit(bulk, rebuilt);
  assert.deepEqual(await commit(bulk, rebuilt), receipt);
  const applied = await read();
  assert.equal(applied.digest, receipt.Digest);
  assert.equal(applied.revision, afterRecovery.revision + 1);
  for (const [profileId, roles] of Object.entries(assignments)) assert.deepEqual(applied.snapshot.Members[profileId].Roles, roles);
  for (const field of ['Roles', 'Order', 'RolePresentation']) assert.deepEqual(applied.snapshot[field], before.snapshot[field]);
  assert.equal((await first.readProtectedRuntimeState(ready)).canManageChannels, true);
  assert.equal((await second.readProtectedRuntimeState(pending)).canManageChannels, true);
  console.log('PASS DEVICE-06 bulk Administrator assignment rejects all while one candidate lacks recovery, then commits and retries exactly after both are ready');
}

async function checkPolicyAdministrator(host, owner, guest, delegate, channelId, recoveryCode, measure) {
  const { link } = await host.createProtectedInvite(owner);
  await guest.redeemProtectedInvite(link, 'Synthetic Administrator');
  const admin = await guest.openStoredProtectedRuntime(owner.serverId);
  const subordinate = await host.createProtectedInvite(owner);
  const invited = await delegate.redeemProtectedInvite(subordinate.link, 'Synthetic Member');
  const delegatedProfile = invited.profileId;
  const denied = { code: 'PROTECTED_ACCESS_DENIED' };
  await assert.rejects(guest.readProtectedManagementPolicy(admin), denied);
  assert.equal((await guest.readProtectedRuntimeState(admin)).canManageChannels, false);

  const commit = async (client, connection, intent) => {
    const preview = await client.previewProtectedRuntimePolicy(connection, intent, connection.policyTrust);
    assert.ok(preview.snapshot, 'authorized management changes include a replayable snapshot');
    return client.commitProtectedRuntimePolicy(connection, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, connection.policyTrust);
  };
  const roleId = randomBytes(16).toString('hex');
  const grant = async () => {
    const { snapshot } = await host.readProtectedOwnerPolicy(owner);
    return commit(host, owner, { Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
      Roles: { ...snapshot.Roles, [roleId]: { Grants: ['server.administrator'] } },
      Order: [...(snapshot.Order ?? []), roleId], Assignments: { [admin.profileId]: [roleId] },
    } });
  };
  await assert.rejects(grant(), { code: 'PROTECTED_RECOVERY_REQUIRED' });
  await guest.enrollProtectedRuntimeRecovery(admin, recoveryCode);
  await new Promise(resolve => setTimeout(resolve, 5300));
  await host.serviceProtectedRuntimeRotations(owner);
  await host.serviceProtectedRuntimeRotations(owner);
  assert.equal((await guest.confirmProtectedRuntimeRecovery(admin, recoveryCode)).ready, true);
  await host.syncProtectedPolicyAttestations(owner);
  const publicText = 'Synthetic everyone channel before promotion';
  await host.withCurrentProtectedChatPolicy(owner, async options => {
    for (let index = 0; index < 32; index++) {
      await host.sendProtectedRuntimeText(owner, channelId, `${publicText} ${index}`, randomBytes(16).toString('hex'), options);
      if ((index + 1) % 5 === 0) await delay(1010);
    }
  });
  const publicPage = await measure(async () => {
    const window = await guest.readProtectedHistoryWindow(admin, channelId);
    return guest.readProtectedChatPage(admin, channelId, Math.max(window.first - 1, window.last - 32), window.cursor);
  });
  assert.equal(publicPage.result.messages.length, 32);
  assert.equal(publicPage.result.messages.at(-1)?.text, `${publicText} 31`);
  assert.ok(publicPage.elapsed < 1000, `everyone chat opened in ${publicPage.elapsed} ms (${publicPage.requests.length} requests)`);
  console.log(`PASS everyone text in ${publicPage.elapsed} ms with 45 ms of added latency per request`);

  const mediaChannel = randomBytes(16).toString('hex');
  await host.readProtectedOwnerPolicy(owner);
  await commit(host, owner, { Action: 'channel.create', OperationID: randomBytes(16).toString('hex'), ResourceChange: {
    ID: mediaChannel, Channel: { Kind: 'text',
      Settings: { Name: 'Synthetic protected media', Description: '', SlowmodeSeconds: 0, VoiceCapacity: 0 } },
    ACL: { Roles: { '@everyone': { Allow: null, Deny: ['channel.view'] } }, Profiles: null },
  } });
  await host.serviceProtectedRuntimeRotations(owner);
  assert.ok(!(await guest.readProtectedRuntimeState(admin)).channels.some(channel => channel.id === mediaChannel));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5e8AAAAASUVORK5CYII=', 'base64');
  const files = [
    { name: 'Photo.png', mime: 'image/png', bytes: png },
    { name: 'Clip.webm', mime: 'video/webm', bytes: Buffer.alloc(8 * 1024 * 1024, 1), poster: { mime: 'image/png', bytes: png } },
    { name: 'Voice.webm', mime: 'audio/webm', bytes: Buffer.from('synthetic voice bytes'), voice: { duration: 1, waveform: [0.2, 0.5] } },
  ];
  const operationId = randomBytes(16).toString('hex');
  const ids = [];
  for (const [index, file] of files.entries()) ids.push(await host.stageProtectedAttachment(owner, mediaChannel, operationId, index, file));
  const receipt = await host.withCurrentProtectedChatPolicy(owner, options => host.sendProtectedRuntimeText(owner, mediaChannel,
    'Mixed media before role assignment', operationId, options, undefined, undefined, undefined, ids));
  await assert.rejects(guest.readProtectedFile(admin, mediaChannel, receipt.Position, ids[0]), denied);
  await grant();

  const state = await guest.readProtectedRuntimeState(admin);
  assert.equal(state.canManageChannels, true);
  assert.equal(state.canManageScopeAuthority, false);
  assert.ok(state.channels.some(channel => channel.id === mediaChannel));
  await host.serviceProtectedRuntimeRotations(owner);
  await host.serviceProtectedRuntimeRotations(owner);
  await guest.readProtectedManagementPolicy(admin);
  // Keep the durable checkpoint and clear the in-memory state, as on a client restart.
  guest.protectedPolicyCheckpoint = new ProtectedPolicyCheckpoint(guest.credentials);
  const history = await measure(() => guest.readProtectedChatPage(admin, mediaChannel, 0));
  assert.ok(history.elapsed < 1000, `private chat opened in ${history.elapsed} ms (${history.requests.length} requests)`);
  assert.equal(history.policyOffsets.filter(after => after === '0').length, 1, 'archive reads replay the pinned policy chain only once');
  const message = history.result.messages.find(row => row.position === receipt.Position);
  assert.equal(message?.text, 'Mixed media before role assignment');
  assert.deepEqual(message.files.map(file => file.id), ids);
  const poster = message.files[1].poster.id;
  const previews = await measure(() => Promise.all([ids[0], poster].map(id => guest.readProtectedFile(admin, mediaChannel, receipt.Position, id))));
  assert.ok(previews.elapsed < 500, `previews loaded in ${previews.elapsed} ms`);
  assert.ok(previews.requests.every(path => !/\/history\/(live|imported)\//.test(path)), 'previews must reuse verified message metadata');
  assert.deepEqual(previews.result.map(bytes => Buffer.from(bytes)), [png, png]);
  console.log(`PASS private text in ${history.elapsed} ms and two previews in ${previews.elapsed} ms with 45 ms of added latency per request`);
  const eventLoop = monitorEventLoopDelay({ resolution: 5 });
  let fullVideoFinished = false;
  const { result: media } = await measure(async () => {
    eventLoop.enable();
    const read = id => guest.readProtectedFile(admin, mediaChannel, receipt.Position, id);
    try {
      const video = read(ids[1]).then(bytes => { fullVideoFinished = true; return bytes; });
      const thumbnail = read(poster).then(bytes => {
        assert.equal(fullVideoFinished, false, 'thumbnail finishes during the video download');
        return bytes;
      });
      return await Promise.all([read(ids[0]), video, read(ids[2]), thumbnail]);
    } finally { eventLoop.disable(); }
  });
  assert.deepEqual(media.map(bytes => Buffer.from(bytes)), [...files.map(file => file.bytes), png]);
  const eventLoopMax = Math.round(eventLoop.max / 1e6);
  assert.ok(eventLoopMax < 150, `Electron main event loop stalled for ${eventLoopMax} ms`);
  console.log(`PASS video download leaves previews responsive; Electron main loop max delay ${eventLoopMax} ms`);
  console.log('PASS granting Administrator opens historical photos, video, its poster and voice recordings');
  await assert.rejects(guest.readProtectedOwnerPolicy(admin), denied);
  const { snapshot } = await guest.readProtectedManagementPolicy(admin);
  const settings = { ...snapshot.Channels[channelId].Settings, Description: 'Signed while the owner is offline' };
  const changed = await commit(guest, admin, { Action: 'channel.settings.update', OperationID: randomBytes(16).toString('hex'),
    ResourceChange: { ID: channelId, Settings: settings } });
  const applied = await guest.readProtectedManagementPolicy(admin);
  assert.equal(applied.digest, changed.Digest);
  assert.deepEqual(applied.snapshot.Channels[channelId].Settings, settings);
  const managedRole = randomBytes(16).toString('hex');
  const createAndAssign = profileId => ({ Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
    Roles: { ...applied.snapshot.Roles, [managedRole]: { Grants: ['channel.edit'] } },
    Order: [managedRole, ...applied.snapshot.Order], Assignments: { [profileId]: [managedRole] },
  } });
  await assert.rejects(commit(guest, admin, createAndAssign(owner.profileId)), denied);
  await commit(guest, admin, createAndAssign(delegatedProfile));
  const assignments = await guest.readProtectedManagementPolicy(admin);
  assert.deepEqual(assignments.snapshot.Members[delegatedProfile].Roles, [managedRole]);
  await assert.rejects(guest.publishProtectedPolicyAttestation(admin, assignments.revision), denied);
  await assert.rejects(guest.readProtectedPolicyAttestation(admin), { code: 'POLICY_ATTESTATION_UNAVAILABLE' });

  const updated = (await host.readProtectedOwnerPolicy(owner)).snapshot;
  await commit(host, owner, { Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
    Roles: updated.Roles, Order: updated.Order, Assignments: { [admin.profileId]: [] },
  } });
  assert.equal((await guest.readProtectedRuntimeState(admin)).canManageChannels, false);
  await assert.rejects(guest.readProtectedManagementPolicy(admin), denied);
  await assert.rejects(guest.readProtectedFile(admin, mediaChannel, receipt.Position, ids[0]), denied);
  await host.syncProtectedPolicyAttestations(owner);
  const avatar = `data:image/png;base64,${png.toString('base64')}`;
  const oldAvatarClient = { ...owner, config: { ...owner.config, protectedOwnerProfileAvatar: false } };
  const originalAvatar = await host.saveProtectedProfileAvatar(oldAvatarClient, avatar, 1);
  const readOwner = async () => (await guest.readProtectedRuntimeRoster(admin, channelId)).members.find(profile => profile.owner);
  assert.equal((await readOwner())?.avatar, undefined, 'an older avatar only has a package for the owner');
  const republished = await host.readProtectedProfileAvatar(owner, true);
  assert.equal(republished.revision, originalAvatar.revision + 1);
  assert.equal((await readOwner())?.avatar, avatar, 'ordinary members receive the existing owner avatar');
  await host.saveProtectedProfileAvatar(owner, null, republished.revision);
  assert.equal((await readOwner())?.avatar, undefined, 'clearing the avatar removes it from the roster');
  console.log('PASS an existing owner avatar reaches a second profile and disappears when removed');
  console.log('PASS Administrator replays and signs management policy, cannot attest as owner, and loses full proof access after revocation');
}

async function checkProtectedMessageRetry(host, owner, guest, channelId, operationId, attempts) {
  const text = 'Synthetic protected message with a lost receipt';
  const send = () => host.withCurrentProtectedChatPolicy(owner,
    options => host.sendProtectedRuntimeText(owner, channelId, text, operationId, options));
  await assert.rejects(send(), /synthetic committed protected message response loss/);
  assert.equal(attempts.length, 1);
  const first = attempts[0];
  assert.equal(first.receipt.Existing, false);

  const { link } = await host.createProtectedInvite(owner);
  await guest.redeemProtectedInvite(link, 'Synthetic added recipient');
  await host.serviceProtectedRuntimeRotations(owner);
  await host.serviceProtectedRuntimeRotations(owner);
  const receipt = await send();
  assert.equal(receipt.Existing, true);
  assert.equal(receipt.Position, first.receipt.Position);
  assert.equal(attempts.length, 2);
  const retry = attempts[1].packet;
  assert.equal(retry.OperationID, first.packet.OperationID);
  assert.notEqual(retry.KeyID, first.packet.KeyID, 'the retry uses the new live generation');
  assert.notEqual(retry.Nonce, first.packet.Nonce, 're-encryption uses a fresh nonce');
  assert.notEqual(retry.Ciphertext, first.packet.Ciphertext);
  const raw = await host.readProtectedRuntimeText(owner, channelId, { after: first.receipt.Position - 1 });
  assert.equal(raw.messages.length, 1);
  assert.equal(raw.messages[0].Packet.KeyID, first.packet.KeyID, 'the original message is the only committed record');
  const page = await host.readProtectedChatPage(owner, channelId, first.receipt.Position - 1);
  assert.deepEqual(page.messages.map(message => message.text), [text]);
  console.log('PASS protected message retry after key rotation uses a fresh nonce and returns the original position');
}

async function checkScopeDeviceDetach(fetcher, host, owner, guest, channelId, recoveryCode) {
  const primary = createClient(fetcher), secondary = createClient(fetcher);
  const { link } = await host.createProtectedInvite(owner, { maxUses: 3 });
  await primary.redeemProtectedInvite(link, 'Synthetic retained primary');
  await secondary.redeemProtectedInvite(link, 'Synthetic detachable source');
  await guest.redeemProtectedInvite(link, 'Synthetic scoped member');
  const root = await primary.openStoredProtectedRuntime(owner.serverId);
  const originalSource = await secondary.openStoredProtectedRuntime(owner.serverId);
  const participant = await secondary.makeProtectedProfileParticipant(originalSource);
  const proposal = await primary.prepareProtectedProfileLink(root, participant, true);
  const confirmed = await primary.signProtectedProfileLink(root, proposal.linkCard);
  const signed = await secondary.signProtectedProfileLink(originalSource, confirmed.linkCard);
  await primary.applyProtectedProfileLink(root, signed.linkCard);
  const moved = await secondary.openStoredProtectedRuntime(owner.serverId);
  assert.equal(moved.profileId, root.profileId);
  assert.equal(moved.deviceId, originalSource.deviceId);

  await primary.enrollProtectedRuntimeRecovery(root, recoveryCode);
  // The enrollee has the first five seconds of rotation priority. Let the
  // current owner then publish the enrollee's packages with its existing keys.
  await new Promise(resolve => setTimeout(resolve, 5300));
  await host.serviceProtectedRuntimeRotations(owner);
  await host.serviceProtectedRuntimeRotations(owner);
  assert.equal((await primary.confirmProtectedRuntimeRecovery(root, recoveryCode)).ready, true);
  const offer = await host.offerProtectedOwnership(owner, root.profileId);
  const receipt = await secondary.acceptProtectedOwnership(moved, offer.operationId);
  assert.equal(receipt.ownerProfileId, root.profileId);

  const initial = await primary.readProtectedProfileLinkStatus(root);
  assert.deepEqual(initial.sources, [originalSource.profileId]);
  await assert.rejects(primary.unlinkProtectedProfile(root, originalSource.profileId, initial.policyHead),
    { code: 'PROTECTED_SCOPE_SIGNER_HANDOVER_REQUIRED' });
  const handover = await secondary.offerProtectedScopeDevice(moved, root.deviceId);
  assert.deepEqual(await primary.acceptProtectedScopeDevice(root, handover.offerCard), { signerDeviceId: root.deviceId });
  const current = await primary.readProtectedProfileLinkStatus(root);
  assert.deepEqual(await primary.unlinkProtectedProfile(root, originalSource.profileId, current.policyHead),
    { sourceProfileId: originalSource.profileId });
  await primary.syncProtectedPolicyAttestations(root);
  await assert.rejects(secondary.readProtectedRuntimeState(moved), { code: 'INVALID_PROTECTED_SESSION' });
  await assert.rejects(secondary.openStoredProtectedRuntime(owner.serverId), { code: 'INVALID_PROTECTED_SESSION_PROOF' });

  const scoped = await guest.openStoredProtectedRuntime(owner.serverId);
  const attestation = await guest.readProtectedPolicyAttestation(scoped);
  assert.equal(attestation.signerProfileId, root.profileId);
  assert.equal(attestation.signerDeviceId, root.deviceId);
  assert.ok(attestation.authorityRevision > receipt.revision);
  assert.ok(attestation.revision > attestation.authorityRevision);
  assert.equal((await guest.verifyProtectedRuntimeOwnAdmission(scoped, channelId)).revision, attestation.revision);
  console.log('PASS a linked owner signer blocks detach until handover, then the source loses access and the scoped guest verifies v2');
}

async function checkScopeDeviceHandover(fetcher, host, owner, guest, channelId) {
  let initialAcceptBody, initialReceipt;
  const second = createClient(async (url, options) => {
    const accepts = options.method === 'POST' && new URL(url).pathname === '/api/v3/policy/scope-authority/device';
    if (accepts && initialAcceptBody !== undefined) assert.equal(options.body, initialAcceptBody);
    const response = await fetcher(url, options);
    if (accepts && response.ok) {
      if (initialAcceptBody === undefined) {
        initialAcceptBody = options.body;
        initialReceipt = await response.json();
        throw new Error('synthetic committed scope signer handover response loss');
      }
      assert.deepEqual(await response.clone().json(), initialReceipt);
    }
    return response;
  });
  const challenge = await host.makeProtectedDeviceChallenge(owner);
  const request = await second.makeProtectedDeviceRequest(challenge);
  const { deviceId } = await host.approveProtectedDeviceRequest(owner, request);
  const receiver = await second.finishProtectedDeviceBinding(challenge);
  assert.equal(receiver.deviceId, deviceId);
  assert.equal(receiver.profileId, owner.profileId);
  assert.notEqual(receiver.deviceId, owner.deviceId);

  const { link } = await host.createProtectedInvite(owner);
  await guest.redeemProtectedInvite(link, 'Synthetic scoped member');
  const scoped = await guest.openStoredProtectedRuntime(owner.serverId);
  await host.syncProtectedPolicyAttestations(owner);
  const genesisSigner = await guest.readProtectedPolicyAttestation(scoped);
  assert.equal(genesisSigner.authorityHead, undefined);
  assert.equal(scoped.policyTrust.ownerDeviceId, owner.deviceId);

  const status = await host.readProtectedScopeDeviceStatus(owner);
  assert.equal(status.signerDeviceId, owner.deviceId);
  assert.equal(status.canOffer, true);
  assert.ok(status.candidates.some(candidate => candidate.deviceId === receiver.deviceId));
  const { offerCard } = await host.offerProtectedScopeDevice(owner, receiver.deviceId);
  const preview = await second.previewProtectedScopeDevice(receiver, offerCard);
  assert.equal(preview.signerDeviceId, owner.deviceId);
  assert.equal(preview.targetDeviceId, receiver.deviceId);
  await assert.rejects(second.acceptProtectedScopeDevice(receiver, offerCard), /synthetic committed scope signer handover response loss/);
  assert.deepEqual(await second.acceptProtectedScopeDevice(receiver, offerCard), { signerDeviceId: receiver.deviceId });
  const attestation = await guest.readProtectedPolicyAttestation(scoped);
  assert.equal(attestation.signerDeviceId, receiver.deviceId);
  assert.ok(attestation.authorityRevision > genesisSigner.revision);
  assert.equal((await guest.verifyProtectedRuntimeOwnAdmission(scoped, channelId)).revision, attestation.revision);
  await assert.rejects(host.syncProtectedPolicyAttestations(owner), { code: 'PROTECTED_ACCESS_DENIED' });
  await host.readProtectedOwnerPolicy(owner);
  await assert.rejects(host.publishProtectedPolicyAttestation(owner, attestation.revision), { code: 'PROTECTED_ACCESS_DENIED' });
  assert.equal((await host.readProtectedRuntimeState(owner)).canManageChannels, true);

  const returnOffer = await second.offerProtectedScopeDevice(receiver, owner.deviceId);
  assert.deepEqual(await host.acceptProtectedScopeDevice(owner, returnOffer.offerCard), { signerDeviceId: owner.deviceId });
  const returned = await guest.readProtectedPolicyAttestation(scoped);
  assert.equal(returned.signerDeviceId, owner.deviceId);
  assert.ok(returned.authorityRevision > attestation.authorityRevision);
  assert.notEqual(returned.authorityHead, attestation.authorityHead);
  assert.equal((await guest.verifyProtectedRuntimeOwnAdmission(scoped, channelId)).revision, returned.revision);
  console.log('PASS scope signer handover retries exactly, excludes the prior signer, and keeps v2 after returning to the pinned device');
}

async function checkProfileLinking(fetcher, host, owner, channelId) {
  let alterBindingReceipt = false;
  const member = saved => createClient(async (url, options) => {
    assert.notEqual(new URL(url).pathname, '/api/v3/policy/proofs', 'linking members use scoped policy evidence');
    const response = await fetcher(url, options);
    if (!alterBindingReceipt || !response.ok || !new URL(url).pathname.startsWith('/api/v3/devices/bind/result/')) return response;
    const receipt = await response.json();
    return new Response(JSON.stringify({ ...receipt, approverProof: 'A'.repeat(86) }), {
      status: response.status, headers: response.headers,
    });
  }, saved);
  const secondaryCredentials = new Map();
  const primary = member(), secondary = member(secondaryCredentials);
  const { link } = await host.createProtectedInvite(owner, { maxUses: 2 });
  await primary.redeemProtectedInvite(link, 'Synthetic primary');
  await secondary.redeemProtectedInvite(link, 'Synthetic secondary');
  const root = await primary.openStoredProtectedRuntime(owner.serverId);
  const source = await secondary.openStoredProtectedRuntime(owner.serverId);
  const agreementSlot = `pawtalk:agreement:v1:${owner.serverId}:${source.deviceId}`;
  const originalAgreement = secondaryCredentials.get(agreementSlot);
  assert.ok(originalAgreement, 'the original device agreement is saved');
  const delayed = member();
  const delayedChallenge = await secondary.makeProtectedDeviceChallenge(source);
  const delayedRequest = await delayed.makeProtectedDeviceRequest(delayedChallenge);
  const delayedApproval = await secondary.approveProtectedDeviceRequest(source, delayedRequest);
  assert.notEqual(root.profileId, source.profileId);
  assert.notEqual(root.deviceId, source.deviceId);

  const { snapshot } = await host.readProtectedOwnerPolicy(owner);
  const primaryRole = randomBytes(16).toString('hex'), secondaryRole = randomBytes(16).toString('hex');
  const intent = { Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
    Roles: { ...snapshot.Roles, [primaryRole]: { Grants: ['message.send'] }, [secondaryRole]: { Grants: ['invite.create'] } },
    Order: [...(snapshot.Order ?? []), primaryRole, secondaryRole],
    Assignments: { [root.profileId]: [primaryRole], [source.profileId]: [secondaryRole] },
  } };
  const rolePreview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
  await host.commitProtectedRuntimePolicy(owner, { preview: rolePreview, intent, expectedResultDigest: rolePreview.draft.ResultDigest }, owner.policyTrust);
  assert.equal((await secondary.listProtectedInvites(source)).canCreate, true);
  await assert.rejects(primary.listProtectedInvites(root), { code: 'PROTECTED_ACCESS_DENIED' });

  const participant = await secondary.makeProtectedProfileParticipant(source);
  const proposal = await primary.prepareProtectedProfileLink(root, participant, true);
  assert.equal(proposal.preview.primaryProfileId, root.profileId);
  assert.equal(proposal.preview.secondaryProfileId, source.profileId);
  assert.deepEqual(proposal.preview.primaryRoles, [primaryRole]);
  assert.deepEqual(proposal.preview.secondaryRoles, [secondaryRole]);
  assert.equal(proposal.preview.movedDevices, 2);
  await assert.rejects(primary.applyProtectedProfileLink(root, proposal.linkCard), { code: 'INVALID_PROFILE_LINK_CARD' });
  const consent = await primary.signProtectedProfileLink(root, proposal.linkCard);
  assert.equal(consent.ready, false);
  const review = await secondary.reviewProtectedProfileLink(source, consent.linkCard);
  assert.equal(review.primaryIsLocal, false);
  assert.equal(review.agreed, false);
  assert.deepEqual(review.preview, proposal.preview);
  const signed = await secondary.signProtectedProfileLink(source, consent.linkCard);
  assert.equal(signed.ready, true);
  assert.equal((await primary.reviewProtectedProfileLink(root, signed.linkCard)).ready, true);
  assert.deepEqual(await primary.applyProtectedProfileLink(root, signed.linkCard), { primaryProfileId: root.profileId });
  await assert.rejects(secondary.readProtectedRuntimeState(source), { code: 'INVALID_PROTECTED_SESSION' });
  const linked = await secondary.openStoredProtectedRuntime(owner.serverId);
  assert.equal(linked.profileId, root.profileId);
  assert.equal(linked.deviceId, source.deviceId);
  const delayedBinding = await delayed.finishProtectedDeviceBinding(delayedChallenge);
  assert.equal(delayedBinding.profileId, root.profileId, 'a receipt still matches its device and key after the approved profile moves');
  assert.equal(delayedBinding.deviceId, delayedApproval.deviceId);
  await assert.rejects(secondary.listProtectedInvites(linked), { code: 'PROTECTED_ACCESS_DENIED' });
  const status = await primary.readProtectedProfileLinkStatus(root);
  assert.equal(status.profileId, root.profileId);
  assert.deepEqual(status.sources, [source.profileId]);
  assert.ok((await secondary.readProtectedRuntimeState(linked)).channels.some(channel => channel.id === channelId));
  const joined = await host.readProtectedOwnerPolicy(owner);
  assert.equal(joined.snapshot.Owner, owner.profileId);
  assert.deepEqual(joined.snapshot.Members[root.profileId].Roles, [primaryRole]);
  assert.equal(joined.snapshot.Members[source.profileId].Active, false);
  assert.ok(!(joined.snapshot.Members[source.profileId].Roles?.length));

  assert.deepEqual(await primary.unlinkProtectedProfile(root, source.profileId, status.policyHead), { sourceProfileId: source.profileId });
  assert.deepEqual((await primary.readProtectedProfileLinkStatus(root)).sources, []);
  await assert.rejects(secondary.readProtectedRuntimeState(linked), { code: 'INVALID_PROTECTED_SESSION' });
  await assert.rejects(delayed.readProtectedRuntimeState(delayedBinding), { code: 'INVALID_PROTECTED_SESSION' });
  await assert.rejects(secondary.openStoredProtectedRuntime(owner.serverId), { code: 'INVALID_PROTECTED_SESSION_PROOF' });

  const challenge = await primary.makeProtectedDeviceChallenge(root);
  const request = await secondary.makeProtectedDeviceRequest(challenge);
  const restarted = member(secondaryCredentials);
  assert.equal(await restarted.makeProtectedDeviceRequest(challenge), request, 'a reopened Client keeps the pending binding request');
  assert.ok(secondaryCredentials.get(agreementSlot) === originalAgreement, 'pending binding preserves the previous agreement');
  await assert.rejects(restarted.finishProtectedDeviceBinding(challenge), { code: 'INVALID_PROTECTED_SESSION_PROOF' });
  assert.deepEqual(await primary.approveProtectedDeviceRequest(root, request), { deviceId: source.deviceId });
  alterBindingReceipt = true;
  await assert.rejects(restarted.finishProtectedDeviceBinding(challenge));
  alterBindingReceipt = false;
  assert.ok(secondaryCredentials.get(agreementSlot) === originalAgreement, 'an invalid receipt cannot replace the previous agreement');
  const rebound = await restarted.finishProtectedDeviceBinding(challenge);
  assert.equal(rebound.deviceId, source.deviceId);
  assert.equal(rebound.profileId, root.profileId);
  assert.ok(secondaryCredentials.get(agreementSlot) !== originalAgreement, 'an approved rebind promotes the fresh agreement');
  assert.equal((await restarted.finishProtectedDeviceBinding(challenge)).deviceId, source.deviceId, 'finishing twice is safe');
  assert.deepEqual((await primary.readProtectedProfileLinkStatus(root)).sources, [source.profileId]);
  await assert.rejects(restarted.listProtectedInvites(rebound), { code: 'PROTECTED_ACCESS_DENIED' });
  const reboundPolicy = (await host.readProtectedOwnerPolicy(owner)).snapshot;
  assert.equal(reboundPolicy.Members[source.profileId].Active, false);
  assert.ok(!(reboundPolicy.Members[source.profileId].Roles?.length));
  assert.notEqual(reboundPolicy.KeyRecipients[rebound.deviceId].PublicKey, joined.snapshot.KeyRecipients[linked.deviceId].PublicKey);
  console.log('PASS linked profiles detach and rebind the same device with a verified fresh key and only primary profile rights');
}

async function checkDeviceBinding(host, owner, applicant, channelId, originalText) {
  const before = await host.readProtectedOwnerPolicy(owner);
  const challenge = await host.makeProtectedDeviceChallenge(owner);
  const request = await applicant.makeProtectedDeviceRequest(challenge);
  const preview = host.previewProtectedDeviceRequest(owner, request);
  assert.notEqual(preview.deviceId, owner.deviceId);
  await assert.rejects(applicant.finishProtectedDeviceBinding(challenge), { code: 'INVALID_PROTECTED_SESSION_PROOF' });
  await assert.rejects(host.approveProtectedDeviceRequest(owner, request), /synthetic committed device binding response loss/);
  assert.deepEqual(await host.approveProtectedDeviceRequest(owner, request), { deviceId: preview.deviceId });
  const bound = await applicant.finishProtectedDeviceBinding(challenge);
  assert.equal(bound.profileId, owner.profileId);
  assert.equal(bound.deviceId, preview.deviceId);
  assert.notEqual(bound.token, owner.token);
  assert.equal((await host.readProtectedRuntimeState(owner)).profileId, owner.profileId);
  assert.equal((await applicant.readProtectedRuntimeState(bound)).canManageChannels, true);
  const after = await host.readProtectedOwnerPolicy(owner);
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.snapshot.Members, before.snapshot.Members);
  assert.deepEqual(after.snapshot.PolicyDevices[owner.deviceId], before.snapshot.PolicyDevices[owner.deviceId]);
  assert.deepEqual(after.snapshot.KeyRecipients[owner.deviceId], before.snapshot.KeyRecipients[owner.deviceId]);
  assert.equal(after.snapshot.PolicyDevices[bound.deviceId].ProfileID, owner.profileId);
  assert.notEqual(after.snapshot.KeyRecipients[bound.deviceId].PublicKey, after.snapshot.KeyRecipients[owner.deviceId].PublicKey);
  for (let pass = 0; pass < 2; pass++) await host.serviceProtectedRuntimeRotations(owner);
  for (const purpose of ['live', 'archive']) {
    const opened = await applicant.withCurrentProtectedChatPolicy(bound,
      options => applicant.loadProtectedRuntimeKey(bound, channelId, purpose, options));
    try { assert.equal(opened.record.Purpose, purpose); }
    finally { opened.secret.fill(0); }
  }
  const history = await applicant.readProtectedChatPage(bound, channelId, 0);
  assert.ok(history.messages.some(message => message.text === originalText));
  const text = 'Synthetic second-device text';
  await applicant.withCurrentProtectedChatPolicy(bound,
    options => applicant.sendProtectedRuntimeText(bound, channelId, text, randomBytes(16).toString('hex'), options));
  const oldDevice = await host.readProtectedChatPage(owner, channelId, 0);
  assert.ok(oldDevice.messages.some(message => message.text === text));
  console.log('PASS ordinary device binding retries exactly and both separate devices retain the same profile and protected text access');
}

async function checkOwnerTransfer(host, owner, guest, visitor, recoveryCode, firstAcceptanceReceipt, recoveryFetcher) {
  let original;
  if (!recoveryFetcher) {
    await assert.rejects(host.offerProtectedOwnership(owner, visitor.profileId), { code: 'PROTECTED_RECOVERY_REQUIRED' });
    original = await host.readProtectedOwnerPolicy(owner);
  }
  await guest.enrollProtectedRuntimeRecovery(visitor, recoveryCode);
  // The enrolling guest has the first five seconds to rotate. The old owner
  // can then prepare packages using the current verified channel policy.
  await new Promise(resolve => setTimeout(resolve, 5300));
  await host.serviceProtectedRuntimeRotations(owner);
  await host.serviceProtectedRuntimeRotations(owner);
  assert.equal((await guest.confirmProtectedRuntimeRecovery(visitor, recoveryCode)).ready, true);

  if (!recoveryFetcher) {
    const canceled = await host.offerProtectedOwnership(owner, visitor.profileId);
    const pending = await guest.readProtectedOwnershipOffer(visitor);
    assert.equal(pending.ownerProfileId, owner.profileId);
    assert.equal(pending.offer.operationId, canceled.operationId);
    assert.equal((await guest.readProtectedRuntimeState(visitor)).canManageChannels, false);
    assert.equal(await host.cancelProtectedOwnership(owner, canceled.operationId), true);
    await assert.rejects(guest.acceptProtectedOwnership(visitor, canceled.operationId), { code: 'PROTECTED_POLICY_CHANGED' });
    console.log('PASS owner transfer requires prepared recovery and leaves the old owner in place until acceptance');
  }

  const offer = await host.offerProtectedOwnership(owner, visitor.profileId);
  await assert.rejects(guest.acceptProtectedOwnership(visitor, offer.operationId), /synthetic committed owner acceptance response loss/);
  const receipt = await guest.acceptProtectedOwnership(visitor, offer.operationId);
  assert.deepEqual(receipt, firstAcceptanceReceipt(), 'exact retry must return the original policy receipt');
  assert.equal(receipt.ownerProfileId, visitor.profileId);
  if (recoveryFetcher) {
    const replacement = createClient(recoveryFetcher);
    const recovered = await replacement.recoverProtectedDeviceFromBundle(guest.prepareRecoveryBundle(visitor, recoveryCode));
    assert.equal(recovered.profileId, visitor.profileId);
    assert.notEqual(recovered.deviceId, visitor.deviceId);
    assert.equal((await replacement.readProtectedRuntimeState(recovered)).canManageChannels, true);
    await assert.rejects(guest.readProtectedRuntimeState(visitor), { code: 'INVALID_PROTECTED_SESSION' });
    await replacement.syncProtectedPolicyAttestations(recovered);
    const attestation = await host.readProtectedPolicyAttestation(owner);
    assert.equal(attestation.authorityRevision, receipt.revision + 1);
    assert.equal(attestation.signerProfileId, visitor.profileId);
    assert.equal(attestation.signerDeviceId, recovered.deviceId);
    console.log('PASS the successor owner recovers on a replacement device, which becomes the scoped policy signer');
    return;
  }
  await guest.syncProtectedPolicyAttestations(visitor);
  assert.equal((await guest.readProtectedRuntimeState(visitor)).canManageChannels, true);
  const transferred = await guest.readProtectedOwnerPolicy(visitor);
  assert.equal(transferred.snapshot.Owner, visitor.profileId);
  assert.deepEqual(transferred.snapshot.Members[owner.profileId].Roles, original.snapshot.Members[owner.profileId].Roles);
  assert.deepEqual(transferred.snapshot.Members[visitor.profileId].Roles, original.snapshot.Members[visitor.profileId].Roles);

  const status = await retryAfterFixtureQuota(() => host.readProtectedOwnershipOffer(owner));
  assert.equal(status.ownerProfileId, visitor.profileId);
  assert.equal(status.offer, null);
  assert.equal((await host.readProtectedRuntimeState(owner)).canManageChannels, false);
  await assert.rejects(host.readProtectedOwnerPolicy(owner), { code: 'PROTECTED_ACCESS_DENIED' });
  await assert.rejects(host.fetchJSON(owner.base, '/api/v3/policy/proofs', {
    fingerprint: owner.fingerprint, headers: { Authorization: `Bearer ${owner.token}` },
  }), { code: 'PROTECTED_ACCESS_DENIED' });
  const attestation = await host.readProtectedPolicyAttestation(owner);
  assert.equal(attestation.authorityHead, status.authorityHead);
  assert.equal(attestation.authorityRevision, receipt.revision);
  assert.equal(attestation.signerDeviceId, visitor.deviceId);
  assert.equal(owner.policyTrust.ownerDeviceId, owner.deviceId);
  console.log('PASS ownership acceptance retries exactly, old owner loses privileged access, and scoped policy verifies the new signer');
  const { ownership, ownershipFloorLoaded, ...reopened } = owner;
  const fetchJSON = host.fetchJSON;
  host.fetchJSON = async function (base, request, options) {
    if (request === '/api/v3/state') {
      return { Channels: [], Events: [], OwnerProfileID: owner.profileId, PolicyRevision: original.revision };
    }
    return fetchJSON.call(this, base, request, options);
  };
  try {
    await assert.rejects(host.readProtectedRuntimeState(reopened), { code: 'POLICY_ROLLBACK' });
  } finally {
    host.fetchJSON = fetchJSON;
  }
  console.log('PASS a reopened session rejects old owner metadata using its saved ownership checkpoint');
}

async function checkRecoveryReplacement(fetcher, host, owner, channelId, [oldCode, newCode]) {
  const oldPackages = new Map();
  const confirmPath = '/api/v3/recovery/confirm';
  const challengePath = '/api/v3/recovery/confirmation-challenge';
  const packagePrefix = `/api/v3/recovery/packages/${channelId}/`;
  let capture = true, replayPackage = false, oldChallenge, oldProof, packageReplays = 0, confirmations = 0;
  const member = createClient(async (url, options) => {
    const { pathname } = new URL(url);
    if (pathname === confirmPath) confirmations++;
    const response = await fetcher(url, options);
    if (!response.ok) return response;
    if (capture && pathname === challengePath) oldChallenge = await response.clone().json();
    if (capture && pathname === confirmPath) oldProof = JSON.parse(options.body);
    if (pathname.startsWith(packagePrefix)) {
      if (capture) oldPackages.set(pathname, await response.clone().json());
      if (replayPackage) {
        assert.ok(oldPackages.has(pathname), 'fixture must replay a genuinely issued package');
        packageReplays++;
        await response.body?.cancel();
        return Response.json(oldPackages.get(pathname));
      }
    }
    return response;
  });
  const { link } = await host.createProtectedInvite(owner);
  await member.redeemProtectedInvite(link, 'Synthetic recovery replacement');
  const connection = await member.openStoredProtectedRuntime(owner.serverId);
  const rotate = async () => {
    // Let the recovery enrollment's initial rotation priority expire.
    await delay(5300);
    for (let pass = 0; pass < 2; pass++) await host.serviceProtectedRuntimeRotations(owner);
  };
  const oldEnrollment = await member.enrollProtectedRuntimeRecovery(connection, oldCode);
  await rotate();
  assert.equal((await member.confirmProtectedRuntimeRecovery(connection, oldCode)).ready, true);
  capture = false;
  assert.equal(oldChallenge.recoveryId, oldEnrollment.recoveryId);
  assert.equal(oldProof.recoveryId, oldEnrollment.recoveryId);
  assert.equal(oldPackages.size, 2);
  for (const { Package: packet } of oldPackages.values()) {
    assert.equal(packet.RecipientID, oldEnrollment.recoveryId);
    assert.equal(Buffer.from(packet.Ciphertext, 'base64').length, 144);
  }
  const original = await host.readProtectedOwnerPolicy(owner);
  const oldIdentity = original.snapshot.RecoveryIdentities[connection.profileId];
  assert.equal(original.snapshot.RecoveryReady[connection.profileId], true);
  const replacement = await member.enrollProtectedRuntimeRecovery(connection, newCode);
  const replaced = await host.readProtectedOwnerPolicy(owner);
  assert.equal(replaced.revision, original.revision + 1);
  assert.equal(replaced.snapshot.RecoveryIdentities[connection.profileId].ID, replacement.recoveryId);
  assert.equal(replaced.snapshot.RecoveryReady?.[connection.profileId] ?? false, false);
  assert.equal(replaced.snapshot.KeyRecipients[oldIdentity.ID], undefined);
  assert.equal(replaced.snapshot.RetiredRecipientKeys[oldIdentity.AgreementKey], true);
  assert.equal(replaced.snapshot.RetiredRecoverySigningKeys[oldIdentity.SigningKey], true);
  assert.deepEqual(replaced.snapshot.PolicyDevices, original.snapshot.PolicyDevices);
  assert.deepEqual(replaced.snapshot.KeyRecipients[connection.deviceId], original.snapshot.KeyRecipients[connection.deviceId]);
  const pending = await member.readProtectedRecoveryCoverage(connection);
  assert.equal(pending.recoveryId, replacement.recoveryId);
  assert.equal(pending.items.length, 2);
  assert.ok(pending.items.every(item => item.pending));

  const stale = prepareProtectedRecoveryConfirmation(connection, oldChallenge, randomBytes(16).toString('hex'),
    deriveRecoveryIdentity(oldCode, connection.serverId, connection.profileId), await member.identity(), oldProof.items);
  await assert.rejects(member.fetchJSON(connection.base, confirmPath, { method: 'POST', body: JSON.stringify(stale),
    fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` } }), { code: 'PROTECTED_POLICY_CHANGED' });
  assert.equal((await host.readProtectedOwnerPolicy(owner)).digest, replaced.digest);

  await rotate();
  const fresh = await member.readProtectedRecoveryCoverage(connection);
  assert.equal(fresh.recoveryId, replacement.recoveryId);
  assert.equal(fresh.items.length, 2);
  for (const item of fresh.items) {
    const previous = oldProof.items.find(entry => entry.purpose === item.purpose);
    assert.ok(previous && !item.pending && item.generation > previous.generation);
    assert.notEqual(item.epochDigest, previous.epochDigest);
    assert.notEqual(item.packageDigest, previous.packageDigest);
  }
  const sentBeforeReplay = confirmations;
  replayPackage = true;
  try {
    await assert.rejects(member.confirmProtectedRuntimeRecovery(connection, newCode), { code: 'INVALID_PROTECTED_RECOVERY' });
  } finally {
    replayPackage = false;
  }
  assert.equal(packageReplays, 1);
  assert.equal(confirmations, sentBeforeReplay, 'Client must reject old package before sending a confirmation');
  assert.equal((await member.confirmProtectedRuntimeRecovery(connection, newCode)).ready, true);
  const audit = await host.readProtectedAudit(owner);
  const events = audit.entries.filter(entry => entry.objectId === connection.profileId && entry.action.startsWith('recovery.'));
  assert.deepEqual(events.map(entry => entry.action), ['recovery.confirm', 'recovery.replace', 'recovery.confirm', 'recovery.enroll']);
  assert.ok(events.every(entry => entry.actor === connection.profileId));
  console.log('PASS recovery replacement retires genuine old package witnesses, preserves active devices, rotates live and archive and records audit');
}

async function checkDeviceRecovery(fetcher, host, owner, guest, visitor, transport, recoveryCodes) {
    const first = await guest.enrollProtectedRuntimeRecovery(visitor, recoveryCodes[0]);
    await new Promise(resolve => setTimeout(resolve, 5300));
    await host.serviceProtectedRuntimeRotations(owner);
    await host.serviceProtectedRuntimeRotations(owner);
    assert.equal((await guest.confirmProtectedRuntimeRecovery(visitor, recoveryCodes[0])).ready, true);

    const { snapshot } = await host.readProtectedOwnerPolicy(owner);
    const administratorRole = randomBytes(16).toString('hex');
    const readerRole = randomBytes(16).toString('hex');
    const roles = { ...snapshot.Roles, [administratorRole]: { Grants: ['server.administrator'] },
      [readerRole]: { Grants: ['channel.view'] } };
    const order = [...(snapshot.Order ?? []), readerRole, administratorRole];
    const assign = async role => {
      const intent = { Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
        Roles: roles, Order: order, Assignments: { [visitor.profileId]: [role] },
      } };
      const preview = await host.previewProtectedRuntimePolicy(owner, intent, owner.policyTrust);
      await host.commitProtectedRuntimePolicy(owner, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, owner.policyTrust);
    };
    await assign(administratorRole);
    const promoted = await host.readProtectedOwnerPolicy(owner);
    assert.deepEqual(promoted.snapshot.Members[visitor.profileId].Roles, [administratorRole]);
    assert.equal((await guest.readProtectedRuntimeState(visitor)).canManageChannels, true);
    await assign(readerRole);
    assert.equal((await guest.readProtectedRuntimeState(visitor)).canManageChannels, false);
    const active = await guest.enrollProtectedRuntimeRecovery(visitor, recoveryCodes[1]);

    const before = await host.readProtectedOwnerPolicy(owner);
    const oldRecovery = promoted.snapshot.RecoveryIdentities[visitor.profileId];
    assert.equal(oldRecovery.ID, first.recoveryId);
    assert.equal(before.snapshot.RecoveryIdentities[visitor.profileId].ID, active.recoveryId);
    assert.equal(before.snapshot.KeyRecipients[first.recoveryId], undefined);
    assert.equal(before.snapshot.RetiredRecipientKeys[oldRecovery.AgreementKey], true);
    assert.equal(before.snapshot.RetiredRecoverySigningKeys[oldRecovery.SigningKey], true);
    let droppedDeviceProposal;
    const replacement = createClient(async (url, options) => {
      const isDeviceRequest = url.endsWith('/api/v3/recovery/device');
      if (options.body && url.includes('/api/v3/recovery/')) {
        assert.ok(recoveryCodes.every(code => !options.body.includes(code)), 'recovery codes must stay local');
      }
      const response = await fetcher(url, options);
      if (isDeviceRequest && response.ok) {
        if (!droppedDeviceProposal) {
          droppedDeviceProposal = options.body;
          await response.body?.cancel();
          throw new Error('synthetic committed recovery device response loss');
        }
        assert.equal(options.body, droppedDeviceProposal, 'retry uses the exact committed proposal');
      }
      return response;
    });
    const request = { ...transport, trust: visitor.policyTrust, profileId: visitor.profileId };
    const oldBundle = createRecoveryBundle({ ...request, code: recoveryCodes[0] });
    const newBundle = createRecoveryBundle({ ...request, code: recoveryCodes[1] });
    await assert.rejects(replacement.recoverProtectedDeviceFromBundle(oldBundle), { code: 'INVALID_RECOVERY_DEVICE_PROOF' });
    assert.equal((await host.readProtectedOwnerPolicy(owner)).revision, before.revision);
    await assert.rejects(replacement.recoverProtectedDeviceFromBundle(newBundle), /synthetic committed recovery device response loss/);
    await assert.rejects(guest.readProtectedRuntimeState(visitor), { code: 'INVALID_PROTECTED_SESSION' });
    const recovered = await replacement.recoverProtectedDeviceFromBundle(newBundle);
    assert.equal(recovered.profileId, visitor.profileId);
    assert.notEqual(recovered.deviceId, visitor.deviceId);
    await assert.rejects(guest.openStoredProtectedRuntime(visitor.serverId), { code: 'INVALID_PROTECTED_SESSION_PROOF' });
    const recoveredState = await replacement.readProtectedRuntimeState(recovered);
    assert.equal(recoveredState.profileId, visitor.profileId);
    assert.equal(recoveredState.canManageChannels, false);
    await assert.rejects(replacement.readProtectedManagementPolicy(recovered), { code: 'PROTECTED_ACCESS_DENIED' });
    const recoveredPolicy = await host.readProtectedOwnerPolicy(owner);
    assert.equal(recoveredPolicy.revision, before.revision + 1);
    assert.deepEqual(recoveredPolicy.snapshot.Members[visitor.profileId].Roles, [readerRole]);
    assert.equal(recoveredPolicy.snapshot.PolicyDevices[visitor.deviceId].Revoked, true);
    assert.equal(recoveredPolicy.snapshot.KeyRecipients[visitor.deviceId], undefined);
    assert.equal(recoveredPolicy.snapshot.RetiredRecipientKeys[before.snapshot.KeyRecipients[visitor.deviceId].PublicKey], true);
    assert.equal(recoveredPolicy.snapshot.PolicyDevices[recovered.deviceId].ProfileID, visitor.profileId);
    assert.equal(recoveredPolicy.snapshot.KeyRecipients[recovered.deviceId].Kind, 'device');

    assert.equal(await host.changeProtectedMembership(owner, 'ban', visitor.profileId, { reason: 'Synthetic recovery ban' }), true);
    const banned = await host.readProtectedOwnerPolicy(owner);
    assert.equal(banned.snapshot.MemberRemovals[visitor.profileId].Action, 'member.ban');
    await assert.rejects(retryAfterFixtureQuota(() => createClient(fetcher).recoverProtectedDeviceFromBundle(newBundle)),
      { code: 'INVALID_RECOVERY_DEVICE_PROOF' });
    assert.equal((await host.readProtectedOwnerPolicy(owner)).digest, banned.digest);
    console.log('PASS last-device recovery preserves the current reader role, retires replaced devices and recovery, supports exact retry, and cannot bypass a ban');
}

(async () => {
  const directory = process.argv[2];
  assert.ok(directory, 'Launch through protected-selfhost-smoke.mjs');
  const fixture = path.join(directory, 'synthetic-microphone.wav');
  const rate = 48_000;
  const pcm = Buffer.alloc(rate * 4 * 2);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    pcm.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * offset / (2 * rate))), offset);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(fixture, Buffer.concat([header, pcm]));
  app.setPath('userData', directory);
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', fixture);
  app.disableHardwareAcceleration();
  await app.whenReady();
  await run(directory);
})().then(() => app.quit(), error => { console.error(error); app.exit(1); });
