import { useEffect, useState } from 'react';
import { t } from './i18n';
import { membership } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';

type Nickname = { name: string; revision: number };

export function ProtectedNicknameDialog({ serverId, profileId, channelId, onClose, onSaved }: {
  serverId: string; profileId: string; channelId?: string; onClose(): void; onSaved(name: string): void;
}) {
  const [current, setCurrent] = useState<Nickname>();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState('');
  const scope = { serverId, profileId, channelId };
  useEffect(() => {
    let active = true;
    void membership<Nickname>('profile.protected.nickname.read', { serverId, profileId, channelId })
      .then(value => {
        if (!active) return;
        setCurrent(value);
        setDraft(value.name);
      }, failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [serverId, profileId, channelId]);

  const name = draft.trim();
  const valid = name.length > 0 && [...name].length <= 32 && !/[\p{Cc}\p{Cs}]/u.test(name);
  async function save() {
    if (!current || conflict || saving || !valid || name === current.name) return;
    setSaving(true);
    setError('');
    try {
      const result = await membership<Nickname>('profile.protected.nickname.change', { ...scope, name, revision: current.revision });
      onSaved(result.name);
    } catch (failure) {
      setConflict((failure as { code?: string }).code === 'REVISION_CONFLICT');
      setError((failure as Error).message);
    } finally { setSaving(false); }
  }
  async function reload() {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      setCurrent(await membership<Nickname>('profile.protected.nickname.read', scope));
      setConflict(false);
    } catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  }
  return <Modal title={t('Изменить ник')} error={error} onClose={() => { if (!saving) onClose(); }}>
    <form className="form-fields" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>{t('Ник на сервере')}<input value={draft} disabled={saving || !current}
        autoFocus maxLength={64} onChange={event => setDraft(event.target.value)}/></label>
      {current && draft !== current.name && <p>{t('Текущий ник — {0}', current.name || t('Не задан'))}</p>}
      <div className="modal-actions">
        <Button type="button" disabled={saving} onClick={onClose}>{t('Отмена')}</Button>
        {conflict ? <Button type="button" disabled={saving} onClick={() => void reload()}>{t('Обновить')}</Button>
          : <Button type="submit" disabled={saving || !valid || !current || name === current.name}>{t('Сохранить')}</Button>}
      </div>
    </form>
  </Modal>;
}
