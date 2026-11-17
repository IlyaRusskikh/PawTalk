const {VoiceSignal}=require('./voice-signal.cjs');
// One active chat subscription. TLS pinning happens in the existing main-process
// signaling bridge before it forwards the bearer header. Renderer sees neither.
class MembershipLive {
 constructor(client,send){this.client=client;this.send=send;this.epoch=0;}
 watch(serverId,channelId,id){this.stop();const epoch=this.epoch;this.id=id;this.active={serverId,channelId};let attempts=0;
  const connect=async()=>{
   if(epoch!==this.epoch)return;
   try{
    const state=await this.client.state(serverId);if(epoch!==this.epoch)return;
    if(!state.capabilities?.includes('chat-events-v1'))return;
    const connection=this.client.connections.get(serverId);if(!connection)throw Error('Not connected');
    const path='/api/v2/channels/'+channelId+'/events',bridge=new VoiceSignal();this.bridge=bridge;
    const address=await bridge.open(connection.base.replace(/^https:/,'wss:'),connection.fingerprint,{eventPath:path,eventToken:connection.token});
    if(epoch!==this.epoch){bridge.close();return}
    const socket=new WebSocket(address+path);this.socket=socket;
    const changed=()=>{if(epoch===this.epoch&&!this.changedTimer)this.changedTimer=setTimeout(()=>{this.changedTimer=undefined;if(epoch===this.epoch)this.send('membership-chat-changed',{serverId,channelId});},40);};
    socket.addEventListener('open',()=>{attempts=0;changed();});
    socket.addEventListener('message',event=>{if(event.data==='changed')changed();else socket.close(1002);});
    socket.addEventListener('error',()=>{});
    socket.addEventListener('close',()=>{bridge.close();if(epoch===this.epoch)retry();});
   }catch{if(epoch===this.epoch){this.bridge?.close();retry();}}
  };
  const retry=()=>{clearTimeout(this.timer);this.timer=setTimeout(connect,Math.min(15000,500*2**Math.min(attempts++,5))+Math.random()*250);};
  void connect();return true;
 }
 unwatch(id){if(id===this.id)this.stop();return true;}
 stop(){this.epoch++;clearTimeout(this.timer);clearTimeout(this.changedTimer);this.changedTimer=undefined;this.socket?.close();this.socket=undefined;this.bridge?.close();this.bridge=undefined;this.id=undefined;this.active=undefined;}
}
module.exports={MembershipLive};
