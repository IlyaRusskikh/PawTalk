import { useCallback, useEffect, useRef, useState } from 'react';
import catalog from '../../../server/internal/access/catalog.json';
import { Toggle } from './Controls';
import { t, useLanguage } from './i18n';
import { membership } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';

const actions: Record<string, string> = {
  'invite.create': 'Создано приглашение',
  'invite.revoke': 'Отозвано приглашение',
  'invite.accept': 'Принято приглашение',
  'member.admit': 'Зачислен участник',
  'member.redeem': 'Зачислен участник',
  'member.leave': 'Участник вышел с сервера',
  'member.kick': 'Исключён участник',
  'profile.edit-other': 'Изменён ник участника',
  'server.rename': 'Изменено название сервера',
  'server.avatar': 'Изменён аватар сервера',
  'member.ban': 'Заблокирован участник',
  'member.unban': 'Снята блокировка участника',
  'audit.retention': 'Изменён срок хранения аудита',
  'member.timeout': 'Назначен тайм-аут',
  'member.timeout.lift': 'Снят тайм-аут',
  'message.delete': 'Удалено сообщение',
  'poll.delete-completed': 'Удалён завершённый опрос',
  'poll.close': 'Завершён опрос',
  'message.pin': 'Сообщение закреплено',
  'message.unpin': 'Сообщение откреплено',
  'message.edit': 'Изменено сообщение',
  'role.create': 'Создана роль',
  'role.update': 'Изменена роль',
  'role.delete': 'Удалена роль',
  'role.order': 'Изменён порядок ролей',
  'role.assign': 'Изменены роли участника',
  'device.enroll': 'Подтверждено устройство',
  'device.revoke': 'Отозвано устройство',
  'recipient.enroll': 'Зарегистрирован получатель ключей',
  'recipient.revoke': 'Отозван получатель ключей',
  'recovery.enroll': 'Зарегистрирована резервная идентичность',
  'recovery.replace': 'Заменена резервная идентичность',
  'recovery.confirm': 'Подтверждена готовность восстановления',
  'recovery.device': 'Восстановлен доступ на новом устройстве',
  'scope.device': 'Передана подпись поканальных подтверждений',
  'channel.acl.update': 'Изменены права канала',
  'channel.acl.sync': 'Синхронизированы права канала',
  'channel.move': 'Перемещён канал',
  'channel.create': 'Создан канал',
  'channel.settings.update': 'Изменены настройки канала',
  'channel.copy': 'Скопирован канал',
  'channel.delete': 'Удалён канал',
  'channel.order': 'Изменён порядок канала',
  'category.acl.update': 'Изменены права категории',
  'category.create': 'Создана категория',
  'category.settings.update': 'Изменены настройки категории',
  'category.delete': 'Удалена категория',
  'category.copy': 'Скопирована категория',
  'category.order': 'Изменён порядок категории',
  'voice.mute': 'Отключён микрофон участника',
  'voice.mute.lift': 'Снято ограничение микрофона',
  'voice.deafen': 'Отключён звук участника',
  'voice.deafen.lift': 'Снято ограничение звука',
};
const objects: Record<string, string> = {
  server: 'Сервер', role: 'Роль', member: 'Участник', device: 'Устройство',
  category: 'Категория', channel: 'Канал', message: 'Сообщение', poll: 'Опрос', invite: 'Приглашение',
};

type AuditEntry = {
  at: number; actor: string; actorName?: string; action: string; kind: string; objectId: string;
  objectName?: string; channelId?: string; channelName?: string; roleNames?: Record<string, string>;
  position?: number; reason?: string;
  change: { previous?: number; current?: number; added?: string[]; removed?: string[]; layoutDigest?: string };
};
type AuditPage = { entries: AuditEntry[]; next?: string; retention: number; canChange: boolean; scope: string; cutoff: number };
const displayName = (name?: string) => name && !/^[\da-f]{32,}$/i.test(name.trim()) ? name : undefined;

