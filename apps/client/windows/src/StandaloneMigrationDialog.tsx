import { useEffect, useState } from 'react';
import { t } from './i18n';
import { membership } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';

export function StandaloneMigrationDialog({ serverId, onClose, onApplied }: {
  serverId: string; onClose(): void; onApplied(): void;
}) {
  const [checkpoint, setCheckpoint] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recoveryBundle, setRecoveryBundle] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    void membership<{ archiveSha256: string }>('migration.standalone.inspect', { serverId }).then(result => {
      if (active) setCheckpoint(result.archiveSha256);
    }, async failure => {
      const bundle = await membership<string | null>('migration.standalone.recovery', { serverId }).catch(() => null);
      if (!active) return;
      if (bundle) setRecoveryBundle(bundle);
      else setError(failure.message);
    });
    return () => { active = false; };
  }, [serverId]);

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const result = await membership<{ recoveryBundle: string }>('migration.standalone.confirm', { serverId, archiveSha256: checkpoint });
      setRecoveryBundle(result.recoveryBundle);
      onApplied();
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  async function copyRecovery() {
    try {
      await membership('copy', { text: recoveryBundle });
      setCopied(true);
    } catch (failure) { setError((failure as Error).message); }
  }

  return <Modal title={t('Перенос сервера на API 3')} error={error} onClose={() => { if (!busy) onClose(); }}>
    <div className="form-fields">
      {recoveryBundle ? <p>{t('Сохраните комплект восстановления в приватном месте. Он позволяет восстановить доступ владельца и ключи перенесённой истории.')}</p>
        : busy ? <p role="status">{t('Переносим историю и проверяем ключи. При обрыве перенос можно продолжить с этого устройства.')}</p>
          : checkpoint ? <p>{t('Сервер сохранил резервную копию. Подтвердите перенос участников и истории в защищённый режим.')}</p>
            : !error && <p role="status">{t('Проверяем резервную копию и права владельца…')}</p>}
    </div>
    <div className="modal-actions">
      <Button disabled={busy} onClick={onClose}>{t(recoveryBundle ? 'Готово' : 'Отмена')}</Button>
      {recoveryBundle ? <Button variant="primary" onClick={() => void copyRecovery()}>
        {t(copied ? 'Скопировано' : 'Скопировать комплект восстановления')}
      </Button> : <Button variant="primary" disabled={busy || !checkpoint} onClick={() => void confirm()}>{t('Подтвердить перенос')}</Button>}
    </div>
  </Modal>;
}
