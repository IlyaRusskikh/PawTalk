import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t, useLanguage } from './i18n';
import { membership } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';

const cardLimit = 4096;

type ProfileLinkPreview = {
  primaryProfileId: string;
  secondaryProfileId: string;
  primaryRoles: string[];
  secondaryRoles: string[];
  movedDevices: number;
  policyHead: string;
  policyRevision: number;
};

type LinkReview = { preview: ProfileLinkPreview; primaryIsLocal: boolean; agreed: boolean; ready: boolean };
type LinkStatus = { profileId: string; policyHead: string; sources: string[] };
type Props = { serverId: string; serverName: string; profileId: string; onClose(): void; onChanged(): void };

const isProfileId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isCard = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= cardLimit;
const validRoles = (roles: unknown): roles is string[] => Array.isArray(roles) && roles.every(role => typeof role === 'string');

function checkReview(review: LinkReview | undefined, profileId: string): asserts review is LinkReview {
  const preview = review?.preview;
  if (!preview || !isProfileId(preview.primaryProfileId) || !isProfileId(preview.secondaryProfileId) ||
      preview.primaryProfileId === preview.secondaryProfileId || !validRoles(preview.primaryRoles) || !validRoles(preview.secondaryRoles) ||
      !isProfileId(preview.policyHead) || !Number.isSafeInteger(preview.policyRevision) || preview.policyRevision < 1 ||
      !Number.isSafeInteger(preview.movedDevices) || preview.movedDevices < 1 || typeof review.primaryIsLocal !== 'boolean' ||
      typeof review.agreed !== 'boolean' || typeof review.ready !== 'boolean' || (review.ready && !review.agreed) ||
      (review.primaryIsLocal ? preview.primaryProfileId : preview.secondaryProfileId) !== profileId) {
    throw Error(t('Не удалось проверить карточку связывания.'));
  }
}

function useProfileLinkAction() {
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState<string>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    setErrorCode(undefined);
    try {
      await action();
    } catch (failure) {
      const rejection = failure as Error & { code?: string };
      setError(rejection.code === 'EXPIRED_CHALLENGE' ? t('Срок карточки истёк. Создайте новую карточку связывания.') : rejection.message);
      setErrorCode(rejection.code);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, error, errorCode, running, run, clearError() { setError(''); setErrorCode(undefined); } };
}

function ShortProfileId({ id }: { id: string }) {
  return <code title={id}>{id.slice(0, 12)}</code>;
}

