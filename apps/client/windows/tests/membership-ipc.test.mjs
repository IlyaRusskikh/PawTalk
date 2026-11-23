import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, rm, rmdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const {registerMembershipIPC}=createRequire(import.meta.url)('../electron/membership-ipc.cjs');
const {clientPerformance}=createRequire(import.meta.url)('../electron/client-performance.cjs');
const serverId='a'.repeat(32),channelId='b'.repeat(32),failure=code=>Object.assign(Error(code),{code});
test('performance diagnostics correlate allowlisted timings and rotate without storing request data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pawtalk-client-performance-'));
  const path = join(directory, 'client-performance.jsonl');
  try {
    await writeFile(path, Buffer.alloc(1024 * 1024, 10));
    const diagnostics = clientPerformance(directory);
    await assert.rejects(diagnostics.action('chat.protected.read', () => diagnostics.stage('history.verify', () =>
      diagnostics.request(`/api/v3/history/live/${channelId}?token=synthetic-private-token`, 'GET', async () => {
        throw Object.assign(Error('synthetic-private-content'), { code: 'RATE_LIMIT', status: 429 });
      }))), { code: 'RATE_LIMIT' });
    diagnostics.renderer('chat.open.rendered', 120.4);
    diagnostics.renderer('synthetic-private-event', 50);
    await diagnostics.close();
    const data = await readFile(path, 'utf8');
    assert.doesNotMatch(data, new RegExp(`synthetic-private|${channelId}`));
    const entries = data.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(entries.map(entry => entry.stage), ['http.history.live', 'history.verify', 'ipc.chat.protected.read', 'chat.open.rendered']);
    assert.ok(entries[0].trace);
    assert.ok(entries.slice(0, 3).every(entry => entry.trace === entries[0].trace && entry.code === 'RATE_LIMIT'));
    assert.equal(entries[3].ms, 120);
    assert.equal((await readFile(`${path}.1`)).length, 1024 * 1024);
  } finally { await Promise.all([rm(path, { force: true }), rm(`${path}.1`, { force: true })]); await rmdir(directory); }
});
function fixture(extra={}){
  let handler;const requests=[],endpoints=[],events=[];
  const client={connections:new Map([[serverId,{fingerprint:'c'.repeat(64)}]]),registry:async()=>[{serverId,address:'https://127.0.0.1',name:'Synthetic'}],state:async()=>({serverId}),request:async(...args)=>{requests.push(args);return {};},voice:async()=>({url:'wss://127.0.0.1/rtc',token:'synthetic'}),forget:async id=>client.connections.delete(id)};
  const service=registerMembershipIPC({...extra,ipcMain:{handle(_name,value){handler=value;}},authorized(event){if(!event.allowed)throw Error('Unauthorized');},client,links:{},clipboard:{writeText(){throw Error('must not reach clipboard');}},send:(...args)=>events.push(args),getWindow:extra.getWindow||(()=>undefined),setVoiceEndpoint:value=>{endpoints.push(value);return value?'ws://127.0.0.1/synthetic':undefined;}});
  return{client,service,requests,endpoints,events,call:(action,input={})=>handler({allowed:true},action,input),unauthorized:(action='copy',input={text:'private'})=>handler({},action,input)};
}
test('membership IPC authorizes before effects and requires a real prepared voice grant',async()=>{
  const f=fixture();try{
    await assert.rejects(f.unauthorized(),/Unauthorized/);
    assert.equal((await f.call('voiceConnected',{serverId,channelId})).error.code,'VOICE_NOT_PREPARED');
    assert.equal((await f.call('voice',{serverId:'invalid',channelId})).error.code,'INVALID_INPUT');
    assert.equal(f.endpoints.length,0,'invalid input released or opened an endpoint');
    assert.equal((await f.call('voice',{serverId,channelId})).value.url,'ws://127.0.0.1/synthetic');
    await f.call('voiceLeave');assert.equal(f.requests.filter(request=>request[1].endsWith('/voice/leave')).length,1,'failed SDK join did not release its pending slot');
  }finally{f.service.stop();}
});

test('protected server state keeps its session in main and renews it without API 2', async () => {
  const f = fixture();
  const state = { apiProtocolVersion: 3, serverId, profileId: 'd'.repeat(64), channels: [{ id: channelId, kind: 'text', name: 'Visible' }] };
  let opened = 0;
  let expire = false;
  let rateLimited = false;
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => ({ token: 'internal-' + ++opened, address: 'https://127.0.0.1' });
  f.client.readProtectedRuntimeState = async connection => {
    assert.equal(connection.token, 'internal-' + opened);
    if (rateLimited) throw failure('RATE_LIMIT');
    if (expire) { expire = false; throw failure('INVALID_PROTECTED_SESSION'); }
    return state;
  };
  try {
    assert.deepEqual((await f.call('connect', { serverId })).value, state);
    rateLimited = true;
    assert.equal((await f.call('state', { serverId })).error.code, 'RATE_LIMIT');
    assert.equal((await f.call('servers')).value[0].status, 'online');
    rateLimited = false;
    assert.deepEqual((await f.call('state', { serverId })).value, state);
    assert.equal(opened, 1, 'throttling does not replace an authenticated session');
    expire = true;
    assert.deepEqual((await f.call('state', { serverId })).value, state);
    assert.equal(opened, 2);
    assert.deepEqual(f.requests, []);
    assert.equal(f.client.connections.has(serverId), false);
  } finally { f.service.stop(); }
});

test('waiting protected rotations wake the worker immediately and repeated reads share the wake', async () => {
  const f = fixture();
  const state = { apiProtocolVersion: 3, serverId, channels: [], rotationQueue: { waiting: 0, processing: 0 } };
  const connection = { serverId, address: 'https://127.0.0.1' };
  let wakes = 0, finish;
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => connection;
  f.client.readProtectedRuntimeState = async () => state;
  f.client.serviceProtectedRuntimeRotations = async current => {
    assert.equal(current, connection);
    wakes++;
    await new Promise(resolve => { finish = resolve; });
  };
  try {
    await f.call('connect', { serverId });
    assert.equal(wakes, 0);
    state.rotationQueue.waiting = 1;
    await f.call('connect', { serverId });
    assert.equal(wakes, 1);
    await f.call('connect', { serverId });
    finish();
    await f.call('connect', { serverId });
    assert.equal(wakes, 1);
  } finally { f.service.stop(); }
});

test('a confirmed protected device revocation removes the local server and sends one recovery notice', async () => {
  const f = fixture();
  const protectedServer = { serverId, address: 'https://127.0.0.1', name: 'Synthetic' };
  let records = [protectedServer];
  let denied;
  f.client.registry = async () => records;
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => ({ serverId, address: protectedServer.address });
  f.client.readProtectedRuntimeState = async () => {
    if (denied) throw failure(denied);
    return { apiProtocolVersion: 3, serverId, channels: [] };
  };
  f.client.forget = async id => { records = records.filter(record => record.serverId !== id); };
  try {
    await f.call('connect', { serverId });
    denied = 'INVALID_PROTECTED_SESSION_PROOF';
    assert.equal((await f.call('connect', { serverId })).error.code, denied);
    assert.equal((await f.call('servers')).value.length, 1);
    assert.equal(f.events.some(([, event]) => event?.departure), false);
    denied = 'PROTECTED_DEVICE_REVOKED';
    assert.equal((await f.call('connect', { serverId })).error.code, denied);
    assert.deepEqual((await f.call('servers')).value, []);
    await f.call('connect', { serverId });
    assert.deepEqual(f.events.flatMap(([, event]) => event?.departure ? [event.departure] : []),
      [{ serverId, name: protectedServer.name, kind: 'device-revoked' }]);
  } finally { f.service.stop(); }
});

test('an unlinked profile removes the server and delivers its own notice when the old session is renewed', async () => {
 for (const action of ['connect', 'leave']) {
  const f = fixture();
  const record = { serverId, address: 'https://127.0.0.1', name: 'Synthetic' };
  let records = [record], unlinked = false;
  f.client.registry = async () => records;
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => {
    if (unlinked) throw failure('PROTECTED_PROFILE_UNLINKED');
    return { serverId, address: record.address };
  };
  f.client.readProtectedRuntimeState = async () => {
    if (unlinked) throw failure('INVALID_PROTECTED_SESSION');
    return { apiProtocolVersion: 3, serverId, channels: [] };
  };
  f.client.leave = async () => { throw failure('INVALID_PROTECTED_SESSION'); };
  f.client.forget = async id => { records = records.filter(value => value.serverId !== id); };
  try {
    await f.call('connect', { serverId });
    unlinked = true;
    assert.equal((await f.call(action, { serverId })).error.code, 'PROTECTED_PROFILE_UNLINKED');
    assert.deepEqual((await f.call('servers')).value, []);
    assert.deepEqual(f.events.flatMap(([, event]) => event?.departure ? [event.departure] : []),
      [{ serverId, name: record.name, kind: 'profile-unlinked' }]);
  } finally { f.service.stop(); }
 }
});

test('protected address changes swap sessions only after success and reuse the new connection', async () => {
  const f = fixture();
  const record = { serverId, address: 'https://127.0.0.1', name: 'Synthetic' };
  const state = { apiProtocolVersion: 3, serverId, profileId: 'd'.repeat(64), channels: [] };
  const old = { serverId, address: record.address, token: 'old-session', config: {} };
  const next = { serverId, address: 'https://127.0.0.1:19443', token: 'new-session', config: { name: record.name } };
  let finish, rejected = true;
  const reads = [];
  f.client.registry = async () => [{ ...record }];
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => {
    assert.equal(record.address, old.address, 'the replacement already authenticated');
    return old;
  };
  f.client.readProtectedRuntimeState = async connection => { reads.push(connection.token); return state; };
  f.client.changeProtectedAddress = async (id, address) => {
    assert.equal(id, serverId);
    assert.equal(address, next.address);
    if (rejected) throw failure('PROTECTED_CUTOVER_CHANGED');
    await new Promise(resolve => { finish = resolve; });
    record.address = address;
    return { connection: next, state };
  };
  try {
    await f.call('connect', { serverId });
    assert.equal((await f.call('server.address', { serverId, address: next.address })).error.code, 'PROTECTED_CUTOVER_CHANGED');
    await f.call('state', { serverId });
    assert.deepEqual(reads, ['old-session', 'old-session']);
    rejected = false;
    const move = f.call('server.address', { serverId, address: next.address });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.call('server.address', { serverId, address: next.address })).error.code, 'BUSY');
    const pendingState = f.call('state', { serverId });
    finish();
    assert.deepEqual((await move).value, state);
    assert.deepEqual((await pendingState).value, state);
    assert.deepEqual(reads, ['old-session', 'old-session', 'new-session']);
    assert.equal((await f.call('servers')).value[0].address, next.address);
    assert.deepEqual(f.requests, []);
  } finally { f.service.stop(); }
});

