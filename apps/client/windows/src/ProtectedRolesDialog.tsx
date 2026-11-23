import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import catalog from '../../../server/internal/access/catalog.json';
import { Icon, Toggle } from './Controls';
import { ContextMenu } from './ContextMenu';
import { ProtectedRoleMembers } from './ProtectedRoleMembers';
import type { RoleView, RoleViewRequest } from './ProtectedRoleView';
import { t, useLanguage } from './i18n';
import { canRetryRoleChange, membership, roleChangeMessage } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';
import { useReorderDrag } from './ui/useReorderDrag';
import { ProtectedRoleAccessImpact, ProtectedScopedRoleImpact, type RoleAccessImpact, type ScopedRoleImpact } from './ProtectedAccessImpact';

type Role = { id: string; name?: string; grants: string[]; color: string; icon: string; hoist: boolean; mentionable: boolean;
  assigned?: number; ownHighestRole?: boolean; ownRoleStyle?: boolean };
type RolePolicy = { revision: number; roles: Role[]; policyHead?: string; grantOptions?: string[] };
type RoleDraft = Pick<Role, 'color' | 'icon' | 'hoist' | 'mentionable' | 'grants'> & { name: string; position: number };
export type RoleEditorEntry = 'appearance' | 'permissions' | 'members' | 'duplicate' | 'delete';
const everyoneRoleId = '@everyone';
const administratorGrant = 'server.administrator';
const roleFields = {
  name: 'Название роли',
  color: 'Цвет роли',
  icon: 'Значок или эмодзи',
  hoist: 'Показывать роль отдельно',
  mentionable: 'Разрешить упоминание роли',
  position: 'Место в иерархии',
} as const;
const roleFieldKeys = Object.keys(roleFields) as (keyof typeof roleFields)[];
const newRoleDraft = (): RoleDraft => ({ name: '', color: '', icon: '', hoist: false, mentionable: false, grants: [], position: 0 });
const roleName = (role: Role) => role.name ?? (role.id === everyoneRoleId ? t('Все участники') : role.id);
function roleDraft(roles: Role[], roleId?: string): RoleDraft {
  const role = roles.find(item => item.id === roleId);
  if (!role) return newRoleDraft();
  const { color, icon, hoist, mentionable, grants } = role;
  const position = Math.max(0, roles.filter(item => item.id !== everyoneRoleId).indexOf(role));
  return { name: roleName(role), color, icon, hoist, mentionable, grants, position };
}

function roleViewRequest(serverId: string, policy: RolePolicy, draft: RoleDraft, roleId?: string): RoleViewRequest {
  return {
    serverId,
    initial: roleId === everyoneRoleId ? [] : [roleId ?? 'draft'],
    roles: [...policy.roles].reverse().filter(role => role.id !== everyoneRoleId).map(role => ({
      id: role.id, name: role.id === roleId ? draft.name : roleName(role), color: role.id === roleId ? draft.color : role.color,
    })).concat(roleId ? [] : [{ id: 'draft', name: draft.name, color: draft.color }]),
    load: selection => membership<RoleView>('role.protected.view', {
      serverId, revision: policy.revision, roleId, ...draft,
      roles: selection.filter(id => id !== 'draft'), includeDraft: roleId === undefined && selection.includes('draft'),
    }),
  };
}

function updateRoleBasis(draft: RoleDraft, original: RoleDraft, latest: RoleDraft, lastPosition: number): RoleDraft {
  const pick = <T,>(local: T, before: T, current: T) => local === before ? current : local;
  const removed = original.grants.filter(id => !draft.grants.includes(id));
  const added = draft.grants.filter(id => !original.grants.includes(id));
  return {
    name: pick(draft.name, original.name, latest.name),
    color: pick(draft.color, original.color, latest.color),
    icon: pick(draft.icon, original.icon, latest.icon),
    hoist: pick(draft.hoist, original.hoist, latest.hoist),
    mentionable: pick(draft.mentionable, original.mentionable, latest.mentionable),
    position: Math.min(lastPosition, pick(draft.position, original.position, latest.position)),
    grants: [...new Set([...latest.grants.filter(id => !removed.includes(id)), ...added])],
  };
}

