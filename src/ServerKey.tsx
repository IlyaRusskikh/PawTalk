import { t } from './i18n';
import { useEffect, useState } from 'react';
import { generateMediaKey, mediaKeyID } from '../shared/encryption.mjs';
import { Modal } from './Modal';

export function ServerKey({ onClose }: { onClose(): void }) {
  const [pair, setPair] = useState<{ key: string; hash: string } | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  useEffect(() => {
    let cancelled = false;
    async function generate() {
      try {
        const key = generateMediaKey();
        const hash = await mediaKeyID(key);
        if (!cancelled) setPair({ key, hash });
      } catch { if (!cancelled) setError(t("Не удалось создать ключ. Закройте окно и попробуйте снова.")); }
    }
    void generate();
    return () => { cancelled = true; };
  }, []);
  async function copy(name: string, value: string) {
    try {
      if (window.desktop) await window.desktop.copyServerKey(value);
      else await navigator.clipboard.writeText(value);
      setCopied(name); setError('');
    }
    catch { setError(t("Не удалось скопировать. Выделите значение и нажмите Ctrl+C.")); }
  }
  const fields = pair ? [
    { name: 'secret', title: t("Ключ для участников"), value: pair.key, hint: t("Сохраните ключ и отправьте друзьям для подключения.") },
    { name: 'env', title: t("Настройки сервера (.env)"), value: `PAWTALK_E2EE=true\nPAWTALK_E2EE_KEY_ID=${pair.hash}`, hint: t("Добавьте эти строки в .env на VPS и перезапустите сервер. Сам ключ на VPS не нужен.") },
  ] : [];
  return <Modal title={t("Ключ шифрования для сервера")} className="server-key-modal" onClose={onClose}>
    <p className="host-hint">{t("Один ключ для вас и друзей. Настройки ниже — для вашего VPS.")}</p>
    {error && <p role="alert" className="text-error">{error}</p>}
    {!pair && !error && <p role="status">{t("Генерируем ключ…")}</p>}
    <div className="form-fields">{fields.map(field => <section className="server-key-field" key={field.name}>
      <label htmlFor={`server-key-${field.name}`}>{field.title}</label>
      <textarea id={`server-key-${field.name}`} readOnly rows={field.name === 'env' ? 3 : 2} value={field.value} spellCheck={false} onFocus={e => e.target.select()}/>
      <button className="e2ee-generate" onClick={() => void copy(field.name, field.value)}>{copied === field.name ? t("Скопировано") : t("Копировать")}</button>
      <p className="host-hint">{field.hint}</p>
    </section>)}</div>
    <p className="host-hint">{t("Сохраните ключ перед закрытием: при следующем открытии будет создан новый.")}</p>
  </Modal>;
}
