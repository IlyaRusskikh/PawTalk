import { t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Microphone } from './audio';
import { VoiceSession, type Snapshot } from './session';
import { resetSettingsTab, loadSettings, remember, type Settings } from './settings';
import { Icon, Toggle } from './Controls';
import { AudioQuickMenu } from './AudioQuickMenu';
import { BookmarkRail, type Bookmark, type RoomPreview } from './BookmarkRail';
import { presencePoll } from '../shared/presence-poll.mjs';
import { HomeScreen } from './HomeScreen';
import { SettingsShell, settingsPage, type SettingsSection } from './SettingsShell';
import { AppearanceSettings } from './AppearanceSettings';
import { ChatSettings, loadChatWindow } from './ChatSettings';
import { UpdateSettings } from './UpdateSettings';
import { ConnectionFailure } from './ConnectionFailure';
import { Toast } from './Toast';
import { applyTheme, loadTheme } from './theme';
import { VoiceSettings } from './VoiceSettings';
import { Modal } from './Modal';
import { JoinRoom } from './JoinRoom';
import { GuestShare } from './GuestShare';
import { bookmarkAddress, sameBookmark, reconcileBookmarks, loadBookmarks } from '../shared/room-bookmarks.mjs';
import { Participants } from './Participants';
import { Avatar } from './Avatar';
import { AvatarEditor } from './AvatarEditor';
import { avatarFormats, avatarStorageKey, validAvatar } from './avatarImage';
import { readChatCursor } from './chat';
import { RoomChat, type ChatRoom } from './RoomChat';
import { RoomSplit } from './RoomSplit';
import { HostPanel } from './HostPanel';
import { ServerKey } from './ServerKey';
import { UpdateNotice } from './UpdateNotice';
import { playSound } from './sounds';
import { useLanguage, changeLanguage } from './i18n';

type JoinTarget = { address: string; nickname: string; password: string; e2eeKey?: string; roomId?: string };
const initial: Snapshot = { state: 'disconnected', people: [], db: -100, speaking: false };
function stored(key: string) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }

