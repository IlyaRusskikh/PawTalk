import { RnnoiseEngine } from '../shared/rnnoise.mjs';
import { VoicePipeline } from '../shared/voice-pipeline.mjs';
import { EchoSuppressor } from '../shared/echo-suppressor.mjs';
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor { port: MessagePort; }
declare function registerProcessor(name: string, constructor: typeof AudioWorkletProcessor): void;
class GateProcessor extends AudioWorkletProcessor {
  engine?: RnnoiseEngine;
  pipeline: VoicePipeline;
  echo = new EchoSuppressor();
  cleaned = new Float32Array(128);
  previousPtt = false;
  state = { settings: { inputMode: 'voice', noiseMode: 'off', autoSensitivity: true, threshold: -48, pttReleaseMs: 160, echoCancellation: false, nearbyVoiceSuppression: false }, ptt: false, muted: true, gain: 1 };
  lastReport = 0; destroyed = false; failed = false;
  constructor(options?: { processorOptions?: { rnnoiseModule?: WebAssembly.Module } }) {
    super();
    if (sampleRate !== 48000) throw new Error('Voicecord requires 48 kHz audio');
    const module = options?.processorOptions?.rnnoiseModule;
    if (module) this.engine = new RnnoiseEngine(module);
    this.pipeline = new VoicePipeline(this.engine);
    this.port.onmessage = event => {
      if (event.data.type === 'destroy') { this.destroyed = true; this.engine?.destroy(); this.pipeline.reset(); this.echo.reset(); }
      else this.state = event.data;
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const output = outputs[0]?.[0];
    if (!output) return !this.destroyed;
    if (this.destroyed || this.failed) { output.fill(0); return false; }
    try {
      if (this.state.settings.inputMode === 'ptt' && this.state.ptt && !this.previousPtt) this.echo.reset();
      this.previousPtt = this.state.ptt;
      if (this.cleaned.length !== output.length) this.cleaned = new Float32Array(output.length);
      if (this.state.muted) { this.echo.reset(); this.cleaned.fill(0); }
      else this.echo.process(inputs[0]?.[0] ?? this.cleaned.fill(0), inputs[1]?.[0], this.cleaned, this.state.settings.nearbyVoiceSuppression && !!inputs[1]?.[0]);
      this.pipeline.process(this.cleaned, output, this.state, currentTime * 1000);
    }
    catch { this.failed = true; output.fill(0); this.port.postMessage({ error: 'Ошибка нейросетевой обработки микрофона. Перезапустите подключение.' }); return false; }
    if (currentTime - this.lastReport >= 0.05) {
      this.port.postMessage({ db: this.pipeline.db, speaking: this.pipeline.speaking, threshold: this.pipeline.gate.getThreshold(this.state.settings), probability: this.pipeline.probability, sampleRate });
      this.lastReport = currentTime;
    }
    return true;
  }
}
registerProcessor('voicecord-gate', GateProcessor);
