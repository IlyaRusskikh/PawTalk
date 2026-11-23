import { useEffect, useState, type FormEvent } from 'react';
import { t } from './i18n';
import { membership } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';

const bundleLimit = 4096;

type RecoveryDevice = { deviceId: string; current: boolean };

function RecoveryDeviceReview({ serverId }: { serverId: string }) {
  const [devices, setDevices] = useState<RecoveryDevice[]>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void membership<{ devices: RecoveryDevice[] }>('recovery.protected.devices', { serverId }).then(
      result => { if (active) setDevices(result.devices); },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [serverId, attempt]);

  return <section className="member-recovery-devices" aria-labelledby="recovery-device-review">
    <h3 id="recovery-device-review">{t('Устройства с доступом к серверу')}</h3>
    {failed ? <>
      <p role="alert">{t('Не удалось получить список устройств.')}</p>
      <button type="button" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>{t('Повторить')}</button>
    </> : !devices ? <p role="status">{t('Загружаем список устройств…')}</p>
      : devices.length === 0 ? <p>{t('Нет устройств для проверки.')}</p>
      : <ul>
        {devices.map(device => <li key={device.deviceId}>
          <code>{device.deviceId}</code>
          {device.current && <span>{t('Это устройство')}</span>}
        </li>)}
      </ul>}
  </section>;
}