test('device recovery IPC validates inputs and returns only the server ID', async () => {
  const f = fixture();
  const deviceId = '1'.repeat(64), linked = '2'.repeat(64);
  const connection = { serverId, deviceId, address: 'https://127.0.0.1', token: 'main-process-session' };
  const state = { apiProtocolVersion: 3, serverId, profileId: 'd'.repeat(64), channels: [] };
  const bundle = 'synthetic-recovery-bundle', calls = [];
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => assert.fail('recovery already opened the session');
  f.client.readProtectedRuntimeState = async session => { assert.equal(session, connection); return state; };
  f.client.prepareRecoveryBundle = session => { assert.equal(session, connection); return bundle; };
  f.client.exportRegisteredRecoveryBundle = async (session, code) => {
    assert.equal(session, connection);
    assert.equal(code, 'a'.repeat(43));
    return bundle;
  };
  f.client.confirmRecoveryBundle = async (session, input, replace) => {
    assert.equal(session, connection);
    calls.push([input, replace]);
    return { ready: true };
  };
  f.client.recoverProtectedDeviceFromBundle = async input => { assert.equal(input, bundle); return connection; };
  f.client.listProtectedOwnDevices = async session => {
    assert.equal(session, connection);
    return [linked, deviceId];
  };
  try {
    await assert.rejects(f.unauthorized('recoverDevice', { recoveryBundle: bundle }), /Unauthorized/);
    await assert.rejects(f.unauthorized('recovery.protected.devices', { serverId }), /Unauthorized/);
    assert.equal((await f.call('recovery.protected.devices', { serverId })).error.code, 'NOT_CONNECTED');
    assert.equal((await f.call('recoverDevice', { recoveryBundle: 'x'.repeat(4097) })).error.code, 'INVALID_INPUT');
    assert.deepEqual((await f.call('recoverDevice', { recoveryBundle: ` ${bundle} ` })).value, { serverId });
    assert.deepEqual((await f.call('recovery.protected.devices', { serverId })).value, {
      devices: [{ deviceId: linked, current: false }, { deviceId, current: true }],
    });
    assert.deepEqual((await f.call('state', { serverId })).value, state);
    assert.deepEqual((await f.call('prepareRecovery', { serverId })).value, { recoveryBundle: bundle });
    assert.deepEqual((await f.call('prepareRecovery', { serverId, code: 'a'.repeat(43) })).value, { recoveryBundle: bundle });
    assert.equal((await f.call('prepareRecovery', { serverId, code: 'a'.repeat(44) })).error.code, 'INVALID_INPUT');
    assert.equal((await f.call('confirmRecovery', { serverId, recoveryBundle: bundle, replace: 'true' })).error.code, 'INVALID_INPUT');
    assert.deepEqual((await f.call('confirmRecovery', { serverId, recoveryBundle: bundle, replace: true })).value, { ready: true });
    assert.deepEqual(calls, [[bundle, true]]);
    assert.ok(f.events.every(event => !JSON.stringify(event).includes(bundle)));
    assert.deepEqual(f.requests, []);
  } finally { f.service.stop(); }
});

test('accepted protected invitation shows key preparation and switches to ordinary state', async () => {
  const f = fixture();
  const profileId = 'd'.repeat(64), cutoverDigest = 'e'.repeat(64);
  let enrolled = false, pendingOpened = 0;
  const connection = { address: 'https://127.0.0.1', token: 'ordinary-token' };
  const pending = { pendingInvite: true, token: 'restricted-token', expiresAt: Date.now() + 60_000 };
  const state = { apiProtocolVersion: 3, serverId, profileId, channels: [{ id: channelId, kind: 'text' }] };
  f.client.join = async () => ({ serverId, keysPending: true });
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId, cutoverDigest });
  f.client.openStoredProtectedRuntime = async () => {
    if (!enrolled) throw failure('INVALID_PROTECTED_SESSION_PROOF');
    return connection;
  };
  f.client.openProtectedPendingInviteSession = async (target, digest) => {
    assert.deepEqual([target, digest], [serverId, cutoverDigest]);
    pendingOpened++;
    return pending;
  };
  f.client.readProtectedPendingInviteState = async session => {
    assert.equal(session, pending);
    return { profileId, keysPending: true };
  };
  f.client.readProtectedRuntimeState = async session => {
    assert.equal(session, connection);
    return state;
  };
  try {
    const preparing = { apiProtocolVersion: 3, serverId, profileId, channels: [], joinPending: true };
    assert.deepEqual((await f.call('join', { address: 'synthetic', nickname: 'New member' })).value, preparing);
    assert.deepEqual((await f.call('state', { serverId })).value, preparing);
    assert.equal(pendingOpened, 1);
    enrolled = true;
    assert.deepEqual((await f.call('state', { serverId })).value, state);
    assert.deepEqual(f.requests, []);
  } finally { f.service.stop(); }
});

test('protected invitation management uses only the connected server and filters list fields', async () => {
  const f = fixture();
  const connection = { address: 'https://127.0.0.1', token: 'ordinary-token' };
  const actions = [];
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => connection;
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId, canListInvites: true });
  f.client.listProtectedInvites = async (session, before) => {
    assert.equal(session, connection);
    actions.push(['list', before]);
    return { invites: [], canCreate: true, policyHead: 'a'.repeat(64) };
  };
  f.client.createProtectedInvite = async (session, options) => {
    assert.equal(session, connection);
    actions.push(['create', options]);
    return { invite: { id: channelId }, link: 'synthetic-link' };
  };
  f.client.revokeProtectedInvite = async (session, inviteId) => {
    assert.equal(session, connection);
    actions.push(['revoke', inviteId]);
  };
  try {
    await f.call('connect', { serverId });
    assert.equal((await f.call('invite.protected.list', { serverId: '0'.repeat(32) })).error.code, 'NOT_CONNECTED');
    assert.equal((await f.call('invite.protected.list', { serverId, before: 'invalid' })).error.code, 'INVALID_INPUT');
    assert.equal((await f.call('invite.protected.create', { serverId, expiresAt: 0, maxUses: 0.5 })).error.code, 'INVALID_INPUT');
    await assert.rejects(f.unauthorized('invite.protected.revoke', { serverId, inviteId: channelId }), /Unauthorized/);
    assert.deepEqual((await f.call('invite.protected.list', { serverId, before: channelId })).value,
      { invites: [], canCreate: true, next: undefined });
    assert.equal((await f.call('invite.protected.create', { serverId, expiresAt: 0, maxUses: 0 })).value.link, 'synthetic-link');
    assert.equal((await f.call('invite.protected.revoke', { serverId, inviteId: channelId })).value, true);
    assert.deepEqual(actions, [['list', channelId], ['create', { expiresAt: 0, maxUses: 0 }], ['revoke', channelId]]);
    assert.deepEqual(f.requests, []);
  } finally { f.service.stop(); }
});

test('delegated role IPC keeps the reviewed delta and reuses its operation ID after a lost reply', async () => {
  const f = fixture(), profileId = 'd'.repeat(64), policyHead = 'f'.repeat(64);
  const connection = { address: 'https://127.0.0.1', token: 'internal', policyTrust: { serverId } };
  const writes = [];
  f.client.loadProtectedRuntimeTrust = async () => connection.policyTrust;
  f.client.openStoredProtectedRuntime = async () => connection;
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId, canAssignRoles: true });
  f.client.readScopedRoles = async (session, target, channel) => {
    assert.equal(session, connection);
    assert.deepEqual([target, channel], [profileId, channelId]);
    return { revision: 3, policyHead, targetProfileId: target, rosterChannelId: channel,
      assignments: [{ id: 'reader', assigned: false, canAssign: true }, { id: 'existing', assigned: true, canAssign: false }] };
  };
  f.client.previewScopedRoles = async (session, change) => {
    assert.equal(session, connection);
    assert.deepEqual(change, { revision: 3, policyHead, targetProfileId: profileId, rosterChannelId: channelId,
      add: ['reader'], remove: ['existing'] });
    return [];
  };
  f.client.commitScopedRoles = async (session, operationId, change) => {
    assert.equal(session, connection);
    writes.push({ operationId, change });
    if (writes.length === 1) throw failure('SERVER_ERROR');
  };
  try {
    await f.call('connect', { serverId });
    await assert.rejects(f.unauthorized('roles.scoped.preview', { serverId }), /Unauthorized/);
    const draft = { serverId, revision: 3, policyHead, profileId, channelId, roles: ['reader'] };
    assert.equal((await f.call('roles.scoped.preview', { ...draft, revision: 2 })).error.code, 'PROTECTED_POLICY_CHANGED');
    const { previewId } = (await f.call('roles.scoped.preview', draft)).value;
    assert.equal(writes.length, 0);
    const commit = { serverId, previewId, roles: ['unreviewed'] };
    assert.equal((await f.call('roles.scoped.commit', commit)).error.code, 'SERVER_ERROR');
    await f.call('roles.scoped.commit', commit);
    assert.deepEqual(writes, Array(2).fill({ operationId: previewId, change: { revision: 3, policyHead,
      targetProfileId: profileId, rosterChannelId: channelId, add: ['reader'], remove: ['existing'] } }));
    assert.equal((await f.call('roles.scoped.commit', commit)).error.code, 'PROTECTED_PREVIEW_EXPIRED');
  } finally { f.service.stop(); }
});

