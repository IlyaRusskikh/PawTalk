import { t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Microphone } from './audio';
import { VoiceSession, type Snapshot } from './session';
import { defaults, loadSettings, remember, type Settings } from './settings';
import { Icon, Toggle } from './Controls';
import { AudioQuickMenu } from './AudioQuickMenu';
import { VoiceSettings } from './VoiceSettings';
import { ConnectionStatus } from './ConnectionStatus';
import { Modal } from './Modal';
import { JoinRoom } from './JoinRoom';
import { GuestShare } from './GuestShare';
import { Participants } from './Participants';
import { HostPanel } from './HostPanel';
import { ServerKey } from './ServerKey';
import { UpdateNotice } from './UpdateNotice';
import { useLanguage, changeLanguage } from './i18n';

type Bookmark = { address: string; name: string };
type JoinTarget = { address: string; nickname: string; password: string; e2eeKey?: string };
const initial: Snapshot = { state: 'disconnected', people: [], db: -100, speaking: false };
function stored(key: string) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }

export function App() {
  const language = useLanguage();
  const states: Record<string, string> = { disconnected: t("Не подключено"), connecting: t("Подключение…"), connected: t("На связи"), reconnecting: t("Восстанавливаем связь…"), signalReconnecting: t("Восстанавливаем связь…") };
  const keys: [number, string][] = [[5, t("Боковая кнопка мыши 4")], [6, t("Боковая кнопка мыши 5")], [32, t("Пробел")], [162, t("Левый Ctrl")], [163, t("Правый Ctrl")], [164, t("Левый Alt")], [165, t("Правый Alt")], [160, t("Левый Shift")], [161, t("Правый Shift")], [20, 'Caps Lock'], ...Array.from({ length: 26 }, (_, i) => [65 + i, String.fromCharCode(65 + i)] as [number, string]), ...Array.from({ length: 12 }, (_, i) => [112 + i, `F${i + 1}`] as [number, string])];
  const [settings, setSettings] = useState(loadSettings);
  const [modal, setModal] = useState<'join' | 'create' | 'share' | 'settings' | 'server-key' | null>(null);
  const [roomName, setRoomName] = useState('');
  const [autoStart, setAutoStart] = useState<boolean | null>(null);
  const [autoStartBusy, setAutoStartBusy] = useState(false);
  const [autoStartAvailable, setAutoStartAvailable] = useState(false);
  const [startInTray, setStartInTray] = useState(false);
  useEffect(() => { void window.desktop?.getStartInTray?.().then(setStartInTray).catch(() => setError(t("Не удалось прочитать настройки автозапуска."))); }, []);
  useEffect(() => { void window.desktop?.getAutoStart?.().then(setAutoStart).catch(() => setError(t("Не удалось прочитать настройки автозапуска."))); }, []);
  async function changeAutoStart(value: boolean) {
    if (!window.desktop?.setAutoStart) return;
    setAutoStartBusy(true);
    try { setAutoStart(await window.desktop.setAutoStart(value)); }
    catch { setError(t("Не удалось изменить автозапуск.")); }
    finally { setAutoStartBusy(false); }
  }
  async function changeStartInTray(value: boolean) {
    if (!window.desktop?.setStartInTray) return;
    setAutoStartBusy(true);
    try { setStartInTray(await window.desktop.setStartInTray(value)); }
    catch { setError(t("Не удалось изменить автозапуск.")); }
    finally { setAutoStartBusy(false); }
  }
  const [hostRunning, setHostRunning] = useState(false);
  const [address, setAddress] = useState('');
  const [nickname, setNickname] = useState(() => stored('voicecord.nickname') || t("Гость"));
  const [hostBusy, setHostBusy] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState(initial);
  const [muted, setMuted] = useState(false); const [deafened, setDeafened] = useState(false); const [ptt, setPtt] = useState(false);
  const [native, setNative] = useState(false); const [keyError, setKeyError] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false); const [testBusy, setTestBusy] = useState(false); const [testDb, setTestDb] = useState(-100);
  const [previewReady, setPreviewReady] = useState(false); const [testSpeaking, setTestSpeaking] = useState(false); const [testThreshold, setTestThreshold] = useState(settings.threshold);
  const [personPrefs, setPersonPrefs] = useState<Record<string, { volume: number; muted: boolean }>>({});
  const controller = useRef<VoiceSession | undefined>(undefined); const testMic = useRef<Microphone | undefined>(undefined);
  const attempt = useRef(0); const currentSettings = useRef(settings); currentSettings.current = settings;
  const joinedOwnHost = useRef(false);
  const active = snapshot.state !== 'disconnected';
  const inRoom = ['connected','reconnecting','signalReconnecting'].includes(snapshot.state);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(previous => ({ ...previous, [key]: value }));
  const currentTarget = useRef<JoinTarget | null>(null);
  const [bookmarkBusy, setBookmarkBusy] = useState(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => {
    try { const data = JSON.parse(stored('voicecord.bookmarks') || '[]'); return Array.isArray(data) ? data.filter(v => v && typeof v.address === 'string' && typeof v.name === 'string' && !v.address.includes('#')).slice(0, 50) : []; } catch { return []; }
  });
  const [menu, setMenu] = useState<{ address: string; x: number; y: number } | null>(null);
  useEffect(() => { localStorage.setItem('voicecord.bookmarks', JSON.stringify(bookmarks)); }, [bookmarks]);
  useEffect(() => {
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', key); window.addEventListener('resize', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); window.removeEventListener('resize', close); };
  }, []);
  async function addBookmark() {
    const target = currentTarget.current;
    if (!target || !window.desktop || bookmarkBusy) return;
    setBookmarkBusy(true);
    try {
      const clean = target.address.split('#')[0];
      let secret = target.password;
      if (target.address.startsWith('voicecord://')) secret = new URLSearchParams(new URL(target.address).hash.slice(1)).get('password') ?? secret;
      await window.desktop.savePassword({ address: clean, password: secret, e2eeKey: target.e2eeKey ?? null });
      setBookmarks(prev => [...prev.filter(v => v.address !== clean), { address: clean, name: roomName || t("Комната") }]);
    } catch { setError(t("Не удалось сохранить закладку в защищённом хранилище.")); }
    finally { setBookmarkBusy(false); }
  }
  async function openBookmark(item: Bookmark) {
    if (!window.desktop || busy || hostBusy || bookmarkBusy) return;
    setMenu(null); setBookmarkBusy(true); setError('');
    try {
      const saved = await window.desktop.loadPassword(item.address);
      if (saved.password === null) { setAddress(item.address); setModal('join'); setError(t("Пароль закладки недоступен. Подключитесь заново.")); return; }
      await connect({ address: item.address, nickname, password: saved.password, e2eeKey: saved.e2eeKey ?? undefined }, false, item.name);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBookmarkBusy(false); }
  }
  async function removeBookmark(item: string) {
    setMenu(null);
    try { await window.desktop?.savePassword({ address: item, password: null }); setBookmarks(prev => prev.filter(v => v.address !== item)); }
    catch { setError(t("Не удалось удалить закладку.")); }
  }
  const stopTest = () => { testMic.current?.stopMonitor(); setTesting(false); };
  useEffect(() => {
    const receive = (value: string) => { if (value) { setAddress(value); setError(''); setModal(null); setModal('join'); } };
    const off = window.desktop?.onInvitation?.(receive);
    void window.desktop?.pendingInvitation?.().then(receive);
    return off;
  }, []);
  useEffect(() => { localStorage.setItem('voicecord.nickname', nickname); }, [nickname]);
  const stopPreview = () => { testMic.current?.stop(); testMic.current = undefined; setTesting(false); setPreviewReady(false); setTestDb(-100); setTestSpeaking(false); };
  async function refreshDevices() { try { setDevices(await navigator.mediaDevices.enumerateDevices()); } catch { setError(t("Не удалось получить список аудиоустройств")); } }
  useEffect(() => {
    const c = new VoiceSession(currentSettings.current); controller.current = c;
    c.onUpdate = setSnapshot; c.onError = setError;
    void refreshDevices();
    void window.desktop?.capabilities().then(info => { setNative(info.native); setAutoStartAvailable(info.platform === 'win32' && info.packaged); });
    const offPtt = window.desktop?.onPtt(down => { setPtt(down); c.setPtt(down); const mic = testMic.current; mic?.update(currentSettings.current, false, down); });
    const offAction = window.desktop?.onAction(action => {
      if (action === 'mute') setMuted(value => !value);
      if (action === 'deafen') setDeafened(value => !value);
      if (action === 'force-mute') setMuted(true);
    });
    const offSleep = window.desktop?.onSuspend(() => { ++attempt.current; setBusy(false); setPtt(false); setMuted(true); void c.disconnect(); setError(t("Компьютер перешёл в сон. Подключитесь снова.")); });
    const offHost = window.desktop?.onHostChanged?.(status => { if (!status.running && joinedOwnHost.current) { joinedOwnHost.current = false; ++attempt.current; setBusy(false); void c.disconnect(); if (status.message) setError(status.message); } });
    const change = async () => {
      const list = await navigator.mediaDevices.enumerateDevices(); setDevices(list);
      const s = currentSettings.current;
      if (s.inputDevice !== 'default' && !list.some(d => d.kind === 'audioinput' && d.deviceId === s.inputDevice)) {
        setSettings(previous => ({ ...previous, inputDevice: 'default' })); setError(t("Микрофон отключён: выбрано системное устройство."));
      }
      if (s.outputDevice !== 'default' && !list.some(d => d.kind === 'audiooutput' && d.deviceId === s.outputDevice)) setSettings(previous => ({ ...previous, outputDevice: 'default' }));
    };
    navigator.mediaDevices?.addEventListener('devicechange', change);
    return () => { ++attempt.current; offPtt?.(); offAction?.(); offSleep?.(); offHost?.(); navigator.mediaDevices?.removeEventListener('devicechange', change); testMic.current?.stop(); void c.disconnect(); };
  }, []);
  useEffect(() => { remember(settings); controller.current?.updateSettings(settings); }, [settings]);
  useEffect(() => { controller.current?.setMute(muted, deafened); }, [muted, deafened]);
  useEffect(() => {
    void window.desktop?.configureKeys({ ptt: settings.pttKey, mute: settings.muteKey, deafen: settings.deafenKey }).then(result => {
      setKeyError(result.failed.length ? t("Комбинация занята или указана неверно: ") + result.failed.join(', ') : '');
    }).catch(() => setKeyError(t("Не удалось настроить горячие клавиши")));
  }, [settings.pttKey, settings.muteKey, settings.deafenKey]);
  useEffect(() => {
    if (modal !== 'settings' || busy) return;
    let cancelled = false;
    const mic = new Microphone(currentSettings.current); mic.muted = false; testMic.current = mic;
    mic.onMeter = (db, speaking, threshold) => { if (!cancelled) { setTestDb(db); setTestSpeaking(speaking); setTestThreshold(threshold); } };
    mic.onError = message => { if (!cancelled) setError(message); };
    mic.onEnded = () => { if (!cancelled) { stopPreview(); setError(t("Микрофон отключён. Выберите доступное устройство.")); } };
    void mic.start().then(async () => {
      if (cancelled) { mic.stop(); return; }
      await mic.configure(currentSettings.current);
      if (!cancelled) { setPreviewReady(true); void refreshDevices(); }
    }).catch(error => { if (!cancelled) { mic.stop(); setError(t("Не удалось запустить микрофон: {0}", error.message)); } });
    return () => { cancelled = true; mic.stop(); if (testMic.current === mic) testMic.current = undefined; setTesting(false); setPreviewReady(false); setTestDb(-100); setTestSpeaking(false); };
  }, [modal, active, busy]);
  useEffect(() => {
    const mic = testMic.current;
    if (mic) void mic.configure(settings).catch(error => { if (testMic.current === mic) setError(t("Не удалось применить настройки микрофона: {0}", error.message)); });
  }, [settings]);
  async function connect(target: JoinTarget, hosting = false, displayName?: string) {
    if (!window.desktop) { setError(t("Подключение доступно в десктопном приложении. Эта страница — предпросмотр интерфейса.")); return; }
    if (settings.inputMode === 'ptt' && !native) { setError(t("Для Push-to-Talk нужно собрать нативный модуль Windows.")); return; }
    const id = ++attempt.current; setBusy(true); setError(''); stopPreview();
    try {
      const result = await window.desktop.connect(target);
      if (id !== attempt.current) return;
      if (result.error) throw new Error(result.error);
      if (!hosting) localStorage.setItem('voicecord.address', target.address.split('#')[0]);
      localStorage.setItem('voicecord.nickname', target.nickname);
      await controller.current!.disconnect();
      if (id !== attempt.current) return;
      await controller.current!.connect(result.url, result.token, { required: result.e2eeRequired, key: result.e2eeKey });
      if (id !== attempt.current) return;
      joinedOwnHost.current = hosting;
      currentTarget.current = { ...target, e2eeKey: result.e2eeKey };
      setPersonPrefs({}); setModal(null); setModal(hosting ? 'share' : null); if (!hosting) { try { setRoomName(displayName || new URLSearchParams(new URL(target.address.includes('://') ? target.address : `https://${target.address}`).hash.slice(1)).get('name') || new URL(target.address.includes('://') ? target.address : `https://${target.address}`).host); } catch { setRoomName(t("Комната")); } } void refreshDevices();
    } catch (error) { if (id === attempt.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (id === attempt.current) setBusy(false); }
  }
  async function disconnect() { currentTarget.current = null; joinedOwnHost.current = false; ++attempt.current; setBusy(false); setPtt(false); await controller.current?.disconnect(); }
  async function toggleTest() {
    if (testing) { stopTest(); return; }
    setTestBusy(true); setError('');
    const mic = testMic.current;
    if (!mic || !previewReady) { setTestBusy(false); return; }
    try {
      await mic.startMonitor(); if (testMic.current !== mic) { mic.stop(); return; }
      setTesting(true); void refreshDevices();
    } catch (error) { mic.stopMonitor(); setError(t("Не удалось проверить микрофон: {0}", error instanceof Error ? error.message : error)); }
    finally { setTestBusy(false); }
  }
  const db = testing || !active ? testDb : snapshot.db;
  const threshold = active && !testing ? snapshot.threshold ?? settings.threshold : settings.autoSensitivity ? testThreshold : settings.threshold;
  const person = (id: string, volume: number, localMute: boolean) => {
    setPersonPrefs(prev => ({ ...prev, [id]: { volume, muted: localMute } })); controller.current?.setPerson(id, volume, localMute);
  };
  return <div className="app">
    <aside className="rail"><button className={`server-orb home-orb ${!inRoom || !bookmarks.some(b => b.address === currentTarget.current?.address.split('#')[0]) ? 'selected' : ''}`} title={t("Главная")} onClick={() => setModal(null)}><img src="./voicecord.svg" width="44" height="44" alt="Voicecord"/></button><div className="rail-line"/><div className="bookmark-list">{bookmarks.map(item => <button key={item.address} className={`server-orb bookmark-orb ${inRoom && item.address === currentTarget.current?.address.split('#')[0] ? 'selected' : ''}`} title={item.name} aria-label={item.name} disabled={busy || hostBusy || bookmarkBusy} onClick={() => void openBookmark(item)} onContextMenu={e => { e.preventDefault(); setMenu({ address: item.address, x: Math.max(8, Math.min(e.clientX, window.innerWidth - 210)), y: Math.max(8, Math.min(e.clientY, window.innerHeight - 70)) }); }}>{item.name.slice(0, 1).toUpperCase()}</button>)}</div></aside>
    {menu && <div className="bookmark-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={e => e.stopPropagation()}><button autoFocus role="menuitem" onClick={() => void removeBookmark(menu.address)}>{t("Удалить закладку")}</button></div>}
    <aside className="user-dock" aria-label={t("Профиль и управление звуком")}>

      <div className="profile"><div className={`avatar small ${snapshot.speaking ? 'speaking' : ''}`}>{(nickname || t("Вы")).slice(0, 1).toUpperCase()}</div><span>{nickname || t("Ваш профиль")}</span><ConnectionStatus compact state={snapshot.state} label={states[snapshot.state] || snapshot.state} delay={snapshot.rtt} loss={snapshot.packetLoss}/><AudioQuickMenu kind="input" settings={settings} update={update} devices={devices} onOpen={refreshDevices}><button className={`icon-button ${muted || deafened ? 'off' : ''}`} aria-pressed={muted || deafened} title={t("Микрофон")} onClick={() => setMuted(v => !v)}><Icon name={muted || deafened ? 'mic-off' : 'mic'}/></button></AudioQuickMenu><AudioQuickMenu kind="output" settings={settings} update={update} devices={devices} onOpen={refreshDevices}><button className={`icon-button ${deafened ? 'off' : ''}`} aria-pressed={deafened} title={t("Входящий звук")} onClick={() => setDeafened(v => !v)}><Icon name={deafened ? 'headphones-off' : 'headphones'}/></button></AudioQuickMenu><button className="icon-button" title={t("Настройки")} onClick={() => setModal('settings')}><Icon name="settings"/></button>{(active || busy) && <button className="icon-button off" title={t("Отключиться")} onClick={() => void disconnect()}><Icon name="exit"/></button>}</div>
    </aside>
    <UpdateNotice blocked={modal !== null} active={active || busy} hosting={hostRunning}/>
    <main>
    <div className="content">
      {error && <div role="alert" className="notice error">{error}<button aria-label={t("Закрыть сообщение")} onClick={() => setError('')}>×</button></div>}
      {!native && <div className="notice warning">{window.desktop ? t("Нативный модуль не загружен. Глобальный PTT и приглушение других приложений недоступны.") : t("Предпросмотр интерфейса. Для голосового подключения запустите Electron.")}</div>}
      <>
        <div className="eyebrow">{t("ВАШЕ МЕСТО ДЛЯ РАЗГОВОРА")}</div>
        <div className="page-title"><div><div className="room-title"><h1>{inRoom ? roomName || t("Вы в хорошей компании.") : t("Разговор начинается здесь.")}</h1>{inRoom && <button className="icon-button bookmark-add" title={bookmarks.some(v => v.address === currentTarget.current?.address.split('#')[0]) ? t("В закладках") : t("Добавить в закладки")} disabled={bookmarkBusy || bookmarks.some(v => v.address === currentTarget.current?.address.split('#')[0])} onClick={() => void addBookmark()}><Icon name="bookmark"/></button>}</div><p>{inRoom ? t("Одна комната. Знакомые голоса. Ничего лишнего.") : t("Voicecord — личная голосовая комната для вас и друзей. Подключитесь к серверу или создайте свой прямо на этом компьютере.")}</p></div>{!inRoom && <span className="badge">{t("● Голосовая связь")}</span>}</div>
        {!active && <div className="home-actions"><button className="home-action" disabled={busy || hostBusy} onClick={() => setModal('join')}><Icon name="signal" size={30}/><strong>{t("Присоединиться к комнате")}</strong><span>{t("По адресу сервера или приглашению")}</span></button><button className="home-action" disabled={busy || hostBusy} onClick={() => setModal(hostRunning ? 'share' : 'create')}><Icon name="invite" size={30}/><strong>{t("Создать комнату")}</strong><span>{t("Пригласите друзей на свой сервер")}</span></button></div>}
        {!active && <div className="server-setup"><span>{t("Настраиваете сервер?")}</span><button className="e2ee-generate" onClick={() => setModal('server-key')}>{t("Сгенерировать ключ шифрования")}</button></div>}
        {modal === 'server-key' && <ServerKey onClose={() => setModal(null)}/>}
        {modal === 'join' && <JoinRoom address={address} setAddress={value => { setAddress(value); setError(''); }} nickname={nickname} busy={busy || hostBusy} error={error} onConnect={input => connect(input)} onClose={() => setModal(null)}/>}
        {inRoom && <>
          <div className="participants-heading"><h2>{t("Участники ")}<span>{snapshot.people.length}</span></h2><div className="room-presence">{snapshot.e2ee && <span className="e2ee-badge" title={t("Голос зашифрован между участниками. Экспериментальный режим.")}>E2EE</span>}<span>{states[snapshot.state]}</span>{<button className="icon-button" title={t("Пригласить пользователя")} onClick={() => setModal('share')}><Icon name="invite"/></button>}</div></div>
          <Participants people={snapshot.people} prefs={personPrefs} onChange={person}/>
        </>}
      </>
      {modal === 'share' && !hostRunning && currentTarget.current && <GuestShare target={currentTarget.current} name={roomName} onClose={() => setModal(null)}/>}
      <HostPanel nickname={nickname} active={active || busy} modal={modal} onClose={() => setModal(null)} onCreated={name => { setRoomName(name); setModal('share'); }} onStatus={setHostRunning} onJoin={input => connect(input, true)} onStop={disconnect} onError={setError} onBusy={setHostBusy}/>
      {modal === 'settings' && <Modal title={t("Настройки")} className="settings-modal" onClose={() => setModal(null)}>{error && <p role="alert" className="text-error">{error}</p>}<section className="settings-page"><div className="settings-card profile-settings"><h1>{t("Обо мне")}</h1><div className="form-fields"><label>{t("Язык приложения")}<select value={language} onChange={event => void changeLanguage(event.target.value as 'ru' | 'en').catch(() => setError(t("Не удалось сохранить язык. Попробуйте снова.")))}><option value="ru">{t("Русский")}</option><option value="en">English</option></select></label><label>{t("Никнейм")}<input value={nickname} onChange={event => setNickname(event.target.value)} maxLength={32} required placeholder={t("Как вас называть?")}/></label></div><p>{t("Используется при следующем подключении к комнате.")}</p>{autoStart !== null && <Toggle label={t("Запускать Voicecord при входе в Windows")} checked={autoStart} detail={autoStartAvailable ? undefined : t("Автозапуск доступен в установленном приложении Windows.")} disabled={autoStartBusy || !autoStartAvailable} onChange={value => void changeAutoStart(value)}/>} {autoStart !== null && <Toggle label={t("Запускать свёрнутым в трее")} detail={t("При автозапуске окно будет скрыто; открыть его можно через значок в трее.")} checked={startInTray} disabled={autoStartBusy || !autoStartAvailable || !autoStart} onChange={value => void changeStartInTray(value)}/>}</div></section>
      <VoiceSettings settings={settings} update={update} devices={devices} keys={keys} db={db} threshold={threshold} speaking={active && !testing ? snapshot.speaking : testSpeaking} active={active} busy={busy} testing={testing} testBusy={testBusy} ready={previewReady} native={native} keyError={keyError} onTest={() => void toggleTest()} onReset={() => setSettings({ ...defaults })}/></Modal>}
    </div>
    </main>
  </div>;
}
