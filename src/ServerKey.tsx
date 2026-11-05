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
      } catch { if (!cancelled) setError('Не удалось создать ключ. Закройте окно и попробуйте снова.'); }
    }
    void generate();
    return () => { cancelled = true; };
  }, []);
  async function copy(name: string, value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(name); setError(''); }
    catch { setError('Не удалось скопировать. Выделите значение и нажмите Ctrl+C.'); }
  }
  const fields = pair ? [
    { name: 'secret', title: 'Секретный ключ E2EE', value: pair.key, hint: 'Сохраните у себя и не передавайте незнакомым людям. Этот ключ нужен вам и участникам комнаты для подключения.' },
    { name: 'hash', title: 'Хэш ключа (SHA-256)', value: pair.hash, hint: 'Запишите этот хэш в конфиг сервера: VOICECORD_E2EE_KEY_ID. Сам секретный ключ на VPS не копируйте.' },
    { name: 'env', title: 'Готовые строки для .env сервера', value: `VOICECORD_E2EE=true\nVOICECORD_E2EE_KEY_ID=${pair.hash}`, hint: 'Добавьте или замените эти строки в .env перед запуском контейнера. Если сервер уже работает, примените обновлённую конфигурацию.' },
  ] : [];
  return <Modal title="Ключ шифрования для сервера" className="server-key-modal" onClose={onClose}>
    <p className="host-hint">Ключ создаётся на вашем компьютере. Подключение к серверу не требуется.</p>
    {error && <p role="alert" className="text-error">{error}</p>}
    {!pair && !error && <p role="status">Генерируем ключ…</p>}
    {fields.map(field => <section className="server-key-field" key={field.name}>
      <label htmlFor={`server-key-${field.name}`}>{field.title}</label>
      <textarea id={`server-key-${field.name}`} readOnly rows={field.name === 'env' ? 3 : 2} value={field.value} spellCheck={false} onFocus={e => e.target.select()}/>
      <button className="e2ee-generate" onClick={() => void copy(field.name, field.value)}>{copied === field.name ? 'Скопировано' : 'Копировать'}</button>
      <p className="host-hint">{field.hint}</p>
    </section>)}
    <p className="host-hint">Сохраните ключ до закрытия окна: приложение его не запоминает. При новом открытии создаётся другая пара ключа и хэша. Для всех участников используйте один и тот же ключ.</p>
  </Modal>;
}
