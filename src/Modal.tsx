import { t } from './i18n';
import { useEffect, useRef, type ReactNode } from 'react';
export function Modal({ title, onClose, children, className = '' }: { title: string; className?: string; onClose(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); const element = dialog.current; return () => element?.close(); }, []);
  return <dialog ref={dialog} className={`modal ${className}`} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label={t("Закрыть")} onClick={onClose}>×</button></div><div className="modal-body">{children}</div></dialog>;
}
