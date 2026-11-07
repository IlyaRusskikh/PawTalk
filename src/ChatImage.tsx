import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type ChatImage as Image, type ChatAccess } from './chat';
import { decodeImage } from './chatImages';
import { Modal } from './Modal';
import { Icon } from './Controls';
import { t } from './i18n';

// At most two downloads/decryptions across the room. No image cache survives a row.
let active = 0;
const waiting: (() => void)[] = [];
async function withImageSlot<T>(callback: () => Promise<T>) {
  if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve)); else active++;
  try { return await callback(); }
  finally { const next = waiting.shift(); if (next) next(); else active--; }
}
export function ChatImage({ image, access, getKey }: { image: Image; access: ChatAccess; getKey(): Promise<CryptoKey | undefined> }) {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setURL] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const blob = useRef<Blob | undefined>(undefined);
  const stage = useRef<HTMLDivElement>(null);
  const viewedImage = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const menuElement = useRef<HTMLDivElement>(null);
  const [actionStatus, setActionStatus] = useState('');
  const [working, setWorking] = useState(false);
  function clamp(point: { x: number; y: number }, scale: number) {
    const view = stage.current, img = viewedImage.current;
    const x = Math.max(0, ((img?.offsetWidth ?? 0) * scale - (view?.clientWidth ?? 0)) / 2);
    const y = Math.max(0, ((img?.offsetHeight ?? 0) * scale - (view?.clientHeight ?? 0)) / 2);
    return { x: Math.max(-x, Math.min(x, point.x)), y: Math.max(-y, Math.min(y, point.y)) };
  }
  function changeZoom(value: number) { const next = Math.max(1, Math.min(4, value)); setZoom(next); setOffset(previous => clamp(previous, next)); }
  function showMenu(event: React.MouseEvent) { event.preventDefault(); event.stopPropagation(); if (url) setMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 110)) }); }
  async function imageAction(action: 'save' | 'copy') {
    setMenu(undefined); setActionStatus('');
    if (!blob.current || !url || working) return;
    setWorking(true);
    try {
      const input = { bytes: new Uint8Array(await blob.current.arrayBuffer()), name: image.name };
      if (action === 'save') {
        if (window.desktop?.saveChatImage) { if (!await window.desktop.saveChatImage(input)) return; }
        else { const link = document.createElement('a'); link.href = url; link.download = image.name; link.click(); }
        setActionStatus(t("Изображение сохранено"));
      } else {
        const bitmap = await createImageBitmap(blob.current);
        try {
          const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
          canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
          const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Image encoding failed')), 'image/png'));
          if (window.desktop?.copyChatImage) await window.desktop.copyChatImage({ bytes: new Uint8Array(await png.arrayBuffer()), name: image.name });
          else await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        } finally { bitmap.close(); }
        setActionStatus(t("Изображение скопировано"));
      }
    } catch { setActionStatus(t("Не удалось сохранить или скопировать изображение.")); }
    finally { setWorking(false); }
  }
  useEffect(() => { setZoom(1); setOffset({ x: 0, y: 0 }); setMenu(undefined); setActionStatus(''); }, [open]);
  useEffect(() => {
    if (!open || !stage.current) return;
    const element = stage.current;
    const wheel = (event: WheelEvent) => { event.preventDefault(); changeZoom(zoom + (event.deltaY < 0 ? .25 : -.25)); };
    element.addEventListener('wheel', wheel, { passive: false });
    const observer = new ResizeObserver(() => setOffset(previous => clamp(previous, zoom))); observer.observe(element);
    return () => { element.removeEventListener('wheel', wheel); observer.disconnect(); };
  }, [open, zoom]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => { if (!menuElement.current?.contains(event.target as Node)) setMenu(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(undefined); } };
    window.addEventListener('pointerdown', close); window.addEventListener('resize', close); window.addEventListener('scroll', close, true); window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', escape, true); };
  }, [menu]);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root: element.current?.closest('.chat-stream'), rootMargin: '120px' });
    observer.observe(element.current!); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible && !open) return;
    let cancelled = false, objectURL: string | undefined;
    setFailed(false);
    void withImageSlot(async () => {
      if (cancelled) return;
      const payload = await window.desktop!.chatRequest(access.handle, { attachment: { id: image.id } });
      if (cancelled) return;
      const decoded = await decodeImage(await getKey(), image, payload as Uint8Array);
      if (cancelled) return;
      blob.current = decoded; objectURL = URL.createObjectURL(decoded); setURL(objectURL);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; blob.current = undefined; if (objectURL) URL.revokeObjectURL(objectURL); setURL(undefined); setMenu(undefined); };
  }, [access.handle, image.id, visible || open, attempt]);
  return <div ref={element} className="chat-image" style={{ aspectRatio: `${image.width} / ${image.height}`, width: Math.min(420, image.width) }}>
    {url ? <button type="button" className="chat-image-open" aria-label={t("Открыть изображение {0}", image.name)} onContextMenu={showMenu} onClick={() => setOpen(true)}><img src={url} width={image.width} height={image.height} alt={image.name} decoding="async"/></button>
      : failed ? <button type="button" className="image-retry" onClick={() => setAttempt(value => value + 1)}><Icon name="image"/>{t("Не удалось загрузить. Повторить")}</button>
      : <span className="image-placeholder"><Icon name="image"/>{visible ? t("Загружаем изображение…") : t("Изображение")}</span>}
    {actionStatus && !open && <span className="image-action-toast" role="status">{actionStatus}</span>}
    {open && url && <Modal title={image.name || t("Изображение")} className="image-viewer" onClose={() => setOpen(false)}>
      <div className="image-stage" ref={stage} data-zoomed={zoom > 1 || undefined} onContextMenu={showMenu} onDoubleClick={() => changeZoom(zoom > 1 ? 1 : 2)} onPointerDown={event => {
        if (event.button !== 0 || zoom <= 1) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, left: offset.x, top: offset.y };
      }} onPointerMove={event => { if (drag.current) setOffset(clamp({ x: drag.current.left + event.clientX - drag.current.x, y: drag.current.top + event.clientY - drag.current.y }, zoom)); }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
        <img ref={viewedImage} src={url} alt={image.name} width={image.width} height={image.height} draggable={false} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}/>
      </div>
      <div className="image-toolbar" role="toolbar" aria-label={t("Просмотр изображения")}>
        <button type="button" className="icon-button" aria-label={t("Уменьшить")} disabled={zoom <= 1} onClick={() => changeZoom(zoom - .25)}><Icon name="zoom-out"/></button>
        <button type="button" className="image-fit" onClick={() => changeZoom(1)} title={t("Вписать в окно")}>{Math.round(zoom * 100)}%</button>
        <button type="button" className="icon-button" aria-label={t("Увеличить")} disabled={zoom >= 4} onClick={() => changeZoom(zoom + .25)}><Icon name="zoom-in"/></button>
        <span className="image-toolbar-divider"/>
        <button type="button" className="icon-button" aria-label={t("Сохранить изображение")} disabled={working} onClick={() => void imageAction('save')}><Icon name="download"/></button>
        <button type="button" className="icon-button" aria-label={t("Копировать изображение")} disabled={working} onClick={() => void imageAction('copy')}><Icon name="copy"/></button>
        <span className="image-action-status" role="status">{actionStatus}</span>
      </div>
    </Modal>}
    {menu && createPortal(<div ref={menuElement} className="chat-image-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={event => event.stopPropagation()}>
      <button type="button" role="menuitem" autoFocus disabled={working} onClick={() => void imageAction('save')}><Icon name="download" size={17}/>{t("Сохранить изображение")}</button>
      <button type="button" role="menuitem" disabled={working} onClick={() => void imageAction('copy')}><Icon name="copy" size={17}/>{t("Копировать изображение")}</button>
    </div>, document.querySelector('dialog.image-viewer[open]') ?? document.body)}
  </div>;
}
