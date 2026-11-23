import { Icon } from '../Controls';
import { t } from '../i18n';

export function AudioStatusIcons({ muted, deafened, serverMuted, serverDeafened, size = 15, className = '' }: {
  muted?: boolean; deafened?: boolean; serverMuted?: boolean; serverDeafened?: boolean; size?: number; className?: string;
}) {
  const serverMicOff = serverMuted || serverDeafened;
  const micLabel = t(serverMicOff ? 'Микрофон отключён на сервере' : 'Микрофон выключен');
  const audioLabel = t(serverDeafened ? 'Звук отключён на сервере' : 'Звук выключен у участника');
  return <span className={`person-status-icons ${className}`}>
    {(muted || serverMicOff) && <span data-server={serverMicOff || undefined} title={micLabel} aria-label={micLabel}><Icon name="mic-off" size={size}/></span>}
    {(deafened || serverDeafened) && <span data-server={serverDeafened || undefined} title={audioLabel} aria-label={audioLabel}><Icon name="headphones-off" size={size}/></span>}
  </span>;
}
