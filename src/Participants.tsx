import { t } from './i18n';
import { useEffect, useState } from 'react';
import { Icon, Slider } from './Controls';
import type { Person } from './session';
import { pingLevel } from '../shared/ping.mjs';
import { qualityLabel } from './quality';
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
 return <><div className="people-grid">{people.map((p, index) => <article key={p.id} tabIndex={p.local ? undefined : 0} aria-label={p.local ? p.name : t("{0}. Настройки громкости: контекстное меню", p.name)} className={`person-card ${p.speaking && !p.muted ? 'speaking' : ''}`} onContextMenu={e => {
  if (p.local) return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect();
  setMenu({ id: p.id, x: Math.max(8, Math.min(e.clientX || rect.left, window.innerWidth - 276)), y: Math.max(8, Math.min(e.clientY || rect.top, window.innerHeight - 190)) });
 }}>
  <div className="person-top"><span className="person-status-icons">{p.muted && <span title={t("Микрофон выключен")} aria-label={t("Микрофон выключен")}><Icon name="mic-off" size={15}/></span>}{(p.deafened || prefs[p.id]?.muted) && <span title={p.deafened ? t("Участник отключил звук") : t("Звук выключен у вас")} aria-label={p.deafened ? t("Участник отключил звук") : t("Звук выключен у вас")}><Icon name="headphones-off" size={15}/></span>}</span><button className={`icon-button person-network ping-${pingLevel(p.rtt)}`} aria-label={t("Соединение {0}", p.name)} title={t("Пинг до сервера: {0}\nКачество: {1}", p.rtt === undefined ? t("нет свежих данных") : t("{0} мс", Math.round(p.rtt)), qualityLabel(p.quality))}><Icon name="signal" size={15}/></button></div>
  <div className={`avatar color-${index % 4}`}>{p.name.slice(0,1).toUpperCase()}</div><h3>{p.name} {p.local && <small>{t("ВЫ")}</small>}</h3>
 </article>)}</div>
 {menu && selected && <div className="person-menu" role="dialog" aria-label={t("Громкость {0}", selected.name)} style={{ left: menu.x, top: menu.y }} onPointerDown={e => e.stopPropagation()}><strong>{selected.name}</strong><Slider label={t("Громкость")} value={pref.volume} min={0} max={2} step={0.05} format={`${Math.round(pref.volume * 100)}%`} onChange={value => onChange(selected.id, value, pref.muted)}/><label className="inline-check"><input type="checkbox" checked={pref.muted} onChange={e => onChange(selected.id, pref.volume, e.target.checked)}/>{t("Не слышать участника")}</label></div>}
 </>;
}
