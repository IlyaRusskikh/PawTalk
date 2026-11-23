import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPrivateKey, createPublicKey, sign, verify, createHash } from 'node:crypto';
import { signatureFrame } from '../../../../shared/framing.mjs';
const require = createRequire(import.meta.url);
const { MembershipClient } = require('../electron/membership-client.cjs');
const { verifyScopedRoleEdit } = require('../electron/protected-scoped-roles.cjs');
const { textRecipientBlind } = require('../electron/protected-channel-policy-commitments.cjs');
const serverPrivate = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 42)]), type: 'pkcs8', format: 'der' });
const serverPublic = createPublicKey(serverPrivate).export({ type: 'spki', format: 'der' }).subarray(-32);
const sid = createHash('sha256').update(serverPublic).digest('hex').slice(0, 32), iid = 'b'.repeat(32), pin = 'c'.repeat(64);
const address = `pawtalk://127.0.0.1:18443/${pin}#v=2&server=${sid}&invite=${iid}&token=${'d'.repeat(43)}&setup=1`;
const spki = Buffer.from('302a300506032b6570032100', 'hex');

test('protected roster restores authentic migrated avatars when the local room key is present', async () => {
  const { sealContent } = await import('../../../../shared/server-crypto.mjs');
  const author = '1'.repeat(64);
  const secret = '2'.repeat(64);
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5e8AAAAASUVORK5CYII=';
  const packet = await sealContent(secret, sid, 'avatar', '', author, author, new TextEncoder().encode(avatar));
  const envelope = Buffer.from(JSON.stringify(packet)).toString('base64');
  const connection = { serverId: sid, base: 'https://roster.test', config: { protectedLegacyAvatar: true } };
  let suppliedAuthor = author;
  let saved = JSON.stringify({ secret });
  const requests = [];
  const client = new MembershipClient({ credentials: { load: async () => saved }, fetcher: async url => {
    requests.push(new URL(url).searchParams.get('legacyAvatars'));
    return Response.json({ revision: 1, members: [{
      id: author, roles: [{ id: '@everyone' }], legacyAvatar: { envelope, author: suppliedAuthor },
    }] });
  } });
  assert.equal((await client.readProtectedRuntimeRoster(connection)).members[0].avatar, avatar);
  suppliedAuthor = '3'.repeat(64);
  assert.equal((await client.readProtectedRuntimeRoster(connection)).members[0].avatar, undefined);
  saved = undefined;
  assert.equal((await client.readProtectedRuntimeRoster(connection)).members[0].avatar, undefined);
  assert.deepEqual(requests, ['1', '1', null]);
});

test('protected requests share their session retry window without delaying other sessions or servers', async t => {
  t.mock.method(Date, 'now', () => now);
  let now = 0;
  const requests = [];
  const first = 'https://first.test', second = 'https://second.test';
  const session = { headers: { Authorization: 'Bearer first-session' } };
  const client = new MembershipClient({ credentials: {}, fetcher: async (address, options) => {
    requests.push(address);
    if (address.startsWith(first) && now < 2000 && options.headers.Authorization === session.headers.Authorization) {
      return Response.json({ error: { code: 'RATE_LIMIT' } }, { status: 429, headers: { 'Retry-After': '2' } });
    }
    return Response.json({ ok: true });
  } });
  await assert.rejects(client.fetchJSON(first, '/api/v3/state', session), { code: 'RATE_LIMIT', retryAfter: 2 });
  now = 1000;
  await assert.rejects(client.fetchJSON(first, '/api/v3/mentions/inbox', session), { code: 'RATE_LIMIT', retryAfter: 1 });
  assert.deepEqual(await client.fetchJSON(first, '/api/v3/session/challenge'), { ok: true });
  assert.deepEqual(await client.fetchJSON(first, '/api/v3/state', { headers: { Authorization: 'Bearer other-session' } }), { ok: true });
  assert.deepEqual(await client.fetchJSON(second, '/api/v3/state', session), { ok: true });
  now = 2000;
  assert.deepEqual(await client.fetchJSON(first, '/api/v3/state', session), { ok: true });
  assert.deepEqual(requests, [
    first + '/api/v3/state', first + '/api/v3/session/challenge', first + '/api/v3/state',
    second + '/api/v3/state', first + '/api/v3/state',
  ]);
});