export function RecoverySetupDialog({ serverId, serverName, onClose }: { serverId: string; serverName: string; onClose(): void }) {
  const [mode, setMode] = useState<'new' | 'saved'>();
  const [recoveryBundle, setRecoveryBundle] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [replaceRequired, setReplaceRequired] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [replacementStage, setReplacementStage] = useState<'review' | 'pending' | 'ready'>();
  const [error, setError] = useState('');

  async function generate() {
    setBusy(true);
    setError('');
    try {
      const result = await membership<{ recoveryBundle: string }>('prepareRecovery', { serverId });
      setRecoveryBundle(result.recoveryBundle);
      setMode('new');
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    setError('');
    try {
      await membership('copy', { text: recoveryBundle });
      setCopied(true);
    } catch (failure) {
      setError((failure as Error).message);
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !recoveryBundle.trim() || (mode === 'new' && !saved) || (replaceRequired && !replaceConfirmed)) return;
    const replace = replaceRequired;
    setReplaceRequired(false);
    setReplaceConfirmed(false);
    setPending(false);
    setBusy(true);
    setError('');
    try {
      const value = recoveryBundle.trim();
      if (mode === 'saved' && /^[A-Za-z0-9_-]{43}$/.test(value)) {
        const result = await membership<{ recoveryBundle: string }>('prepareRecovery', { serverId, code: value });
        setRecoveryBundle(result.recoveryBundle);
        setMode('new');
        return;
      }
      const result = await membership<{ ready: true }>('confirmRecovery', {
        serverId,
        recoveryBundle: value,
        ...(replace && { replace: true }),
      });
      if (result.ready !== true) throw Error(t('Не удалось подтвердить готовность восстановления.'));
      setRecoveryBundle('');
      setReady(true);
      if (replacementStage) setReplacementStage('ready');
    } catch (failure) {
      const rejection = failure as Error & { code?: string };
      if (rejection.code === 'RECOVERY_REPLACEMENT_CONFIRMATION_REQUIRED') {
        setReplaceRequired(true);
        setReplacementStage('review');
      } else if (rejection.code === 'PROTECTED_RECOVERY_PENDING') {
        setPending(true);
        if (replacementStage) setReplacementStage('pending');
      } else setError(rejection.message);
    } finally {
      setBusy(false);
    }
  }

  const deviceReview = replacementStage && <RecoveryDeviceReview key={replacementStage} serverId={serverId}/>;

  return <Modal title={t('Восстановление доступа · {0}', serverName)} className="member-recovery-modal" error={error} onClose={onClose}>
    {ready ? <>
      <p role="status">{t('Восстановление настроено. Сохраните набор на случай потери доступа ко всем устройствам.')}</p>
      {deviceReview}
      <div className="modal-actions"><button className="primary" autoFocus onClick={onClose}>{t('Готово')}</button></div>
    </> : !mode ? <>
      <p>{t('Резервный набор позволяет вернуться на этот сервер, если вы потеряете доступ ко всем своим устройствам.')}</p>
      <p>{t('Если у вас есть рабочее устройство, новое можно привязать к существующему профилю через него.')}</p>
      <div className="modal-actions">
        <button disabled={busy} onClick={() => { setError(''); setMode('saved'); }}>{t('Вставить сохранённый набор')}</button>
        <button className="primary" disabled={busy} onClick={() => void generate()}>
          {busy ? t('Создаём набор…') : t('Создать резервный набор')}
        </button>
      </div>
    </> : <form onSubmit={event => void confirm(event)}>
      <div className="form-fields">
        {mode === 'new' && <>
          <div>
            <p>{t('Сохраните полный набор в менеджере паролей. Запасную копию того же набора можно держать отдельно, например на зашифрованной флешке.')}</p>
            <p>{t('Храните набор как пароль. Тот, у кого он есть, сможет восстановить доступ к вашему профилю на сервере.')}</p>
          </div>
          <p>{t('Набор начнёт действовать после подтверждения настройки.')}</p>
        </>}
        {mode === 'saved' && <p>{t('Если при переносе сервера вы сохранили код, вставьте его, чтобы получить полный резервный набор.')}</p>}
        <label>{t('Резервный набор')}
          <textarea rows={4} required autoFocus autoComplete="off" spellCheck={false}
            maxLength={bundleLimit} readOnly={mode === 'new' || busy || replaceRequired} value={recoveryBundle}
            onChange={event => { setRecoveryBundle(event.target.value); setPending(false); setError(''); }}/>
        </label>
        {mode === 'new' && <>
          <div>
            <Button type="button" disabled={busy} onClick={() => void copy()}>{t('Скопировать набор')}</Button>
          </div>
          {copied && <p role="status">{t('Набор скопирован. Он может остаться в истории буфера обмена.')}</p>}
          <label className="member-confirm-check">
            <input type="checkbox" disabled={busy || replaceRequired} checked={saved} onChange={event => setSaved(event.target.checked)}/>
            {t('Я сохранил резервный набор')}
          </label>
        </>}
        {replaceRequired && <>
          <p role="alert">{t('После подтверждения прежний код сразу перестанет действовать. Уже скопированные ключи и данные останутся у тех, кто их сохранил.')}</p>
          <label className="member-confirm-check">
            <input type="checkbox" autoFocus checked={replaceConfirmed} onChange={event => setReplaceConfirmed(event.target.checked)}/>
            {t('Подтверждаю замену прежнего кода')}
          </label>
        </>}
        {deviceReview}
        {pending && <p role="status">{t('Сервер ещё готовит ключи. Повторите подтверждение с тем же набором сейчас или позже.')}</p>}
        {busy && <p role="status">{t('Проверяем ключи восстановления…')}</p>}
      </div>
      <div className="modal-actions">
        <button type="button" onClick={onClose}>{t('Закрыть')}</button>
        <button className={replaceRequired ? 'danger-button' : 'primary'}
          disabled={busy || !recoveryBundle.trim() || (mode === 'new' && !saved) || (replaceRequired && !replaceConfirmed)}>
          {replaceRequired ? t('Заменить и подтвердить') : pending ? t('Повторить подтверждение') : t('Подтвердить настройку')}
        </button>
      </div>
    </form>}
  </Modal>;
}

export function RecoverDeviceDialog({ onClose, onRecovered }: { onClose(): void; onRecovered(serverId: string): void }) {
  const [recoveryBundle, setRecoveryBundle] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !confirmed || !recoveryBundle.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await membership<{ serverId: string }>('recoverDevice', { recoveryBundle: recoveryBundle.trim() });
      setRecoveryBundle('');
      onRecovered(result.serverId);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return <Modal title={t('Потеряли доступ ко всем устройствам?')} className="member-recovery-modal"
    error={error} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={event => void recover(event)}>
      <div className="form-fields">
        <p>{t('Вставьте резервный набор для нужного сервера. Восстановление отключит все ваши прежние устройства на этом сервере.')}</p>
        <label>{t('Резервный набор')}
          <textarea rows={4} autoFocus required autoComplete="off" spellCheck={false} readOnly={busy}
            maxLength={bundleLimit} value={recoveryBundle}
            onChange={event => { setRecoveryBundle(event.target.value); setConfirmed(false); setError(''); }}/>
        </label>
        <label className="member-confirm-check">
          <input type="checkbox" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>
          {t('Подтверждаю отключение прежних устройств')}
        </label>
        {busy && <p role="status">{t('Восстанавливаем доступ…')}</p>}
      </div>
      <div className="modal-actions">
        <button type="button" disabled={busy} onClick={onClose}>{t('Отмена')}</button>
        <button className="danger-button" disabled={busy || !confirmed || !recoveryBundle.trim()}>{t('Восстановить доступ')}</button>
      </div>
    </form>
  </Modal>;
}
