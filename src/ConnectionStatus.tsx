import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t, useLanguage } from './i18n';
import { Icon } from './Controls';
import { pingLevel } from '../shared/ping.mjs';

export function ConnectionStatus({ name, delay, loss }: { name: string; delay?: number; loss?: number }) {
  const language = useLanguage();
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number>(undefined);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  const hide = () => {
    window.clearTimeout(hoverTimer.current);
    setOpen(false);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      const panel = tooltip.current;
      if (!rect || !panel) return;
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      const top = rect.top >= height + 12 ? rect.top - height - 6 : rect.bottom + 6;
      panel.style.left = left + 'px';
      panel.style.top = Math.min(top, window.innerHeight - height - 8) + 'px';
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, language]);

  return <span className="person-network-wrap">
    <button ref={anchor} type="button" className={`icon-button person-network ping-${pingLevel(delay)}`}
      aria-label={t("Соединение {0}", name)} aria-describedby={open ? id : undefined}
      onMouseEnter={() => { hoverTimer.current = window.setTimeout(() => setOpen(true), 250); }} onMouseLeave={hide}
      onFocus={() => setOpen(true)} onBlur={hide} onClick={() => setOpen(true)}
      onKeyDown={event => { if (event.key === 'Escape') hide(); }}>
      <Icon name="signal" size={15}/>
    </button>
    {open && createPortal(<div ref={tooltip} className="connection-popover" role="tooltip" id={id}>
      <strong>{t("Соединение {0}", name)}</strong>
      <dl>
        <div><dt>{t("Пинг до сервера")}</dt><dd>{delay === undefined ? '—' : t("{0} мс", Math.round(delay))}</dd></div>
        <div><dt>{t("Потеря входящих аудиопакетов")}</dt><dd>{loss === undefined ? '—' : `${new Intl.NumberFormat(language === 'en' ? 'en-US' : 'ru-RU', { maximumFractionDigits: 1 }).format(loss)} %`}</dd></div>
      </dl>
    </div>, document.body)}
  </span>;
}
