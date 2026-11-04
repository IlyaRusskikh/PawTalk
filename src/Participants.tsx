import { useEffect, useState } from 'react';
import { Icon, Slider } from './Controls';
import type { Person } from './session';
export function Participants({ people, prefs, onChange }: { people: Person[]; prefs: Record<string, { volume: number; muted: boolean }>; onChange(id: string, volume: number, muted: boolean): void }) {
 const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
 useEffect(() => {
  const close = () => setMenu(null);
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  window.addEventListener('pointerdown', close); window.addEventListener('resize', close); window.addEventListener('scroll', close, true); window.addEventListener('keydown', key);
  return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', key); };
 }, []);
 const selected = menu && people.find(p => p.id === menu.id && !p.local);
 const pref = selected ? prefs[selected.id] || { volume: 1, muted: false } : { volume: 1, muted: false };
 return <><div className="people-grid">{people.map((p, index) => <article key={p.id} tabIndex={p.local ? undefined : 0} aria-label={p.local ? p.name : `${p.name}. Настройки громкости: контекстное меню`} className={`person-card ${p.speaking && !p.muted ? 'speaking' : ''}`} onContextMenu={e => {
  if (p.local) return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect();
  setMenu({ id: p.id, x: Math.max(8, Math.min(e.clientX || rect.left, window.innerWidth - 276)), y: Math.max(8, Math.min(e.clientY || rect.top, window.innerHeight - 190)) });
 }}>
  <div className="person-top"><span>{p.muted ? 'Микрофон выкл.' : p.speaking ? 'Говорит' : 'Слушает'}</span><button className="icon-button person-network" aria-label={`Соединение ${p.name}`} title={`Пинг до сервера: ${p.rtt === undefined ? 'нет свежих данных' : `${Math.round(p.rtt)} мс`}\nКачество: ${p.quality}`}><Icon name="signal" size={15}/></button></div>
  <div className={`avatar color-${index % 4}`}>{p.name.slice(0,1).toUpperCase()}</div><h3>{p.name} {p.local && <small>ВЫ</small>}</h3>
  {prefs[p.id]?.muted && <small className="person-local-mute">Звук выключен у вас</small>}
 </article>)}</div>
 {menu && selected && <div className="person-menu" role="dialog" aria-label={`Громкость ${selected.name}`} style={{ left: menu.x, top: menu.y }} onPointerDown={e => e.stopPropagation()}><strong>{selected.name}</strong><Slider label="Громкость" value={pref.volume} min={0} max={2} step={0.05} format={`${Math.round(pref.volume * 100)}%`} onChange={value => onChange(selected.id, value, pref.muted)}/><label className="inline-check"><input type="checkbox" checked={pref.muted} onChange={e => onChange(selected.id, pref.volume, e.target.checked)}/>Не слышать участника</label></div>}
 </>;
}
