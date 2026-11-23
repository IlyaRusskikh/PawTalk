import { useEffect, useState } from 'react';
import catalog from '../../../server/internal/access/catalog.json';
import { Icon, Toggle } from './Controls';
import { ProtectedPermissionRows } from './ProtectedPermissionRows';
import { everyoneSubject, permissionRule, ProtectedPermissionSubjects, subjectKey,
  type PermissionAppearanceScope, type PermissionChange, type PermissionSubject } from './ProtectedPermissionSubjects';
import { Modal } from './Modal';
import { SettingsSaveBar } from './SettingsSaveBar';
import { ProtectedChannelAccessDelta, type ChannelAccessDelta } from './ProtectedAccessImpact';
import { t, useLanguage } from './i18n';
import { membership } from './membership';
import { Button } from './ui/Button';
import { ProtectedOrderFields } from './ProtectedOrderFields';

type Named = { id: string; name?: string };
type Rule = 'inherit' | 'allow' | 'deny';
type Action = 'category.create' | 'category.settings.update' | 'category.acl.update' | 'category.delete' | 'category.order' | 'category.copy';
type Category = Named & { children: number; rules: { Roles: RuleMap; Profiles: RuleMap } };
type RuleMap = Record<string, { Allow?: string[]; Deny?: string[] }> | null;
type CategoryPolicy = { revision: number; categories: Category[]; totalChannels: number; profiles: Named[]; roles: (Named & { color?: string })[] };
const categoryName = (category: Named) => category.name ?? t('Категория · {0}', category.id.slice(0, 8));
const actionLabels = {
  'category.create': 'Создать категорию', 'category.settings.update': 'Переименовать категорию',
  'category.acl.update': 'Права категории', 'category.delete': 'Удалить категорию',
  'category.order': 'Изменить порядок категорий', 'category.copy': 'Копировать настройки категории',
} satisfies Record<Action, string>;
const ruleLabels = { inherit: 'Наследовать', allow: 'Разрешить', deny: 'Запретить' } satisfies Record<Rule, string>;

