// Review-only edits of CC0 recordings by Joseph SARDIN / BigSoundBank.
// No synthetic tones. Output stays outside the app's packaged assets.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const directory = resolve(process.argv[2] || 'release/qa/pawtalk-audio-real');
const purrOnly = process.argv.includes('--purr-only');
const rate = 48000;
const sources = [
  { id: '0436', title: 'Cat Purr', page: 'https://bigsoundbank.com/cat-purr-s0436.html', url: 'https://bigsoundbank.com/UPLOAD/bwf-en/0436.wav' },
  { id: '1890', title: 'Meow Cat #2', page: 'https://bigsoundbank.com/miaulement-chat-2-s1890.html', url: 'https://bigsoundbank.com/UPLOAD/bwf-en/1890.wav' },
];
const smooth = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
const db = x => 20 * Math.log10(Math.max(1e-12, x));

function decode(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw Error('Expected RIFF/WAVE');
  let fmt, data;
  for (let at = 12; at + 8 <= bytes.length;) {
    const tag = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4);
    if (at + 8 + size > bytes.length) throw Error('Truncated WAV');
    if (tag === 'fmt ') fmt = bytes.subarray(at + 8, at + 8 + size);
    if (tag === 'data') data = bytes.subarray(at + 8, at + 8 + size);
    // BWF downloads may carry nonstandard trailing metadata after the PCM data.
    if (fmt && data) break;
    at += 8 + size + size % 2;
  }
  if (!fmt || !data || fmt.length < 16) throw Error('Missing WAV chunks');
  const channels = fmt.readUInt16LE(2), sampleRate = fmt.readUInt32LE(4), bits = fmt.readUInt16LE(14);
  const format = fmt.readUInt16LE(0) === 65534 && fmt.length >= 40 ? fmt.readUInt16LE(24) : fmt.readUInt16LE(0);
  if (format !== 1 || ![16, 24, 32].includes(bits) || !channels || !sampleRate) throw Error('Expected PCM16/24/32');
  const step = bits / 8;
  const samples = Float64Array.from({ length: data.length / step / channels }, (_, i) => {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data.readIntLE((i * channels + c) * step, step) / 2 ** (bits - 1);
    return sum / channels;
  });
  return { samples, sampleRate };
}

// Gentle filtering retains the original texture and breathing.
function filter(samples, high, low) {
  const highAlpha = 1 / (1 + 2 * Math.PI * high / rate);
  const lowAlpha = 1 - Math.exp(-2 * Math.PI * low / rate);
  let previous = samples[0] || 0, hp = 0, lp = 0;
  return samples.map(x => { hp = highAlpha * (hp + x - previous); previous = x; lp += lowAlpha * (hp - lp); return lp; });
}

function clip(source, start, end, pitchStart = 0, pitchEnd = pitchStart) {
  if (start < 0 || end > source.samples.length / source.sampleRate || start >= end) throw Error('Invalid source range');
  const result = [];
  const first = start * source.sampleRate, last = end * source.sampleRate;
  for (let position = first; position < last - 1;) {
    const index = Math.floor(position), fraction = position - index;
    result.push(source.samples[index] * (1 - fraction) + source.samples[index + 1] * fraction);
    const progress = (position - first) / (last - first);
    const semitones = pitchStart + (pitchEnd - pitchStart) * smooth(progress);
    position += source.sampleRate / rate * 2 ** (semitones / 12);
  }
  return Float64Array.from(result);
}

function fade(samples, attack = .025, release = .055) {
  return samples.map((value, i) => value * smooth(i / (rate * attack)) * smooth((samples.length - 1 - i) / (rate * release)));
}

function level(samples, targetDb) {
  const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
  const peak = samples.reduce((largest, x) => Math.max(largest, Math.abs(x)), 0);
  if (rms < 1e-6) throw Error('Silent preview');
  const gain = Math.min(10 ** (targetDb / 20) / rms, 10 ** (-5 / 20) / peak);
  return samples.map(x => x * gain);
}

