import { t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Microphone } from './audio';
import { VoiceSession, type Snapshot } from './session';
import { defaults, loadSettings, remember, type Settings } from './settings';
import { Icon, Toggle } from './Controls';
import { AudioQuickMenu } from './AudioQuickMenu';
import { BookmarkRail, type Bookmark } from './BookmarkRail';
import { presencePoll } from '../shared/presence-poll.mjs';
import { VoiceSettings } from './VoiceSettings';
import { Modal } from './Modal';
import { JoinRoom } from './JoinRoom';
import { GuestShare } from './GuestShare';
import { Participants } from './Participants';
import { Avatar } from './Avatar';
import { AvatarEditor } from './AvatarEditor';
import { avatarFormats, avatarStorageKey, validAvatar } from './avatarImage';
import { RoomChat, type ChatRoom } from './RoomChat';
import { RoomSplit } from './RoomSplit';
import { HostPanel } from './HostPanel';
import { ServerKey } from './ServerKey';
import { UpdateNotice } from './UpdateNotice';
import { useLanguage, changeLanguage } from './i18n';

type JoinTarget = { address: string; nickname: string; password: string; e2eeKey?: string };
const initial: Snapshot = { state: 'disconnected', people: [], db: -100, speaking: false };
function stored(key: string) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }

