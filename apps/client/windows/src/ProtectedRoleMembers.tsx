import { useEffect, useState } from 'react';
import { Avatar } from './Avatar';
import { Icon } from './Controls';
import { t } from './i18n';
import { membership, roleChangeMessage } from './membership';
import { Modal } from './Modal';
import { ProtectedRoleAccessImpact, type RoleAccessImpact } from './ProtectedAccessImpact';
import { Button } from './ui/Button';

type Profile = { id: string; name?: string; roles: string[] };
type Policy = { revision: number; profiles: Profile[] };
const nameOf = (profile: Profile) => profile.name ?? t('Участник · {0}', profile.id.slice(0, 8));

export function ProtectedRoleMembers({ serverId, roleId, changed }: {
  serverId: string; roleId: string; changed(): void;
}) {
  const [policy, setPolicy] = useState<Policy>();
  const [search, setSearch] = useState('');
  const [candidateSearch, setCandidateSearch] = useState('');
  const [selection, setSelection] = useState<string[]>();
  const [removal, setRemoval] = useState<Profile>();
  const [preview, setPreview] = useState<{ previewId: string; impact?: RoleAccessImpact }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, reload] = useState(0);
  useEffect(() => {
    let active = true;
    void membership<Policy>('member.protected.roles', { serverId }).then(result => {
      if (active) setPolicy(result);
    }, failure => { if (active) setError((failure as Error).message); });
    return () => { active = false; };
  }, [serverId, revision]);

  const matches = (profile: Profile, query: string) => nameOf(profile).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const members = policy?.profiles.filter(profile => profile.roles.includes(roleId)) ?? [];
  const candidates = policy?.profiles.filter(profile => !profile.roles.includes(roleId) && matches(profile, candidateSearch)) ?? [];
  const close = () => {
    if (busy) return;
    setSelection(undefined); setRemoval(undefined); setPreview(undefined); setCandidateSearch(''); setError('');
  };
  async function save() {
    const profiles = removal ? [removal.id] : selection;
    if (!policy || !profiles?.length || busy) return;
    setBusy(true);
    setError('');
    try {
      if (!preview) {
        setPreview(await membership('role.protected.members-preview', {
          serverId, roleId, revision: policy.revision, profiles, add: !removal,
        }));
      } else {
        await membership('role.protected.commit', { serverId, previewId: preview.previewId });
        setSelection(undefined); setRemoval(undefined); setPreview(undefined); setCandidateSearch('');
        reload(value => value + 1);
        changed();
      }
    } catch (failure) {
      setError(roleChangeMessage(failure, policy.profiles));
      setPreview(undefined);
      reload(value => value + 1);
    } finally { setBusy(false); }
  }

  return <div className="form-fields protected-role-members">
    <div className="protected-role-member-search">
      <input type="search" aria-label={t('Поиск участников')} placeholder={t('Поиск участников')}
        value={search} onChange={event => setSearch(event.target.value)}/>
      <Button variant="primary" disabled={!policy} onClick={() => setSelection([])}>{t('Добавить участников')}</Button>
    </div>
    {!selection && !removal && error && <p role="alert">{error}</p>}
    {policy && !members.length && <p>{t('У роли пока нет участников.')}</p>}
    <ul className="protected-role-member-list">{members.filter(profile => matches(profile, search)).map(profile =>
      <li key={profile.id}><Avatar name={nameOf(profile)}/><span>{nameOf(profile)}</span>
        <button type="button" className="icon-button" aria-label={t('Снять роль')} title={t('Снять роль')}
          onClick={() => setRemoval(profile)}><Icon name="close" size={16}/></button></li>)}</ul>
    {(selection || removal) && <Modal title={t(removal ? 'Снять роль' : 'Добавить участников')} onClose={close} error={error}>
      {removal && <p>{nameOf(removal)}</p>}
      {preview?.impact && <ProtectedRoleAccessImpact impact={preview.impact}/>}
      {!preview && !removal && selection && <div className="form-fields">
        <input autoFocus type="search" aria-label={t('Поиск участников')} placeholder={t('Поиск участников')}
          value={candidateSearch} onChange={event => setCandidateSearch(event.target.value)}/>
        <div className="protected-channel-recipients">{candidates.map(profile => <label key={profile.id}>
          <input type="checkbox" checked={selection.includes(profile.id)}
            disabled={selection.length >= 30 && !selection.includes(profile.id)}
            onChange={event => setSelection(event.target.checked ? [...selection, profile.id] : selection.filter(id => id !== profile.id))}/>
          {nameOf(profile)}
        </label>)}</div>
      </div>}
      <div className="modal-actions">
        <Button disabled={busy} onClick={close}>{t('Отмена')}</Button>
        <Button variant={removal ? 'danger' : 'primary'} disabled={busy || (!removal && !selection?.length)}
          onClick={() => void save()}>{t(preview ? 'Применить' : 'Предпросмотр')}</Button>
      </div>
    </Modal>}
  </div>;
}
