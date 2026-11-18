import { t } from './i18n';
import { Icon, Slider, Toggle } from './Controls';
import { SensitivityMeter } from './SensitivityMeter';
import { playSound } from './sounds';
import type { Settings } from './settings';
import { audioDeviceLabel } from './audioDeviceLabel';
type Update = <K extends keyof Settings>(key: K, value: Settings[K]) => void;
interface Props {
  section: 'audio' | 'shortcuts';
  settings: Settings; update: Update; devices: MediaDeviceInfo[]; keys: [number,string][];
  db: number; threshold: number; speaking: boolean; active: boolean; busy: boolean;
  testing: boolean; testBusy: boolean; ready: boolean; native: boolean; keyError: string;
  onTest: () => void;
}
function MicBars({ db, testing }: { db: number; testing: boolean }) {
  const count = testing ? Math.round(Math.max(0, Math.min(1, (db + 60) / 60)) * 64) : 0;
  return <div className="mic-bars" data-active={testing} role="meter" aria-label={t("Уровень микрофона")} aria-valuemin={-80} aria-valuemax={0} aria-valuenow={testing ? Math.max(-80, Math.min(0, Math.round(db))) : -80}>
    {Array.from({ length: 64 }, (_, index) => <i key={index} className={index < count ? 'lit' : ''}/>)}
  </div>;
}
export function VoiceSettings(p: Props) {
  const { settings: s, update, devices } = p;
  const systemName = (kind: MediaDeviceKind) => audioDeviceLabel(devices.find(device => device.kind === kind && device.deviceId === 'default')?.label.replace(/^(default|по умолчанию)\s*[-–—:]\s*/i, '') ?? '') || (kind === 'audioinput' ? t("Системный микрофон") : t("Системное устройство"));
  return <div className="settings-stack">
    {p.section === 'audio' && <>
      <section id="settings-anchor-voice" className="settings-section settings-page"><section className="settings-card voice-settings"><h1>{t("Голос")}</h1>
      <div className="form-grid">
        <label>{t("Микрофон")}<div className="device-select"><Icon name="mic"/><select aria-label={t("Микрофон")} value={s.inputDevice} onChange={event => update('inputDevice', event.target.value)}><option value="default">Windows ({systemName('audioinput')})</option>{devices.filter(d => d.kind === 'audioinput' && !['default','communications'].includes(d.deviceId)).map((d,i) => <option key={d.deviceId} value={d.deviceId}>{audioDeviceLabel(d.label) || t("Микрофон {0}", i+1)}</option>)}</select></div></label>
        <label>{t("Динамик")}<div className="device-select"><Icon name="headphones"/><select aria-label={t("Динамик")} value={s.outputDevice} onChange={event => update('outputDevice', event.target.value)}><option value="default">Windows ({systemName('audiooutput')})</option>{devices.filter(d => d.kind === 'audiooutput' && !['default','communications'].includes(d.deviceId)).map((d,i) => <option key={d.deviceId} value={d.deviceId}>{audioDeviceLabel(d.label) || t("Динамик {0}", i+1)}</option>)}</select></div></label>
        <Slider label={t("Громкость микрофона")} value={s.inputGain} min={0} max={2} step={0.05} format={`${Math.round(s.inputGain*100)}%`} onChange={value => update('inputGain',value)}/>
        <Slider label={t("Громкость динамика")} value={s.outputVolume} min={0} max={2} step={0.05} format={`${Math.round(s.outputVolume*100)}%`} onChange={value => update('outputVolume',value)}/>
      </div>
      <div className="mic-test-row"><button className="mic-test-button" disabled={p.busy || p.testBusy || !p.ready} aria-pressed={p.testing} aria-busy={p.testBusy} onClick={p.onTest}>{p.testing ? t("Прекратить проверку") : t("Проверка микрофона")}</button><div className="mic-test-output"><MicBars db={p.db} testing={p.testing}/>{p.testing && <small>{t("Воспроизводим ваш прекрасный голос")}</small>}</div></div>
      {p.testing && <p className="host-hint">{t("Проверяйте в наушниках. При прослушивании эхоподавление временно отключено, чтобы не подавлять ваш собственный голос.")}</p>}
    </section>
<section className="settings-card input-settings"><h2>{t("Режим ввода")}</h2>
      <div className="segments" role="group" aria-label={t("Режим ввода")}><button aria-pressed={s.inputMode === 'voice'} className={s.inputMode === 'voice' ? 'chosen' : ''} onClick={() => update('inputMode','voice')}>{t("Активация голосом")}</button><button aria-pressed={s.inputMode === 'ptt'} className={s.inputMode === 'ptt' ? 'chosen' : ''} onClick={() => update('inputMode','ptt')}>Push-to-Talk</button></div>
      {s.inputMode === 'voice' ? <><Toggle label={t("Автоматически определять чувствительность ввода")} detail={t("Контролирует чувствительность к звукам вашего микрофона.")} checked={s.autoSensitivity} onChange={value => update('autoSensitivity',value)}/><SensitivityMeter db={p.db} threshold={p.threshold} speaking={p.speaking} available={p.active || p.ready} automatic={s.autoSensitivity} onChange={value => update('threshold',value)}/></> : <div className="form-grid"><label>{t("Клавиша передачи")}<select value={s.pttKey} onChange={event => update('pttKey',Number(event.target.value))}>{p.keys.map(([code,name]) => <option key={code} value={code}>{name}</option>)}</select></label><Slider label={t("Задержка отпускания")} value={s.pttReleaseMs} min={0} max={1000} step={20} format={t("{0} мс", s.pttReleaseMs)} onChange={value => update('pttReleaseMs',value)}/></div>}
    </section>
<section className="settings-card processing-settings"><h2>{t("Обработка голоса")}</h2>
      <div className="noise-mode-row"><div><strong>{t("Шумоподавление")}</strong><small>{t("Уменьшает фоновые шумы микрофона.")}</small></div><select aria-label={t("Режим шумоподавления")} value={s.noiseMode} onChange={event => update('noiseMode',event.target.value as Settings['noiseMode'])}><option value="off">{t("Выключено")}</option><option value="standard">{t("Стандартное")}</option><option value="rnnoise">RNNoise</option></select></div>
      <Toggle label={t("Эхоподавление")} detail={t("Уменьшает эхо от динамиков")} checked={s.echoCancellation} onChange={value => update('echoCancellation',value)}/>
      <details className="settings-advanced"><summary>{t("Расширенные настройки голоса")}</summary><div className="settings-advanced-body">
      <Toggle label={t("Автоматическое усиление")} detail={t("Выравнивает уровень тихой и громкой речи")} checked={s.autoGainControl} onChange={value => update('autoGainControl',value)}/>
      <Toggle label={t("Подавлять голос собеседника рядом")} detail={t("Для участников рядом с вашим микрофоном. Добавляет 80 мс задержки; обычно можно оставить выключенным.")} checked={s.nearbyVoiceSuppression} onChange={value => update('nearbyVoiceSuppression',value)}/>
      <h3>{t("Глобальное приглушение звука")}</h3><p>{t("Снижает громкость других приложений, когда кто-то говорит.")}</p>
      <Slider label={t("Сила приглушения")} value={s.duckAmount} min={0} max={100} format={`${s.duckAmount}%`} onChange={value => update('duckAmount',value)}/>
      <Toggle label={t("Приглушать, когда говорю я")} disabled={!p.native} checked={s.duckOwn} onChange={value => update('duckOwn',value)}/>
      <Toggle label={t("Приглушать, когда говорят другие")} disabled={!p.native} checked={s.duckOthers} onChange={value => update('duckOthers',value)}/>

      </div></details>
    </section></section>
      <section id="settings-anchor-sounds" className="settings-section"><section className="settings-card"><h1>{t("Звуки")}</h1>
      <Toggle label={t("Звуковые уведомления")} detail={t("Мяуканье при входе и выходе, мурлыканье для новых сообщений вне просмотра.")} checked={s.sounds} onChange={value => update('sounds',value)}/>
      <div className="form-fields notification-settings">
        <Slider label={t("Громкость звуковых уведомлений")} value={s.notificationVolume} min={0} max={1} step={0.01} format={Math.round(s.notificationVolume * 100) + '%'} onChange={value => update('notificationVolume', value)}/>
        <div className="notification-previews">
        <button type="button" disabled={!s.sounds} onClick={() => void playSound('join', s)}>{t("Послушать мяуканье")}</button>
        <button type="button" disabled={!s.sounds} onClick={() => void playSound('message', s)}>{t("Послушать мурчание")}</button>
        </div>
      </div>
    </section></section>
    </>}
    {p.section === 'shortcuts' && <section id="settings-anchor-shortcuts" className="settings-section"><section className="settings-card"><h1>{t("Сочетания клавиш")}</h1>
      <div className="form-fields shortcut-fields"><label>{t("Включить / выключить микрофон")}<input aria-label={t("Включить / выключить микрофон")} value={s.muteKey} onChange={event => update('muteKey',event.target.value)} placeholder="Control+Shift+M"/></label><label>{t("Включить / выключить весь звук")}<input aria-label={t("Включить / выключить весь звук")} value={s.deafenKey} onChange={event => update('deafenKey',event.target.value)} placeholder="Control+Shift+D"/></label></div>
      {p.keyError && <p role="alert" className="text-error">{p.keyError}</p>}
    </section></section>}
  </div>;
}
