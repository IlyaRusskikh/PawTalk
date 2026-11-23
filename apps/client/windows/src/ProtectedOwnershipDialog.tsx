import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t, useLanguage } from './i18n';
import { membership } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';

type Offer = { operationId: string; ownerProfileId: string; targetProfileId: string; expiresAt: number; outgoing: boolean };
type Ownership = { ownerProfileId: string; canOffer: boolean; offer?: Offer };
type Member = { id: string; name?: string };
type Roster = { revision: number; next?: string; members: Member[] };

const memberLabel = (id: string, name?: string) => name ? `${name} · ${id.slice(0, 8)}` : t('Участник · {0}', id.slice(0, 8));

export function ProtectedOwnershipDialog({ serverId, serverName, profileId, onClose, onAccepted }: {
  serverId: string; serverName: string; profileId: string; onClose(): void; onAccepted(): void;
}) {
  const language = useLanguage();
  const [ownership, setOwnership] = useState<Ownership>();
  const [roster, setRoster] = useState<Roster>();
  const [targetProfileId, setTargetProfileId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [accepted, setAccepted] = useState(false);
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
      setError(rejection.code === 'PROTECTED_RECOVERY_REQUIRED'
        ? t('Участнику нужно настроить восстановление доступа, прежде чем он сможет стать владельцем.')
        : rejection.message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function readRoster(previous?: Roster) {
    try {
      const page = await membership<Roster>('roster.protected.read', {
        serverId, ...(previous && { after: previous.next, revision: previous.revision }),
      });
      if (previous && page.revision === previous.revision) {
        setRoster({ ...page, members: [...previous.members, ...page.members] });
      } else {
        setRoster(page);
        setTargetProfileId('');
        setConfirmed(false);
      }
    } catch (failure) {
      if (!previous || (failure as { code?: string }).code !== 'PROTECTED_POLICY_CHANGED') throw failure;
      setRoster(undefined);
      setTargetProfileId('');
      setConfirmed(false);
      await readRoster();
    }
  }

  async function refresh(refreshRoster = true) {
    const current = await membership<Ownership>('ownership.protected.read', { serverId });
    setOwnership(current);
    setConfirmed(false);
    if (refreshRoster && current.canOffer) await readRoster();
  }

  useEffect(() => { void run(() => refresh()); }, [serverId]);
  const offer = ownership?.offer;
  const incoming = offer && !offer.outgoing && offer.targetProfileId === profileId;
  const target = roster?.members.find(member => member.id === targetProfileId);
  const label = (id: string) => memberLabel(id, roster?.members.find(member => member.id === id)?.name);

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || !target || !ownership?.canOffer || offer) return;
    void run(async () => {
      const result = await membership<{ operationId: string }>('ownership.protected.offer', { serverId, targetProfileId: target.id });
      setOwnership({ ...ownership, offer: { operationId: result.operationId, ownerProfileId: ownership.ownerProfileId,
        targetProfileId: target.id, expiresAt: 0, outgoing: true } });
      await refresh(false);
    });
  }

  function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!offer || !incoming || !confirmed) return;
    void run(async () => {
      const result = await membership<{ ownerProfileId: string }>('ownership.protected.accept', { serverId, operationId: offer.operationId });
      if (result.ownerProfileId !== profileId) throw Error(t('Не удалось подтвердить передачу владения.'));
      setAccepted(true);
      onAccepted();
    });
  }

  async function cancel() {
    if (!offer?.outgoing || !ownership?.canOffer) return;
    await run(async () => {
      const result = await membership<boolean>('ownership.protected.cancel', { serverId, operationId: offer.operationId });
      if (result !== true) throw Error(t('Не удалось отозвать предложение.'));
      setOwnership({ ...ownership, offer: undefined });
      await refresh();
    });
  }

  const expires = offer && offer.expiresAt > 0 &&
    new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(offer.expiresAt);
  return <Modal title={t('Передача владения · {0}', serverName)} className="member-ownership-modal" error={error} onClose={() => { if (!running.current) onClose(); }}>
    {accepted ? <>
      <p role="status">{t('Вы стали владельцем сервера.')}</p>
      <div className="modal-actions"><Button variant="primary" autoFocus onClick={onClose}>{t('Готово')}</Button></div>
    </> : offer?.outgoing ? <>
      <p role="status">{t('Предложение отправлено участнику {0}. Владение перейдёт после его подтверждения.', label(offer.targetProfileId))}</p>
      {expires && <p>{t('Действует до {0}', expires)}</p>}
      <div className="modal-actions">
        <Button disabled={busy} onClick={() => void run(() => refresh())}>{t('Обновить')}</Button>
        <Button variant="danger" disabled={busy || !ownership?.canOffer} onClick={() => void cancel()}>{t('Отозвать предложение')}</Button>
      </div>
    </> : incoming ? <form onSubmit={accept}>
      <div className="form-fields">
        <p>{t('Текущий владелец ({0}) предлагает вам принять владение сервером.', label(offer.ownerProfileId))}</p>
        {expires && <p>{t('Действует до {0}', expires)}</p>}
        <label className="member-confirm-check">
          <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/>
          {t('Подтверждаю, что хочу стать владельцем сервера')}
        </label>
      </div>
      <div className="modal-actions">
        <Button type="button" disabled={busy} onClick={onClose}>{t('Закрыть')}</Button>
        <Button variant="primary" disabled={busy || !confirmed}>{t('Принять владение')}</Button>
      </div>
    </form> : ownership?.canOffer && roster ? <form onSubmit={send}>
      <div className="form-fields">
        <label>{t('Будущий владелец')}
          <select required value={targetProfileId} disabled={busy}
            onChange={event => { setTargetProfileId(event.target.value); setConfirmed(false); }}>
            <option value="">{t('Выберите участника')}</option>
            {roster.members.filter(member => member.id !== ownership.ownerProfileId).map(member =>
              <option key={member.id} value={member.id}>{label(member.id)}</option>)}
          </select>
        </label>
        {roster.next && <div><Button type="button" disabled={busy} onClick={() => void run(() => readRoster(roster))}>{t('Показать ещё')}</Button></div>}
        {target && <>
          <p>{t('После принятия предложения вы потеряете полномочия владельца. Назначенные вам роли сохранятся.')}</p>
          <label className="member-confirm-check">
            <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/>
            {t('Подтверждаю, что хочу передать владение этому участнику')}
          </label>
        </>}
      </div>
      <div className="modal-actions">
        <Button type="button" disabled={busy} onClick={onClose}>{t('Отмена')}</Button>
        <Button variant="primary" disabled={busy || !confirmed || !target}>{t('Отправить предложение')}</Button>
      </div>
    </form> : <>
      {busy && <p role="status">{t('Загружаем данные о владении…')}</p>}
      {ownership && !ownership.canOffer && <p>{ownership.ownerProfileId === profileId
        ? t('Передать владение можно с устройства, которое подписывает политику сервера.')
        : t('Для вас пока нет предложения о передаче владения.')}</p>}
      <div className="modal-actions"><Button disabled={busy} onClick={() => void run(() => refresh())}>{t('Обновить')}</Button></div>
    </>}
  </Modal>;
}
