// Correlated, weaker microphone copies of remote speech are attenuated before
// RNNoise, gating and AGC. Unlike polarity inversion this tolerates network delay.
// An 80 ms microphone look-behind permits the remote reference to arrive after
// the direct acoustic sound when two participants are sitting in one room.
export class EchoSuppressor {
  mic = new Float32Array(2048); reference = new Float32Array(2048);
  delay = new Float32Array(3840);
  cursor = 0; count = 0; phase = 0; sumMic = 0; sumReference = 0;
  index = 0; gain = 1; hold = 0; enabled = false; correlation = 0;
  reset() {
    this.mic.fill(0); this.reference.fill(0); this.delay.fill(0);
    this.cursor = this.count = this.phase = this.sumMic = this.sumReference = this.index = this.hold = 0;
    this.gain = 1; this.correlation = 0;
  }
  detect() {
    if (this.count < 480) return;
    // Compare 40 ms of microphone history against 0..300 ms of remote history
    // at 4 kHz. Require both waveform correlation and a stronger remote signal.
    const end = this.count - 320;
    let micEnergy = 0;
    for (let j = 0; j < 160; j++) micEnergy += this.mic[(end - j) & 2047] ** 2;
    if (micEnergy < 160 * 0.00003 ** 2) return;
    let best = 0;
    for (let lag = 0; lag <= 1200; lag++) {
      let cross = 0, energy = 0;
      for (let j = 0; j < 160; j += 2) {
        const ref = this.reference[(this.count - lag - j) & 2047];
        cross += this.mic[(end - j) & 2047] * ref;
        energy += ref * ref;
      }
      if (energy < micEnergy * 1.125) continue;
      const similarity = cross * cross / (micEnergy * 0.5 * energy + 1e-20);
      if (similarity > best) best = similarity;
    }
    this.correlation = Math.sqrt(best);
    if (best > 0.72) this.hold = 4800;
  }
  process(input, reference, output, enabled) {
    if (enabled !== this.enabled) { this.reset(); this.enabled = enabled; }
    if (!enabled) { output.set(input); return; }
    for (let i = 0; i < output.length; i++) {
      const value = input?.[i] || 0;
      this.sumMic += value; this.sumReference += reference?.[i] || 0;
      if (++this.phase === 12) {
        this.phase = 0; ++this.count;
        this.mic[this.count & 2047] = this.sumMic / 12;
        this.reference[this.count & 2047] = this.sumReference / 12;
        this.sumMic = this.sumReference = 0;
        if (this.count % 40 === 0) this.detect();
      }
      const delayed = this.delay[this.index];
      this.delay[this.index] = value; this.index = (this.index + 1) % this.delay.length;
      const target = this.hold > 0 ? 0.02 : 1;
      this.gain += (target - this.gain) * (target < this.gain ? 0.01 : 0.0005);
      this.hold = Math.max(0, this.hold - 1);
      output[i] = delayed * this.gain;
    }
  }
}
