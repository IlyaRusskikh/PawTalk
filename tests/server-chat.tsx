import {AvatarEditor} from '../src/AvatarEditor';
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ServerChat} from '../src/ServerChat';
import {changeLanguage,t} from '../src/i18n';
import {applyTheme,defaultTheme} from '../src/theme';
import type {Message,ServerState} from '../src/membership';
import '../src/membership.css';import '../src/style.css';import '../src/interface.css';
const test=window as any,sid='1'.repeat(32),cid='2'.repeat(32),other='3'.repeat(32),me='a'.repeat(64),friend='b'.repeat(64);
await changeLanguage(new URLSearchParams(location.search).get('lang')==='en'?'en':'ru');applyTheme(defaultTheme);
localStorage.clear();localStorage.setItem('pawtalk.chat.window','25');
localStorage.setItem('pawtalk.v2.read.'+sid+'.'+cid,new URLSearchParams(location.search).get('unread')==='1'?'100':'180');
let records:Message[]=Array.from({length:180},(_,i)=>({id:i+1,channelId:cid,authorProfileId:i===149?me:friend,requestId:(i+1).toString(16).padStart(32,'0'),sentAt:1700000000000+i*1000,content:{text:'Synthetic message '+(i+1)+': '+'wrapped content '.repeat(14)}}));
records[19].content.text='Original **current**';records[179].content.reply={id:20,author:'Old name',text:'Stale snapshot'};
const state:ServerState={serverId:sid,name:'Synthetic chat server',revision:1,controlRevision:1,self:{profileId:me,effectiveProfileId:me,deviceId:'c'.repeat(64),role:'member',permissions:[]},profiles:[{id:me,nickname:'Me',revision:1},{id:friend,nickname:'Friend',revision:1}],channels:[{id:cid,name:'General',kind:'text',protected:true,position:0,revision:1,messageRevision:1,lastMessageId:180},{id:other,name:'Other',kind:'text',protected:false,position:1,revision:1,messageRevision:1,lastMessageId:0}],members:[],devices:[],voice:[],bindings:[]};
const features=new URLSearchParams(location.search).has('features');
if(features){state.capabilities=['polls-v1'];state.members=[{profileId:me,online:true,role:'member'},{profileId:friend,online:true,role:'member'}];}
const pollStates=new Map<string,any>();
let refresh=()=>{},selected=cid,release:undefined|(()=>void);
test.addImage=()=>{const id=Math.max(...records.map(m=>m.id))+1;records.push({id,channelId:cid,authorProfileId:me,requestId:id.toString(16).padStart(32,'0'),sentAt:Date.now(),content:{text:'Editable photo',image:{id:'9'.repeat(32),mime:'image/png'}}});state.channels[0].lastMessageId=id;state.channels[0].messageRevision++;refresh();return id;};
test.renameFriend=()=>{state.profiles.find(p=>p.id===friend)!.nickname='ИльяТестит';refresh();};
test.sendRequests=[];test.read=[];test.failNext=false;test.hold=false;test.release=()=>release?.();
test.update=(id:number,text:string)=>{const message=records.find(m=>m.id===id)!;message.content.text=text;message.editedAt=Date.now();state.channels[0].messageRevision++;refresh();};
test.reply=(id:number,target:number)=>{records.find(m=>m.id===id)!.content.reply={id:target,author:'Old name',text:'Stale snapshot'};state.channels[0].messageRevision++;refresh();};
test.remove=(id:number)=>{records=records.filter(m=>m.id!==id);state.channels[0].messageRevision++;refresh();};
test.select=(id:string)=>{selected=id==='other'?other:cid;refresh();};test.cid=cid;
test.desktop={membership:async(action:string,input:any={})=>{
 await new Promise(resolve=>setTimeout(resolve,15));
 if(action==='image'){const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#888';ctx.fillRect(0,0,320,180);return{value:canvas.toDataURL('image/png')};}
 if(action==='poll.create'){
  const id=Math.max(...records.map(m=>m.id))+1,poll={id:input.requestId,...input.definition};
  records.push({id,channelId:input.channelId,authorProfileId:me,requestId:input.requestId,sentAt:Date.now(),content:{text:input.question,poll}});
  pollStates.set(poll.id,{id:poll.id,messageId:id,closesAt:Date.now()+poll.duration*1000,closedAt:null,multiple:poll.multiple,anonymous:poll.anonymous,intermediate:poll.intermediate,counts:[0,0],total:0,own:[]});state.channels[0].lastMessageId=id;state.channels[0].messageRevision++;refresh();return{value:{id}};
 }
 if(action==='poll.state'){const value=pollStates.get(input.pollId);return{value:{...structuredClone(value),counts:value.intermediate||value.closedAt?value.counts:[]}};}
 if(action==='poll.vote'){const value=pollStates.get(input.pollId);value.own=input.choices;value.total=input.choices.length?1:0;value.counts=[0,1].map(i=>input.choices.includes(i)?1:0);return{value:true};}
 if(action==='poll.close'){
  const value=pollStates.get(input.pollId);value.closedAt=Date.now();const original=records.find(m=>m.id===value.messageId)!;const id=Math.max(...records.map(m=>m.id))+1;
  original.locked=true;records.push({...original,id,systemKind:'poll-result',locked:true,requestId:'e'.repeat(32),content:{...original.content,pollResult:true}});state.channels[0].lastMessageId=id;state.channels[0].messageRevision++;refresh();return{value:true};
 }
 if(action==='messages'){
  const o=input.options||{},all=records.filter(m=>m.channelId===input.channelId),limit=o.limit||100;let eligible=all.filter(m=>(!o.before||m.id<o.before)&&(!o.after||m.id>o.after));
  if(o.ids)eligible=eligible.filter(m=>o.ids.includes(m.id));
  if(o.around){const at=eligible.findIndex(m=>m.id>=o.around);eligible=eligible.slice(Math.max(0,at-Math.floor(limit/2)));}
  const page=o.ids||o.after||o.around?eligible.slice(0,limit):eligible.slice(-limit);
  return{value:{messages:structuredClone(page),first:all[0]?.id||0,last:all.at(-1)?.id||0,hasOlder:!!page.length&&page[0].id>all[0].id,hasNewer:!!page.length&&page.at(-1)!.id<all.at(-1)!.id,unread:all.filter(m=>m.id>(o.readAfter||0)).length}};
 }
 if(action==='send'){
  test.sendRequests.push(structuredClone(input));
  if(test.hold)await new Promise<void>(resolve=>{release=resolve;});
  if(test.failNext){test.failNext=false;return{error:{code:'CONNECTION_FAILED'}};}
  if(input.original){records.find(m=>m.id===input.original.id)!.content=structuredClone(input.content);test.update(input.original.id,input.content.text);return{value:{ok:true}};}
  const id=Math.max(0,...records.map(m=>m.id))+1;records.push({id,channelId:input.channelId,authorProfileId:me,requestId:input.requestId||'f'.repeat(32),sentAt:Date.now(),content:input.content});state.channels.find(c=>c.id===input.channelId)!.lastMessageId=id;state.channels.find(c=>c.id===input.channelId)!.messageRevision++;refresh();return{value:{id}};
 }
 if(action==='message.delete'){test.remove(input.messageId);return{value:true};}
 if(action==='copy'){test.copied=input.text;return{value:true};}
 return{value:true};
}};
test.showVoters=()=>{const id=Math.max(...records.map(m=>m.id))+1,poll={id:'d'.repeat(32),duration:3600,anonymous:false,intermediate:true,multiple:false,options:['Public answer','Other']};const voters=Array.from({length:24},(_,i)=>(i+1).toString(16).padStart(64,'0'));for(const [i,id] of voters.entries())state.profiles.push({id,nickname:'Voter '+(i+1),revision:1});pollStates.set(poll.id,{id:poll.id,messageId:id,closesAt:Date.now()+3600000,closedAt:null,multiple:false,anonymous:false,intermediate:true,counts:[24,0],total:24,own:[],voters:[voters,[]]});records.push({id,channelId:cid,authorProfileId:friend,requestId:'d'.repeat(32),sentAt:Date.now(),content:{text:'Public poll',poll}});state.channels[0].lastMessageId=id;state.channels[0].messageRevision++;refresh();return id;};
let openAvatar:(file:File)=>void;test.openAvatar=async()=>{const canvas=document.createElement('canvas');canvas.width=400;canvas.height=200;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#649';ctx.fillRect(0,0,400,200);canvas.toBlob(blob=>openAvatar(new File([blob!],'test.png',{type:'image/png'})));};
function App(){const[avatar,setAvatar]=useState<File>();openAvatar=setAvatar;const[,render]=useState(0);refresh=()=>render(n=>n+1);const channel=state.channels.find(c=>c.id===selected)!;return <><ServerChat key={selected} state={{...state}} channel={{...channel}} focused onRead={id=>test.read.push(id)} onError={error=>{test.error=error;}}/>{avatar&&<AvatarEditor file={avatar} onClose={()=>setAvatar(undefined)} onSave={()=>true}/>}</>;}
createRoot(document.getElementById('root')!).render(<App/>);
