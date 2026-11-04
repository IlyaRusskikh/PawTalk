// Offline replay of a 48 kHz mono PCM16 WAV through the actual microphone DSP.
// No upload and no microphone access. Keep source recordings outside the repo.
import fs from 'node:fs/promises';
import path from 'node:path';
import { RnnoiseEngine } from '../shared/rnnoise.mjs';
import { VoicePipeline } from '../shared/voice-pipeline.mjs';

const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/check-speech.mjs input.wav [output-directory]');
const folder = path.resolve(process.argv[3] || 'release/qa/speech');
const wav = await fs.readFile(input);
if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected WAV');
let data, format;
for (let offset = 12; offset + 8 <= wav.length;) {
  const size = wav.readUInt32LE(offset + 4), name = wav.toString('ascii', offset, offset + 4);
  if (offset + 8 + size > wav.length) throw new Error('Truncated WAV');
  if (name === 'fmt ') format = wav.subarray(offset + 8, offset + 8 + size);
  if (name === 'data') data = wav.subarray(offset + 8, offset + 8 + size);
  offset += 8 + size + size % 2;
}
if (!format || !data || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== 48000 || format.readUInt16LE(14) !== 16) throw new Error('Required: 48 kHz, mono, PCM 16-bit WAV');
const model = await WebAssembly.compile(await fs.readFile(new URL('../src/generated/rnnoise.wasm', import.meta.url)));
function encode(samples) {
  const result = Buffer.alloc(44 + samples.length * 2);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8); result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(48000, 24); result.writeUInt32LE(96000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, i) => result.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32768))), 44 + i * 2));
  return result;
}
await fs.mkdir(folder, { recursive: true });
const reports = [];
for (const level of [1, 0.25, 0.06]) {
  const engine = new RnnoiseEngine(model), pipeline = new VoicePipeline(engine);
  const samples = Math.ceil((data.length / 2 + 48000) / 480) * 480;
  const output = new Float32Array(samples), source = new Float32Array(samples), frame = new Float32Array(480);
  for (let i = 0; i < data.length / 2; i++) source[i] = data.readInt16LE(i * 2) / 32768 * level;
  const state = { settings: { inputMode: 'voice', noiseMode: 'rnnoise', autoSensitivity: true, threshold: -48, autoGainControl: true }, gain: 1, muted: false, ptt: false };
  const frames = []; let closedEnergy = 0, totalEnergy = 0;
  for (let pos = 0; pos < samples; pos += 480) {
    const chunk = source.subarray(pos, pos + 480);
    pipeline.process(chunk, frame, state, pos / 48);
    output.set(frame, pos);
    const energy = chunk.reduce((sum, x) => sum + x * x, 0);
    totalEnergy += energy;
    if (!pipeline.speaking) closedEnergy += energy;
    frames.push({ ms: pos / 48, inputDB: 10 * Math.log10(Math.max(1e-10, energy / 480)), outputDB: pipeline.db, probability: pipeline.probability, open: pipeline.speaking, threshold: pipeline.gate.getThreshold(state.settings) });
  }
  engine.destroy();
  const name = `level-${level}`;
  await fs.writeFile(path.join(folder, `${name}-input.wav`), encode(source));
  await fs.writeFile(path.join(folder, `${name}-output.wav`), encode(output));
  await fs.writeFile(path.join(folder, `${name}-frames.json`), JSON.stringify(frames));
  reports.push({ level, inputEnergyWhileGateClosedPercent: 100 * closedEnergy / Math.max(totalEnergy, 1e-20), seconds: samples / 48000 });
}
await fs.writeFile(path.join(folder, 'report.json'), JSON.stringify(reports, null, 2));
console.log(JSON.stringify({ folder, reports }, null, 2));
