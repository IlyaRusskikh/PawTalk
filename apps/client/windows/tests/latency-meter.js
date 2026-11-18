// Identical measurement overhead in baseline and E2EE trials. No audio output.
class LatencyMeter extends AudioWorkletProcessor {
  constructor() { super(); this.batch = []; }
  process(inputs, outputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      let sum = 0; for (const value of channel) sum += value * value;
      this.batch.push([currentTime * 1000, Math.sqrt(sum / channel.length)]);
      if (this.batch.length >= 32) { this.port.postMessage(this.batch); this.batch = []; }
    }
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('latency-meter', LatencyMeter);
