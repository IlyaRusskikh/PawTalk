import { useCallback, useEffect, useState } from 'react';
import { t } from './i18n';
import { membership } from './membership';
import { Icon } from './Controls';

export type VoiceRestrictionChoice = { action: 'voice.mute' | 'voice.deafen' | 'voice.disconnect'; lift: boolean; serverWide?: boolean };
export function voiceRestrictionLabel(choice: VoiceRestrictionChoice) {
  if (choice.action === 'voice.mute') return choice.serverWide
    ? t(choice.lift ? 'Вкл. микрофон на сервере' : 'Откл. микрофон на сервере')
    : t(choice.lift ? 'Снять заглушение' : 'Заглушить');
  if (choice.action === 'voice.deafen') return choice.serverWide
    ? t(choice.lift ? 'Сервер: вкл. звук' : 'Сервер: откл. звук')
    : t(choice.lift ? 'Вкл. звук' : 'Откл. звук');
  return t('Отключить от звонка');
}

export function ProtectedVoiceRestrictionControls({ serverId, sourceChannelId, targetSessionId }:
  { serverId: string; sourceChannelId: string; targetSessionId: string }) {
  const [choices, setChoices] = useState<VoiceRestrictionChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => membership<VoiceRestrictionChoice[]>('voice.protected.restriction-choices', { serverId, sourceChannelId, targetSessionId }),
    [serverId, sourceChannelId, targetSessionId]);
  useEffect(() => {
    let current = true;
    void load().then(result => { if (current) setChoices(result); }).catch(() => {});
    return () => { current = false; };
  }, [load]);

  async function apply(choice: VoiceRestrictionChoice) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await membership(choice.action === 'voice.disconnect' ? 'voice.protected.disconnect' : 'voice.protected.restriction',
        { serverId, sourceChannelId, targetSessionId, ...choice });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      await load().then(setChoices, () => setChoices([]));
      setBusy(false);
    }
  }

  if (!choices.length && !error) return null;
  return <div className="person-voice-restrictions">
    {choices.map((choice, index) => {
      const disconnect = choice.action === 'voice.disconnect';
      const icon = disconnect ? 'exit' : choice.action === 'voice.mute' ? (choice.lift ? 'mic' : 'mic-off') :
        choice.lift ? 'headphones' : 'headphones-off';
      const separator = index > 0 && (disconnect || !!choice.serverWide && !choices[index - 1].serverWide);
      return <button type="button" key={`${choice.action}:${!!choice.serverWide}`} className="person-menu-action"
        data-danger={disconnect || !!choice.serverWide || undefined} data-separator={separator || undefined}
        disabled={busy} onClick={() => void apply(choice)}>
        <Icon name={icon} size={17}/><span>{voiceRestrictionLabel(choice)}</span>
      </button>;
    })}
    {error && <p role="alert" className="text-error">{error}</p>}
  </div>;
}
