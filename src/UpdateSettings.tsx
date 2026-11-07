import { useEffect, useState } from 'react';
import { Toggle, Icon } from './Controls';
import { t } from './i18n';
import { version } from '../package.json';

export function UpdateSettings() {
  const [enabled, setEnabled] = useState(true);
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void window.desktop?.getAutoUpdate?.().then(value => { if (active) setEnabled(value); }).catch(() => { if (active) setError(true); });
    void window.desktop?.updateState?.().then(value => { if (active) setState(value); }).catch(() => {});
    const off = window.desktop?.onUpdate?.(value => { if (active) setState(value); });
    return () => { active = false; off?.(); };
  }, []);
  const supported = !!window.desktop?.checkUpdate;
  return <section className="settings-card update-settings"><h1>{t("Обновления")}</h1><p className="settings-description">{t("Новые возможности и исправления Voicecord.")}</p>
    <p className="current-version">{t("Текущая версия: {0}", version)}</p>
    <Toggle label={t("Автообновление")} detail={t("Проверять новые версии при запуске. Установка — после вашего подтверждения.")} checked={enabled} disabled={!supported || busy} onChange={value => {
      setBusy(true); setError(false);
      void window.desktop!.setAutoUpdate!(value).then(setEnabled).catch(() => setError(true)).finally(() => setBusy(false));
    }}/>
    <div className="update-check-card"><span className="update-check-icon"><Icon name="download" size={25}/></span><div><strong>{state.version ? t("Доступна версия {0}", state.version) : t("Проверка обновлений")}</strong><p role="status">{busy || state.status === 'checking' ? t("Проверяем обновления…") : state.status === 'check-failed' ? t("Не удалось проверить обновления. Попробуйте снова.") : checked && !state.version ? t("У вас последняя версия.") : t("Можно проверить вручную, даже если автообновление выключено.")}</p></div></div>
    <button type="button" className="primary" disabled={!supported || busy || ['checking', 'downloading', 'installing'].includes(state.status)} onClick={() => {
      setBusy(true); setError(false);
      void window.desktop!.checkUpdate!().then(value => { setState(value); setChecked(true); }).catch(() => setError(true)).finally(() => setBusy(false));
    }}>{t("Проверить обновления")}</button>
    {error && <p className="text-error" role="alert">{t("Не удалось изменить или проверить настройки обновления.")}</p>}
    {!supported && <p className="host-hint">{t("Обновления доступны в установленном приложении Windows.")}</p>}
  </section>;
}
