// Optional synthetic/reference PCM test. Input: 48 kHz, mono, signed 16-bit WAV.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { RnnoiseEngine } from '../shared/rnnoise.mjs';
const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/neural-quality.mjs speech.wav');
const wav = await fs.readFile(input);
let data, format;
for(let offset=12;offset+8<=wav.length;) {
  const size=wav.readUInt32LE(offset+4),name=wav.toString('ascii',offset,offset+4);
  if(name==='fmt ') format=wav.subarray(offset+8,offset+8+size);
  if(name==='data') data=wav.subarray(offset+8,offset+8+size);
  offset+=8+size+(size%2);
}
assert.ok(format && data);
assert.equal(format.readUInt16LE(0),1);assert.equal(format.readUInt16LE(2),1);assert.equal(format.readUInt32LE(4),48000);assert.equal(format.readUInt16LE(14),16);
const module=await WebAssembly.compile(await fs.readFile(new URL('../src/generated/rnnoise.wasm',import.meta.url)));
const engine=new RnnoiseEngine(module);
const count=Math.ceil(data.length/2/480)*480;
const reference=new Float32Array(count),mixed=new Float32Array(count),filtered=new Float32Array(count);
let seed=7,voiceFrames=0,totalMs=0;
for(let n=0;n<count;n++) {
  reference[n]=n<data.length/2?data.readInt16LE(n*2)/32768*0.25:0;
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  const click=n%11520;
  mixed[n]=reference[n]+(seed/4294967296*2-1)*0.001+(click<100?Math.exp(-click/20)*Math.sin(click*1.7)*0.4:0);
}
for(let offset=0;offset<count;offset+=480) {
  const frame=mixed.slice(offset,offset+480),start=performance.now();
  const probability=engine.process(frame);totalMs+=performance.now()-start;
  if(probability>=0.55)voiceFrames++;
  filtered.set(frame,offset);
}
engine.destroy();
function correlation(lag) {
  let xy=0,xx=0,yy=0;
  for(let n=0;n<count-lag;n++){const x=reference[n],y=filtered[n+lag];xy+=x*y;xx+=x*x;yy+=y*y;}
  return xy/Math.sqrt(xx*yy);
}
function encode(samples) {
 const result=Buffer.alloc(44+samples.length*2);result.write('RIFF',0);result.writeUInt32LE(result.length-8,4);result.write('WAVEfmt ',8);result.writeUInt32LE(16,16);result.writeUInt16LE(1,20);result.writeUInt16LE(1,22);result.writeUInt32LE(48000,24);result.writeUInt32LE(96000,28);result.writeUInt16LE(2,32);result.writeUInt16LE(16,34);result.write('data',36);result.writeUInt32LE(samples.length*2,40);
 samples.forEach((x,n)=>result.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(x*32768))),44+n*2));return result;
}
const correlations=[0,480,960].map(lag=>({lag,correlation:correlation(lag)}));
const metrics={sampleRate:48000,seconds:count/48000,voiceFrames,meanInferenceMs:totalMs/(count/480),correlations};
assert.ok(voiceFrames>10,'speech must be detected');
assert.ok(Math.max(...correlations.map(x=>x.correlation))>0.6,'quiet speech waveform must remain recognizable');
await fs.mkdir('release/qa',{recursive:true});
await fs.writeFile('release/qa/neural-input.wav',encode(mixed));await fs.writeFile('release/qa/neural-output.wav',encode(filtered));await fs.writeFile('release/qa/rnnoise-quality.json',JSON.stringify(metrics,null,2));
console.log(JSON.stringify(metrics));
