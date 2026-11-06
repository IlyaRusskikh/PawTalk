import { t } from './i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, Slider } from './Controls';
import type { Person } from './session';
import { ConnectionStatus } from './ConnectionStatus';
import { Avatar } from './Avatar';

const cardWidth = 160;
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

export function Participants({ people, prefs, onChange }: { people: Person[]; prefs: Record<string, { volume: number; muted: boolean }>; onChange(id: string, volume: number, muted: boolean): void }) {
 const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
 const grid = useRef<HTMLDivElement>(null);
 const [space, setSpace] = useState({ width: 0, height: 0 });
 useLayoutEffect(() => {
  const observer = new ResizeObserver(([entry]) => {
   const { width, height } = entry.contentRect;
   setSpace({ width, height });
  });
  observer.observe(grid.current!);
  return () => observer.disconnect();
 }, []);
 const card = fitCards(people.length, space.width, space.height);
 useEffect(() => {
  const close = () => setMenu(null);
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  window.addEventListener('pointerdown', close); window.addEventListener('resize', close); window.addEventListener('scroll', close, true); window.addEventListener('keydown', key);
  return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', key); };
 }, []);
 const selected = menu && people.find(p => p.id === menu.id && !p.local);
 const pref = selected ? prefs[selected.id] || { volume: 1, muted: false } : { volume: 1, muted: false };
 return <><div className="people-grid" ref={grid} style={{ gap: cardGap }}>{people.map(p => <article key={p.id} tabIndex={0} aria-label={p.local ? p.name : t("{0}. Настройки громкости: контекстное меню", p.name)} className={`person-card ${p.speaking && !p.muted ? 'speaking' : ''}`} style={card} onContextMenu={e => {
  if (p.local) return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect();
  setMenu({ id: p.id, x: Math.max(8, Math.min(e.clientX || rect.left, window.innerWidth - 276)), y: Math.max(8, Math.min(e.clientY || rect.top, window.innerHeight - 190)) });
 }}>
  <div className="person-visual">
    <Avatar name={p.name} image={p.avatar}/>
    <span className="person-status-icons">{p.muted && <span title={t("Микрофон выключен")} aria-label={t("Микрофон выключен")}><Icon name="mic-off" size={15}/></span>}{(p.deafened || prefs[p.id]?.muted) && <span title={p.deafened ? t("Участник отключил звук") : t("Звук выключен у вас")} aria-label={p.deafened ? t("Участник отключил звук") : t("Звук выключен у вас")}><Icon name="headphones-off" size={15}/></span>}</span>
  </div>
  <div className="person-details"><h3 title={p.name}>{p.name}</h3><ConnectionStatus name={p.name} delay={p.rtt} loss={p.packetLoss}/></div>
 </article>)}</div>
 {menu && selected && <div className="person-menu" role="dialog" aria-label={t("Громкость {0}", selected.name)} style={{ left: menu.x, top: menu.y }} onPointerDown={e => e.stopPropagation()}><strong>{selected.name}</strong><Slider label={t("Громкость")} value={pref.volume} min={0} max={2} step={0.05} format={`${Math.round(pref.volume * 100)}%`} onChange={value => onChange(selected.id, value, pref.muted)}/><label className="inline-check"><input type="checkbox" checked={pref.muted} onChange={e => onChange(selected.id, pref.volume, e.target.checked)}/>{t("Не слышать участника")}</label></div>}
 </>;
}
