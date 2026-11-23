import {AvatarEditor} from '../src/AvatarEditor';
import {useState} from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {ServerChat} from '../src/ServerChat';
import {changeLanguage,t} from '../src/i18n';
import {applyTheme,defaultTheme} from '../src/theme';
import type {Message,ServerState} from '../src/membership';
import '../src/membership.css';import '../src/style.css';import '../src/interface.css';
const test=window as any,sid='1'.repeat(32),cid='2'.repeat(32),other='3'.repeat(32),me='a'.repeat(64),friend='b'.repeat(64);
await changeLanguage(new URLSearchParams(location.search).get('lang')==='en'?'en':'ru');applyTheme(defaultTheme);
localStorage.clear();localStorage.setItem('pawtalk.chat.window','25');
const unreadFixture=new URLSearchParams(location.search).get('unread');
localStorage.setItem('pawtalk.v2.read.'+sid+'.'+cid,unreadFixture==='all'?'0':unreadFixture?'100':'180');
let records:Message[]=Array.from({length:180},(_,i)=>({id:i+1,channelId:cid,authorProfileId:i===149?me:friend,requestId:(i+1).toString(16).padStart(32,'0'),sentAt:1700000000000+i*1000,content:{text:'Synthetic message '+(i+1)+': '+'wrapped content '.repeat(14)}}));
if(new URLSearchParams(location.search).has('fallbackgif'))for(const index of [177,178])records[index].content.text='https://gif.example.test/fails.gif';
const localizedTenor='https://tenor.com/ru/view/deal-with-it-dog-gif-9823664';
if(new URLSearchParams(location.search).has('legacygif')){
 records[177].content.text='https://tenor.com/search/meow-gifs';
 records[178].content.text=localizedTenor;
}
records[19].content.text='Original **current**';records[179].content.reply={id:20,author:'Old name',text:'Stale snapshot'};
if(unreadFixture==='own'){
 records=records.filter(message=>message.id!==100).map(message=>message.id>100&&message.id<=128?{...message,authorProfileId:me}:message);
 localStorage.setItem('pawtalk.v2.position.'+sid+':'+cid,JSON.stringify({id:30,offset:0,follow:false}));
}
const liveListeners=new Set<(event:any)=>void>();test.liveReads=[];
const state:ServerState={serverId:sid,name:'Synthetic chat server',revision:1,controlRevision:1,self:{profileId:me,effectiveProfileId:me,deviceId:'c'.repeat(64),role:'member',permissions:[]},profiles:[{id:me,nickname:'Me',revision:1},{id:friend,nickname:'Friend',revision:1}],channels:[{id:cid,name:'General',kind:'text',protected:true,position:0,revision:1,messageRevision:1,lastMessageId:180},{id:other,name:'Other',kind:'text',protected:false,position:1,revision:1,messageRevision:1,lastMessageId:0}],members:[],devices:[],voice:[],bindings:[]};
const features=new URLSearchParams(location.search).has('features');
if(features){state.capabilities=['polls-v1'];state.members=[{profileId:me,online:true,role:'member'},{profileId:friend,online:true,role:'member'}];}
if(new URLSearchParams(location.search).has('compose'))state.capabilities=['checklists-v1','media-files-v1','media-gallery-v1'];
if(new URLSearchParams(location.search).has('media-variants'))state.capabilities?.push('media-variants-v1');
const checklistStates=new Map<number,Record<string,boolean>>();const checklistVersions=new Map<number,number>();test.checklistReads=0;
 test.enableChecklistWS=()=>{state.eventsLive=true;state.capabilities=[...(state.capabilities||[]),'checklist-events-v1'];refresh();};
 test.pushChecklist=(messageId:number,checked:Record<string,boolean>,revision:number)=>{checklistStates.set(messageId,checked);checklistVersions.set(messageId,revision);for(const fn of liveListeners)fn({serverId:sid,type:'chat',channelId:cid,checklists:[{messageId,revision,checked}]});};
