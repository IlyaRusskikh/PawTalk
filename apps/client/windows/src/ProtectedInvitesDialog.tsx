import { useEffect, useRef, useState } from 'react';
import { t, useLanguage } from './i18n';
import { membership } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';
import { Avatar } from './Avatar';
import { Icon } from './Controls';
import { useProtectedProfileAppearances } from './useProtectedProfileAppearances';
import './protected-invites.css';

type Invite = {
  id: string; creator: string; createdAt: number; expiresAt: number;
  maxUses: number; uses: number; revokedAt?: number; canRevoke: boolean;
};
type InvitePage = { invites: Invite[]; canCreate: boolean; next?: string };
type IssuedInvite = { invite: Invite; link: string };

export function ProtectedInvitesDialog({ serverId, profileId, ownAvatar, canListMembers, textChannelId, onClose, inline }: {
  serverId: string; profileId: string; onClose: () => void; inline?: boolean;
  ownAvatar?: string; canListMembers?: boolean; textChannelId?: string;
}) {
  const language = useLanguage();
  const [page, setPage] = useState<InvitePage>();
  const [cursors, setCursors] = useState<string[]>([]);
  const [duration, setDuration] = useState('24');
  const [deadline, setDeadline] = useState('');
  const [useLimit, setUseLimit] = useState('single');
  const [maxUsesInput, setMaxUsesInput] = useState('2');
  const [copyPending, setCopyPending] = useState<IssuedInvite>();
  const [copied, setCopied] = useState(false);
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
  async function load(nextCursors: string[]) {
    const before = nextCursors.at(-1);
    const value = await membership<InvitePage>('invite.protected.list', { serverId, ...(before && { before }) });
    setPage(value);
    setCursors(nextCursors);
  }
  useEffect(() => { void run(() => load([])); }, [serverId]);
  const rosterChannel = canListMembers ? undefined : textChannelId;
  const creators = useProtectedProfileAppearances(canListMembers || rosterChannel ? serverId : undefined,
    rosterChannel, page?.invites.map(invite => invite.creator) ?? []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 4500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(receipt: IssuedInvite) {
    try {
      await membership('copy', { text: receipt.link });
      setCopyPending(undefined);
      setCopied(true);
    } catch {
      setCopyPending(receipt);
    }
  }

  async function create() {
    if (!page?.canCreate) return;
    const now = Date.now();
    const expiresAt = duration === '24' ? 0
      : duration === 'manual' ? new Date(deadline).getTime() : now + Number(duration) * 3_600_000;
    const maxUses = useLimit === 'unlimited' ? 0 : useLimit === 'single' ? 1 : Number(maxUsesInput);
    if ((duration !== '24' && (!Number.isSafeInteger(expiresAt) || expiresAt <= now)) ||
        (useLimit === 'count' && (!Number.isSafeInteger(maxUses) || maxUses < 2))) {
      setError(t('Укажите будущую дату и допустимое число вступлений.'));
      return;
    }
    await run(async () => {
      setCopied(false);
      const receipt = await membership<IssuedInvite>('invite.protected.create', { serverId, expiresAt, maxUses });
      await copy(receipt);
      await load([]);
    });
  }
  async function revoke(inviteId: string) {
    await run(async () => {
      await membership('invite.protected.revoke', { serverId, inviteId });
      if (copyPending?.invite.id === inviteId) setCopyPending(undefined);
      setPage(previous => previous && { ...previous, invites: previous.invites.map(invite => invite.id === inviteId
        ? { ...invite, revokedAt: Date.now(), canRevoke: false } : invite) });
    });
  }
  return <Modal inline={inline} className="protected-invites" title={t('Приглашения')} onClose={onClose} error={error}>
    {copied && <div className="member-error protected-server-profile-toast invite-toast">
      <Icon name="invite" size={18}/>
      <span role="status">{t('Ссылка приглашения создана и скопирована.')}</span>
      <button type="button" className="icon-button" aria-label={t('Закрыть')} onClick={() => setCopied(false)}>×</button>
    </div>}
    {page?.canCreate && <form className="invite-card" onSubmit={event => { event.preventDefault(); void create(); }}>
      <div className="invite-card-heading">
        <span className="invite-art" aria-hidden="true"><Icon name="invite" size={25}/></span>
        <h3>{t('Новое приглашение')}</h3>
      </div>
      <div className="form-grid invite-fields">
        <label>{t('Срок действия')}
          <select value={duration} onChange={event => setDuration(event.target.value)} disabled={busy}>
            <option value="1">{t('1 час')}</option>
            <option value="24">{t('24 часа')}</option>
            <option value="168">{t('7 дней')}</option>
            <option value="manual">{t('Указать дату и время')}</option>
          </select>
        </label>
        <label>{t('Лимит вступлений')}
          <select value={useLimit} onChange={event => setUseLimit(event.target.value)} disabled={busy}>
            <option value="single">{t('Одно вступление')}</option>
            <option value="count">{t('Задать лимит')}</option>
            <option value="unlimited">{t('Без лимита до истечения срока')}</option>
          </select>
        </label>
        {duration === 'manual' && <label>{t('Действует до')}
          <input type="datetime-local" value={deadline} onChange={event => setDeadline(event.target.value)} required disabled={busy}/>
        </label>}
        {useLimit === 'count' && <label>{t('Количество вступлений')}
          <input type="number" min="2" max={Number.MAX_SAFE_INTEGER} value={maxUsesInput}
            onChange={event => setMaxUsesInput(event.target.value)} required disabled={busy}/>
        </label>}
      </div>
      <div className="modal-actions"><Button variant="primary" disabled={busy}>{t('Создать ссылку')}</Button></div>
    </form>}
    {copyPending && <div className="invite-copy-retry">
      <p role="alert">{t('Ссылка создана, но не удалось скопировать её.')}</p>
      <Button type="button" disabled={busy} onClick={() => void run(() => copy(copyPending))}>{t('Повторить копирование')}</Button>
    </div>}
    {page ? <div className="member-management-list">
      <div className="invite-history-heading">
        <h3>{t('История приглашений')}</h3>
        <small>{t('До {0} приглашений на странице', 32)}</small>
      </div>
      {!page.invites.length && <div className="invite-empty">
        <span className="invite-art" aria-hidden="true"><Icon name="invite" size={23}/></span>
        <p>{t('Нет приглашений.')}</p>
      </div>}
      {page.invites.map(invite => {
        const status = invite.revokedAt ? t('Отозвано')
          : invite.expiresAt <= Date.now() ? t('Срок истёк')
          : invite.maxUses !== 0 && invite.uses >= invite.maxUses ? t('Лимит исчерпан') : t('Действует');
        const creator = creators?.get(invite.creator);
        const isOwn = invite.creator === profileId;
        const name = creator?.name ?? t(isOwn ? 'Вы' : 'Участник');
        return <div className="member-management-row invite-row" key={invite.id}>
          <div className="invite-author">
            <Avatar className="small" name={name} image={(isOwn ? ownAvatar : undefined) ?? creator?.avatar}/>
            <span title={name}>{name}</span>
          </div>
          <div className="invite-details"><strong>{status}</strong>
            <small>{t('До {0}', new Date(invite.expiresAt).toLocaleString(language))}</small>
            <small>{invite.maxUses === 0 ? t('Вступлений: {0} · Без лимита', invite.uses)
              : t('Вступлений: {0} из {1}', invite.uses, invite.maxUses)}</small>
          </div>
          {invite.canRevoke && <Button type="button" disabled={busy} onClick={() => void revoke(invite.id)}>{t('Отозвать')}</Button>}
        </div>;
      })}
      {(page.next || cursors.length > 0) && <div className="modal-actions invite-pagination">
        <span>{t('Страница {0}', cursors.length + 1)}</span>
        <Button type="button" disabled={busy || !cursors.length} onClick={() => void run(() => load(cursors.slice(0, -1)))}>{t('Назад')}</Button>
        <Button type="button" disabled={busy || !page.next} onClick={() => {
          if (page.next) void run(() => load([...cursors, page.next!]));
        }}>{t('Далее')}</Button>
      </div>}
    </div> : busy ? <p role="status">{t('Подключение…')}</p> :
      <div className="modal-actions"><Button type="button" onClick={() => void run(() => load([]))}>{t('Повторить')}</Button></div>}
  </Modal>;
}
