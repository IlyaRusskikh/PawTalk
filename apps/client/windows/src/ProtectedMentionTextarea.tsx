import { useEffect, useEffectEvent, useId, useRef, useState, type RefObject } from 'react';
import { shiftMentions, type ProtectedMention, type ProtectedMentionTarget } from '../../../../shared/mentions.mjs';
import { roleMentionStyle } from './MessageText';
import { FormattingTextarea } from './FormattingTextarea';
import { membership } from './membership';
import { t } from './i18n';

type Member = { id: string; name?: string; roles: { id: string; name?: string }[] };
type Roster = { members: Member[]; revision: number; next?: string; roleColors?: Record<string, string>; mentions: { available: boolean; mass: boolean; roles: string[] } };
type Query = { start: number; end: number; text: string };
type Candidate = { target: ProtectedMentionTarget; label: string; detail: string; color?: string };

function candidatesFor(page: Roster, query: string) {
  const needle = query.normalize('NFC').toLowerCase();
  const matches = (label: string) => label.normalize('NFC').toLowerCase().startsWith(needle);
  const candidates: Candidate[] = [];
  if (page.mentions.mass) {
    for (const kind of ['everyone', 'online'] as const) {
      const detail = t(kind === 'everyone' ? 'Все участники' : 'Участники онлайн');
      if (matches(kind) || matches(detail)) candidates.push({ target: { kind }, detail, label: kind });
    }
  }
  const roles = new Set(page.mentions.roles);
  for (const member of page.members) {
    for (const role of member.roles) {
      if (!roles.delete(role.id)) continue;
      const label = role.name ?? role.id;
      if (matches(label) || matches(role.id)) candidates.push({ target: { kind: 'role', id: role.id }, label, detail: t('Роль'), color: Object.hasOwn(page.roleColors ?? {}, role.id) ? page.roleColors?.[role.id] : undefined });
    }
  }
  for (const { id, name } of page.members) {
    const label = name ?? t('Участник · {0}', id.slice(0, 8));
    if (matches(label) || matches(id)) candidates.push({ target: { kind: 'profile', id }, label, detail: id.slice(0, 8) });
  }
  return candidates.slice(0, 10);
}