test('community rename transport checks the pinned session and the committed name and revision', async () => {
  const connection = { base: 'https://127.0.0.1:12345', token: 'internal', fingerprint: pin };
  const input = { name: 'New name', revision: 4 };
  let response = { name: 'New name', revision: 5 };
  const client = new MembershipClient({ credentials: {}, fetcher: async (address, options) => {
    assert.equal(address, connection.base + '/api/v3/community/name');
    assert.equal(options.pawtalkTLSFingerprint, pin);
    assert.equal(options.headers.Authorization, 'Bearer internal');
    assert.equal(options.method, 'PUT');
    assert.deepEqual(JSON.parse(options.body), input);
    return Response.json(response);
  } });
  assert.deepEqual(await client.renameProtectedCommunity(connection, input), response);
  response = { name: 'Different name', revision: 5 };
  await assert.rejects(client.renameProtectedCommunity(connection, input), { code: 'INVALID_API_RESPONSE' });
});

test('protected activity is negotiated and presence comes from the scoped roster', async () => {
  const profileId = 'a'.repeat(64), channelId = 'b'.repeat(32);
  const connection = { base: 'https://127.0.0.1:12345', token: 'internal', fingerprint: pin };
  let reported = 0;
  let presence;
  const client = new MembershipClient({ credentials: {}, fetcher: async (address, options) => {
    assert.equal(options.pawtalkTLSFingerprint, pin);
    assert.equal(options.headers.Authorization, 'Bearer internal');
    if (address === connection.base + '/api/v3/activity') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { away: true });
      reported++;
      return Response.json({ ok: true });
    }
    assert.equal(address, connection.base + '/api/v3/roster/text/' + channelId);
    return Response.json({ revision: 1, channelId, members: [{ id: profileId, roles: [{ id: '@everyone' }], presence }] });
  } });
  await client.reportProtectedActivity(connection, true);
  assert.equal(reported, 0);
  assert.equal((await client.readProtectedRuntimeRoster(connection, channelId)).members[0].presence, undefined);
  await client.reportProtectedActivity({ ...connection, config: { protectedPresence: true } }, true);
  assert.equal(reported, 1);
  presence = 'away';
  assert.equal((await client.readProtectedRuntimeRoster(connection, channelId)).members[0].presence, 'away');
  presence = 'unknown';
  assert.equal((await client.readProtectedRuntimeRoster(connection, channelId)).members[0].presence, undefined);
});

test('nickname transport preserves roster capabilities and binds edits to the protected session and revision', async () => {
  const profileId = 'a'.repeat(64), channelId = 'b'.repeat(32);
  const nicknameDigest = 'c'.repeat(64);
  const connection = { base: 'https://127.0.0.1:12345', token: 'internal', fingerprint: pin };
  const client = new MembershipClient({ credentials: {}, fetcher: async (address, options) => {
    const url = new URL(address);
    assert.equal(url.origin, connection.base);
    assert.equal(options.pawtalkTLSFingerprint, pin);
    assert.equal(options.headers.Authorization, 'Bearer internal');
    if (url.pathname === `/api/v3/roster/text/${channelId}`) {
      return Response.json({ revision: 1, channelId, nicknameDigest, members: [{ id: profileId, name: 'Before', canEditNickname: true,
        roles: [{ id: '@everyone' }] }] });
    }
    assert.equal(url.pathname, `/api/v3/profiles/${profileId}/nickname`);
    if (options.method === 'GET') {
      assert.equal(url.searchParams.get('channel'), channelId);
      return Response.json({ name: 'Before', revision: 1 });
    }
    assert.equal(options.method, 'PUT');
    assert.deepEqual(JSON.parse(options.body), { name: 'After', revision: 1, channelId });
    return Response.json({ name: 'After', revision: 2 });
  } });
  const page = await client.readProtectedRuntimeRoster(connection, channelId);
  assert.equal(page.nicknameDigest, nicknameDigest);
  assert.equal(page.members[0].canEditNickname, true);
  assert.deepEqual(await client.protectedNickname(connection, profileId, channelId), { name: 'Before', revision: 1 });
  assert.deepEqual(await client.protectedNickname(connection, profileId, channelId, { name: 'After', revision: 1 }),
    { name: 'After', revision: 2 });
});

