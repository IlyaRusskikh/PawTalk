import { useRef, useState, type FormEvent } from 'react';
import { t, useLanguage } from './i18n';
import { membership } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';

const cardLimit = 4096;

function useBindingAction() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { error, setError, busy, running, run };
}

function DeviceComparison({ deviceId }: { deviceId: string }) {
  return <p>{t('Код устройства')} <strong><code title={deviceId}>{deviceId.slice(0, 12)}</code></strong></p>;
}

function CopyCard({ label, value, busy, run }: {
  label: string; value: string; busy: boolean; run(action: () => Promise<void>): Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await membership('copy', { text: value });
    setCopied(true);
  }
  return <>
    <label>{label}<textarea rows={3} readOnly value={value} spellCheck={false}/></label>
    <div><Button type="button" disabled={busy} onClick={() => void run(copy)}>{t('Скопировать карточку')}</Button></div>
    {copied && <p role="status">{t('Карточка скопирована.')}</p>}
  </>;
}

export function ApproveProtectedDeviceDialog({ serverId, serverName, onClose }: {
  serverId: string; serverName: string; onClose(): void;
}) {
  const language = useLanguage();
  const [challengeCard, setChallengeCard] = useState('');
  const [requestCard, setRequestCard] = useState('');
  const [preview, setPreview] = useState<{ deviceId: string; expiresAt: number }>();
  const [confirmed, setConfirmed] = useState(false);
  const [complete, setComplete] = useState(false);
  const { error, setError, busy, running, run } = useBindingAction();

  function create() {
    void run(async () => {
      const result = await membership<{ challengeCard: string }>('device.protected.challenge', { serverId });
      setChallengeCard(result.challengeCard);
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const card = requestCard.trim();
    if (!card) return;
    if (!preview) {
      void run(async () => {
        const result = await membership<{ deviceId: string; expiresAt: number }>('device.protected.preview', { serverId, requestCard: card });
        if (!/^[0-9a-f]{64}$/.test(result.deviceId) || !Number.isSafeInteger(result.expiresAt) ||
            result.expiresAt <= 0 || result.expiresAt > 8_640_000_000_000_000) {
          throw Error(t('Не удалось проверить карточку устройства.'));
        }
        setPreview(result);
      });
    } else if (confirmed) {
      void run(async () => {
        const result = await membership<{ deviceId: string }>('device.protected.approve', { serverId, requestCard: card });
        if (result.deviceId !== preview.deviceId) throw Error(t('Не удалось подтвердить привязку устройства.'));
        setChallengeCard('');
        setRequestCard('');
        setComplete(true);
      });
    }
  }

  return <Modal title={t('Привязка устройства · {0}', serverName)} className="member-device-binding-modal"
    error={error} onClose={() => { if (!running.current) onClose(); }}>
    {complete ? <>
      <p role="status">{t('Привязка подтверждена. Теперь можно подключиться с нового устройства.')}</p>
      <div className="modal-actions"><Button variant="primary" autoFocus onClick={onClose}>{t('Готово')}</Button></div>
    </> : <form onSubmit={submit}>
      <div className="form-fields">
        {challengeCard ? <CopyCard label={t('Карточка привязки')} value={challengeCard} busy={busy} run={run}/> :
          <div><Button type="button" disabled={busy} onClick={create}>{t('Создать карточку привязки')}</Button></div>}
        <p>{t('Откройте «Привязать к существующему профилю» на новом устройстве, передайте туда карточку привязки и вставьте полученную карточку ответа ниже.')}</p>
        <label>{t('Карточка ответа')}
          <textarea rows={3} required maxLength={cardLimit} value={requestCard} autoComplete="off" spellCheck={false} readOnly={busy}
            onChange={event => { setRequestCard(event.target.value); setPreview(undefined); setConfirmed(false); setError(''); }}/>
        </label>
        {preview && <>
          <DeviceComparison deviceId={preview.deviceId}/>
          <p>{t('Действует до {0}', new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(preview.expiresAt))}</p>
          <label className="member-confirm-check">
            <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/>
            {t('Код совпадает с кодом на новом устройстве, и я разрешаю привязку')}
          </label>
        </>}
        {busy && <p role="status">{t('Проверяем привязку…')}</p>}
      </div>
      <div className="modal-actions">
        <Button type="button" disabled={busy} onClick={onClose}>{t('Закрыть')}</Button>
        <Button variant="primary" disabled={busy || !requestCard.trim() || (!!preview && !confirmed)}>
          {preview ? t('Подтвердить привязку') : t('Проверить карточку')}
        </Button>
      </div>
    </form>}
  </Modal>;
}

export function RequestProtectedDeviceDialog({ onClose, onAttached }: {
  onClose(): void; onAttached(serverId: string): void;
}) {
  const [challengeCard, setChallengeCard] = useState('');
  const [response, setResponse] = useState<{ requestCard: string; deviceId: string }>();
  const [pending, setPending] = useState(false);
  const { error, setError, busy, running, run } = useBindingAction();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const card = challengeCard.trim();
    if (!card) return;
    void run(async () => {
      if (!response) {
        const result = await membership<{ requestCard: string; deviceId: string }>('device.protected.request', { challengeCard: card });
        if (!/^[0-9a-f]{64}$/.test(result.deviceId)) throw Error(t('Не удалось получить код устройства.'));
        setResponse(result);
      } else {
        setPending(false);
        try {
          const result = await membership<{ serverId: string }>('device.protected.finish', { challengeCard: card });
          setChallengeCard('');
          setResponse(undefined);
          onAttached(result.serverId);
        } catch (failure) {
          if ((failure as { code?: string }).code !== 'INVALID_PROTECTED_SESSION_PROOF') throw failure;
          setPending(true);
        }
      }
    });
  }

  return <Modal title={t('Привязать к существующему профилю')} className="member-device-binding-modal"
    error={error} onClose={() => { if (!running.current) onClose(); }}>
    <form onSubmit={submit}>
      <div className="form-fields">
        {response ? <>
          <p>{t('Передайте карточку ответа на старое устройство. Сверьте код на обоих устройствах и подтвердите привязку на старом.')}</p>
          <CopyCard label={t('Карточка ответа')} value={response.requestCard} busy={busy} run={run}/>
          <DeviceComparison deviceId={response.deviceId}/>
          {pending && <p role="status">{t('Привязка ещё не подтверждена или срок карточки истёк. После подтверждения попробуйте подключиться снова.')}</p>}
        </> : <>
          <p>{t('На устройстве с доступом откройте «Профиль и устройства → Добавить новое устройство» и создайте карточку привязки.')}</p>
          <label>{t('Карточка привязки')}
            <textarea rows={3} autoFocus required maxLength={cardLimit} value={challengeCard} autoComplete="off" spellCheck={false} readOnly={busy}
              onChange={event => { setChallengeCard(event.target.value); setError(''); }}/>
          </label>
        </>}
        {busy && <p role="status">{t('Проверяем привязку…')}</p>}
      </div>
      <div className="modal-actions">
        <Button type="button" disabled={busy} onClick={onClose}>{t('Закрыть')}</Button>
        <Button variant="primary" disabled={busy || !challengeCard.trim()}>{response ? t('Подключить это устройство') : t('Создать карточку ответа')}</Button>
      </div>
    </form>
  </Modal>;
}