test('protected voice keeps one pinned media endpoint and rejects other channel requests', async () => {
  const f = fixture();
  const epochId = 'f'.repeat(32);
  const connection = { address: 'https://127.0.0.1', fingerprint: 'd'.repeat(64),
    policyTrust: {}, config: { protectedVoice: true }, token: 'internal' };
  const grant = { url: 'wss://127.0.0.1/rtc', token: 'grant', key: 'e'.repeat(64), e2eeRequired: true,
    epoch: { epochId, expiresAt: 1 }, internal: connection.token };
  let leaves = 0;
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => connection;
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId });
  f.client.joinProtectedRuntimeVoice = async conn => { assert.equal(conn, connection); return grant; };
  f.client.refreshProtectedRuntimeVoiceKey = async () => null;
  f.client.protectedRuntimeVoiceDestination = async () => '';
  f.client.reconnectProtectedRuntimeVoice = async () => ({ ...grant, token: 'fresh' });
  f.client.leaveProtectedRuntimeVoice = async conn => { assert.equal(conn, connection); leaves++; };
  const scope = { serverId, channelId };
  try {
    await f.call('connect', { serverId });
    assert.equal((await f.call('voice.protected.refresh', { ...scope, epochId })).error.code, 'VOICE_NOT_PREPARED');
    const joined = (await f.call('voice.protected.join', scope)).value;
    assert.equal(joined.url, 'ws://127.0.0.1/synthetic');
    assert.equal(joined.internal, undefined);
    assert.equal((await f.call('voice.protected.refresh', { ...scope, epochId })).value, null);
    for (const code of ['INVALID_PROTECTED_VOICE_KEY', 'UNVERIFIED_VOICE_ROSTER', 'VOICE_GRANT_CHANGED', 'ECONNRESET', 'VOICE_ACCESS_DENIED']) {
      f.client.refreshProtectedRuntimeVoiceKey = async () => { throw Object.assign(new Error(code), { code }); };
      assert.equal((await f.call('voice.protected.refresh', { ...scope, epochId })).error.code, code);
    }
    assert.equal((await f.call('voice.protected.reconnect', { ...scope, channelId: 'a'.repeat(32) })).error.code, 'VOICE_NOT_PREPARED');
    const reconnected = (await f.call('voice.protected.reconnect', scope)).value;
    assert.equal(reconnected.url, joined.url);
    assert.equal(reconnected.token, 'fresh');
    assert.equal(f.endpoints.filter(Boolean).length, 1);
    await f.call('voiceLeave');
    assert.equal(leaves, 1);
    assert.deepEqual(f.requests, []);
  } finally { f.service.stop(); }
});

test('parked protected voice uses the pinned relay and an epochless heartbeat', async () => {
  const f = fixture();
  const connection = { address: 'https://127.0.0.1', fingerprint: 'd'.repeat(64),
    policyTrust: {}, config: { protectedVoice: true }, token: 'protected' };
  const parked = { url: 'wss://127.0.0.1/rtc', token: 'parked', serverDeafened: true, e2eeRequired: true };
  const scope = { serverId, channelId };
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => connection;
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId });
  f.client.joinProtectedRuntimeVoice = async () => parked;
  f.client.protectedRuntimeVoiceDestination = async () => '';
  f.client.reconnectProtectedRuntimeVoice = async () => ({ ...parked, token: 'fresh' });
  f.client.refreshProtectedRuntimeVoiceKey = async (actual, channel, trust, epochId) => {
    assert.deepEqual([actual, channel, trust, epochId], [connection, channelId, connection.policyTrust, null]);
    return { serverDeafened: true };
  };
  f.client.leaveProtectedRuntimeVoice = async () => {};
  try {
    await f.call('connect', { serverId });
    const joined = (await f.call('voice.protected.join', scope)).value;
    assert.deepEqual(joined, { ...parked, url: 'ws://127.0.0.1/synthetic' });
    assert.deepEqual((await f.call('voice.protected.refresh', { ...scope, epochId: null })).value, { serverDeafened: true });
    assert.deepEqual((await f.call('voice.protected.reconnect', scope)).value, { ...joined, channelId, token: 'fresh' });
    assert.equal(f.endpoints.filter(Boolean).length, 1);
  } finally { f.service.stop(); }
});

test('protected voice consumes a ready move with a new bound key and retries its destination', async () => {
  const f = fixture();
  const destination = '4'.repeat(32), epochId = 'f'.repeat(32), target = '5'.repeat(64);
  const connection = { address: 'https://127.0.0.1', fingerprint: 'd'.repeat(64),
    policyTrust: {}, config: { protectedVoice: true }, token: 'protected' };
  const grant = { url: 'wss://127.0.0.1/rtc', token: 'source-grant', key: 'e'.repeat(64), e2eeRequired: true,
    epoch: { epochId, expiresAt: 10 } };
  let next = '', pending = false;
  const joins = [];
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => connection;
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId });
  f.client.joinProtectedRuntimeVoice = async (actual, channel) => {
    assert.equal(actual, connection);
    joins.push(channel);
    if (channel === channelId) return grant;
    assert.equal(channel, destination);
    if (joins.length === 2) { next = ''; throw failure('ECONNRESET'); }
    return { ...grant, token: 'destination-grant', key: '6'.repeat(64), epoch: { epochId: '7'.repeat(32), expiresAt: 20 } };
  };
  f.client.protectedRuntimeVoiceDestination = async actual => { assert.equal(actual, connection); return next; };
  f.client.refreshProtectedRuntimeVoiceKey = async (_actual, channel) => {
    if (channel === channelId) throw failure('VOICE_SLOT_LOST');
    return null;
  };
  f.client.moveProtectedRuntimeVoice = async (actual, profileId, source, targetChannel) => {
    assert.equal(actual, connection);
    assert.deepEqual([profileId, source, targetChannel], [target, channelId, destination]);
    pending = true;
  };
  const targetSessionId = '8'.repeat(32);
  f.client.protectedRuntimeVoiceMoveChoices = async (actual, source, session) => {
    assert.equal(actual, connection);
    if (source === destination) return [];
    assert.deepEqual([source, session], [channelId, targetSessionId]);
    return [destination];
  };
  f.client.moveProtectedRuntimeVoiceSession = async (actual, session, source, targetChannel) => {
    assert.equal(actual, connection);
    assert.deepEqual([session, source, targetChannel], [targetSessionId, channelId, destination]);
  };
  const restriction = { action: 'voice.deafen', lift: true };
  f.client.protectedRuntimeVoiceRestrictionChoices = async (actual, source, session) => {
    assert.equal(actual, connection);
    if (source === destination) return { actions: [] };
    assert.deepEqual([source, session], [channelId, targetSessionId]);
    return { profileId: target, actions: [restriction] };
  };
  f.client.changeProtectedRuntimeVoiceRestriction = async (actual, source, session, action, lift) => {
    assert.equal(actual, connection);
    assert.deepEqual([source, session, action, lift], [channelId, targetSessionId, restriction.action, restriction.lift]);
  };
  f.client.reconnectProtectedRuntimeVoice = async () => { assert.fail('moved session tried to reconnect to source'); };
  f.client.leaveProtectedRuntimeVoice = async () => {};
  const source = { serverId, channelId }, moved = { serverId, channelId: destination };
  try {
    await f.call('connect', { serverId });
    const choices = { serverId, sourceChannelId: channelId, targetSessionId };
    assert.deepEqual((await f.call('voice.protected.move-choices', choices)).value, [destination]);
    assert.deepEqual((await f.call('voice.protected.restriction-choices', choices)).value, [restriction]);
    assert.equal((await f.call('voice.protected.join', source)).value.token, 'source-grant');
    assert.deepEqual((await f.call('voice.protected.move-choices', choices)).value, [destination]);
    assert.deepEqual((await f.call('voice.protected.restriction-choices', choices)).value, [restriction]);
    assert.equal((await f.call('voice.protected.restriction', { ...choices, ...restriction })).value, true);
    assert.equal((await f.call('voice.protected.restriction', { ...choices, action: 'voice.move', lift: true })).error.code, 'INVALID_INPUT');
    assert.deepEqual((await f.call('voice.protected.restriction-choices', { ...choices, sourceChannelId: destination })).value, []);
    assert.deepEqual((await f.call('voice.protected.move-choices', { ...choices, sourceChannelId: destination })).value, []);
    assert.equal((await f.call('voice.protected.move', { ...choices, destinationChannelId: destination })).value, true);
    assert.equal((await f.call('voice.protected.move', { ...choices, destinationChannelId: destination, profileId: target })).error.code, 'INVALID_INPUT');
    assert.equal((await f.call('voice.protected.refresh', { ...source, epochId })).error.code, 'VOICE_SLOT_LOST');
    const move = { serverId, profileId: target, sourceChannelId: channelId, destinationChannelId: destination };
    assert.equal((await f.call('voice.protected.move', move)).value, true);
    assert.equal(pending, true);
    next = destination;
    assert.equal((await f.call('voice.protected.refresh', { ...source, epochId })).error.code, 'VOICE_MOVE_READY');
    assert.equal((await f.call('voice.protected.reconnect', moved)).error.code, 'VOICE_NOT_PREPARED');
    assert.equal((await f.call('voice.protected.reconnect', source)).error.code, 'ECONNRESET');
    const result = (await f.call('voice.protected.reconnect', source)).value;
    assert.equal(result.channelId, destination);
    assert.equal(result.url, 'ws://127.0.0.1/synthetic');
    assert.equal(result.token, 'destination-grant');
    assert.equal(result.key, '6'.repeat(64));
    assert.equal((await f.call('voice.protected.refresh', { ...source, epochId })).error.code, 'VOICE_NOT_PREPARED');
    assert.equal((await f.call('voice.protected.refresh', { ...moved, epochId: result.epoch.epochId })).value, null);
    assert.deepEqual(joins, [channelId, destination, destination]);
    assert.equal(f.endpoints.filter(Boolean).length, 1);
    assert.deepEqual(f.requests, []);
  } finally { f.service.stop(); }
});

