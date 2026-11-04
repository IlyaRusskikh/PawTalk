import { Icon, Slider, Toggle } from './Controls';
import { SensitivityMeter } from './SensitivityMeter';
import type { Settings } from './settings';
type Update = <K extends keyof Settings>(key: K, value: Settings[K]) => void;
interface Props {
  settings: Settings; update: Update; devices: MediaDeviceInfo[]; keys: [number,string][];
  db: number; threshold: number; speaking: boolean; active: boolean; busy: boolean;
  testing: boolean; testBusy: boolean; ready: boolean; native: boolean; keyError: string;
  onTest: () => void; onReset: () => void;
}
function MicBars({ db, testing }: { db: number; testing: boolean }) {
  const count = testing ? Math.round(Math.max(0, Math.min(1, (db + 60) / 60)) * 64) : 0;
  return <div className="mic-bars" data-active={testing} role="meter" aria-label="Уровень микрофона" aria-valuemin={-80} aria-valuemax={0} aria-valuenow={testing ? Math.max(-80, Math.min(0, Math.round(db))) : -80}>
    {Array.from({ length: 64 }, (_, index) => <i key={index} className={index < count ? 'lit' : ''}/>)}
  </div>;
}
export function VoiceSettings(p: Props) {
  const { settings: s, update, devices } = p;
  const systemName = (kind: MediaDeviceKind) => devices.find(device => device.kind === kind && device.deviceId === 'default')?.label.replace(/^(default|по умолчанию)\s*[-–—:]\s*/i, '') || (kind === 'audioinput' ? 'Системный микрофон' : 'Системное устройство');
  return <div className="settings-page">
    <section className="settings-card voice-settings"><h1>Голос</h1>
      <div className="form-grid">
        <label>Микрофон<div className="device-select"><Icon name="mic"/><select aria-label="Микрофон" value={s.inputDevice} onChange={event => update('inputDevice', event.target.value)}><option value="default">Windows ({systemName('audioinput')})</option>{devices.filter(d => d.kind === 'audioinput' && !['default','communications'].includes(d.deviceId)).map((d,i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Микрофон ${i+1}`}</option>)}</select></div></label>
        <label>Динамик<div className="device-select"><Icon name="headphones"/><select aria-label="Динамик" value={s.outputDevice} onChange={event => update('outputDevice', event.target.value)}><option value="default">Windows ({systemName('audiooutput')})</option>{devices.filter(d => d.kind === 'audiooutput' && !['default','communications'].includes(d.deviceId)).map((d,i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Динамик ${i+1}`}</option>)}</select></div></label>
        <Slider label="Громкость микрофона" value={s.inputGain} min={0} max={2} step={0.05} format={`${Math.round(s.inputGain*100)}%`} onChange={value => update('inputGain',value)}/>
        <Slider label="Громкость динамика" value={s.outputVolume} min={0} max={2} step={0.05} format={`${Math.round(s.outputVolume*100)}%`} onChange={value => update('outputVolume',value)}/>
      </div>
      <div className="mic-test-row"><button className="mic-test-button" disabled={p.busy || p.testBusy || !p.ready} aria-pressed={p.testing} aria-busy={p.testBusy} onClick={p.onTest}>{p.testing ? 'Прекратить проверку' : 'Проверка микрофона'}</button><div className="mic-test-output"><MicBars db={p.db} testing={p.testing}/>{p.testing && <small>Воспроизводим ваш прекрасный голос</small>}</div></div>
      {p.testing && <p className="host-hint">Проверяйте в наушниках. При прослушивании эхоподавление временно отключено, чтобы не подавлять ваш собственный голос.</p>}
    </section>
    <section className="settings-card input-settings"><h2>Режим ввода</h2>
      <div className="segments"><button className={s.inputMode === 'voice' ? 'chosen' : ''} onClick={() => update('inputMode','voice')}>Активация голосом</button><button className={s.inputMode === 'ptt' ? 'chosen' : ''} onClick={() => update('inputMode','ptt')}>Push-to-Talk</button></div>
      {s.inputMode === 'voice' ? <><Toggle label="Автоматически определять чувствительность ввода" detail="Контролирует чувствительность к звукам вашего микрофона." checked={s.autoSensitivity} onChange={value => update('autoSensitivity',value)}/><SensitivityMeter db={p.db} threshold={p.threshold} speaking={p.speaking} available={p.active || p.ready} automatic={s.autoSensitivity} onChange={value => update('threshold',value)}/></> : <div className="form-grid"><label>Клавиша передачи<select value={s.pttKey} onChange={event => update('pttKey',Number(event.target.value))}>{p.keys.map(([code,name]) => <option key={code} value={code}>{name}</option>)}</select></label><Slider label="Задержка отпускания" value={s.pttReleaseMs} min={0} max={1000} step={20} format={`${s.pttReleaseMs} мс`} onChange={value => update('pttReleaseMs',value)}/></div>}
    </section>
    <section className="settings-card processing-settings"><h2>Обработка голоса</h2>
      <div className="noise-mode-row"><div><strong>Шумоподавление</strong><small>Уменьшает фоновые шумы микрофона.</small></div><select aria-label="Режим шумоподавления" value={s.noiseMode} onChange={event => update('noiseMode',event.target.value as Settings['noiseMode'])}><option value="off">Выключено</option><option value="standard">Стандартное</option><option value="rnnoise">RNNoise</option></select></div>
      <Toggle label="Эхоподавление" detail="Уменьшает эхо от динамиков" checked={s.echoCancellation} onChange={value => update('echoCancellation',value)}/>
      <Toggle label="Автоматическое усиление" detail="Выравнивает уровень тихой и громкой речи" checked={s.autoGainControl} onChange={value => update('autoGainControl',value)}/>
      <Toggle label="Подавлять голос собеседника рядом" detail="Для участников рядом с вашим микрофоном. Добавляет 80 мс задержки; обычно можно оставить выключенным." checked={s.nearbyVoiceSuppression} onChange={value => update('nearbyVoiceSuppression',value)}/>
    </section>
    <section className="settings-card"><h2>Другие приложения и сочетания клавиш</h2>
      <Toggle label="Приглушать, когда говорю я" disabled={!p.native} checked={s.duckOwn} onChange={value => update('duckOwn',value)}/>
      <Toggle label="Приглушать, когда говорят другие" disabled={!p.native} checked={s.duckOthers} onChange={value => update('duckOthers',value)}/>
      <Slider label="Сила приглушения" value={s.duckAmount} min={0} max={100} format={`${s.duckAmount}%`} onChange={value => update('duckAmount',value)}/>
      <div className="form-grid"><label>Включить / выключить микрофон<input value={s.muteKey} onChange={event => update('muteKey',event.target.value)} placeholder="Control+Shift+M"/></label><label>Включить / выключить весь звук<input value={s.deafenKey} onChange={event => update('deafenKey',event.target.value)} placeholder="Control+Shift+D"/></label></div>
      {p.keyError && <p role="alert" className="text-error">{p.keyError}</p>}
      <Toggle label="Звуки подключения" checked={s.sounds} onChange={value => update('sounds',value)}/>
    </section>
    <button className="quiet" onClick={p.onReset}>Сбросить настройки звука</button>
  </div>;
}
