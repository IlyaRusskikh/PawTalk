import {dropMemberMention,memberDragType} from './memberMention';
import {PollCard} from './PollCard';
import {PollDialog} from './PollDialog';
import {MentionTextarea} from './MentionTextarea';
import type {Mention} from '../shared/mentions.mjs';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from './Avatar';
import { Icon } from './Controls';
import { MessageText } from './MessageText';
import { Modal } from './Modal';
import { ChatImage } from './ChatImage';
import { MessageTime } from './MessageTime';
import { loadChatWindow } from './ChatSettings';
import { t } from './i18n';
import { cursorKey, effectiveProfile, membership, profileFor, type Channel, type Message, type MessagePage, type ServerState } from './membership';

type Anchor = { id: number; offset: number };
type Position = Anchor & { follow: boolean };
type LoadKind = 'initial' | 'sync' | 'older' | 'newer' | 'latest' | 'around';
type Draft = { text: string; mentions?:Mention[]; file?: File; reply?: Message };
type Outgoing = {message:Message;preview?:string;confirmed:boolean};
const drafts = new Map<string,Draft>();
const merge = (a:Message[],b:Message[]) => [...new Map([...a,...b].map(message=>[message.id,message])).values()].sort((a,b)=>a.id-b.id);
function readPosition(key:string):Position|undefined { try {const p=JSON.parse(localStorage.getItem(key)||'null');return p&&Number.isSafeInteger(p.id)&&p.id>0&&Number.isFinite(p.offset)&&typeof p.follow==='boolean'?p:undefined;}catch{return undefined;} }
function EncryptedImage({ serverId, channelId, image, onRemove, removing }: { serverId: string; channelId: string; image: { id: string; mime: string }; onRemove?():void; removing?:boolean }) {
  const load = useCallback(async () => {
    const value = await membership<string>('image', { serverId, channelId, attachmentId: image.id, mime: image.mime });
    const raw = atob(value.slice(value.indexOf(',') + 1));
    return new Blob([Uint8Array.from(raw, character => character.charCodeAt(0))], { type: image.mime });
  }, [serverId, channelId, image.id, image.mime]);
  return <ChatImage image={{ ...image, mime: image.mime as 'image/png'|'image/jpeg'|'image/webp', name: 'image.' + image.mime.split('/')[1], size: 0, width: 320, height: 200 }} load={load} onRemove={onRemove} removing={removing}/>;
}

