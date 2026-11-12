import { t } from './i18n';
import { useEffect, useRef, type ReactNode } from 'react';
export function Modal({ title, onClose, children, className = '' }: { title: string; className?: string; onClose(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  useEffect(() => { dialog.current?.showModal(); const element = dialog.current; return () => element?.close(); }, []);
  return <dialog ref={dialog} className={`modal ${className}`} onCancel={event => { event.preventDefault(); onClose(); }} onPointerDown={event => { backdropPress.current = event.button === 0 && event.target === event.currentTarget; }} onPointerCancel={() => { backdropPress.current = false; }} onClick={event => { const outside = backdropPress.current && event.target === event.currentTarget; backdropPress.current = false; if (outside) onClose(); }}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label={t("Закрыть")} onClick={onClose}>×</button></div><div className="modal-body">{children}</div></dialog>;
}