test('protected chat IPC keeps verified transport scoped to the saved server', async () => {
  const f = fixture();
  const connection = { address: 'https://127.0.0.1', token: 'local-session' };
  const page = { first: 2, messages: [{ position: 2, text: 'Verified' }] };
  const operationId = 'f'.repeat(32);
  const calls = [];
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => connection;
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId });
  f.client.readProtectedChatPage = async (actual, channel, after) => {
    assert.equal(actual, connection);
    calls.push([channel, after]);
    return page;
  };
  f.client.readProtectedHistoryWindow = async (actual, channel, cursor) => {
    assert.equal(actual, connection);
    assert.equal(channel, channelId);
    assert.equal(cursor, '');
    return { first: 2 };
  };
  f.client.deleteProtectedMessage = async (actual, channel, position) => {
    assert.equal(actual, connection);
    assert.deepEqual([channel, position], [channelId, 2]);
  };
  f.client.readProtectedChatEdition = async (actual, channel, position) => {
    assert.equal(actual, connection);
    assert.deepEqual([channel, position], [channelId, 2]);
    return { position: 2, revision: 2, text: 'Revised' };
  };
  f.client.editProtectedChatMessage = async (actual, channel, position, expectedRevision, operation, text) => {
    assert.equal(actual, connection);
    assert.deepEqual([channel, position, expectedRevision, operation, text], [channelId, 2, 1, operationId, 'Revised']);
    return { revision: 2 };
  };
  f.client.withCurrentProtectedChatPolicy = async (actual, callback) => { assert.equal(actual, connection); return callback({}); };
  f.client.sendProtectedRuntimeText = async (actual, channel, text, operation) => {
    assert.equal(actual, connection);
    assert.deepEqual([channel, text, operation], [channelId, 'Draft', operationId]);
    return { Position: 2, Existing: false };
  };
  try {
    await f.call('connect', { serverId });
    const scope = { serverId, channelId };
    assert.equal((await f.call('chat.protected.read', { ...scope, after: -1 })).error.code, 'INVALID_INPUT');
    assert.deepEqual((await f.call('chat.protected.read', { ...scope, after: 1 })).value, page);
    assert.equal((await f.call('chat.protected.window', { ...scope, channelId: 'bad' })).error.code, 'INVALID_INPUT');
    assert.deepEqual((await f.call('chat.protected.window', { ...scope, cursor: '' })).value, { first: 2 });
    assert.equal((await f.call('chat.protected.delete', { ...scope, position: -2 })).error.code, 'INVALID_INPUT');
    assert.equal((await f.call('chat.protected.delete', { ...scope, position: 2 })).value, true);
    assert.equal((await f.call('chat.protected.edition', { ...scope, position: 2 })).value.text, 'Revised');
    const edit = { ...scope, position: 2, expectedRevision: 1, operationId, text: 'Revised' };
    assert.equal((await f.call('chat.protected.edit', { ...edit, expectedRevision: 0 })).error.code, 'INVALID_INPUT');
    assert.equal((await f.call('chat.protected.edit', edit)).value.revision, 2);
    assert.deepEqual(calls, [[channelId, 1]]);
    assert.equal((await f.call('chat.protected.send', { ...scope, text: 'Draft', operationId })).value.Position, 2);
    assert.deepEqual(f.requests, []);
  } finally { f.service.stop(); }
});

test('protected timeout IPC validates the target, finite duration and reason on the saved connection', async () => {
  const f = fixture();
  const profileId = 'a'.repeat(64), operationId = 'e'.repeat(32);
  const connection = { token: 'local-session' };
  const inScope = { serverId, profileId };
  const request = { operationId, durationSeconds: 60, reason: 'Fixture reason' };
  let applied = 0;
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => connection;
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId });
  f.client.readProtectedTimeout = async (actual, profile) => {
    assert.equal(actual, connection);
    assert.equal(profile, profileId);
    return { deadline: 0, canSet: true, canLift: false };
  };
  f.client.changeProtectedTimeout = async (actual, profile, submitted) => {
    assert.equal(actual, connection);
    assert.equal(profile, profileId);
    assert.deepEqual(submitted, request);
    applied++;
    return { deadline: 60000, existing: false };
  };
  try {
    assert.equal((await f.call('moderation.protected.timeout.change', { ...inScope, ...request })).error.code, 'NOT_CONNECTED');
    await f.call('connect', { serverId });
    assert.equal((await f.call('moderation.protected.timeout.read', inScope)).value.canSet, true);
    for (const invalid of [{ durationSeconds: 59 }, { durationSeconds: 2419201 }, { reason: '  ' }, { profileId: 'invalid' }]) {
      assert.equal((await f.call('moderation.protected.timeout.change', { ...inScope, ...request, ...invalid })).error.code, 'INVALID_INPUT');
    }
    assert.equal(applied, 0);
    assert.equal((await f.call('moderation.protected.timeout.change', { ...inScope, ...request })).value.deadline, 60000);
    assert.equal(applied, 1);
    assert.deepEqual(f.requests, []);
  } finally { f.service.stop(); }
});

test('protected channel management signs only the verified preview and preserves unrelated ACL rules', async () => {
  const f = fixture();
  const profile = 'd'.repeat(64);
  const admin = 'a'.repeat(64), peer = 'b'.repeat(64), owner = 'c'.repeat(64);
  const connection = { address: 'https://127.0.0.1', token: 'local-session', policyTrust: {}, profileId: admin };
  const snapshot = { Owner: owner, Roles: { '@everyone': {}, Moderators: {}, Admin: { Grants: ['server.administrator'] } },
    Order: ['Moderators', 'Admin'],
    Members: {
      [admin]: { ID: admin, Active: true, Roles: ['Admin'] },
      [peer]: { ID: peer, Active: true, Roles: ['Admin'] },
      [owner]: { ID: owner, Active: true },
      [profile]: { ID: profile, Active: true, Roles: ['Moderators'] },
    },
    Channels: { [channelId]: { Kind: 'text', CategoryID: 'category', Synchronized: true } },
    Categories: { category: { Roles: { Moderators: { Allow: ['message.send', 'voice.speak'] } },
      Profiles: { [profile]: { Deny: ['history.full'] } } } },
  };
  let revision = 7, verified, committed;
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => connection;
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId });
  f.client.readProtectedManagementPolicy = async seen => {
    assert.equal(seen, connection);
    return { revision, snapshot };
  };
  const preview = { draft: { ResultDigest: 'internal-result' }, snapshot: Buffer.from(JSON.stringify(snapshot)).toString('base64') };
  f.client.previewProtectedRuntimePolicy = async (seen, intent) => {
    assert.equal(seen, connection);
    assert.deepEqual(intent.ResourceChange, { ID: channelId, ACL: {
      Roles: { Moderators: { Allow: ['message.send'], Deny: ['channel.view'] },
        '@everyone': { Allow: ['message.send'], Deny: [] } },
      Profiles: { [profile]: { Allow: [], Deny: ['history.full'] } },
    } });
    return preview;
  };
  f.client.verifyProtectedRuntimePolicyPreview = async (seen, actual, intent) => {
    assert.equal(seen, connection);
    assert.equal(actual, preview);
    verified = intent;
  };
  f.client.commitProtectedRuntimePolicy = async (seen, actual) => {
    assert.equal(seen, connection);
    assert.deepEqual(actual, { preview, intent: verified, expectedResultDigest: 'internal-result' });
    committed = actual.intent;
  };
  try {
    const input = { serverId, channelId };
    const intent = { ...input, action: 'channel.acl.update', revision: 7, role: 'Moderators',
      permission: 'channel.view', rule: 'deny' };
    await f.call('connect', { serverId });
    await assert.rejects(f.unauthorized('channel.protected.preview', intent), /Unauthorized/);
    const settings = (await f.call('channel.protected.manage', input)).value;
    assert.equal(settings.revision, 7);
    assert.deepEqual(settings.rules, { Moderators: { Allow: ['message.send'], Deny: [] } });
    assert.ok(!JSON.stringify(settings).includes(profile));
    const personal = (await f.call('channel.protected.manage', { ...input, personal: true })).value;
    assert.deepEqual(personal.profiles.map(({ id }) => id), [profile]);
    assert.deepEqual(Object.keys(personal.profileRules), [profile]);
    connection.config = { protectedExplicitAdminView: true };
    const explicit = (await f.call('channel.protected.manage', { ...input, personal: true })).value;
    assert.deepEqual(explicit.profiles.map(({ id, explicitViewOnly }) => [id, explicitViewOnly]),
      [[admin, true], [peer, true], [profile, undefined]]);
    assert.equal((await f.call('channel.protected.preview', { ...intent, permission: 'server.administrator' })).error.code, 'INVALID_INPUT');
    assert.equal((await f.call('channel.protected.preview', { ...intent, revision: 6 })).error.code, 'PROTECTED_POLICY_CHANGED');
    const change = { role: 'Moderators', permission: 'channel.view', rule: 'deny' };
    assert.equal((await f.call('channel.protected.preview', { ...intent, changes: [change, change] })).error.code, 'INVALID_INPUT');
    const opaque = (await f.call('channel.protected.preview', { ...intent, changes: [
      change, { role: '@everyone', permission: 'message.send', rule: 'allow' },
    ] })).value;
    assert.deepEqual(Object.keys(opaque), ['previewId', 'impact']);
    assert.match(opaque.previewId, /^[0-9a-f]{32}$/);
    assert.equal((await f.call('channel.protected.commit', { serverId, previewId: '0'.repeat(32) })).error.code, 'PROTECTED_PREVIEW_EXPIRED');
    const result = await f.call('channel.protected.commit', { serverId, ...opaque, action: 'channel.delete' });
    assert.equal(result.value.channelId, channelId);
    assert.equal(committed.Action, 'channel.acl.update');
    assert.equal((await f.call('channel.protected.commit', { serverId, ...opaque })).error.code, 'PROTECTED_PREVIEW_EXPIRED');
    assert.deepEqual(f.requests, []);
  } finally { f.service.stop(); }
});

