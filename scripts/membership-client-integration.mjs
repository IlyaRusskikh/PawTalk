// Invoked by Go's HTTP integration test against its real in-process API 2 handler.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MembershipClient } = require('../electron/membership-client.cjs');
const { MembershipLinks } = require('../electron/membership-links.cjs');
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const fixture = JSON.parse(raw);
function device() {
  const saved = new Map(), sent = [],wire={dropSendResponse:false,dropControlResponse:false,controlCalls:0};
  const client = new MembershipClient({
    credentials: { load: async key => saved.get(key) ?? null, save: async (key, value) => saved.set(key, value) },
    fetcher: async (url, options) => { sent.push(options.body || ''); const controlPost=options.method==='POST'&&new URL(url).pathname==='/api/v2/control';if(controlPost)wire.controlCalls++;const response=await fetch(url, options);if(controlPost&&wire.dropControlResponse){wire.dropControlResponse=false;await response.text();throw Object.assign(Error('synthetic lost control response'),{code:'ECONNRESET'});}if(wire.dropSendResponse&&options.method==='POST'&&new URL(url).pathname.endsWith('/messages')){wire.dropSendResponse=false;await response.text();throw Object.assign(Error('synthetic lost response'),{code:'ECONNRESET'});}return response; },
    verify: async address => assert.equal(new URL(address).origin, fixture.base), trust: async () => {}, allowLoopback: true,
  });
  return { client, saved, sent,wire };
}
const setup = new URL(fixture.base);
setup.hash = new URLSearchParams({ v: '2', server: fixture.serverId, invite: fixture.inviteId, token: fixture.token, setup: '1' }).toString();
const admin = device(), guest = device(), stranger = device();
const initial = await admin.client.join(setup.toString(), 'Synthetic admin', 'Synthetic PC');
assert.equal(initial.self.role, 'admin');
assert.equal(initial.channels.length, 2);
const link = await admin.client.invite(fixture.serverId, 'single');
admin.client.connections.clear(); // Recipient must succeed with inviter offline.
const state = await guest.client.join(link, 'Synthetic guest', 'Synthetic laptop');
assert.equal(state.self.role, 'member');
assert.equal(state.members.length, 2);
const secret = JSON.parse(guest.saved.get('pawtalk:server:v2:' + fixture.serverId)).secret;
assert.equal(secret, JSON.parse(admin.saved.get('pawtalk:server:v2:' + fixture.serverId)).secret);
for (const request of [...admin.sent, ...guest.sent]) assert.ok(!request.includes(secret), 'server received root secret');
assert.notEqual((await admin.client.identity()).profileId, (await guest.client.identity()).profileId);
await assert.rejects(stranger.client.join(link, 'Synthetic other', 'Synthetic phone'), error => error.code === 'INVITE_EXPIRED');
const records = await guest.client.registry();
assert.ok(records.every(record => !record.address.includes('#')));
guest.client.connections.clear();
const reconnected = await guest.client.connect(records[0]);
assert.equal(reconnected.self.effectiveProfileId, state.self.effectiveProfileId);
await admin.client.connect((await admin.client.registry())[0]);
const phone = device(), adminLinks = new MembershipLinks(admin.client), phoneLinks = new MembershipLinks(phone.client);
const pending = await adminLinks.start(fixture.serverId);
const proposal = await phoneLinks.propose(pending.text, 'Synthetic phone', 'Synthetic phone');
const targetView = await adminLinks.status(pending.id);
assert.equal(targetView.code, proposal.code);assert.equal(targetView.sourceNickname,'Synthetic phone');assert.equal(targetView.targetNickname,'Synthetic admin');
await adminLinks.approve(pending.id);
const linked = await phoneLinks.finish(pending.id);
assert.equal(linked.self.effectiveProfileId, initial.self.effectiveProfileId);
assert.equal(linked.self.role, 'admin');
assert.equal(linked.members.length, 2, 'linked phone must not duplicate administrator roster entry');
const channel = initial.channels.find(channel => channel.kind === 'text').id;
await admin.client.send(fixture.serverId, channel, { text: 'Synthetic encrypted message' });
const received = await phone.client.messages(fixture.serverId, channel);
assert.equal(received.messages[0].content.text, 'Synthetic encrypted message');
await phone.client.send(fixture.serverId, channel, { text: 'Edited from linked phone' }, received.messages[0]);
assert.equal((await admin.client.messages(fixture.serverId, channel)).messages[0].content.text, 'Edited from linked phone');
// Real encrypted image upload is staged, becomes readable only with its message,
// and uses the original sender's context after a linked-device edit.
const imageBytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1cAAAAASUVORK5CYII=','base64'));
const image = await phone.client.uploadImage(fixture.serverId,channel,imageBytes,'image/png');
await assert.rejects(admin.client.image(fixture.serverId,channel,image.id,image.mime),error=>error.code==='ATTACHMENT_NOT_FOUND');
await phone.client.send(fixture.serverId,channel,{text:'Synthetic image',image});
assert.equal(await admin.client.image(fixture.serverId,channel,image.id,image.mime),'data:image/png;base64,'+Buffer.from(imageBytes).toString('base64'));
const imageMessage=(await admin.client.messages(fixture.serverId,channel)).messages.at(-1);
await admin.client.send(fixture.serverId,channel,{text:'Image edited by linked desktop',image},imageMessage);
assert.equal((await phone.client.messages(fixture.serverId,channel)).messages.at(-1).content.image.id,image.id);
const control=await adminLinks.transferCreate(fixture.serverId,(await phone.client.identity()).deviceId);
const accepted=await phoneLinks.transferAccept(fixture.serverId,control);
admin.wire.dropControlResponse=true;await assert.rejects(adminLinks.transferFinish(fixture.serverId,accepted),error=>error.code==='ECONNRESET');
const [transferred,repeated]=await Promise.all([adminLinks.transferFinish(fixture.serverId,accepted),adminLinks.transferFinish(fixture.serverId,accepted)]);
assert.equal(repeated.controlRevision,transferred.controlRevision);assert.equal(admin.wire.controlCalls,2,'lost response and concurrent retry use one original mutation and one shared retry');
assert.equal((await adminLinks.transferFinish(fixture.serverId,accepted)).controlRevision,transferred.controlRevision,'post-success retry remains successful');
assert.equal(transferred.self.effectiveProfileId,initial.self.effectiveProfileId);
assert.equal(transferred.self.role,'admin');
const back=await phoneLinks.transferCreate(fixture.serverId,(await admin.client.identity()).deviceId);
await phoneLinks.transferFinish(fixture.serverId,await adminLinks.transferAccept(fixture.serverId,back));
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1cAAAAASUVORK5CYII=';
const rootProfile = (await phone.client.state(fixture.serverId)).profiles.find(profile => profile.id === linked.self.effectiveProfileId);
await phone.client.profile(fixture.serverId, 'Shared synthetic name', avatar, rootProfile.revision);
assert.equal((await admin.client.state(fixture.serverId)).profiles.find(profile => profile.id === rootProfile.id).avatar, avatar);
for (const request of phone.sent) assert.ok(!request.includes(avatar), 'server received plaintext avatar');
await phoneLinks.unlink(fixture.serverId, (await phone.client.identity()).deviceId);
const unlinked = await phone.client.state(fixture.serverId);
assert.equal(unlinked.self.effectiveProfileId, (await phone.client.identity()).profileId);
assert.equal(unlinked.self.role, 'member');
assert.equal(unlinked.members.length, 3);
await assert.rejects(phone.client.send(fixture.serverId, channel, { text: 'Forbidden after unlink' }, received.messages[0]), error => error.code === 'MESSAGE_NOT_OWNED');
for (const request of phone.sent) assert.ok(!request.includes(secret), 'link delivery disclosed root to API');
// Merge two existing groups through their current main devices. Detaching the
// former main must not reconstitute its former subgroup.
const guestLinks = new MembershipLinks(guest.client);
const groupLink = await guestLinks.start(fixture.serverId);
await phoneLinks.propose(groupLink.text, 'Synthetic phone', 'Synthetic phone');
await guestLinks.approve(groupLink.id); await phoneLinks.finish(groupLink.id);
const merge = await adminLinks.start(fixture.serverId);
await guestLinks.propose(merge.text, 'Synthetic guest', 'Synthetic laptop');
await adminLinks.approve(merge.id); await guestLinks.finish(merge.id);
assert.equal((await phone.client.state(fixture.serverId)).self.effectiveProfileId, initial.self.effectiveProfileId);
await guestLinks.unlink(fixture.serverId, (await guest.client.identity()).deviceId);
assert.equal((await guest.client.state(fixture.serverId)).self.effectiveProfileId, (await guest.client.identity()).profileId);
assert.equal((await phone.client.state(fixture.serverId)).self.effectiveProfileId, initial.self.effectiveProfileId);
// Resolve and navigate encrypted originals via the actual scoped HTTP endpoint.
const selected=await admin.client.messages(fixture.serverId,channel,{ids:[received.messages[0].id]});
assert.equal(selected.messages[0].content.text,'Edited from linked phone');
assert.equal((await admin.client.messages(fixture.serverId,channel,{around:selected.messages[0].id,limit:1})).messages[0].id,selected.messages[0].id);
admin.wire.dropSendResponse=true;const stableRequest='e'.repeat(32);
await assert.rejects(admin.client.send(fixture.serverId,channel,{text:'Synthetic retry integration'},undefined,stableRequest),error=>error.code==='ECONNRESET');
await admin.client.send(fixture.serverId,channel,{text:'Synthetic retry integration'},undefined,stableRequest);
assert.equal((await admin.client.messages(fixture.serverId,channel)).messages.filter(message=>message.requestId===stableRequest).length,1,'lost response retry creates exactly one message');
// Deferred departure uses the real API after restart, without reopening history.
const departing=device();
await departing.client.join(await admin.client.invite(fixture.serverId,'single'),'Synthetic departing','Synthetic desktop');
const stored=(await departing.client.registry())[0];
await departing.client.leave(fixture.serverId,{defer:true});
assert.equal((await departing.client.registry()).length,0);
const restarted=new MembershipClient({credentials:{load:async key=>departing.saved.get(key)??null,save:async(key,value)=>departing.saved.set(key,value)},fetcher:fetch,verify:async address=>assert.equal(new URL(address).origin,fixture.base),trust:async()=>{},allowLoopback:true});
assert.equal((await restarted.pendingDepartures())[0].outcome,'done');
assert.equal((await restarted.records()).length,0);
await assert.rejects(departing.client.connect(stored),error=>error.code==='NOT_A_MEMBER');
// The permanent server still rejects departure of the last administrator.
await admin.client.leave(fixture.serverId,{defer:true});
assert.equal((await admin.client.pendingDepartures())[0].outcome,'blocked');
assert.equal((await admin.client.registry())[0].leaveError,'LAST_ADMIN');
console.log('PASS real Go HTTP + main-process client: bootstrap, offline invitation, E2EE, single use, reconnect, X25519 links, group merge and independent unlink');
