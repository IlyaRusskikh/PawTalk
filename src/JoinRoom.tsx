import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { generateMediaKey, validMediaKey } from '../shared/encryption.mjs';
export function validAddress(value: string) {
  try {
    const url = new URL(value.includes('://') ? value.trim() : `https://${value.trim()}`);
    if (url.username || url.password || url.search) return false;
    if (url.protocol === 'voicecord:') {
      const params = new URLSearchParams(url.hash.slice(1));
      return !!url.port && /^\/[a-f0-9]{64}$/.test(url.pathname) && [...params.keys()].every(key => ['password','name','e2ee'].includes(key) && params.getAll(key).length === 1) && (!params.has('e2ee') || validMediaKey(params.get('e2ee')));
    }
    return url.protocol === 'https:' && !!url.hostname && url.pathname === '/' && !url.hash;
  } catch { return false; }
}
export function JoinRoom({ address, setAddress, nickname, busy, error, onConnect, onClose }: {
  address: string; setAddress(value: string): void; nickname: string; busy: boolean; error: string;
  onConnect(input: { address: string; nickname: string; password: string; e2eeKey?: string }): Promise<void>; onClose(): void;
}) {
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState('');
  const [askPassword, setAskPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [e2eeRequired, setE2EERequired] = useState(false);
  const [e2eeKey, setE2EEKey] = useState('');
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);
  async function submit() {
    if (!validAddress(address) || checking || busy) return;
    setFailure('');
    if (address.trim().startsWith('voicecord://')) {
      try {
        const embedded = new URLSearchParams(new URL(address).hash.slice(1)).get('password');
        if (embedded !== null) { await onConnect({ address, nickname, password: embedded }); return; }
      } catch { setFailure('Проверьте приглашение.'); return; }
    }
    const id = ++revision.current; setChecking(true);
    try {
      if (!window.desktop) throw new Error('Подключение доступно в десктопном приложении.');
      const result = await window.desktop.diagnose(address);
      if (id !== revision.current) return;
      if (!result.ok) throw new Error(result.message);
      setE2EERequired(result.e2eeRequired === true); setE2EEKey(address.startsWith('voicecord://') ? new URLSearchParams(new URL(address).hash.slice(1)).get('e2ee') ?? '' : '');
      setPassword(''); setAskPassword(true);
    } catch (e) { if (id === revision.current) setFailure(e instanceof Error ? e.message : String(e)); }
    finally { if (id === revision.current) setChecking(false); }
  }
  return <><Modal title="Присоединиться к комнате" onClose={onClose}><form onSubmit={e => { e.preventDefault(); void submit(); }}>
    {(failure || error) && <p role="alert" className="text-error">{failure || error}</p>}
    <label>Приглашение или адрес сервера<input autoFocus placeholder="voicecord://… или server.example.com" value={address} disabled={busy || checking} onChange={e => { revision.current++; setAddress(e.target.value); setFailure(''); }} autoComplete="off"/></label>
    <button className="primary join-submit" disabled={!validAddress(address) || !nickname.trim() || busy || checking}>{checking ? 'Проверяем соединение…' : busy ? 'Подключение…' : 'Присоединиться'}</button>
  </form></Modal>
  {askPassword && <Modal title="Пароль сервера" onClose={() => { if (!busy) { setAskPassword(false); setPassword(''); setE2EEKey(''); } }}><form onSubmit={e => { e.preventDefault(); const url = address.startsWith('voicecord://') ? new URL(address) : null; if (url && e2eeRequired) { const params = new URLSearchParams(url.hash.slice(1)); params.set('e2ee', e2eeKey); url.hash = params.toString(); } void onConnect({ address: url?.toString() ?? address, nickname, password, ...(e2eeRequired ? { e2eeKey } : {}) }); }}>
    {error && <p role="alert" className="text-error">{error}</p>}<label>Пароль<input autoFocus type="password" required maxLength={1024} autoComplete="off" value={password} disabled={busy} onChange={e => setPassword(e.target.value)}/></label>
    {e2eeRequired && <><label>Ключ E2EE<input type="password" autoComplete="off" value={e2eeKey} maxLength={64} disabled={busy} onChange={e => setE2EEKey(e.target.value.trim())}/></label><p className="host-hint">Используйте ключ от владельца комнаты. Если вы создаёте первую защищённую группу, создайте ключ здесь и передайте друзьям приглашение после входа.</p><button type="button" className="e2ee-generate" disabled={busy} onClick={() => setE2EEKey(generateMediaKey())}>Создать новый ключ</button></>}
    <button className="primary join-submit" disabled={busy || !password || (e2eeRequired && !validMediaKey(e2eeKey))}>{busy ? 'Подключение…' : 'Присоединиться'}</button>
  </form></Modal>}</>;
}
