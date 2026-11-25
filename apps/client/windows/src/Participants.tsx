import { t } from './i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, Slider } from './Controls';
import type { Person } from './session';
import { ConnectionStatus } from './ConnectionStatus';
import { Avatar } from './Avatar';
import { AudioStatusIcons } from './ui/AudioStatusIcons';
import { ProtectedVoiceRestrictionControls } from './ProtectedVoiceRestrictionControls';

const cardWidth = 143;
const cardHeight = 130;
const cardGap = 8;

function fitCards(count: number, width: number, height: number) {
 let scale = 0;
 for (let columns = 1; columns <= count; columns++) {
  const rows = Math.ceil(count / columns);
  scale = Math.max(scale, Math.min(1,
   (width - (columns - 1) * cardGap) / (columns * cardWidth),
   (height - (rows - 1) * cardGap) / (rows * cardHeight),
  ));
 }
 return { width: Math.max(1, Math.floor(cardWidth * scale)), height: Math.max(1, Math.floor(cardHeight * scale)) };
}

export function Participants({ people, prefs, onChange, moderation, compact = false, streaming }: {
  people: Person[]; prefs: Record<string, { volume: number; muted: boolean }>;
  onChange(id: string, volume: number, muted: boolean): void; moderation?: { serverId: string; sourceChannelId: string };
  compact?: boolean; streaming?: ReadonlySet<string>;
}) {
 const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
 const grid = useRef<HTMLDivElement>(null);
 const popover = useRef<HTMLDivElement>(null);
 const menuAnchor = useRef<HTMLElement>(null);
 const [space, setSpace] = useState({ width: 0, height: 0 });
 useLayoutEffect(() => {
  if (compact) return;
  const observer = new ResizeObserver(([entry]) => {
   const { width, height } = entry.contentRect;
   setSpace({ width, height });
  });
  observer.observe(grid.current!);
  return () => observer.disconnect();
 }, [compact]);
 const card = fitCards(people.length, space.width, space.height);
 useEffect(() => {
  const close = (event: Event) => {
   if (event.target instanceof Node && popover.current?.contains(event.target)) return;
   setMenu(null);
  };
  const key = (event: KeyboardEvent) => {
   if (event.key !== 'Escape' || !popover.current) return;
   setMenu(null);
   menuAnchor.current?.focus({ preventScroll: true });
  };
  window.addEventListener('pointerdown', close); window.addEventListener('resize', close); window.addEventListener('scroll', close, true); window.addEventListener('keydown', key);
  return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', key); };
 }, []);
 const selected = menu && people.find(p => p.id === menu.id && !p.local);
 const pref = selected ? prefs[selected.id] || { volume: 1, muted: false } : { volume: 1, muted: false };
 useLayoutEffect(() => {
  const panel = popover.current;
  if (!menu || !panel) return;
  // Moderation actions arrive asynchronously and can change the menu height.
  const place = () => {
   const { width, height } = panel.getBoundingClientRect();
   panel.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))}px`;
   panel.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))}px`;
  };
  const observer = new ResizeObserver(place);
  place();
  observer.observe(panel);
  panel.querySelector('input')?.focus({ preventScroll: true });
  return () => observer.disconnect();
 }, [menu, selected?.id]);
 const openMenu = (id: string, element: HTMLElement, x?: number, y?: number) => {
  const rect = element.getBoundingClientRect();
  menuAnchor.current = element;
  setMenu({ id, x: x || rect.left, y: y || rect.top });
 };
 return <><div className="people-grid" ref={grid} style={{ gap: cardGap }}>{people.map(p => <article key={p.id} tabIndex={0} aria-label={p.local ? p.name : t("{0}. Настройки громкости: контекстное меню", p.name)} className={`person-card ${p.speaking && !p.muted ? 'speaking' : ''}`} style={compact ? undefined : card} onContextMenu={e => {
  if (p.local) return; e.preventDefault(); openMenu(p.id, e.currentTarget, e.clientX, e.clientY);
 }} onKeyDown={e => {
  if (p.local || e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
  e.preventDefault(); openMenu(p.id, e.currentTarget);
 }}>
  <div className="person-visual" data-streaming={streaming?.has(p.id) || undefined}>
    <Avatar name={p.name} image={p.avatar}/>
    <AudioStatusIcons muted={p.muted} deafened={p.deafened}
      serverMuted={p.serverMuted} serverDeafened={p.serverDeafened}/>
  </div>
  <div className="person-details"><h3 title={p.name}>{p.name}</h3><ConnectionStatus name={p.name} delay={p.rtt} loss={p.packetLoss} diagnostics={p.local ? p.diagnostics : undefined}/></div>
 </article>)}</div>
 {menu && selected && <div ref={popover} className="person-menu" role="dialog" aria-label={t("Громкость {0}", selected.name)}>
  <div className="person-menu-profile">
   <Avatar name={selected.name} image={selected.avatar}/><strong title={selected.name}>{selected.name}</strong>
  </div>
  <div className="person-menu-audio">
   <Slider label={<span className="person-menu-volume-label"><Icon name="sound" size={16}/>{t("Громкость")}</span>} value={pref.volume} min={0} max={2} step={0.05}
     format={`${Math.round(pref.volume * 100)}%`} onChange={value => onChange(selected.id, value, pref.muted)}/>
   <label className="person-menu-toggle">
    <Icon name="headphones-off" size={17}/><span>{t("Не слышать участника")}</span>
    <input type="checkbox" role="switch" checked={pref.muted} onChange={event => onChange(selected.id, pref.volume, event.target.checked)}/>
   </label>
  </div>
  {moderation && <ProtectedVoiceRestrictionControls key={`restriction:${moderation.serverId}:${moderation.sourceChannelId}:${selected.id}`}
    {...moderation} targetSessionId={selected.id}/>}
 </div>}
 </>;
}
