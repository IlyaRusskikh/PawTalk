import { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { t, useLanguage } from './i18n';

export function MessageTime({ sent }: { sent: number }) {
  const language = useLanguage();
  const locale = language === 'en' ? 'en-US' : 'ru-RU';
  const id = useId();
  const [position, setPosition] = useState<{ left: number; top: number; below: boolean }>();
  const yesterday = new Date();
  const today = yesterday.toDateString();
  yesterday.setDate(yesterday.getDate() - 1);
  const day = new Date(sent).toDateString();
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(sent);
  const label = day === today ? time : day === yesterday.toDateString() ? t("вчера, в {0}", time)
    : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(sent);
  const open = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const below = rect.top < 72;
    setPosition({ left: Math.max(115, Math.min(window.innerWidth - 115, rect.left + rect.width / 2)), top: below ? rect.bottom + 6 : rect.top - 6, below });
  };
  return <time dateTime={new Date(sent).toISOString()} tabIndex={0} aria-describedby={position ? id : undefined}
    onMouseEnter={event => open(event.currentTarget)} onMouseLeave={() => setPosition(undefined)}
    onFocus={event => open(event.currentTarget)} onBlur={() => setPosition(undefined)}
    onKeyDown={event => { if (event.key === 'Escape') setPosition(undefined); }}>
    {label}
    {position && createPortal(<span id={id} className={`chat-date-tip${position.below ? ' below' : ''}`} style={{ left: position.left, top: position.top }} role="tooltip">
      {new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(sent)}<br/>{time}
    </span>, document.body)}
  </time>;
}
