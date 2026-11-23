import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { t } from './i18n';
import { membership } from './membership';
import { AvatarStrip } from './ui/AvatarStrip';

export type ProtectedPollDefinition = {
  options: string[];
  multiple: boolean;
  anonymous: boolean;
  intermediate: boolean;
};

type PollState = {
  closesAt: number;
  closedAt: number | null;
  multiple: boolean;
  anonymous: boolean;
  intermediate: boolean;
  canVote: boolean;
  canClose: boolean;
  total: number;
  counts: number[];
  own: number[];
  voters?: { id: string; name?: string }[][];
};

export function ProtectedPoll({ serverId, channelId, position, title, poll, timedOut, profiles, ownProfileId, ownAvatar, onClosed }: {
  serverId: string; channelId: string; position: number; title: string; poll: ProtectedPollDefinition; timedOut?: boolean;
  profiles?: ReadonlyMap<string, { name: string; avatar?: string }>;
  ownProfileId: string;
  ownAvatar?: string;
  onClosed(position: number): void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const pending = useRef<{ signature: string; operationId: string } | undefined>(undefined);
  const inFlight = useRef(false);
  const [status, setStatus] = useState<PollState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { anonymous, intermediate, multiple, options } = poll;
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await membership<PollState>('chat.protected.poll', { serverId, channelId, position });
      if (request !== sequence.current) return;
      const showTally = intermediate || next.closedAt !== null;
      if (next.anonymous !== anonymous || next.multiple !== multiple || next.intermediate !== intermediate ||
          next.counts.length !== (showTally ? options.length : 0) || next.own.some(index => index >= options.length)) {
        throw Error(t('Опрос недоступен.'));
      }
      setStatus(next);
      setError('');
    } catch (failure) {
      if (request !== sequence.current) return;
      setStatus(undefined);
      setError((failure as Error).message);
    }
  }, [serverId, channelId, position, anonymous, intermediate, multiple, options.length]);

  const closed = status?.closedAt != null;
  useEffect(() => { if (closed) onClosed(position); }, [closed, onClosed, position]);
  useEffect(() => {
    const element = card.current;
    if (!element || closed && anonymous) return;
    let visible = false;
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) void refresh();
    });
    observer.observe(element);
    const timer = setInterval(() => { if (visible && !inFlight.current) void refresh(); }, 5000);
    return () => {
      sequence.current++;
      observer.disconnect();
      clearInterval(timer);
    };
  }, [anonymous, closed, refresh]);

  async function act(input: { vote: { operationId: string; choices: number[] } } | { close: true }) {
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await membership('chat.protected.poll', { serverId, channelId, position, ...input });
      pending.current = undefined;
      await refresh();
    } catch (failure) {
      await refresh();
      setError((failure as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function choose(index: number) {
    if (!status?.canVote || timedOut || inFlight.current) return;
    const selected = status.own.includes(index);
    const choices = (multiple ? selected ? status.own.filter(item => item !== index) : [...status.own, index] :
      selected ? [] : [index]).sort((a, b) => a - b);
    const signature = JSON.stringify(choices);
    if (pending.current?.signature !== signature) pending.current = { signature, operationId: crypto.randomUUID().replaceAll('-', '') };
    void act({ vote: { operationId: pending.current.operationId, choices } });
  }

  const countsVisible = status?.counts.length === options.length;
  const winner = closed && status ? Math.max(0, ...status.counts) : 0;
  return <div ref={card} className="poll-card" aria-label={t('Опрос')}>
    <strong className="poll-question">{title}</strong>
    <div className="poll-answers">{options.map((option, index) => {
      const chosen = status?.own.includes(index);
      const count = status?.counts[index] ?? 0;
      const percent = status?.total ? Math.round(count / status.total * 100) : 0;
      const voters = !anonymous && countsVisible ? status?.voters?.[index] : undefined;
      return <div className="poll-answer-row" key={index}>
        <button type="button" className={`poll-answer${chosen ? ' chosen' : ''}${winner > 0 && count === winner ? ' winner' : ''}`}
          disabled={!status?.canVote || timedOut || busy} aria-pressed={!!chosen} onClick={() => void choose(index)}>
          {countsVisible && <span className="poll-progress" style={{ width: `${percent}%` }}/>}
          <span className="poll-answer-label">{option}</span>
          {countsVisible && <span className="poll-count">{count} · {percent}%</span>}
          {chosen && <span aria-label={t('Ваш голос')}>✓</span>}
        </button>
        {!!voters?.length && <AvatarStrip className="poll-voters" size={24} expandable label={t('Кто проголосовал')}>
          {voters.map(voter => {
            const profile = profiles?.get(voter.id);
            const name = profile?.name ?? voter.name ?? t('Участник');
            const image = (voter.id === ownProfileId ? ownAvatar : undefined) ?? profile?.avatar;
            return <span key={voter.id} role="listitem" title={name} aria-label={name}><Avatar name={name} image={image}/></span>;
          })}
        </AvatarStrip>}
      </div>;
    })}</div>
    <div className="poll-footer">
      <span>{status ? t('Участников: {0}', status.total) : t('Загрузка…')}</span>
      {status && <span>· {closed ? t('Опрос завершен') : t('До {0}', new Date(status.closesAt).toLocaleString())}</span>}
    </div>
    {anonymous && <small className="poll-hint">{t('Анонимное голосование')}</small>}
    {status && !closed && !countsVisible && <small className="poll-hint">{t('Результаты появятся после завершения опроса.')}</small>}
    {status?.canClose && <button type="button" className="poll-close" disabled={busy}
      onClick={() => { if (!inFlight.current) void act({ close: true }); }}>{t('Завершить опрос')}</button>}
    {error && <p className="text-error" role="alert">{error}</p>}
  </div>;
}
