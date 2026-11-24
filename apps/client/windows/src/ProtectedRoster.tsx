import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from './Avatar';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Icon } from './Controls';
import { t, useLanguage } from './i18n';
import { membership, protectedChannelOpenDelay } from './membership';
import { Button } from './ui/Button';
import { ProtectedNicknameDialog } from './ProtectedNicknameDialog';
import { setMemberDrag } from './memberMention';
import { setTransparentDragImage } from './ui/useReorderDrag';

type Role = { id: string; name?: string; icon?: string };
type Presence = 'online' | 'away' | 'offline';
type Member = { id: string; name?: string; avatar?: string; owner?: boolean; color?: string; groupId?: string; groupRank?: number; roles: Role[];
  presence?: Presence; canKick?: boolean; canBan?: boolean; canAssignRoles?: boolean; canEditNickname?: boolean };
type RosterPage = { revision: number; nicknameDigest?: string; next?: string; members: Member[]; roleColors?: Record<string, string> };
type Group = { id: string; rank: number; role?: Role; members: Member[] };
export type ChatAuthorProfile = { name: string; avatar?: string; color?: string };
export type ChatAuthorRoster = { serverId: string; channelId?: string; names: ReadonlyMap<string, ChatAuthorProfile>;
  roleColors: ReadonlyMap<string, string>; cursor?: { after: string; revision: number } };

const nameOf = (member: Member) => member.name ?? t('Участник · {0}', member.id.slice(0, 8));
const roleName = (role: Role) => role.name ?? (role.id === '@everyone' ? t('Все участники') : role.id);
const presenceLabel = { online: 'В сети', away: 'Отошел', offline: 'Не в сети' } as const;
const presenceOrder = { online: 0, away: 1, offline: 2 };

function RosterAvatar({ member, ownAvatar }: { member: Member; ownAvatar?: string }) {
  const presence = member.presence;
  return <span className="member-avatar-wrap"><Avatar name={nameOf(member)} image={ownAvatar ?? member.avatar}/>
    {presence && <span className={`member-status ${presence}`} role="img" aria-label={t(presenceLabel[presence])}
      title={t(presenceLabel[presence])}/>}
  </span>;
}

