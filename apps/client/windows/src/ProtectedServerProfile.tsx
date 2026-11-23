import { useEffect, useState } from 'react';
import { Avatar } from './Avatar';
import { Icon } from './Controls';
import { membership, type ProtectedServerState } from './membership';
import { t } from './i18n';
import { Button } from './ui/Button';

type Community = NonNullable<ProtectedServerState['community']>;

export function ProtectedServerProfile({ serverId, community, fallbackName, avatar, editable, onAvatar, onSaved, onRefresh }: {
  serverId: string;
  community?: Community;
  fallbackName: string;
  avatar?: string;
  editable: boolean;
  onAvatar?: () => void;
  onSaved: (community: Community) => void;
  onRefresh: () => void;
}) {
  const name = community?.name ?? fallbackName;
  const [draft, setDraft] = useState<{ value: string; revision: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const value = draft?.value ?? name;
  const trimmed = value.trim();
  const dirty = !!draft && trimmed !== name;
  const conflict = !!draft && !!community && draft.revision !== community.revision;
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 3500);
    return () => clearTimeout(timer);
  }, [saved]);

  async function save() {
    if (!editable || !community || !draft || !dirty || conflict || busy || !trimmed || [...trimmed].length > 64) return;
    setBusy(true);
    setError('');
    try {
      const result = await membership<Community>('community.protected.rename', {
        serverId, name: trimmed, revision: draft.revision,
      });
      onSaved(result);
      setDraft(undefined);
      setSaved(true);
    } catch (failure) {
      setError((failure as Error).message);
      if ((failure as { code?: string }).code === 'SERVER_NAME_CHANGED') onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return <form className="protected-server-profile" onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="protected-server-profile-identity">
      <Avatar name={name} image={avatar}/>
      <div className="protected-server-profile-summary">
        <strong>{name}</strong>
        {onAvatar && <Button type="button" disabled={busy} onClick={onAvatar}>{t('Аватар сервера')}</Button>}
      </div>
    </div>
    <div className="form-fields protected-server-profile-fields">
      <label>{t('Название сервера')}
        <input value={value} readOnly={!editable || busy} maxLength={128} required
          onChange={event => {
            if (!community) return;
            setSaved(false);
            setError('');
            setDraft({ value: event.target.value, revision: draft?.revision ?? community.revision });
          }}/>
      </label>
      {(error || conflict) && <p className="text-error" role="alert">
        {error || t('Название сервера уже изменилось. Обновите данные и повторите попытку.')}
      </p>}
    </div>
    {editable && (dirty || conflict) && <div className="modal-actions protected-server-profile-actions">
      <Button type="button" disabled={busy} onClick={() => {
        setDraft(undefined);
        setSaved(false);
        setError('');
      }}>{t('Сбросить')}</Button>
      <Button type="submit" variant="primary" disabled={busy || !dirty || conflict || !trimmed || [...trimmed].length > 64}>
        {t('Сохранить изменения')}
      </Button>
    </div>}
    {saved && <div className="member-error protected-server-profile-toast">
      <Icon name="shield" size={18}/>
      <span role="status">{t('Профиль сохранён')}</span>
      <button type="button" className="icon-button" aria-label={t('Закрыть')} onClick={() => setSaved(false)}>×</button>
    </div>}
  </form>;
}
