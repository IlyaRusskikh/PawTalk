import { type ReactNode } from 'react';
import { Icon } from './Controls';
import { t } from './i18n';

export type SettingsSection = 'profile' | 'voice' | 'input' | 'processing' | 'shortcuts' | 'appearance' | 'chat' | 'general' | 'updates';
export function SettingsShell({ section, onChange, children }: { section: SettingsSection; onChange(section: SettingsSection): void; children: ReactNode }) {
  const items: { id: SettingsSection; label: string; icon: string }[] = [
    { id: 'profile', label: t("Обо мне"), icon: 'user' },
    { id: 'voice', label: t("Звук и устройства"), icon: 'headphones' },
    { id: 'input', label: t("Режим ввода"), icon: 'mic' },
    { id: 'processing', label: t("Обработка голоса"), icon: 'wave' },
    { id: 'shortcuts', label: t("Сочетания клавиш"), icon: 'keyboard' },
    { id: 'appearance', label: t("Оформление"), icon: 'palette' },
    { id: 'chat', label: t("Чат"), icon: 'chat' },
    { id: 'general', label: t("Приложение"), icon: 'settings' },
    { id: 'updates', label: t("Обновления"), icon: 'download' },
  ];
  return <div className="settings-layout"><nav className="settings-nav" role="tablist" aria-label={t("Разделы настроек")} aria-orientation="vertical" onKeyDown={event => {
    const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (items.findIndex(item => item.id === section) + direction + items.length) % items.length;
    onChange(items[index].id); document.getElementById(`settings-tab-${items[index].id}`)?.focus();
  }}><div className="settings-nav-caption">VOICECORD</div>{items.map(item => <button type="button" key={item.id} role="tab" id={`settings-tab-${item.id}`} aria-controls="settings-panel" aria-selected={section === item.id} tabIndex={section === item.id ? 0 : -1} onClick={() => onChange(item.id)}><Icon name={item.icon} size={18}/>{item.label}</button>)}</nav>
    <div className="settings-panel" role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${section}`} tabIndex={0} key={section}>{children}</div>
  </div>;
}
