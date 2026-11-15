import { AvatarStrip } from './ui/AvatarStrip';
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from './Avatar';
import { Icon } from './Controls';
import { t } from './i18n';
import { profileFor, type ServerRecord, type ServerState } from './membership';

export function ServerVoicePreview({server,state,anchor}:{server:ServerRecord;state?:ServerState;anchor:{right:number;top:number}}){
  const element=useRef<HTMLDivElement>(null);
  const channels=state?.channels.filter(channel=>channel.kind==='voice'&&state.voice.some(person=>person.channelId===channel.id))||[];
  useLayoutEffect(()=>{
    const box=element.current!.getBoundingClientRect();
    element.current!.style.top=`${Math.max(8,Math.min(anchor.top,innerHeight-box.height-8))}px`;
    element.current!.style.left=`${Math.max(8,Math.min(anchor.right+12,innerWidth-box.width-8))}px`;
  },[anchor,state,server.status]);
  return createPortal(<div ref={element} id="server-voice-preview" className="server-voice-preview" role="tooltip" style={{left:anchor.right+12,top:anchor.top}}>
    <strong className="server-preview-name">{server.name}</strong>
    {server.status!=='online'||!state?<p>{server.status==='locked'?t('Не удалось подтвердить подлинность сервера.'):t('Нет соединения с сервером.')}</p>:channels.length?channels.map(channel=><section key={channel.id}><div className="server-preview-channel"><Icon name="sound" size={15}/><strong>{channel.name}</strong></div><AvatarStrip className="server-preview-people" size={27} label={channel.name}>{state.voice.filter(person=>person.channelId===channel.id).map(person=>{const profile=profileFor(state,person.profileId),name=profile?.nickname||t('Участник');return <span key={person.deviceId} role="listitem" aria-label={name} title={name}><Avatar name={name} image={profile?.avatar}/></span>;})}</AvatarStrip></section>):<p>{t('В голосовых каналах никого нет.')}</p>}
  </div>,document.body);
}
