import { AvatarStrip } from './ui/AvatarStrip';
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from './Avatar';
import { Icon } from './Controls';
import { t } from './i18n';
import { profileFor, type ProtectedServerState, type ServerRecord, type ServerState } from './membership';
import type { Person } from './session';

export function ServerVoicePreview({ server, state, protectedState, call, anchor }: {
  server: ServerRecord;
  state?: ServerState;
  protectedState?: ProtectedServerState;
  call?: { channelId: string; people: Person[] };
  anchor: { right: number; top: number };
}) {
  const element=useRef<HTMLDivElement>(null);
  const protectedChannel = protectedState?.channels.find(channel => channel.kind === 'voice' && channel.id === call?.channelId);
  const channels = state ? state.channels.flatMap(channel => {
    if (channel.kind !== 'voice') return [];
    const people = state.voice.filter(person => person.channelId === channel.id).map(person => {
      const profile = profileFor(state, person.profileId);
      return { id: person.deviceId, name: profile?.nickname ?? t('Участник'), avatar: profile?.avatar };
    });
    return people.length ? [{ id: channel.id, name: channel.name, people }] : [];
  }) : protectedChannel && call?.people.length
    ? [{ id: protectedChannel.id, name: protectedChannel.name ?? protectedChannel.id, people: call.people }] : [];
  useLayoutEffect(()=>{
    const box=element.current!.getBoundingClientRect();
    element.current!.style.top=`${Math.max(8,Math.min(anchor.top,innerHeight-box.height-8))}px`;
    element.current!.style.left=`${Math.max(8,Math.min(anchor.right+12,innerWidth-box.width-8))}px`;
  },[anchor,state,protectedState,call,server.status]);
  return createPortal(<div ref={element} id="server-voice-preview" className="server-voice-preview" role="tooltip" style={{left:anchor.right+12,top:anchor.top}}>
    <strong className="server-preview-name">{server.name}</strong>
    {server.status !== 'online' || (!state && !protectedState)
      ? <p>{server.status === 'locked' ? t('Не удалось подтвердить подлинность сервера.') : t('Нет соединения с сервером.')}</p>
      : channels.length ? channels.map(channel => <section key={channel.id}>
        <div className="server-preview-channel"><Icon name="sound" size={15}/><strong>{channel.name}</strong></div>
        <AvatarStrip className="server-preview-people" size={27} label={channel.name}>
          {channel.people.map(person => <span key={person.id} role="listitem" aria-label={person.name} title={person.name}>
            <Avatar name={person.name} image={person.avatar}/>
          </span>)}
        </AvatarStrip>
      </section>) : <p>{t(protectedState ? 'Нет данных об активных голосовых каналах.' : 'В голосовых каналах никого нет.')}</p>}
  </div>,document.body);
}
