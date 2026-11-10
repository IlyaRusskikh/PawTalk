import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t, useLanguage } from './i18n';
import { Icon } from './Controls';
import { pingLevel } from '../shared/ping.mjs';
import type { ConnectionHistory } from '../shared/connection-history.mjs';
import { ConnectionDebug, ConnectionSummary } from './ConnectionDebug';

export const ConnectionStatus = memo(function ConnectionStatus({ name, delay, loss, diagnostics }: { name: string; delay?: number; loss?: number; diagnostics?: ConnectionHistory }) {
  const language = useLanguage();
  const id = useId();
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const [debug, setDebug] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(undefined);
  const wasDebug = useRef(false);
  useEffect(() => {
    if (!debug && wasDebug.current) anchor.current?.focus();
    wasDebug.current = debug;
  }, [debug]);
  const hideHover = () => { window.clearTimeout(timer.current); setHover(false); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { if (open) panel.current?.focus({ preventScroll: true }); }, [open]);

  useEffect(() => {
    if (!open && !hover) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.current?.contains(event.target)) { setOpen(false); hideHover(); }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); hideHover(); if (open) anchor.current?.focus(); }
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('focusin', outside);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('focusin', outside); window.removeEventListener('keydown', escape); };
  }, [open, hover]);

  useLayoutEffect(() => {
    if (!open && !hover) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      const element = panel.current;
      if (!rect || !element) return;
      const { width, height } = element.getBoundingClientRect();
      element.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + 'px';
      const top = rect.top >= height + 12 ? rect.top - height - 6 : rect.bottom + 6;
      element.style.top = Math.max(8, Math.min(top, window.innerHeight - height - 8)) + 'px';
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, hover, language]);

  const ping = delay === undefined ? t("Нет измерений") : t("{0} мс", Math.round(delay));
  return <span className="person-network-wrap">
    <button ref={anchor} type="button" className={`icon-button person-network ping-${pingLevel(delay)}`}
      aria-label={t("Соединение {0}", name)} aria-describedby={hover && !open ? id + '-ping' : undefined}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onMouseEnter={() => { if (!open && !debug) { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setHover(true), 250); } }}
      onMouseLeave={hideHover} onFocus={() => { if (!open && !debug) setHover(true); }} onBlur={hideHover}
      onClick={() => { hideHover(); setOpen(value => !value); }}>
      <Icon name="signal" size={15}/>
    </button>
    {hover && !open && !debug && createPortal(<div ref={panel} className="connection-popover connection-ping-tooltip" role="tooltip" id={id + '-ping'}>{ping}</div>, document.body)}
    {open && createPortal(<div ref={panel} className={`connection-popover${diagnostics ? ' connection-summary' : ''}`} role="dialog" tabIndex={-1} aria-label={t("Качество соединения")} id={id}>
      <strong>{diagnostics ? t("Качество соединения") : t("Соединение {0}", name)}</strong>
      {diagnostics ? <ConnectionSummary history={diagnostics} delay={delay} onDebug={() => { setOpen(false); hideHover(); setDebug(true); }}/>
        : <dl><div><dt>{t("Пинг до сервера")}</dt><dd>{ping}</dd></div><div><dt>{t("Потеря входящих аудиопакетов")}</dt><dd>{loss === undefined ? '—' : `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(loss)} %`}</dd></div></dl>}
    </div>, document.body)}
    {debug && diagnostics && <ConnectionDebug history={diagnostics} delay={delay} loss={loss} onClose={() => setDebug(false)}/>}
  </span>;
});
