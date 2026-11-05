import { useEffect, useState } from 'react';
import { Modal } from './Modal';
export function HostPanel({ nickname, active, modal, onClose, onCreated, onStatus, onJoin, onStop, onError, onBusy }: {
  nickname: string; active: boolean; modal: 'join' | 'create' | 'share' | 'settings' | null;
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
  const [copied, setCopied] = useState('');
  const [copiedScript, setCopiedScript] = useState('');
  const [level, setLevel] = useState('local');
  const [local, setLocal] = useState('');
  useEffect(() => {
    const receive = (next: HostStatus) => { setStatus(next); onStatus(next.running); };
    void window.desktop?.hostStatus?.().then(receive);
    return window.desktop?.onHostChanged?.(receive);
  }, [onStatus]);
  async function start() {
    if (!window.desktop) { onError('Создание комнаты доступно в десктопном приложении.'); return; }
    setBusy(true); onBusy(true);
    try {
      const roomName = (name ?? "").trim() || `${nickname} хостит`;
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
  if ((modal !== 'create' && modal !== 'share') || (modal === 'share' && !status.running)) return null;
  const lan = (status.invitations || []).slice(status.internet ? 1 : 0).sort((a, b) => Number(!a.startsWith('voicecord://192.168.')) - Number(!b.startsWith('voicecord://192.168.')));
  const selected = level === 'global' ? status.internet ? status.invitations?.[0] || '' : '' : lan.includes(local) ? local : lan[0] || '';
  return <Modal title={status.running ? 'Поделиться комнатой' : 'Создать комнату'} onClose={onClose}>
    {failure && <p role="alert" className="text-error">{failure}</p>}{status.running ? <>
      <label className="host-invite">Уровень сети<select value={level} onChange={e => setLevel(e.target.value)}><option value="global">Глобальный</option><option value="local">Локальный</option></select></label>
      {level === 'local' && lan.length > 1 && <label>Адрес в локальной сети<select value={selected} onChange={e => setLocal(e.target.value)}>{lan.map(value => <option key={value} value={value}>{value.split('/')[2]}</option>)}</select></label>}
      {selected ? <label className="host-invite">Ссылка приглашения<div><input readOnly value={selected} onFocus={e => e.target.select()}/><button className="primary" onClick={() => void (window.desktop ? window.desktop.copyInvitation(selected) : navigator.clipboard.writeText(selected)).then(() => setCopied(selected)).catch(() => onError('Не удалось скопировать приглашение.'))}>{copied === selected ? 'Скопировано' : 'Копировать'}</button></div></label> : <p role="status" className="host-hint">{level === 'global' ? 'Глобальная ссылка недоступна: порты не открыты или у провайдера дополнительный NAT. Выберите локальный уровень сети.' : 'Локальный адрес недоступен.'}</p>}
      <p className="host-hint">Другу нужен Voicecord. Пароль уже включён в ссылку. Комната работает, пока приложение запущено, в том числе в трее.</p>
      <div className="diagnostic-row"><button className="diagnostic-copy" disabled={!selected} onClick={() => void window.desktop?.copyDiagnosticCommand(selected).then(() => setCopiedScript(selected)).catch(() => setFailure('Не удалось скопировать скрипт проверки подключения.'))}>{copiedScript === selected ? 'Скрипт скопирован' : 'Скопировать скрипт проверки'}</button><span>Скрипт для проверки соединения без загрузки приложения (вставляется в CMD)</span></div>
      <button className="host-stop danger-button" disabled={busy} onClick={() => void stop()}>Закрыть комнату для всех</button>
    </> : <form onSubmit={e => { e.preventDefault(); void start(); }}><div className="form-grid">
      <label className="wide">Название комнаты<input required maxLength={80} value={name ?? `${nickname} хостит`} onChange={e => setName(e.target.value)} disabled={busy}/></label>
      <label>Пароль комнаты<input required type="password" minLength={8} maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} autoComplete="new-password" placeholder="Не менее 8 символов"/></label>
      <label>Порт комнаты<input required type="number" min={1024} max={65532} value={port} onChange={e => setPort(Number(e.target.value))} disabled={busy}/></label>
    </div><label className="encryption-toggle"><input type="checkbox" checked={e2ee} disabled={busy} onChange={e => setE2EE(e.target.checked)}/> Сквозное шифрование E2EE (экспериментально)</label><p className="host-hint">{e2ee && 'Ключ включён в приглашение. Все участники должны использовать клиент с поддержкой E2EE. '}Попробуем открыть порты на роутере автоматически. Для интернета нужны входящие TCP {port}, TCP {port + 1} и UDP {port + 2}. При CGNAT может понадобиться VPS; в локальной сети используйте LAN-приглашение.</p><button className="primary" disabled={busy || active || !nickname.trim()}>{busy ? 'Создаём комнату…' : 'Создать и войти →'}</button></form>}
  </Modal>;
}
