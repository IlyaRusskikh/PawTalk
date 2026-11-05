import { t } from './i18n';
import { useState } from 'react';
import { Modal } from './Modal';
export function GuestShare({ target, name, onClose }: { target: { address: string; password: string; e2eeKey?: string }; name: string; onClose(): void }) {
 const [copied, setCopied] = useState(false); const [error, setError] = useState('');
 const url = target.address.startsWith('voicecord://') ? new URL(target.address) : null;
 if (url) { const old = new URLSearchParams(url.hash.slice(1)); const params = new URLSearchParams({ password: old.get('password') ?? target.password, name }); const key = target.e2eeKey ?? old.get('e2ee'); if (key) params.set('e2ee', key); url.hash = params.toString(); }
 const link = url?.toString() || target.address;
 async function copy() {
  try { if (url && window.desktop) await window.desktop.copyInvitation(link); else await navigator.clipboard.writeText(link); setCopied(true); }
  catch { setError(t("Не удалось скопировать. Выделите ссылку и нажмите Ctrl+C.")); }
 }
 return <Modal title={t("Поделиться комнатой")} onClose={onClose}>
  {error && <p className="text-error" role="alert">{error}</p>}<div className="form-fields"><label className="host-invite">{url ? t("Ссылка приглашения") : t("Адрес сервера")}<div><input readOnly value={link} onFocus={e => e.target.select()}/><button className="primary" onClick={() => void copy()}>{copied ? t("Скопировано") : t("Копировать")}</button></div></label>
  {!url && <label>{t("Пароль сервера")}<input readOnly value={target.password} onFocus={e => e.target.select()}/></label>}
  {!url && target.e2eeKey && <label>{t("Ключ E2EE")}<input readOnly value={target.e2eeKey} onFocus={e => e.target.select()}/></label>}
  </div><p className="host-hint">{url ? t("Другу нужен Voicecord. Пароль уже включён в ссылку. Адрес доступен из той же сети, из которой подключились вы.") : t("Отправьте другу адрес и пароль. Для подключения нужен Voicecord.")}</p>
 </Modal>;
}
