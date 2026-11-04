import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EchoSuppressor } from '../shared/echo-suppressor.mjs';
import { VoicePipeline } from '../shared/voice-pipeline.mjs';

function speech(length, seed = 73) {
  const out = new Float32Array(length);
  let smooth = 0;
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    smooth = smooth * 0.85 + (seed / 2147483648) * 0.15;
    out[i] = smooth * (0.2 + 0.1 * Math.sin(i / 700));
  }
  return out;
}
function echoEnergy({ lag = 0, correlated = true, weaker = true, enabled = true } = {}) {
  const echo = new EchoSuppressor(), length = 48000;
  const voice = speech(length + 24000), other = speech(length + 24000, 101);
  const output = new Float32Array(128);
  let energy = 0;
  for (let pos = 0; pos < length; pos += 128) {
    const mic = new Float32Array(128), ref = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      mic[i] = (correlated ? voice : other)[pos + i + 12000] * (weaker ? 0.25 : 2);
      ref[i] = voice[pos + i + 12000 - lag];
    }
    echo.process(mic, ref, output, enabled);
    if (pos > 24000) energy += output.reduce((sum, value) => sum + value * value, 0);
  }
  return energy;
}
test('echo suppresses weaker correlated copies with acoustic and network delays', () => {
  for (const lag of [-4800, -960, 0, 1920, 3360]) {
    assert.ok(echoEnergy({ lag }) < echoEnergy({ lag, enabled: false }) * 0.01, `lag ${lag}`);
  }
});
test('echo retains independent speech and the louder original', () => {
  for (const options of [{ correlated: false }, { weaker: false }]) {
    const ratio = echoEnergy(options) / echoEnergy({ ...options, enabled: false });
    assert.ok(ratio > 0.8 && ratio < 1.2, `retained energy ${ratio}`);
  }
});
test('echo clears buffered speech on reset and can be disabled immediately', () => {
  const echo = new EchoSuppressor(), output = new Float32Array(128), signal = new Float32Array(128).fill(0.2);
  echo.process(signal, signal, output, true); echo.reset();
  for (let i = 0; i < 40; i++) { echo.process(new Float32Array(128), undefined, output, true); assert.ok(output.every(x => x === 0)); }
  echo.process(signal, undefined, output, false); assert.deepEqual(output, signal);
});
function automaticLevel(amplitude, automatic, muted = false, gain = 1) {
  const pipeline = new VoicePipeline();
  const state = { settings: { inputMode: 'ptt', noiseMode: 'off', autoGainControl: automatic, pttReleaseMs: 0 }, ptt: true, muted, gain };
  const input = new Float32Array(128), output = new Float32Array(128);
  let energy = 0, count = 0;
  for (let pos = 0; pos < 144000; pos += 128) {
    for (let i = 0; i < 128; i++) input[i] = amplitude * Math.sin((pos + i) * Math.PI / 60);
    pipeline.process(input, output, state, pos / 48);
    if (pos > 96000) { energy += output.reduce((sum, x) => sum + x * x, 0); count += output.length; }
  }
  return Math.sqrt(energy / count);
}
test('AGC raises quiet speech and reduces loud speech towards the same RMS', () => {
  assert.ok(automaticLevel(0.03, true) > automaticLevel(0.03, false) * 4);
  assert.ok(Math.abs(automaticLevel(0.03, true) - 0.12) < 0.01);
  assert.ok(Math.abs(automaticLevel(0.6, true) - 0.12) < 0.01);
});
test('AGC respects microphone mute, zero input gain and disabling', () => {
  assert.equal(automaticLevel(0.2, true, true), 0);
  assert.equal(automaticLevel(0.2, true, false, 0), 0);
  assert.ok(Math.abs(automaticLevel(0.2, false) - 0.2 / Math.sqrt(2)) < 0.001);
});