test('delegated role transport pins the session, signs the reviewed delta and verifies the server receipt', async () => {
  const operationId = '1'.repeat(32), profileId = '2'.repeat(64), targetProfileId = '3'.repeat(64), rosterChannelId = '4'.repeat(32);
  const policyHead = '5'.repeat(64), cutoverDigest = '6'.repeat(64), digest = '7'.repeat(64);
  const devicePublic = createPublicKey(serverPrivate).export({ type: 'spki', format: 'der' }).subarray(-32);
  const deviceId = createHash('sha256').update(devicePublic).digest('hex');
  const connection = { base: 'https://127.0.0.1:12345', token: 'internal', fingerprint: pin, profileId, deviceId,
    policyTrust: { serverId: sid, cutoverDigest } };
  const change = { revision: 4, policyHead, targetProfileId, rosterChannelId, add: ['reader'] };
  const impact = { id: rosterChannelId, keyUpdate: true, viewAdded: 1, viewRemoved: 0, fullHistoryAdded: 0, fullHistoryRemoved: 0 };
  const seed = 'a'.repeat(64);
  const rosterSalt = textRecipientBlind(Buffer.from(seed, 'hex'), Buffer.from(rosterChannelId), 30, '').toString('hex');
  const rosterCommitment = createHash('sha256').update(signatureFrame('pawtalk-role-roster-alias-v1', rosterChannelId, rosterSalt)).digest('hex');
  let tamper = false, blindedRoster = false;
  const client = new MembershipClient({ fetcher: async (address, options) => {
    const url = new URL(address);
    assert.equal(url.origin, connection.base);
    assert.equal(options.pawtalkTLSFingerprint, pin);
    assert.equal(options.headers.Authorization, 'Bearer internal');
    if (url.pathname.endsWith('/scoped')) {
      assert.equal(url.searchParams.get('profile'), targetProfileId);
      assert.equal(url.searchParams.get('channel'), rosterChannelId);
      return Response.json({ revision: 4, policyHead, targetProfileId, rosterChannelId,
        assignments: [{ id: 'reader', assigned: false, canAssign: true }] });
    }
    const request = JSON.parse(options.body);
    if (url.pathname.endsWith('/preview')) {
      assert.deepEqual(request, change);
      return Response.json({ revision: 4, policyHead, channels: [impact], ...(blindedRoster && { rosterSalt }) });
    }
    assert.equal(url.pathname, '/api/v3/roles/scoped/commit');
    assert.equal(request.operationId, operationId);
    assert.deepEqual(request.change, blindedRoster ? { ...change, rosterCommitment } : change);
    assert.match(request.signature, /^[A-Za-z0-9_-]{86}$/);
    const actor = { ProfileID: profileId, DeviceID: deviceId };
    const previous = { revision: 4, digest: policyHead, textProjectionVersion: blindedRoster ? 18 : 17, textProjectionSeed: seed };
    const draft = { OperationID: operationId, ResourceChange: { ID: '', RolesEdit: {
      Change: request.change, CutoverDigest: cutoverDigest, EditorProof: request.signature, ServerKey: serverPublic.toString('base64url'),
    } } };
    const device = { ProfileID: profileId, PublicKey: devicePublic.toString('hex') };
    verifyScopedRoleEdit(connection.policyTrust, actor, draft, previous, device);
    if (blindedRoster) {
      const otherChannel = structuredClone(draft);
      otherChannel.ResourceChange.RolesEdit.Change.rosterChannelId = '0'.repeat(32);
      assert.throws(() => verifyScopedRoleEdit(connection.policyTrust, actor, otherChannel, previous, device));
    }
    const frame = signatureFrame('pawtalk-protected-roles-receipt-v1', sid, cutoverDigest, profileId, deviceId,
      operationId, policyHead, '5', digest, request.signature);
    return Response.json({ operationId, revision: 5, digest: tamper ? '8'.repeat(64) : digest,
      serverKey: serverPublic.toString('base64url'), signature: sign(null, frame, serverPrivate).toString('base64url') });
  } });
  client.identity = async () => ({ device: serverPrivate, deviceId });
  assert.equal((await client.readScopedRoles(connection, targetProfileId, rosterChannelId)).assignments[0].id, 'reader');
  assert.deepEqual(await client.previewScopedRoles(connection, change), [impact]);
  await client.commitScopedRoles(connection, operationId, change);
  blindedRoster = true;
  assert.deepEqual(await client.previewScopedRoles(connection, change), [impact]);
  await client.commitScopedRoles(connection, operationId, change);
  tamper = true;
  await assert.rejects(client.commitScopedRoles(connection, operationId, change), { code: 'INVALID_PROTECTED_ROLE_SIGNATURE' });
});

