import { useEffect, useRef, useState } from 'react';
import { t, useLanguage } from './i18n';
import { membership, type TimeoutStatus } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';

const presets = [1, 5, 60, 1440, 10080, 40320];

export function ProtectedTimeoutDialog({ serverId, profileId, name, onClose, onApplied }: {
  serverId: string; profileId: string; name: string; onClose: () => void; onApplied: () => void;
}) {
  const language = useLanguage();
  const [status, setStatus] = useState<TimeoutStatus>();
  const [minutes, setMinutes] = useState('5');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ durationSeconds: number; reason: string; operationId: string } | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void membership<TimeoutStatus>('moderation.protected.timeout.read', { serverId, profileId }).then(result => {
      if (active) setStatus(result);
    }).catch(failure => {
      if (active) setError(failure.message);
    });
    return () => { active = false; };
  }, [serverId, profileId]);

  const duration = Number(minutes);
  const validDuration = Number.isInteger(duration) && duration >= 1 && duration <= 40320;
  const trimmed = reason.trim();
  const validReason = trimmed.length > 0 && [...trimmed].length <= 200 && !/[\p{Cc}\p{Cs}]/u.test(trimmed);
  async function apply(lift: boolean) {
    if (busy || !validReason || (lift ? !status?.canLift : !status?.canSet || !validDuration)) return;
    const durationSeconds = lift ? 0 : duration * 60;
    if (attempt.current?.durationSeconds !== durationSeconds || attempt.current.reason !== trimmed) {
      attempt.current = { durationSeconds, reason: trimmed, operationId: crypto.randomUUID().replaceAll('-', '') };
    }
    setBusy(true);
    setError('');
    try {
      await membership('moderation.protected.timeout.change', { serverId, profileId, ...attempt.current });
      onApplied();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <Modal title={t('Тайм-аут участника')} onClose={() => { if (!busy) onClose(); }} error={error}>
    <form className="form-fields" onSubmit={event => { event.preventDefault(); void apply(!status?.canSet); }}>
      <strong>{name}</strong>
      {!!status?.deadline && <div role="status">
        <p>{t('Тайм-аут на сервере до {0}', new Date(status.deadline).toLocaleString(language))}</p>
        {status.reason && <p>{t('Причина: {0}', status.reason)}</p>}
      </div>}
      {status && !status.canSet && !status.canLift && <p>{t('Нет доступных действий с тайм-аутом.')}</p>}
      {status?.canSet && <>
        <label>{t('Готовая длительность')}<select value={presets.includes(duration) ? minutes : ''} disabled={busy}
          onChange={event => { if (event.target.value) setMinutes(event.target.value); }}>
          <option value="">{t('Ручной ввод')}</option>
          {presets.map(value => <option value={value} key={value}>{t('{0} мин', value)}</option>)}
        </select></label>
        <label>{t('Длительность в минутах')}<input type="number" value={minutes} min={1} max={40320} step={1}
          disabled={busy} onChange={event => setMinutes(event.target.value)}/></label>
      </>}
      {(status?.canLift || status?.canSet) && <label>{t('Причина')}<input value={reason} required maxLength={200}
        list="protected-timeout-reasons" disabled={busy} onChange={event => setReason(event.target.value)}/>
        <datalist id="protected-timeout-reasons">
          {status.canSet && <><option value={t('Нарушение правил сервера')}/><option value={t('Спам')}/></>}
          {status.canLift && <option value={t('Ограничение больше не требуется')}/>}
        </datalist>
      </label>}
      <div className="modal-actions">
        <Button type="button" disabled={busy} onClick={onClose}>{t('Отмена')}</Button>
        {status?.canLift && <Button type={status.canSet ? 'button' : 'submit'} disabled={busy || !validReason}
          onClick={status.canSet ? () => void apply(true) : undefined}>{t('Снять тайм-аут')}</Button>}
        {status?.canSet && <Button type="submit" variant="danger" disabled={busy || !validReason || !validDuration}>
          {t('Назначить тайм-аут')}
        </Button>}
      </div>
    </form>
  </Modal>;
}
