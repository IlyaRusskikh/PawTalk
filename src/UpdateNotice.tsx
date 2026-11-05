import { t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Controls';

export function UpdateNotice({ blocked, active, hosting }: { blocked: boolean; active: boolean; hosting: boolean }) {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const offered = useRef(false);
  const downloading = state.status === 'downloading' || state.status === 'installing' || pending;
  const available = !!state.version;
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
  async function install() {
    if (downloading || !window.desktop?.installUpdate) return;
    setPending(true);
    try { setState(await window.desktop.installUpdate()); }
    catch { setState(previous => ({ ...previous, status: 'failed' })); }
    finally { setPending(false); }
  }
  return <>
    {available && !blocked && !open && <button className="icon-button update-indicator" title={t("Доступно обновление")} aria-label={t("Доступно обновление")} onClick={() => setOpen(true)}><Icon name="download"/></button>}
    {open && !blocked && <Modal title={t("Обновление Voicecord")} className="update-modal" onClose={() => { if (!downloading) setOpen(false); }}>
      <p>{t("Доступна версия ")}{state.version}{state.prerelease ? t(" (предварительный выпуск)") : ''}.</p>
      <p>{t("Новая версия будет загружена и проверена. Затем приложение закроется, предыдущая версия будет удалена, новая — установлена и запущена. Настройки, язык, закладки и пароли сохранятся.")}</p>
      {hosting ? <p className="text-error">{t("Установка закроет вашу комнату и отключит всех участников.")}</p> : active ? <p className="text-error">{t("Установка прервёт текущий звонок.")}</p> : null}
      {downloading && <><p role="status">{state.status === 'installing' ? t("Запускаем установку…") : t("Загружаем обновление…")}</p><progress max={100} value={state.progress ?? 0}/></>}
      {state.status === 'failed' && <p role="alert" className="text-error">{t("Не удалось загрузить, проверить или запустить обновление. Попробуйте снова. Текущая версия сохранена.")}</p>}
      <div className="update-actions"><button className="quiet" disabled={downloading} onClick={() => setOpen(false)}>{t("Отложить")}</button><button className="primary" disabled={downloading} onClick={() => void install()}>{t("Загрузить и установить")}</button></div>
    </Modal>}
  </>;
}
