import { useEffect, useState } from 'react';
import { t, useLanguage } from './i18n';
import { membership } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';

type Action = 'kick' | 'ban';
type CleanupPreview = { id: string; count: number };
type CleanupResult = { cleanup: 'done'; removed: number } | { cleanup: 'failed' };
type Ban = { profileId: string; reason: string; expiresAt: number };
type BanPage = { bans: Ban[]; next?: string };

export function ProtectedMemberModeration({ serverId, profileId, name, action, onClose }: {
  serverId: string; profileId: string; name: string; action: Action; onClose: () => void;
}) {
  const [duration, setDuration] = useState('3600000');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [window, setWindow] = useState('none');
  const [preview, setPreview] = useState<CleanupPreview>();
  const [result, setResult] = useState<CleanupResult>();
  const title = action === 'kick' ? t('Исключить с сервера') : t('Заблокировать');
  const trimmed = reason.trim();
  const validReason = !!trimmed && [...trimmed].length <= 200 && !/[\p{Cc}\p{Cs}]/u.test(trimmed);
  async function previewCleanup() {
    setBusy(true);
    setError('');
    setPreview(undefined);
    try {
      setPreview(await membership<CleanupPreview>('moderation.protected.cleanup.preview', { serverId, profileId, action, window }));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (busy || !validReason || (window !== 'none' && !preview)) return;
    setBusy(true);
    setError('');
    try {
      const expiresAt = action === 'ban' && Number(duration) > 0 ? Date.now() + Number(duration) : 0;
      const outcome = await membership<true | CleanupResult>('moderation.protected.member.change', {
        serverId, profileId, action, reason: trimmed, expiresAt, ...(preview && { cleanupId: preview.id }),
      });
      if (outcome === true) onClose();
      else setResult(outcome);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (result) return <Modal title={title} onClose={onClose}>
    <p>{action === 'ban' ? t('Участник заблокирован.') : t('Участник исключён с сервера.')}</p>
    <p role="status">{result.cleanup === 'done' ? `${t('Удалено сообщений')} · ${result.removed}` : t('Не удалось подтвердить очистку сообщений.')}</p>
    <div className="modal-actions"><Button onClick={onClose}>{t('Готово')}</Button></div>
  </Modal>;
  return <Modal title={title} error={error} onClose={() => { if (!busy) onClose(); }}>
    <form className="form-fields" onSubmit={event => { event.preventDefault(); void apply(); }}>
      <strong>{name}</strong>
      {action === 'ban' && <label>{t('Срок действия')}
        <select value={duration} disabled={busy} onChange={event => setDuration(event.target.value)}>
          <option value="3600000">{t('1 час')}</option>
          <option value="86400000">{t('24 часа')}</option>
          <option value="604800000">{t('7 дней')}</option>
          <option value="0">{t('Навсегда')}</option>
        </select>
      </label>}
      <label>{t('Причина')}
        <input autoFocus required maxLength={200} list="protected-removal-reasons" value={reason}
          disabled={busy} onChange={event => setReason(event.target.value)}/>
        <datalist id="protected-removal-reasons">
          <option value={t('Нарушение правил сервера')}/>
          <option value={t('Спам')}/>
        </datalist>
      </label>
      <label>{t('Очистка сообщений')}
        <select value={window} disabled={busy} onChange={event => { setWindow(event.target.value); setPreview(undefined); }}>
          <option value="none">{t('Не удалять')}</option>
          <option value="hour">{t('1 час')}</option>
          <option value="day">{t('24 часа')}</option>
          <option value="week">{t('7 дней')}</option>
          <option value="all">{t('Вся доступная история')}</option>
        </select>
      </label>
      {window !== 'none' && <div className="modal-actions">
        {preview && <span role="status">{t('Сообщений к удалению')} · {preview.count}</span>}
        <Button type="button" disabled={busy} onClick={() => void previewCleanup()}>{t('Предпросмотр')}</Button>
      </div>}
      <div className="modal-actions">
        <Button type="button" disabled={busy} onClick={onClose}>{t('Отмена')}</Button>
        <Button type="submit" variant="danger" disabled={!validReason || busy || (window !== 'none' && !preview)}>{title}</Button>
      </div>
    </form>
  </Modal>;
}

export function ProtectedBansDialog({ serverId, onClose, inline }: { serverId: string; onClose: () => void; inline?: boolean }) {
  const language = useLanguage();
  const [page, setPage] = useState<BanPage>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  async function load(after?: string) {
    const result = await membership<BanPage>('moderation.protected.bans', { serverId, after });
    setPage(previous => after && previous ? { ...result, bans: [...previous.bans, ...result.bans] } : result);
  }
  useEffect(() => { void run(() => load()); }, [serverId]);
  return <Modal inline={inline} title={t('Заблокированные участники')} error={error} onClose={onClose}>
    {!page && busy && <p role="status">{t('Подключение…')}</p>}
    {page && <div className="member-management-list">
      {!page.bans.length && <p className="host-hint">{t('Нет действующих блокировок.')}</p>}
      {page.bans.map(ban => <div className="member-management-row" key={ban.profileId}>
        <div><strong>{t('Участник · {0}', ban.profileId.slice(0, 8))}</strong>
          <small>{ban.expiresAt === 0 ? t('Навсегда') : ban.expiresAt <= 8_640_000_000_000_000
            ? t('До {0}', new Date(ban.expiresAt).toLocaleString(language)) : t('Дата окончания вне диапазона календаря')}</small>
          {ban.reason && <small>{t('Причина: {0}', ban.reason)}</small>}
        </div>
        <Button disabled={busy} onClick={() => void run(async () => {
          await membership('moderation.protected.member.change', { serverId, profileId: ban.profileId, action: 'unban' });
          await load();
        })}>{t('Снять блокировку')}</Button>
      </div>)}
      {page.next && <Button disabled={busy} onClick={() => void run(() => load(page.next))}>{t('Показать ещё')}</Button>}
    </div>}
  </Modal>;
}
