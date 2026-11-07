import { t } from './i18n';

export function loadChatWindow() {
  try { const value = Number(localStorage.getItem('voicecord.chat.window')); return Number.isInteger(value) && value >= 25 && value <= 500 ? value : 100; } catch { return 100; }
}
export function ChatSettings({ value, onChange }: { value: number; onChange(value: number): void }) {
  return <section className="settings-card"><h1>{t("Чат")}</h1><p className="settings-description">{t("Сколько сообщений держать открытыми одновременно.")}</p>
    <div className="form-fields"><label>{t("Сообщений в окне чата")}<select value={value} onChange={event => onChange(Number(event.target.value))}>{[25, 50, 75, 100, 150, 200, 300, 400, 500].map(size => <option key={size} value={size}>{size}{size === 100 ? t(" — по умолчанию") : ''}</option>)}</select></label></div>
    <p>{t("Старые сообщения подгружаются при прокрутке. Изображения вне просмотра освобождаются из памяти. Большое окно использует больше памяти.")}</p>
  </section>;
}
