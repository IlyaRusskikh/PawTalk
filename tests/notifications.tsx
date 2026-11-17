import { DevicesDialog,LinkDialog } from '../src/MemberDialogs';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ServerApp} from '../src/ServerApp';
import {defaults} from '../src/settings';
import {playSound} from '../src/sounds';
import {changeLanguage} from '../src/i18n';
import {applyTheme,defaultTheme} from '../src/theme';
import '../src/style.css';
import '../src/interface.css';
applyTheme(defaultTheme);
await changeLanguage(new URLSearchParams(location.search).get('language')==='en'?'en':'ru');
localStorage.setItem('pawtalk.onboarding',new URLSearchParams(location.search).has('wizard')?'pending':'done');localStorage.setItem('pawtalk.nickname','Me');
localStorage.setItem('pawtalk.settings',JSON.stringify({...defaults,sounds:true}));
const test=window as any,sid='1'.repeat(32),cid='2'.repeat(32),me='a'.repeat(64),friend='b'.repeat(64);
localStorage.removeItem('pawtalk.v2.read.'+sid+'.'+cid);localStorage.removeItem('pawtalk.v2.mute.'+sid);
const channel={id:cid,kind:'text',name:'General',protected:true,revision:1,messageRevision:1,lastMessageId:120};
const state={serverId:sid,name:'Synthetic notification server',revision:1,controlRevision:1,self:{profileId:me,effectiveProfileId:me,deviceId:'c'.repeat(64),role:'member',permissions:[]},profiles:[{id:me,nickname:'Me',revision:1},{id:friend,nickname:'Friend',revision:1}],channels:[channel],members:[{profileId:me,online:true,role:'member'},{profileId:friend,online:true,role:'member'}],devices:[],voice:[],bindings:[]};
const records:any[]=[];for(let id=1;id<=120;id++)records.push({id,channelId:cid,authorProfileId:friend,requestId:id.toString(16).padStart(32,'0'),sentAt:Date.now()-100000,content:{text:'History '+id+': '+'text '.repeat(20)}});
const serverRecords=[{serverId:sid,name:state.name,address:'https://127.0.0.1:18443',status:'online'}];
let online=true;const listeners=new Set<()=>void>();let activeListener=(_active:boolean)=>{};
const refresh=()=>listeners.forEach(listener=>listener());
const noop=()=>()=>{};
test.desktopNotifications=[];test.messageReads=[];
test.desktop={
 membership:async(action:string,input:any={})=>{
  if(action==='copy'){test.copied=input.text;return{value:true};}
  if(action==='control.create')return{value:'synthetic-control-offer'};
  if(action==='control.accept')return{value:'synthetic-control-response'};
  if(action==='control.finish'){test.finishCalls=(test.finishCalls||0)+1;state.devices.forEach((device:any)=>{device.primary=device.id!=='c'.repeat(64);});test.renderDevices();await new Promise(resolve=>setTimeout(resolve,80));return{value:state};}
  if(action==='activity')return{value:{away:!!test.idle}};
  if(action==='link.pending')return{value:test.incomingLink?[{linkId:'link-fixture',serverId:sid}]:[]};
  if(action==='link.cancel'){test.linkCancelled=true;test.incomingLink=false;return{value:true};}
  if(action==='link.start')return{value:{id:'link-fixture',text:'synthetic-link'}};
  if(action==='link.status')return{value:{id:'link-fixture',state:'proposed',code:'1234567890',sourceProfileId:'e'.repeat(64),targetProfileId:me,chosenProfileId:me,sourceNickname:'Fresh profile',targetNickname:'Me',expiresAt:Date.now()+600000}};
  if(action==='servers')return{value:serverRecords.map(record=>({...record,status:online?'online':'offline'}))};
  if(action==='identity')return{value:{profileId:me,deviceId:'c'.repeat(64)}};
  if(!online)return{error:{code:'CONNECTION_FAILED'}};
  if(action==='connect')return{value:test.reorderMode?{...structuredClone(state),serverId:input.serverId}:structuredClone(state)};
  if(action==='channel.order'){
   test.reorders.push(structuredClone(input));
   const items=input.items.map((item:any)=>state.channels.find(channel=>channel.id===item.id)!);
   state.channels=[...state.channels.filter(channel=>channel.kind!==input.kind),...items];refresh();return{value:true};
  }
  if(action==='notify'){test.desktopNotifications.push(input);return{value:true};}
  if(action==='messages'){
   const options=input.options||{},limit=options.limit||100;test.messageReads.push(structuredClone(options));
   if(test.messageDelay&&options.limit!==1)await new Promise(resolve=>setTimeout(resolve,test.messageDelay));
   let eligible=records.filter(record=>(!options.before||record.id<options.before)&&(!options.after||record.id>options.after));
   if(options.ids)eligible=eligible.filter(record=>options.ids.includes(record.id));
   if(options.around){const at=eligible.findIndex(record=>record.id>=options.around);eligible=eligible.slice(Math.max(0,at-Math.floor(limit/2)));}
   const page=options.ids||options.after||options.around?eligible.slice(0,limit):eligible.slice(-limit);
   return{value:{messages:structuredClone(page),first:records[0]?.id||0,last:records.at(-1)?.id||0,hasOlder:page[0]?.id>records[0]?.id,hasNewer:page.at(-1)?.id<records.at(-1)?.id,unread:records.filter(record=>record.id>(options.readAfter||0)&&record.authorProfileId!==me).length}};
  }
  return{value:true};
 },
 onMembershipChanged:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},onMembershipVoiceLost:noop,onMembershipOpenChannel:noop,
 windowActive:async()=>true,onWindowActive:(listener:typeof activeListener)=>{activeListener=listener;return()=>{activeListener=()=>{};};},
 pendingInvitation:async()=>'',onInvitation:noop,hostStatus:async()=>({running:false}),onHostChanged:noop,
 capabilities:async()=>({native:false,platform:'win32',packaged:false,secureStorage:true}),configureKeys:async()=>({native:false,failed:[]}),onPtt:noop,onAction:noop,onSuspend:noop,duck:async()=>{},updateState:async()=>({status:'idle'}),onUpdate:noop,
};
test.setWindowActive=(active:boolean)=>activeListener(active);
test.addMessages=async(count=1,own=false)=>{for(let i=0;i<count;i++){const id=(records.at(-1)?.id||0)+1;records.push({id,channelId:cid,authorProfileId:own?me:friend,requestId:id.toString(16).padStart(32,'0'),sentAt:Date.now(),content:{text:'New message '+id}});}channel.lastMessageId=records.at(-1).id;channel.messageRevision++;state.revision++;refresh();};
test.refresh=refresh;
test.addMention=()=>{const id=(records.at(-1)?.id||0)+1;records.push({id,channelId:cid,authorProfileId:friend,requestId:id.toString(16).padStart(32,'0'),sentAt:Date.now(),content:{text:'Hello @Me',mentions:[{profileId:me,start:6,end:9}]}});channel.lastMessageId=id;channel.messageRevision++;refresh();};

