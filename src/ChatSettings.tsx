import { t } from './i18n';

export function loadChatWindow() {
  // Preserve the existing preference; it now controls page size, not eviction.
  try { const value = Number(localStorage.getItem('pawtalk.chat.window')); return Number.isInteger(value) && value >= 25 && value <= 500 ? value : 100; } catch { return 100; }
}
export function ChatSettings({ value, onChange }: { value: number; onChange(value: number): void }) {
  return <section className="settings-card"><h1>{t("Чат")}</h1><p className="settings-description">{t("Сколько сообщений загружать за один раз.")}</p>
    <div className="form-fields"><label>{t("Сообщений в одной порции")}<select value={value} onChange={event => onChange(Number(event.target.value))}>{[25, 50, 75, 100, 150, 200, 300, 400, 500].map(size => <option key={size} value={size}>{size}{size === 100 ? t(" — по умолчанию") : ''}</option>)}</select></label></div>
    <p>{t("История автоматически подгружается при прокрутке. Загруженные сообщения остаются в памяти до выхода из чата или нехватки памяти. Изображения загружаются по мере просмотра.")}</p>
  </section>;
}
