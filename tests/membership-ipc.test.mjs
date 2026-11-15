import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {registerMembershipIPC}=createRequire(import.meta.url)('../electron/membership-ipc.cjs');
const serverId='a'.repeat(32),channelId='b'.repeat(32),failure=code=>Object.assign(Error(code),{code});
function fixture(extra={}){
  let handler;const requests=[],endpoints=[],events=[];
  const client={connections:new Map([[serverId,{fingerprint:'c'.repeat(64)}]]),registry:async()=>[{serverId,address:'https://127.0.0.1',name:'Synthetic'}],state:async()=>({serverId}),request:async(...args)=>{requests.push(args);return {};},voice:async()=>({url:'wss://127.0.0.1/rtc',token:'synthetic'}),forget:async id=>client.connections.delete(id)};
  const service=registerMembershipIPC({...extra,ipcMain:{handle(_name,value){handler=value;}},authorized(event){if(!event.allowed)throw Error('Unauthorized');},client,links:{},clipboard:{writeText(){throw Error('must not reach clipboard');}},send:(...args)=>events.push(args),getWindow:()=>undefined,setVoiceEndpoint:value=>{endpoints.push(value);return value?'ws://127.0.0.1/synthetic':undefined;}});
  return{client,service,requests,endpoints,events,call:(action,input={})=>handler({allowed:true},action,input),unauthorized:()=>handler({},'copy',{text:'private'})};
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

 test('membership departures carry one modal event and ban expiry before forgetting',async()=>{
 const f=fixture();try{
  await f.call('servers');const expiresAt=Date.now()+60000;
  f.client.state=async()=>{throw Object.assign(failure('BANNED'),{details:{expiresAt}});};
  await f.call('connect',{serverId});await f.call('connect',{serverId});
  const notices=f.events.filter(event=>event[1]?.departure);assert.equal(notices.length,1);assert.deepEqual(notices[0][1].departure,{serverId,name:'Synthetic',kind:'ban',expiresAt});assert.equal(f.client.connections.has(serverId),false);
 }finally{f.service.stop();}
 const kick=fixture();try{await kick.call('servers');kick.client.state=async()=>{throw failure('NOT_A_MEMBER');};await kick.call('connect',{serverId});assert.equal(kick.events.find(event=>event[1]?.departure)[1].departure.kind,'kick');}finally{kick.service.stop();}
});
