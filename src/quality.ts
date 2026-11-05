import { t } from './i18n';

export function qualityLabel(quality: string): string {
  switch (quality) {
    case 'excellent': return t('Отличное');
    case 'good': return t('Хорошее');
    case 'poor': return t('Плохое');
    case 'lost': return t('Связь потеряна');
    default: return t('Нет данных');
  }
}