test('delegated channel ordering uses the scoped state and an opaque confirmation', async () => {
  const f = fixture();
  const editor = 'd'.repeat(64), owner = 'e'.repeat(64), anchorId = 'c'.repeat(32);
  const connection = { address: 'https://127.0.0.1', profileId: editor, policyTrust: { serverId, ownerProfileId: owner } };
  f.client.loadProtectedRuntimeTrust = async () => connection.policyTrust;
  f.client.openStoredProtectedRuntime = async () => connection;
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId, channels: [
    { id: channelId, kind: 'text', categoryId: 'category', canOrder: true },
    { id: anchorId, kind: 'voice', categoryId: 'category', canOrder: true, name: 'Meeting' },
    { id: '4'.repeat(32), kind: 'text', categoryId: 'category', name: 'Read only' },
    { id: '5'.repeat(32), kind: 'text', categoryId: '', canOrder: true },
  ] });
  f.client.readProtectedManagementPolicy = async () => assert.fail('delegate requested the full policy');
  f.client.verifyProtectedChannelOrderAuthority = async (seen, requested) => {
    assert.equal(seen, connection);
    assert.equal(requested, channelId);
    return { revision: 8, categoryId: 'category', kind: 'text' };
  };
  let intent, committed;
  const preview = { draft: { Revision: 9, ResultDigest: 'verified-result' } };
  f.client.previewProtectedRuntimePolicy = async (_, input) => { intent = input; return preview; };
  f.client.verifyProtectedRuntimePolicyPreview = async (_, selected) => assert.equal(selected, preview);
  f.client.commitProtectedRuntimePolicy = async (_, selected) => { committed = selected; };
  try {
    await f.call('connect', { serverId });
    const input = { serverId, channelId, anchorId, action: 'channel.order', revision: 8, after: true };
    assert.deepEqual((await f.call('channel.protected.manage', { serverId, channelId, orderOnly: true })).value,
      { revision: 8, siblings: [{ id: anchorId, name: 'Meeting' }] });
    assert.equal((await f.call('channel.protected.preview', { ...input, revision: 7 })).error.code, 'PROTECTED_POLICY_CHANGED');
    const confirmation = (await f.call('channel.protected.preview', input)).value;
    assert.deepEqual(Object.keys(confirmation), ['previewId']);
    assert.deepEqual(intent.ResourceChange, { ID: channelId, AnchorID: anchorId, After: true });
    assert.deepEqual((await f.call('channel.protected.commit', { serverId, ...confirmation })).value, { channelId });
    assert.deepEqual(committed, { intent, preview, expectedResultDigest: 'verified-result' });
    const digest = 'f'.repeat(64);
    f.client.readVerifiedProtectedChannelOrder = async (seen, channel, selected) => {
      assert.equal(seen, connection);
      assert.equal(channel, channelId);
      assert.equal(selected, digest);
      return { authorProfileId: editor };
    };
    assert.equal((await f.call('audit.protected.verifyOrder', { serverId, channelId, digest, actor: owner })).error.code, 'INVALID_CHANNEL_ORDER_PROOF');
    assert.equal((await f.call('audit.protected.verifyOrder', { serverId, channelId, digest, actor: editor })).value, true);
    assert.deepEqual(f.requests, []);
  } finally { f.service.stop(); }
});

test('protected role editing keeps identity stable and binds confirmation to the role operation', async () => {
  const f = fixture();
  const connection = { address: 'https://127.0.0.1', policyTrust: {} };
  const roleId = 'e'.repeat(32);
  const ownerId = 'd'.repeat(64), readerId = 'c'.repeat(64), head = '9'.repeat(64);
  const snapshot = { Owner: ownerId, Roles: { '@everyone': { Grants: ['channel.view'] }, [roleId]: { Grants: ['channel.view'] } }, Order: [roleId],
    Members: { [ownerId]: { ID: ownerId, Active: true }, [readerId]: { ID: readerId, Active: true, Roles: [roleId] } },
    RecoveryReady: { [readerId]: true }, Channels: { [channelId]: { Kind: 'text', Settings: { Name: 'Restricted' },
      ACL: { Roles: { [roleId]: { Deny: ['channel.view'] } } } } } };
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => connection;
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId });
  f.client.readProtectedManagementPolicy = async () => ({ revision: 2, digest: head, snapshot,
    importedRoleNames: { [roleId]: 'Legacy role' }, importedProfileNames: { [readerId]: 'Reader' } });
  let intent;
  let previewHead = head;
  f.client.previewProtectedRuntimePolicy = async (_, input) => {
    intent = input;
    const expected = structuredClone(snapshot);
    expected.Roles = input.RoleUpdate.Roles;
    if (!expected.Roles[roleId]) {
      expected.Members[readerId].Roles = [];
      delete expected.Channels[channelId].ACL.Roles[roleId];
    }
    return { draft: { Revision: 3, PreviousDigest: previewHead, ResultDigest: 'result' },
      snapshot: Buffer.from(JSON.stringify(expected)).toString('base64') };
  };
  f.client.verifyProtectedRuntimePolicyPreview = async () => {};
  f.client.commitProtectedRuntimePolicy = async (_, signed) => assert.equal(signed.intent, intent);
  const input = { serverId, revision: 2, roleId, action: 'save', position: 0, name: 'Renamed',
    color: '#5A89BC', icon: '🐾', hoist: true, mentionable: false, grants: ['channel.view'] };
  try {
    await f.call('connect', { serverId });
    const view = (await f.call('role.protected.manage', { serverId })).value;
    assert.equal(view.roles[1].name, 'Legacy role');
    assert.equal(view.roles[1].assigned, 1);
    assert.equal((await f.call('role.protected.preview', { ...input, action: 'delete', roleId: '@everyone' })).error.code, 'INVALID_INPUT');
    const { previewId } = (await f.call('role.protected.preview', input)).value;
    assert.deepEqual(intent.RoleUpdate, { Roles: snapshot.Roles, Order: [roleId], Assignments: null,
      Presentation: { [roleId]: { Name: 'Renamed', Color: '#5a89bc', Icon: '🐾', Hoist: true } } });
    assert.equal((await f.call('channel.protected.commit', { serverId, previewId })).error.code, 'PROTECTED_PREVIEW_EXPIRED');
    assert.equal((await f.call('role.protected.commit', { serverId, previewId })).value.roleId, roleId);
    previewHead = '8'.repeat(64);
    assert.equal((await f.call('role.protected.preview', { ...input, action: 'delete' })).error.code, 'PROTECTED_POLICY_CHANGED');
    previewHead = head;
    const consequence = (await f.call('role.protected.preview', { ...input, action: 'delete' })).value;
    assert.deepEqual(Object.keys(consequence).sort(), ['impact', 'previewId']);
    assert.equal(consequence.impact.changedChannels, 1);
    const [changed] = consequence.impact.details;
    assert.deepEqual([changed.name, changed.beforeView, changed.afterView], ['Restricted', 1, 2]);
    assert.equal(changed.example.profile.name, 'Reader');
    assert.equal(changed.example.removedDeny, true);
    assert.deepEqual(changed.example.before.sources, [{ kind: 'channel', roleId, roleName: 'Legacy role', effect: 'deny' }]);
    assert.equal(changed.example.after.sources[0].roleId, '@everyone');
    const admin = (await f.call('role.protected.preview', { ...input, grants: ['server.administrator'] })).value;
    assert.deepEqual(admin.impact.administrator, { added: 1, ready: 1, removed: 0 });
  } finally { f.service.stop(); }
});

test('protected member assignments and personal channel rules preview only the selected profile', async () => {
  const f = fixture();
  const owner = 'a'.repeat(64), reader = 'd'.repeat(64), other = 'f'.repeat(64);
  const connection = { address: 'https://127.0.0.1', policyTrust: {} };
  let snapshot = { Owner: owner, Roles: { '@everyone': { Grants: ['channel.view'] }, archive: { Grants: ['history.full'] } },
    Order: ['archive'], Members: { [owner]: { ID: owner, Active: true }, [reader]: { ID: reader, Active: true },
      [other]: { ID: other, Active: true, Roles: ['archive'] } },
    Channels: { [channelId]: { Kind: 'text', ACL: { Roles: {}, Profiles: { [other]: { Allow: ['message.send'] } } } } },
    Categories: { private: { Profiles: { [reader]: { Deny: ['channel.view'] } } } },
  };
  let next, mutation;
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => connection;
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId });
  const head = '5'.repeat(64);
  f.client.readProtectedManagementPolicy = async () => ({ revision: 4, digest: head, snapshot, importedProfileNames: { [reader]: 'Reader' } });
  f.client.previewProtectedRuntimePolicy = async (_, intent) => {
    mutation = intent;
    next = structuredClone(snapshot);
    if (intent.RoleUpdate) next.Members[reader].Roles = intent.RoleUpdate.Assignments[reader];
    else if (intent.Action === 'channel.move') {
      next.Channels[channelId].CategoryID = intent.ResourceChange.CategoryID;
      next.Channels[channelId].Synchronized = intent.ResourceChange.Mode === 'synchronize';
    } else next.Channels[channelId].ACL = intent.ResourceChange.ACL;
    return { draft: { Revision: 5, PreviousDigest: head, ResultDigest: 'verified' }, snapshot: Buffer.from(JSON.stringify(next)).toString('base64') };
  };
  f.client.verifyProtectedRuntimePolicyPreview = async () => {};
  f.client.commitProtectedRuntimePolicy = async () => { snapshot = next; };
  const input = { serverId, channelId, profileId: reader, revision: 4 };
  try {
    await f.call('connect', { serverId });
    const profiles = (await f.call('member.protected.roles', { serverId })).value.profiles;
    assert.deepEqual(profiles.map(profile => profile.id), [reader, other]);
    assert.equal(profiles[0].name, 'Reader');
    const explain = { ...input, profileId: other, permission: 'message.send' };
    await assert.rejects(f.unauthorized('channel.protected.explain', explain), /Unauthorized/);
    assert.deepEqual((await f.call('channel.protected.explain', explain)).value, {
      decision: 'allowed', permission: 'message.send', sources: [{ kind: 'channel', effect: 'allow' }],
    });
    assert.equal(mutation, undefined);
    assert.equal((await f.call('channel.protected.explain', { ...explain, revision: 3 })).error.code, 'PROTECTED_POLICY_CHANGED');
    assert.equal((await f.call('channel.protected.explain', { ...explain, profileId: owner })).error.code, 'PROTECTED_ACCESS_DENIED');
    assert.equal((await f.call('channel.protected.explain', { ...explain, permission: 'server.administrator' })).error.code, 'INVALID_INPUT');
    assert.equal((await f.call('member.protected.roles.preview', { ...input, roles: ['@everyone'] })).error.code, 'INVALID_INPUT');
    const assignment = (await f.call('member.protected.roles.preview', { ...input, roles: ['archive'] })).value;
    assert.deepEqual(mutation.RoleUpdate.Assignments, { [reader]: ['archive'] });
    assert.equal(assignment.impact.gained.fullHistory, 1);
    assert.equal(assignment.impact.gained.visible, 0);
    assert.equal((await f.call('member.protected.roles.commit', { serverId, previewId: assignment.previewId })).value.profileId, reader);
    const personal = { ...input, action: 'channel.acl.personal', permission: 'channel.view', rule: 'deny' };
    assert.equal((await f.call('channel.protected.preview', { ...personal, profileId: owner })).error.code, 'PROTECTED_ACCESS_DENIED');
    const rule = (await f.call('channel.protected.preview', personal)).value;
    assert.equal(mutation.Action, 'channel.acl.update');
    assert.deepEqual(mutation.ResourceChange.ACL.Profiles, {
      [reader]: { Allow: [], Deny: ['channel.view'] }, [other]: { Allow: ['message.send'], Deny: [] },
    });
    assert.equal(rule.impact.before.allowed, true);
    assert.equal(rule.impact.after.allowed, false);
    assert.deepEqual(rule.impact.before.evidence.sources, [{ kind: 'base', roleId: '@everyone', roleName: undefined, effect: 'allow' }]);
    assert.deepEqual(rule.impact.after.evidence.sources, [{ kind: 'channel', effect: 'deny' }]);
    assert.deepEqual(rule.impact.lost, { visible: 1, fullHistory: 1 });
    const move = { ...input, action: 'channel.move', categoryId: 'private' };
    const preserved = (await f.call('channel.protected.preview', { ...move, mode: 'preserve' })).value;
    assert.deepEqual(preserved.impact.lostView, []);
    assert.equal(preserved.impact.keyChannels, 0);
    const synchronized = (await f.call('channel.protected.preview', { ...move, mode: 'synchronize' })).value;
    assert.deepEqual(synchronized.impact.lostView, [{ id: reader, name: 'Reader' }]);
    assert.deepEqual(synchronized.impact.lostHistory, [{ id: reader, name: 'Reader' }]);
    assert.equal(synchronized.impact.keyChannels, 1);
  } finally { f.service.stop(); }
});

