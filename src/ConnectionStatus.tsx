import { t, useLanguage } from './i18n';
import { useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Controls';
import { pingLevel } from '../shared/ping.mjs';
export function ConnectionStatus({ state, label, delay, loss, compact = false }: { compact?: boolean; state: string; label: string; delay?: number; loss?: number }) {
  const language = useLanguage();
  const [open, setOpen] = useState(false);
  const connected = state === 'connected';
  const visible = connected && open;
  const anchor = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, bottom: 80 });
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) setPosition({ left: Math.max(12, Math.min(rect.left + rect.width / 2 - 110, window.innerWidth - 232)), bottom: window.innerHeight - rect.top + 8 });
    };
    place(); window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [visible]);
  return <div ref={anchor} className={`connection-status-wrap ${compact ? 'compact' : ''}`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>
    <button type="button" className={`connection-mini ${connected ? `online ping-${pingLevel(delay)}` : ''}`} title={label} aria-label={connected ? t("Качество соединения") : label} aria-describedby={visible ? 'connection-tooltip' : undefined} onClick={() => setOpen(true)}>
      <Icon name="signal"/>{!compact && <span>{label}{!connected && <small>{t("Подключитесь к своему серверу")}</small>}</span>}
    </button>
    {visible && <div className="connection-popover" style={{ position: 'fixed', left: position.left, right: 'auto', bottom: position.bottom, transform: 'none' }} role="tooltip" id="connection-tooltip"><strong>{t("Качество соединения")}</strong><dl><div><dt>{t("Задержка")}</dt><dd>{delay === undefined ? '—' : t("{0} мс", Math.round(delay))}</dd></div><div><dt>{t("Потеря пакетов")}</dt><dd>{loss === undefined ? '—' : `${new Intl.NumberFormat(language === 'en' ? 'en-US' : 'ru-RU', { maximumFractionDigits: 1 }).format(loss)} %`}</dd></div></dl></div>}
  </div>;
}
