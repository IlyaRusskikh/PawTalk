import type { Settings } from './settings';
import workletURL from './gate-worklet.ts?worker&url';
import rnnoiseURL from './generated/rnnoise.wasm?url';

let compiledModel: Promise<WebAssembly.Module> | undefined;
function loadModel() {
  return compiledModel ??= fetch(rnnoiseURL).then(response => {
    if (!response.ok) throw new Error('Не удалось загрузить локальную модель RNNoise');
    return response.arrayBuffer();
  }).then(binary => WebAssembly.compile(binary)).catch(error => { compiledModel = undefined; throw error; });
}

export class Microphone {
  context?: AudioContext;
  stream?: MediaStream;
  destination?: MediaStreamAudioDestinationNode;
  node?: AudioWorkletNode;
  source?: MediaStreamAudioSourceNode;
  private monitorGain?: GainNode;
  private monitorGeneration = 0;
  private references = new Map<string, MediaStreamAudioSourceNode>();
  private configuration = Promise.resolve();
  private stopped = false;
  private capturedSettings?: Settings;
  private capturedEchoCancellation = false;
  private activeNoiseMode: Settings['noiseMode'];
  settings: Settings;
  muted = true; ptt = false; testing = false;
  onMeter: (db: number, speaking: boolean, threshold: number) => void = () => {};
  onEnded: () => void = () => {};
  onError: (message: string) => void = () => {};
  constructor(settings: Settings, private sharedContext?: AudioContext) { this.settings = settings; this.activeNoiseMode = settings.noiseMode; }
  async start() {
    try {
      const capturedSettings = { ...this.settings };
      this.stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: {
        deviceId: this.settings.inputDevice === 'default' ? undefined : { exact: this.settings.inputDevice },
        echoCancellation: this.settings.echoCancellation, noiseSuppression: this.settings.noiseMode === 'standard',
        autoGainControl: false, channelCount: 1, sampleRate: 48000,
      } });
      if (this.stopped) { this.stream.getTracks().forEach(track => track.stop()); this.stream = undefined; return; }
      this.capturedSettings = capturedSettings;
      this.capturedEchoCancellation = capturedSettings.echoCancellation;
      this.context = this.sharedContext ?? new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      await this.context.audioWorklet.addModule(workletURL);
      const module = await loadModel();
      if (this.stopped) { this.stop(); return; }
      this.source = this.context.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.context, 'voicecord-gate', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', processorOptions: { rnnoiseModule: module } });
      this.destination = this.context.createMediaStreamDestination();
      this.source.connect(this.node).connect(this.destination);
      this.node.port.onmessage = event => {
        if (event.data.error) { this.track.enabled = false; this.onError(event.data.error); }
        else this.onMeter(event.data.db, event.data.speaking, event.data.threshold);
      };
      this.stream.getTracks().forEach(track => { track.onended = () => this.onEnded(); });
      this.update(this.settings, this.muted, this.ptt);
      await this.context.resume();
      await this.configure(this.settings);
    } catch (error) { this.stop(); throw error; }
  }
  get track() { if (!this.destination) throw new Error('Микрофон не запущен'); return this.destination.stream.getAudioTracks()[0]; }
  update(settings: Settings, muted: boolean, ptt: boolean) {
    this.settings = settings; this.muted = muted; this.ptt = ptt;
    if (this.destination) this.track.enabled = !muted || this.testing;
    this.node?.port.postMessage({ settings: { ...settings, noiseMode: this.activeNoiseMode }, muted, ptt, gain: settings.inputGain, test: this.testing });
    if (this.monitorGain) this.monitorGain.gain.value = settings.outputVolume;
  }
  configure(settings: Settings) {
    const previous = this.settings;
    this.update(settings, this.muted, this.ptt);
    const apply = this.configuration.catch(() => {}).then(async () => {
      if (this.stopped || !this.stream || !this.destination) return;
      const captured = this.capturedSettings || previous;
      // AEC must not use local microphone monitoring as its playback reference:
      // the reference is the user's own speech and can cancel the wanted voice.
      const echoCancellation = settings.echoCancellation && !this.testing;
      const switchingNoise = captured.noiseMode !== settings.noiseMode;
      if (switchingNoise) {
        this.track.enabled = false;
        this.node?.port.postMessage({ settings: this.settings, muted: true, ptt: false, gain: settings.inputGain });
      }
      try {
      // Chromium can accept applyConstraints while keeping the old processing
      // settings (observed for AEC and noise suppression). Reacquire only the
      // capture source; the worklet, monitor and published track stay alive.
      if (captured.inputDevice !== settings.inputDevice || this.capturedEchoCancellation !== echoCancellation || (captured.noiseMode === 'standard') !== (settings.noiseMode === 'standard')) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: {
          deviceId: settings.inputDevice === 'default' ? undefined : { exact: settings.inputDevice },
          echoCancellation, noiseSuppression: settings.noiseMode === 'standard',
          autoGainControl: false, channelCount: 1, sampleRate: 48000,
        } });
        if (this.stopped) { stream.getTracks().forEach(track => track.stop()); return; }
        const source = this.context!.createMediaStreamSource(stream);
        source.connect(this.node!);
        this.source?.disconnect();
        this.stream.getTracks().forEach(track => { track.onended = null; track.stop(); });
        this.source = source; this.stream = stream;
        stream.getTracks().forEach(track => { track.onended = () => this.onEnded(); });
      }
      this.capturedSettings = { ...settings };
      this.capturedEchoCancellation = echoCancellation;
      this.activeNoiseMode = settings.noiseMode;
      if (!this.stopped && previous.outputDevice !== settings.outputDevice && this.testing) await this.context!.setSinkId(settings.outputDevice === 'default' ? '' : settings.outputDevice);
      } finally { if (!this.stopped) this.update(this.settings, this.muted, this.ptt); }
    });
    this.configuration = apply;
    return apply;
  }
  addReference(id: string, track: MediaStreamTrack) {
    if (!this.context || !this.node || this.stopped) return;
    this.removeReference(id);
    const source = this.context.createMediaStreamSource(new MediaStream([track]));
    source.connect(this.node, 0, 1); this.references.set(id, source);
  }
  removeReference(id: string) { this.references.get(id)?.disconnect(); this.references.delete(id); }
  async startMonitor() {
    if (!this.destination || !this.node || this.stopped || this.testing) return;
    const generation = ++this.monitorGeneration;
    this.testing = true; this.update(this.settings, this.muted, this.ptt);
    try {
      await this.configure(this.settings);
      if (this.stopped || !this.testing || generation !== this.monitorGeneration) return;
      this.monitorGain = this.context!.createGain(); this.monitorGain.gain.value = this.settings.outputVolume;
      // Listen to the same processed PCM that feeds the published track. Avoid
      // an HTMLMediaElement round trip and its additional buffering/playback path.
      this.node.connect(this.monitorGain).connect(this.context!.destination);
      await this.context!.setSinkId(this.settings.outputDevice === 'default' ? '' : this.settings.outputDevice);
      if (this.stopped || !this.testing || generation !== this.monitorGeneration) return;
      await this.context!.resume();
    } catch (error) { this.stopMonitor(); throw error; }
  }
  stopMonitor() {
    ++this.monitorGeneration;
    this.testing = false;
    if (this.monitorGain) this.node?.disconnect(this.monitorGain);
    this.monitorGain?.disconnect(); this.monitorGain = undefined;
    this.update(this.settings, this.muted, this.ptt);
    if (!this.stopped && this.stream) void this.configure(this.settings).catch(error => this.onError(`Не удалось восстановить обработку микрофона: ${String(error)}`));
  }
  stop() {
    this.stopped = true; this.stopMonitor();
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.destination?.stream.getTracks().forEach(track => track.stop());
    this.source?.disconnect(); this.node?.disconnect();
    this.references.forEach(source => source.disconnect()); this.references.clear();
    if (this.node) { this.node.port.onmessage = null; this.node.port.postMessage({ type: 'destroy' }); this.node.port.close(); }
    // A borrowed context also drives incoming speech; only its session closes it.
    if (!this.sharedContext && this.context && this.context.state !== 'closed') void this.context.close();
    this.destination = undefined; this.stream = undefined;
  }
}
export function playCue(connected: boolean) {
  const context = new AudioContext();
  const gain = context.createGain(); gain.gain.value = 0.04; gain.connect(context.destination);
  for (let i = 0; i < 2; i++) {
    const osc = context.createOscillator(); osc.frequency.value = connected ? 540 + i * 180 : 720 - i * 180;
    osc.connect(gain); osc.start(context.currentTime + i * 0.1); osc.stop(context.currentTime + i * 0.1 + 0.08);
  }
  setTimeout(() => { void context.close(); }, 400);
}