function fixture({ failKeySave = false, failPin = false, wrongBinding = false, wrongServerKey = false, malformedState=false } = {}) {
  const entries = new Map(), events = [], requests = [],wire={offline:false,applied:false,leaveError:null,dropResponse:false,saveFail:false}; let keyId, counter = 0, lastChallenge;
  const credentials = {
    load: async key => entries.get(key) ?? null,
    save: async (key, value) => {
      if(wire.saveFail&&key==='pawtalk:memberships:v2')throw Error('OS storage unavailable');
      if (failKeySave && key.startsWith('pawtalk:server:v2:') && JSON.parse(value).secret) throw Error('OS storage unavailable');
      entries.set(key, value); events.push({ key, value });
    },
  };
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname; if(wire.offline)throw Object.assign(Error('refused'),{code:'ECONNREFUSED'});requests.push({ path, ...options });
    const reply = (result, status = 200) => new Response(JSON.stringify(result), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/api/config') {
      const binding = wrongBinding ? 'origin:https://another.invalid' : 'tls-sha256:' + pin;
      const frame = signatureFrame('pawtalk-server-v2', sid, binding, '2', 'Test server', keyId ? '1' : '0', '1');
      return reply({ apiProtocolVersion: 2, e2eeRequired: true, serverId: sid, authBinding: binding, name: 'Test server', initialized: !!keyId, revision: 1,
        identityKey: (wrongServerKey ? Buffer.alloc(32, 1) : serverPublic).toString('base64url'), identitySignature: sign(null, frame, serverPrivate).toString('base64url') });
    }
    if (path === '/api/v2/challenge') {
      lastChallenge = { challenge: (++counter).toString(16).padStart(32, '0'), nonce: Buffer.alloc(32, counter).toString('base64url'), serverId: sid };
      return reply(lastChallenge);
    }
    if (options.headers['X-PawTalk-Proof']) {
      const proof = JSON.parse(Buffer.from(options.headers['X-PawTalk-Proof'], 'base64url').toString());
      const publicKey = value => createPublicKey({ key: Buffer.concat([spki, Buffer.from(value, 'base64url')]), type: 'spki', format: 'der' });
      assert.ok(verify(null, signatureFrame('pawtalk-device-v2', proof.profileKey, proof.deviceKey), publicKey(proof.profileKey), Buffer.from(proof.certificate, 'base64url')));
      const hash = createHash('sha256').update(options.body).digest('hex');
      assert.ok(verify(null, signatureFrame('pawtalk-request-v2', sid,proof.binding, 'POST', path, lastChallenge.challenge, lastChallenge.nonce, hash), publicKey(proof.deviceKey), Buffer.from(proof.signature, 'base64url')));
    }
    if (path.endsWith('/prepare')) return reply({ attemptId: 'e'.repeat(32), deadline: Date.now() + 120000, kind: 'bootstrap', state: 'reserved', keyPackage: null, packageDigest: '' });
    if (path.endsWith('/confirm')) {
      const input = JSON.parse(options.body), saved = JSON.parse(entries.get('pawtalk:server:v2:' + sid));
      assert.match(saved.secret, /^[0-9a-f]{64}$/, 'protected key save must finish before confirm');
      keyId = input.keyId; return reply({ sessionToken: 'f'.repeat(43), self: { profileId: '1'.repeat(64), role: 'admin' } });
    }
    if (path.endsWith('/session')) return wire.applied?reply({error:{code:'NOT_A_MEMBER'}},403):reply({ sessionToken: 'f'.repeat(43) });
    if(path==='/api/v2/leave'){if(wire.leaveError)return reply({error:{code:wire.leaveError}},409);wire.applied=true;if(wire.dropResponse)throw Object.assign(Error('lost response'),{code:'ECONNRESET'});return reply({ok:true});}
    if (path.endsWith('/state')) {const identity=await client.identity();return reply({ serverId: sid, keyId, capabilities:wire.capabilities, name:wire.name||'Test server',revision:1,controlRevision:1,self:{profileId:identity.profileId,deviceId:identity.deviceId,effectiveProfileId:identity.profileId,role:'admin',permissions:[]}, channels: [], members: malformedState?null:[], profiles: [],devices:[],voice:[],bindings:[] });}
    throw Error('Unexpected request ' + path);
  };
  const client = new MembershipClient({ credentials, fetcher, verify: async () => { if (failPin) throw Error('pin mismatch'); return pin; }, trust: async () => {}, allowLoopback: true });
  return { client, entries, events, requests,wire,restart:()=>new MembershipClient({credentials,fetcher,verify:async()=>pin,trust:async()=>{},allowLoopback:true}) };
}

