import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {MembershipClient}=createRequire(import.meta.url)('../electron/membership-client.cjs');

test('encrypted documents preserve original bytes above the old limit; older peers and oversized uploads reject',async()=>{
 const serverId='a'.repeat(32),channelId='b'.repeat(32),profileId='c'.repeat(64);
 const client=new MembershipClient({});client.connections.set(serverId,{secret:'d'.repeat(64),config:{capabilities:['media-files-v1']}});
 client.identity=async()=>({profileId});let packet;
 client.request=async(_server,_path,method,body)=>{if(method==='POST'){packet=body;return {ok:true};}return {packet,authorProfileId:profileId};};
 const bytes=new Uint8Array(3*1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 const uploaded=await client.uploadFile(serverId,channelId,bytes,'application/octet-stream');
 assert.equal(uploaded.mime,'application/octet-stream');
 assert.deepEqual(await client.file(serverId,channelId,uploaded.id),bytes);
 await assert.rejects(client.uploadFile(serverId,channelId,new Uint8Array(50*1024*1024+1),'application/octet-stream'),{code:'INVALID_ATTACHMENT'});
 client.connections.get(serverId).config.capabilities=[];
 await assert.rejects(client.uploadFile(serverId,channelId,bytes,'application/octet-stream'),{code:'UNSUPPORTED_FEATURE'});
 await assert.rejects(client.uploadFile(serverId,channelId,new Uint8Array(1),'text/html'),{code:'INVALID_ATTACHMENT'});
});

test('voice metadata survives authenticated encryption and malformed waveform is rejected',async()=>{
 const serverId='a'.repeat(32),channelId='b'.repeat(32),profileId='c'.repeat(64),secret='d'.repeat(64),requestId='e'.repeat(32);
 const client=new MembershipClient({});client.connections.set(serverId,{secret,config:{capabilities:[]}});client.identity=async()=>({profileId});let wire;
 client.request=async(_server,_path,_method,body)=>{wire=body;return{id:1};};
 const file={id:'f'.repeat(32),name:'voice.webm',mime:'audio/webm',size:100,voice:{duration:3.2,waveform:[0,.1,1]}};
 await client.send(serverId,channelId,{text:'',file},undefined,requestId);
 const {openContent}=await import('../../../../shared/server-crypto.mjs');
 const clear=await openContent(secret,serverId,'chat',channelId,requestId,profileId,{version:2,keyId:wire.keyId,nonce:wire.nonce,ciphertext:wire.ciphertext});
 assert.deepEqual(JSON.parse(new TextDecoder().decode(clear)).file.voice,file.voice);
 await assert.rejects(client.send(serverId,channelId,{text:'',file:{...file,voice:{duration:1,waveform:[2]}}}),{code:'INVALID_ATTACHMENT'});
});

test('gallery binds every encrypted video and poster, validates IDs and gates old servers',async()=>{
 const serverId='a'.repeat(32),channelId='b'.repeat(32),profileId='c'.repeat(64),secret='d'.repeat(64),requestId='e'.repeat(32);
 const client=new MembershipClient({});client.connections.set(serverId,{secret,config:{capabilities:['media-gallery-v1']}});client.identity=async()=>({profileId});let wire;
 client.request=async(_server,_path,_method,body)=>{wire=body;return{id:1};};
 const files=Array.from({length:10},(_,i)=>({id:(i*2+1).toString(16).padStart(32,'0'),poster:{id:(i*2+2).toString(16).padStart(32,'0'),mime:'image/jpeg'},name:`clip-${i}.webm`,mime:'video/webm',size:100,duration:3}));
 await client.send(serverId,channelId,{text:'Gallery',files},undefined,requestId);
 assert.equal(wire.attachmentIds.length,20);assert.equal(new Set(wire.attachmentIds).size,20);
 const {openContent}=await import('../../../../shared/server-crypto.mjs');
 const clear=await openContent(secret,serverId,'chat',channelId,requestId,profileId,{version:2,keyId:wire.keyId,nonce:wire.nonce,ciphertext:wire.ciphertext});
 assert.deepEqual(JSON.parse(new TextDecoder().decode(clear)).files,files);
 for(const invalid of [[...files,files[0]],[files[0],files[0]],[{...files[0],poster:{id:files[0].id,mime:'image/jpeg'}}],[{...files[0],poster:{id:'f'.repeat(32),mime:'text/html'}}]])await assert.rejects(client.send(serverId,channelId,{text:'',files:invalid}),{code:'INVALID_ATTACHMENT'});
 client.connections.get(serverId).config.capabilities=[];
 await assert.rejects(client.send(serverId,channelId,{text:'',files}),{code:'UNSUPPORTED_FEATURE'});
 await assert.rejects(client.send(serverId,channelId,{text:'',file:files[0]}),{code:'UNSUPPORTED_FEATURE'});
});
