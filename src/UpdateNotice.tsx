import { t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Controls';
import { UpdateSecurityError } from './UpdateSecurityError';

export function UpdateNotice({ blocked, active, hosting }: { blocked: boolean; active: boolean; hosting: boolean }) {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const offered = useRef(false);
  const downloading = state.status === 'downloading' || state.status === 'installing' || pending;
  const available = !!state.version || state.status === 'security-failed';
  useEffect(() => {
    let live = true;
    let received = false;
    const off = window.desktop?.onUpdate?.(value => { received = true; if (live) setState(value); });
    void window.desktop?.updateState?.().then(value => { if (live && !received) setState(value); }).catch(() => {});
    return () => { live = false; off?.(); };
  }, []);
  useEffect(() => {
    if (available && !blocked && !offered.current) { offered.current = true; setOpen(true); }
  }, [available, blocked]);
  useEffect(() => {
    const show = () => { if (available && !blocked) setOpen(true); };
    window.addEventListener('pawtalk-show-update', show);
    return () => window.removeEventListener('pawtalk-show-update', show);
  }, [available, blocked]);
  async function install() {
    if (downloading || !window.desktop?.installUpdate) return;
    setPending(true);
    try { setState(await window.desktop.installUpdate()); }
    catch { setState(previous => ({ ...previous, status: 'failed' })); }
    finally { setPending(false); }
  }
  return <>
    {available && !blocked && !open && <button className="icon-button update-indicator" title={t("Доступно обновление")} aria-label={t("Доступно обновление")} onClick={() => setOpen(true)}><Icon name="download"/></button>}
    {open && !blocked && <Modal title={t("Обновление PawTalk")} className="update-modal" onClose={() => { if (!downloading) setOpen(false); }}>
      {state.version && <p>{t("Доступна версия ")}{state.version}{state.prerelease ? t(" (предварительный выпуск)") : ''}.</p>}
      {state.status !== 'security-failed' && <p>{t("Новая версия будет загружена и проверена. Затем приложение закроется, предыдущая версия будет удалена, новая — установлена и запущена. Настройки, язык, закладки и пароли сохранятся.")}</p>}
      {state.status !== 'security-failed' && (hosting ? <p className="text-error">{t("Установка закроет вашу комнату и отключит всех участников.")}</p> : active ? <p className="text-error">{t("Установка прервёт текущий звонок.")}</p> : null)}
      {downloading && <><p role="status">{state.status === 'installing' ? t("Запускаем установку…") : t("Загружаем обновление…")}</p><progress max={100} value={state.progress ?? 0}/></>}
      {state.status === 'failed' && <p role="alert" className="text-error">{t("Не удалось загрузить, проверить или запустить обновление. Попробуйте снова. Текущая версия сохранена.")}</p>}
      {state.status === 'security-failed' && <UpdateSecurityError source={state.source}/>}
      {state.installable === false && <p className="host-hint">{t("Установка обновлений доступна в установленном приложении Windows.")}</p>}
      <div className="update-actions"><button className="quiet" disabled={downloading} onClick={() => setOpen(false)}>{t("Отложить")}</button><button className="primary" disabled={downloading || state.installable === false || state.status === 'security-failed'} onClick={() => void install()}>{t("Загрузить и установить")}</button></div>
    </Modal>}
  </>;
}
