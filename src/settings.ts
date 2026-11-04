export interface Settings {
  inputDevice: string; outputDevice: string; inputGain: number; outputVolume: number;
  inputMode: 'voice' | 'ptt'; autoSensitivity: boolean; threshold: number; pttKey: number; pttReleaseMs: number;
  echoCancellation: boolean; nearbyVoiceSuppression: boolean; noiseMode: 'off' | 'standard' | 'rnnoise'; autoGainControl: boolean;
  muteKey: string; deafenKey: string; duckOwn: boolean; duckOthers: boolean; duckAmount: number; sounds: boolean;
}
export const defaults: Settings = {
  inputDevice: 'default', outputDevice: 'default', inputGain: 1, outputVolume: 1,
  inputMode: 'voice', autoSensitivity: true, threshold: -48, pttKey: 5, pttReleaseMs: 160,
  echoCancellation: true, nearbyVoiceSuppression: false, noiseMode: 'rnnoise', autoGainControl: true,
  muteKey: 'Control+Shift+M', deafenKey: 'Control+Shift+D', duckOwn: false, duckOthers: false, duckAmount: 50, sounds: true,
};
export function loadSettings(): Settings {
  const result = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem('voicecord.settings') || '{}');
    if (saved.noiseMode === undefined && saved.noiseSuppression === false) saved.noiseMode = 'off';
    for (const key of Object.keys(defaults) as (keyof Settings)[]) {
      if (typeof saved[key] === typeof defaults[key]) (result as unknown as Record<string, unknown>)[key] = saved[key];
    }
    if (!['ptt', 'voice'].includes(result.inputMode)) result.inputMode = 'voice';
    if (!['off', 'standard', 'rnnoise'].includes(result.noiseMode)) result.noiseMode = 'rnnoise';
    for (const [key, min, max] of [['inputGain', 0, 2], ['outputVolume', 0, 2], ['threshold', -80, -10], ['pttKey', 1, 254], ['pttReleaseMs', 0, 1000], ['duckAmount', 0, 100]] as const) {
      result[key] = Number.isFinite(result[key]) ? Math.min(max, Math.max(min, result[key])) : defaults[key];
    }
    result.pttKey = Math.round(result.pttKey);
  } catch { /* Corrupt preferences revert to safe defaults. */ }
  return result;
}
export function remember(settings: Settings) { localStorage.setItem('voicecord.settings', JSON.stringify(settings)); }
