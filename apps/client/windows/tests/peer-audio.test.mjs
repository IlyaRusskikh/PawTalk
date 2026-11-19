import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPeerAudio,savePeerAudio,projectPeerAudio,peerAudioStorageKey} from '../src/peerAudio.mjs';
test('peer volume survives fresh client state and changing voice identities, scoped to server/profile',()=>{
 const server='a'.repeat(32),otherServer='b'.repeat(32),profile='c'.repeat(64),linked='d'.repeat(64),data=new Map();
 const storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};
 savePeerAudio(storage,{[server+':'+profile]:{volume:1.65,muted:true}});
 const fresh=loadPeerAudio(storage);
 assert.deepEqual(projectPeerAudio(fresh,server,[{identity:'new-session',profileId:profile}],id=>id)['new-session'],{volume:1.65,muted:true});
 assert.deepEqual(projectPeerAudio(fresh,otherServer,[{identity:'same-person',profileId:profile}],id=>id)['same-person'],{volume:1,muted:false});
 assert.deepEqual(projectPeerAudio(fresh,server,[{identity:'linked-session',profileId:linked}],()=>profile)['linked-session'],{volume:1.65,muted:true});
 data.set(peerAudioStorageKey,'{invalid');assert.deepEqual(loadPeerAudio(storage),{});
 data.set(peerAudioStorageKey,JSON.stringify({[server+':'+profile]:{volume:100,muted:false}}));assert.deepEqual(loadPeerAudio(storage),{});
});
