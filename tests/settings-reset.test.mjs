import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, resetSettingsTab, settingsTabs } from '../src/settings.ts';

test('resetting a settings tab preserves all other tabs, including hidden input options', () => {
  const changed = { ...defaults, inputDevice: 'custom-mic', outputVolume: .4, inputMode: 'ptt', threshold: -30, pttReleaseMs: 800, noiseMode: 'off', echoCancellation: false, muteKey: 'Alt+M', duckAmount: 90, sounds: false, notificationVolume: .2, autoGainControl: false };
  for (const tab of Object.keys(settingsTabs)) {
    const reset = resetSettingsTab(changed, tab);
    for (const key of Object.keys(defaults)) assert.equal(reset[key], settingsTabs[tab].includes(key) ? defaults[key] : changed[key], `${tab}: ${key}`);
  }
});
