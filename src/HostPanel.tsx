import { t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
export function HostPanel({ nickname, active, modal, onClose, onCreated, onStatus, onJoin, onStop, onError, onBusy }: {
  nickname: string; active: boolean; modal: 'join' | 'create' | 'host-share' | 'share' | 'settings' | 'server-key' | null;
  onClose(): void; onCreated(name: string): void; onStatus(running: boolean): void;
  onJoin(input: { address: string; nickname: string; password: string }): Promise<void>;
  onStop(): Promise<void>; onError(message: string): void; onBusy(value: boolean): void;
}) {
  const [status, setStatus] = useState<HostStatus>({ running: false });
  const [name, setName] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  const [password, setPassword] = useState('');
  const [port, setPort] = useState(18443);
  const [e2ee, setE2EE] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<HostCheckResult | null>(null);
  const [checkFailure, setCheckFailure] = useState('');
  const checkAttempt = useRef(0);
  const checkPending = useRef(false);
  const [copied, setCopied] = useState('');
  const [copiedScript, setCopiedScript] = useState('');
  const [level, setLevel] = useState('local');
  const [local, setLocal] = useState('');
  useEffect(() => {
    if (modal !== 'create') {
      ++checkAttempt.current; setCheckResult(null); setCheckFailure('');
      if (checkPending.current) void window.desktop?.cancelHostCheck().catch(() => {});
    }
  }, [modal]);
  useEffect(() => () => {
    ++checkAttempt.current;
    if (checkPending.current) void window.desktop?.cancelHostCheck().catch(() => {});
  }, []);
  async function check() {
    if (!window.desktop || checkPending.current || busy || active) return;
    const attempt = ++checkAttempt.current;
    checkPending.current = true; setChecking(true); setCheckResult(null); setCheckFailure(''); onBusy(true);
    try {
      const result = await window.desktop.checkHost(port);
      if (attempt === checkAttempt.current) setCheckResult(result);
    } catch (error) {
      if (attempt === checkAttempt.current) {
        setCheckResult({ state: 'error', tcp: [false, false], udp: false });
        setCheckFailure(error instanceof Error ? error.message : t('Не удалось получить результат проверки сети. Попробуйте ещё раз.'));
      }
    } finally { checkPending.current = false; setChecking(false); onBusy(false); }
  }
  useEffect(() => {
    const receive = (next: HostStatus) => { setStatus(next); onStatus(next.running); };
    void window.desktop?.hostStatus?.().then(receive);
    return window.desktop?.onHostChanged?.(receive);
  }, [onStatus]);
  async function start() {
    if (checkPending.current) return;
    if (!window.desktop) { onError(t("Создание комнаты доступно в десктопном приложении.")); return; }
    setBusy(true); onBusy(true);
    try {
      const roomName = (name ?? "").trim() || t("{0} хостит", nickname);
      const next = await window.desktop.startHost({ password, port, name: roomName, e2ee }); setStatus(next);
      setLevel(next.internet ? 'global' : 'local');
      await onJoin({ address: next.localAddress!, nickname, password });
      onCreated(roomName); setPassword('');
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)); onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); onBusy(false); }
  }
  async function stop() {
    setBusy(true);
    try { await onStop(); await window.desktop?.stopHost(); setPassword(''); onClose(); }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)); onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function rejoin() {
    if (!status.localAddress) return;
    setBusy(true);
    try {
      await onJoin({ address: status.localAddress, nickname, password: '' });
    } finally { setBusy(false); }
  }
  if ((modal !== 'create' && modal !== 'host-share') || (modal === 'host-share' && !status.running)) return null;
  const lan = (status.invitations || []).slice(status.internet ? 1 : 0).sort((a, b) => Number(!a.startsWith('voicecord://192.168.')) - Number(!b.startsWith('voicecord://192.168.')));
  const selected = level === 'global' ? status.internet ? status.invitations?.[0] || '' : '' : lan.includes(local) ? local : lan[0] || '';
  const checkReasons: Record<string, string> = {
    'ports-in-use': t('Порты проверки заняты. Закройте другую комнату или выберите другой порт.'),
    'no-interface': t('Не найден сетевой адаптер с IPv4-шлюзом. Проверьте подключение и настройки VPN.'),
    'no-public-ip': t('Не удалось определить публичный IPv4 роутера. Это не означает, что хостинг недоступен.'),
    'checker-unavailable': t('Сервис check-host.net не завершил проверку после повторных запросов. Это ошибка внешней проверки, а не запрет хостинга.'),
    'check-failed': t('Не удалось запустить локальную часть проверки сети.'),
  };
  return <Modal title={status.running ? t("Поделиться комнатой") : t("Создать комнату")} onClose={onClose}>
    {failure && <p role="alert" className="text-error">{failure}</p>}{status.running ? <>
      <div className="form-fields"><label className="host-invite">{t("Уровень сети")}<select value={level} onChange={e => setLevel(e.target.value)}><option value="global">{t("Глобальный")}</option><option value="local">{t("Локальный")}</option></select></label>
      {level === 'local' && lan.length > 1 && <label>{t("Адрес в локальной сети")}<select value={selected} onChange={e => setLocal(e.target.value)}>{lan.map(value => <option key={value} value={value}>{value.split('/')[2]}</option>)}</select></label>}
      {selected ? <label className="host-invite">{t("Ссылка приглашения")}<div><input readOnly value={selected} onFocus={e => e.target.select()}/><button className="primary" onClick={() => void (window.desktop ? window.desktop.copyInvitation(selected) : navigator.clipboard.writeText(selected)).then(() => setCopied(selected)).catch(() => onError(t("Не удалось скопировать приглашение.")))}>{copied === selected ? t("Скопировано") : t("Копировать")}</button></div></label> : <p role="status" className="host-hint">{level === 'global' ? t("Глобальная ссылка недоступна: порты не открыты или у провайдера дополнительный NAT. Выберите локальный уровень сети.") : t("Локальный адрес недоступен.")}</p>}
      </div><p className="host-hint">{t("Другу нужен Voicecord. Пароль уже включён в ссылку. Комната работает, пока приложение запущено, в том числе в трее.")}</p>
      <div className="diagnostic-row"><span>{t("Не уверены, что друг сможет зайти? Отправьте ему скрипт для проверки")}</span><button className="diagnostic-copy" disabled={!selected} onClick={() => void window.desktop?.copyDiagnosticCommand(selected).then(() => setCopiedScript(selected)).catch(() => setFailure(t("Не удалось скопировать скрипт проверки подключения.")))}>{copiedScript === selected ? t("Скрипт скопирован") : t("Копировать")}</button></div>
      <div className="modal-actions">
        {!active && <button className="primary" disabled={busy || !nickname.trim()} onClick={() => void rejoin()}>{t("Войти в комнату")}</button>}
        <button className="host-stop danger-button" disabled={busy} onClick={() => void stop()}>{t("Закрыть комнату для всех")}</button>
      </div>
    </> : <form onSubmit={e => { e.preventDefault(); void start(); }}><div className="form-fields"><div className="form-grid">
      <label className="wide">{t("Название комнаты")}<input required maxLength={80} value={name ?? t("{0} хостит", nickname)} onChange={e => setName(e.target.value)} disabled={busy}/></label>
      <label>{t("Пароль комнаты")}<input required type="password" minLength={8} maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} autoComplete="new-password" placeholder={t("Не менее 8 символов")}/></label>
      <label>{t("Порт комнаты")}<input required type="number" min={1024} max={65532} value={port} onChange={e => { setPort(Number(e.target.value)); setCheckResult(null); setCheckFailure(''); }} disabled={busy || checking}/></label>
    </div>
      <label className="encryption-toggle"><input type="checkbox" checked={e2ee} disabled={busy} onChange={e => setE2EE(e.target.checked)}/>{t("Сквозное шифрование E2EE")}</label>
    </div>
      <div className="host-chat-hints" aria-live="polite">
        <p className="host-chat-kept">{t("Сообщения не пропадут при перезаходе в комнату")}</p>
        <p className="host-chat-ends">{t("Сообщения пропадут, как только вы закроете комнату")}</p>
      </div>
      <section className="host-check" aria-label={t("Проверка хостинга в интернете")}>
        <div className="host-check-heading"><strong>{t("Могу ли я хостить в интернет?")}</strong><button type="button" className="e2ee-generate" disabled={busy || checking || active || !window.desktop || !Number.isInteger(port) || port < 1024 || port > 65532} onClick={() => void check()}>{checking ? t("Проверяем…") : t("Проверить")}</button></div>
        <div role="status" aria-live="polite">
          {checking && <p className="host-hint">{t("Проверяем TCP и UDP из интернета. Это может занять около минуты…")}</p>}
          {checkResult && <p className={`host-check-result ${checkResult.state === 'internet' ? 'success' : 'warning'}`}>{checkResult.state === 'internet' ? t("Да, ко мне можно подключиться через интернет :)") : checkResult.state === 'unconfirmed' ? t("Доступ через интернет не подтверждён. Пока используйте локальную сеть :(") : t("Не удалось завершить проверку. Доступность из интернета пока неизвестна — попробуйте ещё раз.")}</p>}
          {checkResult && checkResult.state !== 'cancelled' && <p className="host-hint host-check-ports">TCP {port}: {checkResult.tcp[0] ? '✓' : '—'} · TCP {port + 1}: {checkResult.tcp[1] ? '✓' : '—'} · UDP {port + 2}: {checkResult.udp ? '✓' : '—'}</p>}
          {(checkFailure || checkResult?.reason) && <p className="host-hint" role="status">{checkFailure || checkReasons[checkResult!.reason!]}</p>}
        </div>
        <p className="host-hint">{t("Попробуем открыть порты и проверить соединение из сети интернет")}</p>
      </section>
      <button className="primary" disabled={busy || checking || active || !nickname.trim()}>{busy ? t("Создаём комнату…") : t("Создать и войти →")}</button></form>}
  </Modal>;
}
