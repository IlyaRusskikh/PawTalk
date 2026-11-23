import { useEffect, useState } from 'react';
import { t } from './i18n';
import { membership, type ProtectedServerState } from './membership';
import { Modal } from './Modal';
import { Button } from './ui/Button';

type DeleteBasis = { revision: number; totalChannels?: number; settings?: { Name: string } };

export function ProtectedChannelDeleteDialog({ serverId, channel, onClose, onDeleted }: {
  serverId: string;
  channel: ProtectedServerState['channels'][number];
  onClose(): void;
  onDeleted(): void;
}) {
  const [basis, setBasis] = useState<DeleteBasis>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const channelId = channel.id;
  useEffect(() => {
    let active = true;
    void membership<DeleteBasis>('channel.protected.manage', { serverId, channelId }).then(
      value => { if (active) setBasis(value); },
      failure => { if (active) setError((failure as Error).message); },
    );
    return () => { active = false; };
  }, [serverId, channelId, reload]);

  async function confirm() {
    if (!basis || busy) return;
    setBusy(true);
    setError('');
    try {
      const { previewId } = await membership<{ previewId: string }>('channel.protected.preview', {
        serverId, channelId, revision: basis.revision, action: 'channel.delete',
      });
      await membership('channel.protected.commit', { serverId, previewId });
      onDeleted();
    } catch (failure) {
      setError((failure as Error).message);
      if ((failure as { code?: string }).code === 'PROTECTED_POLICY_CHANGED') {
        setBasis(undefined);
        setReload(value => value + 1);
      }
    } finally { setBusy(false); }
  }

  const name = basis?.settings?.Name ?? channel.name ?? t('Канал · {0}', channelId.slice(0, 8));
  return <Modal title={t('Удалить канал')} className="chat-delete-modal protected-resource-delete-modal protected-channel-delete-modal"
    error={error} onClose={() => { if (!busy) onClose(); }}>
    <p className="chat-delete-question">{t('Удалить канал «{0}»? Это действие нельзя отменить.', name)}</p>
    {basis?.totalChannels === 1 && <p className="protected-resource-delete-warning">{t('Это последний канал на сервере.')}</p>}
    <div className="modal-actions">
      <Button autoFocus type="button" disabled={busy} onClick={onClose}>{t('Отмена')}</Button>
      <Button type="button" className="chat-delete-confirm" disabled={busy || !basis} onClick={() => void confirm()}>
        {t('Удалить канал')}
      </Button>
    </div>
  </Modal>;
}