test('server rename uses bounded IPC and refreshes shared state',async()=>{
 const f=fixture();try{
  const result=await f.call('server.rename',{serverId,name:'New shared name',expectedName:'Synthetic'});assert.ok(result.value);
  assert.deepEqual(f.requests[0].slice(0,3),[serverId,'/api/v2/server','PATCH']);assert.equal(f.requests[0][3].expectedName,'Synthetic');assert.match(f.requests[0][3].requestId,/^[a-f0-9]{32}$/);
  const before=f.requests.length;assert.equal((await f.call('server.rename',{serverId,name:'x'.repeat(257),expectedName:'Synthetic'})).error.code,'INVALID_INPUT');assert.equal(f.requests.length,before);
 }finally{f.service.stop();}
});

test('native notification payload includes readable content without Markdown or spoilers',async()=>{
 const shown=[];class FakeNotification{static isSupported(){return true;}constructor(options){shown.push(options);}on(){}show(){}}
 const f=fixture({Notification:FakeNotification});try{
  assert.equal((await f.call('notify',{serverId,channelId,channelName:'General',authorName:'Friend',text:'**Hello** [world](https://example.test) ||hidden||'})).value,true);
  assert.equal(shown[0].silent,true,'OS notification must not add a system sound');assert.equal(shown[0].title,'Synthetic · #General');assert.ok(shown[0].body.startsWith('Friend: Hello world '));assert.ok(!shown[0].body.includes('hidden'));assert.ok(!shown[0].body.includes('**'));
 }finally{f.service.stop();}
 const pictures=[];class PictureNotification{static isSupported(){return true;}constructor(options){pictures.push(options);}on(){}show(){}}
 const image=fixture({Notification:PictureNotification});try{await image.call('notify',{serverId,channelId,channelName:'General',authorName:'Friend',text:'',hasImage:true});assert.match(pictures[0].body,/Friend: (Изображение|Image)/);}finally{image.service.stop();}
});
test('suspend cancels an in-flight grant before the renderer receives an endpoint',async()=>{
  const f=fixture();let release,started;const gate=new Promise(resolve=>{release=resolve;}),enter=new Promise(resolve=>{started=resolve;});
  f.client.voice=async()=>{started();await gate;return{url:'wss://127.0.0.1/rtc'};};
  try{const pending=f.call('voice',{serverId,channelId});await enter;f.service.suspend();release();assert.equal((await pending).error.code,'CANCELLED');assert.equal(f.endpoints.filter(Boolean).length,0);assert.equal(f.requests.filter(request=>request[1].endsWith('/voice/leave')).length,1);}finally{f.service.stop();}
});
test('revoked membership disconnects compliant voice even when media server removal fails',async()=>{
  const f=fixture();try{
    await f.call('voice',{serverId,channelId});await f.call('voiceConnected',{serverId,channelId});
    f.client.request=async(_id,path)=>{if(path==='/api/v2/heartbeat')throw failure('NOT_A_MEMBER');return{};};
    f.service.start();for(let count=0;count<100&&!f.events.some(event=>event[0]==='membership-voice-lost');count++)await new Promise(setImmediate);
    assert.ok(f.events.some(event=>event[0]==='membership-voice-lost'&&event[1].serverId===serverId));assert.equal(f.endpoints.at(-1),null);
  }finally{f.service.stop();}
});
test('background TLS identity failures remain locked rather than ordinary offline',async()=>{
  const f=fixture();f.client.state=async()=>{throw failure('SERVER_KEY_CHANGED');};
  try{f.service.start();for(let count=0;count<100&&!f.events.length;count++)await new Promise(setImmediate);assert.equal(f.service.statuses.get(serverId),'locked');}finally{f.service.stop();}
});

test('only the matching local selfhost stops on leave; an external server uses membership departure',async()=>{
  let stopped=0,left=0;
  const f=fixture({getHost:()=>({running:true,serverId}),stopHost:async()=>{stopped++;}});
  f.client.leave=async()=>{left++;};
  try{assert.equal((await f.call('servers')).value[0].ownedSelfhost,true);await f.call('leave',{serverId});assert.equal(stopped,1);assert.equal(left,0);}finally{f.service.stop();}
  const external=fixture({getHost:()=>({running:true,serverId:'d'.repeat(32)}),stopHost:async()=>{stopped++;}});
  external.client.leave=async()=>{left++;};
  try{assert.equal((await external.call('servers')).value[0].ownedSelfhost,false);await external.call('leave',{serverId});assert.equal(stopped,1);assert.equal(left,1);}finally{external.service.stop();}
});

test('a missing local membership is not a server kick',async()=>{
 const f=fixture();try{
  await f.call('servers');f.client.registry=async()=>[];
  assert.equal((await f.call('connect',{serverId})).error.code,'NOT_A_MEMBER');
  assert.equal(f.events.some(event=>event[1]?.departure),false);
 }finally{f.service.stop();}
});

test('voluntary selfhost departure suppresses an already pending membership denial',async()=>{
 const f=fixture({getHost:()=>({running:true,serverId}),stopHost:async()=>{}});
 let entered,reject;const started=new Promise(resolve=>{entered=resolve;});
 f.client.state=()=>{entered();return new Promise((_resolve,fail)=>{reject=fail;});};
 try{
  const pending=f.call('connect',{serverId});await started;
  assert.equal((await f.call('leave',{serverId})).value,true);
  reject(failure('NOT_A_MEMBER'));await pending;
  assert.equal(f.events.some(event=>event[1]?.departure),false);
 }finally{f.service.stop();}
});

test('host shutdown suppresses stale denials but an explicit rejoin restores ban notices',async()=>{
 const f=fixture();let entered,reject;const started=new Promise(resolve=>{entered=resolve;});
 f.client.state=()=>{entered();return new Promise((_resolve,fail)=>{reject=fail;});};
 try{
  const pending=f.call('connect',{serverId});await started;await f.service.serverEnded(serverId);
  reject(failure('BANNED'));await pending;
  assert.equal(f.events.some(event=>event[1]?.departure),false);
  f.client.join=async()=>{f.client.connections.set(serverId,{});return{serverId};};
  await f.call('join',{address:'synthetic',nickname:'Synthetic'});
  f.client.state=async()=>{throw failure('BANNED');};await f.call('connect',{serverId});
  assert.equal(f.events.filter(event=>event[1]?.departure).length,1);
 }finally{f.service.stop();}
});

test('a rejected leave does not suppress a subsequent real ban',async()=>{
 const f=fixture();try{
  f.client.leave=async()=>{throw failure('LAST_ADMIN');};
  assert.equal((await f.call('leave',{serverId})).error.code,'LAST_ADMIN');
  f.client.state=async()=>{throw failure('BANNED');};await f.call('connect',{serverId});
  assert.equal(f.events.filter(event=>event[1]?.departure).length,1);
 }finally{f.service.stop();}
});

 test('membership departures carry one modal event and ban expiry before forgetting',async()=>{
 const f=fixture();try{
  await f.call('servers');const expiresAt=Date.now()+60000;
  f.client.state=async()=>{throw Object.assign(failure('BANNED'),{details:{expiresAt}});};
  await f.call('connect',{serverId});await f.call('connect',{serverId});
  const notices=f.events.filter(event=>event[1]?.departure);assert.equal(notices.length,1);assert.deepEqual(notices[0][1].departure,{serverId,name:'Synthetic',kind:'ban',expiresAt});assert.equal(f.client.connections.has(serverId),false);
 }finally{f.service.stop();}
 const kick=fixture();try{await kick.call('servers');kick.client.state=async()=>{throw failure('NOT_A_MEMBER');};await kick.call('connect',{serverId});assert.equal(kick.events.find(event=>event[1]?.departure)[1].departure.kind,'kick');}finally{kick.service.stop();}
});

