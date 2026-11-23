import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Controls';
import { t } from './i18n';
import { membership, type ComposerActivity } from './membership';
import { useProtectedProfileAppearances } from './useProtectedProfileAppearances';

const refreshInterval = 4000;
const typingPause = 3500;
const expiresAfter = 7500;
type ActiveComposer = Exclude<ComposerActivity, 'idle'>;

function createPublisher(serverId: string, channelId: string) {
  let current: ComposerActivity = 'idle';
  let sentAt = -Infinity;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: ComposerActivity | undefined;
  let sending = false;
  async function flush() {
    sending = true;
    while (pending !== undefined) {
      const activity = pending;
      pending = undefined;
      await membership('chat.protected.composer', { serverId, channelId, activity }).catch(() => {});
    }
    sending = false;
  }
  function send(activity: ComposerActivity) {
    if (activity === current && (activity === 'idle' || performance.now() - sentAt < refreshInterval)) return;
    current = activity;
    sentAt = performance.now();
    pending = activity;
    if (!sending) void flush();
  }
  function stop() {
    clearTimeout(idleTimer);
    send('idle');
  }
  return {
    stop,
    type() {
      send('typing');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(stop, typingPause);
    },
    record() {
      clearTimeout(idleTimer);
      send('recording');
    },
  };
}

export function useChatComposerActivity(serverId: string, channelId: string, enabled: boolean, recording: boolean) {
  const publisher = useMemo(() => createPublisher(serverId, channelId), [serverId, channelId]);
  useEffect(() => {
    if (!enabled) return;
    return publisher.stop;
  }, [enabled, publisher]);
  useEffect(() => {
    if (!enabled || !recording) return;
    publisher.record();
    const timer = setInterval(publisher.record, refreshInterval + 100);
    return () => { clearInterval(timer); publisher.stop(); };
  }, [enabled, publisher, recording]);
  return publisher;
}

export function ChatComposerActivity({ serverId, channelId, ownProfileId, names }: {
  serverId: string; channelId: string; ownProfileId: string; names?: ReadonlyMap<string, { name: string }>;
}) {
  const [active, setActive] = useState<ReadonlyMap<string, ActiveComposer>>(new Map());
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    function remove(profileId: string) {
      clearTimeout(timers.get(profileId));
      timers.delete(profileId);
      setActive(previous => {
        if (!previous.has(profileId)) return previous;
        const next = new Map(previous);
        next.delete(profileId);
        return next;
      });
    }
    function clear() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    }
    const unsubscribe = window.desktop?.onMembershipProtectedEvent?.(event => {
      if (event.serverId !== serverId) return;
      if (event.type === 'resync' || event.type === 'status' && !event.live) {
        clear();
        setActive(new Map());
      }
      if (event.type !== 'composer' || event.channelId !== channelId || event.profileId === ownProfileId) return;
      const { profileId, activity } = event;
      if (activity === 'idle') { remove(profileId); return; }
      if (!timers.has(profileId) && timers.size >= 64) return;
      clearTimeout(timers.get(profileId));
      timers.set(profileId, setTimeout(() => remove(profileId), expiresAfter));
      setActive(previous => previous.get(profileId) === activity ? previous : new Map(previous).set(profileId, activity));
    });
    return () => { clear(); unsubscribe?.(); };
  }, [serverId, channelId, ownProfileId]);
  const unresolved = [...active.keys()].filter(profileId => !names?.get(profileId)?.name);
  const profiles = useProtectedProfileAppearances(serverId, channelId, unresolved);
  if (!active.size) return null;
  const typing = [...active].filter(([, activity]) => activity === 'typing');
  const recording = [...active].filter(([, activity]) => activity === 'recording');
  const name = (profileId: string) => names?.get(profileId)?.name || profiles?.get(profileId)?.name || t('Участник');
  return <div className="chat-composer-activity">
    {!!typing.length && <div className="chat-typing">
      <span className="chat-typing-paws" aria-hidden="true"><Icon name="paw" size={12}/><Icon name="paw" size={12}/><Icon name="paw" size={12}/></span>
      <span className="chat-activity-label">{typing.length === 1 ? t('{0} печатает…', name(typing[0][0])) : t('Несколько участников печатают…')}</span>
    </div>}
    {!!recording.length && <div className="chat-typing">
      <span className="chat-recording-cats" aria-hidden="true">
        {['smile', 'open', 'closed'].map(mouth => <svg key={mouth} viewBox="0 0 24 24" width="15" height="15"
          fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 13V4l5 4a12 12 0 0 1 8 0l5-4v9c0 4.3-4 7-9 7s-9-2.7-9-7Z"/>
          <path d="M8 12h.01m8 0h.01"/>
          {mouth === 'open' ? <ellipse cx="12" cy="15.5" rx="1.7" ry="2" fill="currentColor" stroke="none"/> :
            <path d={mouth === 'smile' ? 'M10 15q2 2 4 0' : 'M10.5 15.5h3'}/>}
        </svg>)}
      </span>
      <span className="chat-activity-label">{recording.length === 1 ? t('{0} записывает голосовое сообщение…', name(recording[0][0])) :
        t('Несколько участников записывают голосовые сообщения…')}</span>
    </div>}
  </div>;
}
