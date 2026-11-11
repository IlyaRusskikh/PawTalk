import { useId, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Controls';
import { Avatar } from './Avatar';
import { t } from './i18n';

export type Bookmark = { address: string; name: string; roomId?: string };
export type RoomPreview = { status: 'online' | 'offline' | 'locked'; participants?: number; unread?: number; people?: { name: string; avatar?: string }[]; details?: boolean; feed?: string; ephemeral?: boolean };
type Drag = { temporaryAddress?: string; bookmarks: Bookmark[]; order: Bookmark[]; statuses: boolean[]; from: number; centers: number[]; offline: boolean };

export function BookmarkRail({ bookmarks, temporaryRoom, onSaveTemporary, activeAddress, activeRoomId, selected, people, livePeople = [], unread = 0, presence, disabled, onOpen, onMenu, onReorder }: {
  temporaryRoom?: Bookmark; onSaveTemporary?(): void;
  bookmarks: Bookmark[]; activeAddress?: string; activeRoomId?: string; selected: boolean; people: number;
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
  }, [bookmarks, presence, activeAddress, temporaryRoom?.address]);
  const drag = useRef<Drag | null>(null);
  const suppressClickUntil = useRef(0);
  const [preview, setPreview] = useState<{ drag: Drag; to: number } | null>(null);
  const id = useId();
  const [hover, setHover] = useState<{ item: Bookmark; x: number; y: number }>();
  const isActive = (item: Bookmark) => item.address === activeAddress && (!item.roomId || item.roomId === activeRoomId);
  const stateFor = (address: string, roomId?: string): RoomPreview | undefined => {
    if (isActive({address,name:'',roomId})) return { status: 'online', participants: people, people: livePeople.slice(0, 3), unread, details: true };
    const value = presence[address];
    return typeof value === 'number' ? { status: 'online', participants: value, unread: 0, details: false } : value ?? undefined;
  };
  function show(item: Bookmark, button: HTMLElement) {
    const rect = button.getBoundingClientRect();
    setHover({ item, x: rect.right + 14, y: Math.max(12, Math.min(rect.top - 10, window.innerHeight - 190)) });
  }
  const shown = hover ? stateFor(hover.item.address,hover.item.roomId) : undefined;
  const offline = (item: Bookmark) => stateFor(item.address,item.roomId)?.status === 'offline';
  // Keep the saved order intact: connection changes only affect the displayed groups.
  const ordered = [...bookmarks.filter(item => !offline(item)), ...bookmarks.filter(offline)];
  const sameOrder = (current: Drag) => current.temporaryAddress === temporaryRoom?.address && current.bookmarks === bookmarks && current.order.every((item, index) => ordered[index]?.address === item.address && current.statuses[index] === offline(item));
  const placement = preview && sameOrder(preview.drag) ? preview : null;

  function startDrag(event: DragEvent<HTMLButtonElement>, from: number) {
    const rail = list.current!;
    const top = rail.getBoundingClientRect().top - rail.scrollTop;
    const centers = Array.from(rail.querySelectorAll('.bookmark-orb:not(.temporary-orb)'), button => {
      const rect = button.getBoundingClientRect();
      return rect.top + rect.height / 2 - top;
    });
    drag.current = { temporaryAddress: temporaryRoom?.address, bookmarks, order: ordered, statuses: ordered.map(offline), from, centers, offline: offline(ordered[from]) };
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
  >{temporaryRoom && <div className="temporary-room">
    <button type="button" className={`server-orb bookmark-orb temporary-orb${selected ? ' selected' : ''}`} aria-label={temporaryRoom.name} disabled={disabled}
      onClick={() => onOpen(temporaryRoom)}
      onMouseEnter={event => show(temporaryRoom, event.currentTarget)} onMouseLeave={() => setHover(undefined)}
      onFocus={event => show(temporaryRoom, event.currentTarget)} onBlur={() => setHover(undefined)} onKeyDown={event => { if (event.key === 'Escape') setHover(undefined); }}>
      {temporaryRoom.name.slice(0, 1).toUpperCase()}
      <span className="participant-pin" title={t("Участников: {0}", people)}><Icon name="users" size={10}/>{people}</span>
      {!!unread && <span className="unread-pin" title={t("Непрочитанных: {0}", unread)}><Icon name="chat" size={10}/>{unread > 99 ? '99+' : unread}</span>}
    </button>
    <button type="button" className="temporary-room-pin" disabled={disabled} title={t("Временная комната — добавить в закладки")} aria-label={t("Временная комната — добавить в закладки")} onClick={onSaveTemporary}><span className="temporary-room-timer"><Icon name="stopwatch" size={12}/></span><span className="temporary-room-star"><Icon name="star" size={12}/></span></button>
  </div>}{ordered.map((item, index) => {
    const state = stateFor(item.address,item.roomId);
    const count = state?.status === 'online' ? state.participants : undefined;
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
    return <button key={item.address} className={`server-orb bookmark-orb ${selected && isActive(item) ? 'selected' : ''} ${placeholder ? 'bookmark-placeholder' : ''}${state?.status === 'offline' ? ' server-offline' : ''}${index > 0 && offline(item) && !offline(ordered[index - 1]) ? ' bookmark-group-start' : ''}`}
      aria-label={item.name} aria-describedby={hover?.item.address === item.address ? id : undefined} disabled={disabled} draggable={!disabled}
      onMouseEnter={event => show(item, event.currentTarget)} onMouseLeave={() => setHover(undefined)} onFocus={event => show(item, event.currentTarget)} onBlur={() => setHover(undefined)}
      style={offset ? { transform: `translateY(${offset}px)` } : undefined}
      onDragStart={event => startDrag(event, index)}
      onDragEnd={endDrag}
      onClick={() => { if (Date.now() >= suppressClickUntil.current) onOpen(item); }}
      onKeyDown={event => { if (event.key === 'Escape') setHover(undefined); }}
      onContextMenu={event => { event.preventDefault(); setHover(undefined); onMenu(item.address, event.clientX, event.clientY); }}
    >{item.name.slice(0, 1).toUpperCase()}
      {state?.status === 'online' && count !== undefined && <span className="participant-pin" title={t("Участников: {0}", count)}><Icon name="users" size={10}/>{count}</span>}
      {state?.status === 'offline' ? <span className="unread-pin disconnected-pin" title={t("Нет соединения")} aria-label={t("Нет соединения")}><Icon name="offline" size={12}/></span>
        : state?.status === 'online' && state.unread ? <span className="unread-pin" title={t("Непрочитанных: {0}", state.unread)}><Icon name="chat" size={10}/>{state.unread > 99 ? '99+' : state.unread}</span> : null}
    </button>;
  })}{hover && !placement && createPortal(<div className="server-preview" role="tooltip" id={id} style={{ left: hover.x, top: hover.y }}>
    <div className="server-preview-heading"><span className="server-preview-icon"><Icon name={shown?.status === 'offline' ? 'offline' : 'headphones'} size={20}/></span><div><strong>{hover.item.name}</strong><small>{shown?.status === 'locked' ? t("Требуется повторный вход") : shown?.status === 'offline' ? t("Нет соединения") : shown ? shown.participants !== undefined ? t("Участников: {0}", shown.participants) : t("Сервер доступен") : t("Проверяем соединение…")}</small></div></div>
    {shown?.status === 'online' && <><div className="server-preview-people">{shown.people?.map((person, index) => <div key={index}><Avatar name={person.name} image={person.avatar}/><span>{person.name}</span></div>)}{(shown.participants ?? 0) > (shown.people?.length ?? 0) && shown.details && <span className="server-preview-more">+{(shown.participants ?? 0) - (shown.people?.length ?? 0)}</span>}{!shown.people?.length && <p>{shown.details ? t("В канале пока тихо") : t("Подключитесь, чтобы увидеть участников")}</p>}</div>
      <div className="server-preview-footer"><Icon name="chat" size={13}/>{t("Непрочитанных: {0}", shown.unread ?? 0)}</div></>}
  </div>, document.body)}</div>{overflow && <div className="bookmark-overflow" aria-label={hiddenBelow ? t("Ещё серверов ниже: {0}", hiddenBelow) : undefined}><span>{hiddenBelow ? `+${hiddenBelow}` : ''}</span></div>}</div>;
}