export function App() {
  const language = useLanguage();
  const keys: [number, string][] = [[5, t("Боковая кнопка мыши 4")], [6, t("Боковая кнопка мыши 5")], [32, t("Пробел")], [162, t("Левый Ctrl")], [163, t("Правый Ctrl")], [164, t("Левый Alt")], [165, t("Правый Alt")], [160, t("Левый Shift")], [161, t("Правый Shift")], [20, 'Caps Lock'], ...Array.from({ length: 26 }, (_, i) => [65 + i, String.fromCharCode(65 + i)] as [number, string]), ...Array.from({ length: 12 }, (_, i) => [112 + i, `F${i + 1}`] as [number, string])];
  const [onboarding, setOnboarding] = useState<number | null>(() => stored('pawtalk.onboarding') === 'pending' || (!stored('pawtalk.onboarding') && !stored('pawtalk.nickname')) ? 0 : null);
  useEffect(() => { if (onboarding !== null) localStorage.setItem('pawtalk.onboarding', 'pending'); }, [onboarding]);
  const onboardingActive = useRef(onboarding !== null); onboardingActive.current = onboarding !== null;
  function finishOnboarding() { localStorage.setItem('pawtalk.onboarding', 'done'); setNickname(value => value.trim() || t("Гость")); setOnboarding(null); setModal(address ? 'join' : null); }
  const [settings, setSettings] = useState(loadSettings);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('profile');
  const settingsPageId = settingsPage(settingsSection);
  const [theme, setTheme] = useState(loadTheme);
  const [chatWindow, setChatWindow] = useState(loadChatWindow);
  const [activeUnread, setActiveUnread] = useState(0);
  const [nativeNoticeDismissed, setNativeNoticeDismissed] = useState(false);
  useEffect(() => { try { localStorage.setItem('pawtalk.chat.window', String(chatWindow)); } catch {} }, [chatWindow]);
  useEffect(() => { applyTheme(theme); try { localStorage.setItem('pawtalk.theme', JSON.stringify(theme)); } catch {} }, [theme]);
  const [modal, setModal] = useState<'join' | 'create' | 'share' | 'host-share' | 'settings' | 'server-key' | null>(() => onboarding !== null ? 'settings' : null);
  const [roomName, setRoomName] = useState('');
  const [page, setPage] = useState<'home' | 'room'>('home');
  const [renaming, setRenaming] = useState<Bookmark | null>(null);
  const [autoStart, setAutoStart] = useState<boolean | null>(null);
  const [autoStartBusy, setAutoStartBusy] = useState(false);
  const [autoStartAvailable, setAutoStartAvailable] = useState(false);
  const [startInTray, setStartInTray] = useState(false);
  useEffect(() => { void window.desktop?.getStartInTray?.().then(setStartInTray).catch(() => setSettingsError(t("Не удалось прочитать настройки автозапуска."))); }, []);
  useEffect(() => { void window.desktop?.getAutoStart?.().then(setAutoStart).catch(() => setSettingsError(t("Не удалось прочитать настройки автозапуска."))); }, []);
  async function changeAutoStart(value: boolean) {
    if (!window.desktop?.setAutoStart) return;
    setAutoStartBusy(true);
    try { setAutoStart(await window.desktop.setAutoStart(value)); }
    catch { setSettingsError(t("Не удалось изменить автозапуск.")); }
    finally { setAutoStartBusy(false); }
  }
  async function changeStartInTray(value: boolean) {
    if (!window.desktop?.setStartInTray) return;
    setAutoStartBusy(true);
    try { setStartInTray(await window.desktop.setStartInTray(value)); }
    catch { setSettingsError(t("Не удалось изменить автозапуск.")); }
    finally { setAutoStartBusy(false); }
  }
  const [hostRunning, setHostRunning] = useState(false);
  const [address, setAddress] = useState('');
  const [nickname, setNickname] = useState(() => stored('pawtalk.nickname') || t("Гость"));
  const [avatar, setAvatar] = useState(() => {
    const saved = stored(avatarStorageKey);
    return validAvatar(saved) ? saved : undefined;
  });
  const [avatarFile, setAvatarFile] = useState<File>();
  const avatarPicker = useRef<HTMLInputElement>(null);
  const [hostBusy, setHostBusy] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [connectionStage, setConnectionStage] = useState<'server' | 'voice'>('server');
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
    try { return loadBookmarks(JSON.parse(stored('pawtalk.bookmarks') || '[]')); } catch { return []; }
  });
  const [menu, setMenu] = useState<{ address: string; x: number; y: number } | null>(null);
  const [presence, setPresence] = useState<Record<string, RoomPreview>>({});
  useEffect(() => {
    const poll = presencePoll({
      read: async () => {
        const result: Record<string, RoomPreview> = {};
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(4, bookmarks.length) }, async () => {
          while (index < bookmarks.length) {
            const item = bookmarks[index++];
            try {
              let saved: { feed?: string; ephemeral?: boolean } = {};
              try { saved = JSON.parse(localStorage.getItem('pawtalk.chat.feed.' + item.address) ?? '{}'); } catch {}
              const after = saved.feed ? readChatCursor({ handle: '', feed: saved.feed, ephemeral: !!saved.ephemeral }) : 0;
              const preview = window.desktop?.roomPreview ? await window.desktop.roomPreview(item.address, { feed: saved.feed, after, roomId: item.roomId }) : undefined;
              const count = preview ? undefined : await window.desktop?.roomPresence?.(item.address);
              result[item.address] = preview ?? (typeof count === 'number' ? { status: 'online', participants: count, unread: 0, details: false } : { status: 'offline' });
              if (preview?.feed) try { localStorage.setItem('pawtalk.chat.feed.' + item.address, JSON.stringify({ feed: preview.feed, ephemeral: preview.ephemeral })); } catch {}
            } catch { result[item.address] = { status: 'offline' }; }
          }
        }));
        return result;
      },
      publish: (values: Record<string, RoomPreview>) => setPresence(values),
    });
    let changed = false;
    const receive = (active: boolean) => { changed = true; poll.setActive(active); };
    const off = window.desktop?.onWindowActive?.(receive);
    const fallback = () => receive(document.visibilityState === 'visible' && document.hasFocus());
    if (window.desktop?.windowActive) void window.desktop.windowActive().then(active => { if (!changed) poll.setActive(active); }).catch(() => {});
    else { fallback(); window.addEventListener('focus', fallback); window.addEventListener('blur', fallback); document.addEventListener('visibilitychange', fallback); }
    return () => { poll.stop(); off?.(); window.removeEventListener('focus', fallback); window.removeEventListener('blur', fallback); document.removeEventListener('visibilitychange', fallback); };
  }, [bookmarks]);
  useEffect(() => {
    localStorage.setItem('pawtalk.bookmarks', JSON.stringify(bookmarks));
    void window.desktop?.setUpdateRooms?.(bookmarks.map(({ address, name }) => ({ address, name }))).catch(() => {});
  }, [bookmarks]);
  useEffect(() => {
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', key); window.addEventListener('resize', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); window.removeEventListener('resize', close); };
  }, []);
  function savedNames(): Record<string, string> {
    try { const value = JSON.parse(stored('pawtalk.roomNames') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
  }
  function renameRoom(address: string, name: string) {
    const clean = name.trim();
    if (!clean) return;
    setBookmarks(prev => prev.map(item => item.address === address ? { ...item, name: clean } : item));
    localStorage.setItem('pawtalk.roomNames', JSON.stringify({ ...savedNames(), [address]: clean }));
    if (currentTarget.current?.address.split('#')[0] === address) setRoomName(clean);
    setRenaming(null);
  }
  const isBookmarked = bookmarks.some(item => sameBookmark(item,currentTarget.current));
  async function toggleBookmark() {
    const target = currentTarget.current;
    if (!target || !window.desktop || bookmarkBusy) return;
    setBookmarkBusy(true);
    try {
      const clean = bookmarkAddress(target.address);
      if (isBookmarked) { for(const item of bookmarks.filter(item=>sameBookmark(item,target)))await window.desktop.savePassword({address:item.address,password:null}); setBookmarks(prev => prev.filter(item => !sameBookmark(item,target))); return; }
      let secret = target.password;
      if (target.address.startsWith('pawtalk://')) secret = new URLSearchParams(new URL(target.address).hash.slice(1)).get('password') ?? secret;
      await window.desktop.savePassword({ address: clean, password: secret, e2eeKey: target.e2eeKey ?? null });
      setBookmarks(prev => [...prev.filter(v => v.address!==clean && !sameBookmark(v,target)), { address: clean, name: roomName || t("Комната"), ...(target.roomId?{roomId:target.roomId}:{}) }]);
    } catch { setError(t("Не удалось изменить закладку в защищённом хранилище.")); }
    finally { setBookmarkBusy(false); }
  }
  async function openBookmark(item: Bookmark) {
    if (active && sameBookmark(item,currentTarget.current)) { setPage('room'); setModal(null); setMenu(null); return; }
    if (!window.desktop || busy || hostBusy || bookmarkBusy) return;
    setMenu(null); setBookmarkBusy(true); setError('');
    try {
      const saved = await window.desktop.loadPassword(item.address);
      if (saved.password === null) { setAddress(item.address); setModal('join'); setError(t("Пароль закладки недоступен. Подключитесь заново.")); return; }
      await connect({ address: item.address, nickname, password: saved.password, e2eeKey: saved.e2eeKey ?? undefined }, false, item.name, true);
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
    const receive = (value: string) => { if (value) { setAddress(value); setError(''); if (!onboardingActive.current) { setModal(null); setModal('join'); } } };
    const off = window.desktop?.onInvitation?.(receive);
    void window.desktop?.pendingInvitation?.().then(receive);
    return off;
  }, []);
  useEffect(() => { localStorage.setItem('pawtalk.nickname', nickname); }, [nickname]);
  const stopPreview = () => { testMic.current?.stop(); testMic.current = undefined; setTesting(false); setPreviewReady(false); setTestDb(-100); setTestSpeaking(false); };
  async function refreshDevices() { try { setDevices(await navigator.mediaDevices.enumerateDevices()); } catch { setError(t("Не удалось получить список аудиоустройств")); } }
  useEffect(() => {
    const c = new VoiceSession(currentSettings.current); controller.current = c;
    c.onUpdate = setSnapshot; c.onError = message => { if (c.room?.state !== 'connected') setConnectionError(message); else setError(message); };
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
  const previousAudio = useRef({ muted, deafened });
  useEffect(() => {
    controller.current?.setMute(muted, deafened);
    const previous = previousAudio.current;
    if (previous.deafened !== deafened) void playSound(deafened ? 'deafen' : 'undeafen', currentSettings.current);
    else if (previous.muted !== muted) void playSound(muted ? 'mute' : 'unmute', currentSettings.current);
    previousAudio.current = { muted, deafened };
  }, [muted, deafened]);
  useEffect(() => {
    void window.desktop?.configureKeys({ ptt: settings.pttKey, mute: settings.muteKey, deafen: settings.deafenKey }).then(result => {
      setKeyError(result.failed.length ? t("Комбинация занята или указана неверно: ") + result.failed.join(', ') : '');
    }).catch(() => setKeyError(t("Не удалось настроить горячие клавиши")));
  }, [settings.pttKey, settings.muteKey, settings.deafenKey]);
  useEffect(() => {
    if (modal !== 'settings' || settingsPageId !== 'audio' || busy) return;
    let cancelled = false;
    const mic = new Microphone(currentSettings.current); mic.muted = false; testMic.current = mic;
    mic.onMeter = (db, speaking, threshold) => { if (!cancelled) { setTestDb(db); setTestSpeaking(speaking); setTestThreshold(threshold); } };
    mic.onError = message => { if (!cancelled) setSettingsError(message); };
    mic.onEnded = () => { if (!cancelled) { stopPreview(); setSettingsError(t("Микрофон отключён. Выберите доступное устройство.")); } };
    void mic.start().then(async () => {
      if (cancelled) { mic.stop(); return; }
      await mic.configure(currentSettings.current);
      if (!cancelled) { setPreviewReady(true); void refreshDevices(); }
    }).catch(error => { if (!cancelled) { mic.stop(); setSettingsError(t("Не удалось запустить микрофон: {0}", error.message)); } });
    return () => { cancelled = true; mic.stop(); if (testMic.current === mic) testMic.current = undefined; setTesting(false); setPreviewReady(false); setTestDb(-100); setTestSpeaking(false); };
  }, [modal, settingsPageId, active, busy]);
  useEffect(() => {
    const mic = testMic.current;
    if (mic) void mic.configure(settings).catch(error => { if (testMic.current === mic) setSettingsError(t("Не удалось применить настройки микрофона: {0}", error.message)); });
  }, [settings]);
  async function connect(target: JoinTarget, hosting = false, displayName?: string, fromBookmark = false) {
    if (!window.desktop) { setError(t("Подключение доступно в десктопном приложении. Эта страница — предпросмотр интерфейса.")); return; }
    if (settings.inputMode === 'ptt' && !native) { setError(t("Для Push-to-Talk нужно собрать нативный модуль Windows.")); return; }
    const id = ++attempt.current; setBusy(true); setConnectionStage('server'); setError(''); setConnectionError(''); stopPreview();
    let unusedChat: string | undefined;
    try {
      const result = await window.desktop.connect(target);
      unusedChat = result.chat?.handle;
      if (id !== attempt.current) return;
      if (result.error) {
        if(fromBookmark && result.credentialsRequired) { setAddress(target.address);setModal('join'); }
        throw new Error(result.error);
      }
      const password=target.password || (target.address.startsWith('pawtalk://') ? new URLSearchParams(new URL(target.address).hash.slice(1)).get('password') : '') || '';
      const verified = { ...target, password, address: result.bookmarkAddress || bookmarkAddress(target.address), roomId: result.roomId, e2eeKey: result.e2eeKey };
      const matches=bookmarks.filter(item=>sameBookmark(item,verified));
      if(matches.length) {
        await window.desktop.savePassword({address:verified.address,password:verified.password,e2eeKey:result.e2eeKey??null});
        for(const item of matches)if(bookmarkAddress(item.address)!==verified.address)await window.desktop.savePassword({address:item.address,password:null});
        setBookmarks(prev=>reconcileBookmarks(prev,verified));
        setPresence({});
      }
      if (!hosting) localStorage.setItem('pawtalk.address', target.address.split('#')[0]);
      localStorage.setItem('pawtalk.nickname', target.nickname);
      setChatRoom(null);
      await controller.current!.disconnect();
      if (id !== attempt.current) return;
      setConnectionStage('voice');
      await controller.current!.connect(result.url, result.token, { required: result.e2eeRequired, key: result.e2eeKey });
      if (id !== attempt.current) return;
      joinedOwnHost.current = result.ownHost ?? hosting;
      currentTarget.current = verified;
      setActiveUnread(0);
      if (result.chat) try { localStorage.setItem('pawtalk.chat.feed.' + verified.address, JSON.stringify({ feed: result.chat.feed, ephemeral: result.chat.ephemeral })); } catch {}
      setChatRoom({ identity: result.identity, nickname: target.nickname.trim(), access: result.chat, key: result.e2eeKey });
      unusedChat = undefined;
      if (hosting && savedNames()[target.address.split('#')[0]]) setRoomName(savedNames()[target.address.split('#')[0]]);
      setPage('room'); setPersonPrefs({}); setModal(null); if (!hosting) { try { setRoomName(savedNames()[target.address.split('#')[0]] || displayName || new URLSearchParams(new URL(target.address.includes('://') ? target.address : `https://${target.address}`).hash.slice(1)).get('name') || new URL(target.address.includes('://') ? target.address : `https://${target.address}`).host); } catch { setRoomName(t("Комната")); } } void refreshDevices();
    } catch (error) { if (id === attempt.current) setConnectionError(error instanceof Error ? error.message : String(error)); }
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
  const callControls = <div className="call-controls" role="group" aria-label={t("Управление звонком")}>
    <AudioQuickMenu kind="input" settings={settings} update={update} devices={devices} onOpen={refreshDevices}>
      <button className={`icon-button ${muted || deafened ? 'off' : ''}`} aria-pressed={muted || deafened} title={t("Микрофон")} onClick={() => setMuted(v => !v)}><Icon name={muted || deafened ? 'mic-off' : 'mic'}/></button>
    </AudioQuickMenu>
    <AudioQuickMenu kind="output" settings={settings} update={update} devices={devices} onOpen={refreshDevices}>
      <button className={`icon-button ${deafened ? 'off' : ''}`} aria-pressed={deafened} title={t("Входящий звук")} onClick={() => setDeafened(v => !v)}><Icon name={deafened ? 'headphones-off' : 'headphones'}/></button>
    </AudioQuickMenu>
    <button className="icon-button call-leave" title={t("Отключиться")} onClick={() => void disconnect()}><Icon name="exit"/></button>
  </div>;
  return <div className="app">
    <aside className="rail"><button className={`server-orb home-orb ${!showRoom ? 'selected' : ''}`} title={t("Главная")} onClick={() => { setPage('home'); setModal(null); }}><img src="./pawtalk-mark.svg" width="44" height="44" alt="PawTalk"/></button><div className="rail-line"/><BookmarkRail bookmarks={bookmarks} temporaryRoom={inRoom && !isBookmarked && currentTarget.current ? { address: currentTarget.current.address.split('#')[0], name: roomName || t("Комната") } : undefined} onSaveTemporary={() => void toggleBookmark()} activeAddress={inRoom ? currentTarget.current?.address.split('#')[0] : undefined} activeRoomId={currentTarget.current?.roomId} selected={showRoom} people={snapshot.people.length} livePeople={snapshot.people} unread={activeUnread} presence={presence} disabled={busy || hostBusy || bookmarkBusy} onOpen={item => void openBookmark(item)} onReorder={setBookmarks} onMenu={(address, x, y) => setMenu({ address, x: Math.max(8, Math.min(x, window.innerWidth - 210)), y: Math.max(8, Math.min(y, window.innerHeight - 120)) })}/><div className="rail-actions"><UpdateNotice blocked={(modal !== null && modal !== 'settings') || renaming !== null || !!avatarFile || onboarding !== null} active={active || busy} hosting={hostRunning}/><button className="icon-button rail-settings" title={t("Настройки")} onClick={() => setModal('settings')}><Icon name="settings"/></button></div></aside>
    {menu && <div className="bookmark-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={e => e.stopPropagation()}><button autoFocus role="menuitem" onClick={() => { const item = bookmarks.find(b => b.address === menu.address); if (item) setRenaming(item); setMenu(null); }}>{t("Переименовать")}</button><button role="menuitem" onClick={() => void removeBookmark(menu.address)}>{t("Удалить закладку")}</button></div>}
    <main>
    <div className={`content${showRoom ? ' room-content' : ''}`}>
      <div className="toast-stack" aria-live="polite">
        {connectionError && modal !== 'join' && <Toast key={connectionError} onDismiss={() => setConnectionError('')}><ConnectionFailure detail={connectionError} onClose={() => setConnectionError('')}/></Toast>}
        {error && <Toast key={error} onDismiss={() => setError('')}><div role="alert" className="notice error">{error}<button aria-label={t("Закрыть сообщение")} onClick={() => setError('')}>×</button></div></Toast>}
        {!native && !nativeNoticeDismissed && <Toast onDismiss={() => setNativeNoticeDismissed(true)}><div className="notice warning">{window.desktop ? t("Нативный модуль не загружен. Глобальный PTT и приглушение других приложений недоступны.") : t("Предпросмотр интерфейса. Для голосового подключения запустите Electron.")}<button aria-label={t("Закрыть сообщение")} onClick={() => setNativeNoticeDismissed(true)}>×</button></div></Toast>}
      </div>
      <>
        {showRoom && <div className="page-title">
          <div>
            <div className="room-title"><h1>{showRoom ? roomName || t("Вы в хорошей компании.") : t("Разговор начинается здесь.")}</h1>{showRoom && <button className={`icon-button bookmark-add ${isBookmarked ? 'bookmarked' : ''}`} aria-pressed={isBookmarked} title={isBookmarked ? t("Удалить закладку") : t("Добавить в закладки")} disabled={bookmarkBusy} onClick={() => void toggleBookmark()}><Icon name="star"/></button>}</div>
            {!showRoom && <p>{t("PawTalk — личная голосовая комната для вас и друзей. Подключитесь к серверу или создайте свой прямо на этом компьютере.")}</p>}
          </div>
          {showRoom ? <div className="room-presence">
            {snapshot.e2ee && <span className="e2ee-badge" title={t("Голос зашифрован между участниками. Экспериментальный режим.")}>E2EE</span>}
            {snapshot.state !== 'connected' && <span>{t("Восстанавливаем связь…")}</span>}
            <button className="icon-button" title={t("Пригласить пользователя")} onClick={() => setModal(joinedOwnHost.current ? 'host-share' : 'share')}><Icon name="invite"/></button>
          </div> : <span className="badge">{t("● Голосовая связь")}</span>}
        </div>}
        {!showRoom && <HomeScreen hosting={hostRunning} disabled={busy || hostBusy} bookmarks={bookmarks} roomName={roomName} inRoom={inRoom} onJoin={() => setModal('join')} onHost={() => setModal(hostRunning ? 'host-share' : 'create')} onOpen={item => void openBookmark(item)} onReturn={() => setPage('room')} onServerKey={() => setModal('server-key')}/>}
        {modal === 'server-key' && <ServerKey onClose={() => setModal(null)}/>}
        {modal === 'join' && <JoinRoom address={address} setAddress={value => { setAddress(value); setError(''); setConnectionError(''); }} nickname={nickname} busy={busy || hostBusy} error={connectionError} onConnect={input => connect(input)} onClose={() => setModal(null)}/>}
        {inRoom && <RoomSplit visible={showRoom} participants={<>
          <Participants people={snapshot.people} prefs={personPrefs} onChange={person}/>
          {showRoom && callControls}
        </>} chat={chatRoom && controller.current && <RoomChat key={chatRoom.identity} room={chatRoom} session={controller.current} people={snapshot.people} profile={{ nickname, avatar }} visible={showRoom} connected={snapshot.state === 'connected'} covered={modal !== null || renaming !== null} windowSize={chatWindow} onUnread={setActiveUnread}/>}/>}
      </>
      {modal === 'share' && currentTarget.current && <GuestShare target={currentTarget.current} name={roomName} onClose={() => setModal(null)}/>}
      <HostPanel nickname={nickname} active={active || busy} modal={modal} onClose={() => setModal(null)} onCreated={name => { setRoomName(name); setModal('host-share'); }} onStatus={setHostRunning} onJoin={input => connect(input, true)} onStop={disconnect} onError={setError} onBusy={setHostBusy}/>
      {renaming && <Modal title={t("Переименовать сервер")} onClose={() => setRenaming(null)}><form onSubmit={event => { event.preventDefault(); renameRoom(renaming.address, renaming.name); }}><div className="form-fields"><label>{t("Название сервера")}<input autoFocus required maxLength={64} value={renaming.name} onChange={event => setRenaming({ ...renaming, name: event.target.value })}/></label></div><p className="host-hint">{t("Название изменится только у вас.")}</p><div className="modal-actions"><button type="button" className="quiet" onClick={() => setRenaming(null)}>{t("Отмена")}</button><button className="primary" disabled={!renaming.name.trim()}>{t("Сохранить")}</button></div></form></Modal>}
      {modal === 'settings' && <Modal title={onboarding !== null ? t("Добро пожаловать в PawTalk") : t("Настройки")} className={onboarding !== null ? 'settings-modal onboarding-modal' : 'settings-modal'} onClose={() => onboarding !== null ? finishOnboarding() : setModal(null)}>{settingsError && <p role="alert" className="text-error">{settingsError}</p>}{onboarding !== null && <div className="onboarding-progress"><p>{t("Шаг {0} из 3", onboarding + 1)}</p><p>{[t("Как вас называть? Выберите язык приложения и никнейм."), t("Добавьте аватарку — или оставьте инициалы."), t("Выберите устройства и проверьте микрофон в наушниках.")][onboarding]}</p></div>}<SettingsShell wizard={onboarding !== null} section={settingsSection} onChange={setSettingsSection}>{settingsSection === 'profile' && <section className="settings-page"><div className="settings-card profile-settings"><h1>{t("Обо мне")}</h1>
        {onboarding !== 0 && <div className="profile-avatar">
          <Avatar name={nickname} image={avatar}/>
          <div className="profile-avatar-actions">
            <input ref={avatarPicker} type="file" hidden accept={avatarFormats.join(',')} onChange={event => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) setAvatarFile(file);
            }}/>
            <button type="button" className="secondary" onClick={() => avatarPicker.current?.click()}>{t("Выбрать изображение")}</button>
            {avatar && <button type="button" className="quiet" onClick={() => {
              if (!saveAvatar()) setSettingsError(t("Не удалось сохранить аватар."));
            }}>{t("Удалить аватар")}</button>}
          </div>
        </div>}
        {onboarding !== 1 && <div className="form-fields">{onboarding === 0 && <label>{t("Язык приложения")}<select value={language} onChange={event => void changeLanguage(event.target.value as 'ru' | 'en').catch(() => setSettingsError(t("Не удалось сохранить язык. Попробуйте снова.")))}><option value="ru">Русский</option><option value="en">English</option></select></label>}<label>{t("Никнейм")}<input value={nickname} onChange={event => setNickname(event.target.value)} maxLength={32} required placeholder={t("Как вас называть?")}/></label></div>}{onboarding === null && <p>{t("Никнейм обновляется и в открытой комнате.")}</p>}</div></section>}
      {settingsSection === 'language' && <section className="settings-card"><h1>{t("Язык")}</h1><div className="form-fields"><label>{t("Язык приложения")}<select value={language} onChange={event => void changeLanguage(event.target.value as 'ru' | 'en').catch(() => setSettingsError(t("Не удалось сохранить язык. Попробуйте снова.")))}><option value="ru">{t("Русский")}</option><option value="en">English</option></select></label></div></section>}
      {settingsPageId === 'system' && <section id="settings-anchor-general" className="settings-card settings-section"><h1>{t("Основные")}</h1>{autoStart !== null && <Toggle label={t("Запускать PawTalk при входе в Windows")} checked={autoStart} detail={autoStartAvailable ? undefined : t("Автозапуск доступен в установленном приложении Windows.")} disabled={autoStartBusy || !autoStartAvailable} onChange={value => void changeAutoStart(value)}/>} {autoStart !== null && <Toggle label={t("Запускать свёрнутым в трее")} detail={t("При автозапуске окно будет скрыто; открыть его можно через значок в трее.")} checked={startInTray} disabled={autoStartBusy || !autoStartAvailable || !autoStart} onChange={value => void changeStartInTray(value)}/>}</section>}
      {settingsSection === 'appearance' && <AppearanceSettings theme={theme} onChange={setTheme}/>}
      {settingsSection === 'chat' && <ChatSettings value={chatWindow} onChange={setChatWindow}/>}

      {['audio', 'system'].includes(settingsPageId) && <VoiceSettings section={settingsPageId === 'audio' ? 'audio' : 'shortcuts'} settings={settings} update={update} devices={devices} keys={keys} db={db} threshold={threshold} speaking={active && !testing ? snapshot.speaking : testSpeaking} active={active} busy={busy} testing={testing} testBusy={testBusy} ready={previewReady} native={native} keyError={keyError} onTest={() => void toggleTest()}/>}
      {settingsPageId === 'system' && <section id="settings-anchor-updates" className="settings-section"><UpdateSettings/></section>}
      {['audio', 'system'].includes(settingsPageId) && <footer className="settings-page-footer"><button type="button" className="quiet settings-reset" onClick={() => setSettings(current => settingsPageId === 'audio' ? resetSettingsTab(resetSettingsTab(current, 'voice'), 'sounds') : resetSettingsTab(current, 'shortcuts'))}>{t("Сбросить настройки вкладки")}</button></footer>}</SettingsShell>{onboarding !== null && <div className="modal-actions onboarding-actions"><button className="quiet" onClick={finishOnboarding}>{t("Настроить позже")}</button>{onboarding > 0 && <button className="secondary" onClick={() => { setOnboarding(onboarding - 1); setSettingsSection('profile'); }}>{t("Назад")}</button>}<button className="primary" disabled={!nickname.trim()} onClick={() => { if (onboarding === 2) finishOnboarding(); else { setOnboarding(onboarding + 1); setSettingsSection(onboarding === 1 ? 'voice' : 'profile'); } }}>{onboarding === 2 ? t("Готово") : t("Далее")}</button></div>}</Modal>}
      {modal === 'settings' && avatarFile && <AvatarEditor file={avatarFile} onClose={() => setAvatarFile(undefined)} onSave={saveAvatar}/>}
      {busy && <Modal title={t("Подключение к комнате")} className="connection-loading" onClose={() => {}}><div className="connection-progress" role="status" aria-live="polite" aria-busy="true"><span className="connection-spinner" aria-hidden="true"/><strong>{connectionStage === 'server' ? t("Связываемся с сервером…") : t("Подключаем голос и чат…")}</strong><p>{t("Это может занять несколько секунд.")}</p><progress aria-label={t("Подключение к комнате")}/></div></Modal>}
    </div>
    </main>
  </div>;
}