export function ProtectedAuditDialog({ serverId, channelNames, onClose, inline }: {
  serverId: string; channelNames: Record<string, string>; onClose: () => void; inline?: boolean;
}) {
  const language = useLanguage();
  const [page, setPage] = useState<AuditPage>();
  const [error, setError] = useState('');
  const [days, setDays] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [proofCheck, setProofCheck] = useState<{ digest: string; scope: string; status: 'pending' | 'verified' | 'unavailable' }>();
  const alive = useRef(false);
  const running = useRef(false);
  const current = useRef<{ page: AuditPage; topNext?: string } | undefined>(undefined);
  const load = useCallback(async (more = false) => {
    const previous = current.current;
    if (running.current || more && !previous?.page.next) return;
    running.current = true;
    setLoading(true);
    try {
      let next = await membership<AuditPage>('audit.protected.read', { serverId, ...(more && { before: previous?.page.next }) });
      if (!alive.current) return;
      const sameScope = next.scope === previous?.page.scope && next.retention === previous?.page.retention;
      if (more && !sameScope) {
        setPage(undefined);
        current.current = undefined;
        next = await membership<AuditPage>('audit.protected.read', { serverId });
        more = false;
      }
      if (!alive.current) return;
      const topNext = more ? previous?.topNext : next.next;
      if (more && previous) {
        next = { ...next, entries: [...previous.page.entries.filter(entry => entry.at >= next.cutoff), ...next.entries] };
      } else if (sameScope && next.next !== undefined && next.next === previous?.topNext) {
        const tail = previous.page.entries.slice(32).filter(entry => entry.at >= next.cutoff);
        if (tail.length) next = { ...next, entries: [...next.entries, ...tail], next: previous.page.next };
      }
      if (previous?.page.retention !== next.retention) setConfirmed(false);
      current.current = { page: next, topNext };
      setPage(next);
      setError('');
    } catch (failure) {
      if (!alive.current) return;
      current.current = undefined;
      setPage(undefined);
      setError((failure as Error).message);
    } finally {
      running.current = false;
      if (alive.current) setLoading(false);
    }
  }, [serverId]);
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [load]);

  const selectedDays = Number(days ?? page?.retention);
  const validDays = Number.isSafeInteger(selectedDays) && selectedDays > 0 && selectedDays <= 106751991167;
  const shorter = !!page && validDays && selectedDays < page.retention;
  async function save() {
    if (!page?.canChange || !validDays || selectedDays === page.retention || shorter && !confirmed || running.current) return;
    running.current = true;
    setSaving(true);
    let changed = false;
    try {
      await membership('audit.protected.retention', { serverId, days: selectedDays, expected: page.retention, confirmShorter: shorter && confirmed });
      if (!alive.current) return;
      setDays(undefined);
      setConfirmed(false);
      current.current = undefined;
      setPage(undefined);
      changed = true;
    } catch (failure) {
      if (alive.current) setError((failure as Error).message);
    } finally {
      running.current = false;
      if (alive.current) setSaving(false);
    }
    if (changed) await load();
  }
  const date = (value: number) => new Date(value).toLocaleString(language);
  const valueOf = (entry: AuditEntry, value: number) => entry.action === 'audit.retention' ? t('{0} дн.', value) :
    value === 0 ? t('Нет тайм-аута') : date(value);
  const labelOf = (entry: AuditEntry, id: string) => {
    if (entry.action === 'role.assign') {
      return id === '@everyone' ? id : displayName(Object.hasOwn(entry.roleNames ?? {}, id) ? entry.roleNames?.[id] : undefined) ?? t('Роль недоступна');
    }
    if (['channel.acl.update', 'channel.acl.sync', 'channel.move', 'category.acl.update'].includes(entry.action)) {
      const [rule, permissionId] = id.split(':');
      const permission = catalog.permissions.find(item => item.id === permissionId);
      if (permission && (rule === 'allow' || rule === 'deny')) {
        return `${rule === 'allow' ? t('Разрешено') : t('Запрещено')} · ${permission[language]}`;
      }
    }
    return catalog.permissions.find(permission => permission.id === id)?.[language] ?? t('Неизвестное право');
  };

  async function checkOrderProof(entry: AuditEntry, scope: string) {
    const digest = entry.change.layoutDigest;
    if (!digest || !entry.channelId || proofCheck?.status === 'pending') return;
    setError('');
    setProofCheck({ digest, scope, status: 'pending' });
    try {
      const verified = await membership<boolean>('audit.protected.verifyOrder', { serverId, channelId: entry.channelId, digest, actor: entry.actor });
      if (alive.current) setProofCheck({ digest, scope, status: verified ? 'verified' : 'unavailable' });
    } catch (failure) {
      if (!alive.current) return;
      setProofCheck(undefined);
      setError((failure as Error).message);
    }
  }

  return <Modal inline={inline} title={t('Журнал аудита')} className="protected-audit" onClose={onClose} error={error}>
    <div className="form-fields">
      {page?.canChange && <form className="form-fields" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label>{t('Срок хранения журнала, дни')}<input type="number" min={1} step={1} value={days ?? page.retention} disabled={saving}
          onChange={event => { setDays(event.target.value); setConfirmed(false); }}/></label>
        {shorter && <Toggle checked={confirmed} onChange={setConfirmed} disabled={saving}
          label={t('Удалить записи старше нового срока')} detail={t('Удалённые записи журнала восстановить нельзя.')}/>}
        <div className="modal-actions">
          <Button type="submit" variant={shorter ? 'danger' : 'primary'}
            disabled={loading || saving || !validDays || selectedDays === page.retention || shorter && !confirmed}>{t('Сохранить')}</Button>
        </div>
      </form>}
      {!page && !error && <p role="status">{t('Загружаем журнал аудита…')}</p>}
      {page?.entries.length === 0 && <p>{t('Нет доступных записей аудита.')}</p>}
      {page && page.entries.length > 0 && <ol className="protected-audit-entries">
        {page.entries.map((entry, index) => {
          const objectName = displayName(entry.objectName) ?? (entry.kind === 'channel' ? displayName(channelNames[entry.objectId]) :
            entry.kind === 'role' && entry.objectId === '@everyone' ? '@everyone' : undefined);
          const channelName = entry.channelId && (displayName(entry.channelName) ?? displayName(channelNames[entry.channelId]) ?? t('Канал недоступен'));
          return <li key={index}>
          <strong>{t(Object.hasOwn(actions, entry.action) ? actions[entry.action] : 'Событие аудита')}</strong>
          <p><time>{date(entry.at)}</time> · <span>{displayName(entry.actorName) ?? t('Участник')}</span></p>
          <p>{t(objects[entry.kind] ?? 'Событие аудита')}{objectName && ` · ${objectName}`}
            {channelName && entry.kind !== 'channel' && ` · ${channelName}`}</p>
          {entry.reason && <p>{t('Причина: {0}', entry.reason)}</p>}
          {entry.change.previous !== undefined && entry.change.current !== undefined &&
            <p>{valueOf(entry, entry.change.previous)} → {valueOf(entry, entry.change.current)}</p>}
          {!!entry.change.added?.length && <p>{t('Добавлено: {0}', entry.change.added.map(id => labelOf(entry, id)).join(', '))}</p>}
          {!!entry.change.removed?.length && <p>{t('Удалено: {0}', entry.change.removed.map(id => labelOf(entry, id)).join(', '))}</p>}
          {entry.change.layoutDigest && <>
            <Button variant="quiet" disabled={proofCheck?.status === 'pending'} onClick={() => void checkOrderProof(entry, page.scope)}>
              {t('Проверить подпись')}
            </Button>
            {proofCheck?.digest === entry.change.layoutDigest && proofCheck.scope === page.scope && proofCheck.status !== 'pending' &&
              <p role="status">{proofCheck.status === 'verified' ? t('Подпись подтверждена') : t('Доказательство недоступно')}</p>}
          </>}
        </li>;
        })}
      </ol>}
      {page?.next && <div><Button disabled={loading || saving} onClick={() => void load(true)}>{t('Показать ещё')}</Button></div>}
    </div>
  </Modal>;
}
