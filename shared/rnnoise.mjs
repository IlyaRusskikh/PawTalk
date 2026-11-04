// C ABI of the pinned RNNoise WASM asset. No DOM, network, timers or wrapper shims.
export class RnnoiseEngine {
  constructor(module) {
    let exports;
    const instance = new WebAssembly.Instance(module, { env: {
      emscripten_memcpy_big: (destination, source, length) => {
        new Uint8Array(exports.memory.buffer).copyWithin(destination, source, source + length);
        return destination;
      },
      emscripten_resize_heap: size => {
        try { exports.memory.grow(Math.ceil((size - exports.memory.buffer.byteLength) / 65536)); return 1; } catch { return 0; }
      },
      __assert_fail: () => { throw new Error('RNNoise assertion failed'); },
    }, wasi_snapshot_preview1: {
      fd_write: (_fd, vectors, count, written) => {
        const heap = new Uint32Array(exports.memory.buffer);
        let bytes = 0;
        for (let i = 0; i < count; i++) bytes += heap[(vectors + i * 8 + 4) / 4];
        heap[written / 4] = bytes;
        return 0;
      },
    } });
    exports = instance.exports;
    this.exports = exports;
    exports.emscripten_stack_init(); exports.__wasm_call_ctors();
    if (exports.rnnoise_get_frame_size() !== 480) throw new Error('RNNoise requires 480-sample frames');
    this.state = exports.rnnoise_create(0);
    this.input = exports.malloc(480 * 4); this.output = exports.malloc(480 * 4);
    if (!this.state || !this.input || !this.output) { this.destroy(); throw new Error('RNNoise allocation failed'); }
  }
  process(frame) {
    if (!this.state || frame.length !== 480) throw new Error('Invalid RNNoise frame or destroyed engine');
    if (!this.heap || this.heap.buffer !== this.exports.memory.buffer) this.heap = new Float32Array(this.exports.memory.buffer);
    const heap = this.heap;
    const input = this.input / 4, output = this.output / 4;
    for (let i = 0; i < 480; i++) heap[input + i] = Math.max(-1, Math.min(1, frame[i])) * 32768;
    const probability = this.exports.rnnoise_process_frame(this.state, this.output, this.input);
    for (let i = 0; i < 480; i++) frame[i] = heap[output + i] / 32768;
    return probability;
  }
  destroy() {
    if (this.state) this.exports.rnnoise_destroy(this.state);
    if (this.input) this.exports.free(this.input);
    if (this.output) this.exports.free(this.output);
    this.state = this.input = this.output = 0;
  }
}
