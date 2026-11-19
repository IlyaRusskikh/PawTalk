import {notificationAvatar} from './notificationAvatar';
import {loadPeerAudio,savePeerAudio,projectPeerAudio} from './peerAudio.mjs';
import { HomeScreen } from './HomeScreen';
import {ServerAvatarDialog} from './ServerAvatarDialog';
import { AvatarStrip } from './ui/AvatarStrip';
import { useReorderDrag, setTransparentDragImage } from './ui/useReorderDrag';
import { AudioStatusIcons } from './ui/AudioStatusIcons';
import { Button } from './ui/Button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionStatus } from './ConnectionStatus';
import { Avatar } from './Avatar';
import { AudioQuickMenu } from './AudioQuickMenu';
import { Icon } from './Controls';
import { BansDialog, DevicesDialog, InvitationDialog, LinkDialog } from './MemberDialogs';
import { MemberSettings } from './MemberSettings';
import { Modal } from './Modal';
import { Participants } from './Participants';
import { RoomSplit } from './RoomSplit';
import { ServerChat } from './ServerChat';
import { ServerVoicePreview } from './ServerVoicePreview';
import { VoiceSession, type Snapshot } from './session';
import { loadSettings, remember, type Settings } from './settings';
import { playSound } from './sounds';
import { UpdateNotice } from './UpdateNotice';
import { HostPanel } from './HostPanel';
import { avatarStorageKey, validAvatar } from './avatarImage';
import { t, useLanguage } from './i18n';
import { channelMuteKey, isChannelMuted, notificationsMuted, cursorKey, effectiveProfile, isServerMuted, membership, profileFor, storedJSON, type Channel, type Message, type MessagePage, type ServerRecord, type ServerState } from './membership';
import './membership.css';