function concat(parts) {
  const result = new Float64Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function encode(samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((x, i) => {
    if (!Number.isFinite(x) || Math.abs(x) > 1) throw Error('Invalid or clipped sample');
    bytes.writeInt16LE(Math.round(x * 32767), 44 + i * 2);
  });
  return bytes;
}

await mkdir(join(directory, 'sources'), { recursive: true });
const decoded = new Map();
const activeSources = sources.filter(source => !purrOnly || source.id === '0436');
for (const source of activeSources) {
  const file = join(directory, 'sources', `${source.id}.wav`);
  let bytes;
  try { bytes = await readFile(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(source.url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error(`Download ${source.id}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    decode(bytes);
    await writeFile(file, bytes);
  }
  decoded.set(source.id, decode(bytes));
  source.sha256 = createHash('sha256').update(bytes).digest('hex');
}

const previews = [];
const purrRanges = [[.50, 1.16], [1.12, 1.84], [2.50, 3.25], [4.45, 5.11], [7.08, 7.88]];
for (const [index, [start, end]] of purrRanges.entries()) {
  // Normalize before the envelope so longer fades do not boost the body level.
  const samples = fade(level(filter(clip(decoded.get('0436'), start, end), 38, 2200), -24), .12, .24);
  previews.push({ name: `message-purr-0${index + 1}.wav`, samples, source: '0436', range: [start, end], pitchSemitones: [0, 0], fadeInSeconds: .12, fadeOutSeconds: .24 });
}
if (!purrOnly) {
const meow = decoded.get('1890');
const editMeow = (startPitch, endPitch) => level(fade(filter(clip(meow, .84, 2.03, startPitch, endPitch), 65, 7500)), -21);
const joinSound = concat([editMeow(-1, 0), new Float64Array(Math.round(rate * .10)), editMeow(2, 3)]);
previews.push({ name: 'room-join-double-meow-up.wav', samples: joinSound, source: '1890', range: [.84, 2.03], pitchSemitones: [[-1, 0], [2, 3]], gapSeconds: .10 });
previews.push({ name: 'room-leave-single-meow-down.wav', samples: editMeow(1, -3), source: '1890', range: [.84, 2.03], pitchSemitones: [1, -3] });
}

const report = [];
for (const { samples, ...info } of previews) {
  const bytes = encode(samples);
  await writeFile(join(directory, info.name), bytes);
  report.push({ ...info, seconds: samples.length / rate, peakDb: db(samples.reduce((p, x) => Math.max(p, Math.abs(x)), 0)), rmsDb: db(Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length)), sha256: createHash('sha256').update(bytes).digest('hex') });
}
// Listening order: enter, leave, then message variations 1–5.
const order = purrOnly ? previews : [previews[5], previews[6], ...previews.slice(0, 5)];
await writeFile(join(directory, '00-listen-all.wav'), encode(concat(order.flatMap(({ samples }) => [samples, new Float64Array(Math.round(rate * .65))]))));
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ author: 'Joseph SARDIN / BigSoundBank', license: 'CC0', licenseURL: 'https://creativecommons.org/publicdomain/zero/1.0/', integrated: false, sampleRate: rate, channels: 1, bits: 16, sources: activeSources, previews: report }, null, 2) + '\n');
const orderNotes = purrOnly
  ? '00-listen-all.wav: messages 1–5. Entry and exit await user-supplied recordings.\n'
  : '00-listen-all.wav: join, leave, messages 1–5. Join uses two meows with rising pitch; leave uses one with falling pitch.\n';
await writeFile(join(directory, 'README.txt'), 'PawTalk — real cat recording previews, NOT integrated.\nAuthor: Joseph SARDIN / BigSoundBank. Source license: CC0.\n' + orderNotes + 'Five different unpitched purr excerpts; fade in 120 ms, fade out 240 ms.\nSee manifest.json for original URLs, SHA-256, edit ranges and audio levels.\n');
console.log(directory);
console.table(report.map(({ name, seconds, peakDb, rmsDb }) => ({ name, seconds: seconds.toFixed(3), peakDb: peakDb.toFixed(1), rmsDb: rmsDb.toFixed(1) })));
