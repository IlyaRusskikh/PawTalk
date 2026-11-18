import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from './i18n';

const dividerHeight = 12;

export function RoomSplit({ visible, participants, chat }: { visible: boolean; participants: ReactNode; chat: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const dragOffset = useRef(0);
  const [height, setHeight] = useState(0);
  const [ratio, setRatio] = useState(0.43);

  useLayoutEffect(() => {
    const pane = container.current!;
    const resize = () => setHeight(pane.clientHeight);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  const available = Math.max(0, height - dividerHeight);
  const max = Math.max(0, available - 154);
  const min = Math.min(196, max);
  const upper = Math.max(min, Math.min(max, Math.round(available * ratio)));
  const resizeTo = (pixels: number) => {
    if (available > 0) setRatio(Math.max(min, Math.min(max, pixels)) / available);
  };
  const percent = (pixels: number) => available > 0 ? Math.round(pixels / available * 100) : 0;

  return <div className="room-split" ref={container} hidden={!visible} style={height > 0 ? { gridTemplateRows: `${upper}px ${dividerHeight}px minmax(0, 1fr)` } : undefined}>
    <section className="room-participants" id="room-participants" aria-label={t("Участники")}>{participants}</section>
    <div className="room-divider" role="separator" aria-orientation="horizontal" aria-label={t("Размер области участников")} aria-controls="room-participants"
      aria-valuemin={percent(min)} aria-valuemax={percent(max)} aria-valuenow={percent(upper)} tabIndex={0}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        dragOffset.current = event.clientY - event.currentTarget.getBoundingClientRect().top;
      }}
      onPointerMove={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          resizeTo(event.clientY - container.current!.getBoundingClientRect().top - dragOffset.current);
        }
      }}
      onKeyDown={event => {
        const targets: Record<string, number> = { ArrowUp: upper - 16, ArrowDown: upper + 16, Home: min, End: max };
        const target = targets[event.key];
        if (target === undefined) return;
        event.preventDefault();
        resizeTo(target);
      }}/>
    {chat}
  </div>;
}