function CopyLinkCard({ label, card, busy, run }: {
  label: string; card: string; busy: boolean; run(action: () => Promise<void>): Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  return <>
    <label>{label}<textarea value={card} rows={3} readOnly spellCheck={false}/></label>
    <div><Button type="button" disabled={busy} onClick={() => void run(async () => {
      await membership('copy', { text: card });
      setCopied(true);
    })}>{t('Скопировать карточку')}</Button></div>
    {copied && <p role="status">{t('Карточка скопирована.')}</p>}
  </>;
}

function LinkConsequences({ review }: { review: LinkReview }) {
  const { preview, primaryIsLocal } = review;
  return <>
    <div className="form-grid">
      <div>
        <strong>{t('Основной профиль')}</strong>
        <p>{primaryIsLocal ? t('Вы') : t('Другой участник')} · <ShortProfileId id={preview.primaryProfileId}/></p>
        <p>{preview.primaryRoles.length ? t('Роли сохранятся: {0}', preview.primaryRoles.join(', ')) : t('Общие права (@everyone)')}</p>
      </div>
      <div>
        <strong>{t('Присоединяемый профиль')}</strong>
        <p>{primaryIsLocal ? t('Другой участник') : t('Вы')} · <ShortProfileId id={preview.secondaryProfileId}/></p>
        <p>{preview.secondaryRoles.length ? t('Роли будут сняты: {0}', preview.secondaryRoles.join(', ')) : t('Назначенных ролей нет.')}</p>
      </div>
    </div>
    <p>{t('Устройств перейдёт в основной профиль: {0}. Они получат только его доступ к каналам и истории.', preview.movedDevices)}</p>
    <p>{t('Присоединяемый профиль больше не будет отдельным участником.')}</p>
  </>;
}

export function ProtectedProfileLinkDialog({ serverId, serverName, profileId, onClose, onChanged }: Props) {
  useLanguage();
  const [step, setStep] = useState<'start' | 'choose' | 'paste' | 'review' | 'done'>('start');
  const [participantCard, setParticipantCard] = useState('');
  const [input, setInput] = useState('');
  const [primaryIsLocal, setPrimaryIsLocal] = useState<boolean>();
  const [linkCard, setLinkCard] = useState('');
  const [review, setReview] = useState<LinkReview>();
  const [confirmed, setConfirmed] = useState(false);
  const { busy, error, running, run, clearError } = useProfileLinkAction();

  function openInput(next: 'start' | 'choose' | 'paste') {
    setInput('');
    setPrimaryIsLocal(undefined);
    setConfirmed(false);
    clearError();
    setStep(next);
  }

  function createParticipantCard() {
    void run(async () => {
      const result = await membership<{ participantCard: string }>('profile.protected.participant', { serverId });
      if (!isCard(result.participantCard)) throw Error(t('Не удалось получить карточку профиля.'));
      setParticipantCard(result.participantCard);
    });
  }

  function reviewInput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const card = input.trim();
    if (!isCard(card) || (step === 'choose' && primaryIsLocal === undefined)) return;
    void run(async () => {
      if (step === 'choose') {
        const result = await membership<{ preview: ProfileLinkPreview; linkCard: string }>('profile.protected.prepare', {
          serverId, participantCard: card, primaryIsLocal,
        });
        const next = { preview: result.preview, primaryIsLocal: primaryIsLocal!, agreed: false, ready: false };
        checkReview(next, profileId);
        if (!isCard(result.linkCard)) throw Error(t('Не удалось проверить карточку связывания.'));
        setReview(next);
        setLinkCard(result.linkCard);
      } else {
        const next = await membership<LinkReview>('profile.protected.review', { serverId, linkCard: card });
        checkReview(next, profileId);
        setReview(next);
        setLinkCard(card);
      }
      setInput('');
      setStep('review');
    });
  }

  function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!review || !linkCard) return;
    if (!review.agreed && confirmed) {
      void run(async () => {
        const result = await membership<{ linkCard: string; ready: boolean }>('profile.protected.sign', { serverId, linkCard });
        if (!isCard(result.linkCard) || typeof result.ready !== 'boolean') throw Error(t('Не удалось подтвердить связывание профилей.'));
        setLinkCard(result.linkCard);
        setReview({ ...review, agreed: true, ready: result.ready });
        setConfirmed(false);
      });
    } else if (review.ready && review.primaryIsLocal) {
      void run(async () => {
        const result = await membership<{ primaryProfileId: string }>('profile.protected.apply', { serverId, linkCard });
        if (result.primaryProfileId !== review.preview.primaryProfileId) throw Error(t('Не удалось подтвердить связывание профилей.'));
        setLinkCard('');
        setParticipantCard('');
        setStep('done');
        onChanged();
      });
    }
  }

  const close = () => { if (!running.current) onClose(); };
  return <Modal title={t('Объединить два существующих профиля · {0}', serverName)} className="member-profile-link-modal" error={error} onClose={close}>
    {step === 'start' && <>
      <div className="form-fields">
        <p>{t('Чтобы связать два действующих профиля, передайте свою карточку другому участнику или получите его карточку.')}</p>
        {participantCard ? <CopyLinkCard label={t('Моя карточка профиля')} card={participantCard} busy={busy} run={run}/> :
          <div><Button disabled={busy} onClick={createParticipantCard}>{t('Создать карточку профиля')}</Button></div>}
        {busy && <p role="status">{t('Проверяем связывание…')}</p>}
      </div>
      <div className="modal-actions member-profile-link-actions">
        <Button disabled={busy} onClick={() => openInput('paste')}>{t('Проверить карточку связывания')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => openInput('choose')}>{t('Выбрать основной профиль')}</Button>
      </div>
    </>}
    {(step === 'choose' || step === 'paste') && <form onSubmit={reviewInput}>
      <div className="form-fields">
        <label>{step === 'choose' ? t('Карточка другого профиля') : t('Карточка связывания')}
          <textarea rows={3} required autoFocus maxLength={cardLimit} autoComplete="off" spellCheck={false}
            value={input} readOnly={busy} onChange={event => { setInput(event.target.value); clearError(); }}/>
        </label>
        {step === 'choose' && <>
          <label>{t('Основной профиль')}
            <select required value={primaryIsLocal === undefined ? '' : String(primaryIsLocal)} disabled={busy}
              onChange={event => setPrimaryIsLocal(event.target.value === '' ? undefined : event.target.value === 'true')}>
              <option value="">{t('Выберите профиль')}</option>
              <option value="true">{t('Мой профиль')}</option>
              <option value="false">{t('Другой профиль')}</option>
            </select>
          </label>
          <p>{t('Если один из профилей принадлежит владельцу сервера, он должен остаться основным.')}</p>
        </>}
        {busy && <p role="status">{t('Проверяем связывание…')}</p>}
      </div>
      <div className="modal-actions">
        <Button type="button" disabled={busy} onClick={() => openInput('start')}>{t('Назад')}</Button>
        <Button variant="primary" disabled={busy || !input.trim() || (step === 'choose' && primaryIsLocal === undefined)}>
          {step === 'choose' ? t('Посмотреть последствия') : t('Проверить карточку')}
        </Button>
      </div>
    </form>}
    {step === 'review' && review && <form onSubmit={confirm}>
      <div className="form-fields">
        <LinkConsequences review={review}/>
        {review.agreed ? <>
          <p role="status">{review.ready
            ? review.primaryIsLocal ? t('Оба профиля подтвердили связывание. Его можно применить.') : t('Оба профиля подтвердили связывание. Передайте карточку основному профилю, чтобы применить его.')
            : t('Передайте подписанную карточку другому профилю. Связывание применяется с основного профиля после двух подтверждений.')}</p>
          <CopyLinkCard key={linkCard} label={t('Подписанная карточка связывания')} card={linkCard} busy={busy} run={run}/>
        </> : <label className="member-confirm-check">
          <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/>
          {t('Я согласен связать профили с указанными правами')}
        </label>}
        {busy && <p role="status">{t('Проверяем связывание…')}</p>}
      </div>
      <div className="modal-actions member-profile-link-actions">
        <Button type="button" disabled={busy} onClick={() => openInput(review.agreed ? 'paste' : 'start')}>
          {review.agreed ? t('Проверить другую карточку') : t('Назад')}
        </Button>
        {!review.agreed && <Button variant="primary" disabled={busy || !confirmed}>{t('Подписать согласие')}</Button>}
        {review.ready && review.primaryIsLocal && <Button variant="primary" disabled={busy}>{t('Применить связывание')}</Button>}
      </div>
    </form>}
    {step === 'done' && <>
      <p role="status">{t('Профили связаны. Теперь все связанные устройства используют права основного профиля.')}</p>
      <div className="modal-actions"><Button variant="primary" autoFocus onClick={onClose}>{t('Готово')}</Button></div>
    </>}
  </Modal>;
}