test('incoming link attention restores and focuses once, including a hidden main window',async()=>{
 let handler,restores=0,shows=0,focuses=0;const linkId='d'.repeat(32);let state='proposed';
 const links={pending:new Map([[linkId,{side:'target',connection:{config:{serverId}}}]]),prune(){},status:async()=>({state})};
 const service=registerMembershipIPC({ipcMain:{handle(_name,value){handler=value;}},authorized(){},client:{connections:new Map()},links,send(){},getWindow:()=>({isDestroyed:()=>false,isMinimized:()=>true,restore(){restores++;},show(){shows++;},focus(){focuses++;}})});
 try{const first=await handler({},'link.pending',{});assert.deepEqual(first.value,[{linkId,serverId}]);await handler({},'link.pending',{});assert.deepEqual([restores,shows,focuses],[1,1,1]);state='cancelled';assert.deepEqual((await handler({},'link.pending',{})).value,[]);}finally{service.stop();}
});
test('automatic idle threshold uses native system inactivity and exposes no manual setter',async()=>{
 let idle=299;const f=fixture({getIdleSeconds:()=>idle});try{assert.equal((await f.call('activity')).value.away,false);idle=300;assert.equal((await f.call('activity')).value.away,true);assert.equal((await f.call('activity.set',{away:true})).error.code,'INVALID_ACTION');}finally{f.service.stop();}
});
test('memory pressure is a local read-only boolean behind the membership IPC authorizer',async()=>{let low=false;const f=fixture({getMemoryPressure:()=>low});try{assert.deepEqual((await f.call('memory.status')).value,{low:false});low=true;assert.deepEqual((await f.call('memory.status')).value,{low:true});await assert.rejects(f.unauthorized('memory.status'),/Unauthorized/);assert.equal(f.requests.length,0);}finally{f.service.stop();}});

test('desktop notification batches deduplicate IDs and retain mention priority',async()=>{
 const shown=[];class N{static isSupported(){return true;}constructor(options){shown.push(options);}on(){}show(){}}
 const f=fixture({Notification:N});try{
  const base={serverId,channelId,channelName:'General',authorName:'Friend',batchCount:1};
  const first=f.call('notify',{...base,messageId:10,mention:true,text:'Important mention'});
  const second=f.call('notify',{...base,messageId:11,text:'Later ordinary text'});
  await Promise.all([first,second]);assert.equal(shown.length,1);assert.match(shown[0].body,/Important mention/);assert.match(shown[0].body,/2/);
  assert.equal((await f.call('notify',{...base,messageId:11,text:'Duplicate'})).value,false);assert.equal(shown.length,1);
 }finally{f.service.stop();}
});
test('shutdown cancels pending desktop batches without leaking unresolved IPC',async()=>{
 const shown=[];class N{static isSupported(){return true;}constructor(options){shown.push(options);}on(){}show(){}}
 const f=fixture({Notification:N});const pending=f.call('notify',{serverId,channelId,channelName:'General',authorName:'Friend',messageId:1,text:'Pending'});f.service.stop();assert.equal((await pending).value,false);assert.equal(shown.length,0);
});

function nativeAlerts(extra={}){
 const shown=[];class N extends EventEmitter{static isSupported(){return true;}constructor(options){super();this.options=options;this.closed=0;}show(){shown.push(this);}close(){this.closed++;this.emit('close');}}
 const f=fixture({...extra,Notification:N});return{...f,shown,notify:(messageId,options={})=>f.call('notify',{serverId,channelId,channelName:'General',authorName:'Friend',messageId,text:'Message '+messageId,...options}),read:(messageId,channel=channelId)=>f.call('notify.read',{serverId,channelId:channel,messageId})};
}

test('protected history shares concurrent reads only and previews combined role grants', async () => {
  const f = nativeAlerts();
  const profileId = 'd'.repeat(64), privateChannel = 'e'.repeat(32), voiceChannel = 'f'.repeat(32);
  const connection = { serverId, profileId, address: 'https://127.0.0.1' };
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => connection;
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId, profileId, channels: [] });
  let release, started;
  const waiting = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  let reads = 0;
  f.client.readProtectedChatPage = async () => { reads++; started(); await waiting; return { messages: [] }; };
  f.client.readProtectedManagementPolicy = async () => ({ revision: 1, snapshot: {
    Owner: profileId, Roles: { '@everyone': { Grants: [] }, reader: { Grants: ['channel.view'] }, writer: { Grants: ['message.send', 'voice.connect'] } },
    Order: ['reader','writer'], Members: { [profileId]: { ID: profileId, Active: true } },
    Channels: { [channelId]: { Kind: 'text' }, [voiceChannel]: { Kind: 'voice' },
      [privateChannel]: { Kind: 'text', ACL: { Roles: { '@everyone': { Deny: ['channel.view'] } } } } },
  } });
  try {
    assert.equal((await f.call('connect', { serverId })).value.apiProtocolVersion, 3);
    const first = f.call('chat.protected.read', { serverId, channelId, after: 0 });
    await ready;
    const second = f.call('chat.protected.read', { serverId, channelId, after: 0 });
    release();
    await Promise.all([first, second]);
    assert.equal(reads, 1);
    await f.call('chat.protected.read', { serverId, channelId, after: 0 });
    assert.equal(reads, 2, 'A later read revalidates access');
    const draft = { serverId, revision: 1, roleId: 'reader', name: 'Reader', position: 0,
      grants: ['channel.view'], color: '', icon: '', hoist: false, mentionable: false, includeDraft: false };
    assert.deepEqual((await f.call('role.protected.view', { ...draft, roles: ['writer'] })).value.channels, []);
    const single = (await f.call('role.protected.view', { ...draft, roles: ['reader'] })).value.channels;
    assert.deepEqual(single.map(channel => [channel.id, channel.canSend, channel.canConnect]),
      [[channelId, false, false], [voiceChannel, false, false]]);
    const combined = (await f.call('role.protected.view', { ...draft, roles: ['reader','writer'] })).value.channels;
    assert.deepEqual(combined.map(channel => [channel.id, channel.canSend, channel.canConnect]),
      [[channelId, true, false], [voiceChannel, false, true]]);
  } finally { release(); f.service.stop(); }
});

test('one protected ACL change can make a resource private and grant selected members access', async () => {
  const f = nativeAlerts();
  const profileId = 'd'.repeat(64), memberId = 'e'.repeat(64), category = 'f'.repeat(32);
  const snapshot = { Owner: profileId, Roles: { '@everyone': { Grants: ['channel.view'] } },
    Members: { [profileId]: { ID: profileId, Active: true }, [memberId]: { ID: memberId, Active: true } },
    Categories: { [category]: { Roles: null, Profiles: null } },
    Channels: { [channelId]: { Kind: 'text', CategoryID: category, Synchronized: true } } };
  const changes = [
    { role: '@everyone', permission: 'channel.view', rule: 'deny' },
    { profileId: memberId, permission: 'channel.view', rule: 'allow' },
  ];
  const expected = { Roles: { '@everyone': { Allow: [], Deny: ['channel.view'] } },
    Profiles: { [memberId]: { Allow: ['channel.view'], Deny: [] } } };
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => ({ serverId, profileId, address: 'https://127.0.0.1' });
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId, profileId, channels: [] });
  f.client.readProtectedManagementPolicy = async () => ({ revision: 1, snapshot });
  f.client.verifyProtectedRuntimePolicyPreview = async () => {};
  const captured = [];
  f.client.previewProtectedRuntimePolicy = async (_connection, intent) => {
    captured.push(intent);
    const result = structuredClone(snapshot);
    if (intent.Action === 'category.acl.update') result.Categories[category] = intent.ResourceChange.ACL;
    else Object.assign(result.Channels[channelId], { ACL: intent.ResourceChange.ACL, Synchronized: false });
    return { snapshot: Buffer.from(JSON.stringify(result)).toString('base64') };
  };
  try {
    await f.call('connect', { serverId });
    assert.ok((await f.call('channel.protected.preview', { serverId, channelId, revision: 1, action: 'channel.acl.personal', changes })).value?.previewId);
    assert.ok((await f.call('category.protected.preview', { serverId, categoryId: category, revision: 1, action: 'category.acl.update', changes })).value?.previewId);
    assert.deepEqual(captured.map(intent => intent.ResourceChange.ACL), [expected, expected]);
  } finally { f.service.stop(); }
});

test('protected notifications honor group mute and verify the original immediately before display', async () => {
  const f = nativeAlerts();
  const profileId = 'd'.repeat(64);
  const visible = [{ id: channelId, kind: 'text', name: 'Protected' }];
  let revision = 1;
  let denied = false;
  let reads = 0;
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => ({ serverId, profileId, address: 'https://127.0.0.1' });
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId, profileId, channels: visible });
  f.client.pollProtectedMentions = async () => ({ cursor: 'e'.repeat(32), alerts: [
    { channelId, position: 1, kind: 'group' }, { channelId, position: 2, kind: 'direct' },
    { channelId, position: 3, kind: 'group' }, { channelId, position: 4, kind: 'group' },
  ] });
  f.client.readProtectedChatReference = async (_connection, _channel, position) => {
    reads++;
    return { position, revision: 1, text: 'Verified protected preview', mentions: [position === 2 ? { kind: 'profile', id: profileId } : { kind: 'everyone' }] };
  };
  f.client.verifyProtectedMention = async (_connection, _channel, position) => {
    if (denied) throw failure('PROTECTED_ACCESS_DENIED');
    return { kind: position === 2 ? 'direct' : 'group', remaining: 20_000, revision };
  };
  const notify = position => f.call('chat.protected.notify', { serverId, channelId, position });
  const prefs = mutedChannels => ({ serverId, mutedChannels, serverMuted: false });
  try {
    await f.call('connect', { serverId });
    await f.call('chat.protected.mentions', prefs([channelId]));
    assert.equal((await notify(1)).value, false);
    assert.equal(reads, 0, 'muted group cannot decrypt a preview for notification');
    assert.equal((await notify(2)).value, true, 'direct mention bypasses the same channel mute');
    assert.match(f.shown[0].options.body, /Verified protected preview/);
    assert.match(f.shown[0].options.title, /Упоминание|Mention/);
    assert.equal((await notify(2)).value, false);
    await f.call('chat.protected.muteNotifications', prefs([]));
    revision = 2;
    assert.equal((await notify(3)).value, false, 'a changed edition cannot show stale text');
    revision = 1;
    assert.equal((await notify(3)).value, true);
    await f.call('chat.protected.muteNotifications', prefs([channelId]));
    assert.equal(f.shown[1].closed, 1, 'new mute dismisses an already shown group notice');
    await f.call('chat.protected.muteNotifications', prefs([]));
    denied = true;
    assert.equal((await notify(4)).error.code, 'PROTECTED_ACCESS_DENIED');
    assert.equal(f.shown.length, 2);
  } finally { f.service.stop(); }
});

