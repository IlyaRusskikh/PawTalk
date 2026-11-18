import { t } from './i18n';
export function UpdateSecurityError({ source }: { source?: string }) {
  return <p role="alert" className="text-error">{t("Источник «{0}» не смог предоставить безопасный установщик: подпись обновления или контрольная сумма не прошла проверку. Установка отменена. Попробуйте вручную установить новую версию с GitHub, используя VPN для загрузки.", source || 'GitHub')}</p>;
}