const pollStates=new Map<string,any>();
let refresh=()=>{},selected=cid,release:undefined|(()=>void);
test.addImage=()=>{const id=Math.max(...records.map(m=>m.id))+1;records.push({id,channelId:cid,authorProfileId:me,requestId:id.toString(16).padStart(32,'0'),sentAt:Date.now(),content:{text:'Editable photo',image:{id:'9'.repeat(32),mime:'image/png'}}});state.channels[0].lastMessageId=id;state.channels[0].messageRevision++;refresh();return id;};
test.renameFriend=()=>{state.profiles.find(p=>p.id===friend)!.nickname='ИльяТестит';refresh();};
test.sendRequests=[];test.read=[];test.failNext=false;test.hold=false;test.release=()=>release?.();
test.setBatch=(size:number)=>{localStorage.setItem('pawtalk.chat.window',String(size));refresh();};
test.extendHistory=(last:number)=>{for(let id=records.at(-1)!.id+1;id<=last;id++)records.push({id,channelId:cid,authorProfileId:friend,requestId:id.toString(16).padStart(32,'0'),sentAt:1700000000000+id*1000,content:{text:'Extended history '+id}});state.channels[0].lastMessageId=last;state.channels[0].messageRevision++;refresh();};
const attachmentBytes=new Map<string,{bytes:Uint8Array;mime:string}>();let attachmentSequence=32;
test.attachmentReads = [];
let releaseUpload:undefined|(()=>void);test.releaseUpload=()=>releaseUpload?.();
test.attachImage=()=>{const input=document.querySelector<HTMLInputElement>('.chat-compose input[type=file]')!,data=new DataTransfer(),bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEAAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0));data.items.add(new File([bytes],'pending.png',{type:'image/png'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));};
test.confirmPending=()=>{const input=test.sendRequests.at(-1),channel=state.channels.find(c=>c.id===input.channelId)!,previous=channel.messageRevision,id=Math.max(...records.map(m=>m.id))+1,row:Message={id,channelId:input.channelId,authorProfileId:me,requestId:input.requestId,sentAt:Date.now(),content:structuredClone(input.content)};records.push(row);channel.lastMessageId=id;channel.messageRevision++;state.eventsLive=true;for(const fn of liveListeners)fn({serverId:sid,channelId:input.channelId,type:'chat',delivery:true,previous,revision:channel.messageRevision,first:records[0].id,last:id,messages:[structuredClone(row)],deleted:[]});refresh();return id;};
test.update=(id:number,text:string)=>{const message=records.find(m=>m.id===id)!;message.content.text=text;message.editedAt=Date.now();state.channels[0].messageRevision++;refresh();};
test.reply=(id:number,target:number)=>{records.find(m=>m.id===id)!.content.reply={id:target,author:'Old name',text:'Stale snapshot'};state.channels[0].messageRevision++;refresh();};
test.remove=(id:number)=>{records=records.filter(m=>m.id!==id);state.channels[0].messageRevision++;refresh();};
test.select=(id:string)=>{selected=id==='other'?other:cid;refresh();};test.cid=cid;
test.gifLoads=0;
test.desktop={onMembershipServerEvent:(listener:(event:any)=>void)=>{liveListeners.add(listener);return()=>liveListeners.delete(listener);},membership:async(action:string,input:any={})=>{
 await new Promise(resolve=>setTimeout(resolve,15));
 if(action==='gif.load'){test.gifLoads++;return{value:{mime:'image/gif',base64:'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}};}
 if(action==='gif.resolve')return{value:['https://gif.example.test/no-extension','https://klipy.com/gifs/rat-eat-pog','https://tenor.com/search/meow-gifs',localizedTenor].includes(input.url)?{url:'https://gif.example.test/animated.gif'}:null};
 if(action==='upload.file'){test.mediaBytes=input.bytes;const id=(++attachmentSequence).toString(16).padStart(32,'0');attachmentBytes.set(id,input);return{value:{id,mime:input.mime}};}
 if(action==='file'){test.attachmentReads.push(input.attachmentId);return{value:attachmentBytes.get(input.attachmentId)?.bytes||test.mediaBytes};}
 if(action==='image'&&attachmentBytes.has(input.attachmentId)){const record=attachmentBytes.get(input.attachmentId)!;return{value:'data:'+record.mime+';base64,'+btoa(String.fromCharCode(...record.bytes))};}
 if(action==='image'){const canvas=document.createElement('canvas'),portrait=input.attachmentId==='9'.repeat(32);canvas.width=portrait?800:320;canvas.height=portrait?1200:180;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#888';ctx.fillRect(0,0,canvas.width,canvas.height);return{value:canvas.toDataURL('image/png')};}
 if(action==='memory.status')return{value:{low:!!test.lowMemory}};
 if(action==='upload'){if(test.holdUpload)await new Promise<void>(resolve=>{releaseUpload=resolve;});const id=(++attachmentSequence).toString(16).padStart(32,'0');attachmentBytes.set(id,input);return{value:{id,mime:input.mime}};}
 if(action==='poll.create'){
  const id=Math.max(...records.map(m=>m.id))+1,poll={id:input.requestId,...input.definition};
  records.push({id,channelId:input.channelId,authorProfileId:me,requestId:input.requestId,sentAt:Date.now(),content:{text:input.question,poll}});
  pollStates.set(poll.id,{id:poll.id,messageId:id,closesAt:Date.now()+poll.duration*1000,closedAt:null,multiple:poll.multiple,anonymous:poll.anonymous,intermediate:poll.intermediate,counts:[0,0],total:0,own:[]});state.channels[0].lastMessageId=id;state.channels[0].messageRevision++;refresh();return{value:{id}};
 }
 if(action==='checklist.state'){test.checklistReads++;return{value:{checked:checklistStates.get(input.messageId)||{},revision:checklistVersions.get(input.messageId)||1}};}
 if(action==='checklist.check'){const checked={...(checklistStates.get(input.messageId)||{}),[input.item]:input.checked},revision=(checklistVersions.get(input.messageId)||1)+1;test.pushChecklist(input.messageId,checked,revision);return{value:{checked,revision}};}
 if(action==='poll.state'){test.pollReads=(test.pollReads||0)+1;const value=pollStates.get(input.pollId);return{value:{...structuredClone(value),counts:value.intermediate||value.closedAt?value.counts:[]}};}
 if(action==='poll.vote'){const value=pollStates.get(input.pollId);value.own=input.choices;value.total=input.choices.length?1:0;value.counts=[0,1].map(i=>input.choices.includes(i)?1:0);return{value:true};}
 if(action==='poll.close'){
  const value=pollStates.get(input.pollId);value.closedAt=Date.now();const original=records.find(m=>m.id===value.messageId)!;const id=Math.max(...records.map(m=>m.id))+1;
  original.locked=true;records.push({...original,id,systemKind:'poll-result',locked:true,requestId:'e'.repeat(32),content:{...original.content,pollResult:true}});state.channels[0].lastMessageId=id;state.channels[0].messageRevision++;refresh();return{value:true};
 }
 if(action==='messages'){test.liveReads.push(structuredClone(input.options||{}));
  const o=input.options||{},all=records.filter(m=>m.channelId===input.channelId),limit=o.limit||100;let eligible=all.filter(m=>(!o.before||m.id<o.before)&&(!o.after||m.id>o.after));
  if(test.holdOlderPage&&o.before&&limit>1){test.holdOlderPage=false;await new Promise<void>(resolve=>{test.releaseOlderPage=resolve;});}
  if(o.ids)eligible=eligible.filter(m=>o.ids.includes(m.id));
  if(o.around){const at=eligible.findIndex(m=>m.id>=o.around);eligible=eligible.slice(Math.max(0,at-Math.floor(limit/2)));}
  const page=o.ids||o.after||o.around?eligible.slice(0,limit):eligible.slice(-limit);
  return{value:{messages:structuredClone(page),first:all[0]?.id||0,last:all.at(-1)?.id||0,hasOlder:!!page.length&&page[0].id>all[0].id,hasNewer:!!page.length&&page.at(-1)!.id<all.at(-1)!.id,unread:all.filter(m=>m.id>(o.readAfter||0)&&(m.systemKind||m.authorProfileId!==me)).length}};
 }
 if(action==='send'){
  test.sendRequests.push(structuredClone(input));
  if(test.hold)await new Promise<void>(resolve=>{release=resolve;});
  if(test.failNext){test.failNext=false;return{error:{code:'CONNECTION_FAILED'}};}
  if(input.original){records.find(m=>m.id===input.original.id)!.content=structuredClone(input.content);test.update(input.original.id,input.content.text);return{value:{ok:true}};}
  const repeated=records.find(m=>m.requestId===input.requestId&&m.authorProfileId===me);if(repeated)return{value:{id:repeated.id}};
  const id=Math.max(0,...records.map(m=>m.id))+1;records.push({id,channelId:input.channelId,authorProfileId:me,requestId:input.requestId||'f'.repeat(32),sentAt:Date.now(),content:input.content});state.channels.find(c=>c.id===input.channelId)!.lastMessageId=id;state.channels.find(c=>c.id===input.channelId)!.messageRevision++;refresh();return{value:{id}};
 }
 if(action==='message.delete'){test.remove(input.messageId);return{value:true};}
 if(action==='copy'){test.copied=input.text;return{value:true};}
 return{value:true};
}};
test.enableLive=()=>{state.eventsLive=true;refresh();};
test.showVoters=()=>{const id=Math.max(...records.map(m=>m.id))+1,poll={id:'d'.repeat(32),duration:3600,anonymous:false,intermediate:true,multiple:false,options:['Public answer','Other']};const voters=Array.from({length:24},(_,i)=>(i+1).toString(16).padStart(64,'0'));for(const [i,id] of voters.entries())state.profiles.push({id,nickname:'Voter '+(i+1),revision:1});pollStates.set(poll.id,{id:poll.id,messageId:id,closesAt:Date.now()+3600000,closedAt:null,multiple:false,anonymous:false,intermediate:true,counts:[24,0],total:24,own:[],voters:[voters,[]]});records.push({id,channelId:cid,authorProfileId:friend,requestId:'d'.repeat(32),sentAt:Date.now(),content:{text:'Public poll',poll}});state.channels[0].lastMessageId=id;state.channels[0].messageRevision++;refresh();return id;};
let openAvatar:(file:File)=>void;test.openAvatar=async()=>{const canvas=document.createElement('canvas');canvas.width=400;canvas.height=200;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#649';ctx.fillRect(0,0,400,200);canvas.toBlob(blob=>openAvatar(new File([blob!],'test.png',{type:'image/png'})));};
test.pushLive=(kind:string,id?:number,duplicate=false)=>{
 if(duplicate){for(const fn of liveListeners)fn(test.lastLive);return test.lastLive.messages?.[0]?.id;}
 const channel=state.channels[0],previous=channel.messageRevision;state.eventsLive=true;
 const add=()=>{const next=Math.max(test.liveCounter||0,...records.map(m=>m.id))+1;test.liveCounter=next;const row:Message={id:next,channelId:cid,authorProfileId:friend,requestId:next.toString(16).padStart(32,'0'),sentAt:Date.now(),content:{text:'Pushed '+next}};records.push(row);channel.messageRevision++;return row;};
 let updates:Message[]=[],deleted:any[]=[],delayed:any;
 if(kind==='new'||kind==='state-first')updates=[add()];
 if(kind==='reply'){const row=add();row.content.reply={id:id!,author:'Old name',text:'Stale snapshot'};updates=[row];}
 if(kind==='edit'){const row=records.find(m=>m.id===id)!;row.content={text:'Live edited '+id};row.editedAt=Date.now();updates=[row];channel.messageRevision++;}
 if(kind==='delete'){const row=records.find(m=>m.id===id)!;deleted=[{id:row.id,authorProfileId:row.authorProfileId}];records=records.filter(m=>m.id!==id);channel.messageRevision++;}
 if(kind==='gap'){add();updates=[add()];}
 if(kind==='reorder'){const first=add();delayed={serverId:sid,channelId:cid,type:'chat',delivery:true,previous,revision:channel.messageRevision,first:records[0].id,last:first.id,messages:structuredClone([first]),deleted:[]};updates=[add()];}
 channel.lastMessageId=records.at(-1)?.id||0;
 const event={serverId:sid,channelId:cid,type:'chat',delivery:true,previous:kind==='gap'||kind==='reorder'?previous+1:previous,revision:channel.messageRevision,first:records[0]?.id||0,last:channel.lastMessageId,messages:structuredClone(updates),deleted};test.lastLive=event;
 if(kind==='state-first'){
  state.capabilities=[...(state.capabilities||[]),'message-events-v1'];
  flushSync(refresh);
  queueMicrotask(()=>{for(const fn of liveListeners)fn(event);});
  return updates[0]?.id;
 }
 for(const fn of liveListeners)fn(event);if(delayed)setTimeout(()=>{for(const fn of liveListeners)fn(delayed);},30);refresh();return updates[0]?.id;
};
function App(){const[avatar,setAvatar]=useState<File>();openAvatar=setAvatar;const[,render]=useState(0);refresh=()=>render(n=>n+1);const channel=state.channels.find(c=>c.id===selected)!;return <><ServerChat key={selected} state={{...state}} channel={{...channel}} focused onRead={id=>test.read.push(id)} onError={error=>{test.error=error;}}/>{avatar&&<AvatarEditor file={avatar} onClose={()=>setAvatar(undefined)} onSave={()=>true}/>}</>;}
createRoot(document.getElementById('root')!).render(<App/>);