type MenuItem = { label: string; action(): void; danger?: boolean; disabled?: boolean };
function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose(): void }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous=document.activeElement;
    const menu = element.current!; const box = menu.getBoundingClientRect(); menu.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`; menu.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) onClose(); };
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', onClose);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', onClose); if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true}); };
  }, []);
  return <div ref={element} className="member-context" role="menu" style={{ left: x, top: y }} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') { onClose(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const buttons = Array.from(element.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')), index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }}>{items.map((item, index) => <button role="menuitem" className={item.danger ? 'text-error' : ''} key={index} disabled={item.disabled} onClick={() => { onClose(); item.action(); }}>{item.label}</button>)}</div>;
}
const emptyVoice: Snapshot = { state: 'disconnected', people: [], db: -100, speaking: false };
export function ServerApp() {
  useLanguage();
  const [servers, setServers] = useState<ServerRecord[]>([]), [states, setStates] = useState<Record<string, ServerState>>({}), [selected, setSelected] = useState(''), [chatIDs, setChatIDs] = useState<Record<string, string>>(()=>storedJSON('pawtalk.v2.channels',{}));
  const [homeAvatar,setHomeAvatar]=useState(()=>{const value=localStorage.getItem(avatarStorageKey)||'';return validAvatar(value)?value:undefined;});
  const [onboarding,setOnboarding]=useState(()=>localStorage.getItem('pawtalk.onboarding')==='pending'||(!localStorage.getItem('pawtalk.onboarding')&&!localStorage.getItem('pawtalk.nickname')));
  const onboardingActive=useRef(onboarding);onboardingActive.current=onboarding;
  useEffect(()=>{if(onboarding)localStorage.setItem('pawtalk.onboarding','pending');},[onboarding]);
  const [avatarServer,setAvatarServer]=useState<ServerState>();
  const [idle,setIdle]=useState(false);
  useEffect(()=>{let alive=true;const poll=()=>void membership<{away:boolean}>('activity').then(value=>{if(alive)setIdle(value.away);}).catch(()=>{});poll();const timer=setInterval(poll,5000);return()=>{alive=false;clearInterval(timer);};},[]);
  const [openLinkID,setOpenLinkID]=useState('');
  const [incomingLink,setIncomingLink]=useState<{linkId:string;serverId:string}>();
  useEffect(()=>{let alive=true,pending=false;async function poll(){if(pending)return;pending=true;try{const links=await membership<{linkId:string;serverId:string}[]>('link.pending');if(alive)setIncomingLink(links[0]);}catch{}finally{pending=false;}}void poll();const timer=setInterval(()=>void poll(),2000),off=window.desktop?.onMembershipServerEvent?.(event=>{if(event.type!=='chat')void poll();});return()=>{alive=false;clearInterval(timer);off?.();};},[]);
  const [departures,setDepartures]=useState<{serverId:string;name:string;kind:'kick'|'ban';expiresAt?:number|null}[]>([]);
  const [roster, setRoster] = useState(() => localStorage.getItem('pawtalk.v2.roster') !== 'hidden'), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<'join'|'invite'|'link'|'devices'|'bans'|'settings'|'create'|'host-share'|null>(onboarding?'settings':null), [address, setAddress] = useState(''), [linkText, setLinkText] = useState(''), [nickname, setNickname] = useState(() => localStorage.getItem('pawtalk.nickname') || t('Гость'));
  const [settings, setSettings] = useState(loadSettings), [snapshot, setSnapshot] = useState(emptyVoice), [voice, setVoice] = useState<{ serverId: string; channelId: string }>(), [audioState, setAudioState] = useState({muted:false,deafened:false});
  const {muted,deafened}=audioState;
  const toggleMic=useCallback(()=>setAudioState(value=>value.deafened?{muted:false,deafened:false}:{muted:!value.muted,deafened:false}),[]);
  const toggleSound=useCallback(()=>setAudioState(value=>value.deafened?{muted:false,deafened:false}:{muted:true,deafened:true}),[]);
  const [native, setNative] = useState(false), [keyError, setKeyError] = useState(''), [devices, setDevices] = useState<MediaDeviceInfo[]>([]), [hostRunning, setHostRunning] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>(), [muteServer, setMuteServer] = useState<string>(),[muteChannel,setMuteChannel]=useState<{serverId:string;channelId:string}>(), [leaveServer, setLeaveServer] = useState<ServerRecord>();
  const [addressServer, setAddressServer] = useState<ServerRecord>();
  const [renameServer,setRenameServer]=useState<{serverId:string;name:string}>(),[serverName,setServerName]=useState('');
  const [preview,setPreview]=useState<{serverId:string;anchor:{right:number;top:number}}>();
  const [sidebarWidth,setSidebarWidth]=useState(()=>{const value=Number(localStorage.getItem('pawtalk.v2.sidebar-width'));return Number.isFinite(value)&&value>=220&&value<=440?value:272;});
  const [windowWidth,setWindowWidth]=useState(innerWidth),resizeOffset=useRef(0);
  const maxSidebar=Math.max(220,Math.min(440,windowWidth-74-(roster&&selected?(windowWidth<=1000?190:232):0)-360-6));
  const sidebarPixels=Math.min(sidebarWidth,maxSidebar);
  useEffect(()=>{const resize=()=>{setWindowWidth(innerWidth);setPreview(undefined);};window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  useEffect(()=>{localStorage.setItem('pawtalk.v2.sidebar-width',String(sidebarWidth));},[sidebarWidth]);
  const [channelDialog, setChannelDialog] = useState<{ kind: 'text'|'voice'; channel?: Channel; deleting?: boolean }>(), [channelName, setChannelName] = useState('');
  const [moderation, setModeration] = useState<{ profileId: string; mode: 'role'|'kick'|'ban' }>(), [role, setRole] = useState('member'), [banDuration, setBanDuration] = useState('3600000');
  const [mentionIDs,setMentionIDs]=useState<Record<string,number[]>>({});
  const [unread, setUnread] = useState<Record<string, number>>({}), [focused, setFocused] = useState(true), [, updatePrefs] = useState(0), [peerAudio,setPeerAudio]=useState(()=>loadPeerAudio(localStorage));
  const contentFocused=focused&&!avatarServer&&!incomingLink&&!departures.length&&!modal&&!channelDialog&&!moderation&&!leaveServer&&!muteServer&&!muteChannel&&!addressServer&&!renameServer;
  const controller = useRef<VoiceSession | undefined>(undefined), current = useRef({ settings, states, selected, chatIDs, focused:contentFocused, deafened, voice }); current.current = { settings, states, selected, chatIDs, focused:contentFocused, deafened, voice };
  const mentionCache=useRef(new Map<string,Message[]>()),rescan=useRef(new Map<string,number>()),refreshAgain=useRef(false),soundAt=useRef(0);
  const seen = useRef(new Map<string, { revision: number; last: number; read?:number }>()), polling = useRef(false), mounted = useRef(true), joiningVoice = useRef(false);
  const voiceAttempt=useRef(0),pendingVoiceServer=useRef('');
  const periodicRefreshAt=useRef(0),notificationsRetry=useRef(false),deliveries=useRef(new Map<string,import('./membership').ServerEvent[]>()),knownUnread=useRef(new Map<string,number>()),deliveryGaps=useRef(new Map<string,number>());
  const viewports=useRef(new Map<string,boolean>());
  const notificationReads=useRef(new Map<string,number>());
  function acknowledgeNotifications(serverId:string,channelId:string,messageId:number){const key=serverId+':'+channelId;if(messageId<1||(notificationReads.current.get(key)||0)>=messageId)return;notificationReads.current.set(key,messageId);if(notificationReads.current.size>2048)notificationReads.current.delete(notificationReads.current.keys().next().value!);void membership('notify.read',{serverId,channelId,messageId}).catch(()=>{if(notificationReads.current.get(key)===messageId)notificationReads.current.delete(key);});}
  const hiddenVoice=useRef(new Map<string,string>());
  const [serverOrder,setServerOrder]=useState<string[]>(()=>storedJSON('pawtalk.v2.server-order',[]));
  const orderRef=useRef(serverOrder);orderRef.current=serverOrder;
  const reportedConnectionErrors=useRef(new Map<string,string>());
  const state = states[selected], record = servers.find(server => server.serverId === selected), chat = state?.channels.find(channel => channel.id === chatIDs[selected] && channel.kind === 'text') || state?.channels.find(channel => channel.kind === 'text');
  const own = state && profileFor(state, state.self.effectiveProfileId), active = snapshot.state !== 'disconnected', admin = state?.self.role === 'admin', canInvite = admin || state?.self.role === 'moderator';
  async function refreshDevices() { try { setDevices(await navigator.mediaDevices.enumerateDevices()); } catch { setError(t('Не удалось получить список аудиоустройств')); } }
  const refresh = useCallback(async () => {
    if (polling.current){refreshAgain.current=true;return;} polling.current = true;notificationsRetry.current=false;
    try {
      const records = await membership<ServerRecord[]>('servers'); const order=orderRef.current;records.sort((a,b)=>(order.includes(a.serverId)?order.indexOf(a.serverId):1e6)-(order.includes(b.serverId)?order.indexOf(b.serverId):1e6)); if (!mounted.current) return; setServers(records);
      setStates(previous=>Object.fromEntries(Object.entries(previous).filter(([id])=>records.some(record=>record.serverId===id))));
      if(current.current.selected&&!records.some(record=>record.serverId===current.current.selected))setSelected('');
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
        while (index < records.length && mounted.current) {
          const server = records[index++];
          try {
            const next = await membership<ServerState>('connect', { serverId: server.serverId }); if (!mounted.current) return;
            const hidden=hiddenVoice.current.get(next.serverId);if(hidden){if(!next.voice.some(person=>person.deviceId===hidden))hiddenVoice.current.delete(next.serverId);else next.voice=next.voice.filter(person=>person.deviceId!==hidden);}
            setStates(previous => ({ ...previous, [next.serverId]: next }));
            setServers(previous=>previous.map(record=>record.serverId===next.serverId?{...record,name:next.name}:record));
            reportedConnectionErrors.current.delete(server.serverId);
            const channelKeys=new Set(next.channels.map(channel=>`${next.serverId}:${channel.id}`));
            setUnread(values=>Object.fromEntries(Object.entries(values).filter(([key])=>!key.startsWith(next.serverId+':')||channelKeys.has(key))));
            for (const channel of next.channels.filter(channel => channel.kind === 'text')) {
              const key = `${next.serverId}:${channel.id}`, previous = seen.current.get(key);
              const read = Number(localStorage.getItem(cursorKey(next.serverId, channel.id))) || 0;
              acknowledgeNotifications(next.serverId,channel.id,read);
              if (channel.lastMessageId <= read) { seen.current.set(key,{revision:channel.messageRevision,last:channel.lastMessageId,read});setUnread(values => ({ ...values, [key]: 0 }));setMentionIDs(values=>({...values,[key]:[]}));mentionCache.current.delete(key);rescan.current.delete(key);knownUnread.current.set(key,0);deliveries.current.set(key,(deliveries.current.get(key)||[]).filter(e=>e.revision!>channel.messageRevision)); continue; }
              if (previous?.revision === channel.messageRevision&&previous.read===read){rescan.current.delete(key);deliveries.current.set(key,(deliveries.current.get(key)||[]).filter(e=>e.revision!>previous.revision));continue;}
              const requestedScan=rescan.current.get(key)||0,fullScan=!previous||requestedScan||(!next.eventsLive&&previous.revision!==channel.messageRevision&&previous.last>=channel.lastMessageId);
              const queued=(deliveries.current.get(key)||[]).filter(e=>e.revision!>(previous?.revision??-1)).sort((a,b)=>a.revision!-b.revision!);
              let revision=previous?.revision,fast=!!previous&&!requestedScan&&(previous.read===read||read>=previous.last);
              for(const packet of queued){if(packet.previous!==revision)fast=false;revision=packet.revision;}
              fast=fast&&queued.length>0&&revision===channel.messageRevision;
              // State can arrive before the first envelope. Give a healthy
              // payload stream the same bounded grace as reordered envelopes.
              if(!fast&&(queued.length||next.eventsLive&&next.capabilities?.includes('message-events-v1'))&&previous&&!fullScan&&(previous.read===read||read>=previous.last)){let deadline=deliveryGaps.current.get(key);if(!deadline){deadline=Date.now()+200;deliveryGaps.current.set(key,deadline);setTimeout(()=>{if(mounted.current&&deliveryGaps.current.get(key)===deadline)void refresh();},210);}if(Date.now()<deadline)continue;}if(fast)deliveryGaps.current.delete(key);
              let page:MessagePage,mentions:Message[],arrivals:Message[]=[],cursor=read,scanThrough=channel.lastMessageId;
              if(fast){
                let count=read>=previous!.last?0:knownUnread.current.get(key)||0;const byId=new Map((mentionCache.current.get(key)||[]).filter(m=>m.id>read).map(m=>[m.id,m]));
                const incoming=(m:{authorProfileId:string;systemKind?:string})=>!!m.systemKind||effectiveProfile(next,m.authorProfileId)!==next.self.effectiveProfileId,newRows=new Map<number,Message>(),removed=new Set<number>();
                for(const packet of queued){for(const m of packet.messages||[]){if(m.id>previous!.last){if(!newRows.has(m.id)&&m.id>read&&incoming(m))count++;newRows.set(m.id,m);removed.delete(m.id);}byId.delete(m.id);if(m.id>read&&incoming(m)&&m.content.mentions?.some(mention=>effectiveProfile(next,mention.profileId)===next.self.effectiveProfileId))byId.set(m.id,m);}for(const d of packet.deleted||[]){byId.delete(d.id);newRows.delete(d.id);if(!removed.has(d.id)&&d.id>read&&incoming(d))count--;removed.add(d.id);}}
                arrivals=[...newRows.values()];mentions=[...byId.values()];page={messages:[],first:queued.at(-1)!.first||0,last:queued.at(-1)!.last!,unread:Math.max(0,count),hasOlder:false,hasNewer:false};cursor=scanThrough=page.last;
              }else{
                page=await membership<MessagePage>('messages',{serverId:next.serverId,channelId:channel.id,options:{limit:1,readAfter:read}});
                mentions=fullScan?[]:(mentionCache.current.get(key)||[]).filter(m=>m.id>read);cursor=fullScan?read:Math.max(read,previous?.last||0);scanThrough=Math.max(channel.lastMessageId,page.last);
                while(cursor<scanThrough){const batch=await membership<MessagePage>('messages',{serverId:next.serverId,channelId:channel.id,options:{limit:500,...(cursor?{after:cursor}:{around:1})}});arrivals.push(...batch.messages);for(const message of batch.messages)if(message.id>read&&effectiveProfile(next,message.authorProfileId)!==next.self.effectiveProfileId&&message.content.mentions?.some(mention=>effectiveProfile(next,mention.profileId)===next.self.effectiveProfileId))mentions.push(message);const last=batch.messages.at(-1)?.id||cursor;if(last<=cursor||last>=scanThrough){cursor=last;break;}cursor=last;}
              }
              if(!mounted.current)return;knownUnread.current.set(key,page.unread);setUnread(values=>({...values,[key]:page.unread}));deliveries.current.set(key,(deliveries.current.get(key)||[]).filter(e=>e.revision!>channel.messageRevision));
              const value=current.current,visible=value.selected===next.serverId&&(value.chatIDs[next.serverId]||next.channels.find(channel=>channel.kind==='text')?.id)===channel.id&&value.focused&&viewports.current.get(key)!==false;
              if(!mounted.current)return;if(rescan.current.get(key)===requestedScan)rescan.current.delete(key);seen.current.set(key,{revision:channel.messageRevision,last:Math.max(scanThrough,cursor),read});mentionCache.current.set(key,mentions);setMentionIDs(values=>({...values,[key]:mentions.map(message=>message.id)}));
              const newMention=previous&&mentions.filter(message=>message.id>previous.last).at(-1);
              if (previous && channel.lastMessageId > previous.last && page.unread && !visible && (!notificationsMuted(next.serverId,channel.id)||newMention)) {
                const incoming=arrivals.filter(message=>message.id>previous.last&&(!!message.systemKind||effectiveProfile(next,message.authorProfileId)!==next.self.effectiveProfileId));
                if(!incoming.length)continue;
                const message=newMention||incoming.at(-1);
                const now=current.current,nowRead=Number(localStorage.getItem(cursorKey(next.serverId,channel.id)))||0;
                const visibleNow=now.selected===next.serverId&&(now.chatIDs[next.serverId]||next.channels.find(c=>c.kind==='text')?.id)===channel.id&&now.focused&&viewports.current.get(key)!==false;
                if(visibleNow||nowRead>=channel.lastMessageId)continue;
                if(message&&!now.deafened&&Date.now()-soundAt.current>750){soundAt.current=Date.now();void playSound('message',now.settings);}
                if(message)void membership('notify', { serverId: next.serverId, channelId: channel.id, channelName: channel.name,
                  authorName:message.systemKind?t('Система'):profileFor(next,message.authorProfileId)?.nickname||t('Участник'),
                  authorAvatar:message.systemKind?undefined:notificationAvatar(profileFor(next,message.authorProfileId)?.nickname||t('Участник'),profileFor(next,message.authorProfileId)?.avatar),
                  messageId:message.id,lastMessageId:incoming.reduce((last,m)=>Math.max(last,m.id),message.id),batchCount:incoming.length,mention:!!newMention,text:message.unreadable?t('Не удалось расшифровать сообщение.'):message.content.text||((message.content.file||message.content.files?.length)?t('Вложения'):''),hasImage:!!message.content.image });
              }
            }
          } catch (error) { if(['BANNED','NOT_A_MEMBER'].includes((error as {code:string}).code))continue;notificationsRetry.current=true;const message=(error as Error).message;if (current.current.selected === server.serverId && mounted.current&&reportedConnectionErrors.current.get(server.serverId)!==message){reportedConnectionErrors.current.set(server.serverId,message);setError(message);} }
        }
      }));
    } catch (error) { notificationsRetry.current=true;if (mounted.current) setError((error as Error).message); } finally { polling.current = false;if(refreshAgain.current&&mounted.current){refreshAgain.current=false;queueMicrotask(()=>void refresh());} }
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh(); const timer = setInterval(() => {const values=Object.values(current.current.states);if(values.length&&values.every(s=>s.eventsLive)&&!notificationsRetry.current&&Date.now()-periodicRefreshAt.current<30000)return;periodicRefreshAt.current=Date.now();void refresh();}, 3500);
    const serverEvent=window.desktop?.onMembershipServerEvent?.(event=>{if(event.delivery&&event.channelId){const key=event.serverId+':'+event.channelId;if([...deliveries.current.values()].reduce((n,v)=>n+v.length,0)>=64){deliveries.current.clear();for(const k of seen.current.keys())rescan.current.set(k,(rescan.current.get(k)||0)+1);}else deliveries.current.set(key,[...(deliveries.current.get(key)||[]),event]);void refresh();return;}if(event.rescan&&event.channelId)rescan.current.set(event.serverId+':'+event.channelId,(rescan.current.get(event.serverId+':'+event.channelId)||0)+1);if(event.type==='resync')for(const key of seen.current.keys())if(key.startsWith(event.serverId+':'))rescan.current.set(key,(rescan.current.get(key)||0)+1);void refresh();});
    const liveStatus=window.desktop?.onMembershipLiveStatus?.(event=>{setStates(values=>values[event.serverId]?{...values,[event.serverId]:{...values[event.serverId],eventsLive:event.live}}:values);if(!event.live)for(const key of seen.current.keys())if(key.startsWith(event.serverId+':'))rescan.current.set(key,(rescan.current.get(key)||0)+1);void refresh();});
    const changed = window.desktop?.onMembershipChanged?.(event => {if(event?.departure){setDepartures(values=>[...values,event.departure!]);setModal(null);setChannelDialog(undefined);setModeration(undefined);setLeaveServer(undefined);setMuteServer(undefined);setAddressServer(undefined);setRenameServer(undefined);setError('');}if(event?.leaveError==='LAST_ADMIN')setError(t('Сервер отклонил отложенный выход: сначала назначьте другого администратора. Сервер возвращён в список.'));void refresh();});
    const receive = (value: string) => { if (value) { setAddress(value); if(!onboardingActive.current)setModal('join'); } };
    const invitation = window.desktop?.onInvitation(receive); void window.desktop?.pendingInvitation().then(receive);
    const open = window.desktop?.onMembershipOpenChannel?.(value => { setSelected(value.serverId); setChatIDs(previous => ({ ...previous, [value.serverId]: value.channelId }));  });
    const focus = window.desktop?.onWindowActive?.(value=>{if(!value)current.current.focused=false;setFocused(value);}); void window.desktop?.windowActive?.().then(setFocused);
    return () => { mounted.current = false; clearInterval(timer); changed?.();serverEvent?.();liveStatus?.(); invitation?.(); open?.(); focus?.(); };
  }, [refresh]);
  useEffect(() => {
    const session = new VoiceSession(current.current.settings); controller.current = session;
    session.onUpdate = value=>{setSnapshot(value);if(value.state==='disconnected'&&current.current.voice&&!joiningVoice.current){setVoice(undefined);void membership('voiceLeave').catch(()=>{});}}; session.onError = setError; void refreshDevices();
    void window.desktop?.capabilities().then(value => setNative(value.native));
    const ptt = window.desktop?.onPtt(down => session.setPtt(down));
    const action = window.desktop?.onAction(value => { if (value === 'mute') toggleMic(); if (value === 'deafen') toggleSound(); if (value === 'force-mute') setAudioState(value=>({...value,muted:true})); });
    const lost = window.desktop?.onMembershipVoiceLost?.(event => {if(current.current.voice?.serverId!==event.serverId&&pendingVoiceServer.current!==event.serverId)return;++voiceAttempt.current; void session.disconnect(); setVoice(undefined); setError(t('Голосовое соединение завершено сервером.')); });
    const suspend = window.desktop?.onSuspend(() => {++voiceAttempt.current; void session.disconnect(); setVoice(undefined); setAudioState(value=>({...value,muted:true})); });
    const change = () => void refreshDevices(); navigator.mediaDevices?.addEventListener('devicechange', change);
    return () => { ptt?.(); action?.(); lost?.(); suspend?.(); navigator.mediaDevices?.removeEventListener('devicechange', change); void session.disconnect(); };
  }, []);
  useEffect(() => { remember(settings); controller.current?.updateSettings(settings); }, [settings]);
  const previousAudio = useRef({ muted, deafened });
  useEffect(() => {
    controller.current?.setMute(muted, deafened); const previous = previousAudio.current;
    if (previous.deafened !== deafened) void playSound(deafened ? 'deafen' : 'undeafen', current.current.settings);
    else if (previous.muted !== muted) void playSound(muted ? 'mute' : 'unmute', current.current.settings);
    previousAudio.current = { muted, deafened };
  }, [muted, deafened]);
  useEffect(() => { void window.desktop?.configureKeys({ ptt: settings.pttKey, mute: settings.muteKey, deafen: settings.deafenKey }).then(value => setKeyError(value.failed.length ? t('Комбинация занята или указана неверно: ') + value.failed.join(', ') : '')).catch(() => setKeyError(t('Не удалось настроить горячие клавиши'))); }, [settings.pttKey, settings.muteKey, settings.deafenKey]);
  useEffect(() => { localStorage.setItem('pawtalk.nickname', nickname); }, [nickname]);
  useEffect(() => { localStorage.setItem('pawtalk.v2.channels',JSON.stringify(chatIDs)); }, [chatIDs]);
  useEffect(() => { localStorage.setItem('pawtalk.v2.roster', roster ? 'visible' : 'hidden'); }, [roster]);
  useEffect(() => { void window.desktop?.setUpdateRooms?.(servers.map(server => ({ address: server.address, name: server.name }))); }, [servers]);
  async function perform(action: string, input: Record<string, unknown>, done?: () => void) {
    setBusy(true); setError(''); try { await membership(action, input); done?.(); await refresh(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  function joined(value: ServerState) { setStates(previous => ({ ...previous, [value.serverId]: value })); setSelected(value.serverId); setModal(null); setAddress(''); setLinkText(''); void refresh(); }
  async function join(address: string) {
    setBusy(true); setError(''); try { joined(await membership<ServerState>('join', { address, nickname })); } catch (error) { setError((error as Error).message); throw error; } finally { setBusy(false); }
  }
  async function disconnectVoice(cancel=true) {if(cancel)++voiceAttempt.current;const previous=current.current.voice;if(previous){const old=current.current.states[previous.serverId];if(old){hiddenVoice.current.set(previous.serverId,old.self.deviceId);setStates(values=>({...values,[old.serverId]:{...old,voice:old.voice.filter(person=>person.deviceId!==old.self.deviceId)}}));}}setVoice(undefined); await controller.current?.disconnect(); await membership('voiceLeave'); }
  async function joinVoice(channel: Channel) {
    if (!state || joiningVoice.current) return;
    joiningVoice.current = true; setBusy(true); setError('');
    const attempt=++voiceAttempt.current;pendingVoiceServer.current=state.serverId;
    try {
      if (settings.inputMode === 'ptt' && !native) throw Error(t('Для Push-to-Talk нужно собрать нативный модуль Windows.'));
      await disconnectVoice(false); const access = await membership<{ url: string; token: string; key: string }>('voice', { serverId: state.serverId, channelId: channel.id });
      if(attempt!==voiceAttempt.current)throw Object.assign(Error('cancelled'),{code:'CANCELLED'});
      const profile = profileFor(state, state.self.effectiveProfileId); controller.current?.setNickname(profile?.nickname || nickname); controller.current?.setAvatar(profile?.avatar);
      const known=current.current.states[state.serverId]||state;for(const [id,pref] of Object.entries(projectPeerAudio(peerAudio,state.serverId,known.voice,id=>effectiveProfile(known,id))))controller.current?.setPerson(id,pref.volume,pref.muted);
      await controller.current!.connect(access.url, access.token, { required: true, key: access.key });
      if(attempt!==voiceAttempt.current)throw Object.assign(Error('cancelled'),{code:'CANCELLED'});
      await membership('voiceConnected', { serverId: state.serverId, channelId: channel.id }); hiddenVoice.current.delete(state.serverId); setVoice({ serverId: state.serverId, channelId: channel.id });  await refresh();
    } catch (error) { await controller.current?.disconnect(); void membership('voiceLeave'); setVoice(undefined); if(attempt===voiceAttempt.current&&(error as {code?:string}).code!=='CANCELLED')setError((error as Error).message); } finally { joiningVoice.current = false;pendingVoiceServer.current=''; setBusy(false); }
  }
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(previous => ({ ...previous, [key]: value }));
  function context(event: React.MouseEvent, items: MenuItem[]) { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, items }); }
  function serverMenu(event: React.MouseEvent, server: ServerRecord) {
    const items:MenuItem[]=[{ label: isServerMuted(server.serverId) ? t('Включить уведомления') : t('Заглушить уведомления'), action() { if (isServerMuted(server.serverId)) { localStorage.removeItem(`pawtalk.v2.mute.${server.serverId}`); updatePrefs(value => value + 1); } else setMuteServer(server.serverId); } }];
    items.push({label:t('Изменить адрес сервера'),disabled:voice?.serverId===server.serverId,action(){setAddress(server.address);setAddressServer(server);setError('');}});
    if(states[server.serverId]?.self.role==='admin'&&states[server.serverId].capabilities?.includes('server-avatar-v1'))items.push({label:t('Аватар сервера'),action(){setAvatarServer(states[server.serverId]);}});
    if(states[server.serverId]?.self.role==='admin')items.push({label:t('Переименовать сервер'),action(){const name=states[server.serverId].name;setError('');setServerName(name);setRenameServer({serverId:server.serverId,name});}});
    if(states[server.serverId]?.self.role==='admin')items.push({label:t('Заблокированные участники'),action(){setSelected(server.serverId);setModal('bans');}});
    if(['admin','moderator'].includes(states[server.serverId]?.self.role||''))items.push({label:t('Пригласить участников'),action(){setSelected(server.serverId);setModal('invite');}});
    items.push({ label: t('Выйти с сервера'), danger: true, action: () => setLeaveServer(server) });context(event,items);
  }
  function channelMenu(event: React.MouseEvent, channel: Channel) {
    const items:MenuItem[]=[];if(channel.kind==='text')items.push({label:isChannelMuted(selected,channel.id)?t('Включить уведомления'):t('Заглушить уведомления'),action(){if(isChannelMuted(selected,channel.id)){localStorage.removeItem(channelMuteKey(selected,channel.id));updatePrefs(v=>v+1);}else setMuteChannel({serverId:selected,channelId:channel.id});}});if(admin)items.push({ label: t('Переименовать'), action: () => { setChannelName(channel.name); setChannelDialog({ kind: channel.kind, channel }); } }, { label: t('Удалить канал'), danger: true, disabled: channel.protected, action: () => setChannelDialog({ kind: channel.kind, channel, deleting: true }) });if(items.length)context(event,items);
  }
  function memberMenu(event: React.MouseEvent, profileId: string) {
    if (!state) return; const own = state.self.effectiveProfileId === profileId, member = state.members.find(member => member.profileId === profileId);
    const items: MenuItem[] = [{ label: t('Скопировать ID профиля'), action: () => void membership('copy', { text: profileId }) }];
    if (own) items.push({ label: t('Связать устройства'), action: () => { setLinkText(''); setModal('link'); } }, { label: t('Связанные устройства'), action: () => setModal('devices') });
    if (admin) items.push({ label: t('Изменить роль'), action: () => { setRole(member?.role || 'member'); setModeration({ profileId, mode: 'role' }); } }, { label: t('Исключить с сервера'), danger: true, disabled: member?.role === 'admin', action: () => setModeration({ profileId, mode: 'kick' }) }, { label: t('Заблокировать'), danger: true, disabled: member?.role === 'admin', action: () => setModeration({ profileId, mode: 'ban' }) });
    context(event, items);
  }
  async function reorderChannels(kind:'voice'|'text',ids:string[]){
    if(!state||!admin)return;
    const list=ids.map(id=>state.channels.find(channel=>channel.id===id&&channel.kind===kind)!);
    if(list.some(channel=>!channel))return;
    const before=state.channels;
    setStates(values=>({...values,[state.serverId]:{...state,channels:[...state.channels.filter(c=>c.kind!==kind),...list]}}));
    try{await membership('channel.order',{serverId:state.serverId,kind,items:list.map(c=>({id:c.id,revision:c.revision}))});await refresh();}
    catch(error){setStates(values=>({...values,[state.serverId]:{...state,channels:before}}));setError((error as Error).message);void refresh();}
  }
  const serverDrag=useReorderDrag(servers.map(server=>server.serverId),order=>{
    localStorage.setItem('pawtalk.v2.server-order',JSON.stringify(order));orderRef.current=order;setServerOrder(order);
    setServers(values=>[...values].sort((a,b)=>order.indexOf(a.serverId)-order.indexOf(b.serverId)));
  });
  const voiceDrag=useReorderDrag((state?.channels||[]).filter(c=>c.kind==='voice').map(c=>c.id),ids=>{void reorderChannels('voice',ids);});
  const textDrag=useReorderDrag((state?.channels||[]).filter(c=>c.kind==='text').map(c=>c.id),ids=>{void reorderChannels('text',ids);});
  const onlineVoice = voice && states[voice.serverId], voiceChannel = onlineVoice?.channels.find(channel => channel.id === voice?.channelId);
  const personPrefs=onlineVoice&&voice?projectPeerAudio(peerAudio,voice.serverId,onlineVoice.voice,id=>effectiveProfile(onlineVoice,id)):{};
  const audioBindings=JSON.stringify(personPrefs);
  useEffect(()=>{for(const [id,pref] of Object.entries(JSON.parse(audioBindings) as Record<string,{volume:number;muted:boolean}>))controller.current?.setPerson(id,pref.volume,pref.muted);},[audioBindings,voice?.serverId]);
  function changePersonAudio(id:string,volume:number,muted:boolean){const presence=onlineVoice?.voice.find(item=>item.identity===id);if(!presence||!voice||!onlineVoice)return;const next={...peerAudio,[voice.serverId+':'+effectiveProfile(onlineVoice,presence.profileId)]:{volume:Math.max(0,Math.min(2,volume)),muted}};try{savePeerAudio(localStorage,next);}catch{setError(t('Не удалось сохранить громкость участника.'));}setPeerAudio(next);controller.current?.setPerson(id,volume,muted);}
  const people = snapshot.people.map(person => { const presence = onlineVoice?.voice.find(item => item.identity === person.id), profile = presence && onlineVoice && profileFor(onlineVoice, presence.profileId); return profile ? { ...person, name: profile.nickname, avatar: profile.avatar } : person; });
  return <div className="server-app" onKeyDown={event=>{if(event.key==='Escape')setPreview(undefined);}}>
    <nav className="member-rail" aria-label={t('Серверы')}><button className={`member-orb member-home ${!selected ? 'selected' : ''}`} aria-label={t('Главная')} title={t('Главная')} onClick={() => setSelected('')}><Icon name="paw" size={28}/></button><div className="member-rail-line"/><div className="member-server-list" {...serverDrag.list}>{servers.map(server => {
      const count = Object.entries(unread).filter(([key]) => key.startsWith(server.serverId + ':')).reduce((total, [, value]) => total + value, 0);
      return <button draggable {...serverDrag.item(server.serverId)} onDragStart={event=>{serverDrag.start(event,server.serverId);setPreview(undefined);}} onDragEnd={serverDrag.end} className={`member-orb ${selected === server.serverId ? 'selected' : ''}`} key={server.serverId} aria-label={`${server.name}${isServerMuted(server.serverId)?` · ${t('Уведомления отключены')}`:''}`} aria-describedby={preview?.serverId===server.serverId?'server-voice-preview':undefined} onMouseEnter={event=>{if(serverDrag.suppressClick())return;const box=event.currentTarget.getBoundingClientRect();setPreview({serverId:server.serverId,anchor:{right:box.right,top:box.top}});}} onMouseLeave={()=>setPreview(undefined)} onFocus={event=>{const box=event.currentTarget.getBoundingClientRect();setPreview({serverId:server.serverId,anchor:{right:box.right,top:box.top}});}} onBlur={()=>setPreview(undefined)} onClick={() => {if(serverDrag.suppressClick())return;setPreview(undefined); setSelected(server.serverId);  setError(''); }} onContextMenu={event => serverMenu(event, server)}>{states[server.serverId]?.avatar?<img className="member-server-avatar" src={states[server.serverId].avatar} alt=""/>:server.name.slice(0, 2).toUpperCase()}<i className={`member-status ${server.status}`}/>{count > 0 && <b className={`member-unread-badge ${isServerMuted(server.serverId)?'notifications-muted':''} ${Object.entries(mentionIDs).some(([key,ids])=>key.startsWith(server.serverId+':')&&ids.length)?'has-mention':''}`}>{count > 99 ? '99+' : count}</b>}</button>;
    })}</div><button className="member-orb" aria-label={t('Присоединиться к серверу')} title={t('Присоединиться к серверу')} onClick={() => { setAddress(''); setModal('join'); }}><Icon name="plus"/></button><div className="member-rail-actions"><UpdateNotice blocked={onboarding||(!!modal&&modal!=='settings')||!!addressServer||!!renameServer||!!channelDialog||!!moderation||!!leaveServer||!!muteServer||busy} active={active} hosting={hostRunning}/><button className="icon-button member-rail-settings" aria-label={t('Настройки')} title={t('Настройки')} onClick={() => setModal('settings')}><Icon name="settings"/></button></div></nav>
    <aside id="server-channels" className="member-channels" style={{width:sidebarPixels}}><div className="member-server-title"><strong>{state?.name || record?.name || 'PawTalk'}</strong>{record && <button className="icon-button" aria-label={t('Меню сервера')} onClick={event => serverMenu(event, record)}><Icon name="more" size={18}/></button>}</div>
      <div className="member-channel-scroll">{selected ? !state ? <p className="member-empty" role="status">{t('Подключение…')}</p> : <>{(['voice', 'text'] as const).map(kind => <section className="member-channel-group" key={kind} {...(kind==='voice'?voiceDrag:textDrag).list}><div className="member-channel-caption"><h2>{kind === 'voice' ? t('Голосовые каналы') : t('Текстовые чаты')}</h2>{admin && <button className="icon-button" title={t('Создать канал')} aria-label={t('Создать канал')} onClick={() => { setChannelName(''); setChannelDialog({ kind }); }}><Icon name="plus" size={16}/></button>}</div>{state.channels.filter(channel => channel.kind === kind).map(channel => <div key={channel.id} {...(kind==='voice'?voiceDrag:textDrag).item(channel.id)}><button draggable={admin} onDragStart={event=>{if(!admin){event.preventDefault();return;}(kind==='voice'?voiceDrag:textDrag).start(event,channel.id);}} onDragEnd={(kind==='voice'?voiceDrag:textDrag).end} className={`member-channel ${(unread[`${selected}:${channel.id}`]||0)>0&&!notificationsMuted(selected,channel.id)?'has-unread':''} ${(kind === 'text' && chat?.id === channel.id) || (kind === 'voice' && voice?.serverId === selected && voice.channelId === channel.id) ? 'selected' : ''}`} disabled={busy && kind === 'voice'} onClick={() => { if((kind==='voice'?voiceDrag:textDrag).suppressClick())return; if (kind === 'voice') { if (!(voice?.serverId === selected && voice.channelId === channel.id)) void joinVoice(channel); } else { setChatIDs(previous => ({ ...previous, [selected]: channel.id }));  } }} onContextMenu={event => channelMenu(event, channel)}><Icon name={kind === 'voice' ? 'sound' : 'chat'} size={18}/><span>{channel.name}</span>{(unread[`${selected}:${channel.id}`] || 0) > 0 && <b className={`member-channel-count ${notificationsMuted(selected,channel.id)?'notifications-muted':''} ${mentionIDs[`${selected}:${channel.id}`]?.length?'has-mention':''}`}>{unread[`${selected}:${channel.id}`]}</b>}</button>{kind === 'voice' && <AvatarStrip className="member-channel-people" size={23}>{state.voice.filter(presence => presence.channelId === channel.id).map(presence => { const profile = profileFor(state, presence.profileId), person = voice?.serverId === selected && voice.channelId === channel.id ? snapshot.people.find(person => person.id === presence.identity) : undefined, speaking = person?.speaking && !person.muted; return <span title={profile?.nickname} aria-label={profile?.nickname||t('Участник')} className={`member-channel-person ${speaking ? 'speaking' : ''}`} key={presence.deviceId}><Avatar name={profile?.nickname || t('Участник')} image={profile?.avatar}/><AudioStatusIcons className="member-channel-audio-status" size={10} muted={person?.muted} deafened={person?.deafened} locallyMuted={!!person && personPrefs[person.id]?.muted}/></span>; })}</AvatarStrip>}</div>)}</section>)}</> : <div className="member-home-navigation"><button onClick={() => setModal('join')}><Icon name="invite"/>{t('Присоединиться')}</button><button onClick={() => setModal(hostRunning ? 'host-share' : 'create')}><Icon name="plus"/>{hostRunning ? t('Мой сервер') : t('Создать сервер')}</button></div>}</div>
      <div className="member-user-panel" onContextMenu={event => { if (state) memberMenu(event, state.self.effectiveProfileId); else context(event,[{label:t('Скопировать ID профиля'),action:()=>void membership<{profileId:string}>('identity').then(value=>membership('copy',{text:value.profileId})).catch(error=>setError(error.message))}]); }}><div className="member-user-identity"><button className="member-user-name" onClick={() => setModal('settings')}><span className="member-avatar-wrap"><Avatar name={own?.nickname || nickname} image={own?.avatar || (!state ? homeAvatar : undefined)}/><i className={`member-status ${selected&&record?.status!=='online'?'offline':idle?'away':'online'}`}/></span><span className="member-user-text"><strong>{own?.nickname || nickname}</strong><small>{selected ? record?.status === 'online' ? idle?t('Отошел'):t('В сети') : t('Нет соединения') : idle?t('Отошел'):t('В сети')}</small></span></button></div><div className="member-audio-buttons">{voice&&<ConnectionStatus name={onlineVoice?.name||nickname} delay={snapshot.rtt} loss={snapshot.packetLoss} diagnostics={snapshot.people.find(person=>person.local)?.diagnostics}/>}<AudioQuickMenu kind="input" settings={settings} update={update} devices={devices} onOpen={refreshDevices}><button className={`icon-button ${muted ? 'text-error' : ''}`} aria-label={muted ? t('Включить микрофон') : t('Выключить микрофон')} title={t('Микрофон')} aria-pressed={muted} onClick={() => toggleMic()}><Icon size={18} name={muted ? 'mic-off' : 'mic'}/></button></AudioQuickMenu><AudioQuickMenu kind="output" settings={settings} update={update} devices={devices} onOpen={refreshDevices}><button className={`icon-button ${deafened ? 'text-error' : ''}`} title={t('Звук')} aria-label={deafened ? t('Включить звук') : t('Выключить звук')} aria-pressed={deafened} onClick={() => toggleSound()}><Icon size={18} name={deafened ? 'headphones-off' : 'headphones'}/></button></AudioQuickMenu>{voice&&<button className="icon-button text-error member-voice-disconnect" title={t('Отключиться от голоса')} aria-label={t('Отключиться от голоса')} onClick={()=>void disconnectVoice().catch(error=>setError(error.message))}><Icon size={18} name="exit"/></button>}</div></div>
    </aside>
    <div className="member-sidebar-divider" role="separator" aria-orientation="vertical" aria-label={t('Ширина меню сервера')} aria-controls="server-channels" aria-valuemin={220} aria-valuemax={maxSidebar} aria-valuenow={sidebarPixels} tabIndex={0}
      onPointerDown={event=>{if(event.button!==0||!event.isPrimary)return;event.preventDefault();event.currentTarget.focus({preventScroll:true});event.currentTarget.setPointerCapture(event.pointerId);resizeOffset.current=event.clientX-event.currentTarget.getBoundingClientRect().left;}}
      onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId)){const left=event.currentTarget.parentElement!.getBoundingClientRect().left;setSidebarWidth(Math.max(220,Math.min(maxSidebar,event.clientX-left-74-resizeOffset.current)));}}}
      onKeyDown={event=>{const sizes:Record<string,number>={ArrowLeft:sidebarPixels-16,ArrowRight:sidebarPixels+16,Home:220,End:maxSidebar};if(sizes[event.key]!==undefined){event.preventDefault();setSidebarWidth(Math.max(220,Math.min(maxSidebar,sizes[event.key])));}}}
      onDoubleClick={()=>setSidebarWidth(272)}/>
    <main className="member-main">{selected && state ? <><div className="member-toolbar"><div className="member-toolbar-title"><Icon name={voice?.serverId===selected ? 'sound' : 'chat'}/><h1>{voice?.serverId === selected ? voiceChannel?.name : chat?.name}</h1></div><span className="member-e2ee" title={t('Сквозное шифрование включено')}>E2EE</span>{canInvite&&<button className="icon-button" title={t('Пригласить пользователя')} aria-label={t('Пригласить пользователя')} onClick={() => setModal('invite')}><Icon name="invite"/></button>}<button className={`icon-button ${roster ? 'selected' : ''}`} title={roster ? t('Скрыть список участников') : t('Показать список участников')} aria-label={roster ? t('Скрыть список участников') : t('Показать список участников')} aria-pressed={roster} onClick={() => setRoster(value => !value)}><Icon name="users"/></button></div><div className="member-workspace"><div className="member-content"><RoomSplit visible={!!(voice?.serverId === selected && active)} participants={<><Participants people={people} prefs={personPrefs} onChange={changePersonAudio}/><div className="member-call-controls call-controls"><AudioQuickMenu kind="input" settings={settings} update={update} devices={devices} onOpen={refreshDevices}><button className={`icon-button ${muted ? 'off text-error' : ''}`} aria-label={muted ? t('Включить микрофон') : t('Выключить микрофон')} title={t('Микрофон')} aria-pressed={muted} onClick={() => toggleMic()}><Icon size={18} name={muted ? 'mic-off' : 'mic'}/></button></AudioQuickMenu><AudioQuickMenu kind="output" settings={settings} update={update} devices={devices} onOpen={refreshDevices}><button className={`icon-button ${deafened ? 'off text-error' : ''}`} title={t('Звук')} aria-label={deafened ? t('Включить звук') : t('Выключить звук')} aria-pressed={deafened} onClick={() => toggleSound()}><Icon size={18} name={deafened ? 'headphones-off' : 'headphones'}/></button></AudioQuickMenu>{voice&&<button className="icon-button call-leave member-voice-disconnect" title={t('Отключиться от голоса')} aria-label={t('Отключиться от голоса')} onClick={()=>void disconnectVoice().catch(error=>setError(error.message))}><Icon size={18} name="exit"/></button>}</div></>} chat={chat ? <ServerChat key={`${selected}:${chat.id}`} state={state} channel={chat} focused={contentFocused} onViewport={latest=>viewports.current.set(`${selected}:${chat.id}`,latest)} onRead={last => {acknowledgeNotifications(selected,chat.id,last);setMentionIDs(values=>({...values,[`${selected}:${chat.id}`]:(values[`${selected}:${chat.id}`]||[]).filter(id=>id>last)}));if(last>=chat.lastMessageId)setUnread(previous => ({ ...previous, [`${selected}:${chat.id}`]: 0 }));}} onError={setError}/> : <p className="member-empty">{t('Чат недоступен.')}</p>}/></div>{roster && <aside className="member-roster" aria-label={t('Участники')}><h2>{t('Участники — {0}', state.members.length)}</h2>{[...state.members].sort((a, b) => Number(b.online) - Number(a.online)).map(member => { const profile = profileFor(state, member.profileId); return <button draggable onDragStart={event=>{event.dataTransfer.setData('application/x-pawtalk-member',JSON.stringify({serverId:state.serverId,profileId:member.profileId}));event.dataTransfer.effectAllowed='copy';setTransparentDragImage(event);}} className={`member-roster-person ${member.online ? '' : 'offline'}`} key={member.profileId} onContextMenu={event => memberMenu(event, member.profileId)} onClick={event => memberMenu(event, member.profileId)}><span className="member-avatar-wrap"><Avatar name={profile?.nickname || t('Участник')} image={profile?.avatar}/><i className={`member-status ${member.online ? member.away?'away':'online' : 'offline'}`}/></span><span className="member-roster-label"><span className="member-roster-nickname">{profile?.nickname || t('Участник')}</span>{effectiveProfile(state,member.profileId)===state.self.effectiveProfileId&&<small className="member-self-pin">{t('Вы')}</small>}</span>{member.role !== 'member' && <Icon name="shield" size={13}/>}</button>; })}</aside>}</div></> : selected ? <div className="member-welcome"><Icon name="paw" size={70}/><h1>{record?.name || t('Сервер')}</h1><p>{t('Ожидаем соединения с сервером…')}</p></div> : <HomeScreen hosting={hostRunning} disabled={busy} onJoin={() => setModal('join')} onHost={() => setModal(hostRunning ? 'host-share' : 'create')}/> }</main>
    {preview&&servers.find(server=>server.serverId===preview.serverId)&&<ServerVoicePreview server={servers.find(server=>server.serverId===preview.serverId)!} state={states[preview.serverId]} anchor={preview.anchor}/> }
    {error && <div className="member-error" role="alert"><span>{error}</span><button className="icon-button" aria-label={t('Закрыть')} onClick={() => setError('')}>×</button></div>}
    {menu && <ContextMenu {...menu} onClose={() => setMenu(undefined)}/>}
    {modal === 'settings' && <MemberSettings wizard={onboarding} settings={settings} setSettings={setSettings} state={onboarding?undefined:state} nickname={nickname} onNickname={setNickname} onClose={() => {if(onboarding){localStorage.setItem('pawtalk.onboarding','done');setOnboarding(false);setModal(address?'join':null);}else setModal(null);}} onRefresh={() => {const value=localStorage.getItem(avatarStorageKey)||'';setHomeAvatar(validAvatar(value)?value:undefined);void refresh();}} native={native} keyError={keyError} active={active} voiceMic={controller.current?.mic} voiceSnapshot={snapshot}/>}
    {modal === 'join' && <Modal className="member-join-modal" error={error} title={t('Присоединиться к серверу')} onClose={() => setModal(null)}><form onSubmit={event => { event.preventDefault(); try { if (new URL(address).hash.includes('link=')) { setLinkText(address); setModal('link'); } else void join(address).catch(() => {}); } catch { setError(t('Неверная ссылка приглашения.')); } }}><div className="form-fields member-join-row"><label>{t('Ссылка приглашения или строка привязки')}<input autoFocus required type="text" autoComplete="off" spellCheck={false} value={address} onChange={event => setAddress(event.target.value)}/></label><Button variant="primary" disabled={busy || !address.trim()}>{busy ? t('Подключение…') : t('Присоединиться')}</Button></div></form></Modal>}
    {!!departures.length&&<Modal title={departures[0].kind==='ban'?t('Доступ к серверу заблокирован.'):t('Вы исключены с сервера')} onClose={()=>setDepartures(values=>values.slice(1))}>
      <p>{departures[0].kind==='kick'?t('Вы исключены с сервера «{0}». Для возвращения понадобится действующее приглашение.',departures[0].name):departures[0].expiresAt===null?t('Вы получили бессрочный бан на сервере «{0}».',departures[0].name):departures[0].expiresAt?t('Вы получили бан на сервере «{0}» до {1}.',departures[0].name,new Date(departures[0].expiresAt).toLocaleString()):t('Доступ к серверу «{0}» заблокирован. Срок не указан сервером.',departures[0].name)}</p>
      <div className="modal-actions"><Button variant="primary" onClick={()=>setDepartures(values=>values.slice(1))}>{t('Понятно')}</Button></div>
    </Modal>}
    {modal === 'invite' && state && <InvitationDialog state={state} onClose={() => setModal(null)}/>}
    {modal === 'link' && <LinkDialog state={state} nickname={nickname} initialText={linkText} onID={setOpenLinkID} onClose={() => {setOpenLinkID(''); setModal(null); void refresh(); }} onJoined={joined}/>}
    {incomingLink&&(modal!=='link'||incomingLink.linkId!==openLinkID)&&<LinkDialog key={incomingLink.linkId} initialID={incomingLink.linkId} state={states[incomingLink.serverId]} nickname={nickname} onClose={()=>{setIncomingLink(undefined);void refresh();}} onJoined={joined}/>}
    {modal === 'devices' && state && <DevicesDialog state={state} onClose={() => setModal(null)} onRefresh={() => void refresh()}/>}
    {modal === 'bans' && state && <BansDialog state={state} onClose={() => setModal(null)}/>}
    {(muteServer||muteChannel) && <Modal title={t('Заглушить уведомления')} onClose={() => {setMuteServer(undefined);setMuteChannel(undefined);}}><div className="member-mute-options">{[[15, t('На 15 минут')], [60, t('На 1 час')], [180, t('На 3 часа')], [480, t('На 8 часов')], [1440, t('На 24 часа')], [0, t('До тех пор, пока не включу')]].map(([minutes, label]) => <button key={minutes} onClick={() => { localStorage.setItem(muteChannel?channelMuteKey(muteChannel.serverId,muteChannel.channelId):`pawtalk.v2.mute.${muteServer}`, String(minutes ? Date.now() + Number(minutes) * 60000 : Number.MAX_SAFE_INTEGER)); setMuteServer(undefined);setMuteChannel(undefined); updatePrefs(value => value + 1); }}>{label}</button>)}</div></Modal>}
    {leaveServer && <Modal error={error} title={leaveServer.ownedSelfhost?t('Остановить сервер и выйти?'):t('Выйти с сервера?')} onClose={() => setLeaveServer(undefined)}><p>{leaveServer.ownedSelfhost?t('Сервер «{0}» запущен этим клиентом. Выход остановит его и отключит всех участников.',leaveServer.name):t('Все связанные устройства покинут «{0}». История и связи сохранятся. Для возвращения понадобится приглашение.', leaveServer.name)}</p>{!leaveServer.ownedSelfhost&&leaveServer.status!=='online'&&<p className="host-hint">{t('Сервер исчезнет из списка сейчас. Клиент сохранит запрос и отправит выход, когда сервер станет доступен.')}</p>}<div className="modal-actions"><button disabled={busy} onClick={() => setLeaveServer(undefined)}>{t('Отмена')}</button><button disabled={busy} className="danger-button" onClick={() => { const id = leaveServer.serverId; if (voice?.serverId === id) void disconnectVoice(); void perform('leave', { serverId: id }, () => { setLeaveServer(undefined); if (selected === id) setSelected(''); }); }}>{leaveServer.ownedSelfhost?t('Остановить и выйти'):t('Выйти с сервера')}</button></div></Modal>}
    {channelDialog && state && <Modal error={error} title={channelDialog.deleting ? t('Удалить канал?') : channelDialog.channel ? t('Переименовать канал') : t('Создать канал')} onClose={() => setChannelDialog(undefined)}><form onSubmit={event => { event.preventDefault(); const channel = channelDialog.channel; void perform(channelDialog.deleting ? 'channel.delete' : channel ? 'channel.patch' : 'channel.create', { serverId: state.serverId, kind: channelDialog.kind, channelId: channel?.id, name: channelName, expectedRevision: channel?.revision, position:channel?.position }, () => setChannelDialog(undefined)); }}><div className="form-fields">{channelDialog.deleting ? <p>{channelDialog.kind === 'text' ? t('Чат «{0}» и вся его история будут удалены безвозвратно.', channelDialog.channel!.name) : t('Участники покинут голосовой канал и останутся на сервере.')}</p> : <label>{t('Название канала')}<input required autoFocus maxLength={128} value={channelName} onChange={event => setChannelName(event.target.value)}/></label>}</div><div className="modal-actions"><button type="button" onClick={() => setChannelDialog(undefined)}>{t('Отмена')}</button><button disabled={busy} className={channelDialog.deleting ? 'danger-button' : 'primary'}>{channelDialog.deleting ? t('Удалить') : t('Сохранить')}</button></div></form></Modal>}
    {moderation && state && <Modal error={error} title={moderation.mode === 'role' ? t('Изменить роль') : moderation.mode === 'ban' ? t('Заблокировать участника') : t('Исключить участника')} onClose={() => setModeration(undefined)}><p>{profileFor(state, moderation.profileId)?.nickname}</p><div className="form-fields">{moderation.mode === 'role' ? <label>{t('Роль')}<select value={role} onChange={event => setRole(event.target.value)}><option value="member">{t('Участник')}</option><option value="moderator">{t('Модератор')}</option><option value="admin">{t('Администратор')}</option></select></label> : moderation.mode === 'ban' ? <label>{t('Срок блокировки')}<select value={banDuration} onChange={event => setBanDuration(event.target.value)}><option value="3600000">{t('1 час')}</option><option value="86400000">{t('24 часа')}</option><option value="604800000">{t('7 дней')}</option><option value="0">{t('Навсегда')}</option></select></label> : <p>{t('Все связанные устройства будут исключены. Вход по действующему приглашению останется доступен.')}</p>}</div><div className="modal-actions"><button disabled={busy} onClick={() => setModeration(undefined)}>{t('Отмена')}</button><button disabled={busy} className="primary" onClick={() => void perform(moderation.mode === 'role' ? 'role.set' : moderation.mode === 'kick' ? 'member.kick' : 'member.ban', { serverId: state.serverId, profileId: moderation.profileId, role, expiresAt: Number(banDuration) ? Date.now() + Number(banDuration) : null }, () => setModeration(undefined))}>{t('Подтвердить')}</button></div></Modal>}
    <HostPanel nickname={nickname} active={busy} modal={modal === 'create' || modal === 'host-share' ? modal : null} onClose={() => setModal(null)} onCreated={() => { setHostRunning(true); void window.desktop?.hostStatus().then(async host => {if(host.serverId)joined(await membership<ServerState>('connect',{serverId:host.serverId}));}).catch(error=>setError(error.message)); }} onStatus={setHostRunning} onJoin={async input => { await join(input.address); }} onStop={async () => { const host=await window.desktop?.hostStatus();if (voice?.serverId===host?.serverId) await disconnectVoice(); }} onError={setError} onBusy={setBusy}/>
    {renameServer&&<Modal error={error} title={t('Переименовать сервер')} onClose={()=>setRenameServer(undefined)}><form onSubmit={event=>{event.preventDefault();void perform('server.rename',{serverId:renameServer.serverId,name:serverName.trim(),expectedName:renameServer.name},()=>setRenameServer(undefined));}}><div className="form-fields"><label>{t('Название сервера')}<input autoFocus required maxLength={64} value={serverName} onChange={event=>setServerName(event.target.value)}/></label></div><div className="modal-actions"><button type="button" disabled={busy} onClick={()=>setRenameServer(undefined)}>{t('Отмена')}</button><button className="primary" disabled={busy||!serverName.trim()||serverName.trim()===renameServer.name}>{t('Сохранить')}</button></div></form></Modal>}
    {avatarServer&&<ServerAvatarDialog state={avatarServer} onClose={()=>setAvatarServer(undefined)} onSaved={()=>void refresh()}/>}
    {addressServer && <Modal error={error} title={t('Изменить адрес сервера')} onClose={() => setAddressServer(undefined)}><form onSubmit={event => {event.preventDefault();void perform('server.address',{serverId:addressServer.serverId,address},()=>setAddressServer(undefined));}}><div className="form-fields"><label>{t('Адрес сервера')}<input autoFocus required value={address} onChange={event=>setAddress(event.target.value)}/></label><p>{t('Вставьте новый адрес или ссылку с отпечатком. Идентичность сервера и ваше членство должны сохраниться.')}</p></div><div className="modal-actions"><button type="button" disabled={busy} onClick={()=>setAddressServer(undefined)}>{t('Отмена')}</button><button className="primary" disabled={busy}>{t('Сохранить')}</button></div></form></Modal>}
  </div>;
}
