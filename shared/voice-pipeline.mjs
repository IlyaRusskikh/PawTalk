import { VoiceGate } from './gate.mjs';

// 48 kHz mono: 10 ms model frames, 20 ms look-behind before the speech gate.
// Current-frame detection controls delayed audio to preserve initial consonants.
export class VoicePipeline {
  frame = new Float32Array(480); history = new Float32Array(960); output = new Float32Array(480);
  gate = new VoiceGate();
  filled = 0; historyIndex = 0; read = 0; write = 0; available = 0;
  key = ''; db = -100; speaking = false; probability = 0;
  pttPressed = false;
  automaticGain = 1;
  constructor(engine) { this.engine = engine; }
  reset() {
    this.frame.fill(0); this.history.fill(0); this.output.fill(0);
    this.filled = this.historyIndex = this.read = this.write = this.available = 0;
    this.gate.reset(); this.speaking = false; this.db = -100; this.probability = 0;
    this.automaticGain = 1;
  }
  process(input, output, state, time) {
    const settings = state.settings;
    const key = `${settings.noiseMode}|${settings.inputMode}|${state.muted}|${!!settings.autoGainControl}`;
    if (this.key !== key) { this.key = key; this.reset(); }
    if (settings.inputMode === 'ptt' && state.ptt && !this.pttPressed) this.reset();
    this.pttPressed = state.ptt;
    if (settings.inputMode === 'ptt' && !state.ptt && time >= this.gate.openUntil) { this.output.fill(0); this.available = 0; this.read = this.write; }
    const neural = settings.noiseMode === 'rnnoise';
    if (neural && !this.engine) { output.fill(0); return; } // Fail closed, never send unfiltered audio.
    for (let i = 0; i < output.length; i++) {
      this.frame[this.filled++] = input?.[i] || 0;
      if (this.filled === 480) {
        this.filled = 0;
        if (state.muted) this.frame.fill(0); // Do not retain muted microphone audio inside the model.
        const probability = neural ? this.engine.process(this.frame) : undefined;
        this.probability = probability ?? 0;
        let sum = 0;
        for (let j = 0; j < 480; j++) sum += (this.frame[j] * state.gain) ** 2;
        this.db = 20 * Math.log10(Math.max(0.00001, Math.sqrt(sum / 480)));
        this.speaking = this.gate.update(this.db, time + i / 48, settings, state.ptt, state.muted, probability);
        // Gate uses the original level so AGC cannot open it by amplifying noise.
        // Normalize only speech, with fast attenuation and slower amplification.
        const rms = Math.sqrt(sum / 480);
        if (settings.autoGainControl && this.speaking && rms > 0.003 && (probability === undefined || probability > 0.5)) {
          const target = Math.max(0.25, Math.min(8, 0.12 / rms));
          this.automaticGain += (target - this.automaticGain) * (target < this.automaticGain ? 0.3 : 0.025);
        } else if (!settings.autoGainControl) this.automaticGain = 1;
        const gain = state.gain * this.automaticGain;
        // Meter shows the transmitted speech level, while gating stays pre-AGC.
        if (this.speaking) this.db += 20 * Math.log10(this.automaticGain);
        for (let j = 0; j < 480; j++) {
          const delayed = settings.inputMode === 'ptt' ? this.frame[j] : this.history[this.historyIndex];
          this.history[this.historyIndex] = state.muted ? 0 : this.frame[j];
          this.historyIndex = (this.historyIndex + 1) % 960;
          this.output[this.write] = this.speaking && !state.muted ? Math.max(-1, Math.min(1, delayed * gain)) : 0;
          this.write = (this.write + 1) % 480; this.available++;
        }
      }
      output[i] = !state.muted && this.available ? this.output[this.read] : 0;
      if (this.available) { this.read = (this.read + 1) % 480; this.available--; }
    }
  }
}
