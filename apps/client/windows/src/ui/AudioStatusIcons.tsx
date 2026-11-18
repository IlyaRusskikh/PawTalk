import { Icon } from '../Controls';
import { t } from '../i18n';

export function AudioStatusIcons({ muted, deafened, locallyMuted, size = 15, className = '' }: {
  muted?: boolean; deafened?: boolean; locallyMuted?: boolean; size?: number; className?: string;
}) {
  const audioLabel = deafened ? t('Участник отключил звук') : t('Звук выключен у вас');
  return <span className={`person-status-icons ${className}`}>
    {muted && <span title={t('Микрофон выключен')} aria-label={t('Микрофон выключен')}><Icon name="mic-off" size={size}/></span>}
    {(deafened || locallyMuted) && <span title={audioLabel} aria-label={audioLabel}><Icon name="headphones-off" size={size}/></span>}
  </span>;
}