test('protected own device inventory uses the pinned session and validates its complete ID list', async () => {
  const { client } = fixture();
  const current = '1'.repeat(64), linked = '2'.repeat(64);
  const connection = { base: 'https://127.0.0.1', fingerprint: pin, token: 'internal-session', deviceId: current };
  let response = { deviceIds: [current, linked] };
  client.fetchJSON = async (base, path, options) => {
    assert.equal(base, connection.base);
    assert.equal(path, '/api/v3/devices/self');
    assert.deepEqual(options, { fingerprint: pin, headers: { Authorization: 'Bearer internal-session' } });
    return response;
  };
  assert.deepEqual(await client.listProtectedOwnDevices(connection), response.deviceIds);
  for (const ids of [null, [linked], [current, current], [current, { deviceId: linked }],
    [current, 'A'.repeat(64)], Array.from({ length: 8193 }, (_, i) => i.toString(16).padStart(64, '0'))]) {
    response = { deviceIds: ids };
    await assert.rejects(client.listProtectedOwnDevices(connection), { code: 'INVALID_API_RESPONSE' });
  }
});

test('main-process bootstrap verifies proofs, saves secret before confirm and never sends root', async () => {
  const f = fixture(); await f.client.join(address, 'Test', 'Test device');
  const saved = JSON.parse(f.entries.get('pawtalk:server:v2:' + sid));
  assert.match(saved.secret, /^[0-9a-f]{64}$/);
  assert.ok(!saved.pending);
  for (const request of f.requests) assert.ok(!JSON.stringify(request).includes(saved.secret), 'root leaked to transport');
  const servers = await f.client.registry(); assert.equal(servers.length, 1); assert.ok(!servers[0].address.includes('#'));
  const firstIdentity = await f.client.identity();
  assert.equal((await f.client.identity()).profileId, firstIdentity.profileId);
  // A repeated setup link from an already active client uses membership, not a
  // second bootstrap and does not replace the saved server secret.
  await f.client.join(address, 'Test', 'Test device');
  assert.equal(f.requests.filter(request => request.path.endsWith('/confirm')).length, 1);
});

test('key-storage failure prevents confirmation and pin failure prevents all HTTP', async () => {
  const f = fixture({ failKeySave: true });
  await assert.rejects(f.client.join(address, 'Test', 'Test device'), /OS storage unavailable/);
  assert.equal(f.requests.filter(request => request.path.endsWith('/confirm')).length, 0);
  const pinned = fixture({ failPin: true });
  await assert.rejects(pinned.client.join(address, 'Test', 'Test device'), /pin mismatch/);
  assert.equal(pinned.requests.length, 0);
});

test('public server ID cannot substitute another transport or signing identity', async () => {
  for (const options of [{ wrongBinding: true }, { wrongServerKey: true }]) {
    const f = fixture(options);
    await assert.rejects(f.client.join(address, 'Test', 'Test device'), error => ['SERVER_BINDING_MISMATCH', 'INVALID_SERVER_IDENTITY'].includes(error.code));
    assert.deepEqual(f.requests.map(request => request.path), ['/api/config']);
    assert.equal(f.entries.size, 0, 'untrusted config caused identity or root storage');
  }
});
test('malformed server state is rejected in main before it can crash the renderer',async()=>{
  const f=fixture({malformedState:true});await assert.rejects(f.client.join(address,'Test','Test device'),error=>error.code==='INVALID_API_RESPONSE');
});

