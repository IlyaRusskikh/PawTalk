import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { RnnoiseEngine } from '../shared/rnnoise.mjs';
import { VoicePipeline } from '../shared/voice-pipeline.mjs';
import { VoiceGate } from '../shared/gate.mjs';
const module = await WebAssembly.compile(await fs.readFile(new URL('../src/generated/rnnoise.wasm',import.meta.url)));

test('real bundled RNNoise suppresses deterministic click-like noise without the gate', () => {
  const engine=new RnnoiseEngine(module);
  let seed=3, raw=0, filtered=0;
  for(let n=0;n<300;n++) {
    const frame=new Float32Array(480);
    for(let i=0;i<480;i++) {
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      frame[i]=(seed/4294967296*2-1)*0.001;
      if(n%17===0 && i<100) frame[i]+=Math.exp(-i/20)*Math.sin(i*1.7)*0.4;
    }
    const energy=frame.reduce((sum,x)=>sum+x*x,0);
    const probability=engine.process(frame);
    assert.ok(Number.isFinite(probability) && probability>=0 && probability<=1);
    assert.ok(frame.every(Number.isFinite));
    if(n>100) { raw+=energy; filtered+=frame.reduce((sum,x)=>sum+x*x,0); }
  }
  assert.ok(10*Math.log10(raw/filtered)>12,'click fixture attenuation must exceed 12 dB');
  engine.destroy(); engine.destroy();
  assert.throws(()=>engine.process(new Float32Array(480)));
});

test('neural VAD rejects one-frame transients and retains speech hangover', () => {
  const gate=new VoiceGate();const settings={inputMode:'voice',noiseMode:'rnnoise',autoSensitivity:false,threshold:-60};
  assert.equal(gate.update(-20,1000,settings,false,false,0.95),false);
  assert.equal(gate.update(-80,1010,settings,false,false,0.01),false);
  assert.equal(gate.update(-40,1100,settings,false,false,0.9),false);
  assert.equal(gate.update(-40,1110,settings,false,false,0.9),true);
  assert.equal(gate.update(-75,1250,settings,false,false,0.01),true);
  assert.equal(gate.update(-75,1500,settings,false,false,0.01),false);
});

test('20 ms look-behind preserves quiet audio preceding voice detection', () => {
  const pipeline=new VoicePipeline();
  const state={settings:{inputMode:'voice',noiseMode:'off',autoSensitivity:false,threshold:-20,pttReleaseMs:0},muted:false,ptt:false,gain:1};
  const chunk=new Float32Array(480),out=new Float32Array(480);
  chunk.fill(0.01);pipeline.process(chunk,out,state,1000);
  chunk.fill(0.02);pipeline.process(chunk,out,state,1010);
  chunk.fill(0.5);pipeline.process(chunk,out,state,1020);
  const samples=[];
  for(let i=0;i<2;i++){pipeline.process(chunk,out,state,1030+i*10);samples.push(...out);}
  assert.ok(samples.some(x=>Math.abs(x-0.01)<0.000001),'first quiet consonant survives opening');
  assert.ok(samples.some(x=>Math.abs(x-0.02)<0.000001),'following quiet audio survives opening');
});

test('mute flushes delayed audio; released PTT with zero hold cannot replay buffered speech', () => {
  const pipeline=new VoicePipeline({process(frame){return 0.9;}});
  const settings={inputMode:'ptt',noiseMode:'rnnoise',autoSensitivity:true,threshold:-60,pttReleaseMs:0};
  const state={settings,muted:false,ptt:true,gain:1}; const input=new Float32Array(128).fill(0.5),output=new Float32Array(128);
  for(let i=0;i<30;i++)pipeline.process(input,output,state,1000+i*128/48);
  pipeline.process(input,output,{...state,muted:true},1100);assert.ok(output.every(x=>x===0));
  pipeline.process(input,output,{...state,ptt:false},1200);assert.ok(output.every(x=>x===0));
  for(let i=0;i<20;i++){pipeline.process(input,output,{...state,ptt:false},1203+i*128/48);assert.ok(output.every(x=>x===0));}
});
test('muted microphone samples are not retained inside the neural model', () => {
 let frames=0;
 const pipeline=new VoicePipeline({process(frame){assert.ok(frame.every(x=>x===0));frames++;return 0;}});
 const state={settings:{inputMode:'voice',noiseMode:'rnnoise',autoSensitivity:true,threshold:-50},muted:true,ptt:false,gain:1};
 for(let i=0;i<20;i++) { const output=new Float32Array(128);pipeline.process(new Float32Array(128).fill(0.8),output,state,1000+i*128/48);assert.ok(output.every(x=>x===0)); }
 assert.ok(frames>0);
});
