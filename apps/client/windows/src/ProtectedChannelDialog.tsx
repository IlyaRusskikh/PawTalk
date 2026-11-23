import { useEffect, useState } from 'react';
import catalog from '../../../server/internal/access/catalog.json';
import { Icon, Toggle } from './Controls';
import { ProtectedPermissionRows } from './ProtectedPermissionRows';
import { everyoneSubject, permissionRule, ProtectedPermissionSubjects, subjectKey,
  type PermissionAppearanceScope, type PermissionChange, type PermissionSubject } from './ProtectedPermissionSubjects';
import { t, useLanguage } from './i18n';
import { membership, type ProtectedServerState } from './membership';
import { Modal } from './Modal';
import { SettingsSaveBar } from './SettingsSaveBar';
import { Button } from './ui/Button';
import { ProtectedAccessImpact, ProtectedChannelAccessDelta,
  type AccessImpact, type ChannelAccessDelta } from './ProtectedAccessImpact';
import { ProtectedOrderFields } from './ProtectedOrderFields';
import { ProtectedChannelDeleteDialog } from './ProtectedChannelDeleteDialog';

type Channel = ProtectedServerState['channels'][number];
type Rule = 'inherit' | 'allow' | 'deny';
type ChannelAction = 'channel.create' | 'channel.settings.update' | 'channel.acl.update' |
  'channel.acl.personal' | 'channel.acl.sync' | 'channel.copy' | 'channel.move' | 'channel.order';
type DialogAction = ChannelAction | 'channel.continue';
type ChannelPolicy = {
  revision: number;
  settings?: { Name: string; Description: string; SlowmodeSeconds: number; VoiceCapacity: number };
  synchronized?: boolean;
  explicitAdminView?: boolean;
  canSynchronize?: boolean;
  roles?: { id: string; name?: string; color?: string }[];
  rules?: Record<string, { Allow: string[]; Deny: string[] }>;
  profiles?: { id: string; name?: string; explicitViewOnly?: boolean }[];
  profileRules?: Record<string, { Allow: string[]; Deny: string[] }>;
  categories?: { id: string; name?: string }[];
  siblings?: { id: string; name?: string }[];
};

const labels = {
  'channel.create': 'Создать канал',
  'channel.settings.update': 'Настройки канала',
  'channel.acl.update': 'Права роли в канале',
  'channel.acl.personal': 'Персональные права в канале',
  'channel.acl.sync': 'Синхронизировать права с категорией',
  'channel.copy': 'Создать копию канала',
  'channel.continue': 'Создать новый канал после утраты ключей',
  'channel.move': 'Переместить канал',
  'channel.order': 'Изменить порядок каналов',
} satisfies Record<DialogAction, string>;
const ruleLabels = { inherit: 'Наследовать', allow: 'Разрешить', deny: 'Запретить' } satisfies Record<Rule, string>;