test.setupReorder=()=>{
 test.reorderMode=true;state.self.role='admin';
 state.channels.push(...(['voice','text'] as const).flatMap(kind=>Array.from({length:3},(_,i)=>({id:kind+i,kind,name:kind+' '+i,protected:false,revision:1,messageRevision:1,lastMessageId:0}))));
 serverRecords.push(...Array.from({length:2},(_,i)=>({serverId:String(i+4).repeat(32),name:'Synthetic server '+i,address:'https://127.0.0.1:18443',status:'online'})));
 refresh();
};
test.reorders=[];
test.addServer=()=>{serverRecords.push({serverId:'3'.repeat(32),name:'Synthetic second server',address:'https://127.0.0.1:18443',status:'online'});refresh();};
test.setConnected=(value:boolean)=>{online=value;refresh();};
test.setChatVisible=(visible:boolean)=>{(document.querySelector(visible?'.member-server-list button':'.member-home') as HTMLButtonElement)?.click();};
test.setCovered=(covered:boolean)=>{(document.querySelector(covered?'.member-rail-settings':'dialog .modal-heading button') as HTMLButtonElement)?.click();};
test.muteServer=(muted:boolean)=>{if(muted)localStorage.setItem('pawtalk.v2.mute.'+sid,String(Date.now()+60000));else localStorage.removeItem('pawtalk.v2.mute.'+sid);};
test.audioPlays = [];
const audioNodes: {source:AudioBufferSourceNode;gain?:GainNode;ended:boolean}[] = [];
test.soundState = (index:number) => ({ended:audioNodes[index].ended,gain:audioNodes[index].gain?.gain.value});
const soundGains = new WeakMap<AudioNode, GainNode>();
const connect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (...args: any[]) {
  if (this instanceof AudioBufferSourceNode && args[0] instanceof GainNode) soundGains.set(this, args[0]);
  return (connect as any).apply(this, args);
} as typeof connect;
const start = AudioBufferSourceNode.prototype.start;
AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
  const node={source:this,gain:soundGains.get(this),ended:false};
  audioNodes.push(node);
  this.addEventListener('ended',()=>{node.ended=true;});
  test.audioPlays.push({ offset:args[1]??0, seconds: this.buffer?.duration, channels: this.buffer?.numberOfChannels, sink: (this.context as AudioContext & { sinkId: string }).sinkId, gain: soundGains.get(this)?.gain.value });
  return start.apply(this, args);
};
test.playSound = (event: 'join' | 'leave' | 'message', overrides = {}) => playSound(event, { ...defaults, ...overrides });

Object.defineProperty(test,'notifications',{get:()=>test.audioPlays.length});
const root=createRoot(document.getElementById('root')!);root.render(<ServerApp/>);test.ready=true;
test.populatePeople=()=>{state.voice=Array.from({length:12},(_,i)=>({profileId:friend,deviceId:String(i).padStart(64,'0'),channelId:'voice0',identity:String(i).padStart(32,'0')})) as any;refresh();};
test.emitDeparture=(kind:string,expiresAt?:number|null)=>listeners.forEach(listener=>(listener as any)({departure:{serverId:sid,name:'Synthetic notice server',kind,expiresAt}}));
test.setRole=(role:string)=>{state.self.role=role;refresh();};
test.renderDevices=()=>root.render(<DevicesDialog state={{...state}} onClose={()=>{}} onRefresh={()=>{test.renderDevices();}}/>);
test.openDevices=(primary:boolean)=>{state.devices=[{id:'c'.repeat(64),label:'This PC',primary,originalProfileId:me},{id:'d'.repeat(64),label:'Other PC',primary:!primary,originalProfileId:friend}] as any;test.renderDevices();};
test.openLink=()=>{state.devices=[{id:'c'.repeat(64),label:'This PC',primary:true,originalProfileId:me}] as any;root.render(<LinkDialog state={{...state}} nickname="Me" onClose={()=>{}} onJoined={()=>{}}/>);};
