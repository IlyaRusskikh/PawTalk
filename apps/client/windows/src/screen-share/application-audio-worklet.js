class ApplicationAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pcm = new Int16Array(Math.floor(sampleRate / 8) * 2);
    this.start = 0;
    this.length = 0;
    this.buffering = true;
    this.port.onmessage = ({ data }) => {
      const samples = data.subarray(Math.max(0, data.length - this.pcm.length));
      const overflow = Math.max(0, this.length + samples.length - this.pcm.length);
      this.start = (this.start + overflow) % this.pcm.length;
      this.length -= overflow;
      const end = (this.start + this.length) % this.pcm.length;
      const first = Math.min(samples.length, this.pcm.length - end);
      this.pcm.set(samples.subarray(0, first), end);
      this.pcm.set(samples.subarray(first), 0);
      this.length += samples.length;
    };
  }

  process(_inputs, [output]) {
    const [left, right] = output;
    if (this.buffering && this.length < sampleRate * 2 * 0.03) return true;
    const frames = Math.min(left.length, this.length / 2);
    for (let i = 0; i < frames; i++) {
      left[i] = this.pcm[this.start] / 32768;
      right[i] = this.pcm[this.start + 1] / 32768;
      this.start = (this.start + 2) % this.pcm.length;
    }
    this.length -= frames * 2;
    this.buffering = frames < left.length;
    return true;
  }
}

registerProcessor('pawtalk-application-audio', ApplicationAudioProcessor);