export function ProtectedChannelDialog({ serverId, channel, channels, orderOnly = false, initialMoveCategoryId, initialCategoryId,
  initialKind, initialAction, addedRole, appearanceScope, onCreateRole, onClose, onApplied }: {
  serverId: string;
  channel?: Channel;
  channels: Channel[];
  orderOnly?: boolean;
  initialMoveCategoryId?: string;
  initialCategoryId?: string;
  initialKind?: 'text' | 'voice';
  initialAction?: 'channel.copy';
  appearanceScope?: PermissionAppearanceScope;
  addedRole?: string;
  onCreateRole?(): void;
  onClose(): void;
  onApplied(channelId: string, action: ChannelAction | 'channel.delete'): void;
}) {
  const language = useLanguage();
  const [policy, setPolicy] = useState<ChannelPolicy>();
  const droppedChannel = initialMoveCategoryId !== undefined;
  const [action, setAction] = useState<DialogAction>(droppedChannel ? 'channel.move' :
    orderOnly ? 'channel.order' : channel ? initialAction ?? 'channel.settings.update' : 'channel.create');
  const [kind, setKind] = useState<'text' | 'voice'>(channel?.kind ?? initialKind ?? 'text');
  const [name, setName] = useState(channel?.name ?? '');
  const [description, setDescription] = useState('');
  const [slowmode, setSlowmode] = useState('0');
  const [capacity, setCapacity] = useState('0');
  const [role, setRole] = useState('@everyone');
  const [profileId, setProfileId] = useState('');
  const [categoryId, setCategoryId] = useState(initialMoveCategoryId ?? channel?.categoryId ?? initialCategoryId ?? '');
  const [mode, setMode] = useState<'' | 'preserve' | 'synchronize'>(droppedChannel ? '' : 'preserve');
  const [anchorId, setAnchorId] = useState('');
  const [after, setAfter] = useState(false);
  const [permission, setPermission] = useState('channel.view');
  const [changes, setChanges] = useState<PermissionChange[]>([]);
  const [addedSubjects, setAddedSubjects] = useState<string[]>([]);
  const [keyLossConfirmed, setKeyLossConfirmed] = useState(false);
  const [preview, setPreview] = useState<{ previewId: string; impact?: AccessImpact | ChannelAccessDelta }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [chooseMembers, setChooseMembers] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [privateRoles, setPrivateRoles] = useState<string[]>([]);
  const [privateProfiles, setPrivateProfiles] = useState<string[]>([]);

  const channelId = channel?.id;
  useEffect(() => {
    let active = true;
    void membership<ChannelPolicy>('channel.protected.manage', {
      serverId, channelId, ...(orderOnly ? { orderOnly } : channelId ? { personal: true } : { creationAccess: true }),
    }).then(value => {
      if (!active) return;
      setPolicy(value);
      if (value.settings) {
        setName(value.settings.Name);
        setDescription(value.settings.Description);
        setSlowmode(String(value.settings.SlowmodeSeconds));
        setCapacity(String(value.settings.VoiceCapacity));
      }
    }, failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [serverId, channelId, orderOnly]);
  useEffect(() => {
    if (!addedRole || !channelId) return;
    let active = true;
    void membership<ChannelPolicy>('channel.protected.manage', { serverId, channelId, personal: true }).then(value => {
      if (!active) return;
      setPolicy(value);
      if (value.roles?.some(item => item.id === addedRole)) {
        setRole(addedRole);
        setAddedSubjects(previous => [...previous, subjectKey({ id: addedRole, name: addedRole })]);
        setAction('channel.acl.update');
      }
    }, failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [serverId, channelId, addedRole]);

  const personal = action === 'channel.acl.personal';
  const access = personal || action === 'channel.acl.update';
  const availableSubjects: PermissionSubject[] = [
    ...(policy?.roles ?? []).filter(item => item.id !== '@everyone')
      .map(item => ({ id: item.id, name: item.name ?? item.id, color: item.color })),
    ...(policy?.profiles ?? []).map(item => ({
      id: item.id, name: profileName(item), profile: true, explicitViewOnly: item.explicitViewOnly,
    })),
  ];
  const visibleSubjects = [everyoneSubject, ...availableSubjects.filter(subject => addedSubjects.includes(subjectKey(subject)) ||
    Object.hasOwn((subject.profile ? policy?.profileRules : policy?.rules) ?? {}, subject.id))];
  const activeSubject = visibleSubjects.find(subject => personal ? subject.profile && subject.id === profileId :
    !subject.profile && subject.id === role) ?? everyoneSubject;
  function originalRule(subject: PermissionSubject, id: string): Rule {
    return permissionRule(subject.profile ? policy?.profileRules : policy?.rules, subject.id, id);
  }
  function ruleFor(subject: PermissionSubject, id: string): Rule {
    return changes.find(change => (subject.profile ? change.profileId : change.role) === subject.id && change.permission === id)?.rule ??
      originalRule(subject, id);
  }
  function changeRule(subject: PermissionSubject, permission: string, rule: Rule) {
    const original = originalRule(subject, permission);
    setChanges(previous => {
      const next = previous.filter(change => (subject.profile ? change.profileId : change.role) !== subject.id || change.permission !== permission);
      if (rule !== original) next.push({ ...(subject.profile ? { profileId: subject.id } : { role: subject.id }), permission, rule });
      return next;
    });
  }
  function selectSubject(subject: PermissionSubject) {
    setAction(subject.profile ? 'channel.acl.personal' : 'channel.acl.update');
    if (subject.profile) setProfileId(subject.id);
    else setRole(subject.id);
    setPermission('channel.view');
  }
  const creating = action === 'channel.create';
  const choosingPrivateAccess = creating && isPrivate && !chooseMembers;
  const settings = creating || action === 'channel.settings.update';
  const settingsPage = !!channel && !orderOnly && !droppedChannel && initialAction !== 'channel.copy';
  const editingSettings = settingsPage && (settings || access || action === 'channel.acl.sync');
  const originalName = policy?.settings?.Name ?? channel?.name ?? '';
  const originalDescription = policy?.settings?.Description ?? '';
  const originalSlowmode = String(policy?.settings?.SlowmodeSeconds ?? 0);
  const originalCapacity = String(policy?.settings?.VoiceCapacity ?? 0);
  const dirty = settings
    ? name !== originalName || description !== originalDescription || slowmode !== originalSlowmode || capacity !== originalCapacity
    : action === 'channel.acl.sync' || changes.length > 0;
  const continuing = action === 'channel.continue';
  const copying = action === 'channel.copy';
  const policyAction = continuing ? 'channel.copy' : action;
  const numeric = kind === 'text' ? slowmode : capacity;
  const categories = policy?.categories ?? [];
  const destination = categories.find(category => category.id === categoryId);
  const canPreview = !!policy && (!settings || (!!name.trim() && [...name.trim()].length <= 64 &&
    /^\d+$/.test(numeric) && Number(numeric) <= (kind === 'text' ? 21600 : 0xffffffff))) &&
    (!editingSettings || !settings || name.trim() !== originalName || description !== originalDescription ||
      Number(numeric) !== Number(kind === 'text' ? originalSlowmode : originalCapacity)) &&
    (!access || changes.length > 0 && changes.length <= 128) &&
    (!continuing || keyLossConfirmed) &&
    (action !== 'channel.move' || (!!mode && categoryId !== channel?.categoryId && (!categoryId || !!destination))) &&
    (action !== 'channel.order' || !!anchorId);
  const siblings = (policy?.siblings ?? []).map(item => ({
    id: item.id, name: item.name ?? channels.find(channel => channel.id === item.id)?.name ?? t('Канал · {0}', item.id.slice(0, 8)),
  }));
  const categoryName = (category: { id: string; name?: string }) => category.name ?? t('Категория · {0}', category.id.slice(0, 8));
  function profileName(profile: { id: string; name?: string }) {
    return profile.name ?? t('Участник · {0}', profile.id.slice(0, 8));
  }
  const matchesSearch = (label: string) => label.toLocaleLowerCase().includes(memberSearch.trim().toLocaleLowerCase());
  const toggleRecipient = (values: string[], id: string) => values.includes(id) ? values.filter(value => value !== id) : [...values, id];

  function resetDraft() {
    setName(originalName);
    setDescription(originalDescription);
    setSlowmode(originalSlowmode);
    setCapacity(originalCapacity);
    setChanges([]);
    setAddedSubjects([]);
    setRole('@everyone');
    setProfileId('');
    setError('');
  }
  function chooseAction(next: DialogAction) {
    if (action === next || busy) return;
    resetDraft();
    setAction(next);
    setPreview(undefined);
    setPermission('channel.view');
    setCategoryId(channel?.categoryId ?? '');
    setMode('preserve');
    setAnchorId('');
    setAfter(false);
    setKeyLossConfirmed(false);
  }
  async function review() {
    if (!policy || !canPreview || busy) return;
    setError('');
    setBusy(true);
    try {
      const result = await membership<{ previewId: string; impact?: AccessImpact | ChannelAccessDelta }>('channel.protected.preview', {
        serverId, channelId, revision: policy.revision, action: policyAction, kind, name, description: kind === 'text' ? description : originalDescription,
        slowmodeSeconds: Number(slowmode), voiceCapacity: Number(capacity), ...(personal ? { profileId } : { role }),
        permission, rule: ruleFor(activeSubject, permission), categoryId, mode, anchorId, after,
        ...(policyAction === 'channel.order' && !channel?.categoryId && { mixedOrder: true }),
        ...(access && { changes }),
        ...(!channel && isPrivate && { privateAccess: { roles: privateRoles, profiles: privateProfiles } }),
      });
      if (creating || copying || editingSettings) await commit(result.previewId);
      else setPreview(result);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  async function commit(previewId: string) {
    const result = await membership<{ channelId: string }>('channel.protected.commit', { serverId, previewId });
    onApplied(result.channelId, policyAction);
  }
  async function apply() {
    if (!preview || busy) return;
    setError('');
    setBusy(true);
    try {
      await commit(preview.previewId);
    } catch (failure) {
      setPreview(undefined);
      setError((failure as Error).message);
    } finally { setBusy(false); }
  }

  if (copying) return <Modal title={t(labels['channel.copy'])} error={error} className="chat-delete-modal protected-channel-copy-dialog"
    onClose={() => { if (!busy) onClose(); }}>
    <p className="chat-delete-question">{t('Создать копию канала «{0}»?', channel?.name ?? channelId)}</p>
    <p>{t('Будут скопированы настройки и права канала. История останется в исходном канале.')}</p>
    <div className="modal-actions">
      <Button autoFocus type="button" disabled={busy} onClick={onClose}>{t('Отмена')}</Button>
      <Button type="button" variant="primary" disabled={busy || !canPreview}
        onClick={() => void review()}>{t('Создать копию')}</Button>
    </div>
  </Modal>;

  const title = droppedChannel ? t(labels['channel.move']) :
    orderOnly ? t('Изменить порядок каналов') : channel ? t('Управление каналом') :
      chooseMembers && !preview ? t('Добавить участников или роли') : t('Создать канал');
  const heading = settings ? t('Обзор') : access ? t('Права доступа') : t(labels[action]);
  const navigation = <nav className="settings-nav" aria-label={t('Настройки канала')}>
    <div className="settings-nav-caption">{channel?.name ?? channelId}</div>
    <button type="button" aria-current={settings ? 'page' : undefined} disabled={busy}
      onClick={() => void chooseAction('channel.settings.update')}><Icon name="settings" size={16}/>{t('Обзор')}</button>
    <button type="button" aria-current={access || action === 'channel.acl.sync' ? 'page' : undefined} disabled={busy}
      onClick={() => void chooseAction('channel.acl.update')}><Icon name="shield" size={16}/>{t('Права доступа')}</button>
    {policy?.settings && kind === 'text' && <button type="button" aria-current={continuing ? 'page' : undefined}
      disabled={busy} onClick={() => void chooseAction('channel.continue')}>{t(labels['channel.continue'])}</button>}
    <button type="button" className="text-error" disabled={busy} onClick={() => setDeleteOpen(true)}>
      <Icon name="trash" size={16}/>{t('Удалить канал')}
    </button>
  </nav>;
  const content = <>
    {preview ? <div className="form-fields">
      {settings ? <>
        <p>{t('Проверьте настройки канала «{0}» перед применением.', name.trim())}</p>
        {description && <p>{description}</p>}
        <p>{kind === 'text' ? t('Пауза между сообщениями — {0} с', Number(slowmode)) : t('Лимит участников — {0}', Number(capacity))}</p>
      </> : <p>{t(labels[action])} · {channel?.name}</p>}
      {access && <ul>{changes.map(change => <li key={JSON.stringify([change.role, change.profileId, change.permission])}>
        {visibleSubjects.find(subject => subject.profile ? subject.id === change.profileId : subject.id === change.role)?.name}
        {' · '}{catalog.permissions.find(item => item.id === change.permission)?.[language] ?? change.permission} · {t(ruleLabels[change.rule])}
      </li>)}</ul>}
      {preview.impact && ('keyChannels' in preview.impact ? <ProtectedChannelAccessDelta impact={preview.impact}/>
        : <ProtectedAccessImpact impact={preview.impact}/>)}
      {access && policy?.synchronized &&
        <p>{t('Сейчас канал наследует правила категории. Изменение создаст отдельные правила канала.')}</p>}
      {action === 'channel.acl.sync' && <p>{t('Правила канала будут заменены правилами категории.')}</p>}
      {action === 'channel.move' && <p>{destination ? categoryName(destination) : t('Без категории')} ·
        {' '}{mode === 'preserve' ? t('Сохранить текущие права') : t('Принять права категории')}</p>}
      {action === 'channel.order' && <p>{after ? t('После выбранного') : t('Перед выбранным')} · {siblings.find(item => item.id === anchorId)?.name}</p>}
      {continuing && <p>{t('Новый канал получит свои ключи, настройки и права исходного канала. Старый шифрованный архив останется в исходном канале.')}</p>}
    </div> : chooseMembers ? <div className="form-fields">
      <p>{name.trim()}</p>
      <label>{t('Роли и участники')}<input autoFocus type="search" value={memberSearch} disabled={busy}
        onChange={event => setMemberSearch(event.target.value)}/></label>
      <div className="protected-channel-recipients">
        {policy?.roles?.filter(item => matchesSearch(item.name ?? item.id)).map(item =>
          <label key={item.id}><input type="checkbox" checked={privateRoles.includes(item.id)} disabled={busy}
            onChange={() => setPrivateRoles(toggleRecipient(privateRoles, item.id))}/>{item.name ?? item.id} <small>{t('Роль')}</small></label>)}
        {policy?.profiles?.filter(item => matchesSearch(profileName(item))).map(item =>
          <label key={item.id}><input type="checkbox" checked={privateProfiles.includes(item.id)} disabled={busy}
            onChange={() => setPrivateProfiles(toggleRecipient(privateProfiles, item.id))}/>{profileName(item)} <small>{t('Участник')}</small></label>)}
      </div>
    </div> : <div className="form-fields">
      {action === 'channel.acl.sync' && <p>{t('Правила канала будут заменены правилами категории.')}</p>}
      {continuing && <>
        <p>{t('При отключённых устройствах доставка ключей может задерживаться. Продолжайте только после подтверждения безвозвратной утраты ключей исходного канала.')}</p>
        <Toggle label={t('Подтверждаю, что ключи исходного канала утрачены')} checked={keyLossConfirmed} disabled={busy || !policy}
          onChange={setKeyLossConfirmed}/>
      </>}
      {settings && <>
        {!channel && <label>{t('Тип канала')}<select value={kind} disabled={busy || !policy}
          onChange={event => setKind(event.target.value === 'voice' ? 'voice' : 'text')}>
          <option value="text">{t('Текстовый канал')}</option><option value="voice">{t('Голосовой канал')}</option>
        </select></label>}
        <label>{t('Название канала')}<input value={name} disabled={busy || !policy} onChange={event => setName(event.target.value)}/></label>
        {kind === 'text' && <label>{t(channel ? 'Тема канала' : 'Описание')}<textarea value={description} disabled={busy || !policy}
          onChange={event => setDescription(event.target.value)} rows={channel ? 7 : 3}/></label>}
        {kind === 'text' ? <label>{t('Пауза между сообщениями (с)')}<input type="number" min={0} max={21600} value={slowmode}
          disabled={busy || !policy} onChange={event => setSlowmode(event.target.value)}/></label>
          : <label>{t('Лимит участников (0 — без ограничения)')}<input type="number" min={0} max={0xffffffff} value={capacity}
            disabled={busy || !policy} onChange={event => setCapacity(event.target.value)}/></label>}
        {!channel && <Toggle label={t('Приватный канал')} checked={isPrivate} disabled={busy || !policy}
          onChange={setIsPrivate}/>}
      </>}
      {action === 'channel.move' && <>
        <label>{t('Категория')}<select value={categoryId} disabled={busy || !policy} onChange={event => {
          setCategoryId(event.target.value);
          setMode(droppedChannel ? '' : 'preserve');
        }}>
          <option value="">{t('Без категории')}</option>
          {!!categoryId && !destination && droppedChannel && <option value={categoryId} disabled>
            {categoryName({ id: categoryId })}
          </option>}
          {categories.map(category => <option key={category.id} value={category.id}>{categoryName(category)}</option>)}
        </select></label>
        <label>{t('Права при переносе')}<select value={mode} disabled={busy || !policy}
          onChange={event => setMode(event.target.value === 'synchronize' ? 'synchronize' : 'preserve')}>
          {droppedChannel && <option value="" disabled>{t('Выберите права при переносе')}</option>}
          <option value="preserve">{t('Сохранить текущие права')}</option>
          {!!categoryId && <option value="synchronize">{t('Принять права категории')}</option>}
        </select></label>
      </>}
      {action === 'channel.order' && <ProtectedOrderFields items={siblings} anchorId={anchorId} after={after} disabled={busy || !policy}
        onAnchor={setAnchorId} onAfter={setAfter}/>}
      {access && <>
        <div className="protected-access-card">
          {policy?.synchronized
            ? <p>{t('Сейчас канал наследует правила категории. Изменение создаст отдельные правила канала.')}</p>
            : policy?.canSynchronize && <Button disabled={busy} onClick={() => void chooseAction('channel.acl.sync')}>
              {t(labels['channel.acl.sync'])}
            </Button>}
          <Toggle label={t('Приватный канал')}
            checked={ruleFor(everyoneSubject, 'channel.view') === 'deny'}
            disabled={busy || !policy}
            onChange={checked => {
              selectSubject(everyoneSubject);
              changeRule(everyoneSubject, 'channel.view', checked ? 'deny' : 'inherit');
            }}/>
        </div>
        <h3>{t('Расширенные права')}</h3>
        <div className="protected-permission-layout">
          <ProtectedPermissionSubjects subjects={visibleSubjects} available={availableSubjects} active={activeSubject}
            appearanceScope={appearanceScope} onCreateRole={onCreateRole}
            emptyHint={policy?.explicitAdminView === false
              ? t('Для явного добавления администраторов в список доступа обновите сервер.') : undefined}
            disabled={busy || !policy} onSelect={selectSubject} onAdd={subject => {
              setAddedSubjects(previous => [...previous, subjectKey(subject)]);
              selectSubject(subject);
              if (subject.explicitViewOnly) changeRule(subject, 'channel.view', 'allow');
            }}/>
          <ProtectedPermissionRows key={activeSubject.explicitViewOnly ? 'view' : 'full'}
            kind={kind} disabled={busy || !policy} explicitViewOnly={activeSubject.explicitViewOnly}
            ruleFor={id => ruleFor(activeSubject, id)} onChange={(id, value) => {
              setPermission(id);
              changeRule(activeSubject, id, value);
            }}/>
        </div>
        {activeSubject.explicitViewOnly && <p className="host-hint">
          {t('Администратор уже видит приватный канал. Явное разрешение добавляет его в список доступа.')}
        </p>}
      </>}
    </div>}
    {!editingSettings && <div className="modal-actions">
      <Button disabled={busy} onClick={preview ? () => setPreview(undefined) : chooseMembers ? () => setChooseMembers(false) : onClose}>
        {preview || chooseMembers ? t('Назад') : t('Отмена')}
      </Button>
      {preview ? <Button disabled={busy} variant="primary"
        onClick={() => void apply()}>{continuing ? t('Создать новый канал') : t('Применить')}</Button>
        : <Button disabled={busy || !canPreview} variant="primary" onClick={() => {
          if (choosingPrivateAccess) setChooseMembers(true);
          else void review();
        }}>{t(choosingPrivateAccess ? 'Продолжить' : creating ? 'Создать канал' : 'Предпросмотр')}</Button>}
    </div>}
  </>;
  const saveBar = editingSettings && dirty && <SettingsSaveBar busy={busy} canSave={canPreview}
    onReset={action === 'channel.acl.sync' ? () => chooseAction('channel.acl.update') : resetDraft}
    onSave={() => void review()}/>;
  return <><Modal title={title} error={error} fullPage={settingsPage}
    className={settingsPage ? 'settings-modal protected-channel-settings-dialog' : undefined}
    navigation={settingsPage ? navigation : undefined} sectionTitle={heading} footer={saveBar}
    onClose={() => { if (!busy) onClose(); }}>
    {content}
  </Modal>
    {deleteOpen && channel && <ProtectedChannelDeleteDialog serverId={serverId} channel={channel}
      onClose={() => setDeleteOpen(false)} onDeleted={() => onApplied(channel.id, 'channel.delete')}/>}
  </>;
}
