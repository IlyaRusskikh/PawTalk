import {useCallback, useEffect, useRef, useState} from 'react';
import {effectiveProfile, membership, profileFor, type Message, type ServerState} from './membership';
import {t} from './i18n';

interface PollState {
  id: string; messageId: number; closesAt: number; closedAt: number | null;
  multiple: boolean; anonymous: boolean; intermediate: boolean;
  counts: number[]; total: number; own: number[]; voters?: string[][];
}
export function PollCard({message, state, onJump}: {message: Message; state: ServerState; onJump(id: number): void}) {
  const poll = message.content.poll!;
  const [status, setStatus] = useState<PollState>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const inFlight = useRef(false), generation = useRef(0), sequence = useRef(0);
  const pending = useRef<{signature: string; id: string}|undefined>(undefined);
  const refresh = useCallback(async () => {
    const epoch = generation.current, request = ++sequence.current;
    const value = await membership<PollState>('poll.state', {serverId: state.serverId, pollId: poll.id});
    if (epoch !== generation.current || request !== sequence.current) return;
    if (value.id !== poll.id || !Number.isSafeInteger(value.messageId) || value.messageId < 1 || !Number.isSafeInteger(value.closesAt) || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.own) || value.own.some(i => !Number.isInteger(i) || i < 0 || i >= poll.options.length) || !Array.isArray(value.counts) || (value.counts.length !== 0 && value.counts.length !== poll.options.length) || value.counts.some(n => !Number.isSafeInteger(n) || n < 0)) throw Error(t('Опрос недоступен.'));
    if (value.multiple !== poll.multiple || value.anonymous !== poll.anonymous || value.intermediate !== poll.intermediate || (value.closedAt !== null && !Number.isSafeInteger(value.closedAt)) || (value.voters !== undefined && (!Array.isArray(value.voters) || value.voters.length !== poll.options.length || value.voters.some(voters => !Array.isArray(voters) || voters.length > 10000 || voters.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)))))) throw Error(t('Опрос недоступен.'));
    setStatus(value); setError('');
  }, [state.serverId, poll.id]);
  useEffect(() => {
    const epoch = ++generation.current;
    const load = () => void refresh().catch(error => {if (generation.current === epoch) setError(error.message);});
    load(); const timer = setInterval(load, 3500);
    return () => {generation.current++; clearInterval(timer);};
  }, [refresh]);
  const closed = status?.closedAt != null;
  const countsVisible = status && status.counts.length === poll.options.length;
  const author = effectiveProfile(state, message.authorProfileId) === state.self.effectiveProfileId;
  async function act(action: 'poll.vote' | 'poll.close', choices?: number[]) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    const signature = JSON.stringify({action, choices});
    if (pending.current?.signature !== signature) pending.current = {signature, id: crypto.randomUUID().replaceAll('-', '')};
    try {
      await membership(action, {serverId: state.serverId, pollId: poll.id, choices, requestId: pending.current!.id});
      pending.current = undefined; await refresh();
    } catch (error) {setError((error as Error).message);}
    finally {inFlight.current = false; setBusy(false);}
  }
  const maximum = status ? Math.max(0, ...status.counts) : 0;
  if (message.content.pollResult) return <div className="poll-result">
    <strong>{t('Опрос «{0}» завершен', message.content.text)}</strong>
    {status && countsVisible && <span>{status.total ? poll.options.filter((_, i) => status.counts[i] === maximum).join(' · ') : t('Нет голосов')}</span>}
    {status && <button type="button" onClick={() => onJump(status.messageId)}>{t('Просмотреть опрос')}</button>}
    {error && <p role="alert" className="text-error">{error}</p>}
  </div>;
  return <div className="poll-card" aria-label={t('Опрос')}>
    <strong className="poll-question">{message.content.text}</strong>
    <div className="poll-answers">{poll.options.map((option, index) => {
      const chosen = status?.own.includes(index), count = status?.counts[index] || 0;
      const percent = status?.total ? Math.round(count / status.total * 100) : 0;
      return <div className="poll-answer-row" key={index}><button type="button" className={`poll-answer ${chosen ? 'chosen' : ''} ${closed && maximum > 0 && count === maximum ? 'winner' : ''}`} disabled={!status || closed || busy} aria-pressed={!!chosen} onClick={() => {
        if (!status) return;
        const choices = status.multiple ? chosen ? status.own.filter(i => i !== index) : [...status.own, index] : chosen ? [] : [index];
        void act('poll.vote', choices);
      }}>
        {countsVisible && <span className="poll-progress" style={{width: `${percent}%`}}/>}
        <span className="poll-answer-label">{option}</span>
        {countsVisible && <span className="poll-count">{count} · {percent}%</span>}
        {chosen && <span aria-label={t('Ваш голос')}>✓</span>}
      </button>{!status?.anonymous && countsVisible && !!status?.voters?.[index]?.length && <details className="poll-voters"><summary>{t('Кто проголосовал')}</summary>{status.voters[index].map(id => <span key={id}>{profileFor(state, id)?.nickname || t('Участник')}</span>)}</details>}</div>;
    })}</div>
    <div className="poll-footer"><span>{status ? t('Участников: {0}', status.total) : t('Загрузка…')}</span><span>· {closed ? t('Опрос завершен') : status ? t('До {0}', new Date(status.closesAt).toLocaleString()) : ''}</span></div>
    {status?.anonymous && <small className="poll-hint">{t('Анонимное голосование')}</small>}
    {status && !closed && !countsVisible && <small className="poll-hint">{t('Результаты появятся после завершения опроса.')}</small>}
    {author && status && !closed && <button type="button" className="poll-close" disabled={busy} onClick={() => void act('poll.close')}>{t('Завершить опрос')}</button>}
    {error && <p role="alert" className="text-error">{error}</p>}
  </div>;
}
