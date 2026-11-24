import {VideoMessage} from './VideoMessage';
import {AttachmentDrafts} from './AttachmentDrafts';
import {ChatFileDrop} from './ChatFileDrop';
import {allocateMediaViews,prepareDraft,disposeDraft,canPrepareAttachment,fitChatAttachment,hasGalleryPreview,largeAttachmentLimit,imageMime,mediaVariantsCapability,videoMime,type MediaDraft} from './mediaDraft';
import {ChecklistDialog,ChecklistCard} from './Checklist';
import {ChatFile} from './ChatFile';
import {ChatEmptyState} from './ChatEmptyState';
import {useMessageHighlight} from './useMessageHighlight';
import {VoiceComposer,type VoiceDraft} from './VoiceComposer';
import {dropMemberMention,memberDragType} from './memberMention';
import {PollCard} from './PollCard';
import {PollDialog} from './PollDialog';
import {MentionTextarea} from './MentionTextarea';
import { animateSendFlight, composerTextOrigin } from './sendFlight';
import { trimMessage } from './trimMessage';
import type {Mention} from '../../../../shared/mentions.mjs';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from './Avatar';
import { Icon } from './Controls';
import { MessageText } from './MessageText';
import { Modal } from './Modal';
import { ChatImage } from './ChatImage';
import { MessageTime } from './MessageTime';
import { loadChatWindow } from './ChatSettings';
import { ChatHistory } from './chatHistory';
import { t } from './i18n';
import { cursorKey, effectiveProfile, membership, profileFor, type Channel, type Message, type MessagePage, type ServerState } from './membership';

type Anchor = { id: number; offset: number };
type Position = Anchor & { follow: boolean };
type LoadKind = 'initial' | 'sync' | 'older' | 'newer' | 'latest' | 'around';
type Draft = { text: string; mentions?:Mention[]; media?: MediaDraft[]; reply?: Message };
type Outgoing = {message:Message;preview?:string;confirmed:boolean};
const drafts = new Map<string,Draft>();
function readPosition(key:string):Position|undefined { try {const p=JSON.parse(localStorage.getItem(key)||'null');return p&&Number.isSafeInteger(p.id)&&p.id>0&&Number.isFinite(p.offset)&&typeof p.follow==='boolean'?p:undefined;}catch{return undefined;} }
function EncryptedImage({ serverId, channelId, image, onRemove, removing,credits }: { serverId: string; channelId: string; image: NonNullable<Message['content']['image']>; onRemove?():void; removing?:boolean;credits?:{author?:string;avatar?:string;date?:number} }) {
  const load = useCallback(async () => {
    const value = await membership<string>('image', { serverId, channelId, attachmentId: image.id, mime: image.mime });
    const raw = atob(value.slice(value.indexOf(',') + 1));
    return new Blob([Uint8Array.from(raw, character => character.charCodeAt(0))], { type: image.mime });
  }, [serverId, channelId, image.id, image.mime]);
  if (image.size !== undefined) {
    const file = { ...image, size: image.size, name: image.name ?? 'image.' + image.mime.split('/')[1] };
    return <div className="chat-image">
      <VideoMessage serverId={serverId} channelId={channelId} files={[file]} saveImageNatively {...credits}/>
      {onRemove && <button type="button" className="icon-button chat-image-remove" disabled={removing}
        title={t('Удалить вложение')} aria-label={t('Удалить вложение')} onClick={onRemove}><Icon name="trash" size={18}/></button>}
    </div>;
  }
  return <ChatImage image={{ ...image, mime: image.mime as 'image/png'|'image/jpeg'|'image/webp', name: image.name || 'image.' + image.mime.split('/')[1], size: 0, width: 320, height: 200 }} load={load} credits={credits} onRemove={onRemove} removing={removing}/>;
}

