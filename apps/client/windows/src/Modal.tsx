import { t } from './i18n';
import { useEffect, useRef, type ReactNode, type KeyboardEventHandler } from 'react';
export function Modal({ title, onClose, children, className = '', error, onKeyDown, footer, inline = false, fullPage = false, navigation, sectionTitle }: { title: string; className?: string; error?: string; onClose(): void; children: ReactNode; onKeyDown?: KeyboardEventHandler<HTMLDialogElement>; footer?:ReactNode; inline?: boolean; fullPage?: boolean; navigation?: ReactNode; sectionTitle?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  useEffect(() => { dialog.current?.showModal(); const element = dialog.current; return () => element?.close(); }, []);
  if (inline) return <section className={className} aria-label={title}>
    {error && <p role="alert" className="text-error modal-error">{error}</p>}{children}{footer}
  </section>;
  const page = fullPage || !!navigation;
  const body = navigation ? <div className="settings-layout">{navigation}
    <section className="settings-panel-layout">
      <div className="settings-panel"><div className="settings-content"><h2>{sectionTitle ?? title}</h2>{children}</div></div>
      {footer && <div className="settings-panel-footer"><div className="settings-content">{footer}</div></div>}
    </section>
  </div> : children;
  return <dialog aria-label={title} onKeyDown={onKeyDown} ref={dialog} className={`modal ${page ? 'settings-full-page ' : ''}${className}`} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }} onPointerDown={event => { backdropPress.current = !page && event.button === 0 && event.target === event.currentTarget; }} onPointerCancel={() => { backdropPress.current = false; }} onClick={event => { const outside = backdropPress.current && event.target === event.currentTarget; backdropPress.current = false; if (outside) onClose(); }}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label={t("Закрыть")} onClick={onClose}>×</button></div><div className="modal-body">{error && <p role="alert" className="text-error modal-error">{error}</p>}{body}</div>{footer&&!navigation&&<div className="modal-footer">{footer}</div>}</dialog>;
}
