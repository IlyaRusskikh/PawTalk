import { useEffect, useState } from 'react';
import { t } from './i18n';
import { membership } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';

type Device = { deviceId: string; current: boolean };

export function ProtectedOwnDeviceList({ serverId, canRevoke }: { serverId: string; canRevoke: boolean }) {
  const [devices, setDevices] = useState<Device[]>();
  const [target, setTarget] = useState<Device>();
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [revokeError, setRevokeError] = useState('');
  const [revoked, setRevoked] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void membership<{ devices: Device[] }>('device.protected.list', { serverId }).then(
      result => { if (active) setDevices(result.devices); },
      error => { if (active) setLoadError(error.message); },
    );
    return () => { active = false; };
  }, [serverId, attempt]);

  async function revoke() {
    if (!target || busy) return;
    setBusy(true);
    setRevokeError('');
    try {
      await membership('device.protected.revoke', { serverId, deviceId: target.deviceId });
      setDevices(current => current?.filter(device => device.deviceId !== target.deviceId));
      setTarget(undefined);
      setRevoked(true);
    } catch (error) {
      setRevokeError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="profile-device-list">
    <h3>{t('Связанные устройства')}</h3>
    {loadError ? <>
      <p role="alert">{loadError}</p>
      <Button onClick={() => { setLoadError(''); setAttempt(value => value + 1); }}>{t('Повторить')}</Button>
    </> : !devices ? <p role="status">{t('Загружаем список устройств…')}</p> :
      devices.map(device => <div className="member-management-row" key={device.deviceId}>
        <div>
          <strong>{t(device.current ? 'Это устройство' : 'Связанное устройство')}</strong>
          <code>{device.deviceId}</code>
        </div>
        {canRevoke && !device.current && <Button onClick={() => {
          setRevoked(false); setRevokeError(''); setTarget(device);
        }}>{t('Отозвать доступ')}</Button>}
      </div>)}
    {revoked && <p role="status">{t('Доступ устройства отозван.')}</p>}
    {target && <Modal title={t('Отозвать доступ устройства')} error={revokeError} onClose={() => { if (!busy) setTarget(undefined); }}>
      <p>{t('Это устройство потеряет доступ к профилю на этом сервере. Остальные устройства останутся подключены.')}</p>
      <code>{target.deviceId}</code>
      <div className="modal-actions">
        <Button autoFocus disabled={busy} onClick={() => setTarget(undefined)}>{t('Отмена')}</Button>
        <Button variant="danger" disabled={busy} onClick={() => void revoke()}>{t('Отозвать доступ')}</Button>
      </div>
    </Modal>}
  </section>;
}