export function ProtectedCategoriesDialog({ serverId, target, appearanceScope, onClose, onApplied }: {
  serverId: string; target?: Named & { mode: 'edit' | 'delete' }; onClose(): void; onApplied(): void;
  appearanceScope?: PermissionAppearanceScope;
}) {
  const language = useLanguage();
  const initialCategoryId = target?.id ?? '';
  const editing = target?.mode === 'edit';
  const [policy, setPolicy] = useState<CategoryPolicy>();
  const [categoryId, setCategoryId] = useState(initialCategoryId);
  const [action, setAction] = useState<Action>(() => target?.mode === 'edit' ? 'category.settings.update'
    : target?.mode === 'delete' ? 'category.delete' : 'category.create');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'keep_children' | 'delete_children'>('keep_children');
  const [anchorId, setAnchorId] = useState('');
  const [after, setAfter] = useState(false);
  const [subject, setSubject] = useState<PermissionSubject>(everyoneSubject);
  const [addedSubjects, setAddedSubjects] = useState<string[]>([]);
  const [changes, setChanges] = useState<PermissionChange[]>([]);
  const [preview, setPreview] = useState<{ previewId: string; impact?: ChannelAccessDelta }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void membership<CategoryPolicy>('category.protected.manage', { serverId }).then(value => {
      if (active) {
        setPolicy(value);
        const initial = value.categories.find(category => category.id === initialCategoryId);
        if (initial && reload === 0) setName(categoryName(initial));
      }
    }, failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [serverId, initialCategoryId, reload]);

  const category = policy?.categories.find(entry => entry.id === categoryId);
  const configuredSubjects = [
    ...(policy?.roles ?? []).filter(role => role.id !== '@everyone').map(role => ({ id: role.id, name: role.name ?? role.id, color: role.color })),
    ...(policy?.profiles ?? []).map(profile => ({ id: profile.id, name: profile.name ?? t('Участник · {0}', profile.id.slice(0, 8)), profile: true })),
  ] satisfies PermissionSubject[];
  const subjects: PermissionSubject[] = [everyoneSubject, ...configuredSubjects.filter(item =>
    addedSubjects.includes(subjectKey(item)) || Object.hasOwn(('profile' in item ? category?.rules.Profiles : category?.rules.Roles) ?? {}, item.id))];
  const ruleFromCategory = (item: PermissionSubject, permission: string) =>
    permissionRule(item.profile ? category?.rules.Profiles : category?.rules.Roles, item.id, permission);
  function ruleFor(item: PermissionSubject, permission: string): Rule {
    return changes.find(change => (item.profile ? change.profileId : change.role) === item.id && change.permission === permission)?.rule ??
      ruleFromCategory(item, permission);
  }
  function changeRule(item: PermissionSubject, permission: string, rule: Rule) {
    setChanges(previous => {
      const next = previous.filter(change => (item.profile ? change.profileId : change.role) !== item.id || change.permission !== permission);
      if (rule !== ruleFromCategory(item, permission)) next.push({ ...(item.profile ? { profileId: item.id } : { role: item.id }), permission, rule });
      return next;
    });
  }
  const creating = action === 'category.create';
  const naming = creating || action === 'category.settings.update' || action === 'category.copy';
  const deleting = action === 'category.delete';
  const changingSettings = action === 'category.settings.update' || action === 'category.acl.update';
  const applyDirectly = creating || deleting || changingSettings;
  const originalName = category ? categoryName(category) : '';
  const dirty = action === 'category.settings.update' ? name !== originalName : changes.length > 0;
  function reset() {
    setName(originalName);
    setChanges([]);
    setAddedSubjects([]);
    setSubject(everyoneSubject);
    setError('');
  }
  const deleteMode = category?.children ? mode : 'keep_children';
  const neighbors = (policy?.categories ?? []).filter(item => item.id !== categoryId)
    .map(item => ({ id: item.id, name: categoryName(item) }));
  const canPreview = !!policy && (!naming || !!name.trim() && [...name.trim()].length <= 64) &&
    (!(target || deleting) || !!category) && (action !== 'category.settings.update' || !!category && name.trim() !== originalName) &&
    (action !== 'category.acl.update' || changes.length > 0 && changes.length <= 128) &&
    (action !== 'category.order' || !!anchorId);

  async function submit() {
    if (!policy || !canPreview || busy) return;
    setBusy(true);
    setError('');
    try {
      const prepared = preview ?? await membership<{ previewId: string; impact?: ChannelAccessDelta }>('category.protected.preview', {
        serverId, revision: policy.revision, categoryId, action, name, anchorId, after,
        ...(deleting && { mode: deleteMode }),
        ...(action === 'category.acl.update' && { changes }),
      });
      if (!preview && !applyDirectly) {
        setPreview(prepared);
      } else {
        await membership('category.protected.commit', { serverId, previewId: prepared.previewId });
        onApplied();
      }
    } catch (failure) {
      setPreview(undefined);
      setError((failure as Error).message);
      if (applyDirectly && (failure as { code?: string }).code === 'PROTECTED_POLICY_CHANGED') {
        setPolicy(undefined);
        setReload(value => value + 1);
      }
    } finally { setBusy(false); }
  }

  const close = () => { if (!busy) onClose(); };
  if (deleting) return <Modal title={t('Удалить категорию')}
    className="chat-delete-modal protected-resource-delete-modal protected-category-delete-modal"
    error={error} onClose={close}>
    <p className="chat-delete-question">{t('Удалить категорию «{0}»? Это действие нельзя отменить.',
      categoryName(category ?? target ?? { id: categoryId }))}</p>
    {category && category.children > 0 && <div className="form-fields">
      <label>{t('Каналы в категории')}
        <select value={deleteMode} disabled={busy}
          onChange={event => setMode(event.target.value === 'delete_children' ? 'delete_children' : 'keep_children')}>
          <option value="keep_children">{t('Оставить каналы и сохранить права')}</option>
          <option value="delete_children">{t('Удалить категорию вместе с каналами')}</option>
        </select>
      </label>
    </div>}
    {category && category.children > 0 && <p className={deleteMode === 'delete_children'
      ? 'protected-resource-delete-warning' : 'chat-delete-question protected-category-delete-hint'}>
      {t(deleteMode === 'keep_children'
        ? 'Каналы выйдут из категории и сохранят свои права — {0}'
        : 'Каналы и их содержимое станут недоступны участникам — {0}', category.children)}
      {deleteMode === 'delete_children' && category.children === policy?.totalChannels &&
        <> {t('На сервере не останется каналов.')}</>}
    </p>}
    <div className="modal-actions">
      <Button autoFocus type="button" disabled={busy} onClick={close}>{t('Отмена')}</Button>
      <Button type="button" className="chat-delete-confirm" disabled={busy || !canPreview} onClick={() => void submit()}>
        {t('Удалить категорию')}
      </Button>
    </div>
  </Modal>;

  const content = <>
    {preview ? <div className="form-fields">
      <p>{t(actionLabels[action])} · {naming ? name.trim() : category && categoryName(category)}</p>
      {action === 'category.acl.update' && <ul>{changes.map(change => <li key={JSON.stringify([change.role, change.profileId, change.permission])}>
        {subjects.find(item => item.profile ? item.id === change.profileId : item.id === change.role)?.name}
        {' · '}{catalog.permissions.find(item => item.id === change.permission)?.[language] ?? change.permission} · {t(ruleLabels[change.rule])}
      </li>)}</ul>}
      {action === 'category.copy' && <p>{t('Правила доступа будут скопированы. Каналы останутся в исходной категории.')}</p>}
      {action === 'category.order' && <p>{after ? t('После выбранного') : t('Перед выбранным')} · {neighbors.find(item => item.id === anchorId)?.name}</p>}
      {preview.impact && <ProtectedChannelAccessDelta impact={preview.impact}/>}
    </div> : <div className="form-fields">
      {!target && <label>{t('Категория')}<select disabled={busy || !policy} value={categoryId} onChange={event => {
        const id = event.target.value;
        setCategoryId(id);
        const item = policy?.categories.find(entry => entry.id === id);
        setAction(item ? 'category.settings.update' : 'category.create');
        setName(item ? categoryName(item) : '');
        setSubject(everyoneSubject);
        setAddedSubjects([]);
        setChanges([]);
        setMode('keep_children');
        setAnchorId('');
        setAfter(false);
      }}>
        <option value="">{t('Создать категорию')}</option>
        {policy?.categories.map(item => <option key={item.id} value={item.id}>{categoryName(item)}</option>)}
      </select></label>}
      {!target && category && <label>{t('Действие')}<select value={action} disabled={busy} onChange={event => {
        setAction(event.target.value as Action);
        setAnchorId('');
        setAfter(false);
      }}>
        {Object.entries(actionLabels).filter(([id]) => id !== 'category.create' && (id !== 'category.order' || neighbors.length > 0))
          .map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}
      </select></label>}
      {naming && <label>{t('Название категории')}<input value={name} disabled={busy || !policy}
        onChange={event => setName(event.target.value)}/></label>}
      {action === 'category.acl.update' && <>
        <Toggle label={t('Приватная категория')} checked={ruleFor(everyoneSubject, 'channel.view') === 'deny'}
          disabled={busy || !category} onChange={checked => {
            setSubject(everyoneSubject);
            changeRule(everyoneSubject, 'channel.view', checked ? 'deny' : 'inherit');
          }}/>
        <div className="protected-permission-layout">
          <ProtectedPermissionSubjects subjects={subjects} available={configuredSubjects} active={subject}
            appearanceScope={appearanceScope}
            disabled={busy || !category} onSelect={setSubject} onAdd={item => {
              setAddedSubjects(previous => [...previous, subjectKey(item)]);
              setSubject(item);
            }}/>
          <ProtectedPermissionRows kind="category" disabled={busy || !category}
            ruleFor={permission => ruleFor(subject, permission)} onChange={(permission, rule) => changeRule(subject, permission, rule)}/>
        </div>
      </>}
      {action === 'category.order' && <ProtectedOrderFields items={neighbors} anchorId={anchorId} after={after} disabled={busy}
        onAnchor={setAnchorId} onAfter={setAfter}/>}
    </div>}
    {!changingSettings && <div className="modal-actions">
      <Button disabled={busy} onClick={preview ? () => setPreview(undefined) : onClose}>{preview ? t('Назад') : t('Отмена')}</Button>
      <Button disabled={busy || !canPreview} variant="primary"
        onClick={() => void submit()}>{t(creating ? 'Создать категорию' : preview ? 'Применить' : 'Предпросмотр')}</Button>
    </div>}
  </>;
  const saveBar = changingSettings && dirty && <SettingsSaveBar busy={busy} canSave={canPreview}
    onReset={reset} onSave={() => void submit()}/>;
  if (!editing) return <Modal title={t('Категории')} error={error} onClose={close} footer={saveBar}>{content}</Modal>;

  const tab = (next: 'category.settings.update' | 'category.acl.update') => {
    if (next === action) return;
    reset();
    setAction(next);
  };
  const permissions = action === 'category.acl.update';
  return <Modal fullPage title={t('Настройки категории')} className="settings-modal protected-category-settings"
    error={error} onClose={close} footer={saveBar} sectionTitle={t(permissions ? 'Права доступа' : 'Обзор')} navigation={
      <nav className="settings-nav" aria-label={t('Настройки категории')}>
        {category && <div className="settings-nav-caption">{categoryName(category)}</div>}
        <button type="button" aria-current={!permissions ? 'page' : undefined} disabled={busy}
          onClick={() => tab('category.settings.update')}><Icon name="settings" size={16}/>{t('Обзор')}</button>
        <button type="button" aria-current={permissions ? 'page' : undefined} disabled={busy}
          onClick={() => tab('category.acl.update')}><Icon name="shield" size={16}/>{t('Права доступа')}</button>
      </nav>}>
    {content}
  </Modal>;
}
