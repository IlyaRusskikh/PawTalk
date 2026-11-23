import { useEffect, useState, type ReactNode } from 'react';
import { Toggle } from './Controls';
import { ProtectedPermissionRows } from './ProtectedPermissionRows';
import { PermissionSubjectLabel } from './ProtectedPermissionSubjects';
import { t } from './i18n';
import { membership } from './membership';
import { Modal } from './Modal';
import { SettingsSaveBar } from './SettingsSaveBar';
import { Button } from './ui/Button';

type RoleRules = Record<string, { Allow: string[] | null; Deny: string[] | null }>;
type ACLProof = { channelId: string; kind: 'text' | 'voice'; synchronized: boolean; rules: RoleRules; policyHead: string; revision: number };
type Rule = 'Allow' | 'Deny' | 'inherit';
type Change = { roleId: string; permission: string; rule: Rule };

function ruleFor(rules: RoleRules, roleId: string, permission: string): Rule {
  const entry = Object.hasOwn(rules, roleId) ? rules[roleId] : undefined;
  if (entry?.Allow?.includes(permission)) return 'Allow';
  return entry?.Deny?.includes(permission) ? 'Deny' : 'inherit';
}

function applyChanges(rules: RoleRules, changes: Change[]) {
  const result = new Map(Object.entries(rules));
  for (const { roleId, permission, rule } of changes) {
    const prior = result.get(roleId);
    const Allow = (prior?.Allow ?? []).filter(id => id !== permission);
    const Deny = (prior?.Deny ?? []).filter(id => id !== permission);
    if (rule === 'Allow') Allow.push(permission);
    if (rule === 'Deny') Deny.push(permission);
    if (Allow.length || Deny.length) result.set(roleId, { Allow: Allow.length ? Allow : null, Deny: Deny.length ? Deny : null });
    else result.delete(roleId);
  }
  return Object.fromEntries(result);
}

export function ProtectedChannelACLDialog({ serverId, channelId, navigation, onClose }: {
  serverId: string; channelId: string; navigation: ReactNode; onClose(): void;
}) {
  const [proof, setProof] = useState<ACLProof>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [roleId, setRoleId] = useState('@everyone');
  const [addingRole, setAddingRole] = useState(false);
  const [newRoleId, setNewRoleId] = useState('');
  const [addedRoles, setAddedRoles] = useState<string[]>([]);
  const [draft, setDraft] = useState<Change[]>([]);
  const [saving, setSaving] = useState(false);
  const [accepted, setAccepted] = useState(false);
  useEffect(() => {
    let current = true;
    void membership<ACLProof>('channel.acl.protected.read', { serverId, channelId }).then(result => {
      if (result?.channelId !== channelId) throw Error('INVALID_CHANNEL_POLICY_PROOF');
      if (current) setProof(result);
    }).catch(() => { if (current) setError(t('Не удалось проверить правила доступа к каналу.')); });
    return () => { current = false; };
  }, [serverId, channelId, attempt]);

  const rules = Object.entries(proof?.rules ?? {});
  const changes = proof ? draft.filter(change => ruleFor(proof.rules, change.roleId, change.permission) !== change.rule) : [];
  const role = roleId.trim();
  const effectiveRule = (id: string, permission: string) => draft.find(change => change.roleId === id &&
    change.permission === permission)?.rule ?? (proof ? ruleFor(proof.rules, id, permission) : 'inherit');
  function changeRule(roleId: string, permission: string, rule: Rule) {
    setDraft(previous => [...previous.filter(change => change.roleId !== roleId || change.permission !== permission),
      { roleId, permission, rule }]);
  }
  function reload() {
    setError('');
    setProof(undefined);
    setAttempt(value => value + 1);
  }
  async function save() {
    if (!proof || saving || accepted || !changes.length) return;
    setSaving(true);
    setError('');
    try {
      const receipt = await membership<{ channelId: string; revision: number }>('channel.acl.protected.commit', {
        serverId, channelId, kind: proof.kind, policyHead: proof.policyHead, rules: applyChanges(proof.rules, changes),
      });
      if (receipt?.channelId !== channelId || receipt.revision !== proof.revision + 1) throw Error('INVALID_API_RESPONSE');
      setAccepted(true);
    } catch (failure) {
      const code = (failure as { code?: string })?.code;
      if (code === 'PROTECTED_POLICY_CHANGED') {
        reload();
        return;
      }
      setError(code === 'PROTECTED_ACCESS_DENIED' ? t('Недостаточно прав для этого изменения.') : t('Не удалось сохранить правила доступа.'));
    } finally { setSaving(false); }
  }

  return <Modal title={t('Права доступа')} navigation={navigation} className={navigation ? 'settings-modal' : undefined} error={error}
    onClose={() => { if (!saving) onClose(); }}
    footer={!accepted && changes.length > 0 && <SettingsSaveBar busy={saving}
      onReset={() => { setDraft([]); setError(''); }} onSave={() => void save()}/>}>
    {accepted ? <p role="status">{t('Изменение принято сервером. Новая политика проверяется.')}</p>
      : !proof ? error ? <Button onClick={reload}>{t('Обновить подтверждение')}</Button> : <p role="status">{t('Проверяем правила доступа…')}</p>
      : <>
        <p>{proof.synchronized ? t('Ролевые правила наследуются от категории.') : t('Канал использует собственные ролевые правила.')}</p>
        <Toggle label={t('Приватный канал')} checked={effectiveRule('@everyone', 'channel.view') === 'Deny'} disabled={saving}
          onChange={checked => {
            setRoleId('@everyone');
            changeRule('@everyone', 'channel.view', checked ? 'Deny' : 'inherit');
          }}/>
        <div className="protected-permission-layout">
          <div className="protected-permission-subjects">
            <strong>{t('Роли')}</strong>
            {[...new Set([...rules.map(([id]) => id), ...addedRoles])].filter(id => id !== '@everyone').concat('@everyone').map(id =>
              <Button variant="quiet" key={id} className="permission-subject-button" aria-pressed={role === id}
                onClick={() => setRoleId(id)}><PermissionSubjectLabel subject={{ id, name: id }}/></Button>)}
            <Button variant="quiet" aria-expanded={addingRole} onClick={() => setAddingRole(value => !value)}>{t('Добавить роль')}</Button>
            {addingRole && <div className="protected-permission-picker">
              <label>{t('Идентификатор роли')}<input value={newRoleId} onChange={event => setNewRoleId(event.target.value)}/></label>
              <Button disabled={!newRoleId.trim() || /[\p{Cc}\p{Cs}]/u.test(newRoleId)} onClick={() => {
                const id = newRoleId.trim();
                setAddedRoles(previous => [...previous, id]);
                setRoleId(id);
                setNewRoleId('');
                setAddingRole(false);
              }}>{t('Добавить роль')}</Button>
            </div>}
          </div>
          <ProtectedPermissionRows kind={proof.kind} disabled={saving || !role || /[\p{Cc}\p{Cs}]/u.test(role)}
            ruleFor={permission => {
              const value = effectiveRule(role, permission);
              return value === 'Allow' ? 'allow' : value === 'Deny' ? 'deny' : 'inherit';
            }}
            onChange={(permission, value) => {
              const rule = value === 'allow' ? 'Allow' : value === 'deny' ? 'Deny' : 'inherit';
              changeRule(role, permission, rule);
            }}/>
        </div>
      </>}
  </Modal>;
}