export function ProtectedRolesDialog({ serverId, scoped, channelNames, onClose, onApplied, onAssignments, onRoleView,
  initialRoleId, entry = 'appearance', inline = false, fullPage = false, footerHost }: {
  serverId: string; scoped?: boolean; channelNames?: Map<string, string>; onClose(): void; onApplied(roleId?: string): void; onAssignments?(): void;
  initialRoleId?: string; entry?: RoleEditorEntry; inline?: boolean; fullPage?: boolean; footerHost?: HTMLDivElement | null; onRoleView?: (view: RoleViewRequest) => void;
}) {
  const language = useLanguage();
  const permissionScopes: Record<string, string> = {
    server: t('Область: сервер'), resource: t('Область: категории и каналы'), category: t('Область: категории'),
    channel: t('Область: каналы'), text: t('Область: текстовые каналы'), voice: t('Область: голосовые каналы'),
  };
  const [policy, setPolicy] = useState<RolePolicy>();
  const [roleId, setRoleId] = useState(entry === 'duplicate' ? undefined : initialRoleId);
  const [draft, setDraft] = useState<RoleDraft>(newRoleDraft);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'appearance' | 'permissions' | 'members'>(entry === 'members' || entry === 'permissions' ? entry : 'appearance');
  type Preview = { previewId: string; impact?: RoleAccessImpact; scopedImpact?: ScopedRoleImpact };
  const [preview, setPreview] = useState<Preview>();
  const [retrySave, setRetrySave] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [conflicts, setConflicts] = useState<(keyof typeof roleFields)[]>([]);
  const [discard, setDiscard] = useState<{ run(): void }>();
  const basisAction = scoped ? 'roles.scoped.basis' : 'role.protected.manage';

  useEffect(() => {
    let active = true;
    void membership<RolePolicy>(basisAction, { serverId }).then(result => {
      if (active) {
        setPolicy(result);
        if (initialRoleId) {
          const initial = roleDraft(result.roles, initialRoleId);
          setDraft(entry === 'duplicate' && initial.name
            ? { ...initial, name: [...t('Копия роли «{0}»', initial.name)].slice(0, 64).join('') }
            : initial);
        }
      }
    }, failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [serverId, basisAction, initialRoleId, entry]);

  const roles = policy?.roles ?? [];
  const selected = roles.find(role => role.id === roleId);
  const update = (change: Partial<RoleDraft>) => {
    setRetrySave(undefined);
    setDraft(before => ({ ...before, ...change }));
  };
  const original = roleDraft(roles, roleId);
  const dirty = roleFieldKeys.some(key => original[key] !== draft[key]) ||
    original.grants.length !== draft.grants.length || draft.grants.some(id => !original.grants.includes(id));
  const missingRole = !!roleId && !selected;

  function leave(run: () => void) {
    if (busy) return;
    if (dirty) setDiscard({ run });
    else run();
  }

  function pick(id: string) {
    leave(() => {
      setRoleId(id || undefined);
      setTab('appearance');
      setSearch('');
      if (!needsRefresh) setError('');
      setRefreshed(false);
      setConflicts([]);
      setDraft(roleDraft(roles, id));
      setRetrySave(undefined);
    });
  }
  function showFailure(failure: unknown) {
    if ((failure as { code?: string })?.code === 'PROTECTED_POLICY_CHANGED') {
      setNeedsRefresh(true);
      setRefreshed(false);
      setError(t('Политика изменилась. Обновите данные роли и повторите действие.'));
    } else setError(roleChangeMessage(failure));
  }
  async function refreshBasis() {
    if (busy) return;
    setBusy(true);
    setError('');
    setRetrySave(undefined);
    try {
      const latest = await membership<RolePolicy>(basisAction, { serverId });
      setPolicy(latest);
      if (!roleId || latest.roles.some(role => role.id === roleId)) {
        const lastPosition = latest.roles.filter(role => role.id !== everyoneRoleId).length - (roleId ? 1 : 0);
        const latestDraft = roleDraft(latest.roles, roleId);
        setConflicts(roleFieldKeys.filter(key =>
          original[key] !== latestDraft[key] && original[key] !== draft[key] && latestDraft[key] !== draft[key]));
        setDraft(updateRoleBasis(draft, original, latestDraft, Math.max(0, lastPosition)));
        setRefreshed(true);
      } else {
        setError(t('Роль больше недоступна. Черновик остался в редакторе.'));
      }
      setNeedsRefresh(false);
    } catch (failure) { showFailure(failure); }
    finally { setBusy(false); }
  }
  async function review(action: 'save' | 'delete') {
    if (!policy || busy || needsRefresh || missingRole) return;
    setBusy(true);
    setError('');
    let prepared = action === 'save' ? retrySave : undefined;
    try {
      prepared ??= await membership<Preview>(
        scoped ? 'roles.scoped.preview' : 'role.protected.preview', {
          serverId, revision: policy.revision, policyHead: policy.policyHead, roleId, action, ...draft,
        });
      if (action === 'delete') setPreview(prepared);
      else await commit(prepared, true);
    } catch (failure) {
      setRetrySave(action === 'save' && scoped && canRetryRoleChange(failure) ? prepared : undefined);
      showFailure(failure);
    }
    finally { setBusy(false); }
  }
  const beginDelete = useEffectEvent(() => {
    if (selected && !selected.ownHighestRole && roleId !== everyoneRoleId) void review('delete');
  });
  const enteredDelete = useRef(false);
  useEffect(() => {
    if (entry !== 'delete' || !policy || enteredDelete.current) return;
    enteredDelete.current = true;
    beginDelete();
  }, [entry, policy]);
  async function commit(ready: Preview, save: boolean) {
    const result = await membership<{ roleId?: string } | undefined>(
      scoped ? 'roles.scoped.commit' : 'role.protected.commit', { serverId, previewId: ready.previewId });
    onApplied(save ? result?.roleId : undefined);
  }
  async function apply() {
    if (!preview || busy) return;
    setBusy(true);
    setError('');
    try {
      await commit(preview, false);
    } catch (failure) {
      if (!scoped || !canRetryRoleChange(failure)) setPreview(undefined);
      showFailure(failure);
    } finally { setBusy(false); }
  }

  const disabled = busy || !policy;
  const valid = !!draft.name.trim() && [...draft.name.trim()].length <= 64 &&
    (!draft.color || /^#[a-f0-9]{6}$/i.test(draft.color)) && [...draft.icon.trim()].length <= 32;
  const hasAdministrator = draft.grants.includes(administratorGrant);
  const canEditGrant = (id: string) => !selected?.ownHighestRole &&
    (!scoped || !!policy?.grantOptions?.includes(id) || !!selected?.grants.includes(id));
  const appearanceDisabled = disabled || (selected?.ownHighestRole && !selected.ownRoleStyle);
  const toggleGrant = (id: string, checked: boolean) => {
    update({ grants: checked ? [...draft.grants, id] : draft.grants.filter(grant => grant !== id) });
  };
  const administratorWarning = hasAdministrator && <p role="status">{t('Право «Администратор» даёт полный доступ, включая все закрытые каналы. Иерархия и защита владельца продолжают действовать. Для новых назначений нужно настроить восстановление доступа.')}</p>;
  const previewDisabled = disabled || needsRefresh || missingRole;
  function openRoleView() {
    if (!policy || !onRoleView) return;
    onRoleView(roleViewRequest(serverId, policy, draft, roleId));
  }
  const saveBar = dirty && !discard && !preview && <div className="protected-role-save">
    <span>{t('Есть несохранённые изменения')}</span>
    <div className="modal-actions protected-role-save-actions">
      <Button disabled={busy} onClick={() => { setDraft(original); setRetrySave(undefined); }}>{t('Сбросить')}</Button>
      <Button disabled={previewDisabled || !valid} variant="primary" onClick={() => void review('save')}>{t('Сохранить изменения')}</Button>
    </div>
  </div>;
  const navigation = <nav className="protected-role-editor-nav" aria-label={t('Роли')}>
    <div className="protected-role-editor-nav-actions">
      <Button variant="quiet" onClick={() => leave(onClose)}><Icon name="arrow-left" size={16}/>{t('Назад')}</Button>
      <button className="icon-button" type="button" aria-label={t('Создать роль')} onClick={() => pick('')} disabled={disabled}>
        <Icon name="plus" size={16}/>
      </button>
    </div>
    {[...roles].reverse().map(role => <Button key={role.id} variant="quiet" aria-pressed={roleId === role.id}
      disabled={busy} onClick={() => pick(role.id)}><i style={{ background: role.color || undefined }}/>{roleName(role)}</Button>)}
  </nav>;
  const content = <>
    {discard ? <p>{t('Отбросить несохранённые изменения роли?')}</p> : preview ? <div className="form-fields">
      <p>{t('Удалить роль «{0}»?', selected && roleName(selected))}</p>
      {selected?.assigned !== undefined && <p>{t('Назначений роли — {0}', selected.assigned)}</p>}
      <p>{t('Назначения будут сняты, а правила этой роли удалены из каналов и категорий.')}</p>
      {preview.impact && <ProtectedRoleAccessImpact impact={preview.impact}/>}
      {preview.scopedImpact && <ProtectedScopedRoleImpact impact={preview.scopedImpact} channelNames={channelNames}/>}
    </div> : <div className="form-fields">
      {needsRefresh && <div><Button variant="secondary" disabled={busy} onClick={() => void refreshBasis()}>{t('Обновить данные роли')}</Button></div>}
      {refreshed && <p role="status">{t('Данные роли обновлены. Ваши изменения сохранены в черновике. Проверьте его перед применением.')}</p>}
      {refreshed && conflicts.length > 0 && <p role="status">
        {t('На сервере изменились те же поля. Сейчас в черновике ваши значения: {0}.', conflicts.map(key => t(roleFields[key])).join(', '))}
      </p>}
      <h3>{selected ? t('Редактировать роль — {0}', roleName(selected)) : t('Создать роль')}</h3>
      <nav className="protected-role-tabs" aria-label={t('Роли')}>
        <Button variant="quiet" aria-current={tab === 'appearance' ? 'page' : undefined}
          onClick={() => setTab('appearance')}>{t('Оформление роли')}</Button>
        <Button variant="quiet" aria-current={tab === 'permissions' ? 'page' : undefined}
          onClick={() => setTab('permissions')}>{t('Права доступа')}</Button>
        {roleId && roleId !== everyoneRoleId && !scoped && <Button variant="quiet" aria-current={tab === 'members' ? 'page' : undefined}
          onClick={() => setTab('members')}>{t('Участники')}</Button>}
      </nav>
      {tab === 'appearance' && <>
        {selected?.ownHighestRole && <p className="host-hint">{t(selected.ownRoleStyle
          ? 'Для своей высшей роли можно изменить название, цвет и значок.'
          : 'Для изменения оформления своей высшей роли обновите сервер.')}</p>}
        <label>{t('Название роли')}<input value={draft.name} disabled={appearanceDisabled} onChange={event => update({ name: event.target.value })}/></label>
        <div className="form-grid">
          <label className="theme-color-field">{t('Цвет роли')}<span className="theme-color-control">
            <input type="color" aria-label={t('Цвет роли')} value={draft.color || '#5a89bc'} disabled={appearanceDisabled}
              onChange={event => update({ color: event.target.value })}/>
            <Button type="button" variant="quiet" disabled={appearanceDisabled || !draft.color} onClick={() => update({ color: '' })}>{t('По умолчанию')}</Button>
          </span></label>
          <label>{t('Значок или эмодзи')}<input value={draft.icon} disabled={appearanceDisabled} onChange={event => update({ icon: event.target.value })}/></label>
        </div>
        <Toggle label={t('Показывать роль отдельно')} checked={draft.hoist} disabled={disabled || selected?.ownHighestRole} onChange={hoist => update({ hoist })}/>
        <Toggle label={t('Разрешить упоминание роли')} checked={draft.mentionable} disabled={disabled || selected?.ownHighestRole}
          onChange={mentionable => update({ mentionable })}/>
        {!scoped && onRoleView && <div><Button disabled={previewDisabled || !valid} onClick={openRoleView}>{t('Предпросмотр сервера от лица роли')}</Button></div>}
      </>}
      {tab === 'permissions' && <>
        <input type="search" aria-label={t('Поиск по правам')} placeholder={t('Поиск по правам')}
          value={search} disabled={disabled} onChange={event => setSearch(event.target.value)}/>
        <h4>{t('Основные права сервера')}</h4>
        <div className="protected-role-permissions">
          {catalog.permissions.filter(permission => permission.id !== administratorGrant &&
            permission[language].toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(permission =>
            <Toggle key={permission.id} label={permission[language]} detail={permissionScopes[permission.scope]}
              checked={draft.grants.includes(permission.id)} disabled={disabled || !canEditGrant(permission.id)}
              onChange={checked => toggleGrant(permission.id, checked)}/>)}
        </div>
        {(canEditGrant(administratorGrant) || hasAdministrator) && (!search.trim() ||
          t('Администратор').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && <>
          <h4>{t('Расширенные права')}</h4>
          <div className="protected-role-permissions"><Toggle label={t('Администратор')} detail={t('Полный доступ, включая все закрытые каналы')}
            checked={hasAdministrator} disabled={disabled || !canEditGrant(administratorGrant)}
            onChange={checked => toggleGrant(administratorGrant, checked)}/></div>
          {administratorWarning}
        </>}
      </>}
      {tab === 'members' && roleId && <ProtectedRoleMembers key={roleId} serverId={serverId} roleId={roleId}
        changed={() => void refreshBasis()}/>}
      {!inline && onAssignments && <div><Button variant="secondary" disabled={busy} onClick={() => leave(onAssignments)}>{t('Назначения ролей')}</Button></div>}
    </div>}
    {discard ? <div className="modal-actions">
      <Button autoFocus onClick={() => setDiscard(undefined)}>{t('Продолжить редактирование')}</Button>
      <Button variant="danger" onClick={() => { setDiscard(undefined); discard.run(); }}>{t('Отбросить изменения')}</Button>
    </div> : preview ? <div className="modal-actions">
      <Button disabled={busy} onClick={() => entry === 'delete' ? onClose() : setPreview(undefined)}>{t('Назад')}</Button>
      <Button disabled={busy} variant="danger" onClick={() => void apply()}>{t('Удалить роль')}</Button>
    </div> : <>
      {selected && !selected.ownHighestRole && roleId !== everyoneRoleId && tab === 'appearance' && <div className="modal-actions">
        <Button disabled={previewDisabled} variant="quiet" className="text-error" onClick={() => void review('delete')}>{t('Удалить роль')}</Button>
      </div>}
    </>}
  </>;
  const editor = <div className="protected-role-editor">{navigation}<div className="protected-role-editor-content">{content}</div></div>;
  if (inline) return <section aria-label={t('Роли сервера')}>
    {error && <p role="alert" className="text-error">{error}</p>}{editor}
    {footerHost && createPortal(saveBar, footerHost)}
  </section>;
  return <Modal title={t('Роли сервера')} fullPage={fullPage} className={fullPage ? 'settings-modal' : undefined}
    error={error} footer={saveBar} onClose={() => discard ? setDiscard(undefined) : leave(onClose)}>
    {fullPage ? <div className="settings-panel protected-role-full-page"><div className="settings-content">{editor}</div></div> : editor}
  </Modal>;
}

export function ProtectedRolesSettings({ serverId, onEdit, onRoleView, footerHost }: {
  serverId: string; onEdit(roleId?: string, entry?: RoleEditorEntry): void;
  onRoleView(view: RoleViewRequest): void; footerHost: HTMLDivElement | null;
}) {
  const [policy, setPolicy] = useState<RolePolicy>();
  const [order, setOrder] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const [version, reload] = useState(0);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<{ role: Role; anchor: HTMLButtonElement; x: number; y: number }>();
  useEffect(() => {
    let active = true;
    void membership<RolePolicy>('role.protected.manage', { serverId }).then(policy => {
      if (active) setPolicy(policy);
    }, failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [serverId, version]);
  const roles = policy?.roles;
  const custom = (roles ?? []).filter(role => role.id !== everyoneRoleId).reverse();
  const sorted = order?.map(id => custom.find(role => role.id === id)).filter((role): role is Role => !!role) ?? custom;
  const visible = sorted.filter(role => roleName(role).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const dirty = !!order && order.some((id, index) => id !== custom[index]?.id);
  const drag = useReorderDrag(visible.map(role => role.id), ids => setOrder(ids));
  async function saveOrder() {
    if (busy || !policy || !dirty || !order) return;
    setBusy(true); setError('');
    try {
      const { previewId } = await membership<{ previewId: string }>('role.protected.order-preview', {
        serverId, revision: policy.revision, order: [...order].reverse(),
      });
      await membership('role.protected.commit', { serverId, previewId });
      setPolicy({ ...policy, roles: [...policy.roles.filter(role => role.id === everyoneRoleId), ...[...sorted].reverse()] });
      setOrder(undefined);
      reload(value => value + 1);
    } catch (failure) {
      setError(roleChangeMessage(failure));
      if ((failure as { code?: string }).code === 'PROTECTED_POLICY_CHANGED') { setOrder(undefined); reload(value => value + 1); }
    } finally { setBusy(false); }
  }
  return <div className="form-fields">
    {error && <p role="alert" className="text-error">{error}</p>}
    {roles?.some(role => role.id === everyoneRoleId) &&
      <button type="button" className="role-default-card" disabled={dirty} onClick={() => onEdit(everyoneRoleId, 'permissions')}>
        <span className="role-default-icon"><Icon name="users" size={20}/></span>
        <span className="role-default-copy"><strong>{t('Права по умолчанию')}</strong>
          <small>{t('@everyone · распространяется на всех участников сервера')}</small></span>
        <Icon name="chevron-right" size={17}/>
      </button>}
    <div className="protected-roles-list-actions">
      <label>{t('Поиск роли')}<input type="search" value={search} onChange={event => setSearch(event.target.value)}/></label>
      <Button variant="primary" disabled={!roles || dirty} onClick={() => onEdit()}>{t('Создать роль')}</Button>
    </div>
    <div className="server-settings-role-labels">
      <strong>{t('Роли — {0}', custom.length)}</strong><span>{t('Участники')}</span>
    </div>
    <ul className="server-settings-roles" {...drag.list}>
      {visible.map(role => <li key={role.id} {...drag.item(role.id)}>
        <span className="role-drag-handle" draggable={!search.trim() && !busy}
          title={t('Изменить порядок ролей')}
          onDragStart={event => drag.start(event, role.id)} onDragEnd={drag.end}><Icon name="grip" size={16}/></span>
        <button className="role-list-name" type="button" disabled={dirty} onClick={() => { if (!drag.suppressClick()) onEdit(role.id); }}>
          <span className="role-list-symbol" aria-hidden="true" data-icon={role.icon || undefined}
            style={{ color: role.color || undefined }}>{!role.icon && <Icon name="shield" size={19}/>}</span>
          <span>{roleName(role)}</span>
        </button>
        <button type="button" className="role-list-count" disabled={dirty} title={t('Показать участников')}
          aria-label={t('Показать участников роли «{0}»', roleName(role))} onClick={() => onEdit(role.id, 'members')}>
          <span>{role.assigned ?? '—'}</span><Icon name="users" size={16}/>
        </button>
        <button type="button" className="icon-button role-list-action" disabled={dirty} title={t('Редактировать роль')}
          aria-label={t('Редактировать роль — {0}', roleName(role))} onClick={() => onEdit(role.id)}><Icon name="edit" size={17}/></button>
        <button type="button" className="icon-button role-list-action" disabled={dirty} title={t('Действия с ролью')}
          aria-label={t('Действия с ролью — {0}', roleName(role))} aria-haspopup="menu" aria-expanded={menu?.role.id === role.id}
          onClick={event => {
            const box = event.currentTarget.getBoundingClientRect();
            setMenu(menu?.role.id === role.id ? undefined : { role, anchor: event.currentTarget, x: box.left, y: box.bottom + 4 });
          }}><Icon name="more" size={18}/></button>
      </li>)}
    </ul>
    {menu && policy && <ContextMenu {...menu} onClose={() => setMenu(undefined)} items={[
      { label: t('Дублировать роль'), icon: 'copy', action: () => onEdit(menu.role.id, 'duplicate') },
      { label: t('Предпросмотр сервера от лица роли'), icon: 'arrow-right',
        action: () => onRoleView(roleViewRequest(serverId, policy, roleDraft(policy.roles, menu.role.id), menu.role.id)) },
      { label: t('Удалить роль'), icon: 'trash', danger: true, separatorBefore: true,
        disabled: menu.role.ownHighestRole, action: () => onEdit(menu.role.id, 'delete') },
    ]}/>}
    {dirty && footerHost && createPortal(<div className="protected-role-save">
      <span>{t('Есть несохранённые изменения')}</span>
      <div className="modal-actions protected-role-save-actions">
        <Button disabled={busy} onClick={() => setOrder(undefined)}>{t('Сбросить')}</Button>
        <Button disabled={busy} variant="primary" onClick={() => void saveOrder()}>{t('Сохранить изменения')}</Button>
      </div>
    </div>, footerHost)}
  </div>;
}
