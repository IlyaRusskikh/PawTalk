import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Controls';
import { t } from './i18n';
import { membership, protectedChannelOpenDelay } from './membership';
import type { Snapshot } from './session';

type TextScope = { serverId: string; profileId: string; channelId: string };
export type DeferredPolicy = { revision: number; head: string };
export type ProtectionStatus = { state: 'green' | 'yellow' | 'red' | 'grey'; reason: string; allowSend: boolean; deferredBasis?: DeferredPolicy };
const unknown: ProtectionStatus = { state: 'grey', reason: 'WINDOW_UNVERIFIED', allowSend: false };
const offline: ProtectionStatus = { state: 'grey', reason: 'OFFLINE', allowSend: false };
const maxObservationAge = 15_000;
const statusStates = { green: true, yellow: true, red: true, grey: true } as const;

export function useProtectedTextStatus(scope: TextScope | undefined, disconnected: boolean) {
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine);
  const [sample, setSample] = useState<{ key: string; status: ProtectionStatus }>();
  const { serverId, profileId, channelId } = scope ?? {};
  const key = scope ? `${serverId}:${profileId}:${channelId}` : '';
  const isOffline = disconnected || !networkOnline;
  useEffect(() => {
    const online = () => setNetworkOnline(true);
    const offline = () => setNetworkOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);
  useEffect(() => {
    if (isOffline || sample?.key !== key || sample.status.state === 'grey' || sample.status.state === 'red') return;
    const timer = window.setTimeout(() => {
      setSample(current => current === sample ? { key, status: unknown } : current);
    }, maxObservationAge);
    return () => window.clearTimeout(timer);
  }, [key, isOffline, sample]);
  useEffect(() => {
    if (!key) {
      setSample(undefined);
      return;
    }
    if (isOffline) {
      setSample(previous => previous?.key === key && previous.status.state === 'red' ? previous : { key, status: offline });
    }
    let active = true;
    let reading = false;
    let refreshAfterRead = false;
    let eventRefresh: number | undefined;
    async function refresh() {
      if (!active) return;
      if (reading) {
        refreshAfterRead = true;
        return;
      }
      reading = true;
      try {
        const result = await membership<ProtectionStatus>('protection.protected.read', { serverId, channelId, offline: isOffline });
        const valid = result && Object.hasOwn(statusStates, result.state) && typeof result.reason === 'string' &&
          typeof result.allowSend === 'boolean';
        const status = valid && (!isOffline || result.state === 'red') ? result : isOffline ? offline : unknown;
        if (active) setSample(previous => status.state === 'grey' &&
          previous?.key === key && previous.status.state === 'red'
          ? previous : { key, status });
      } catch (error) {
        if ((error as { code?: string }).code === 'RATE_LIMIT') return;
        if (active) setSample(previous => previous?.key === key && previous.status.state === 'red'
          ? previous : { key, status: isOffline ? offline : unknown });
      } finally {
        reading = false;
        if (refreshAfterRead) {
          refreshAfterRead = false;
          void refresh();
        }
      }
    }
    const initial = window.setTimeout(() => void refresh(), isOffline ? 0 : protectedChannelOpenDelay);
    const timer = isOffline ? undefined : window.setInterval(() => void refresh(), 10_000);
    const unsubscribe = isOffline ? undefined : window.desktop?.onMembershipProtectedEvent?.(event => {
      if (event.serverId !== serverId || (event.type !== 'state' && event.type !== 'resync') || eventRefresh !== undefined) return;
      eventRefresh = window.setTimeout(() => {
        eventRefresh = undefined;
        void refresh();
      }, 350);
    });
    if (!isOffline) window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.clearTimeout(eventRefresh);
      window.removeEventListener('focus', refresh);
      unsubscribe?.();
    };
  }, [key, serverId, channelId, isOffline]);

  if (!scope) return undefined;
  if (sample?.key === key && (!isOffline || sample.status.state === 'red')) return sample.status;
  return isOffline ? offline : unknown;
}

function statusLabel(state: ProtectionStatus['state']) {
  switch (state) {
    case 'green': return t('Защита подтверждена');
    case 'yellow': return t('Защита обновляется');
    case 'red': return t('Отправка приостановлена');
    case 'grey': return t('Защита ещё не проверена');
  }
}

