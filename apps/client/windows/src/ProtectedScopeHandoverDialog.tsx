import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t, useLanguage } from './i18n';
import { membership } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';

const cardLimit = 4096;
type Candidate = { deviceId: string; originProfileId?: string };
type HandoverStatus = { ownerProfileId: string; signerDeviceId: string; localDeviceId: string; canOffer: boolean; candidates: Candidate[] };
type HandoverPreview = { signerDeviceId: string; targetDeviceId: string; expiresAt: number };
type OfferedCard = { offerCard: string; targetDeviceId: string; expiresAt: number };

const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isExpiry = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
const shortId = (id: string) => id.slice(0, 12);

function DeviceCode({ id }: { id: string }) {
  return <code title={id}>{shortId(id)}</code>;
}

export function ProtectedScopeHandoverDialog({ serverId, serverName, profileId, onClose, onChanged }: {
  serverId: string; serverName: string; profileId: string; onClose(): void; onChanged(): void;
}) {
  const language = useLanguage();
  const [status, setStatus] = useState<HandoverStatus>();
  const [unavailable, setUnavailable] = useState(false);
  const [targetDeviceId, setTargetDeviceId] = useState('');
  const [offered, setOffered] = useState<OfferedCard>();
  const [offerCard, setOfferCard] = useState('');
  const [preview, setPreview] = useState<HandoverPreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);

  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      const rejection = failure as Error & { code?: string };
      setError(rejection.code === 'EXPIRED_CHALLENGE'
        ? t('Срок карточки передачи истёк. Создайте новую на подписывающем устройстве.') : rejection.message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function load() {
    const next = await membership<HandoverStatus>('scope.protected.status', { serverId });
    if (next.ownerProfileId !== profileId) {
      setStatus(undefined);
      setUnavailable(true);
      return;
    }
    if (!isId(next.localDeviceId) || !isId(next.signerDeviceId) || typeof next.canOffer !== 'boolean' ||
        !Array.isArray(next.candidates) || (!next.canOffer && next.candidates.length > 0) ||
        (next.canOffer && next.signerDeviceId !== next.localDeviceId) ||
        next.candidates.some(candidate => !isId(candidate.deviceId) || candidate.deviceId === next.localDeviceId ||
          (candidate.originProfileId !== undefined && !isId(candidate.originProfileId))) ||
        new Set(next.candidates.map(candidate => candidate.deviceId)).size !== next.candidates.length) {
      throw Error(t('Не удалось проверить устройства для передачи подписи.'));
    }
    setStatus(next);
    setUnavailable(false);
    setTargetDeviceId('');
    setOffered(undefined);
    setOfferCard('');
    setPreview(undefined);
    setConfirmed(false);
    setCopied(false);
  }

  useEffect(() => { void run(load); }, [serverId, profileId]);

  function offer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!status?.canOffer || !status.candidates.some(candidate => candidate.deviceId === targetDeviceId)) return;
    void run(async () => {
      const result = await membership<{ offerCard: string; expiresAt: number }>('scope.protected.offer', { serverId, targetDeviceId });
      if (typeof result.offerCard !== 'string' || !result.offerCard.trim() || result.offerCard.length > cardLimit || !isExpiry(result.expiresAt)) {
        throw Error(t('Не удалось создать карточку передачи подписи.'));
      }
      setOffered({ ...result, targetDeviceId });
      setCopied(false);
    });
  }

  function receive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const card = offerCard.trim();
    if (!status || !card || status.localDeviceId === status.signerDeviceId || (preview && !confirmed)) return;
    void run(async () => {
      if (!preview) {
        const next = await membership<HandoverPreview>('scope.protected.preview', { serverId, offerCard: card });
        if (!isId(next.signerDeviceId) || next.targetDeviceId !== status.localDeviceId || next.signerDeviceId === status.localDeviceId ||
            !isExpiry(next.expiresAt)) throw Error(t('Карточка передачи подписи не подходит этому устройству.'));
        setPreview(next);
      } else {
        const result = await membership<{ signerDeviceId: string }>('scope.protected.accept', { serverId, offerCard: card });
        if (result.signerDeviceId !== preview.targetDeviceId) throw Error(t('Не удалось подтвердить передачу подписи.'));
        setOfferCard('');
        setCompleted(true);
        onChanged();
      }
    });
  }

  const expires = (value: number) => t('Действует до {0}', new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(value));
  const close = () => { if (!running.current) onClose(); };
  return <Modal title={t('Передача подписи подтверждений · {0}', serverName)} className="member-scope-handover-modal" error={error} onClose={close}>
    {completed ? <>
      <p role="status">{t('Это устройство теперь подписывает поканальные подтверждения.')}</p>
      <div className="modal-actions"><Button variant="primary" autoFocus onClick={onClose}>{t('Готово')}</Button></div>
    </> : <div className="form-fields">
        {!status && busy && <p role="status">{t('Проверяем устройства для передачи подписи…')}</p>}
        {unavailable && <p>{t('Передача подписи доступна только устройствам владельца сервера.')}</p>}
        {status && <>
          <p>{t('Поканальные подтверждения помогают клиентам проверять доступ к каналам. Право подписи можно передать другому устройству того же владельца.')}</p>
          <div className="form-grid">
            <div>{t('Это устройство')} · <DeviceCode id={status.localDeviceId}/></div>
            <div>{t('Подписывает сейчас')} · <DeviceCode id={status.signerDeviceId}/></div>
          </div>
        </>}
      {status?.canOffer && status.candidates.length > 0 ? <form onSubmit={offer}>
        <div className="form-fields">
          <label>{t('Устройство, которое примет подпись')}
            <select required disabled={busy} value={targetDeviceId} onChange={event => {
              setTargetDeviceId(event.target.value); setOffered(undefined); setCopied(false); setError('');
            }}>
              <option value="">{t('Выберите устройство')}</option>
              {status.candidates.map(candidate => <option key={candidate.deviceId} value={candidate.deviceId} title={candidate.deviceId}>
                {candidate.originProfileId && candidate.originProfileId !== status.ownerProfileId
                  ? t('Устройство {0} · профиль {1}', shortId(candidate.deviceId), shortId(candidate.originProfileId)) : shortId(candidate.deviceId)}
              </option>)}
            </select>
          </label>
          {offered && <>
            <p>{t('Карточка для устройства')} · <DeviceCode id={offered.targetDeviceId}/>. {expires(offered.expiresAt)}</p>
            <p>{t('Откройте передачу подписи на выбранном устройстве, вставьте карточку и подтвердите получение.')}</p>
            <label>{t('Карточка передачи подписи')}<textarea rows={3} readOnly value={offered.offerCard} spellCheck={false}/></label>
            <div><Button type="button" disabled={busy} onClick={() => void run(async () => {
              await membership('copy', { text: offered.offerCard });
              setCopied(true);
            })}>{t('Скопировать карточку')}</Button></div>
            {copied && <p role="status">{t('Карточка скопирована.')}</p>}
          </>}
        </div>
        <div className="modal-actions">
          <Button type="button" disabled={busy} onClick={() => void run(load)}>{t('Обновить')}</Button>
          <Button variant="primary" disabled={busy || !targetDeviceId}>
            {offered ? t('Создать новую карточку') : t('Создать карточку передачи')}
          </Button>
        </div>
      </form> : status && status.localDeviceId !== status.signerDeviceId ? <form onSubmit={receive}>
        <div className="form-fields">
          <p>{t('Получите карточку передачи на устройстве, которое сейчас подписывает подтверждения.')}</p>
          <label>{t('Карточка передачи подписи')}
            <textarea rows={3} required maxLength={cardLimit} autoComplete="off" spellCheck={false}
              value={offerCard} readOnly={busy} onChange={event => {
                setOfferCard(event.target.value); setPreview(undefined); setConfirmed(false); setError('');
              }}/>
          </label>
          {preview && <>
            <div className="form-grid">
              <div>{t('Передаёт подпись')} · <DeviceCode id={preview.signerDeviceId}/></div>
              <div>{t('Примет подпись')} · <DeviceCode id={preview.targetDeviceId}/></div>
            </div>
            <p>{expires(preview.expiresAt)}</p>
            <label className="member-confirm-check">
              <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/>
              {t('Я подтверждаю, что это устройство будет подписывать поканальные подтверждения')}
            </label>
          </>}
        </div>
        <div className="modal-actions">
          <Button type="button" disabled={busy} onClick={() => void run(load)}>{t('Обновить')}</Button>
          <Button variant="primary" disabled={busy || !offerCard.trim() || (!!preview && !confirmed)}>
            {preview ? t('Принять подпись') : t('Проверить карточку')}
          </Button>
        </div>
      </form> : <>
        {status && <p>{t('У профиля владельца нет другого устройства, которому можно передать подпись.')}</p>}
        <div className="modal-actions">
          <Button disabled={busy} onClick={() => void run(load)}>{t('Обновить')}</Button>
          <Button variant="primary" disabled={busy} onClick={onClose}>{t('Закрыть')}</Button>
        </div>
      </>}
    </div>}
  </Modal>;
}