export function ProtectedLinkedProfilesDialog({ serverId, serverName, profileId, onClose, onChanged, onScopeHandover }: Props & {
  onScopeHandover(): void;
}) {
  useLanguage();
  const [status, setStatus] = useState<LinkStatus>();
  const [source, setSource] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [detached, setDetached] = useState(false);
  const { busy, error, errorCode, running, run, clearError } = useProfileLinkAction();

  async function load() {
    const next = await membership<LinkStatus>('profile.protected.status', { serverId });
    if (next.profileId !== profileId || !isProfileId(next.policyHead) || !Array.isArray(next.sources) ||
        next.sources.some(id => !isProfileId(id) || id === profileId) || new Set(next.sources).size !== next.sources.length) {
      throw Error(t('Не удалось проверить связанные профили.'));
    }
    setStatus(next);
  }

  useEffect(() => { void run(load); }, [serverId, profileId]);

  function unlink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || !status?.sources.includes(source)) return;
    void run(async () => {
      const result = await membership<{ sourceProfileId: string }>('profile.protected.unlink', {
        serverId, sourceProfileId: source, policyHead: status.policyHead,
      });
      if (result.sourceProfileId !== source) throw Error(t('Не удалось подтвердить отвязку профиля.'));
      setSource('');
      setConfirmed(false);
      setStatus(undefined);
      setDetached(true);
      onChanged();
    });
  }

  const close = () => { if (!running.current) onClose(); };
  return <Modal title={t('Связанные профили · {0}', serverName)} className="member-profile-link-modal" error={error} onClose={close}>
    {source ? <form onSubmit={unlink}>
      <div className="form-fields">
        <p>{t('Отвязать профиль')} · <ShortProfileId id={source}/></p>
        <p>{t('Устройства этого профиля потеряют доступ. Прежние роли и членство не восстановятся.')}</p>
        {errorCode === 'PROTECTED_SCOPE_SIGNER_HANDOVER_REQUIRED' && <div>
          <Button type="button" disabled={busy} onClick={onScopeHandover}>{t('Открыть передачу подписи')}</Button>
        </div>}
        <label className="member-confirm-check">
          <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/>
          {t('Я подтверждаю отзыв доступа у устройств этого профиля')}
        </label>
      </div>
      <div className="modal-actions">
        <Button type="button" disabled={busy} onClick={() => { setSource(''); setConfirmed(false); clearError(); }}>{t('Отмена')}</Button>
        <Button variant="danger" disabled={busy || !confirmed}>{t('Отвязать профиль')}</Button>
      </div>
    </form> : <>
      <div className="form-fields">
        {detached && <p role="status">{t('Профиль отвязан. Его устройства потеряли доступ.')}</p>}
        {status?.sources.length === 0 && <p>{t('У этого профиля нет связанных профилей.')}</p>}
        {status?.sources.map(id => <div className="member-profile-link-row" key={id}>
          <ShortProfileId id={id}/>
          <Button disabled={busy} aria-label={t('Отвязать профиль {0}', id.slice(0, 12))} onClick={() => {
            clearError(); setConfirmed(false); setSource(id);
          }}>{t('Отвязать')}</Button>
        </div>)}
        {busy && <p role="status">{t('Проверяем связывание…')}</p>}
      </div>
      <div className="modal-actions">
        <Button disabled={busy} onClick={() => void run(load)}>{t('Обновить')}</Button>
        <Button variant="primary" disabled={busy} onClick={onClose}>{t('Готово')}</Button>
      </div>
    </>}
  </Modal>;
}
