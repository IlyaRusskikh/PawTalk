import { useId, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Controls';
import { Avatar } from './Avatar';
import { t } from './i18n';

export type Bookmark = { address: string; name: string };
export type RoomPreview = { status: 'online' | 'offline'; participants?: number; unread?: number; people?: { name: string; avatar?: string }[]; details?: boolean; feed?: string; ephemeral?: boolean };
type Drag = { bookmarks: Bookmark[]; order: Bookmark[]; statuses: boolean[]; from: number; centers: number[]; offline: boolean };

export function BookmarkRail({ bookmarks, activeAddress, selected, people, livePeople = [], unread = 0, presence, disabled, onOpen, onMenu, onReorder }: {
  bookmarks: Bookmark[]; activeAddress?: string; selected: boolean; people: number;
  livePeople?: { name: string; avatar?: string }[]; unread?: number;
  presence: Record<string, RoomPreview | number | null>; disabled: boolean;
  onOpen(item: Bookmark): void; onMenu(address: string, x: number, y: number): void;
  onReorder(items: Bookmark[]): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [hiddenBelow, setHiddenBelow] = useState(0);
  function measureOverflow() {
    const element = list.current, frame = viewport.current;
    if (!element || !frame) return;
    const overflowing = element.scrollHeight > frame.clientHeight + 1;
    const bottom = element.getBoundingClientRect().bottom;
    setOverflow(overflowing);
    setHiddenBelow(overflowing ? Array.from(element.querySelectorAll('.bookmark-orb')).filter(button => button.getBoundingClientRect().bottom > bottom + 1).length : 0);
  }
  useLayoutEffect(() => {
    measureOverflow();
    const observer = new ResizeObserver(measureOverflow);
    if (list.current) observer.observe(list.current);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [bookmarks, presence, activeAddress]);
  const drag = useRef<Drag | null>(null);
  const suppressClickUntil = useRef(0);
  const [preview, setPreview] = useState<{ drag: Drag; to: number } | null>(null);
  const id = useId();
  const [hover, setHover] = useState<{ item: Bookmark; x: number; y: number }>();
  const stateFor = (address: string): RoomPreview | undefined => {
    if (address === activeAddress) return { status: 'online', participants: people, people: livePeople.slice(0, 3), unread, details: true };
    const value = presence[address];
    return typeof value === 'number' ? { status: 'online', participants: value, unread: 0, details: false } : value ?? undefined;
  };
  const shown = hover ? stateFor(hover.item.address) : undefined;
  const offline = (item: Bookmark) => stateFor(item.address)?.status === 'offline';
  // Keep the saved order intact: connection changes only affect the displayed groups.
  const ordered = [...bookmarks.filter(item => !offline(item)), ...bookmarks.filter(offline)];
  const sameOrder = (current: Drag) => current.bookmarks === bookmarks && current.order.every((item, index) => ordered[index]?.address === item.address && current.statuses[index] === offline(item));
  const placement = preview && sameOrder(preview.drag) ? preview : null;

  function startDrag(event: DragEvent<HTMLButtonElement>, from: number) {
    const rail = list.current!;
    const top = rail.getBoundingClientRect().top - rail.scrollTop;
    const centers = Array.from(rail.querySelectorAll('.bookmark-orb'), button => {
      const rect = button.getBoundingClientRect();
      return rect.top + rect.height / 2 - top;
    });
    drag.current = { bookmarks, order: ordered, statuses: ordered.map(offline), from, centers, offline: offline(ordered[from]) };
    setHover(undefined);
    suppressClickUntil.current = Infinity;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', ordered[from].address);
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

  return <div className="bookmark-viewport" ref={viewport}><div ref={list} className={`bookmark-list${placement ? ' reordering' : ''}`} onScroll={() => { setHover(undefined); measureOverflow(); }}
    onDragOver={event => {
      const current = drag.current;
      if (disabled || !current || !sameOrder(current)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const to = targetSlot(event, current.centers);
      if (offline(ordered[to]) !== current.offline) return;
      setPreview(previous => previous?.drag === current && previous.to === to ? previous : { drag: current, to });
    }}
    onDragLeave={event => {
      const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
      if (event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom) setPreview(null);
    }}
    onDrop={event => {
      const current = drag.current;
      if (disabled || !current || !sameOrder(current)) { endDrag(); return; }
      event.preventDefault();
      const to = targetSlot(event, current.centers);
      endDrag();
      if (offline(ordered[to]) !== current.offline) return;
      if (current.from === to) return;
      const next = [...current.order];
      const [item] = next.splice(current.from, 1);
      next.splice(to, 0, item);
      const group = next.filter(item => offline(item) === current.offline);
      let index = 0;
      onReorder(bookmarks.map(item => offline(item) === current.offline ? group[index++] : item));
    }}
  >{ordered.map((item, index) => {
    const state = stateFor(item.address);
    const count = state?.participants;
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
    const show = (button: HTMLElement) => { const rect = button.getBoundingClientRect(); setHover({ item, x: rect.right + 14, y: Math.max(12, Math.min(rect.top - 10, window.innerHeight - 190)) }); };
    return <button key={item.address} className={`server-orb bookmark-orb ${selected && item.address === activeAddress ? 'selected' : ''} ${placeholder ? 'bookmark-placeholder' : ''}${state?.status === 'offline' ? ' server-offline' : ''}${index > 0 && offline(item) && !offline(ordered[index - 1]) ? ' bookmark-group-start' : ''}`}
      aria-label={item.name} aria-describedby={hover?.item.address === item.address ? id : undefined} disabled={disabled} draggable={!disabled}
      onMouseEnter={event => show(event.currentTarget)} onMouseLeave={() => setHover(undefined)} onFocus={event => show(event.currentTarget)} onBlur={() => setHover(undefined)}
      style={offset ? { transform: `translateY(${offset}px)` } : undefined}
      onDragStart={event => startDrag(event, index)}
      onDragEnd={endDrag}
      onClick={() => { if (Date.now() >= suppressClickUntil.current) onOpen(item); }}
      onKeyDown={event => { if (event.key === 'Escape') setHover(undefined); }}
      onContextMenu={event => { event.preventDefault(); setHover(undefined); onMenu(item.address, event.clientX, event.clientY); }}
    >{item.name.slice(0, 1).toUpperCase()}
      {state?.status === 'online' && count !== undefined && <span className="participant-pin" title={t("Участников: {0}", count)}><Icon name="users" size={10}/>{count}</span>}
      {state?.status === 'offline' ? <span className="unread-pin disconnected-pin" title={t("Нет соединения")} aria-label={t("Нет соединения")}><Icon name="offline" size={12}/></span>
        : state?.unread ? <span className="unread-pin" title={t("Непрочитанных: {0}", state.unread)}><Icon name="chat" size={10}/>{state.unread > 99 ? '99+' : state.unread}</span> : null}
    </button>;
  })}{hover && !placement && createPortal(<div className="server-preview" role="tooltip" id={id} style={{ left: hover.x, top: hover.y }}>
    <div className="server-preview-heading"><span className="server-preview-icon"><Icon name={shown?.status === 'offline' ? 'offline' : 'headphones'} size={20}/></span><div><strong>{hover.item.name}</strong><small>{shown?.status === 'offline' ? t("Нет соединения") : shown ? shown.participants !== undefined ? t("Участников: {0}", shown.participants) : t("Сервер доступен") : t("Проверяем соединение…")}</small></div></div>
    {shown?.status === 'online' && <><div className="server-preview-people">{shown.people?.map((person, index) => <div key={index}><Avatar name={person.name} image={person.avatar}/><span>{person.name}</span></div>)}{(shown.participants ?? 0) > (shown.people?.length ?? 0) && shown.details && <span className="server-preview-more">+{(shown.participants ?? 0) - (shown.people?.length ?? 0)}</span>}{!shown.people?.length && <p>{shown.details ? t("В канале пока тихо") : t("Подключитесь, чтобы увидеть участников")}</p>}</div>
      <div className="server-preview-footer"><Icon name="chat" size={13}/>{t("Непрочитанных: {0}", shown.unread ?? 0)}</div></>}
  </div>, document.body)}</div>{overflow && <div className="bookmark-overflow" aria-label={hiddenBelow ? t("Ещё серверов ниже: {0}", hiddenBelow) : undefined}><span>{hiddenBelow ? `+${hiddenBelow}` : ''}</span></div>}</div>;
}