test('protected ordinary activity uses authenticated recent messages, and reading or muting dismisses its toast', async () => {
  const appearances = [];
  const f = nativeAlerts({ notificationAppearance: async meta => { appearances.push(meta); return {}; } });
  const profileId = 'd'.repeat(64);
  const authorId = 'f'.repeat(64), avatar = 'synthetic-avatar';
  const position = 2;
  const secondChannel = 'e'.repeat(32);
  const staleChannel = 'c'.repeat(32);
  const cursor = '7'.repeat(32);
  f.client.loadProtectedRuntimeTrust = async () => ({ serverId });
  f.client.openStoredProtectedRuntime = async () => ({ serverId, profileId, address: 'https://127.0.0.1' });
  f.client.readProtectedRuntimeState = async () => ({ apiProtocolVersion: 3, serverId, profileId,
    channels: [channelId, secondChannel, staleChannel].map(id => ({ id, kind: 'text', name: 'Protected' })) });
  f.client.readProtectedHistoryWindow = async (_connection, id, after) => ({
    first: 1, last: position, removed: [], cursor,
    edits: id === staleChannel && after === cursor ? [{ position, revision: 2 }] : [],
  });
  f.client.readProtectedChatReference = async (_connection, _channel, requested, window) => {
    if (requested === 1) return { position: 1, authorProfileId: authorId, text: 'Direct alert',
      mentions: [{ kind: 'profile', id: profileId }] };
    assert.equal(window.cursor, cursor);
    return { position, authorProfileId: authorId, sentAt: Date.now(), text: 'Hello ||hidden spoiler|| **friend**' };
  };
  f.client.readProtectedRuntimeRoster = async (_connection, _channel, after, revision) => {
    if (!after) return { members: [], next: '5'.repeat(64), revision: 7 };
    assert.equal(after, 'f'.repeat(63) + 'e');
    assert.equal(revision, 7);
    return { members: [{ id: authorId, name: 'Alice', avatar }] };
  };
  const activity = (after, channel = channelId) => f.call('chat.protected.activity', { serverId, channelId: channel, after, notify: true });
  const mute = mutedChannels => f.call('chat.protected.muteNotifications', { serverId, mutedChannels, serverMuted: false });
  try {
    await f.call('connect', { serverId });
    await mute([]);
    assert.deepEqual((await activity(1)).value, { position: 2, incoming: true, recent: true, notified: true });
    assert.match(f.shown[0].options.body, /^Alice: Hello .* friend$/);
    assert.doesNotMatch(f.shown[0].options.body, /hidden spoiler|\*\*/);
    assert.equal(appearances[0].avatar, avatar);
    assert.equal((await activity(2)).value, undefined);
    f.client.pollProtectedMentions = async () => ({ cursor: '9'.repeat(32),
      alerts: [{ channelId, position: 1, kind: 'direct' }] });
    f.client.verifyProtectedMention = async () => ({ kind: 'direct', revision: 1, remaining: 10_000 });
    await f.call('chat.protected.mentions', { serverId, mutedChannels: [], serverMuted: false });
    assert.equal((await f.call('chat.protected.notify', { serverId, channelId, position: 1 })).value, true,
      'a verified mention takes priority even when a newer ordinary toast already appeared');
    assert.match(f.shown[1].options.title, /Упоминание|Mention/);
    assert.equal(f.shown[0].closed, 1);
    await f.read(2);
    assert.equal(f.shown[1].closed, 1);
    assert.equal((await activity(1, secondChannel)).value.notified, true);
    await mute([secondChannel]);
    assert.equal(f.shown[2].closed, 1);
    assert.equal((await activity(1, staleChannel)).error.code, 'PROTECTED_ACCESS_DENIED');
    assert.equal(f.shown.length, 3, 'an edit during toast preparation invalidates the preview');
    const other = await f.call('chat.protected.activity', { serverId, channelId: '8'.repeat(32), notify: true });
    assert.equal(other.value, undefined);
  } finally { f.service.stop(); }
});

test('reading cancels queued and shown alerts, rejects late events and preserves newer unread messages',async()=>{
 const f=nativeAlerts();try{
  const pending=f.notify(10);await f.read(10);assert.equal((await pending).value,false);assert.equal(f.shown.length,0);
  assert.equal((await f.notify(10)).value,false,'late arrival for a read message is ignored');
  assert.equal((await f.notify(11)).value,true);await f.read(10);assert.equal(f.shown[0].closed,0,'partial read does not close a newer unread message');
  await f.read(11);assert.equal(f.shown[0].closed,1);assert.equal(f.requests.length,0,'read acknowledgments never call the server');
 }finally{f.service.stop();}
});

test('each chat replaces its native toast with stable Windows tag/group; timeout does not lose cleanup',async()=>{
 const f=nativeAlerts();try{
  await f.notify(1);await f.notify(2);assert.equal(f.shown[0].closed,1,'old native toast is explicitly closed');assert.equal(f.shown[1].closed,0);
  const a=f.shown[0].options,b=f.shown[1].options;assert.equal(a.id,b.id);assert.equal(a.groupId,b.groupId);assert.match(a.id,/^[a-f0-9]{16}$/);assert.match(a.groupId,/^[a-f0-9]{16}$/);
  const other='c'.repeat(32);await f.notify(3,{channelId:other});assert.notEqual(f.shown[2].options.id,b.id);assert.equal(f.shown[2].options.groupId,b.groupId);
  f.shown[1].emit('close');await f.read(2);assert.equal(f.shown[1].closed,1,'timed-out toast can still be removed from Action Center');assert.equal(f.shown[2].closed,0,'another unread chat is retained');
 }finally{f.service.stop();}
 assert.equal(f.shown.at(-1).closed,1,'shutdown closes native alerts too');
});

test('reading during asynchronous notification preparation cancels the pending IPC and prevents resurrection',async()=>{
 const f=nativeAlerts();let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 f.client.registry=async()=>{entered();await gate;return[{serverId,name:'Synthetic'}];};
 try{const pending=f.notify(12);await ready;await f.read(12);assert.equal((await pending).value,false);release();await new Promise(setImmediate);assert.equal(f.shown.length,0);}
 finally{release();f.service.stop();}
});

test('a native show delayed until after reading is dismissed again',async()=>{
 const f=nativeAlerts();try{await f.notify(1);await f.read(1);assert.equal(f.shown[0].closed,1);f.shown[0].emit('show');assert.equal(f.shown[0].closed,2,'Windows async preparation cannot resurrect a read toast');}finally{f.service.stop();}
});

test('focus and shutdown are rechecked after asynchronous notification preparation',async()=>{
 let focused=false;const f=nativeAlerts({getWindow:()=>({isFocused:()=>focused})});let release,entered;let gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 f.client.registry=async()=>{entered();await gate;return[{serverId,name:'Synthetic'}];};
 try{const pending=f.notify(1);await ready;focused=true;release();assert.equal((await pending).value,false);assert.equal(f.shown.length,0);
  focused=false;gate=new Promise(r=>release=r);ready=new Promise(r=>entered=r);const next=f.notify(2);await ready;f.service.stop();assert.equal((await next).value,false);release();await new Promise(setImmediate);assert.equal(f.shown.length,0);
 }finally{release();f.service.stop();}
});

test('server departure closes delivered alerts and cancels pending batches',async()=>{
 const f=nativeAlerts();try{await f.notify(1);const pending=f.notify(2);await f.service.serverEnded(serverId);assert.equal((await pending).value,false);assert.equal(f.shown[0].closed,1);assert.equal((await f.notify(3)).value,false);}finally{f.service.stop();}
});

test('read IPC validates identity and cursor before effects and cannot be used by unauthorized senders',async()=>{
 const f=nativeAlerts();try{
  await assert.rejects(f.unauthorized('notify.read',{serverId,channelId,messageId:100}),/Unauthorized/);
  for(const input of [{serverId:'invalid',channelId,messageId:100},{serverId,channelId:'invalid',messageId:100},{serverId,channelId,messageId:-1},{serverId,channelId,messageId:'100'},{serverId,channelId,messageId:Number.MAX_SAFE_INTEGER+1}])assert.equal((await f.call('notify.read',input)).error.code,'INVALID_INPUT');
  assert.equal((await f.notify(1)).value,true,'invalid/unauthorized read did not advance the cursor');
  assert.equal((await f.notify(2,{lastMessageId:1})).error.code,'INVALID_INPUT');
 }finally{f.service.stop();}
});

test('mention priority retains the complete batch read boundary',async()=>{
 const f=nativeAlerts();try{await f.notify(10,{lastMessageId:12,mention:true,text:'Mention',batchCount:3});assert.equal((await f.notify(12)).value,false,'whole delivered batch is deduplicated');await f.read(12);assert.equal(f.shown[0].closed,1);assert.equal((await f.notify(13,{mention:true})).value,true,'new mentions after reading still notify');}finally{f.service.stop();}
});


test('sender avatar follows mention priority and reads cancel asynchronous avatar preparation',async()=>{
 const shown=[],avatars=[];class N{static isSupported(){return true;}constructor(options){shown.push(options);}on(){}show(){}}
 let release,entered;const gate=new Promise(resolve=>release=resolve),start=new Promise(resolve=>entered=resolve);
 const f=fixture({Notification:N,notificationAppearance:async input=>{avatars.push(input.avatar);entered();await gate;return{toastXml:'synthetic'};}});
 const base={serverId,channelId,channelName:'General',authorName:'Friend',text:'Mention'};
 try{
  const first=f.call('notify',{...base,messageId:10,mention:true,authorAvatar:'mention avatar'});
  const second=f.call('notify',{...base,messageId:11,authorAvatar:'ordinary avatar'});
  await start;await f.call('notify.read',{serverId,channelId,messageId:11});release();
  assert.equal((await first).value,false);assert.equal((await second).value,false);assert.deepEqual(avatars,['mention avatar']);assert.equal(shown.length,0);
  assert.equal((await f.call('notify',{...base,messageId:12,authorAvatar:'new avatar'})).value,true);
  assert.equal(shown.length,1);assert.equal(shown[0].toastXml,'synthetic');
 }finally{release();f.service.stop();}
});
