import { useRef, useState, type DragEvent } from 'react';
import { t } from './i18n';

export type Bookmark = { address: string; name: string };
type Drag = { bookmarks: Bookmark[]; from: number; centers: number[] };

export function BookmarkRail({ bookmarks, activeAddress, selected, people, presence, disabled, onOpen, onMenu, onReorder }: {
  bookmarks: Bookmark[]; activeAddress?: string; selected: boolean; people: number;
  presence: Record<string, number | null>; disabled: boolean;
  onOpen(item: Bookmark): void; onMenu(address: string, x: number, y: number): void;
  onReorder(items: Bookmark[]): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClickUntil = useRef(0);
  const [preview, setPreview] = useState<{ drag: Drag; to: number } | null>(null);
  const placement = preview?.drag.bookmarks === bookmarks ? preview : null;

  function startDrag(event: DragEvent<HTMLButtonElement>, from: number) {
    const rail = list.current!;
    const top = rail.getBoundingClientRect().top - rail.scrollTop;
    const centers = Array.from(rail.querySelectorAll('.bookmark-orb'), button => {
      const rect = button.getBoundingClientRect();
      return rect.top + rect.height / 2 - top;
    });
    drag.current = { bookmarks, from, centers };
    suppressClickUntil.current = Infinity;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', bookmarks[from].address);
  }

  function targetSlot(event: DragEvent<HTMLDivElement>, centers: number[]) {
    const rail = event.currentTarget;
    const y = event.clientY - rail.getBoundingClientRect().top + rail.scrollTop;
    let slot = 0;
    // Use the original slots so animated buttons cannot shift the drop thresholds.
    while (slot < centers.length - 1 && y >= (centers[slot] + centers[slot + 1]) / 2) slot++;
    return slot;
  }

  function endDrag() {
    drag.current = null;
    setPreview(null);
    suppressClickUntil.current = Date.now() + 200;
  }

  return <div ref={list} className={`bookmark-list${placement ? ' reordering' : ''}`}
    onDragOver={event => {
      const current = drag.current;
      if (disabled || current?.bookmarks !== bookmarks) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const to = targetSlot(event, current.centers);
      setPreview(previous => previous?.drag === current && previous.to === to ? previous : { drag: current, to });
    }}
    onDragLeave={event => {
      const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
      if (event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom) setPreview(null);
    }}
    onDrop={event => {
      const current = drag.current;
      if (disabled || current?.bookmarks !== bookmarks) return;
      event.preventDefault();
      const to = targetSlot(event, current.centers);
      endDrag();
      if (current.from === to) return;
      const next = [...bookmarks];
      const [item] = next.splice(current.from, 1);
      next.splice(to, 0, item);
      onReorder(next);
    }}
  >{bookmarks.map((item, index) => {
    const count = item.address === activeAddress ? people : presence[item.address];
    let offset = 0;
    const placeholder = placement?.drag.from === index;
    if (placement) {
      const { drag: { from, centers }, to } = placement;
      let slot = index;
      if (index === from) slot = to;
      else if (from < index && index <= to) slot--;
      else if (to <= index && index < from) slot++;
      offset = centers[slot] - centers[index];
    }
    return <button key={item.address} className={`server-orb bookmark-orb ${selected && item.address === activeAddress ? 'selected' : ''} ${placeholder ? 'bookmark-placeholder' : ''}`}
      title={item.name} aria-label={item.name} disabled={disabled} draggable={!disabled}
      style={offset ? { transform: `translateY(${offset}px)` } : undefined}
      onDragStart={event => startDrag(event, index)}
      onDragEnd={endDrag}
      onClick={() => { if (Date.now() >= suppressClickUntil.current) onOpen(item); }}
      onContextMenu={event => { event.preventDefault(); onMenu(item.address, event.clientX, event.clientY); }}
    >{item.name.slice(0, 1).toUpperCase()}<span className="participant-pin" title={count == null ? t("Количество участников недоступно") : t("Участников: {0}", count)}>{count ?? '?'}</span></button>;
  })}</div>;
}
