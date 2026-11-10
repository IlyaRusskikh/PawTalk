import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t, useLanguage } from './i18n';
import { Icon } from './Controls';
import { pingLevel } from '../shared/ping.mjs';
import type { ConnectionHistory } from '../shared/connection-history.mjs';
import { ConnectionCharts } from './ConnectionCharts';

export const ConnectionStatus = memo(function ConnectionStatus({ name, delay, loss, diagnostics }: { name: string; delay?: number; loss?: number; diagnostics?: ConnectionHistory }) {
  const language = useLanguage();
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number>(undefined);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      window.clearTimeout(hoverTimer.current);
      setOpen(false);
    };
    window.addEventListener('keydown', escape);
    return () => { window.clearTimeout(hoverTimer.current); window.removeEventListener('keydown', escape); };
  }, []);

  const hide = () => {
    window.clearTimeout(hoverTimer.current);
    setOpen(false);
  };
  const show = () => { window.clearTimeout(hoverTimer.current); setOpen(true); };
  const leave = () => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(hide, 80);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      const panel = tooltip.current;
      if (!rect || !panel) return;
      const width = panel.getBoundingClientRect().width;
      const height = panel.getBoundingClientRect().height;
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      const top = rect.top >= height + 12 ? rect.top - height - 6 : rect.bottom + 6;
      panel.style.left = left + 'px';
      panel.style.top = Math.max(8, Math.min(top, window.innerHeight - height - 8)) + 'px';
    };
    place();
    const observer = new ResizeObserver(place);
    if (tooltip.current) observer.observe(tooltip.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, language]);

  return <span className="person-network-wrap">
    <button ref={anchor} type="button" className={`icon-button person-network ping-${pingLevel(delay)}`}
      aria-label={t("Соединение {0}", name)} aria-describedby={open ? id : undefined}
      onMouseEnter={() => { window.clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(show, 250); }} onMouseLeave={leave}
      onFocus={show} onBlur={hide} onClick={show}
      onKeyDown={event => { if (event.key === 'Escape') hide(); }}>
      <Icon name="signal" size={15}/>
    </button>
    {open && createPortal(<div ref={tooltip} className={`connection-popover${diagnostics ? ' connection-diagnostics' : ''}`} role="tooltip" id={id} onMouseEnter={show} onMouseLeave={leave}>
      <strong>{diagnostics ? t("Качество соединения") : t("Соединение {0}", name)}</strong>
      <dl>
        <div><dt>{t("Пинг до сервера")}</dt><dd>{delay === undefined ? '—' : t("{0} мс", Math.round(delay))}</dd></div>
        <div><dt>{t("Потеря входящих аудиопакетов")}</dt><dd>{loss === undefined ? '—' : `${new Intl.NumberFormat(language === 'en' ? 'en-US' : 'ru-RU', { maximumFractionDigits: 1 }).format(loss)} %`}</dd></div>
      </dl>
      {diagnostics && <ConnectionCharts history={diagnostics} delay={delay} loss={loss}/>}
    </div>, document.body)}
  </span>;
});