test('address change preserves membership and root, rejects another server before sending identity', async () => {
  const f = fixture(); await f.client.join(address, 'Test', 'PC');
  const before = f.entries.get('pawtalk:server:v2:' + sid), confirmations = f.requests.filter(request => request.path.endsWith('/confirm')).length;
  const updated = address.replace(':18443/', ':19443/').split('#')[0];
  await f.client.changeAddress(sid, updated);
  assert.equal((await f.client.registry())[0].address, updated);
  assert.equal(f.entries.get('pawtalk:server:v2:' + sid), before);
  assert.equal(f.requests.filter(request => request.path.endsWith('/confirm')).length, confirmations);
  const count = f.requests.length;
  await assert.rejects(f.client.changeAddress('0'.repeat(32), updated), error => error.code === 'NOT_A_MEMBER');
  assert.equal(f.requests.length, count);
});

test('moving a protected server keeps its saved identity and commits only after API 3 authentication', async () => {
  const registry = 'pawtalk:memberships:v2', trustSlot = 'pawtalk:protected-runtime:v1:' + sid;
  const savedAddress = `pawtalk://127.0.0.1:18443/${pin}/v3`;
  const cutoverDigest = '1'.repeat(64), anchorDigest = '2'.repeat(64), binding = '3'.repeat(64);
  const trust = { serverId: sid, cutoverDigest, anchorDigest, ownerProfileId: '4'.repeat(64), ownerDeviceId: '5'.repeat(64) };
  const entries = new Map([[registry, JSON.stringify([{ serverId: sid, address: savedAddress, name: 'Saved server' }])],
    [trustSlot, JSON.stringify(trust)]]);
  const requests = [], trusted = [];
  let refuseSession = false;
  const client = new MembershipClient({ protectedOnly: true,
    credentials: { load: async key => entries.get(key), save: async (key, value) => entries.set(key, value) },
    verify: async target => {
      assert.equal(new URL(target).pathname, `/${pin}/v3`);
      assert.equal(new URL(target).hash, '');
      return pin;
    },
    trust: async address => trusted.push(address),
    fetcher: async (address, options) => {
      const url = new URL(address);
      requests.push(url.pathname);
      assert.notEqual(url.port, '18443', 'The old endpoint may be unavailable');
      assert.equal(options.pawtalkTLSFingerprint, pin);
      if (url.pathname === '/api/config') {
        const anchor = url.port === '20443' ? 'f'.repeat(64) : anchorDigest;
        const frame = signatureFrame('pawtalk-server-v3', sid, '3', '4', 'Saved server', binding, cutoverDigest, anchor, 'true', 'false');
        return Response.json({ apiProtocolVersion: 3, dataSchemaVersion: 4, serverId: sid, e2eeRequired: true, name: 'Saved server',
          binding, cutoverDigest, anchorDigest: anchor, protectedVoice: false, identityKey: serverPublic.toString('base64url'),
          identitySignature: sign(null, frame, serverPrivate).toString('base64url') });
      }
      if (url.pathname === '/api/v3/session/challenge') {
        return Response.json({ apiProtocolVersion: 3, serverId: sid, cutoverDigest, binding,
          nonce: '6'.repeat(64), expiresAt: Date.now() + 10000 });
      }
      if (url.pathname === '/api/v3/session/open') {
        const { deviceId, nonce, signature } = JSON.parse(options.body);
        const identity = await client.identity();
        assert.equal(deviceId, identity.deviceId);
        const frame = signatureFrame('pawtalk-protected-session-v1', sid, cutoverDigest, binding, nonce, deviceId);
        assert.ok(verify(null, frame, createPublicKey(identity.device), Buffer.from(signature, 'base64url')));
        if (refuseSession) return Response.json({ error: { code: 'INVALID_PROTECTED_SESSION_PROOF' } }, { status: 401 });
        return Response.json({ deviceId, profileId: identity.profileId, sessionId: '7'.repeat(32),
          token: Buffer.alloc(32, 8).toString('base64url'), expiresAt: Date.now() + 10000 });
      }
      assert.equal(url.pathname, '/api/v3/state');
      assert.equal(options.headers.Authorization, 'Bearer ' + Buffer.alloc(32, 8).toString('base64url'));
      return Response.json({ Channels: [], Events: [] });
    },
  });
  const identity = await client.identity();
  const source = new Map(entries);
  await assert.rejects(client.changeProtectedAddress(sid, '127.0.0.1:20443'), { code: 'PROTECTED_CUTOVER_CHANGED' });
  assert.deepEqual(requests.splice(0), ['/api/config']);
  assert.deepEqual(entries, source);
  assert.deepEqual(trusted, []);
  refuseSession = true;
  await assert.rejects(client.changeProtectedAddress(sid, '127.0.0.1:19443'), { code: 'INVALID_PROTECTED_SESSION_PROOF' });
  assert.deepEqual(entries, source);
  assert.deepEqual(trusted, []);
  requests.length = 0;
  refuseSession = false;
  const moved = await client.changeProtectedAddress(sid, '127.0.0.1:19443');
  assert.equal(moved.state.profileId, identity.profileId);
  assert.equal(moved.connection.deviceId, identity.deviceId);
  assert.deepEqual(requests, ['/api/config', '/api/v3/session/challenge', '/api/v3/session/open', '/api/v3/state']);
  assert.equal((await client.registry())[0].address, savedAddress.replace(':18443/', ':19443/'));
  assert.equal(entries.get(trustSlot), source.get(trustSlot));
  assert.deepEqual(trusted, [moved.connection.address]);
  assert.equal((await client.openStoredProtectedRuntime(sid)).address, moved.connection.address);
});