export function ProtectedRoster({ serverId, channelId, profileId, ownAvatar, eventsLive, previewMembers, onProfiles, onTimeout, onModerate, onPersonalACL, onAssignRoles, onOpenProfileDevices }: {
  serverId: string; channelId?: string; profileId: string; onTimeout?: (id: string, name: string) => void;
  ownAvatar?: string;
  eventsLive?: boolean;
  previewMembers?: readonly Pick<Member, 'id' | 'name' | 'avatar'>[];
  onProfiles?: (profiles: ChatAuthorRoster) => void;
  onModerate?: (id: string, name: string, action: 'kick' | 'ban') => void;
  onPersonalACL?: (id: string, name: string) => void;
  onAssignRoles?: (id: string, name: string) => void;
  onOpenProfileDevices?: () => void;
}) {
  const language = useLanguage();
  const [page, setPage] = useState<RosterPage>();
  const [selectedId, setSelectedId] = useState('');
  const [editingNickname, setEditingNickname] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; anchor: HTMLElement }>();
  const preview = previewMembers !== undefined;
  const visibleMembers: Member[] | undefined = previewMembers?.map(member => ({ ...member, roles: [] })) ?? page?.members;
  const current = useRef<RosterPage | undefined>(undefined);
  const running = useRef(false);
  const scope = useRef(0);
  const load = useCallback(async (more = false, refreshLoadedPages = false) => {
    if (running.current || more && !current.current?.next) return;
    const generation = scope.current;
    running.current = true;
    setLoading(true);
    const pinned = current.current;
    try {
      const input = { serverId, channelId };
      const readPage = (after?: string, revision?: number) => membership<RosterPage>('roster.protected.read', {
        ...input, ...(after && { after, revision }),
      });
      let fresh: RosterPage;
      try {
        fresh = await readPage(more ? pinned?.next : undefined, pinned?.revision);
        if (generation !== scope.current) return;
        if (pinned?.revision === fresh.revision) {
          if (pinned.nicknameDigest === fresh.nicknameDigest && !refreshLoadedPages) {
            fresh = more ? { ...fresh, members: [...pinned.members, ...fresh.members] }
              : { ...pinned, members: [...fresh.members, ...pinned.members.slice(fresh.members.length)] };
          } else {
            const count = pinned.members.length + (more ? fresh.members.length : 0);
            if (more) fresh = await readPage();
            while (fresh.revision === pinned.revision && fresh.next && fresh.members.length < count &&
                generation === scope.current) {
              const next = await readPage(fresh.next, fresh.revision);
              if (next.nicknameDigest !== fresh.nicknameDigest) return;
              fresh = { ...next, members: [...fresh.members, ...next.members] };
            }
          }
        }
      } catch (failure) {
        if ((failure as { code?: string }).code !== 'PROTECTED_POLICY_CHANGED' || generation !== scope.current) throw failure;
        current.current = undefined;
        setPage(undefined);
        setSelectedId('');
        fresh = await readPage();
      }
      if (generation !== scope.current) return;
      setError('');
      if (pinned?.revision !== fresh.revision) {
        setSelectedId('');
        setEditingNickname(false);
      }
      current.current = fresh;
      setPage(fresh);
    } catch (failure) {
      if (generation !== scope.current) return;
      if ((failure as { code?: string }).code === 'RATE_LIMIT') return;
      current.current = undefined;
      setPage(undefined);
      setSelectedId('');
      setError((failure as Error).message);
    } finally {
      if (generation === scope.current) {
        running.current = false;
        setLoading(false);
      }
    }
  }, [serverId, channelId]);

  useEffect(() => {
    if (preview) return;
    scope.current++;
    running.current = false;
    current.current = undefined;
    setPage(undefined);
    setSelectedId('');
    setEditingNickname(false);
    setMenu(undefined);
    const initial = setTimeout(() => void load(), protectedChannelOpenDelay);
    const stop = window.desktop?.onMembershipProtectedEvent?.(event => {
      if (event.serverId === serverId && (event.type === 'state' || event.type === 'resync')) void load(false, true);
    });
    const stopNickname = window.desktop?.onMembershipChanged?.(event => {
      if (event?.serverId === serverId && event.nickname) applyNickname(event.nickname.profileId, event.nickname.name);
    });
    return () => { scope.current++; clearTimeout(initial); stop?.(); stopNickname?.(); };
  }, [load, serverId, preview]);
  useEffect(() => {
    if (preview) return;
    const timer = setInterval(() => void load(false, true), eventsLive ? 30_000 : 15_000);
    return () => clearInterval(timer);
  }, [load, eventsLive, preview]);
  useEffect(() => {
    if (!onProfiles) return;
    const names = new Map<string, ChatAuthorProfile>();
    const roleColors = new Map(Object.entries(page?.roleColors ?? {}));
    for (const member of page?.members ?? []) {
      names.set(member.id, { name: nameOf(member), avatar: member.avatar, color: member.color });
    }
    onProfiles({ serverId, channelId, names, roleColors, cursor: page?.next ? { after: page.next, revision: page.revision } : undefined });
  }, [onProfiles, serverId, channelId, page]);

  function applyNickname(id: string, name: string) {
    const latest = current.current;
    if (!latest?.members.some(member => member.id === id && member.name !== name)) return;
    scope.current++;
    running.current = false;
    setLoading(false);
    const updated = { ...latest, members: latest.members.map(member => member.id === id ? { ...member, name } : member) };
    current.current = updated;
    setPage(updated);
  }

  const groupMap = new Map<string, Group>();
  for (const member of visibleMembers ?? []) {
    const id = member.groupId ?? '';
    if (!groupMap.has(id)) groupMap.set(id, { id, rank: member.groupRank ?? Number.MAX_SAFE_INTEGER,
      role: member.roles.find(role => role.id === id), members: [] });
    groupMap.get(id)!.members.push(member);
  }
  const groups = [...groupMap.values()].sort((a, b) => a.rank - b.rank);
  const selected = !preview ? page?.members.find(member => member.id === selectedId) : undefined;
  const menuMember = menu && !preview ? page?.members.find(member => member.id === menu.id) : undefined;
  function menuItems(member: Member): MenuItem[] {
    const name = nameOf(member);
    const items: MenuItem[] = [{ label: t('Скопировать ID профиля'),
      action: () => void membership('copy', { text: member.id }).catch(failure => setError(failure.message)) }];
    if (member.id === profileId && onOpenProfileDevices) items.push({ label: t('Профиль и устройства'), action: onOpenProfileDevices });
    if (member.canEditNickname) items.push({ label: t('Изменить ник'), action: () => {
      setSelectedId(member.id);
      setEditingNickname(true);
    } });
    if (member.canAssignRoles && onAssignRoles) items.push({ label: t('Назначения ролей'), action: () => onAssignRoles(member.id, name) });
    if (!member.owner && member.id !== profileId && onPersonalACL) items.push({
      label: t('Персональные правила доступа'), action: () => onPersonalACL(member.id, name),
    });
    if (!member.owner && onTimeout) items.push({ label: t('Тайм-аут участника'), action: () => onTimeout(member.id, name) });
    if (member.canKick && onModerate) items.push({ label: t('Исключить с сервера'), danger: true, action: () => onModerate(member.id, name, 'kick') });
    if (member.canBan && onModerate) items.push({ label: t('Заблокировать'), danger: true, action: () => onModerate(member.id, name, 'ban') });
    return items;
  }
  if (selected) return <div className="protected-roster-card">
    <Button variant="quiet" className="protected-roster-back" onClick={() => { setSelectedId(''); setEditingNickname(false); }}>
      <Icon name="arrow-left" size={16}/>{t('Назад')}
    </Button>
    <div className="protected-roster-card-body">
      <div className="protected-roster-card-name">
        <RosterAvatar member={selected} ownAvatar={selected.id === profileId ? ownAvatar : undefined}/>
        <div>
          <strong style={{ color: selected.color }}>{nameOf(selected)}</strong>
          {selected.owner && <small>{t('Владелец')}</small>}
        </div>
      </div>
      <section className="protected-roster-card-section">
        <h3>{t('Роли')}</h3>
        <ul className="protected-roster-roles">{selected.roles.map(role =>
          <li key={role.id}>{role.icon && <span aria-hidden="true">{role.icon} </span>}{roleName(role)}</li>)}</ul>
      </section>
      <div className="protected-roster-card-actions">
        {selected.id === profileId && onOpenProfileDevices && <Button onClick={onOpenProfileDevices}>{t('Профиль и устройства')}</Button>}
        {selected.canEditNickname && <Button onClick={() => setEditingNickname(true)}>
          <Icon name="edit" size={17}/>{t('Изменить ник')}
        </Button>}
        {selected.canAssignRoles && onAssignRoles &&
          <Button onClick={() => onAssignRoles(selected.id, nameOf(selected))}>
            <Icon name="users" size={17}/>{t('Назначения ролей')}
          </Button>}
        {!selected.owner && selected.id !== profileId && onPersonalACL &&
          <Button onClick={() => onPersonalACL(selected.id, nameOf(selected))}>
            <Icon name="shield" size={17}/>{t('Персональные правила доступа')}
          </Button>}
        {!selected.owner && onTimeout && <Button onClick={() => onTimeout(selected.id, nameOf(selected))}>
            <Icon name="stopwatch" size={17}/>{t('Тайм-аут участника')}
        </Button>}
      </div>
      {onModerate && (selected.canKick || selected.canBan) && <div className="protected-roster-card-actions protected-roster-card-moderation">
        {selected.canKick && <Button variant="danger" onClick={() => onModerate(selected.id, nameOf(selected), 'kick')}>
          <Icon name="exit" size={17}/>{t('Исключить с сервера')}
        </Button>}
        {selected.canBan && <Button variant="danger" onClick={() => onModerate(selected.id, nameOf(selected), 'ban')}>
          <Icon name="lock" size={17}/>{t('Заблокировать')}
        </Button>}
      </div>}
    </div>
    {selected.canEditNickname && editingNickname && <ProtectedNicknameDialog
      key={selected.id} serverId={serverId} profileId={selected.id} channelId={channelId}
      onClose={() => setEditingNickname(false)} onSaved={name => {
        applyNickname(selected.id, name);
        setEditingNickname(false);
      }}/>}
  </div>;

  return <>
    {error && <p className="member-empty" role="alert">{error}</p>}
    {!visibleMembers && !error && <p className="member-empty" role="status">{t('Загружаем список участников…')}</p>}
    {visibleMembers?.length === 0 && <p className="member-empty">{t('Нет доступных участников')}</p>}
    {groups.map(group => <section className="protected-roster-group" key={group.id}>
      <h2>{group.role ? roleName(group.role) : t('Участники')}</h2>
      {group.members.sort((a, b) => presenceOrder[a.presence ?? 'offline'] - presenceOrder[b.presence ?? 'offline'] ||
        nameOf(a).localeCompare(nameOf(b), language) || a.id.localeCompare(b.id)).map(member =>
        <button className={`member-roster-person${member.presence === 'offline' ? ' offline' : ''}`}
          key={member.id} draggable={!preview} aria-disabled={preview || undefined} onDragStart={event => {
          if (preview) return;
          setMemberDrag(event.dataTransfer, serverId, member.id);
          setTransparentDragImage(event);
        }} onContextMenu={event => {
          if (preview) return;
          event.preventDefault();
          const anchor = event.currentTarget, bounds = anchor.getBoundingClientRect();
          const keyboard = event.clientX === 0 && event.clientY === 0;
          setMenu({ id: member.id, anchor, x: keyboard ? bounds.left : event.clientX, y: keyboard ? bounds.bottom : event.clientY });
        }} onClick={() => { if (!preview) { setMenu(undefined); setEditingNickname(false); setSelectedId(member.id); } }}>
          <RosterAvatar member={member} ownAvatar={member.id === profileId ? ownAvatar : undefined}/>
          <span className="member-roster-label">
            <span className="member-roster-nickname" style={{ color: member.color }}>{nameOf(member)}</span>
            {member.id === profileId && <small className="member-self-pin">{t('Вы')}</small>}
          </span>
        </button>)}
    </section>)}
    {page?.next && <Button disabled={loading} onClick={() => void load(true)}>{t('Показать ещё')}</Button>}
    {menu && menuMember && createPortal(<ContextMenu {...menu} items={menuItems(menuMember)} onClose={() => setMenu(undefined)}/>,
      menu.anchor.closest('dialog') ?? document.body)}
  </>;
}
