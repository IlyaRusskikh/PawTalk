import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Controls';
import { t } from './i18n';

export type SettingsSection = 'profile' | 'voice' | 'sounds' | 'shortcuts' | 'appearance' | 'chat' | 'general' | 'updates' | 'language';
export function settingsPage(section: SettingsSection) {
  if (section === 'voice' || section === 'sounds') return 'audio';
  if (section === 'general' || section === 'shortcuts' || section === 'updates') return 'system';
  return section;
}
export function SettingsShell({ section, onChange, children }: { section: SettingsSection; onChange(section: SettingsSection): void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(section);
  const page = settingsPage(section);
  const scrollToSection = (target: SettingsSection) => {
    const container = panel.current;
    if (!container) return;
    const anchor = container.querySelector<HTMLElement>(`#settings-anchor-${target}`);
    const inset = parseFloat(getComputedStyle(container).paddingTop);
    const heading = anchor?.querySelector('h1, h2') ?? anchor;
    const top = heading ? container.scrollTop + heading.getBoundingClientRect().top - container.getBoundingClientRect().top - inset : 0;
    container.scrollTo({ top, behavior: 'auto' });
    setActive(target);
  };
  useLayoutEffect(() => { scrollToSection(section); }, [section]);
  const navigate = (target: SettingsSection) => {
    if (target === section) scrollToSection(target);
    onChange(target);
  };
  const items: { id: SettingsSection; label: string; icon: string; group?: string; child?: boolean }[] = [
    { id: 'profile', label: t("Обо мне"), icon: 'user', group: t("Настройки пользователя") },
    { id: 'voice', label: t("Голос"), icon: 'mic', group: t("Звук и устройства"), child: true },
    { id: 'sounds', label: t("Звуки"), icon: 'sound', child: true },
    { id: 'appearance', label: t("Оформление"), icon: 'palette', group: t("Приложение") },
    { id: 'chat', label: t("Чат"), icon: 'chat' },
    { id: 'general', label: t("Основные"), icon: 'settings', group: t("Система"), child: true },
    { id: 'shortcuts', label: t("Сочетания клавиш"), icon: 'keyboard', child: true },
    { id: 'updates', label: t("Обновления"), icon: 'download', child: true },
    { id: 'language', label: t("Язык"), icon: 'settings', group: t("Регион") },
  ];
  return <div className="settings-layout"><nav className="settings-nav" role="tablist" aria-label={t("Разделы настроек")} aria-orientation="vertical" onKeyDown={event => {
    const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (items.findIndex(item => item.id === active) + direction + items.length) % items.length;
    navigate(items[index].id); document.getElementById(`settings-tab-${items[index].id}`)?.focus();
  }}><div className="settings-nav-caption">PAWTALK</div>{items.map(item => <Fragment key={item.id}>{item.group && <div className="settings-nav-group" role="presentation">{item.group}</div>}<button className={item.child ? 'settings-nav-child' : undefined} type="button" key={item.id} role="tab" id={`settings-tab-${item.id}`} aria-controls={item.child ? `settings-anchor-${item.id}` : 'settings-panel'} aria-selected={active === item.id} tabIndex={active === item.id ? 0 : -1} onClick={() => navigate(item.id)}><Icon name={item.icon} size={18}/>{item.label}</button></Fragment>)}</nav>
    <div ref={panel} className="settings-panel" role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${active}`} tabIndex={0} key={page} onScroll={() => {
      const container = panel.current;
      if (!container) return;
      const anchors = Array.from(container.querySelectorAll<HTMLElement>('[id^="settings-anchor-"]'));
      const line = container.getBoundingClientRect().top + parseFloat(getComputedStyle(container).paddingTop) + 2;
      const current = anchors.filter(anchor => (anchor.querySelector('h1, h2') ?? anchor).getBoundingClientRect().top <= line).at(-1) ?? anchors[0];
      if (current) setActive(current.id.replace('settings-anchor-', '') as SettingsSection);
    }}><div className="settings-content">{children}</div></div>
  </div>;
}