test('offline departure survives restart, stays hidden and only authenticates to send leave',async()=>{
  const f=fixture();await f.client.join(address,'Test','PC');
  const root=f.entries.get('pawtalk:server:v2:'+sid),identity=f.entries.get('pawtalk:identity:v2');
  f.wire.offline=true;await f.client.leave(sid,{defer:true});
  assert.deepEqual(await f.client.registry(),[]);
  const record=(await f.client.records())[0],next=f.restart();
  assert.deepEqual(await next.registry(),[]);assert.equal((await next.pendingDepartures(1000))[0].outcome,'retry');
  assert.equal((await next.records())[0].pendingLeave.nextAttempt,61000);
  const count=f.requests.length;f.wire.offline=false;
  assert.equal((await next.pendingDepartures(61000))[0].outcome,'done');
  assert.deepEqual(await next.records(),[]);
  assert.ok(!f.requests.slice(count).some(request=>request.path==='/api/v2/state'),'hidden server resumed ordinary state/history traffic');
  const leave=f.requests.find(request=>request.path==='/api/v2/leave');assert.equal(JSON.parse(leave.body).requestId,record.pendingLeave.requestId);
  assert.equal(f.entries.get('pawtalk:server:v2:'+sid),root);assert.equal(f.entries.get('pawtalk:identity:v2'),identity);
});

test('lost leave response is reconciled, while last-admin refusal restores the visible server',async()=>{
  const f=fixture();await f.client.join(address,'Test','PC');await f.client.leave(sid,{defer:true});
  f.wire.dropResponse=true;assert.equal((await f.client.pendingDepartures(0))[0].outcome,'retry');
  assert.equal((await f.client.pendingDepartures(60000))[0].outcome,'done');
  assert.equal(f.requests.filter(request=>request.path==='/api/v2/leave').length,1);
  const admin=fixture();await admin.client.join(address,'Admin','PC');await admin.client.leave(sid,{defer:true});admin.wire.leaveError='LAST_ADMIN';
  assert.equal((await admin.client.pendingDepartures(0))[0].outcome,'blocked');
  const visible=await admin.client.registry();assert.equal(visible.length,1);assert.equal(visible[0].leaveError,'LAST_ADMIN');assert.ok(!visible[0].pendingLeave);
});

test('failed durable save keeps membership visible; a pending leave cannot silently rejoin',async()=>{
  const f=fixture();await f.client.join(address,'Test','PC');f.wire.saveFail=true;
  await assert.rejects(f.client.leave(sid,{defer:true}),/OS storage unavailable/);assert.equal((await f.client.registry()).length,1);assert.ok(f.client.connections.has(sid));
  f.wire.saveFail=false;await f.client.leave(sid,{defer:true});const before=f.requests.length;
  await assert.rejects(f.client.connect({serverId:sid,address}),{code:'LEAVE_PENDING'});
  await assert.rejects(f.client.join(address,'Test','PC'),{code:'LEAVE_PENDING'});assert.equal(f.requests.length,before);
});

