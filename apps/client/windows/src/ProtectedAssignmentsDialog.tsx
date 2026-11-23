import { useEffect, useState } from 'react';
import { Toggle } from './Controls';
import { Modal } from './Modal';
import { t } from './i18n';
import { canRetryRoleChange, membership, roleChangeMessage } from './membership';
import { Button } from './ui/Button';

type Named = { id: string; name?: string };
type Participant = Named & { roles: string[] };
type AssignmentPolicy = { revision: number; policyHead?: string; profiles: Participant[]; roles: (Named & { canAssign?: boolean })[] };
export type ScopedAssignmentTarget = { profileId: string; profileName: string; channelId?: string };
const profileName = (profile: Participant) => profile.name ?? t('Участник · {0}', profile.id.slice(0, 8));

export function ProtectedAssignmentsDialog({ serverId, target, onClose, onApplied }: {
  serverId: string; target?: ScopedAssignmentTarget; onClose(): void; onApplied(): void;
}) {
  const [policy, setPolicy] = useState<AssignmentPolicy>();
  const [profileId, setProfileId] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [retryPreviewId, setRetryPreviewId] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = target ? membership<{ revision: number; policyHead: string; roles: (Named & { assigned: boolean; canAssign: boolean })[] }>(
      'roles.scoped.basis', { serverId, profileId: target.profileId, channelId: target.channelId }).then(value => ({ ...value,
        profiles: [{ id: target.profileId, name: target.profileName, roles: value.roles.filter(role => role.assigned).map(role => role.id) }],
      })) : membership<AssignmentPolicy>('member.protected.roles', { serverId });
    void load.then(value => {
      if (!alive) return;
      setPolicy(value);
      if (target) {
        setProfileId(target.profileId);
        setRoles(value.profiles[0].roles);
      }
    }, failure => { if (alive) setError(failure.message); });
    return () => { alive = false; };
  }, [serverId, target]);

  const selected = policy?.profiles.find(profile => profile.id === profileId);
  const customRoles = [...(policy?.roles ?? [])].reverse();
  const changed = !!selected && (selected.roles.length !== roles.length || roles.some(id => !selected.roles.includes(id)));
  async function submit() {
    if (!policy || busy || !changed) return;
    setError('');
    setBusy(true);
    let previewId = retryPreviewId;
    try {
      previewId ??= (await membership<{ previewId: string }>(target ? 'roles.scoped.preview' : 'member.protected.roles.preview', {
        serverId, profileId, roles, revision: policy.revision, policyHead: policy.policyHead, channelId: target?.channelId,
      })).previewId;
      await membership(target ? 'roles.scoped.commit' : 'member.protected.roles.commit', { serverId, previewId });
      onApplied();
    } catch (failure) {
      setError(roleChangeMessage(failure, policy.profiles));
      setRetryPreviewId(target && canRetryRoleChange(failure) ? previewId : undefined);
    } finally { setBusy(false); }
  }

  return <Modal title={t('Назначения ролей')} error={error} onClose={() => { if (!busy) onClose(); }}>
    <div className="form-fields">
      {target ? <p>{target.profileName}</p> : <label>{t('Участник')}<select value={profileId} disabled={busy || !policy} onChange={event => {
        setProfileId(event.target.value);
        setRoles(policy?.profiles.find(profile => profile.id === event.target.value)?.roles ?? []);
        setRetryPreviewId(undefined);
        setError('');
      }}>
        <option value="">{policy?.profiles.length ? t('Выберите участника') : t('Нет доступных участников')}</option>
        {policy?.profiles.map(profile => <option key={profile.id} value={profile.id}>{profileName(profile)}</option>)}
      </select></label>}
      {selected && customRoles.map(role => <Toggle key={role.id} label={role.name ?? role.id} checked={roles.includes(role.id)}
        disabled={busy || role.canAssign === false && !selected.roles.includes(role.id)}
        onChange={checked => {
          setRetryPreviewId(undefined);
          setError('');
          setRoles(previous => checked ? [...previous, role.id] : previous.filter(id => id !== role.id));
        }}/>)}
      {selected && !customRoles.length && <p>{t('Сначала создайте пользовательскую роль.')}</p>}
    </div>
    <div className="modal-actions">
      <Button disabled={busy} onClick={onClose}>{t('Отмена')}</Button>
      <Button disabled={busy || !changed} variant="primary" onClick={() => void submit()}>{t('Сохранить')}</Button>
    </div>
  </Modal>;
}
