import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ServerChat} from '../src/ServerChat';
import {changeLanguage,t} from '../src/i18n';
import {applyTheme,defaultTheme} from '../src/theme';
import type {Message,ServerState} from '../src/membership';
import '../src/style.css';import '../src/interface.css';import '../src/membership.css';
const test=window as any,sid='1'.repeat(32),cid='2'.repeat(32),other='3'.repeat(32),me='a'.repeat(64),friend='b'.repeat(64);
await changeLanguage(new URLSearchParams(location.search).get('lang')==='en'?'en':'ru');applyTheme(defaultTheme);
localStorage.clear();localStorage.setItem('pawtalk.chat.window','25');
localStorage.setItem('pawtalk.v2.read.'+sid+'.'+cid,new URLSearchParams(location.search).get('unread')==='1'?'100':'180');
let records:Message[]=Array.from({length:180},(_,i)=>({id:i+1,channelId:cid,authorProfileId:i===149?me:friend,requestId:(i+1).toString(16).padStart(32,'0'),sentAt:1700000000000+i*1000,content:{text:'Synthetic message '+(i+1)+': '+'wrapped content '.repeat(14)}}));
records[19].content.text='Original **current**';records[179].content.reply={id:20,author:'Old name',text:'Stale snapshot'};
const state:ServerState={serverId:sid,name:'Synthetic chat server',revision:1,controlRevision:1,self:{profileId:me,effectiveProfileId:me,deviceId:'c'.repeat(64),role:'member',permissions:[]},profiles:[{id:me,nickname:'Me',revision:1},{id:friend,nickname:'Friend',revision:1}],channels:[{id:cid,name:'General',kind:'text',protected:true,position:0,revision:1,messageRevision:1,lastMessageId:180},{id:other,name:'Other',kind:'text',protected:false,position:1,revision:1,messageRevision:1,lastMessageId:0}],members:[],devices:[],voice:[],bindings:[]};
let refresh=()=>{},selected=cid,release:undefined|(()=>void);
test.sendRequests=[];test.read=[];test.failNext=false;test.hold=false;test.release=()=>release?.();
test.update=(id:number,text:string)=>{const message=records.find(m=>m.id===id)!;message.content.text=text;message.editedAt=Date.now();state.channels[0].messageRevision++;refresh();};
test.reply=(id:number,target:number)=>{records.find(m=>m.id===id)!.content.reply={id:target,author:'Old name',text:'Stale snapshot'};state.channels[0].messageRevision++;refresh();};
test.remove=(id:number)=>{records=records.filter(m=>m.id!==id);state.channels[0].messageRevision++;refresh();};
test.select=(id:string)=>{selected=id==='other'?other:cid;refresh();};test.cid=cid;
test.desktop={membership:async(action:string,input:any={})=>{
 await new Promise(resolve=>setTimeout(resolve,15));
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
  if(input.original){test.update(input.original.id,input.content.text);return{value:{ok:true}};}
  const id=Math.max(0,...records.map(m=>m.id))+1;records.push({id,channelId:input.channelId,authorProfileId:me,requestId:input.requestId||'f'.repeat(32),sentAt:Date.now(),content:input.content});state.channels.find(c=>c.id===input.channelId)!.lastMessageId=id;state.channels.find(c=>c.id===input.channelId)!.messageRevision++;refresh();return{value:{id}};
 }
 if(action==='message.delete'){test.remove(input.messageId);return{value:true};}
 if(action==='copy'){test.copied=input.text;return{value:true};}
 return{value:true};
}};
function App(){const[,render]=useState(0);refresh=()=>render(n=>n+1);const channel=state.channels.find(c=>c.id===selected)!;return <ServerChat key={selected} state={{...state}} channel={{...channel}} focused onRead={id=>test.read.push(id)} onError={error=>{test.error=error;}}/>;}
createRoot(document.getElementById('root')!).render(<App/>);
