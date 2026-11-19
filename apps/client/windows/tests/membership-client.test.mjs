import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPrivateKey, createPublicKey, sign, verify, createHash } from 'node:crypto';
import { signatureFrame } from '../../../../shared/framing.mjs';
const require = createRequire(import.meta.url);
const { MembershipClient } = require('../electron/membership-client.cjs');
const serverPrivate = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 42)]), type: 'pkcs8', format: 'der' });
const serverPublic = createPublicKey(serverPrivate).export({ type: 'spki', format: 'der' }).subarray(-32);
const sid = createHash('sha256').update(serverPublic).digest('hex').slice(0, 32), iid = 'b'.repeat(32), pin = 'c'.repeat(64);
const address = `pawtalk://127.0.0.1:18443/${pin}#v=2&server=${sid}&invite=${iid}&token=${'d'.repeat(43)}&setup=1`;
const spki = Buffer.from('302a300506032b6570032100', 'hex');
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
