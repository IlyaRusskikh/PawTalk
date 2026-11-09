import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioDeviceLabel } from '../src/audioDeviceLabel.ts';

test('audio device names hide trailing USB IDs while preserving model names', () => {
  assert.equal(audioDeviceLabel('Микрофон (fifine Microphone) (3142:a010)'), 'Микрофон (fifine Microphone)');
  assert.equal(audioDeviceLabel('Microphone (USB Audio) (ABCD:0123) '), 'Microphone (USB Audio)');
  for (const label of ['', 'Microphone (USB Audio)', 'Speakers (Realtek(R) Audio)', 'Microphone (Model 1234)']) {
    assert.equal(audioDeviceLabel(label), label);
  }
});
