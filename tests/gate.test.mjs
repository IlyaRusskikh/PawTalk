import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceGate } from '../shared/gate.mjs';
const voice = { inputMode: 'voice', autoSensitivity: false, threshold: -45, pttReleaseMs: 160 };
test('voice threshold, hangover and hysteresis protect syllables', () => {
 const gate = new VoiceGate();
 assert.equal(gate.update(-65, 1000, voice, false, false), false);
 assert.equal(gate.update(-40, 1100, voice, false, false), true);
 assert.equal(gate.update(-70, 1200, voice, false, false), true);
 assert.equal(gate.update(-70, 1400, voice, false, false), false);
});
test('PTT blocks speech until held, then respects release delay', () => {
 const gate = new VoiceGate(); const settings = { ...voice, inputMode: 'ptt' };
 assert.equal(gate.update(0, 1000, settings, false, false), false);
 assert.equal(gate.update(-20, 1100, settings, true, false), true);
 assert.equal(gate.update(-20, 1200, settings, false, false), true);
 assert.equal(gate.update(-20, 1300, settings, false, false), false);
});
test('mute overrides PTT and immediately clears hangover', () => {
 const gate = new VoiceGate();
 gate.update(-20, 1000, voice, true, false);
 assert.equal(gate.update(-20, 1001, voice, true, true), false);
 assert.equal(gate.update(-80, 1002, voice, false, false), false);
});
test('automatic threshold opens on speech and closes on steady background', () => {
 const gate = new VoiceGate(); const settings = { ...voice, autoSensitivity: true };
 for(let i=0;i<1000;i++) gate.update(-60,i*10,settings,false,false);
 assert.equal(gate.update(-60,11000,settings,false,false), false);
 assert.equal(gate.update(-28,11010,settings,false,false), true);
});
test('switching from voice to PTT does not carry over an open voice gate', () => {
 const gate = new VoiceGate(); gate.update(-20,1000,voice,false,false);
 assert.equal(gate.update(-20,1001,{...voice,inputMode:'ptt'},false,false),false);
});
