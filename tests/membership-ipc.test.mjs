import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
const {registerMembershipIPC}=createRequire(import.meta.url)('../electron/membership-ipc.cjs');
const serverId='a'.repeat(32),channelId='b'.repeat(32),failure=code=>Object.assign(Error(code),{code});
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
