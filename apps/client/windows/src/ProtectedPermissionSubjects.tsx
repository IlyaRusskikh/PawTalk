import { useState } from 'react';
import { t } from './i18n';
import { Button } from './ui/Button';
import type { PermissionChoice } from './ProtectedPermissionRows';
import { Avatar } from './Avatar';
import { Icon } from './Controls';
import { useProtectedProfileAppearances } from './useProtectedProfileAppearances';

export type PermissionSubject = { id: string; name: string; profile?: boolean; color?: string; explicitViewOnly?: boolean };
export type PermissionAppearanceScope = { serverId: string; channelId?: string; ownProfileId?: string; ownAvatar?: string };
export type PermissionChange = { role?: string; profileId?: string; permission: string; rule: PermissionChoice };
type Rules = Record<string, { Allow?: string[]; Deny?: string[] }> | null | undefined;

export const subjectKey = ({ id, profile }: PermissionSubject) => `${profile ? 'profile' : 'role'}:${id}`;
export const everyoneSubject: PermissionSubject = { id: '@everyone', name: '@everyone' };

export function permissionRule(rules: Rules, id: string, permission: string): PermissionChoice {
  const entry = rules && Object.hasOwn(rules, id) ? rules[id] : undefined;
  return entry?.Allow?.includes(permission) ? 'allow' : entry?.Deny?.includes(permission) ? 'deny' : 'inherit';
}

function subjectGroup(subject: PermissionSubject) {
  return subject.profile ? 2 : subject.id === everyoneSubject.id ? 1 : 0;
}

export function PermissionSubjectLabel({ subject, avatar }: { subject: PermissionSubject; avatar?: string }) {
  return <>
    {subject.profile ? <Avatar className="permission-subject-avatar" name={subject.name} image={avatar}/> :
      subject.id !== everyoneSubject.id && <span className="permission-subject-dot" aria-hidden="true"
        style={{ backgroundColor: /^#[\da-f]{6}$/i.test(subject.color ?? '') ? subject.color : undefined }}/>}
    <span className="permission-subject-name" title={subject.name}>{subject.name}</span>
  </>;
}

export function ProtectedPermissionSubjects({ subjects, active, available, onSelect, onAdd, onCreateRole, disabled, appearanceScope, emptyHint }: {
  subjects: PermissionSubject[]; active: PermissionSubject; available: PermissionSubject[]; disabled: boolean;
  appearanceScope?: PermissionAppearanceScope;
  emptyHint?: string;
  onSelect(subject: PermissionSubject): void; onAdd(subject: PermissionSubject): void; onCreateRole?(): void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const profiles = useProtectedProfileAppearances(appearanceScope?.serverId, appearanceScope?.channelId,
    (open ? available : subjects).filter(subject => subject.profile).map(subject => subject.id));
  const name = (subject: PermissionSubject) => subject.profile ? profiles?.get(subject.id)?.name ?? subject.name : subject.name;
  const avatar = (subject: PermissionSubject) => (subject.id === appearanceScope?.ownProfileId
    ? appearanceScope?.ownAvatar : undefined) ?? profiles?.get(subject.id)?.avatar;
  const assigned = new Set(subjects.map(subjectKey));
  const byGroup = (a: PermissionSubject, b: PermissionSubject) => subjectGroup(a) - subjectGroup(b);
  const options = available.filter(subject => !assigned.has(subjectKey(subject)) &&
    name(subject).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort(byGroup);
  return <div className="protected-permission-subjects" aria-label={t('Роли и участники')}>
    <strong>{t('Роли и участники')}</strong>
    {[...subjects].sort(byGroup).map(subject => <Button key={subjectKey(subject)} variant="quiet" type="button"
      className="permission-subject-button"
      disabled={disabled} aria-pressed={subjectKey(active) === subjectKey(subject)}
      onClick={() => onSelect(subject)}><PermissionSubjectLabel subject={{ ...subject, name: name(subject) }} avatar={avatar(subject)}/>
      {subject.profile && subjectKey(active) === subjectKey(subject) && <span className="permission-subject-selected" aria-hidden="true"/>}
    </Button>)}
    <Button variant="quiet" type="button" disabled={disabled} aria-expanded={open}
      className="permission-subject-button" onClick={() => { setOpen(value => !value); setSearch(''); }}>
      <Icon name="invite" size={16}/>{t('Добавить роль или участника')}
    </Button>
    {open && <div className="protected-permission-picker">
      <input type="search" autoFocus aria-label={t('Поиск роли или участника')} placeholder={t('Поиск роли или участника')}
        value={search} onChange={event => setSearch(event.target.value)}/>
      {options.map(subject => <Button key={subjectKey(subject)} type="button" variant="quiet" className="permission-subject-button" disabled={disabled}
        onClick={() => { onAdd(subject); setOpen(false); }}><PermissionSubjectLabel subject={{ ...subject, name: name(subject) }} avatar={avatar(subject)}/></Button>)}
      {!options.length && <small>{(!search.trim() && emptyHint) || t('Нет доступных ролей или участников.')}</small>}
    </div>}
    {onCreateRole && <Button variant="quiet" type="button" className="permission-subject-button"
      disabled={disabled} onClick={onCreateRole}>
      <Icon name="plus" size={16}/>{t('Создать роль')}
    </Button>}
  </div>;
}
