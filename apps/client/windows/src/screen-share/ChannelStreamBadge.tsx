import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from '../i18n';
import type { ScreenStream } from '../session';
import { StreamPicture } from './StreamPicture';

const copy = {
  ru: { live: 'Стримит', preview: 'Превью стрима' },
  en: { live: 'Streaming', preview: 'Stream preview' },
};

export function ChannelStreamBadge({ stream, name }: { stream: ScreenStream; name: string }) {
  const labels = copy[useLanguage()];
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number>(undefined);
  const [open, setOpen] = useState(false);
  const label = `${labels.preview} · ${name}`;

  function show() {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  }
  function hide() {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  }
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useLayoutEffect(() => {
    if (!open) return;
    const dismiss = () => { window.clearTimeout(closeTimer.current); setOpen(false); };
    const position = () => {
      const button = trigger.current;
      const element = preview.current;
      if (!button || !element) return;
      const anchor = button.getBoundingClientRect();
      const channelList = button.closest('.member-channel-scroll')?.getBoundingClientRect();
      if (anchor.bottom <= (channelList?.top ?? 0) || anchor.top >= (channelList?.bottom ?? window.innerHeight)) {
        dismiss();
        return;
      }
      const { width, height } = element.getBoundingClientRect();
      const right = anchor.right + 8;
      element.style.left = `${right + width <= window.innerWidth - 8 ? right : Math.max(8, anchor.left - width - 8)}px`;
      element.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8))}px`;
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return <>
    <button ref={trigger} type="button" className="channel-stream-badge" title=""
      aria-label={`${labels.live} · ${name}`} aria-describedby={open ? id : undefined}
      onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide} onClick={show}>
      {labels.live}
    </button>
    {open && createPortal(<div ref={preview} id={id} className="channel-stream-preview" role="tooltip"
      aria-label={label} onPointerEnter={show} onPointerLeave={hide}>
      <StreamPicture stream={stream} alt={label}/>
    </div>, document.body)}
  </>;
}