export function ServerChat({ state, channel, focused, onRead, onError, onViewport }: { state: ServerState; channel: Channel; focused: boolean; onRead(last: number): void; onError(error: string): void; onViewport?(latest:boolean):void }) {
  const serverId=state.serverId,channelId=channel.id,key=`${serverId}:${channelId}`,positionKey=`pawtalk.v2.position.${key}`,limit=loadChatWindow();
  const [messages,setMessages]=useState<Message[]>([]),rows=useRef<Message[]>([]),predecessor=useRef<Message|undefined>(undefined);
  const history=useRef(new ChatHistory()),olderEdge=useRef<HTMLDivElement>(null),newerEdge=useRef<HTMLDivElement>(null);
  const [text,setText]=useState(()=>drafts.get(key)?.text||''),[media,setMedia]=useState<MediaDraft[]>(()=>drafts.get(key)?.media||[]),[reply,setReply]=useState<Message|undefined>(()=>drafts.get(key)?.reply);
  const file=media[0]?.file;const [preparing,setPreparing]=useState(false),preparation=useRef<AbortController>(undefined);
  useEffect(()=>()=>preparation.current?.abort(),[]);
  const [checklistDialog,setChecklistDialog]=useState<Message | true>();
  const [recordingVoice,setRecordingVoice]=useState(false);
  const [creatingPoll,setCreatingPoll]=useState(false),[showPreview,setShowPreview]=useState(false);
  const scrollTimer=useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(()=>()=>clearTimeout(scrollTimer.current),[]);
  const [mentions,setMentions]=useState<Mention[]>(()=>drafts.get(key)?.mentions||[]),[editMentions,setEditMentions]=useState<Mention[]>([]);
  const [editing,setEditing]=useState<Message>(),[editText,setEditText]=useState(''),[removeImage,setRemoveImage]=useState(false),[deleting,setDeleting]=useState<Message>();
  const [sending,setSending]=useState(false),[mutating,setMutating]=useState(false),[loading,setLoading]=useState(true),[ready,setReady]=useState(false);
  const [outgoing,setOutgoing]=useState<Outgoing>(),outgoingRef=useRef<Outgoing|undefined>(undefined);
  const [flightActive,setFlightActive]=useState(false),flightCleanup=useRef<((update?:boolean)=>void)|undefined>(undefined);
  function showOutgoing(value:Outgoing){outgoingRef.current=value;setOutgoing(value);}
  useEffect(()=>()=>{if(outgoing?.preview)URL.revokeObjectURL(outgoing.preview);},[outgoing?.preview]);
  useEffect(()=>()=>flightCleanup.current?.(false),[]);
  const [failure,setFailure]=useState(''),[sendError,setSendError]=useState(''),[mutationError,setMutationError]=useState(''),[notice,setNotice]=useState('');
  const [newCount,setNewCount]=useState(0),[bounds,setBounds]=useState({first:0,last:0}),boundsRef=useRef(bounds);boundsRef.current=bounds;
  const [away,setAway]=useState(false),[quotes,setQuotes]=useState(new Map<number,Message|null>()),[preview,setPreview]=useState('');
  const [menu,setMenu]=useState<{message:Message;x:number;y:number}>(),menuRef=useRef<HTMLDivElement>(null),[attachmentMenu,setAttachmentMenu]=useState(false);
  const pane=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null),composer=useRef<HTMLTextAreaElement>(null),editInput=useRef<HTMLTextAreaElement>(null),picker=useRef<HTMLInputElement>(null);
  const savedPosition=useRef(readPosition(positionKey)),follow=useRef(savedPosition.current?.follow!==false),epoch=useRef(0),queue=useRef(Promise.resolve()),navigation=useRef<LoadKind|undefined>(undefined),sendingRef=useRef(false),mutationRef=useRef(false);
  const pendingPosition=useRef<{bottom?:boolean;anchor?:Anchor;target?:number;unread?:boolean}|undefined>(undefined),lastAnchor=useRef<Anchor|undefined>(undefined),resizeAnchor=useRef<{id:number;offset:number;width:number;height:number}|undefined>(undefined),lastScroll=useRef(0);
  const current=useRef({state,channel,focused,onRead,onViewport,reply,pageSize:limit});current.current={state,channel,focused,onRead,onViewport,reply,pageSize:limit};
  const read=useRef(Number(localStorage.getItem(cursorKey(serverId,channelId)))||0),entryRead=useRef(read.current),[hasSent,setHasSent]=useState(false);
  const entryUnread=useRef<number|undefined>(undefined),alignUnread=useRef(false);
  const sendTimes=useRef<number[]>([]);
  const uploaded=useRef(new Map<File,import('./membership').ChatAttachment>()),pendingSend=useRef<{signature:string;id:string}|undefined>(undefined),arrival=useRef<{x:number;y:number}|undefined>(undefined);
  const highlight = useMessageHighlight();
  const deletedMessages=useRef(new Set<number>()),fullSync=useRef(false),eventRevision=useRef(0),eventLast=useRef(0),loadedRevision=useRef(-1),quotesRef=useRef(new Map<number,Message|null>());
  const knownLast=Math.max(bounds.last,channel.lastMessageId),reportedLast=deletedMessages.current.has(knownLast)?messages.at(-1)?.id||0:knownLast;
  const hasOlder=!!messages.length&&messages[0].id>bounds.first,hasNewer=!!messages.length&&messages.at(-1)!.id<reportedLast;
  function confirmOutgoing(updates:Message[]){const pending=outgoingRef.current;if(!pending)return;const state=current.current.state,confirmed=updates.find(m=>m.requestId===pending.message.requestId&&effectiveProfile(state,m.authorProfileId)===state.self.effectiveProfileId);if(confirmed)showOutgoing({...pending,message:confirmed,confirmed:true});}
  function clearConfirmedOutgoing(){if(!sendingRef.current&&!flightCleanup.current&&outgoingRef.current?.confirmed&&rows.current.some(m=>m.requestId===outgoingRef.current!.message.requestId)){outgoingRef.current=undefined;setOutgoing(undefined);}}
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
    for(const id of ids){const cached=history.current.find(id)?.messages.find(m=>m.id===id);if(cached)resolved.set(id,cached);}
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
      const next=history.current.update(updates,[...deleted],previousLast);
      for(const id of deleted)deletedMessages.current.add(id);
      const known=new Map(quotesRef.current),available=new Map([...old,...updates].map(m=>[m.id,m]));for(const m of updates)if(known.has(m.id))known.set(m.id,m);for(const m of next){const id=m.content.reply?.id;if(id&&available.has(id))known.set(id,available.get(id)!);}for(const id of deleted)if(known.has(id))known.set(id,null);quotesRef.current=known;setQuotes(known);
      if(next.length){const at=old.findIndex(m=>m.id===next[0].id);if(at>0)predecessor.current=old[at-1];if(predecessor.current&&deleted.has(predecessor.current.id))predecessor.current=undefined;}
      pendingPosition.current=follow.current?{bottom:true}:{anchor:saved};rows.current=next;setMessages(next);boundsRef.current={first:event.first!,last:event.last!};setBounds(boundsRef.current);loadedRevision.current=event.revision!;setAway(!follow.current);setFailure('');
      clearConfirmedOutgoing();
      try{await refreshQuotes(next,generation,true);}catch(error){if(generation===epoch.current)setFailure((error as Error).message);}
    });queue.current=job;
  }
  function load(kind:LoadKind='sync',target?:number):Promise<void>{
    const generation=epoch.current;
    const job=queue.current.catch(()=>{}).then(async()=>{
      if(generation!==epoch.current)return;
      if(kind==='sync'&&current.current.state.eventsLive&&deliveryWaiters.current.size&&!fullSync.current)return;
      const revision=Math.max(current.current.channel.messageRevision,eventRevision.current),force=fullSync.current||!current.current.state.eventsLive,batchSize=current.current.pageSize;
      if(kind==='sync'&&!fullSync.current&&loadedRevision.current>=revision)return;
      if(kind==='sync')fullSync.current=false;
      setLoading(true);
      const existing=rows.current,oldPredecessor=predecessor.current,oldAnchor=anchor(),saved=kind==='initial'?savedPosition.current:undefined;
      const incremental=kind==='sync'&&!force&&existing.length>0,append=incremental&&follow.current;
      let options:Record<string,unknown>={limit:batchSize,readAfter:read.current};
      if(append)options={...options,after:existing.at(-1)!.id};
      else if(kind==='older')options={...options,before:existing[0]?.id};
      else if(kind==='newer')options={...options,after:existing.at(-1)?.id};
      else if(kind==='around'||(kind==='initial'&&saved&&!saved.follow))options={...options,around:target||saved?.id};
      try{
        const targetLast=Math.max(reportedLast,current.current.channel.lastMessageId,eventLast.current,outgoingRef.current?.confirmed?outgoingRef.current.message.id:0);
        const cached=!fullSync.current&&loadedRevision.current>=revision&&(kind==='around'?history.current.activate(target!):kind==='latest'?history.current.latest(targetLast):undefined);
        if(cached){
          predecessor.current=undefined;
          pendingPosition.current=kind==='latest'?{bottom:true}:{target};
          follow.current=kind==='latest';
          // A cached jump must run the positioning effect even if the active block did not change.
          const next=[...cached];
          rows.current=next;setMessages(next);setAway(!follow.current);
          await refreshQuotes(next,generation,true);return;
        }
        let minimumRevision:number|undefined;
        if(kind==='sync'&&force&&history.current.all.length){
          const ids=history.current.all.map(m=>m.id),updates:Message[]=[],deleted:number[]=[];
          for(let i=0;i<ids.length;i+=500){const selection=ids.slice(i,i+500),snapshot=await membership<MessagePage>('messages',{serverId,channelId,options:{ids:selection,limit:selection.length,readAfter:read.current}});if(generation!==epoch.current)return;updates.push(...snapshot.messages);const found=new Set(snapshot.messages.map(m=>m.id));deleted.push(...selection.filter(id=>!found.has(id)));if(snapshot.revision!==undefined)minimumRevision=Math.min(minimumRevision??snapshot.revision,snapshot.revision);}
          history.current.update(updates,deleted);
        }
        let page=await membership<MessagePage>('messages',{serverId,channelId,options});if(generation!==epoch.current)return;
        if(kind==='initial'&&page.unread>0){
          // The latest page can start well after the read cursor. Fetch near
          // that boundary, including context before the first unread message.
          const readAfter=entryRead.current,entryLast=page.last;
          let unreadPage=await membership<MessagePage>('messages',{serverId,channelId,options:{limit:batchSize,around:readAfter+1,readAfter}});
          if(generation!==epoch.current)return;
          while(unreadPage.unread>0){
            const state=current.current.state;
            const first=unreadPage.messages.find(message=>message.id>readAfter&&!deletedMessages.current.has(message.id)&&
              (message.systemKind||effectiveProfile(state,message.authorProfileId)!==state.self.effectiveProfileId));
            if(first){page=unreadPage;entryUnread.current=first.id;break;}
            // Messages sent by another device on this profile do not count as unread.
            const after=unreadPage.messages.at(-1)?.id;
            if(!unreadPage.hasNewer||!after||after>=entryLast)break;
            unreadPage=await membership<MessagePage>('messages',{serverId,channelId,options:{limit:batchSize,after,readAfter}});
            if(generation!==epoch.current)return;
            if((unreadPage.messages.at(-1)?.id??0)<=after)break;
          }
        }
        history.current.update([],history.current.all.filter(m=>m.id<page.first||m.id>page.last).map(m=>m.id));
        const previousActive=existing[0]?.id;
        history.current.page(page.messages.filter(m=>!deletedMessages.current.has(m.id)),kind==='older'||kind==='newer'||append);
        if(append&&page.hasNewer){page=await membership<MessagePage>('messages',{serverId,channelId,options:{limit:batchSize,readAfter:read.current}});if(generation!==epoch.current)return;history.current.page(page.messages);}
        if(kind==='sync'&&!follow.current&&previousActive)history.current.activate(oldAnchor?.id||previousActive);
        const next=history.current.messages;
        predecessor.current=undefined;
        const oldBefore=next.length?existing.findIndex(m=>m.id===next[0].id):-1;
        if(oldBefore>0)predecessor.current=existing[oldBefore-1];
        else if(oldBefore===0)predecessor.current=oldPredecessor;
        else if(next.length&&next[0].id>page.first){const preceding=await membership<MessagePage>('messages',{serverId,channelId,options:{before:next[0].id,limit:1}});if(generation!==epoch.current)return;predecessor.current=preceding.messages.at(-1);}
        if(kind==='initial'&&entryUnread.current!==undefined||kind==='newer'&&alignUnread.current){follow.current=false;pendingPosition.current={unread:true};}
        else if(kind==='latest'||(kind==='initial'&&(!saved||saved.follow))){follow.current=true;pendingPosition.current={bottom:true};}
        else if(kind==='around'){follow.current=false;pendingPosition.current={target};}
        else if(kind==='initial'&&saved){follow.current=false;pendingPosition.current={anchor:saved};}
        else pendingPosition.current=follow.current?{bottom:true}:{anchor:anchor()||oldAnchor};
        confirmOutgoing(page.messages);setNewCount(page.unread);rows.current=next;setMessages(next);boundsRef.current={first:page.first,last:page.last};setBounds(boundsRef.current);setAway(!follow.current);setReady(true);setFailure('');
        loadedRevision.current=minimumRevision??page.revision??revision;clearConfirmedOutgoing();await refreshQuotes(next,generation,kind!=='sync'||!force);
      }catch(error){if(kind==='sync'&&force)fullSync.current=true;if(generation===epoch.current)setFailure((error as Error).message);}
      finally{if(generation===epoch.current)setLoading(false);}
    });queue.current=job;return job;
  }
  async function navigate(kind:LoadKind,target?:number){
    if(navigation.current&&(kind!=='latest'||navigation.current==='latest'))return;
    if(kind==='latest'||kind==='around')alignUnread.current=false;
    navigation.current=kind;
    try{
      if(kind!=='latest')follow.current=false;
      await load(kind,target);
    }finally{
      if(navigation.current===kind)navigation.current=undefined;
    }
  }
  useEffect(()=>{const generation=++epoch.current;void load('initial');return()=>{if(epoch.current===generation)epoch.current++;for(const timer of deliveryWaiters.current.values())clearTimeout(timer);deliveryWaiters.current.clear();history.current.clear();rows.current=[];quotesRef.current.clear();};},[key]);
  useEffect(()=>{const subscriptionId=crypto.randomUUID().replaceAll('-','');let cancelled=false,pending=false,dirty=false;
    const sync=async()=>{if(pending){dirty=true;return;}pending=true;do{dirty=false;await load('sync');}while(dirty&&!cancelled);pending=false;};
    const events=window.desktop?.onMembershipServerEvent?.(event=>{if(event.serverId!==serverId)return;if(event.channelId===channelId&&event.delivery){eventRevision.current=Math.max(eventRevision.current,event.revision||0);eventLast.current=event.last||0;deliver(event);return;}if(event.type==='resync')fullSync.current=true;if(event.channelId===channelId){eventRevision.current=Math.max(eventRevision.current,event.revision||0);eventLast.current=event.last||0;if(event.rescan)fullSync.current=true;}});
    const off=window.desktop?.onMembershipChatChanged?.(event=>{if(event.serverId===serverId&&event.channelId===channelId&&!event.delivery)void sync();});
    if(off)void membership('chat.watch',{serverId,channelId,subscriptionId}).catch(()=>{});
    return()=>{cancelled=true;off?.();events?.();if(off)void membership('chat.unwatch',{subscriptionId}).catch(()=>{});};
  },[key]);
  const liveDelivery=state.eventsLive&&state.capabilities?.includes('message-events-v1');
  useEffect(()=>{
    if(!ready)return;
    if(liveDelivery&&!fullSync.current&&channel.messageRevision>loadedRevision.current){
      // A state response can advertise a revision before its live envelope arrives.
      const timer=setTimeout(()=>void load('sync'),200);
      return()=>clearTimeout(timer);
    }
    void load('sync');
  },[key,channel.messageRevision,liveDelivery,ready]);
  useEffect(()=>{if(!ready||loading||failure)return;const list=pane.current;if(!list)return;const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){if(entry.target===olderEdge.current&&hasOlder&&(!follow.current||list.scrollHeight<=list.clientHeight+4))void navigate('older');if(entry.target===newerEdge.current&&hasNewer&&!follow.current)void navigate('newer');}},{root:list,rootMargin:'120px 0px'});if(olderEdge.current)observer.observe(olderEdge.current);if(newerEdge.current)observer.observe(newerEdge.current);return()=>observer.disconnect();},[ready,loading,failure,messages,hasOlder,hasNewer]);
  useEffect(()=>{
    if(!ready)return;let cancelled=false,pending=false;
    const check=async()=>{if(pending)return;pending=true;
      try{
        const status=await membership<{low:boolean}>('memory.status').catch(()=>({low:false})),heap=(performance as Performance&{memory?:{usedJSHeapSize:number;jsHeapSizeLimit:number}}).memory;
        if(cancelled||!status?.low&&!(heap&&heap.usedJSHeapSize>heap.jsHeapSizeLimit*.8))return;
        const generation=epoch.current;
        queue.current=queue.current.catch(()=>{}).then(async()=>{
          if(cancelled||generation!==epoch.current)return;const keep=Math.max(100,current.current.pageSize);
          if(history.current.all.length<=keep&&history.current.blocks.length<=1)return;
          const saved=anchor(),old=rows.current,next=history.current.trim(follow.current?old.at(-1)?.id||0:saved?.id||old[0]?.id||0,keep),index=old.findIndex(m=>m.id===next[0]?.id);
          predecessor.current=index>0?old[index-1]:undefined;pendingPosition.current=follow.current?{bottom:true}:{anchor:saved};rows.current=next;setMessages(next);deletedMessages.current.clear();await refreshQuotes(next,generation,true);
        });await queue.current;
      }catch{}finally{pending=false;}
    };
    void check();const timer=setInterval(()=>void check(),15000);return()=>{cancelled=true;clearInterval(timer);};
  },[key,ready]);
  useEffect(()=>{if(!failure)return;const timer=setInterval(()=>void load(ready?'sync':'initial'),3500);return()=>clearInterval(timer);},[failure,ready]);
  useEffect(()=>{drafts.set(key,{text,mentions,media,reply});if(drafts.size>100){const oldest=drafts.keys().next().value!;drafts.get(oldest)?.media?.forEach(disposeDraft);drafts.delete(oldest);}},[text,mentions,media,reply,key]);
  useEffect(()=>{if(!file||!file.type.startsWith('image/')){setPreview('');return;}const url=URL.createObjectURL(file);setPreview(url);return()=>URL.revokeObjectURL(url);},[file]);
  useEffect(()=>{if(focused&&!editing&&!menu){const timer=setTimeout(focusInput,0);return()=>clearTimeout(timer);}},[focused,key,editing?.id,!!menu,!!deleting]);
  useLayoutEffect(()=>{
    const list=pane.current;if(!list)return;const position=pendingPosition.current;pendingPosition.current=undefined;
    if(position?.bottom)list.scrollTop=list.scrollHeight;
    else if(position?.unread){
      const divider=list.querySelector<HTMLElement>('.chat-divider'),top=list.getBoundingClientRect().top;
      if(divider)list.scrollTop+=divider.getBoundingClientRect().top-top;
      // A short page may hit the bottom before the divider reaches the top.
      // Keep the target while the history observer fetches the next page.
      alignUnread.current=!!divider&&hasNewer&&divider.getBoundingClientRect().top-top>2;
      follow.current=!hasNewer&&list.scrollHeight-list.scrollTop-list.clientHeight<12;setAway(!follow.current);
    }
    else if(position?.anchor)restoreAnchor(position.anchor);
    else if(position?.target){const row=list.querySelector<HTMLElement>(`[data-message-row="${position.target}"]`);if(row){list.scrollTop+=row.getBoundingClientRect().top-list.getBoundingClientRect().top-list.clientHeight/2+row.offsetHeight/2;highlight(row);follow.current=!hasNewer&&list.scrollHeight-list.scrollTop-list.clientHeight<12;setAway(!follow.current);}else setNotice(t('Исходное сообщение уже недоступно.'));}
    else if(follow.current)list.scrollTop=list.scrollHeight;
    const sent=arrival.current;
    const row=sent&&list.querySelector<HTMLElement>('.chat-message-pending .member-message-text');
    if(sent&&row){
      arrival.current=undefined;
      flightCleanup.current=animateSendFlight(list,row,sent,()=>{
        flightCleanup.current=undefined;setFlightActive(false);clearConfirmedOutgoing();
      });
      if(flightCleanup.current)setFlightActive(true);
    }
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
  useLayoutEffect(()=>{const field=editInput.current;if(!editing||!field)return;field.focus({preventScroll:true});field.closest('.chat-inline-edit')?.scrollIntoView({block:'nearest'});},[editing?.id]);
  useEffect(()=>{const field=composer.current;if(field){field.style.height='auto';field.style.height=`${Math.min(180,field.scrollHeight)}px`;}},[text]);
  useEffect(()=>{
    if(!menu)return;const element=menuRef.current!;const r=element.getBoundingClientRect();element.style.left=`${Math.max(8,Math.min(menu.x,innerWidth-r.width-8))}px`;element.style.top=`${Math.max(8,Math.min(menu.y,innerHeight-r.height-8))}px`;element.querySelector<HTMLButtonElement>('button')?.focus();
    const close=(event:Event)=>{if(!element.contains(event.target as Node))setMenu(undefined);};document.addEventListener('pointerdown',close);window.addEventListener('resize',close);return()=>{document.removeEventListener('pointerdown',close);window.removeEventListener('resize',close);};
  },[menu]);
  function quote(id:number,fallback?:Message['content']['reply']){const source=messages.find(m=>m.id===id)??quotes.get(id);return {source,author:source?source.systemKind?t('Система'):profileFor(state,source.authorProfileId)?.nickname||t('Участник'):t('Участник'),text:source===null?t('Исходное сообщение уже недоступно.'):source?.unreadable?t('Не удалось расшифровать сообщение.'):source?(source.content.text||t('Изображение')):t('Загрузка истории…')};}
  function beginReply(message:Message){setReply(message);setMenu(undefined);focusInput();void refreshQuotes(rows.current,epoch.current).catch(()=>{});}
  function beginEdit(message:Message){if(mutationRef.current||message.content.poll)return;setEditMentions(message.content.mentions||[]);setEditing(message);setRemoveImage(false);setEditText(message.content.text);setMutationError('');setMenu(undefined);}
  function cancelEdit(){if(mutationRef.current)return;setEditing(undefined);setMutationError('');focusInput();}
  async function jump(id:number){
    const list=pane.current,row=list?.querySelector<HTMLElement>(`[data-message-row="${id}"]`);
    if(row&&list){
      const viewport=list.getBoundingClientRect(),target=row.getBoundingClientRect();
      if(target.top>=viewport.top&&target.bottom<=viewport.top+list.clientHeight){highlight(row);return;}
      pendingPosition.current={target:id};follow.current=false;setMessages([...rows.current]);
    }else await navigate('around',id);
  }
  async function selectFile(...next:File[]){
    if(!next.length||sendingRef.current||preparation.current)return;
    if(media.length+next.length>10){onError(t('Можно прикрепить до 10 файлов.'));return;}
    if(media.length+next.length>1&&!state.capabilities?.includes('media-gallery-v1')){onError(t('Для этой функции обновите сервер.'));return;}
    const limit=state.capabilities?.includes('media-files-v1')?largeAttachmentLimit:2*1024*1024;
    if(next.some(file=>!canPrepareAttachment(file,limit))){onError(t('Файл пуст или превышает допустимый размер.'));return;}
    const controller=new AbortController();preparation.current=controller;
    setPreparing(true);setAttachmentMenu(false);const generation=epoch.current;
    const prepared: MediaDraft[] = [];
    try{
      for (const file of next) {
        prepared.push(await prepareDraft(await fitChatAttachment(file,limit,controller.signal), state.capabilities?.includes(mediaVariantsCapability)));
        if(generation!==epoch.current){prepared.forEach(disposeDraft);return;}
      }
      setMedia(previous=>[...previous,...prepared]);
      if(prepared.some(item=>item.error))onError(t('Не удалось создать превью видео. Файл можно отправить для скачивания.'));
    } catch {
      prepared.forEach(disposeDraft);
      if(generation===epoch.current)onError(t('Файл пуст или превышает допустимый размер.'));
    } finally{preparation.current=undefined;if(generation===epoch.current){setPreparing(false);focusInput();}}
  }
  function removeDraft(id:string){setMedia(previous=>{const item=previous.find(i=>i.id===id);if(item){disposeDraft(item);uploaded.current.delete(item.file);}return previous.filter(i=>i.id!==id);});focusInput();}
  function renameDraft(id:string,name:string){setMedia(previous=>previous.map(item=>{if(item.id!==id)return item;const renamed=new File([item.file],name,{type:item.file.type,lastModified:item.file.lastModified}),cached=uploaded.current.get(item.file);if(cached){uploaded.current.delete(item.file);uploaded.current.set(renamed,{...cached,name});}return{...item,file:renamed};}));}
  async function send(voice?:VoiceDraft){
    const file=voice?.file||media[0]?.file;const selected=voice?[]:media;
    const trimmed=trimMessage(voice?'':text,voice?[]:mentions),value=trimmed.text;if(sendingRef.current||preparing||(!value&&!file)||new TextEncoder().encode(value).length>4096)return;
    sendTimes.current=sendTimes.current.filter(time=>Date.now()-time<1000);if(sendTimes.current.length>=3){setSendError(t('Слишком много сообщений. Подождите секунду.'));return;}
    sendingRef.current=true;setSending(true);setSendError('');const generation=epoch.current,origin=composerTextOrigin(composer.current);
    const latestReply=reply&&quote(reply.id,{id:reply.id,author:profileFor(state,reply.authorProfileId)?.nickname||t('Участник'),text:reply.content.text});
    const content:Message['content']={...trimmed,...(reply?{reply:{id:reply.id,author:latestReply?.source?latestReply.author:profileFor(state,reply.authorProfileId)?.nickname||t('Участник'),text:latestReply?.source?latestReply.source.content.text:reply.content.text}}:{})};
    flightCleanup.current?.();
    arrival.current=origin;
    const variants = state.capabilities?.includes(mediaVariantsCapability);
    const pendingPreview = file && imageMime(file.type) ? selected[0]?.poster ?? (!variants ? file : undefined) : undefined;
    showOutgoing({message:{id:-1,channelId,authorProfileId:state.self.profileId,requestId:crypto.randomUUID().replaceAll('-',''),sentAt:Date.now(),content},preview:pendingPreview?URL.createObjectURL(pendingPreview):undefined,confirmed:false});follow.current=true;setAway(false);pendingPosition.current={bottom:true};
    try{
      const gif=!file&&!voice&&/^https:\/\/\S+$/.test(value)?await membership<{url:string;mime?:'image/gif'|'video/mp4'|'video/webm'}|null>('gif.resolve',{url:value}).catch(()=>null):null;
      const attachments:import('./membership').ChatAttachment[]=[];
      const views = allocateMediaViews(selected);
      async function uploadImage(blob: Blob) {
        return membership<{id:string;mime:string}>('upload',
          {serverId,channelId,mime:blob.type,bytes:new Uint8Array(await blob.arrayBuffer())});
      }
      for(const [index, item] of (voice?[{file:voice.file} as MediaDraft]:selected).entries()){
        const file=item.file;let attachment=uploaded.current.get(file);
        if(!attachment){const image=imageMime(file.type),mime=image?file.type:['image/gif','video/mp4','video/webm','audio/webm','audio/ogg'].includes(file.type)?file.type:'application/octet-stream';
          const remote=await membership<{id:string;mime:string}>(image?'upload':'upload.file',{serverId,channelId,mime,bytes:new Uint8Array(await file.arrayBuffer())});
          attachment={...remote,name:file.name,size:file.size};
          if(item.duration!==undefined)attachment.duration=item.duration;
          if(voice)attachment.voice={duration:voice.duration,waveform:voice.waveform};
          uploaded.current.set(file,attachment);
        }
        if (item.poster && variants && !videoMime(file.type) && !attachment.preview) {
          const { id } = await uploadImage(item.poster);
          attachment.preview = { id, mime: 'image/webp', size: item.poster.size };
        }
        if (item.poster && !attachment.preview && file.type.startsWith('video/') &&
            state.capabilities?.includes('media-gallery-v1') && !attachment.poster) {
          attachment.poster = await uploadImage(item.poster);
        }
        const view = views[index];
        if (variants && attachment.preview && view && !attachment.view) {
          const { id } = await uploadImage(view);
          attachment.view = { id, mime: 'image/webp', size: view.size };
        }
        const { preview, view: playback, poster, ...original } = attachment;
        attachments.push({ ...original, ...(variants && preview ? { preview, ...(view && playback && { view: playback }) } : { poster }) });
      }
      if(generation!==epoch.current)return;
      const body:Message['content']={...content,...(gif?.url?{gif:{source:value,url:gif.url,...(gif.mime?{mime:gif.mime}:{})}}:{})};
      if(attachments.length>1)body.files=attachments;
      else if(attachments[0]){
        const { id, mime, name, size, preview, view } = attachments[0];
        if (imageMime(mime)) body.image = { id, mime, name, ...(variants && { size, preview, view }) };
        else body.file = attachments[0];
      }
      const signature=JSON.stringify(body);
      if(pendingSend.current?.signature!==signature)pendingSend.current={signature,id:crypto.randomUUID().replaceAll('-','')};
      showOutgoing({...outgoingRef.current!,message:{...outgoingRef.current!.message,content:body,requestId:pendingSend.current.id}});
      let result:{id:number};
      try{result=await membership<{id:number}>('send',{serverId,channelId,content:body,requestId:pendingSend.current.id});}
      catch(error){if(!outgoingRef.current?.confirmed)throw error;result={id:outgoingRef.current.message.id};}
      if(generation!==epoch.current)return;showOutgoing({...outgoingRef.current!,message:{...outgoingRef.current!.message,id:result.id},confirmed:true});pendingSend.current=undefined;uploaded.current.clear();sendTimes.current.push(Date.now());setHasSent(true);if(!voice){setMentions([]);setText('');setReply(undefined);media.forEach(disposeDraft);setMedia([]);}setRecordingVoice(false);follow.current=true;setAway(false);if(result?.id){markRead(result.id);}if(!current.current.state.eventsLive||hasNewer)await load('latest');if(generation===epoch.current)clearConfirmedOutgoing();
    }catch(error){if(generation===epoch.current){flightCleanup.current?.();outgoingRef.current=undefined;setOutgoing(undefined);setSendError((error as Error).message);}}
    finally{sendingRef.current=false;if(generation===epoch.current){setSending(false);clearConfirmedOutgoing();requestAnimationFrame(()=>{if(generation===epoch.current&&!sendingRef.current)focusInput();});}}
  }
  async function mutate(message:Message,value?:string){
    if(mutationRef.current)return;const content={...message.content,...trimMessage(value??'',editMentions)};if(value!==undefined&&removeImage)delete content.image;if(value!==undefined&&content.gif?.source!==content.text)delete content.gif;if(value!==undefined&&new TextEncoder().encode(content.text).length>4096)return;if(value!==undefined&&!content.text&&!content.image&&!content.file&&!content.files?.length)value=undefined;
    if(value!==undefined&&content.text===message.content.text&&!removeImage&&JSON.stringify(content.mentions)===JSON.stringify(message.content.mentions||[])){cancelEdit();return;}
    mutationRef.current=true;setMutating(true);setMutationError('');const generation=epoch.current;
    try{
      if(value===undefined)await membership('message.delete',{serverId,messageId:message.id});
      else await membership('send',{serverId,channelId,content,original:message});
      if(generation!==epoch.current)return;
      if(value===undefined){deletedMessages.current.add(message.id);if(deletedMessages.current.size>1000)deletedMessages.current.delete(deletedMessages.current.values().next().value!);}
      pendingPosition.current=follow.current?{bottom:true}:{anchor:anchor()};rows.current=history.current.update(value===undefined?[]:[{...message,content,editedAt:Date.now()}],value===undefined?[message.id]:[]);
      if(value===undefined&&message.id===Math.max(boundsRef.current.last,reportedLast)){
        const last=rows.current.at(-1)?.id||0;setBounds(previous=>({...previous,last}));
        if(follow.current)setAway(false);
      }
      setMessages(rows.current);setEditing(undefined);setDeleting(undefined);await load('sync');
    }catch(error){if(generation===epoch.current)setMutationError((error as Error).message);}
    finally{mutationRef.current=false;if(generation===epoch.current){setMutating(false);focusInput();}}
  }
  function requestDelete(message:Message,skip=false){if(message.locked||message.systemKind)return;setMenu(undefined);setMutationError('');if(skip)void mutate(message);else setDeleting(message);}
  const tooLong=new TextEncoder().encode(trimMessage(text).text).length>4096;
  const displayed=outgoing&&!messages.some(m=>m.requestId===outgoing.message.requestId&&effectiveProfile(state,m.authorProfileId)===state.self.effectiveProfileId)?[...messages,outgoing.message]:messages;
  return <section className="member-chat room-chat" aria-label={channel.name} onDragOver={event=>{if(event.dataTransfer.types.includes(memberDragType)){event.preventDefault();event.dataTransfer.dropEffect='copy';}}} onDrop={event=>{const raw=event.dataTransfer.getData(memberDragType);if(!raw)return;event.preventDefault();if(sendingRef.current)return;const field=composer.current,next=dropMemberMention(raw,state,text,mentions,field?.selectionStart??text.length,field?.selectionEnd??text.length);if(!next)return;setText(next.text);setMentions(next.mentions);requestAnimationFrame(()=>{field?.focus();field?.setSelectionRange(next.caret,next.caret);});}}>
    <div className="chat-feed"><div ref={pane} className="member-history chat-stream" tabIndex={0} role="log" aria-label={t('Сообщения чата')} aria-live="polite" aria-busy={loading} onLoadCapture={()=>{const list=pane.current;if(list){if(follow.current)list.scrollTop=list.scrollHeight;else restoreAnchor(lastAnchor.current);lastScroll.current=list.scrollTop;remember();}}} onScroll={()=>{
      const list=pane.current!;list.classList.add('is-scrolling');clearTimeout(scrollTimer.current);scrollTimer.current=setTimeout(()=>list.classList.remove('is-scrolling'),800);const delta=list.scrollTop-lastScroll.current;lastScroll.current=list.scrollTop;if(!delta||resizeAnchor.current&&(resizeAnchor.current.width!==list.clientWidth||resizeAnchor.current.height!==list.clientHeight))return;follow.current=list.scrollHeight-list.scrollTop-list.clientHeight<12&&(!hasNewer||follow.current);setAway(!follow.current);remember();current.current.onViewport?.(follow.current);if(delta<0&&list.scrollTop<100&&hasOlder)void navigate('older');else if(delta>0&&list.scrollHeight-list.scrollTop-list.clientHeight<100&&hasNewer)void navigate('newer');
    }}><div ref={content}>
      <div ref={olderEdge} className="chat-history-edge" aria-hidden="true"/>
      {!ready&&<p className="chat-empty" role="status">{t('Загрузка истории…')}</p>}
      {ready && !displayed.length && <ChatEmptyState onCompose={!recordingVoice && !sending ? () => {
        setShowPreview(false);
        requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
      } : undefined}/>}
      {displayed.map((message,index)=>{
        const local=message===outgoing?.message,pending=local&&!outgoing!.confirmed,author=profileFor(state,message.authorProfileId),system=message.systemKind==='poll-result',own=!system&&effectiveProfile(state,message.authorProfileId)===state.self.effectiveProfileId,previous=index?displayed[index-1]:predecessor.current,isEditing=editing?.id===message.id;
        const firstUnread=!local&&!own&&!hasSent&&(entryUnread.current!==undefined?message.id===entryUnread.current:message.id>entryRead.current&&(!previous||previous.id<=entryRead.current)),continuation=!isEditing&&!firstUnread&&!message.content.reply&&!message.content.poll&&!previous?.content.poll&&previous&&effectiveProfile(state,previous.authorProfileId)===effectiveProfile(state,message.authorProfileId)&&message.sentAt>=previous.sentAt&&message.sentAt-previous.sentAt<=300000&&new Date(message.sentAt).toDateString()===new Date(previous.sentAt).toDateString();
        const reference=message.content.reply&&quote(message.content.reply.id,message.content.reply);
        return <article className={`member-message chat-message${pending?' chat-message-pending':''}${message.content.mentions?.some(m=>effectiveProfile(state,m.profileId)===state.self.effectiveProfileId)?' chat-message-mentioned':''}${continuation?' chat-message-continuation':''}`} key={message.id} aria-busy={pending||undefined}>
          {firstUnread&&<div className="chat-divider">{t('Новые сообщения')}</div>}
          <div className={`chat-message-row${isEditing?' chat-message-editing':''}`} data-message-row={pending?undefined:message.id} onContextMenu={event=>{if(local||isEditing||message.unreadable)return;event.preventDefault();setMenu({message,x:event.clientX,y:event.clientY});}}>
            {system?<span className="chat-system-avatar" aria-hidden="true"><Icon name="paw" size={22}/></span>:continuation?<span className="chat-continuation-time"><MessageTime sent={message.sentAt} compact/></span>:<Avatar className="chat-avatar" name={author?.nickname||t('Участник')} image={author?.avatar}/>}
            <div className="member-message-content chat-message-body">
              {!continuation&&<div className="member-message-heading chat-meta"><strong>{system?t('Система'):author?.nickname||t('Участник')}</strong><MessageTime sent={message.sentAt}/></div>}
              {reference&&<button type="button" className="member-reply chat-reply-quote" onClick={()=>{if(reference.source===null)setNotice(t('Исходное сообщение уже недоступно.'));else void jump(message.content.reply!.id);}}><Icon name="reply" size={13}/><strong>{reference.author}</strong><span className="chat-reply-text"><MessageText text={reference.text.slice(0,240)} preview/></span></button>}
              {message.content.checklist?<ChecklistCard message={message} state={state} onEdit={()=>setChecklistDialog(message)}/>:message.content.poll?<PollCard message={message} state={state} onJump={id=>void jump(id)} onClosed={()=>{if(!message.locked){rows.current=history.current.update([{...message,locked:true}]);setMessages(rows.current);}}}/>:isEditing?<form className="chat-inline-edit" aria-label={t('Редактировать сообщение')} onSubmit={event=>{event.preventDefault();void mutate(message,editText);}}><MentionTextarea state={state} mentions={editMentions} onValue={(value,mentions)=>{setEditText(value);setEditMentions(mentions);}} ref={editInput} rows={1} value={editText} maxLength={4096} readOnly={mutating} aria-label={t('Сообщение')} onEscape={cancelEdit} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancelEdit();}else if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.nativeEvent.keyCode!==229){event.preventDefault();if(!event.repeat)void mutate(message,editText);}}}/>{removeImage&&<small className="chat-edit-removed">{t('Вложение будет удалено')}</small>}<div className="chat-edit-hint"><span>{t('Esc для')}</span> <button type="button" disabled={mutating} onClick={cancelEdit}>{t('отмены')}</button><span> · {t('Enter чтобы')}</span> <button type="submit" disabled={mutating}>{t('сохранить')}</button></div>{mutationError&&<p role="alert" className="text-error">{mutationError}</p>}</form>:<div className="member-message-text" style={flightActive&&(local||own&&message.requestId===outgoing?.message.requestId)?{visibility:'hidden'}:undefined}>{message.unreadable?<em>{t('Не удалось расшифровать сообщение.')}</em>:<MessageText text={message.content.text} mentions={message.content.mentions} gif={message.content.gif}/>}{!!message.editedAt&&<small className="chat-edited">{t('изменено')}</small>}</div>}
              <div className="chat-message-attachments" data-multiple={(message.content.files?.length||0)>1}>
              {(message.content.files|| (message.content.file?[message.content.file]:[])).map(f=>hasGalleryPreview(f)?<VideoMessage key={f.id} serverId={serverId} channelId={channelId} pending={local} files={[f]} group={(message.content.files||[f]).filter(hasGalleryPreview)} author={author?.nickname||t('Участник')} avatar={author?.avatar} date={message.sentAt}/>:<ChatFile key={f.id} serverId={serverId} channelId={channelId} pending={local} file={f}/>)}
              </div>
              {local&&outgoing?.preview?<img className="member-chat-image chat-pending-image" src={outgoing.preview} alt={t('Изображение')}/>:message.content.image&&!(isEditing&&removeImage)&&<EncryptedImage serverId={serverId} channelId={channelId} image={message.content.image} credits={{author:author?.nickname,avatar:author?.avatar,date:message.sentAt}} onRemove={isEditing?()=>setRemoveImage(true):undefined} removing={mutating}/>}
            </div>
            {!local&&!system&&!message.unreadable&&!isEditing&&<div className="member-message-actions"><button type="button" className="icon-button" title={t('Ответить')} aria-label={t('Ответить')} onClick={()=>beginReply(message)}><Icon name="reply" size={16}/></button>{own&&!message.locked&&<>{!message.content.poll&&!message.content.checklist&&<button type="button" className="icon-button" title={t('Редактировать')} aria-label={t('Редактировать')} onClick={()=>beginEdit(message)}><Icon name="edit" size={16}/></button>}<button type="button" className="icon-button" title={t('Удалить сообщение')} aria-label={t('Удалить сообщение')} onClick={event=>requestDelete(message,event.shiftKey)}><Icon name="trash" size={16}/></button></>}</div>}
          </div><div className="chat-read-end" data-read-id={local?undefined:message.id}/>
        </article>;
      })}
      <div ref={newerEdge} className="chat-history-edge" aria-hidden="true"/>
    </div></div>{ready&&loading&&<span className="chat-history-loading" role="status">{t('Загрузка истории…')}</span>}{(away||hasNewer&&!follow.current)&&<button className="member-load chat-jump" title={t('К новым сообщениям')} aria-label={newCount?t('Новых сообщений: {0}',newCount):t('К новым сообщениям')} onClick={()=>{void navigate('latest');focusInput();}}><Icon name="arrow-down" size={20}/>{newCount>0&&<b className="chat-jump-count">{newCount}</b>}</button>}</div>
    <ChatFileDrop channelName={channel.name} enabled={!sending && !preparing && !recordingVoice} onFiles={files => void selectFile(...files)}/>
    {failure&&<p className="member-chat-error text-error" role="alert">{failure}<button onClick={()=>void load('sync')}>{t('Повторить')}</button></p>}
    {sendError&&<p className="text-error" role="alert">{sendError}</p>}
    {tooLong&&<p className="text-error" role="status">{t('Сообщение слишком длинное.')}</p>}
    {notice&&<p className="chat-inline-notice" role="status">{notice}<button type="button" aria-label={t('Закрыть сообщение')} onClick={()=>setNotice('')}>×</button></p>}
    <form className="member-composer chat-composer" onSubmit={event=>{event.preventDefault();void send();}} onPaste={event=>{const next=[...event.clipboardData.files];if(next.length){event.preventDefault();void selectFile(...next);}}}>
      {reply&&<div className="member-compose-context chat-reply-draft"><Icon name="reply" size={16}/><div><strong>{t('Ответ {0}',quote(reply.id,{id:reply.id,author:profileFor(state,reply.authorProfileId)?.nickname||t('Участник'),text:reply.content.text}).author)}</strong><span className="chat-reply-text"><MessageText text={quote(reply.id,{id:reply.id,author:'',text:reply.content.text}).text.slice(0,240)} preview/></span></div><button type="button" className="icon-button" aria-label={t('Отменить ответ')} disabled={sending} onClick={()=>{setReply(undefined);focusInput();}}>×</button></div>}
      {!!media.length&&<AttachmentDrafts items={media} busy={sending} onRemove={removeDraft} onRename={renameDraft}/>}
      {preparing&&<span role="status" className="attachment-preparing">{t('Подготовка вложений…')}</span>}
      <div className="chat-compose">{recordingVoice?<VoiceComposer busy={sending} onCancel={()=>setRecordingVoice(false)} onSend={value=>void send(value)}/>:<><input ref={picker} type="file" multiple hidden onChange={event=>{void selectFile(...(event.target.files||[]));event.target.value='';}}/>
        <div className="chat-attachment-control" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setAttachmentMenu(false);}}><button className="chat-attach" type="button" disabled={sending||preparing} title={t('Вложения')} aria-label={t('Прикрепить изображение')} aria-haspopup="menu" aria-expanded={attachmentMenu} onClick={()=>setAttachmentMenu(value=>!value)}><Icon name="plus" size={22}/></button>{attachmentMenu&&<div className="chat-attachment-menu" role="menu" aria-label={t('Вложения')}><button type="button" role="menuitem" autoFocus onClick={()=>{setAttachmentMenu(false);picker.current?.click();}}><Icon name="image" size={18}/>{t('Отправить файл')}</button><button type="button" role="menuitem" onClick={()=>{setAttachmentMenu(false);setRecordingVoice(true);}}><Icon name="mic" size={18}/>{t('Записать голосовое')}</button>{state.capabilities?.includes('checklists-v1')&&<button type="button" role="menuitem" onClick={()=>{setAttachmentMenu(false);setChecklistDialog(true);}}><Icon name="checklist" size={18}/>{t('Интерактивный список')}</button>}{state.capabilities?.includes('polls-v1')&&<button type="button" role="menuitem" onClick={()=>{setAttachmentMenu(false);setCreatingPoll(true);}}><Icon name="chat" size={18}/>{t('Создать опрос')}</button>}</div>}</div>
        <div className="chat-input-shell" data-preview={showPreview}><button type="button" className="chat-preview-toggle icon-button" title={t(showPreview?'Отключить предпросмотр':'Предпросмотр')} aria-label={t(showPreview?'Отключить предпросмотр':'Предпросмотр')} aria-pressed={showPreview} onClick={()=>setShowPreview(value=>!value)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><>{showPreview?<path d="M3 9c4 6 14 6 18 0M6 12l-2 3M12 14v3M18 12l2 3"/>:<><path d="M2 12s4-8 10-8 10 8 10 8-4 8-10 8S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>}</></svg></button>{showPreview&&<div className="chat-compose-preview member-message-text" tabIndex={0} role="region" aria-label={t('Предпросмотр')}><MessageText text={text} mentions={mentions}/></div>}<MentionTextarea state={state} mentions={mentions} onValue={(value,mentions)=>{setText(value);setMentions(mentions);}} ref={composer} value={text} maxLength={4096} rows={1} readOnly={sending||showPreview} aria-label={t('Сообщение')} placeholder={t('Написать в «{0}»',channel.name)} onEscape={()=>{if(reply)setReply(undefined);}} onKeyDown={event=>{if(event.key==='Escape'&&reply){event.preventDefault();setReply(undefined);return;}if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.nativeEvent.keyCode!==229){event.preventDefault();if(!event.repeat)void send();}}}/></div>
      </>}</div>
    </form>
    {menu&&createPortal(<div ref={menuRef} className="chat-message-menu" role="menu" style={{left:menu.x,top:menu.y}} onKeyDown={event=>{if(event.key==='Escape'||event.key==='Tab'){setMenu(undefined);focusInput();return;}if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}}}><button role="menuitem" onClick={()=>beginReply(menu.message)}><Icon name="reply" size={17}/>{t('Ответить')}</button>{!!menu.message.content.text&&<button role="menuitem" onClick={()=>{void membership('copy',{text:menu.message.content.text}).catch(error=>onError(error.message));setMenu(undefined);}}><Icon name="copy" size={17}/>{t('Скопировать текст')}</button>}{!menu.message.systemKind&&!menu.message.locked&&effectiveProfile(state,menu.message.authorProfileId)===state.self.effectiveProfileId&&<>{!menu.message.content.poll&&!menu.message.content.checklist&&<button role="menuitem" onClick={()=>beginEdit(menu.message)}><Icon name="edit" size={17}/>{t('Редактировать')}</button>}<div role="separator" className="chat-menu-separator"/><button role="menuitem" className="chat-menu-delete" onClick={event=>requestDelete(menu.message,event.shiftKey)}><Icon name="trash" size={17}/>{t('Удалить сообщение')}</button></>}</div>,document.body)}
    {checklistDialog&&<ChecklistDialog serverId={serverId} channelId={channelId} message={checklistDialog===true?undefined:checklistDialog} onClose={()=>setChecklistDialog(undefined)} onPosted={()=>{follow.current=true;void load('latest');}}/>}
    {creatingPoll&&<PollDialog serverId={serverId} channelId={channelId} onClose={()=>{setCreatingPoll(false);focusInput();}} onPosted={async()=>{setHasSent(true);follow.current=true;await load('latest');}}/>}
    {deleting&&<Modal title={t('Удалить сообщение')} className="chat-delete-modal" onClose={()=>{if(!mutating)setDeleting(undefined);}}><p className="chat-delete-question">{t('Вы действительно хотите удалить это сообщение?')}</p><div className="chat-delete-preview"><Avatar name={profileFor(state,deleting.authorProfileId)?.nickname||t('Участник')} image={profileFor(state,deleting.authorProfileId)?.avatar} className="chat-avatar"/><div className="chat-message-body"><div className="chat-meta"><strong>{profileFor(state,deleting.authorProfileId)?.nickname||t('Участник')}</strong><MessageTime sent={deleting.sentAt}/></div><MessageText text={deleting.content.text}/>{deleting.content.image&&<div className="chat-delete-attachment"><Icon name="image" size={16}/>{t('Изображение')}</div>}</div></div><p className="chat-delete-tip"><strong>{t('Подсказка:')}</strong><br/>{t('Чтобы полностью обойти это подтверждение, удерживайте Shift при нажатии на «Удалить сообщение».')}</p>{mutationError&&<p role="alert" className="text-error">{mutationError}</p>}<div className="modal-actions"><button type="button" disabled={mutating} onClick={()=>{setDeleting(undefined);focusInput();}}>{t('Отмена')}</button><button type="button" className="danger-button" disabled={mutating} onClick={()=>void mutate(deleting)}>{t('Удалить')}</button></div></Modal>}
  </section>;
}