export function ServerChat({ state, channel, focused, onRead, onError, onViewport }: { state: ServerState; channel: Channel; focused: boolean; onRead(last: number): void; onError(error: string): void; onViewport?(latest:boolean):void }) {
  const serverId=state.serverId,channelId=channel.id,key=`${serverId}:${channelId}`,positionKey=`pawtalk.v2.position.${key}`,limit=loadChatWindow();
  const [messages,setMessages]=useState<Message[]>([]),rows=useRef<Message[]>([]),predecessor=useRef<Message|undefined>(undefined);
  const [text,setText]=useState(()=>drafts.get(key)?.text||''),[file,setFile]=useState<File|undefined>(()=>drafts.get(key)?.file),[reply,setReply]=useState<Message|undefined>(()=>drafts.get(key)?.reply);
  const [creatingPoll,setCreatingPoll]=useState(false);
  const [mentions,setMentions]=useState<Mention[]>(()=>drafts.get(key)?.mentions||[]),[editMentions,setEditMentions]=useState<Mention[]>([]);
  const [editing,setEditing]=useState<Message>(),[editText,setEditText]=useState(''),[removeImage,setRemoveImage]=useState(false),[deleting,setDeleting]=useState<Message>();
  const [sending,setSending]=useState(false),[mutating,setMutating]=useState(false),[loading,setLoading]=useState(true),[ready,setReady]=useState(false);
  const [outgoing,setOutgoing]=useState<Outgoing>(),outgoingRef=useRef<Outgoing|undefined>(undefined);
  function showOutgoing(value:Outgoing){outgoingRef.current=value;setOutgoing(value);}
  useEffect(()=>()=>{if(outgoing?.preview)URL.revokeObjectURL(outgoing.preview);},[outgoing?.preview]);
  const [failure,setFailure]=useState(''),[sendError,setSendError]=useState(''),[mutationError,setMutationError]=useState(''),[notice,setNotice]=useState('');
  const [newCount,setNewCount]=useState(0),[bounds,setBounds]=useState({first:0,last:0}),boundsRef=useRef(bounds);boundsRef.current=bounds;
  const [away,setAway]=useState(false),[quotes,setQuotes]=useState(new Map<number,Message|null>()),[preview,setPreview]=useState('');
  const [menu,setMenu]=useState<{message:Message;x:number;y:number}>(),menuRef=useRef<HTMLDivElement>(null),[attachmentMenu,setAttachmentMenu]=useState(false);
  const pane=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null),composer=useRef<HTMLTextAreaElement>(null),editInput=useRef<HTMLTextAreaElement>(null),picker=useRef<HTMLInputElement>(null);
  const savedPosition=useRef(readPosition(positionKey)),follow=useRef(savedPosition.current?.follow!==false),epoch=useRef(0),queue=useRef(Promise.resolve()),navigation=useRef(false),sendingRef=useRef(false),mutationRef=useRef(false);
  const pendingPosition=useRef<{bottom?:boolean;anchor?:Anchor;target?:number;unread?:boolean}|undefined>(undefined),lastAnchor=useRef<Anchor|undefined>(undefined),resizeAnchor=useRef<{id:number;offset:number;width:number;height:number}|undefined>(undefined),lastScroll=useRef(0);
  const current=useRef({state,channel,focused,onRead,onViewport,reply});current.current={state,channel,focused,onRead,onViewport,reply};
  const read=useRef(Number(localStorage.getItem(cursorKey(serverId,channelId)))||0),entryRead=useRef(read.current),[hasSent,setHasSent]=useState(false);
  const sendTimes=useRef<number[]>([]);
  const uploaded=useRef<{file:File;image:{id:string;mime:string}}|undefined>(undefined),pendingSend=useRef<{signature:string;id:string}|undefined>(undefined),arrival=useRef<{x:number;y:number}|undefined>(undefined),highlightTimer=useRef<ReturnType<typeof setTimeout>>(undefined);
  const deletedMessages=useRef(new Set<number>()),fullSync=useRef(false),eventRevision=useRef(0),eventLast=useRef(0),loadedRevision=useRef(-1),quotesRef=useRef(new Map<number,Message|null>());
  const knownLast=Math.max(bounds.last,channel.lastMessageId),reportedLast=deletedMessages.current.has(knownLast)?messages.at(-1)?.id||0:knownLast;
  const hasOlder=!!messages.length&&messages[0].id>bounds.first,hasNewer=!!messages.length&&messages.at(-1)!.id<reportedLast;
  function confirmOutgoing(updates:Message[]){const pending=outgoingRef.current;if(!pending)return;const state=current.current.state,confirmed=updates.find(m=>m.requestId===pending.message.requestId&&effectiveProfile(state,m.authorProfileId)===state.self.effectiveProfileId);if(confirmed)showOutgoing({...pending,message:confirmed,confirmed:true});}
  function focusInput(){if(current.current.focused&&!creatingPoll&&!document.querySelector('dialog[open]'))composer.current?.focus({preventScroll:true});}
  function anchor():Anchor|undefined {
    const list=pane.current;if(!list)return;
    const box=list.getBoundingClientRect(),visible=[...list.querySelectorAll<HTMLElement>('[data-message-row]')].filter(row=>{const r=row.getBoundingClientRect();return r.bottom>box.top&&r.top<box.bottom;});
    const row=visible.find(row=>row.getBoundingClientRect().top>=box.top)||visible[0];
    if(row){const target=row.querySelector<HTMLElement>('.member-message-text')||row;return {id:Number(row.dataset.messageRow),offset:box.top-target.getBoundingClientRect().top};}
  }
  function remember(){
    const list=pane.current;if(!list)return;
    list.toggleAttribute('data-more-above',list.scrollTop>1);list.toggleAttribute('data-more-below',list.scrollHeight-list.clientHeight-list.scrollTop>1);
    if(resizeAnchor.current&&(resizeAnchor.current.width!==list.clientWidth||resizeAnchor.current.height!==list.clientHeight))return;
    lastAnchor.current=anchor();
    const box=list.getBoundingClientRect(),last=[...list.querySelectorAll<HTMLElement>('[data-message-row]')].reverse().find(row=>{const r=row.getBoundingClientRect();return r.top<box.bottom&&r.bottom>box.top;});
    if(last)resizeAnchor.current={id:Number(last.dataset.messageRow),offset:last.getBoundingClientRect().bottom-box.bottom,width:list.clientWidth,height:list.clientHeight};
    if(lastAnchor.current)localStorage.setItem(positionKey,JSON.stringify({...lastAnchor.current,follow:follow.current}));
  }
  function restoreAnchor(value?:Anchor){const list=pane.current,row=value&&list?.querySelector<HTMLElement>(`[data-message-row="${value.id}"]`);if(list&&row){const target=row.querySelector<HTMLElement>('.member-message-text')||row;list.scrollTop+=target.getBoundingClientRect().top-list.getBoundingClientRect().top+value!.offset;}}
  function markRead(last:number){if(last>=Math.max(boundsRef.current.last,current.current.channel.lastMessageId))setNewCount(0);if(last<=read.current)return;read.current=last;localStorage.setItem(cursorKey(serverId,channelId),String(last));current.current.onRead(last);}
  async function refreshQuotes(next:Message[],generation:number,incremental=false){
    const live=new Map(next.map(m=>[m.id,m])),ids=[...new Set([...next.map(m=>m.content.reply?.id),current.current.reply?.id].filter((id):id is number=>!!id))].filter(id=>!live.has(id));
    const resolved=new Map<number,Message|null>();
    if(incremental)for(const id of ids)if(quotesRef.current.has(id))resolved.set(id,quotesRef.current.get(id)!);
    const missing=ids.filter(id=>!resolved.has(id));
    for(let i=0;i<missing.length;i+=500){const requested=missing.slice(i,i+500),page=await membership<MessagePage>('messages',{serverId,channelId,options:{ids:requested,limit:requested.length}});for(const id of requested)resolved.set(id,page.messages.find(m=>m.id===id)||null);}
    if(generation===epoch.current){quotesRef.current=resolved;setQuotes(resolved);}
  }
  const deliveryWaiters=useRef(new Map<number,ReturnType<typeof setTimeout>>());
  function deliver(event:import('./membership').ServerEvent,retry=false){
    const generation=epoch.current;
    const job=queue.current.catch(()=>{}).then(async()=>{
      if(generation!==epoch.current||!event.delivery||event.revision! <=loadedRevision.current)return;
      if(loadedRevision.current!==event.previous){if(!retry&&deliveryWaiters.current.size<64){if(!deliveryWaiters.current.has(event.revision!))deliveryWaiters.current.set(event.revision!,setTimeout(()=>{deliveryWaiters.current.delete(event.revision!);if(generation===epoch.current)deliver(event,true);},200));return;}fullSync.current=true;queueMicrotask(()=>void load('sync'));return;}
      const old=rows.current,saved=anchor(),deleted=new Set((event.deleted||[]).map(d=>d.id)),updates=event.messages||[],state=current.current.state,previousLast=boundsRef.current.last;
      confirmOutgoing(updates);
      const incoming=(m:{authorProfileId:string;systemKind?:string})=>!!m.systemKind||effectiveProfile(state,m.authorProfileId)!==state.self.effectiveProfileId;
      const countChange=updates.filter(m=>m.id>previousLast&&m.id>read.current&&incoming(m)).length-(event.deleted||[]).filter(d=>d.id>read.current&&incoming(d)).length;
      setNewCount(count=>Math.max(0,count+countChange));
      const visible=new Set(old.map(m=>m.id));let next=merge(old.filter(m=>!deleted.has(m.id)),updates.filter(m=>visible.has(m.id)||follow.current&&m.id>(old.at(-1)?.id||0))).slice(-limit);
      for(const id of deleted)deletedMessages.current.add(id);
      const known=new Map(quotesRef.current),available=new Map([...old,...updates].map(m=>[m.id,m]));for(const m of updates)if(known.has(m.id))known.set(m.id,m);for(const m of next){const id=m.content.reply?.id;if(id&&available.has(id))known.set(id,available.get(id)!);}for(const id of deleted)if(known.has(id))known.set(id,null);quotesRef.current=known;setQuotes(known);
      if(next.length){const at=old.findIndex(m=>m.id===next[0].id);if(at>0)predecessor.current=old[at-1];if(predecessor.current&&deleted.has(predecessor.current.id))predecessor.current=undefined;}
      pendingPosition.current=follow.current?{bottom:true}:{anchor:saved};rows.current=next;setMessages(next);boundsRef.current={first:event.first!,last:event.last!};setBounds(boundsRef.current);loadedRevision.current=event.revision!;setAway(!follow.current);setFailure('');
      try{await refreshQuotes(next,generation,true);}catch(error){if(generation===epoch.current)setFailure((error as Error).message);}
    });queue.current=job;
  }
  function load(kind:LoadKind='sync',target?:number):Promise<void>{
    const generation=epoch.current;
    const job=queue.current.catch(()=>{}).then(async()=>{
      if(generation!==epoch.current)return;
      if(kind==='sync'&&current.current.state.eventsLive&&deliveryWaiters.current.size&&!fullSync.current)return;
      const revision=Math.max(current.current.channel.messageRevision,eventRevision.current),force=fullSync.current||!current.current.state.eventsLive;
      if(kind==='sync'&&!force&&loadedRevision.current>=revision)return;
      if(kind==='sync')fullSync.current=false;
      setLoading(true);
      const existing=rows.current,oldPredecessor=predecessor.current,oldAnchor=anchor(),saved=kind==='initial'?savedPosition.current:undefined;
      const incremental=kind==='sync'&&!force&&existing.length>0,append=incremental&&follow.current,countsOnly=incremental&&!follow.current;
      if(append&&Math.max(current.current.channel.lastMessageId,eventLast.current)<=existing.at(-1)!.id){loadedRevision.current=revision;setLoading(false);return;}
      let options:Record<string,unknown>={limit,readAfter:read.current};
      if(append)options={...options,after:existing.at(-1)!.id};
      else if(countsOnly)options={...options,limit:1};
      else if(kind==='older')options={...options,limit:Math.min(50,Math.floor(limit/2)),before:existing[0]?.id};
      else if(kind==='newer')options={...options,limit:Math.min(50,Math.floor(limit/2)),after:existing.at(-1)?.id};
      else if(kind==='around'||(kind==='initial'&&saved&&!saved.follow))options={...options,around:target||saved?.id};
      else if(kind==='sync'&&!follow.current&&existing.length)options={...options,ids:existing.map(m=>m.id)};
      try{
        let unreadTarget:number|undefined;
        if(kind==='initial'&&channel.lastMessageId>entryRead.current){
          const first=await membership<MessagePage>('messages',{serverId,channelId,options:{...(entryRead.current?{after:entryRead.current}:{around:1}),readAfter:entryRead.current,limit:1}});
          if(generation!==epoch.current)return;
          if(first.unread&&first.messages.length){unreadTarget=first.messages[0].id;options={limit,readAfter:read.current,around:unreadTarget};}
        }
        let page=await membership<MessagePage>('messages',{serverId,channelId,options});if(generation!==epoch.current)return;
        let next=page.messages;
        if(append){if(page.hasNewer){const latest=await membership<MessagePage>('messages',{serverId,channelId,options:{limit,readAfter:read.current}});if(generation!==epoch.current)return;page=latest;next=latest.messages;}else next=merge(existing,page.messages).slice(-limit);}
        else if(countsOnly)next=existing;
        if(kind==='older')next=merge(page.messages,existing).slice(0,limit);
        else if(kind==='newer')next=merge(existing,page.messages).slice(-limit);
        if(kind==='initial'&&unreadTarget){follow.current=false;pendingPosition.current={unread:true};}
        else if(kind==='latest'||(kind==='initial'&&(!saved||saved.follow))){follow.current=true;pendingPosition.current={bottom:true};}
        else if(kind==='around'){follow.current=false;pendingPosition.current={target};}
        else if(kind==='initial'&&saved){follow.current=false;pendingPosition.current={anchor:saved};}
        else pendingPosition.current=follow.current?{bottom:true}:{anchor:anchor()||oldAnchor};
        next=next.filter(message=>!deletedMessages.current.has(message.id));
        predecessor.current=undefined;
        const oldBefore=next.length?existing.findIndex(m=>m.id===next[0].id):-1;
        if(incremental&&oldBefore>0)predecessor.current=existing[oldBefore-1];
        else if(incremental&&oldBefore===0)predecessor.current=oldPredecessor;
        else if(next.length&&next[0].id>page.first){const preceding=await membership<MessagePage>('messages',{serverId,channelId,options:{before:next[0].id,limit:1}});if(generation!==epoch.current)return;predecessor.current=preceding.messages.at(-1);}
        confirmOutgoing(page.messages);setNewCount(page.unread);rows.current=next;setMessages(next);boundsRef.current={first:page.first,last:page.last};setBounds(boundsRef.current);setAway(!follow.current);setReady(true);setFailure('');
        loadedRevision.current=page.revision??revision;await refreshQuotes(next,generation,!!incremental);
      }catch(error){if(kind==='sync'&&force)fullSync.current=true;if(generation===epoch.current)setFailure((error as Error).message);}
      finally{if(generation===epoch.current)setLoading(false);}
    });queue.current=job;return job;
  }
  async function navigate(kind:LoadKind,target?:number){if(navigation.current)return;navigation.current=true;try{if(kind!=='latest')follow.current=false;await load(kind,target);}finally{navigation.current=false;}}
  useEffect(()=>{const generation=++epoch.current;void load('initial');return()=>{if(epoch.current===generation)epoch.current++;clearTimeout(highlightTimer.current);for(const timer of deliveryWaiters.current.values())clearTimeout(timer);deliveryWaiters.current.clear();};},[key]);
  useEffect(()=>{const subscriptionId=crypto.randomUUID().replaceAll('-','');let cancelled=false,pending=false,dirty=false;
    const sync=async()=>{if(pending){dirty=true;return;}pending=true;do{dirty=false;await load('sync');}while(dirty&&!cancelled);pending=false;};
    const events=window.desktop?.onMembershipServerEvent?.(event=>{if(event.serverId!==serverId)return;if(event.channelId===channelId&&event.delivery){eventRevision.current=Math.max(eventRevision.current,event.revision||0);eventLast.current=event.last||0;deliver(event);return;}if(event.type==='resync')fullSync.current=true;if(event.channelId===channelId){eventRevision.current=Math.max(eventRevision.current,event.revision||0);eventLast.current=event.last||0;if(event.rescan)fullSync.current=true;}});
    const off=window.desktop?.onMembershipChatChanged?.(event=>{if(event.serverId===serverId&&event.channelId===channelId&&!event.delivery)void sync();});
    if(off)void membership('chat.watch',{serverId,channelId,subscriptionId}).catch(()=>{});
    return()=>{cancelled=true;off?.();events?.();if(off)void membership('chat.unwatch',{subscriptionId}).catch(()=>{});};
  },[key]);
  useEffect(()=>{if(ready)void load('sync');},[channel.messageRevision,ready]);
  useEffect(()=>{if(ready)void navigate(follow.current?'latest':'around',lastAnchor.current?.id||rows.current[0]?.id);},[limit]);
  useEffect(()=>{if(!failure)return;const timer=setInterval(()=>void load('sync'),3500);return()=>clearInterval(timer);},[failure]);
  useEffect(()=>{drafts.set(key,{text,mentions,file,reply});if(drafts.size>100)drafts.delete(drafts.keys().next().value!);},[text,mentions,file,reply,key]);
  useEffect(()=>{if(!file){setPreview('');return;}const url=URL.createObjectURL(file);setPreview(url);return()=>URL.revokeObjectURL(url);},[file]);
  useEffect(()=>{if(focused&&!editing&&!menu){const timer=setTimeout(focusInput,0);return()=>clearTimeout(timer);}},[focused,key,editing?.id,!!menu,!!deleting]);
  useLayoutEffect(()=>{
    const list=pane.current;if(!list)return;const position=pendingPosition.current;pendingPosition.current=undefined;
    if(position?.bottom)list.scrollTop=list.scrollHeight;
    else if(position?.unread){const divider=list.querySelector<HTMLElement>('.chat-divider');if(divider)list.scrollTop+=divider.getBoundingClientRect().top-list.getBoundingClientRect().top;follow.current=!hasNewer&&list.scrollHeight-list.scrollTop-list.clientHeight<12;setAway(!follow.current);}
    else if(position?.anchor)restoreAnchor(position.anchor);
    else if(position?.target){const row=list.querySelector<HTMLElement>(`[data-message-row="${position.target}"]`);if(row){list.scrollTop+=row.getBoundingClientRect().top-list.getBoundingClientRect().top-list.clientHeight/2+row.offsetHeight/2;highlight(row);follow.current=!hasNewer&&list.scrollHeight-list.scrollTop-list.clientHeight<12;setAway(!follow.current);}else setNotice(t('Исходное сообщение уже недоступно.'));}
    const sent=arrival.current;if(sent){const row=list.querySelector<HTMLElement>(`.chat-message-pending .member-message-text`);if(row){arrival.current=undefined;if(!matchMedia('(prefers-reduced-motion: reduce)').matches){const r=row.getBoundingClientRect();row.animate([{transform:`translate(${sent.x-r.left}px,${sent.y-r.top}px)`,opacity:.5},{transform:'none',opacity:1}],{duration:220,easing:'ease-out'});}}}
    if(!hasNewer&&list.scrollHeight-list.scrollTop-list.clientHeight<12){follow.current=true;setAway(false);}
    lastScroll.current=list.scrollTop;remember();current.current.onViewport?.(follow.current);
  },[messages,hasNewer,outgoing]);
  useEffect(()=>{
    const list=pane.current;if(!list)return;
    const observer=new ResizeObserver(()=>{const saved=resizeAnchor.current;if(follow.current)list.scrollTop=list.scrollHeight;else if(saved&&(saved.width!==list.clientWidth||saved.height!==list.clientHeight)){const row=list.querySelector<HTMLElement>(`[data-message-row="${saved.id}"]`);if(row)list.scrollTop+=row.getBoundingClientRect().bottom-list.getBoundingClientRect().bottom-saved.offset;}lastScroll.current=list.scrollTop;resizeAnchor.current=undefined;remember();});observer.observe(list);if(content.current)observer.observe(content.current);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    if(!focused||!ready||creatingPoll)return;const list=pane.current;if(!list)return;
    const observer=new IntersectionObserver(entries=>{if(!current.current.focused)return;for(const entry of entries)if(entry.isIntersecting)markRead(Number((entry.target as HTMLElement).dataset.readId));},{root:list,threshold:1});
    for(const row of list.querySelectorAll('[data-read-id]'))observer.observe(row);return()=>observer.disconnect();
  },[messages,focused,ready,creatingPoll]);
  useLayoutEffect(()=>{const field=editInput.current;if(!editing||!field)return;field.style.height='auto';field.style.height=`${field.scrollHeight}px`;field.focus({preventScroll:true});field.closest('.chat-inline-edit')?.scrollIntoView({block:'nearest'});},[editing?.id,editText]);
  useEffect(()=>{const field=composer.current;if(field){field.style.height='auto';field.style.height=`${Math.min(180,field.scrollHeight)}px`;}},[text]);
  useEffect(()=>{
    if(!menu)return;const element=menuRef.current!;const r=element.getBoundingClientRect();element.style.left=`${Math.max(8,Math.min(menu.x,innerWidth-r.width-8))}px`;element.style.top=`${Math.max(8,Math.min(menu.y,innerHeight-r.height-8))}px`;element.querySelector<HTMLButtonElement>('button')?.focus();
    const close=(event:Event)=>{if(!element.contains(event.target as Node))setMenu(undefined);};document.addEventListener('pointerdown',close);window.addEventListener('resize',close);return()=>{document.removeEventListener('pointerdown',close);window.removeEventListener('resize',close);};
  },[menu]);
  function quote(id:number,fallback?:Message['content']['reply']){const source=messages.find(m=>m.id===id)??quotes.get(id);return {source,author:source?source.systemKind?t('Система'):profileFor(state,source.authorProfileId)?.nickname||t('Участник'):t('Участник'),text:source===null?t('Исходное сообщение уже недоступно.'):source?.unreadable?t('Не удалось расшифровать сообщение.'):source?(source.content.text||t('Изображение')):t('Загрузка истории…')};}
  function beginReply(message:Message){setReply(message);setMenu(undefined);focusInput();void refreshQuotes(rows.current,epoch.current).catch(()=>{});}
  function beginEdit(message:Message){if(mutationRef.current||message.content.poll)return;setEditMentions(message.content.mentions||[]);setEditing(message);setRemoveImage(false);setEditText(message.content.text);setMutationError('');setMenu(undefined);}
  function cancelEdit(){if(mutationRef.current)return;setEditing(undefined);setMutationError('');focusInput();}
  function highlight(row:HTMLElement){row.classList.add('chat-message-target');clearTimeout(highlightTimer.current);highlightTimer.current=setTimeout(()=>row.classList.remove('chat-message-target'),1600);}
  async function jump(id:number){
    const list=pane.current,row=list?.querySelector<HTMLElement>(`[data-message-row="${id}"]`);
    if(row&&list){
      const viewport=list.getBoundingClientRect(),target=row.getBoundingClientRect();
      if(target.top>=viewport.top&&target.bottom<=viewport.top+list.clientHeight){highlight(row);return;}
      pendingPosition.current={target:id};follow.current=false;setMessages([...rows.current]);
    }else await navigate('around',id);
  }
  function selectFile(next?:File){if(!next||sendingRef.current)return;if(!['image/png','image/jpeg','image/webp'].includes(next.type)||next.size>2*1024*1024){onError(t('Выберите PNG, JPEG или WebP размером до 2 МБ.'));return;}uploaded.current=undefined;setFile(next);setAttachmentMenu(false);focusInput();}
  async function send(){
    const value=text.trim();if(sendingRef.current||(!value&&!file)||new TextEncoder().encode(value).length>4096)return;
    sendTimes.current=sendTimes.current.filter(time=>Date.now()-time<1000);if(sendTimes.current.length>=3){setSendError(t('Слишком много сообщений. Подождите секунду.'));return;}
    sendingRef.current=true;setSending(true);setSendError('');const generation=epoch.current,origin=composer.current?.getBoundingClientRect();
    const latestReply=reply&&quote(reply.id,{id:reply.id,author:profileFor(state,reply.authorProfileId)?.nickname||t('Участник'),text:reply.content.text});
    const content:Message['content']={text:value,mentions:mentions.map(m=>({...m,start:m.start-(text.length-text.trimStart().length),end:m.end-(text.length-text.trimStart().length)})),...(reply?{reply:{id:reply.id,author:latestReply?.source?latestReply.author:profileFor(state,reply.authorProfileId)?.nickname||t('Участник'),text:latestReply?.source?latestReply.source.content.text:reply.content.text}}:{})};
    if(origin)arrival.current={x:origin.left+14,y:origin.top+12};
    showOutgoing({message:{id:-1,channelId,authorProfileId:state.self.profileId,requestId:crypto.randomUUID().replaceAll('-',''),sentAt:Date.now(),content},preview:file?URL.createObjectURL(file):undefined,confirmed:false});follow.current=true;setAway(false);pendingPosition.current={bottom:true};
    try{
      let image=file&&uploaded.current?.file===file?uploaded.current.image:undefined;
      if(file&&!image){image=await membership<{id:string;mime:string}>('upload',{serverId,channelId,mime:file.type,bytes:new Uint8Array(await file.arrayBuffer())});uploaded.current={file,image:image!};}
      if(generation!==epoch.current)return;
      const body={...content,...(image?{image}:{})},signature=JSON.stringify(body);
      if(pendingSend.current?.signature!==signature)pendingSend.current={signature,id:crypto.randomUUID().replaceAll('-','')};
      showOutgoing({...outgoingRef.current!,message:{...outgoingRef.current!.message,content:body,requestId:pendingSend.current.id}});
      let result:{id:number};
      try{result=await membership<{id:number}>('send',{serverId,channelId,content:body,requestId:pendingSend.current.id});}
      catch(error){if(!outgoingRef.current?.confirmed)throw error;result={id:outgoingRef.current.message.id};}
      if(generation!==epoch.current)return;showOutgoing({...outgoingRef.current!,message:{...outgoingRef.current!.message,id:result.id},confirmed:true});pendingSend.current=undefined;uploaded.current=undefined;sendTimes.current.push(Date.now());setHasSent(true);setMentions([]);setText('');setReply(undefined);setFile(undefined);follow.current=true;setAway(false);if(result?.id){markRead(result.id);}await load('latest');if(generation===epoch.current&&rows.current.some(m=>m.requestId===outgoingRef.current?.message.requestId)){outgoingRef.current=undefined;setOutgoing(undefined);}
    }catch(error){if(generation===epoch.current){outgoingRef.current=undefined;setOutgoing(undefined);setSendError((error as Error).message);}}
    finally{sendingRef.current=false;if(generation===epoch.current){setSending(false);focusInput();}}
  }
  async function mutate(message:Message,value?:string){
    if(mutationRef.current)return;const content={...message.content,text:value?.trim()||'',mentions:editMentions.map(m=>({...m,start:m.start-(editText.length-editText.trimStart().length),end:m.end-(editText.length-editText.trimStart().length)}))};if(value!==undefined&&removeImage)delete content.image;if(value!==undefined&&new TextEncoder().encode(content.text).length>4096)return;if(value!==undefined&&!content.text&&!content.image)value=undefined;
    if(value!==undefined&&value.trim()===message.content.text.trim()&&!removeImage&&JSON.stringify(content.mentions)===JSON.stringify(message.content.mentions||[])){cancelEdit();return;}
    mutationRef.current=true;setMutating(true);setMutationError('');const generation=epoch.current;
    try{
      if(value===undefined)await membership('message.delete',{serverId,messageId:message.id});
      else await membership('send',{serverId,channelId,content,original:message});
      if(generation!==epoch.current)return;
      if(value===undefined){deletedMessages.current.add(message.id);if(deletedMessages.current.size>1000)deletedMessages.current.delete(deletedMessages.current.values().next().value!);}
      pendingPosition.current=follow.current?{bottom:true}:{anchor:anchor()};rows.current=value===undefined?rows.current.filter(m=>m.id!==message.id):rows.current.map(m=>m.id===message.id?{...m,content,editedAt:Date.now()}:m);
      if(value===undefined&&message.id===Math.max(boundsRef.current.last,reportedLast)){
        const last=rows.current.at(-1)?.id||0;setBounds(previous=>({...previous,last}));
        if(follow.current)setAway(false);
      }
      setMessages(rows.current);setEditing(undefined);setDeleting(undefined);await load('sync');
    }catch(error){if(generation===epoch.current)setMutationError((error as Error).message);}
    finally{mutationRef.current=false;if(generation===epoch.current){setMutating(false);focusInput();}}
  }
  function requestDelete(message:Message,skip=false){if(message.locked||message.systemKind)return;setMenu(undefined);setMutationError('');if(skip)void mutate(message);else setDeleting(message);}
  const tooLong=new TextEncoder().encode(text.trim()).length>4096;
  const displayed=outgoing&&!messages.some(m=>m.requestId===outgoing.message.requestId&&effectiveProfile(state,m.authorProfileId)===state.self.effectiveProfileId)?[...messages,outgoing.message]:messages;
  return <section className="member-chat room-chat" aria-label={channel.name} onDragOver={event=>{if(event.dataTransfer.types.includes(memberDragType)){event.preventDefault();event.dataTransfer.dropEffect='copy';}}} onDrop={event=>{const raw=event.dataTransfer.getData(memberDragType);if(!raw)return;event.preventDefault();if(sendingRef.current)return;const field=composer.current,next=dropMemberMention(raw,state,text,mentions,field?.selectionStart??text.length,field?.selectionEnd??text.length);if(!next)return;setText(next.text);setMentions(next.mentions);requestAnimationFrame(()=>{field?.focus();field?.setSelectionRange(next.caret,next.caret);});}}>
    <div className="chat-feed"><div ref={pane} className="member-history chat-stream" tabIndex={0} role="log" aria-label={t('Сообщения чата')} aria-live="polite" aria-busy={loading} onLoadCapture={()=>{const list=pane.current;if(list){if(follow.current)list.scrollTop=list.scrollHeight;else restoreAnchor(lastAnchor.current);lastScroll.current=list.scrollTop;remember();}}} onScroll={()=>{
      const list=pane.current!,delta=list.scrollTop-lastScroll.current;lastScroll.current=list.scrollTop;if(!delta||resizeAnchor.current&&(resizeAnchor.current.width!==list.clientWidth||resizeAnchor.current.height!==list.clientHeight))return;follow.current=list.scrollHeight-list.scrollTop-list.clientHeight<12&&(!hasNewer||follow.current);setAway(!follow.current);remember();current.current.onViewport?.(follow.current);if(delta<0&&list.scrollTop<100&&hasOlder)void navigate('older');else if(delta>0&&list.scrollHeight-list.scrollTop-list.clientHeight<100&&hasNewer)void navigate('newer');
    }}><div ref={content}>
      {hasOlder&&<button className="member-load chat-page-loader" disabled={loading} onClick={()=>void navigate('older')}>{t('Предыдущие сообщения')}</button>}
      {!ready&&<p className="chat-empty" role="status">{t('Загрузка истории…')}</p>}
      {ready&&!displayed.length&&<div className="member-chat-welcome"><Icon name="chat" size={42}/><h2>{channel.name}</h2><p>{t('Начните общение в этом чате.')}</p></div>}
      {displayed.map((message,index)=>{
        const local=message===outgoing?.message,pending=local&&!outgoing!.confirmed,author=profileFor(state,message.authorProfileId),system=message.systemKind==='poll-result',own=!system&&effectiveProfile(state,message.authorProfileId)===state.self.effectiveProfileId,previous=index?displayed[index-1]:predecessor.current,isEditing=editing?.id===message.id;
        const firstUnread=!local&&!hasSent&&message.id>entryRead.current&&(!previous||previous.id<=entryRead.current),continuation=!isEditing&&!firstUnread&&!message.content.reply&&!message.content.poll&&!previous?.content.poll&&previous&&effectiveProfile(state,previous.authorProfileId)===effectiveProfile(state,message.authorProfileId)&&message.sentAt>=previous.sentAt&&message.sentAt-previous.sentAt<=300000&&new Date(message.sentAt).toDateString()===new Date(previous.sentAt).toDateString();
        const reference=message.content.reply&&quote(message.content.reply.id,message.content.reply);
        return <article className={`member-message chat-message${pending?' chat-message-pending':''}${message.content.mentions?.some(m=>effectiveProfile(state,m.profileId)===state.self.effectiveProfileId)?' chat-message-mentioned':''}${continuation?' chat-message-continuation':''}`} key={message.id} aria-busy={pending||undefined}>
          {firstUnread&&<div className="chat-divider">{t('Новые сообщения')}</div>}
          <div className={`chat-message-row${isEditing?' chat-message-editing':''}`} data-message-row={pending?undefined:message.id} onContextMenu={event=>{if(local||isEditing||message.unreadable)return;event.preventDefault();setMenu({message,x:event.clientX,y:event.clientY});}}>
            {system?<span className="chat-system-avatar" aria-hidden="true"><Icon name="paw" size={22}/></span>:continuation?<span className="chat-continuation-time"><MessageTime sent={message.sentAt}/></span>:<Avatar className="chat-avatar" name={author?.nickname||t('Участник')} image={author?.avatar}/>}
            <div className="member-message-content chat-message-body">
              {!continuation&&<div className="member-message-heading chat-meta"><strong>{system?t('Система'):author?.nickname||t('Участник')}</strong><MessageTime sent={message.sentAt}/></div>}
              {reference&&<button type="button" className="member-reply chat-reply-quote" onClick={()=>{if(reference.source===null)setNotice(t('Исходное сообщение уже недоступно.'));else void jump(message.content.reply!.id);}}><Icon name="reply" size={13}/><strong>{reference.author}</strong><span className="chat-reply-text"><MessageText text={reference.text.slice(0,240)} preview/></span></button>}
              {message.content.poll?<PollCard message={message} state={state} onJump={id=>void jump(id)} onClosed={()=>{if(!message.locked){rows.current=rows.current.map(row=>row.id===message.id?{...row,locked:true}:row);setMessages(rows.current);}}}/>:isEditing?<form className="chat-inline-edit" aria-label={t('Редактировать сообщение')} onSubmit={event=>{event.preventDefault();void mutate(message,editText);}}><MentionTextarea state={state} mentions={editMentions} onValue={(value,mentions)=>{setEditText(value);setEditMentions(mentions);}} ref={editInput} rows={1} value={editText} maxLength={4096} readOnly={mutating} aria-label={t('Сообщение')} onEscape={cancelEdit} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancelEdit();}else if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.nativeEvent.keyCode!==229){event.preventDefault();if(!event.repeat)void mutate(message,editText);}}}/>{removeImage&&<small className="chat-edit-removed">{t('Вложение будет удалено')}</small>}<div className="chat-edit-hint"><span>{t('Esc для')}</span> <button type="button" disabled={mutating} onClick={cancelEdit}>{t('отмены')}</button><span> · {t('Enter чтобы')}</span> <button type="submit" disabled={mutating}>{t('сохранить')}</button></div>{mutationError&&<p role="alert" className="text-error">{mutationError}</p>}</form>:<div className="member-message-text">{message.unreadable?<em>{t('Не удалось расшифровать сообщение.')}</em>:<MessageText text={message.content.text} mentions={message.content.mentions}/>}{!!message.editedAt&&<small className="chat-edited">{t('изменено')}</small>}</div>}
              {local&&outgoing?.preview?<img className="member-chat-image chat-pending-image" src={outgoing.preview} alt={t('Изображение')}/>:message.content.image&&!(isEditing&&removeImage)&&<EncryptedImage serverId={serverId} channelId={channelId} image={message.content.image} onRemove={isEditing?()=>setRemoveImage(true):undefined} removing={mutating}/>}
            </div>
            {!local&&!system&&!message.unreadable&&!isEditing&&<div className="member-message-actions"><button type="button" className="icon-button" title={t('Ответить')} aria-label={t('Ответить')} onClick={()=>beginReply(message)}><Icon name="reply" size={16}/></button>{own&&!message.locked&&<>{!message.content.poll&&<button type="button" className="icon-button" title={t('Редактировать')} aria-label={t('Редактировать')} onClick={()=>beginEdit(message)}><Icon name="edit" size={16}/></button>}<button type="button" className="icon-button" title={t('Удалить сообщение')} aria-label={t('Удалить сообщение')} onClick={event=>requestDelete(message,event.shiftKey)}><Icon name="trash" size={16}/></button></>}</div>}
          </div>{!local&&<div className="chat-read-end" data-read-id={message.id}/>}
        </article>;
      })}
      {hasNewer&&!follow.current&&<button className="member-load chat-page-loader" disabled={loading} onClick={()=>void navigate('newer')}>{t('Следующие сообщения')}</button>}
    </div></div>{(away||hasNewer&&!follow.current)&&<button className="member-load chat-jump" title={t('К новым сообщениям')} aria-label={newCount?t('Новых сообщений: {0}',newCount):t('К новым сообщениям')} onClick={()=>{follow.current=true;void navigate('latest');focusInput();}}><Icon name="arrow-down" size={20}/>{newCount>0&&<b className="chat-jump-count">{newCount}</b>}</button>}</div>
    {failure&&<p className="member-chat-error text-error" role="alert">{failure}<button onClick={()=>void load('sync')}>{t('Повторить')}</button></p>}
    {sendError&&<p className="text-error" role="alert">{sendError}</p>}
    {tooLong&&<p className="text-error" role="status">{t('Сообщение слишком длинное.')}</p>}
    {notice&&<p className="chat-inline-notice" role="status">{notice}<button type="button" aria-label={t('Закрыть сообщение')} onClick={()=>setNotice('')}>×</button></p>}
    <form className="member-composer chat-composer" onSubmit={event=>{event.preventDefault();void send();}} onDragOver={event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();}} onDrop={event=>{if(event.dataTransfer.types.includes(memberDragType))return;event.preventDefault();selectFile(event.dataTransfer.files[0]);}} onPaste={event=>{const next=[...event.clipboardData.files].find(file=>file.type.startsWith('image/'));if(next){event.preventDefault();selectFile(next);}}}>
      {reply&&<div className="member-compose-context chat-reply-draft"><Icon name="reply" size={16}/><div><strong>{t('Ответ {0}',quote(reply.id,{id:reply.id,author:profileFor(state,reply.authorProfileId)?.nickname||t('Участник'),text:reply.content.text}).author)}</strong><span className="chat-reply-text"><MessageText text={quote(reply.id,{id:reply.id,author:'',text:reply.content.text}).text.slice(0,240)} preview/></span></div><button type="button" className="icon-button" aria-label={t('Отменить ответ')} disabled={sending} onClick={()=>{setReply(undefined);focusInput();}}>×</button></div>}
      {file&&<div className="member-compose-context chat-attachment-draft">{preview&&<img src={preview} alt={file.name}/>}<div><strong>{file.name}</strong><span>{Math.ceil(file.size/1024)} {t('КБ')}</span></div><button type="button" className="icon-button" aria-label={t('Удалить вложение')} disabled={sending} onClick={()=>{setFile(undefined);uploaded.current=undefined;focusInput();}}>×</button></div>}
      <div className="chat-compose"><input ref={picker} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={event=>{selectFile(event.target.files?.[0]);event.target.value='';}}/>
        <div className="chat-attachment-control" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setAttachmentMenu(false);}}><button className="chat-attach" type="button" disabled={sending} title={t('Прикрепить изображение')} aria-label={t('Прикрепить изображение')} aria-haspopup="menu" aria-expanded={attachmentMenu} onClick={()=>setAttachmentMenu(value=>!value)}><Icon name="plus" size={22}/></button>{attachmentMenu&&<div className="chat-attachment-menu" role="menu" aria-label={t('Вложения')}><button type="button" role="menuitem" autoFocus onClick={()=>{setAttachmentMenu(false);picker.current?.click();}}><Icon name="image" size={18}/>{t('Отправить файл')}</button>{state.capabilities?.includes('polls-v1')&&<button type="button" role="menuitem" onClick={()=>{setAttachmentMenu(false);setCreatingPoll(true);}}><Icon name="chat" size={18}/>{t('Создать опрос')}</button>}</div>}</div>
        <div className="chat-input-shell"><MentionTextarea state={state} mentions={mentions} onValue={(value,mentions)=>{setText(value);setMentions(mentions);}} ref={composer} value={text} maxLength={4096} rows={1} readOnly={sending} aria-label={t('Сообщение')} placeholder={t('Написать в «{0}»',channel.name)} onEscape={()=>{if(reply)setReply(undefined);}} onKeyDown={event=>{if(event.key==='Escape'&&reply){event.preventDefault();setReply(undefined);return;}if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.nativeEvent.keyCode!==229){event.preventDefault();if(!event.repeat)void send();}}}/></div>
      </div>
    </form>
    {menu&&createPortal(<div ref={menuRef} className="chat-message-menu" role="menu" style={{left:menu.x,top:menu.y}} onKeyDown={event=>{if(event.key==='Escape'||event.key==='Tab'){setMenu(undefined);focusInput();return;}if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}}}><button role="menuitem" onClick={()=>beginReply(menu.message)}><Icon name="reply" size={17}/>{t('Ответить')}</button>{!!menu.message.content.text&&<button role="menuitem" onClick={()=>{void membership('copy',{text:menu.message.content.text}).catch(error=>onError(error.message));setMenu(undefined);}}><Icon name="copy" size={17}/>{t('Скопировать текст')}</button>}{!menu.message.systemKind&&!menu.message.locked&&effectiveProfile(state,menu.message.authorProfileId)===state.self.effectiveProfileId&&<>{!menu.message.content.poll&&<button role="menuitem" onClick={()=>beginEdit(menu.message)}><Icon name="edit" size={17}/>{t('Редактировать')}</button>}<div role="separator" className="chat-menu-separator"/><button role="menuitem" className="chat-menu-delete" onClick={event=>requestDelete(menu.message,event.shiftKey)}><Icon name="trash" size={17}/>{t('Удалить сообщение')}</button></>}</div>,document.body)}
    {creatingPoll&&<PollDialog serverId={serverId} channelId={channelId} onClose={()=>{setCreatingPoll(false);focusInput();}} onPosted={async()=>{setHasSent(true);follow.current=true;await load('latest');}}/>}
    {deleting&&<Modal title={t('Удалить сообщение')} className="chat-delete-modal" onClose={()=>{if(!mutating)setDeleting(undefined);}}><p className="chat-delete-question">{t('Вы действительно хотите удалить это сообщение?')}</p><div className="chat-delete-preview"><Avatar name={profileFor(state,deleting.authorProfileId)?.nickname||t('Участник')} image={profileFor(state,deleting.authorProfileId)?.avatar} className="chat-avatar"/><div className="chat-message-body"><div className="chat-meta"><strong>{profileFor(state,deleting.authorProfileId)?.nickname||t('Участник')}</strong><MessageTime sent={deleting.sentAt}/></div><MessageText text={deleting.content.text}/>{deleting.content.image&&<div className="chat-delete-attachment"><Icon name="image" size={16}/>{t('Изображение')}</div>}</div></div><p className="chat-delete-tip"><strong>{t('Подсказка:')}</strong><br/>{t('Чтобы полностью обойти это подтверждение, удерживайте Shift при нажатии на «Удалить сообщение».')}</p>{mutationError&&<p role="alert" className="text-error">{mutationError}</p>}<div className="modal-actions"><button type="button" disabled={mutating} onClick={()=>{setDeleting(undefined);focusInput();}}>{t('Отмена')}</button><button type="button" className="danger-button" disabled={mutating} onClick={()=>void mutate(deleting)}>{t('Удалить')}</button></div></Modal>}
  </section>;
}
