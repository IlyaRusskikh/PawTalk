// The pinned upstream package embeds its WASM in the browser wrapper. Extract it
// at build/dev startup so AudioWorklet can use the C ABI without DOM polyfills.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(fileURLToPath(import.meta.resolve('@shiguredo/rnnoise-wasm')), 'utf8');
const start = source.indexOf('AGFzbQ');
const end = start < 0 ? -1 : source.indexOf('"', start);
if (start < 0 || end < 0) throw new Error('Pinned RNNoise package has no embedded WASM');
const binary = Buffer.from(source.slice(start, end), 'base64');
if (!WebAssembly.validate(binary)) throw new Error('Invalid embedded RNNoise WASM');
if (createHash('sha256').update(binary).digest('hex') !== 'b3b67c9eae8f0791aad468c708659e0850bb37b0fb9c8a8666f2d7b0b6869bc4') throw new Error('RNNoise WASM differs from pinned 2025.1.5 asset');
const file = path.join(root, 'src/generated/rnnoise.wasm');
await mkdir(path.dirname(file), { recursive: true });
const previous = await readFile(file).catch(() => undefined);
if (!previous?.equals(binary)) await writeFile(file, binary);
