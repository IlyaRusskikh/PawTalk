const {VoiceSignal}=require('./voice-signal.cjs');
const id=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
// One shared subscription per server; the legacy channel stream stays available
// only for peers without server-events-v1. Tokens never enter the renderer.
class MembershipLive {
 constructor(client,send,snapshot=()=>{}){this.client=client;this.send=send;this.snapshot=snapshot;this.entries=new Map();}
 async reconcileSequence(serverId){const entry=this.entries.get(serverId);if(!entry?.wide||!entry.online||Date.now()-(entry.checked||0)<30000)return;entry.checked=Date.now();const value=await this.client.request(serverId,'/api/v2/events/status');if(!Number.isSafeInteger(value.sequence)||value.sequence<0)throw Error('Invalid event sequence');if(entry.closed)return;if(value.sequence>(entry.sequence||0)){entry.sequence=value.sequence;this.send('membership-server-event',{serverId,type:'resync'});if(this.active?.serverId===serverId)this.send('membership-chat-changed',{serverId,channelId:this.active.channelId});}}
 healthy(serverId){return !!this.entries.get(serverId)?.online&&this.entries.get(serverId).wide;}
 ensure(serverId,state,channelId){
  const wide=state.capabilities?.includes('server-events-v1');if(!wide&&!channelId)return;
  if(!wide&&!state.capabilities?.includes('chat-events-v1'))return;
  const payloads=wide&&state.capabilities?.includes('message-events-v1');
  const path=wide?(payloads?'/api/v2/events/messages':'/api/v2/events'):'/api/v2/channels/'+channelId+'/events',previous=this.entries.get(serverId);
  if(previous?.path===path)return;
  if(previous)this.closeEntry(previous);
  const entry={serverId,path,wide,payloads,channelId,decodeEpoch:0,decodeCount:0,decodeBytes:0,decoding:Promise.resolve(),online:false,attempts:0,closed:false,pending:new Map()};this.entries.set(serverId,entry);
  const signal=(type,payload={})=>{if(entry.closed)return;this.send(type,{serverId,...payload});};
  const flush=()=>{entry.flush=undefined;entry.pendingBytes=0;for(const event of [...entry.pending.values()].sort((a,b)=>a.channelId===b.channelId?(a.revision||0)-(b.revision||0):(a.sequence||0)-(b.sequence||0))){
   signal('membership-server-event',event);
   if(event.type==='chat')signal('membership-chat-changed',{channelId:event.channelId,delivery:event.delivery,pollIds:event.delivery?[...(event.pollIds||[]),...(event.messages||[]).flatMap(m=>m.content.poll?[m.content.poll.id]:[])]:undefined});
   else if(event.type==='resync'&&this.active?.serverId===serverId)signal('membership-chat-changed',{channelId:this.active.channelId});
  }entry.pending.clear();};
  const connect=async initial=>{
   if(entry.closed)return;
   try{
    if(!initial){state=await this.client.state(serverId);if(entry.closed)return;this.snapshot(serverId,state);}
    const connection=this.client.connections.get(serverId);if(!connection)throw Error('Not connected');
    const bridge=new VoiceSignal();entry.bridge=bridge;
    const address=await bridge.open(connection.base.replace(/^https:/,'wss:'),connection.fingerprint,{eventPath:path,eventToken:connection.token,onEventActivity:()=>{entry.lastFrame=Date.now();}});
    if(entry.closed){bridge.close();return;}
    const socket=new WebSocket(address+path);entry.socket=socket;
    socket.addEventListener('open',()=>{if(entry.closed)return;entry.online=true;entry.opened=Date.now();entry.lastFrame=Date.now();entry.sequence=0;entry.decodeEpoch++;signal('membership-live-status',{live:wide});});
    socket.addEventListener('message',message=>{if(entry.closed)return;const bytes=typeof message.data==='string'?Buffer.byteLength(message.data):60001;
     if(bytes>60000||entry.decodeCount>=64||entry.decodeBytes+bytes>262144){signal('membership-server-event',{type:'resync'});socket.close(1013);return;}
     const epoch=entry.decodeEpoch;entry.decodeCount++;entry.decodeBytes+=bytes;
     entry.decoding=entry.decoding.then(async()=>{if(entry.closed||epoch!==entry.decodeEpoch)return;let event;
     try{if(!wide){if(message.data!=='changed')throw Error();signal('membership-chat-changed',{channelId});return;}
      event=JSON.parse(message.data);if(!event||!['resync','state','chat'].includes(event.type))throw Error();
      if(!Number.isSafeInteger(event.sequence)||event.sequence<0)throw Error();entry.sequence=Math.max(entry.sequence||0,event.sequence);
      if(event.type==='chat'&&(!id(event.channelId)||!Number.isSafeInteger(event.revision)||event.revision<0||!Number.isSafeInteger(event.last)||event.last<0||(event.rescan!==undefined&&typeof event.rescan!=='boolean')))throw Error();
     }catch(error){socket.close(1002);return;}
     if(event.pollIds!==undefined&&(!Array.isArray(event.pollIds)||event.pollIds.length>32||event.pollIds.some(p=>!id(p))))throw Error('Invalid poll update');

     if(event.checklists!==undefined){if(!Array.isArray(event.checklists)||event.checklists.length>32)throw Error('Invalid checklist update');for(const item of event.checklists){if(!item||!Number.isSafeInteger(item.messageId)||item.messageId<1||!Number.isSafeInteger(item.revision)||item.revision<0||!item.checked||typeof item.checked!=='object'||Array.isArray(item.checked)||Object.keys(item.checked).length>100||Object.entries(item.checked).some(([key,value])=>!id(key)||typeof value!=='boolean'))throw Error('Invalid checklist update');}}
     if(event.delivery){
      if(!payloads||!Number.isSafeInteger(event.previous)||event.previous<0||event.previous>=event.revision||!Number.isSafeInteger(event.first)||event.first<0||!Array.isArray(event.messages)||event.messages.length>32||!Array.isArray(event.deleted||[])||(event.deleted||[]).length>32)throw Error('Invalid delivery');
      for(const d of event.deleted||[])if(!Number.isSafeInteger(d.id)||d.id<1||! /^[a-f0-9]{64}$/.test(d.authorProfileId)||!['',undefined,'poll-result'].includes(d.systemKind))throw Error('Invalid removal');
      event.messages=await this.client.decodeMessages(serverId,event.channelId,event.messages);
      event.deleted=event.deleted||[];if(entry.closed||epoch!==entry.decodeEpoch)return;
     }
     const key=event.type+(event.channelId||'')+(event.delivery?':'+event.revision:'');const oldSize=entry.pending.get(key)?._bytes||0;entry.pendingBytes=(entry.pendingBytes||0)-oldSize+bytes;event._bytes=bytes;if(entry.pending.size>=64||entry.pendingBytes>262144){entry.pending.clear();entry.pending.set('resync',{type:'resync'});entry.pendingBytes=0;}else{const old=entry.pending.get(key);entry.pending.set(key,{...event,rescan:!!event.rescan||!!old?.rescan});}
     if(!entry.flush)entry.flush=setTimeout(flush,40);
     }).catch(error=>{signal('membership-server-event',{type:'resync'});socket.close(1002);}).finally(()=>{entry.decodeCount--;entry.decodeBytes-=bytes;});
    });
    socket.addEventListener('error',()=>{});
    socket.addEventListener('close',()=>{if(Date.now()-entry.opened>30000)entry.attempts=0;bridge.close();entry.online=false;signal('membership-live-status',{live:false});if(!entry.closed)retry();});
   }catch{entry.bridge?.close();entry.online=false;signal('membership-live-status',{live:false});if(!entry.closed)retry();}
  };
  const retry=()=>{clearTimeout(entry.retry);entry.retry=setTimeout(()=>void connect(false),Math.min(15000,500*2**Math.min(entry.attempts++,5))+Math.random()*250);};
  const watch=()=>{if(entry.closed)return;if(entry.online&&Date.now()-(entry.lastFrame||0)>45000){entry.socket?.close();entry.bridge?.close();}entry.watchdog=setTimeout(watch,5000);};entry.watchdog=setTimeout(watch,5000);
  void connect(true);
 }
 watch(serverId,channelId,subscriptionId){const old=this.active;this.active={serverId,channelId,subscriptionId};if(old&&old.serverId!==serverId&&!this.entries.get(old.serverId)?.wide)this.remove(old.serverId);
  if(this.entries.get(serverId)?.wide)return true;const connection=this.client.connections.get(serverId);if(connection)this.ensure(serverId,{capabilities:connection.config.capabilities},channelId);return true;
 }
 unwatch(subscriptionId){if(this.active?.subscriptionId===subscriptionId){const entry=this.entries.get(this.active.serverId);if(entry&&!entry.wide)this.remove(this.active.serverId);this.active=undefined;}return true;}
 reconcile(records){const ids=new Set(records.map(r=>r.serverId));for(const serverId of this.entries.keys())if(!ids.has(serverId))this.remove(serverId);}
 closeEntry(entry){entry.closed=true;clearTimeout(entry.watchdog);clearTimeout(entry.retry);clearTimeout(entry.flush);entry.socket?.close();entry.bridge?.close();}
 remove(serverId){const entry=this.entries.get(serverId);if(entry)this.closeEntry(entry);this.entries.delete(serverId);}
 stop(){for(const entry of this.entries.values())this.closeEntry(entry);this.entries.clear();this.active=undefined;}
}
module.exports={MembershipLive};
