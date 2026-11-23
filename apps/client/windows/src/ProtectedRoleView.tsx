import { useEffect, useRef, useState } from 'react';
import { Icon } from './Controls';
import { t } from './i18n';
import { Button } from './ui/Button';

export type RoleView = {
  canManageChannels?: boolean;
  canListInvites?: boolean;
  categories: { id: string; name?: string }[];
  channels: { id: string; kind: 'text' | 'voice'; name?: string; categoryId?: string; canSend: boolean;
    canAttach: boolean; canConnect: boolean; canEditSettings?: boolean; canInspectACL?: boolean;
    members: { id: string; name?: string }[] }[];
};

export type RoleViewRequest = {
  serverId: string;
  initial: string[];
  roles: { id: string; name: string; color: string }[];
  load(roles: string[]): Promise<RoleView>;
};

export type RoleViewSession = { request: RoleViewRequest; selected: string[] };

export function useRoleView(session?: RoleViewSession) {
  const [result, setResult] = useState<{ session: RoleViewSession; view?: RoleView; error?: string }>();
  useEffect(() => {
    if (!session) return;
    let active = true;
    const timer = setTimeout(() => {
      void session.request.load(session.selected).then(view => {
        if (active) setResult({ session, view });
      }, failure => {
        if (active) setResult({ session, error: (failure as Error).message });
      });
    }, 120);
    return () => { active = false; clearTimeout(timer); };
  }, [session]);
  return result?.session === session ? result : undefined;
}

export function ProtectedRoleViewToolbar({ session, onChange, onClose }: {
  session: RoleViewSession;
  onChange(roles: string[]): void;
  onClose(): void;
}) {
  const [picker, setPicker] = useState(false);
  const [search, setSearch] = useState('');
  const controls = useRef<HTMLDivElement>(null);
  const { selected, request } = session;
  useEffect(() => {
    if (!picker) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !controls.current?.contains(event.target)) setPicker(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [picker]);
  return <div className="protected-role-view-bar" onKeyDown={event => {
    if (event.key !== 'Escape' || !picker) return;
    event.preventDefault();
    event.stopPropagation();
    setPicker(false);
    event.currentTarget.querySelector<HTMLButtonElement>('.protected-role-view-controls > button')?.focus();
  }}>
    <Button onClick={onClose}><Icon name="arrow-left" size={14}/>{t('Вернуться к настройкам ролей')}</Button>
    <div className="protected-role-view-controls" ref={controls}>
      <span>{t('Выбрано ролей: {0}', selected.length)}</span>
      <Button aria-expanded={picker} onClick={() => setPicker(value => !value)}>{t('Выберите роли')}</Button>
      {picker && <div className="protected-role-view-picker">
        <input autoFocus type="search" placeholder={t('Поиск роли')} aria-label={t('Поиск роли')}
          value={search} onChange={event => setSearch(event.target.value)}/>
        <div className="protected-role-view-options">
          <label><input type="checkbox" checked disabled/><span>@everyone</span></label>
          {request.roles.filter(role => role.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(role =>
            <label key={role.id}>
              <input type="checkbox" checked={selected.includes(role.id)} onChange={event => onChange(event.target.checked
                ? [...selected, role.id] : selected.filter(id => id !== role.id))}/>
              <span><i style={{ backgroundColor: role.color || undefined }}/>{role.name}</span>
            </label>)}
        </div>
      </div>}
    </div>
    <Button aria-label={t('Закрыть предпросмотр')} title={t('Закрыть предпросмотр')} onClick={onClose}>×</Button>
  </div>;
}