test('retry after a lost send response reuses exact encrypted packet and request ID',async()=>{
 const client=new MembershipClient({credentials:{load:async()=>null,save:async()=>{}},fetcher:fetch,verify:async()=>{},trust:async()=>{}});
 client.connections.set(sid,{secret:'a'.repeat(64)});client.identity=async()=>({profileId:'b'.repeat(64)});
 const requests=[];client.request=async(_server,_path,_method,body)=>{requests.push(body);if(requests.length===1)throw Object.assign(Error('response lost'),{code:'ECONNRESET'});return{id:123};};
 const id='d'.repeat(32),cid='c'.repeat(32),content={text:'Synthetic retry'};
 await assert.rejects(client.send(sid,cid,content,undefined,id),{code:'ECONNRESET'});
 await assert.rejects(client.send(sid,cid,{text:'different'},undefined,id),{code:'REQUEST_CONFLICT'});
 assert.deepEqual(await client.send(sid,cid,content,undefined,id),{id:123});assert.deepEqual(requests[0],requests[1]);assert.equal(client.pendingMessages.size,0);
});

test('API 2 single photo variants retain the legacy image entry and bind every object', async () => {
 const client = new MembershipClient({ credentials: {}, fetcher: fetch });
 const connection = { secret: 'a'.repeat(64), config: { capabilities: ['attachment-removal-v1'] } };
 client.connections.set(sid, connection);
 const authorProfileId = 'b'.repeat(64), channelId = 'c'.repeat(32);
 client.identity = async () => ({ profileId: authorProfileId });
 const requests = [];
 client.request = async (_server, _path, _method, body) => { requests.push(body); return { id: 123 }; };
 const image = { id: '1'.repeat(32), mime: 'image/jpeg', name: 'Original.jpg', size: 1200000,
   preview: { id: '2'.repeat(32), mime: 'image/webp', size: 50000 },
   view: { id: '3'.repeat(32), mime: 'image/webp', size: 400000 } };
 await assert.rejects(client.send(sid, channelId, { text: 'Photo', image }), { code: 'UNSUPPORTED_FEATURE' });
 connection.config.capabilities.push('media-variants-v1');
 await assert.rejects(client.send(sid, channelId, { text: '', image: { ...image, view: image.preview } }), { code: 'INVALID_ATTACHMENT' });
 await assert.rejects(client.send(sid, channelId, { text: '', image: { ...image, preview: { ...image.preview, size: 81921 } } }), { code: 'INVALID_ATTACHMENT' });
 assert.equal(requests.length, 0);
 await client.send(sid, channelId, { text: 'Photo', image });
 assert.deepEqual(requests[0].attachmentIds, [image.id, image.preview.id, image.view.id]);
 const [message] = await client.decodeMessages(sid, channelId, [{ ...requests[0], id: 123, channelId, authorProfileId }]);
 assert.deepEqual(message.content.image, image);
 await client.send(sid, channelId, { text: 'Photo removed' }, message);
 assert.equal(requests[1].removeAttachment, true);
 assert.deepEqual(requests[1].attachmentIds, []);
});

test('authenticated state updates saved server name without changing the signed config',async()=>{
 const f=fixture();await f.client.join(address,'Test','Device');const config=f.client.connections.get(sid).config;
 f.wire.name='Shared new name';await f.client.state(sid);
 assert.equal((await f.client.registry())[0].name,'Shared new name');assert.equal(config.name,'Test server');
});

test('authenticated server errors preserve bounded ban details for local presentation',async()=>{
 const client=new MembershipClient({credentials:{},fetcher:async()=>new Response(JSON.stringify({error:{code:'BANNED',details:{expiresAt:1234567890000,membershipState:'kicked',untrusted:'ignored'}}}),{status:403})});
 await assert.rejects(client.fetchJSON('https://example.test','/api/v2/state'),error=>error.code==='BANNED'&&error.details.expiresAt===1234567890000&&!('untrusted' in error.details));
});

 test('server restart refreshes feature gates from authenticated state',async()=>{
 const f=fixture();await f.client.join(address,'Test','Device');
 const connection=f.client.connections.get(sid);assert.ok(!connection.config.capabilities?.includes('checklists-v1'));
 f.wire.capabilities=['checklists-v1','media-files-v1'];await f.client.state(sid);
 assert.deepEqual(connection.config.capabilities,f.wire.capabilities);
 f.wire.capabilities=[];await f.client.state(sid);assert.deepEqual(connection.config.capabilities,[]);
 f.wire.capabilities=[123];await assert.rejects(f.client.state(sid),{code:'INVALID_API_RESPONSE'});
 });
