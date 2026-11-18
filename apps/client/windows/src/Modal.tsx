import { t } from './i18n';
import { useEffect, useRef, type ReactNode, type KeyboardEventHandler } from 'react';
export function Modal({ title, onClose, children, className = '', error, onKeyDown, footer }: { title: string; className?: string; error?: string; onClose(): void; children: ReactNode; onKeyDown?: KeyboardEventHandler<HTMLDialogElement>; footer?:ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  useEffect(() => { dialog.current?.showModal(); const element = dialog.current; return () => element?.close(); }, []);
  return <dialog onKeyDown={onKeyDown} ref={dialog} className={`modal ${className}`} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }} onPointerDown={event => { backdropPress.current = event.button === 0 && event.target === event.currentTarget; }} onPointerCancel={() => { backdropPress.current = false; }} onClick={event => { const outside = backdropPress.current && event.target === event.currentTarget; backdropPress.current = false; if (outside) onClose(); }}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label={t("Закрыть")} onClick={onClose}>×</button></div><div className="modal-body">{error && <p role="alert" className="text-error modal-error">{error}</p>}{children}</div>{footer&&<div className="modal-footer">{footer}</div>}</dialog>;
}
