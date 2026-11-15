import { useEffect, useRef, useState } from 'react';
import { Microphone } from './audio';
import { AppearanceSettings } from './AppearanceSettings';
import { Avatar } from './Avatar';
import { AvatarEditor } from './AvatarEditor';
import { avatarStorageKey,validAvatar } from './avatarImage';
import { ChatSettings, loadChatWindow } from './ChatSettings';
import { Toggle } from './Controls';
import { changeLanguage, t, useLanguage } from './i18n';
import { Modal } from './Modal';
import { SettingsShell, settingsPage, type SettingsSection } from './SettingsShell';
import { resetSettingsTab, type Settings } from './settings';
import { applyTheme, loadTheme } from './theme';
import { UpdateSettings } from './UpdateSettings';
import { VoiceSettings } from './VoiceSettings';
import type { Snapshot } from './session';
import { membership, profileFor, type ServerState } from './membership';

export function MemberSettings({ settings, setSettings, state, nickname, onNickname, onClose, onRefresh, native, keyError, active, voiceMic,voiceSnapshot, wizard=false }: {
  settings: Settings; setSettings(value: Settings): void; state?: ServerState; nickname: string; onNickname(value: string): void; onClose(): void; onRefresh(): void; native: boolean; keyError: string; active: boolean;voiceMic?:Microphone;voiceSnapshot:Snapshot;wizard?:boolean;
}) {
  const language = useLanguage(), [section, setSection] = useState<SettingsSection>('profile'), [theme, setTheme] = useState(loadTheme), [chatWindow, setChatWindow] = useState(loadChatWindow);
  const own = state && profileFor(state, state.self.effectiveProfileId);
  const [step,setStep]=useState(0);
  const [name, setName] = useState(own?.nickname || nickname), [avatar, setAvatar] = useState<string|null|undefined>(()=>{const value=localStorage.getItem(avatarStorageKey)||'';return own?.avatar||(state?undefined:validAvatar(value)?value:undefined);}), [file, setFile] = useState<File>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [devices, setDevices] = useState<MediaDeviceInfo[]>([]), [testing, setTesting] = useState(false), [ready, setReady] = useState(false);
  const [meter, setMeter] = useState({ db: -100, speaking: false, threshold: settings.threshold }), [autoStart, setAutoStart] = useState<boolean>(), [tray, setTray] = useState(false), [autoAvailable, setAutoAvailable] = useState(false);
  const mic = useRef<Microphone | undefined>(undefined), picker = useRef<HTMLInputElement>(null), current = useRef(settings); current.current = settings;
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings({ ...settings, [key]: value });
  useEffect(() => { applyTheme(theme); localStorage.setItem('pawtalk.theme', JSON.stringify(theme)); }, [theme]);
  useEffect(() => { localStorage.setItem('pawtalk.chat.window', String(chatWindow)); }, [chatWindow]);
  useEffect(() => {
    void window.desktop?.getAutoStart?.().then(setAutoStart).catch(error => setError(error.message));
    void window.desktop?.getStartInTray?.().then(setTray).catch(error => setError(error.message));
    void window.desktop?.capabilities().then(value => setAutoAvailable(value.platform === 'win32' && value.packaged));
  }, []);
  useEffect(() => {
    if (settingsPage(section) !== 'audio') return;
    if(active){mic.current=voiceMic;void navigator.mediaDevices.enumerateDevices().then(setDevices).catch(()=>{});return()=>{voiceMic?.stopMonitor();mic.current=undefined;setTesting(false);};}
    let alive = true; const preview = new Microphone(current.current);preview.muted=false; mic.current = preview;
    preview.onMeter = (db, speaking, threshold) => { if (alive) setMeter({ db, speaking, threshold }); };
    preview.onError = message => { if (alive) setError(message); };
    preview.onEnded = () => { if (alive) { setReady(false); setTesting(false); setError(t('Микрофон отключён. Выберите доступное устройство.')); } };
    void preview.start().then(async () => { if (!alive) { preview.stop(); return; } await preview.configure(current.current); if (alive) { setReady(true); setDevices(await navigator.mediaDevices.enumerateDevices()); } }).catch(error => { if (alive) setError(error.message); });
    return () => { alive = false; preview.stop(); mic.current = undefined; setTesting(false); setReady(false); };
  }, [settingsPage(section), active,voiceMic]);
  useEffect(() => { if(!active)void mic.current?.configure(settings).catch(error => setError(error.message)); }, [settings,active]);
  useEffect(()=>window.desktop?.onPtt(down=>{if(!active)mic.current?.update(current.current,false,down);}),[active]);
  async function save() {
    setBusy(true); setError('');
    try { if (state) await membership('profile', { serverId: state.serverId, nickname: name.trim(), avatar, expectedRevision: own?.revision }); else {onNickname(name.trim()||t('Гость'));if(avatar)localStorage.setItem(avatarStorageKey,avatar);else localStorage.removeItem(avatarStorageKey);} onRefresh();return true; }
    catch (error) { setError((error as Error).message);return false; } finally { setBusy(false); }
  }
  const keys: [number, string][] = [[5, t('Боковая кнопка мыши 4')], [6, t('Боковая кнопка мыши 5')], [32, t('Пробел')], [162, t('Левый Ctrl')], [164, t('Левый Alt')], [160, t('Левый Shift')], ...Array.from({ length: 26 }, (_, index) => [65 + index, String.fromCharCode(65 + index)] as [number, string]), ...Array.from({ length: 12 }, (_, index) => [112 + index, `F${index + 1}`] as [number, string])];
  const advancing=useRef(false);
  async function nextStep(){if(busy||advancing.current||!name.trim())return;advancing.current=true;try{if(!await save())return;if(step===2)onClose();else{setStep(step+1);setSection(step===1?'voice':'profile');}}finally{advancing.current=false;}}
  const finish=async()=>{if(await save())onClose();};
  return <Modal onKeyDown={event=>{if(!wizard||file||event.key!=='Enter'||event.repeat||event.nativeEvent.isComposing||event.nativeEvent.keyCode===229)return;const target=event.target as HTMLElement;if(target.closest('button,select,textarea')||target instanceof HTMLInputElement&&(step!==0||target.type!=='text'))return;event.preventDefault();void nextStep();}} title={wizard?t('Добро пожаловать в PawTalk'):t('Настройки')} onClose={()=>{if(wizard)void finish();else onClose();}} className={wizard?'settings-modal onboarding-modal':'settings-modal'}>{wizard&&<div className="onboarding-progress"><p>{t('Шаг {0} из 3',step+1)}</p><p>{[t('Как вас называть? Выберите язык приложения и никнейм.'),t('Добавьте аватарку — или оставьте инициалы.'),t('Выберите устройства и проверьте микрофон в наушниках.')][step]}</p></div>}<SettingsShell wizard={wizard} section={section} onChange={setSection}>
    {error && <p className="text-error" role="alert">{error}</p>}
    {section === 'profile' && <section className="settings-card settings-page"><h1>{state ? t('Профиль на сервере') : t('Обо мне')}</h1><div className="form-fields">{(!wizard||step===1)&&<><div className="member-profile-preview"><Avatar name={name} image={avatar || undefined}/><button onClick={() => picker.current?.click()}>{t('Изменить аватар')}</button>{avatar && <button onClick={() => setAvatar(null)}>{t('Удалить аватар')}</button>}</div><input hidden type="file" ref={picker} accept="image/png,image/jpeg,image/webp" onChange={event => { setFile(event.target.files?.[0]); event.target.value = ''; }}/></>}{(!wizard||step===0)&&<>{wizard&&<label>{t('Язык приложения')}<select value={language} onChange={event=>void changeLanguage(event.target.value as 'ru'|'en').catch(error=>setError(error.message))}><option value="ru">Русский</option><option value="en">English</option></select></label>}<label>{t('Имя пользователя')}<input maxLength={32} value={name} onChange={event => setName(event.target.value)}/></label></>}{state && <label>{t('ID профиля')}<input readOnly value={state.self.effectiveProfileId} onFocus={event => event.target.select()}/></label>}</div>{!wizard&&<div className="modal-actions"><button className="primary" disabled={busy || !name.trim()} onClick={() => void save()}>{t('Сохранить')}</button></div>}</section>}
    {['audio', 'system'].includes(settingsPage(section)) && <>
      {settingsPage(section) === 'system' && <section id="settings-anchor-general" className="settings-section settings-card settings-page"><h1>{t('Основные')}</h1><Toggle label={t('Запускать вместе с Windows')} checked={!!autoStart} disabled={!autoAvailable} onChange={value => void window.desktop?.setAutoStart?.(value).then(setAutoStart).catch(error => setError(error.message))}/><Toggle label={t('Запускать в трее')} checked={tray} onChange={value => void window.desktop?.setStartInTray?.(value).then(setTray).catch(error => setError(error.message))}/></section>}
      <VoiceSettings section={settingsPage(section) === 'audio' ? 'audio' : 'shortcuts'} settings={settings} update={update} devices={devices} keys={keys} {...(active?{db:voiceSnapshot.db,speaking:voiceSnapshot.speaking,threshold:voiceSnapshot.threshold??settings.threshold}:meter)} active={active} busy={false} testing={testing} testBusy={busy} ready={active?voiceSnapshot.state==='connected'&&!!voiceMic:ready} native={native} keyError={keyError} onTest={() => {
        if (testing) { mic.current?.stopMonitor(); setTesting(false); return; }
        setBusy(true); void mic.current?.startMonitor().then(() => setTesting(true)).catch(error => setError(error.message)).finally(() => setBusy(false));
      }}/>
      {settingsPage(section) === 'audio' && <div className="settings-page-footer"><button className="settings-reset" onClick={() => setSettings(resetSettingsTab(settings, section === 'sounds' ? 'sounds' : 'voice'))}>{t('Сбросить настройки раздела')}</button></div>}
      {settingsPage(section) === 'system' && <section id="settings-anchor-updates" className="settings-section settings-page"><UpdateSettings/></section>}
    </>}
    {section === 'appearance' && <AppearanceSettings theme={theme} onChange={setTheme}/>}
    {section === 'chat' && <ChatSettings value={chatWindow} onChange={setChatWindow}/>}
    {section === 'language' && <section className="settings-card settings-page"><h1>{t('Язык')}</h1><label>{t('Язык приложения')}<select value={language} onChange={event => void changeLanguage(event.target.value as 'ru'|'en')}><option value="ru">Русский</option><option value="en">English</option></select></label></section>}
  </SettingsShell>{wizard&&<div className="modal-actions onboarding-actions"><button disabled={busy} className="quiet" onClick={()=>void finish()}>{t('Настроить позже')}</button>{step>0&&<button disabled={busy} onClick={()=>{setStep(step-1);setSection('profile');}}>{t('Назад')}</button>}<button disabled={busy||!name.trim()} className="primary" onClick={()=>void nextStep()}>{step===2?t('Готово'):t('Далее')}</button></div>}{file && <AvatarEditor file={file} onClose={() => setFile(undefined)} onSave={value => { setAvatar(value); setFile(undefined); return true; }}/>}</Modal>;
}
