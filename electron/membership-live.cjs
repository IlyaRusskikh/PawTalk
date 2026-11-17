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
  const path=wide?'/api/v2/events':'/api/v2/channels/'+channelId+'/events',previous=this.entries.get(serverId);
  if(previous?.path===path)return;
  if(previous)this.closeEntry(previous);
  const entry={serverId,path,wide,channelId,online:false,attempts:0,closed:false,pending:new Map()};this.entries.set(serverId,entry);
  const signal=(type,payload={})=>{if(entry.closed)return;this.send(type,{serverId,...payload});};
  const flush=()=>{entry.flush=undefined;for(const event of entry.pending.values()){
   signal('membership-server-event',event);
   if(event.type==='chat')signal('membership-chat-changed',{channelId:event.channelId});
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
    socket.addEventListener('open',()=>{if(entry.closed)return;entry.online=true;entry.opened=Date.now();entry.lastFrame=Date.now();entry.sequence=0;signal('membership-live-status',{live:wide});});
    socket.addEventListener('message',message=>{if(entry.closed)return;let event;
     try{if(!wide){if(message.data!=='changed')throw Error();signal('membership-chat-changed',{channelId});return;}
      event=JSON.parse(message.data);if(!event||!['resync','state','chat'].includes(event.type))throw Error();
      if(!Number.isSafeInteger(event.sequence)||event.sequence<0)throw Error();entry.sequence=Math.max(entry.sequence||0,event.sequence);
      if(event.type==='chat'&&(!id(event.channelId)||!Number.isSafeInteger(event.revision)||event.revision<0||!Number.isSafeInteger(event.last)||event.last<0||(event.rescan!==undefined&&typeof event.rescan!=='boolean')))throw Error();
     }catch{socket.close(1002);return;}
     const key=event.type+(event.channelId||'');if(entry.pending.size>=64){entry.pending.clear();entry.pending.set('resync',{type:'resync'});}else{const old=entry.pending.get(key);entry.pending.set(key,{...event,rescan:!!event.rescan||!!old?.rescan});}
     if(!entry.flush)entry.flush=setTimeout(flush,40);
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