function statusDetail({ reason, state, allowSend }: ProtectionStatus) {
  switch (reason) {
    case 'CURRENT_VERIFIED':
      return allowSend ? t('Устройство проверило актуальный ключ и разрешение отправки.')
        : t('Устройство проверило актуальный ключ. Канал доступен вам для чтения.');
    case 'CURRENT_GRACE':
    case 'PREVIOUS_GRACE': return t('Для канала ещё действует переходный период смены ключей.');
    case 'FRESH_KEY_PENDING':
    case 'CURRENT_KEY_PENDING': return t('Подготавливается актуальный ключ для этого канала.');
    case 'POLICY_PROOF_PENDING': return t('Клиент ожидает подтверждения правил доступа для проверки ключа канала.');
    case 'CUTOFF_EXPIRED': return t('Переходный период закончился. Для отправки нужен проверенный актуальный ключ. Черновик сохранён.');
    case 'OFFLINE': return t('Нет связи с сервером. Актуальное состояние защиты неизвестно.');
    default:
      return state === 'red' ? t('Проверка защиты не пройдена. Черновик сохранён.')
        : t('Проверяемое состояние защиты канала пока недоступно.');
  }
}

export function ProtectedTextStatus({ status = unknown }: { status?: ProtectionStatus }) {
  return <ProtectionStatusBadge kind="text" state={status.state} label={statusLabel(status.state)} detail={statusDetail(status)}/>;
}

type VoiceStatus = NonNullable<Snapshot['voiceProtection']>;

export function ProtectedVoiceStatus({ status }: { status?: VoiceStatus }) {
  const labels = {
    green: t('Защита голоса подтверждена'),
    yellow: t('Защита голоса обновляется'),
    red: t('Голос приостановлен'),
    grey: t('Защита голоса ещё не проверена'),
  };
  const details = {
    VOICE_VERIFIED: t('Устройство проверило актуальный медиаключ и защищённое голосовое подключение.'),
    VOICE_KEY_PENDING: t('Подготавливается проверенный медиаключ голосового канала.'),
    VOICE_SERVER_DEAFENED: t('Сервер приостановил передачу и приём голоса.'),
    VOICE_OFFLINE: t('Актуальное состояние защиты голоса пока неизвестно.'),
    VOICE_KEY_EXPIRED: t('Срок действия медиаключа истёк. Голос отключён.'),
    VOICE_KEY_INVALID: t('Проверка медиаключа не пройдена. Голос отключён.'),
    VOICE_ENCRYPTION_LOST: t('Подтверждение шифрования утрачено. Голос отключён.'),
  };
  const state = status?.state ?? 'grey';
  const label = status?.reason === 'VOICE_SERVER_DEAFENED' ? t('Звук отключён на сервере') : labels[state];
  return <ProtectionStatusBadge kind="voice" state={state} label={label} detail={details[status?.reason ?? 'VOICE_OFFLINE']}/>;
}

function ProtectionStatusBadge({ kind, state, label, detail }: {
  kind: 'text' | 'voice'; state: ProtectionStatus['state']; label: string; detail: string;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [open, setOpen] = useState(false);
  const visible = open || hover || focus;
  const close = () => { setOpen(false); setHover(false); setFocus(false); };
  useLayoutEffect(() => {
    if (!visible || !button.current || !card.current) return;
    const anchor = button.current.getBoundingClientRect();
    const sidebar = button.current.closest('.member-channels')?.getBoundingClientRect();
    const left = (sidebar?.left ?? anchor.left) + 10;
    const width = Math.min(270, (sidebar?.right ?? window.innerWidth) - left - 10);
    card.current.style.width = `${width}px`;
    card.current.style.left = `${left}px`;
    const height = card.current.offsetHeight;
    const top = anchor.bottom + height + 10 <= window.innerHeight ? anchor.bottom + 4 : anchor.top - height - 4;
    card.current.style.top = `${Math.max(8, top)}px`;
  }, [visible, detail]);
  useEffect(() => {
    if (!visible) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !button.current?.contains(event.target) && !card.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('focusin', outside);
    window.addEventListener('keydown', escape);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('focusin', outside);
      window.removeEventListener('keydown', escape);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [visible]);
  const scope = `protected-${kind}-status`;
  return <>
    <button ref={button} type="button"
      className={`protected-channel-status icon-button ${scope}-button ${scope}--${state}`}
      data-state={state} aria-label={label} aria-expanded={open}
      aria-controls={open ? id : undefined} aria-describedby={visible ? id : undefined}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
      onClick={() => open ? close() : setOpen(true)}>
      <Icon name={kind === 'voice' ? 'sound' : 'chat'} size={18}/>
    </button>
    {visible && createPortal(<div ref={card} className={`protected-status-badge-card ${scope}-card`} id={id} role={open ? 'group' : 'tooltip'}>
      <strong>{label}</strong><div>{detail}</div>
    </div>, document.body)}
  </>;
}