export function ProtectedMentionTextarea({ serverId, channelId, input, value, mentions, disabled, canMention, placeholder, onValue }: {
  serverId: string; channelId: string; input: RefObject<HTMLTextAreaElement | null>; value: string; mentions: ProtectedMention[];
  disabled: boolean; canMention: boolean; placeholder: string; onValue(value: string, mentions: ProtectedMention[]): void;
}) {
  const [query, setQuery] = useState<Query>();
  const [index, setIndex] = useState(0);
  const [roster, setRoster] = useState<Roster>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const run = useRef(0);
  const running = useRef(false);
  const id = useId();
  const open = !!query && canMention && !disabled;
  const candidates = open && roster?.mentions.available ? candidatesFor(roster, query.text) : [];
  const show = open && (candidates.length > 0 || !!roster?.next || pending || !!error);

  async function load(previous?: Roster) {
    if (running.current) return;
    const ticket = ++run.current;
    running.current = true;
    setPending(true);
    setError('');
    try {
      const scope = { serverId, channelId };
      let page: Roster;
      try {
        page = await membership<Roster>('roster.protected.mentions', { ...scope,
          ...(previous && { after: previous.next, revision: previous.revision }) });
      } catch (failure) {
        if (!previous || (failure as { code?: string }).code !== 'PROTECTED_POLICY_CHANGED' || run.current !== ticket) throw failure;
        previous = undefined;
        setRoster(undefined);
        page = await membership<Roster>('roster.protected.mentions', scope);
      }
      if (run.current !== ticket) return;
      if (previous && page.mentions.available) {
        page = { ...page, members: [...previous.members, ...page.members], mentions: { ...page.mentions,
          roles: [...new Set([...previous.mentions.roles, ...page.mentions.roles])] } };
      }
      setRoster(current => !previous && current?.revision === page.revision && current.mentions.mass === page.mentions.mass &&
        current.mentions.available === page.mentions.available ? current : page);
    } catch (failure) {
      if (run.current !== ticket) return;
      setRoster(undefined);
      setError((failure as Error).message);
    } finally {
      if (run.current === ticket) {
        running.current = false;
        setPending(false);
      }
    }
  }

  const refreshRoster = useEffectEvent(() => void load());
  useEffect(() => {
    if (!open) {
      setRoster(undefined);
      setPending(false);
      setError('');
      return;
    }
    refreshRoster();
    const timer = setInterval(refreshRoster, 10_000);
    return () => { run.current++; running.current = false; clearInterval(timer); };
  }, [open, serverId, channelId]);

  function inspect(field: HTMLTextAreaElement, spans = mentions) {
    const caret = field.selectionStart;
    if (!canMention || field.selectionEnd !== caret || spans.some(span => caret >= span.start && caret <= span.end)) {
      setQuery(undefined);
      return;
    }
    const match = /(?:^|\s)@([^@\n]{0,64})$/.exec(field.value.slice(0, caret));
    setQuery(match ? { start: caret - match[1].length - 1, end: caret, text: match[1] } : undefined);
    setIndex(0);
  }

  function choose(candidate: Candidate) {
    if (!query || mentions.length >= 64) return;
    const label = `@${candidate.label.slice(0, 128).replace(/\p{Cs}$/u, '')}`;
    const end = query.start + label.length;
    const next = `${value.slice(0, query.start)}${label} ${value.slice(query.end)}`;
    if (next.length > 4096) return;
    onValue(next, [...shiftMentions(value, next, mentions), { ...candidate.target, start: query.start, end }]
      .sort((left, right) => left.start - right.start));
    setQuery(undefined);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(end + 1, end + 1);
    });
  }

  return <div className="mention-input protected-mention-input">
    <FormattingTextarea ref={input} aria-label={t('Сообщение')} placeholder={placeholder} maxLength={4096} rows={1} value={value}
      disabled={disabled} aria-autocomplete="list" aria-expanded={show} aria-controls={show ? id : undefined}
      aria-activedescendant={candidates.length ? `${id}-${index % candidates.length}` : undefined}
      onChange={event => {
        const next = event.target.value;
        const spans = shiftMentions(value, next, mentions);
        onValue(next, spans);
        inspect(event.target, spans);
      }} onClick={event => inspect(event.currentTarget)} onSelect={event => inspect(event.currentTarget)}
      onBlur={() => setQuery(undefined)} onKeyDown={event => {
        if (!open || event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          setQuery(undefined);
        } else if (candidates.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault();
          setIndex(index => (index + candidates.length + (event.key === 'ArrowDown' ? 1 : -1)) % candidates.length);
        } else if (candidates.length && (event.key === 'Enter' || event.key === 'Tab' && !event.shiftKey)) {
          event.preventDefault();
          choose(candidates[index % candidates.length]);
        }
      }}/>
    {show && <div className="mention-options">
      <div id={id} role="listbox" aria-label={t('Упомянуть участника')}>
        {candidates.map((candidate, i) => <button key={JSON.stringify(candidate.target)} id={`${id}-${i}`} type="button"
          role="option" aria-selected={i === index % candidates.length} onMouseDown={event => event.preventDefault()}
          onClick={() => choose(candidate)}><span className={candidate.color ? 'chat-mention' : undefined} style={roleMentionStyle(candidate.color)}>@{candidate.label}</span><small>{candidate.detail}</small></button>)}
      </div>
      {roster?.next && <button type="button" disabled={pending} onMouseDown={event => event.preventDefault()}
        onClick={() => void load(roster)}>{t('Загрузить ещё')}</button>}
      {pending && <p role="status">{t('Загрузка…')}</p>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}
