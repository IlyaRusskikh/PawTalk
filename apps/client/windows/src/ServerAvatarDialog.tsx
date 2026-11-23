import { useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { AvatarEditor } from './AvatarEditor';
import { Modal } from './Modal';
import { membership, type ServerState } from './membership';
import { t } from './i18n';

export type AvatarServer = Pick<ServerState, 'serverId' | 'name' | 'avatar' | 'avatarRevision'> & {
  protectedAccess?: boolean;
  pending?: boolean;
};

export function ServerAvatarDialog({ state, onClose, onSaved }: { state: AvatarServer; onClose(): void; onSaved(): void }) {
  const initial = state.avatar || null;
  const [avatar, setAvatar] = useState<string | null>(initial);
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removed, setRemoved] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const changed = avatar !== initial || state.pending && removed;

  async function save() {
    setBusy(true);
    setError('');
    try {
      await membership(state.protectedAccess ? 'community.protected.avatar' : 'server.avatar', {
        serverId: state.serverId, avatar, expectedRevision: state.avatarRevision,
      });
      onSaved();
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <>
    <Modal title={t('Аватар сервера')} onClose={() => { if (!busy) onClose(); }}>
      <div className="form-fields">
        <div className="member-profile-preview">
          <Avatar name={state.name} image={avatar || undefined}/>
          <button type="button" disabled={busy} onClick={() => picker.current?.click()}>{t('Изменить аватар')}</button>
          {(avatar || state.pending && !removed) && <button type="button" disabled={busy} onClick={() => {
            setAvatar(null);
            setRemoved(true);
          }}>{t('Удалить аватар')}</button>}
        </div>
        <input ref={picker} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={event => {
          setFile(event.target.files?.[0]);
          event.target.value = '';
        }}/>
      </div>
      {error && <p role="alert" className="text-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" disabled={busy} onClick={onClose}>{t('Отмена')}</button>
        <button type="button" className="primary" disabled={busy || !changed} onClick={() => void save()}>{t('Сохранить')}</button>
      </div>
    </Modal>
    {file && <AvatarEditor file={file} onClose={() => setFile(undefined)} onSave={value => {
      setAvatar(value);
      setRemoved(false);
      return true;
    }}/>}
  </>;
}