export function App() {
  const language = useLanguage();
  const keys: [number, string][] = [[5, t("Боковая кнопка мыши 4")], [6, t("Боковая кнопка мыши 5")], [32, t("Пробел")], [162, t("Левый Ctrl")], [163, t("Правый Ctrl")], [164, t("Левый Alt")], [165, t("Правый Alt")], [160, t("Левый Shift")], [161, t("Правый Shift")], [20, 'Caps Lock'], ...Array.from({ length: 26 }, (_, i) => [65 + i, String.fromCharCode(65 + i)] as [number, string]), ...Array.from({ length: 12 }, (_, i) => [112 + i, `F${i + 1}`] as [number, string])];
  const [settings, setSettings] = useState(loadSettings);
  const [modal, setModal] = useState<'join' | 'create' | 'share' | 'host-share' | 'settings' | 'server-key' | null>(null);
  const [roomName, setRoomName] = useState('');
  const [page, setPage] = useState<'home' | 'room'>('home');
  const [renaming, setRenaming] = useState<Bookmark | null>(null);
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
  const [avatar, setAvatar] = useState(() => {
    const saved = stored(avatarStorageKey);
    return validAvatar(saved) ? saved : undefined;
  });
  const [avatarFile, setAvatarFile] = useState<File>();
  const avatarPicker = useRef<HTMLInputElement>(null);
  const [hostBusy, setHostBusy] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState(initial);
  const [chatRoom, setChatRoom] = useState<ChatRoom | null>(null);
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
  const showRoom = inRoom && page === 'room';
  useEffect(() => {
    if (snapshot.state !== 'disconnected' || !chatRoom) return;
    if (chatRoom.access) void window.desktop?.chatClose(chatRoom.access.handle).catch(() => {});
    setChatRoom(null);
  }, [snapshot.state, chatRoom]);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(previous => ({ ...previous, [key]: value }));
  const currentTarget = useRef<JoinTarget | null>(null);
  const [bookmarkBusy, setBookmarkBusy] = useState(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => {
    try { const data = JSON.parse(stored('voicecord.bookmarks') || '[]'); return Array.isArray(data) ? data.filter(v => v && typeof v.address === 'string' && typeof v.name === 'string' && !v.address.includes('#')).slice(0, 50) : []; } catch { return []; }
  });
  const [menu, setMenu] = useState<{ address: string; x: number; y: number } | null>(null);
  const [presence, setPresence] = useState<Record<string, number | null>>({});
  useEffect(() => {
    const poll = presencePoll({
      read: async () => Object.fromEntries(await Promise.all(bookmarks.map(async item => {
        try { return [item.address, await window.desktop?.roomPresence?.(item.address) ?? null] as const; }
        catch { return [item.address, null] as const; }
      }))),
      publish: (values: Record<string, number | null>) => setPresence(values),
    });
    let changed = false;
    const receive = (active: boolean) => { changed = true; poll.setActive(active); };
    const off = window.desktop?.onWindowActive?.(receive);
    const fallback = () => receive(document.visibilityState === 'visible' && document.hasFocus());
    if (window.desktop?.windowActive) void window.desktop.windowActive().then(active => { if (!changed) poll.setActive(active); }).catch(() => {});
    else { fallback(); window.addEventListener('focus', fallback); window.addEventListener('blur', fallback); document.addEventListener('visibilitychange', fallback); }
    return () => { poll.stop(); off?.(); window.removeEventListener('focus', fallback); window.removeEventListener('blur', fallback); document.removeEventListener('visibilitychange', fallback); };
  }, [bookmarks]);
  useEffect(() => { localStorage.setItem('voicecord.bookmarks', JSON.stringify(bookmarks)); }, [bookmarks]);
  useEffect(() => {
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', key); window.addEventListener('resize', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); window.removeEventListener('resize', close); };
  }, []);
  function savedNames(): Record<string, string> {
    try { const value = JSON.parse(stored('voicecord.roomNames') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
  }
  function renameRoom(address: string, name: string) {
    const clean = name.trim();
    if (!clean) return;
    setBookmarks(prev => prev.map(item => item.address === address ? { ...item, name: clean } : item));
    localStorage.setItem('voicecord.roomNames', JSON.stringify({ ...savedNames(), [address]: clean }));
    if (currentTarget.current?.address.split('#')[0] === address) setRoomName(clean);
    setRenaming(null);
  }
  const isBookmarked = bookmarks.some(item => item.address === currentTarget.current?.address.split('#')[0]);
  async function toggleBookmark() {
    const target = currentTarget.current;
    if (!target || !window.desktop || bookmarkBusy) return;
    setBookmarkBusy(true);
    try {
      const clean = target.address.split('#')[0];
      if (isBookmarked) { await window.desktop.savePassword({ address: clean, password: null }); setBookmarks(prev => prev.filter(item => item.address !== clean)); return; }
      let secret = target.password;
      if (target.address.startsWith('voicecord://')) secret = new URLSearchParams(new URL(target.address).hash.slice(1)).get('password') ?? secret;
      await window.desktop.savePassword({ address: clean, password: secret, e2eeKey: target.e2eeKey ?? null });
      setBookmarks(prev => [...prev.filter(v => v.address !== clean), { address: clean, name: roomName || t("Комната") }]);
    } catch { setError(t("Не удалось изменить закладку в защищённом хранилище.")); }
    finally { setBookmarkBusy(false); }
  }
  async function openBookmark(item: Bookmark) {
    if (active && item.address === currentTarget.current?.address.split('#')[0]) { setPage('room'); setModal(null); setMenu(null); return; }
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
    if (bookmarkBusy) return;
    setMenu(null); setBookmarkBusy(true);
    try { await window.desktop?.savePassword({ address: item, password: null }); setBookmarks(prev => prev.filter(v => v.address !== item)); }
    catch { setError(t("Не удалось удалить закладку.")); }
    finally { setBookmarkBusy(false); }
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
  useEffect(() => { controller.current?.setAvatar(avatar); }, [avatar]);
  useEffect(() => {
    const timer = setTimeout(() => controller.current?.setNickname(nickname), 300);
    return () => clearTimeout(timer);
  }, [nickname]);
  useEffect(() => { if (modal !== 'settings') setAvatarFile(undefined); }, [modal]);
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
    if (active && target.address.split('#')[0] === currentTarget.current?.address.split('#')[0]) { setPage('room'); setModal(null); return; }
    if (!window.desktop) { setError(t("Подключение доступно в десктопном приложении. Эта страница — предпросмотр интерфейса.")); return; }
    if (settings.inputMode === 'ptt' && !native) { setError(t("Для Push-to-Talk нужно собрать нативный модуль Windows.")); return; }
    const id = ++attempt.current; setBusy(true); setError(''); stopPreview();
    let unusedChat: string | undefined;
    try {
      const result = await window.desktop.connect(target);
      unusedChat = result.chat?.handle;
      if (id !== attempt.current) return;
      if (result.error) throw new Error(result.error);
      if (!hosting) localStorage.setItem('voicecord.address', target.address.split('#')[0]);
      localStorage.setItem('voicecord.nickname', target.nickname);
      setChatRoom(null);
      await controller.current!.disconnect();
      if (id !== attempt.current) return;
      await controller.current!.connect(result.url, result.token, { required: result.e2eeRequired, key: result.e2eeKey });
      if (id !== attempt.current) return;
      joinedOwnHost.current = result.ownHost ?? hosting;
      currentTarget.current = { ...target, e2eeKey: result.e2eeKey };
      setChatRoom({ identity: result.identity, nickname: target.nickname.trim(), access: result.chat, key: result.e2eeKey });
      unusedChat = undefined;
      if (hosting && savedNames()[target.address.split('#')[0]]) setRoomName(savedNames()[target.address.split('#')[0]]);
      setPage('room'); setPersonPrefs({}); setModal(joinedOwnHost.current ? 'host-share' : null); if (!hosting) { try { setRoomName(savedNames()[target.address.split('#')[0]] || displayName || new URLSearchParams(new URL(target.address.includes('://') ? target.address : `https://${target.address}`).hash.slice(1)).get('name') || new URL(target.address.includes('://') ? target.address : `https://${target.address}`).host); } catch { setRoomName(t("Комната")); } } void refreshDevices();
    } catch (error) { if (id === attempt.current) setError(error instanceof Error ? error.message : String(error)); }
    finally {
      if (unusedChat) void window.desktop.chatClose(unusedChat).catch(() => {});
      if (id === attempt.current) setBusy(false);
    }
  }
  async function disconnect() { setPage('home'); currentTarget.current = null; joinedOwnHost.current = false; ++attempt.current; setBusy(false); setPtt(false); await controller.current?.disconnect(); }
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
  function saveAvatar(value?: string) {
    try {
      if (value) localStorage.setItem(avatarStorageKey, value);
      else localStorage.removeItem(avatarStorageKey);
      setAvatar(value);
      return true;
    } catch { return false; }
  }
  const callControls = <div className={`call-controls${showRoom ? '' : ' call-controls-floating'}`} role="group" aria-label={t("Управление звонком")}>
    <AudioQuickMenu kind="input" settings={settings} update={update} devices={devices} onOpen={refreshDevices}>
      <button className={`icon-button ${muted || deafened ? 'off' : ''}`} aria-pressed={muted || deafened} title={t("Микрофон")} onClick={() => setMuted(v => !v)}><Icon name={muted || deafened ? 'mic-off' : 'mic'}/></button>
    </AudioQuickMenu>
    <AudioQuickMenu kind="output" settings={settings} update={update} devices={devices} onOpen={refreshDevices}>
      <button className={`icon-button ${deafened ? 'off' : ''}`} aria-pressed={deafened} title={t("Входящий звук")} onClick={() => setDeafened(v => !v)}><Icon name={deafened ? 'headphones-off' : 'headphones'}/></button>
    </AudioQuickMenu>
    <button className="icon-button call-leave" title={t("Отключиться")} onClick={() => void disconnect()}><Icon name="exit"/></button>
  </div>;
  return <div className="app">
    <aside className="rail"><button className={`server-orb home-orb ${!showRoom ? 'selected' : ''}`} title={t("Главная")} onClick={() => { setPage('home'); setModal(null); }}><img src="./voicecord.svg" width="44" height="44" alt="Voicecord"/></button><div className="rail-line"/><BookmarkRail bookmarks={bookmarks} activeAddress={inRoom ? currentTarget.current?.address.split('#')[0] : undefined} selected={showRoom} people={snapshot.people.length} presence={presence} disabled={busy || hostBusy || bookmarkBusy} onOpen={item => void openBookmark(item)} onReorder={setBookmarks} onMenu={(address, x, y) => setMenu({ address, x: Math.max(8, Math.min(x, window.innerWidth - 210)), y: Math.max(8, Math.min(y, window.innerHeight - 120)) })}/><button className="icon-button rail-settings" title={t("Настройки")} onClick={() => setModal('settings')}><Icon name="settings"/></button></aside>
    {menu && <div className="bookmark-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={e => e.stopPropagation()}><button autoFocus role="menuitem" onClick={() => { const item = bookmarks.find(b => b.address === menu.address); if (item) setRenaming(item); setMenu(null); }}>{t("Переименовать")}</button><button role="menuitem" onClick={() => void removeBookmark(menu.address)}>{t("Удалить закладку")}</button></div>}
    {!showRoom && (active || busy) && callControls}
    <UpdateNotice blocked={modal !== null || renaming !== null} active={active || busy} hosting={hostRunning}/>
    <main>
    <div className={`content${showRoom ? ' room-content' : ''}`}>
      {error && <div role="alert" className="notice error">{error}<button aria-label={t("Закрыть сообщение")} onClick={() => setError('')}>×</button></div>}
      {!native && <div className="notice warning">{window.desktop ? t("Нативный модуль не загружен. Глобальный PTT и приглушение других приложений недоступны.") : t("Предпросмотр интерфейса. Для голосового подключения запустите Electron.")}</div>}
      <>
        {!showRoom && <div className="eyebrow">{t("ВАШЕ МЕСТО ДЛЯ РАЗГОВОРА")}</div>}
        <div className="page-title">
          <div>
            <div className="room-title"><h1>{showRoom ? roomName || t("Вы в хорошей компании.") : t("Разговор начинается здесь.")}</h1>{showRoom && <button className={`icon-button bookmark-add ${isBookmarked ? 'bookmarked' : ''}`} aria-pressed={isBookmarked} title={isBookmarked ? t("Удалить закладку") : t("Добавить в закладки")} disabled={bookmarkBusy} onClick={() => void toggleBookmark()}><Icon name="star"/></button>}</div>
            {!showRoom && <p>{t("Voicecord — личная голосовая комната для вас и друзей. Подключитесь к серверу или создайте свой прямо на этом компьютере.")}</p>}
          </div>
          {showRoom ? <div className="room-presence">
            {snapshot.e2ee && <span className="e2ee-badge" title={t("Голос зашифрован между участниками. Экспериментальный режим.")}>E2EE</span>}
            {snapshot.state !== 'connected' && <span>{t("Восстанавливаем связь…")}</span>}
            <button className="icon-button" title={t("Пригласить пользователя")} onClick={() => setModal(joinedOwnHost.current ? 'host-share' : 'share')}><Icon name="invite"/></button>
          </div> : <span className="badge">{t("● Голосовая связь")}</span>}
        </div>
        {!showRoom && <>{inRoom && <button className="return-room" onClick={() => setPage('room')}>{t("Вернуться в комнату: {0}", roomName)}</button>}<div className="home-actions"><button className="home-action" disabled={busy || hostBusy} onClick={() => setModal('join')}><Icon name="signal" size={30}/><strong>{t("Присоединиться к комнате")}</strong><span>{t("По адресу сервера или приглашению")}</span></button><button className="home-action" disabled={busy || hostBusy} onClick={() => setModal(hostRunning ? 'host-share' : 'create')}><Icon name="invite" size={30}/><strong>{hostRunning ? t("Моя комната") : t("Создать комнату")}</strong><span>{t("Пригласите друзей на свой сервер")}</span></button></div></>}
        {!showRoom && <div className="server-setup"><span>{t("Настраиваете сервер?")}</span><button className="e2ee-generate" onClick={() => setModal('server-key')}>{t("Сгенерировать ключ шифрования")}</button></div>}
        {modal === 'server-key' && <ServerKey onClose={() => setModal(null)}/>}
        {modal === 'join' && <JoinRoom address={address} setAddress={value => { setAddress(value); setError(''); }} nickname={nickname} busy={busy || hostBusy} error={error} onConnect={input => connect(input)} onClose={() => setModal(null)}/>}
        {inRoom && <RoomSplit visible={showRoom} participants={<>
          <Participants people={snapshot.people} prefs={personPrefs} onChange={person}/>
          {showRoom && callControls}
        </>} chat={chatRoom && controller.current && <RoomChat key={chatRoom.identity} room={chatRoom} session={controller.current} people={snapshot.people} profile={{ nickname, avatar }} visible={showRoom} connected={snapshot.state === 'connected'} covered={modal !== null || renaming !== null}/>}/>}
      </>
      {modal === 'share' && currentTarget.current && <GuestShare target={currentTarget.current} name={roomName} onClose={() => setModal(null)}/>}
      <HostPanel nickname={nickname} active={active || busy} modal={modal} onClose={() => setModal(null)} onCreated={setRoomName} onStatus={setHostRunning} onJoin={input => connect(input, true)} onStop={disconnect} onError={setError} onBusy={setHostBusy}/>
      {renaming && <Modal title={t("Переименовать сервер")} onClose={() => setRenaming(null)}><form onSubmit={event => { event.preventDefault(); renameRoom(renaming.address, renaming.name); }}><div className="form-fields"><label>{t("Название сервера")}<input autoFocus required maxLength={64} value={renaming.name} onChange={event => setRenaming({ ...renaming, name: event.target.value })}/></label></div><p className="host-hint">{t("Название изменится только у вас.")}</p><div className="modal-actions"><button type="button" className="quiet" onClick={() => setRenaming(null)}>{t("Отмена")}</button><button className="primary" disabled={!renaming.name.trim()}>{t("Сохранить")}</button></div></form></Modal>}
      {modal === 'settings' && <Modal title={t("Настройки")} className="settings-modal" onClose={() => setModal(null)}>{error && <p role="alert" className="text-error">{error}</p>}<section className="settings-page"><div className="settings-card profile-settings"><h1>{t("Обо мне")}</h1>
        <div className="profile-avatar">
          <Avatar name={nickname} image={avatar}/>
          <div className="profile-avatar-actions">
            <input ref={avatarPicker} type="file" hidden accept={avatarFormats.join(',')} onChange={event => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) setAvatarFile(file);
            }}/>
            <button type="button" className="secondary" onClick={() => avatarPicker.current?.click()}>{t("Выбрать изображение")}</button>
            {avatar && <button type="button" className="quiet" onClick={() => {
              if (!saveAvatar()) setError(t("Не удалось сохранить аватар."));
            }}>{t("Удалить аватар")}</button>}
          </div>
        </div>
        <div className="form-fields"><label>{t("Язык приложения")}<select value={language} onChange={event => void changeLanguage(event.target.value as 'ru' | 'en').catch(() => setError(t("Не удалось сохранить язык. Попробуйте снова.")))}><option value="ru">{t("Русский")}</option><option value="en">English</option></select></label><label>{t("Никнейм")}<input value={nickname} onChange={event => setNickname(event.target.value)} maxLength={32} required placeholder={t("Как вас называть?")}/></label></div><p>{t("Никнейм обновляется и в открытой комнате.")}</p>{autoStart !== null && <Toggle label={t("Запускать Voicecord при входе в Windows")} checked={autoStart} detail={autoStartAvailable ? undefined : t("Автозапуск доступен в установленном приложении Windows.")} disabled={autoStartBusy || !autoStartAvailable} onChange={value => void changeAutoStart(value)}/>} {autoStart !== null && <Toggle label={t("Запускать свёрнутым в трее")} detail={t("При автозапуске окно будет скрыто; открыть его можно через значок в трее.")} checked={startInTray} disabled={autoStartBusy || !autoStartAvailable || !autoStart} onChange={value => void changeStartInTray(value)}/>}</div></section>
      <VoiceSettings settings={settings} update={update} devices={devices} keys={keys} db={db} threshold={threshold} speaking={active && !testing ? snapshot.speaking : testSpeaking} active={active} busy={busy} testing={testing} testBusy={testBusy} ready={previewReady} native={native} keyError={keyError} onTest={() => void toggleTest()} onReset={() => setSettings({ ...defaults })}/></Modal>}
      {modal === 'settings' && avatarFile && <AvatarEditor file={avatarFile} onClose={() => setAvatarFile(undefined)} onSave={saveAvatar}/>}
    </div>
    </main>
  </div>;
}
