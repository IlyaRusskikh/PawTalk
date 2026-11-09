import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Controls';
import { t } from './i18n';

export function ConnectionFailure({ detail, onClose }: { detail: string; onClose?(): void }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  return <div role="alert" className="connection-failure"><span className="failure-symbol"><Icon name="signal" size={17}/></span><strong>{t("Подключение не удалось")}</strong>
    <button ref={trigger} type="button" className="failure-details" aria-label={t("Подробности ошибки")} aria-expanded={!!position} aria-controls={id} onClick={() => {
      const rect = trigger.current!.getBoundingClientRect();
      setPosition(previous => previous ? undefined : { left: Math.max(12, Math.min(window.innerWidth - 372, rect.left)), top: Math.max(12, Math.min(window.innerHeight - 210, rect.bottom + 10)) });
    }}><Icon name="info" size={17}/></button>
    {onClose && <button type="button" className="failure-dismiss" aria-label={t("Закрыть сообщение")} onClick={onClose}><Icon name="close" size={17}/></button>}
    {position && createPortal(<div className="failure-popover" id={id} role="dialog" aria-label={t("Подробности ошибки")} style={position} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setPosition(undefined); trigger.current?.focus(); } }}>
      <div><strong>{t("Подробности ошибки")}</strong><button type="button" autoFocus aria-label={t("Закрыть")} onClick={() => { setPosition(undefined); trigger.current?.focus(); }}>×</button></div><p>{detail}</p>
    </div>, document.querySelector('dialog[open]:last-of-type') ?? document.body)}
  </div>;
}
