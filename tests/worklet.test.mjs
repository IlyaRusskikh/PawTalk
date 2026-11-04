import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
const assets = path.resolve('dist/assets');
test('compiled worklet emits zeros for mute and released PTT, even with loud input', async () => {
  const name = (await fs.readdir(assets)).find(name => name.startsWith('gate-worklet-') && name.endsWith('.js'));
  assert.ok(name, 'run npm run build before npm test');
  let Processor;
  const scope = { sampleRate: 48000, currentTime: 1, AudioWorkletProcessor: class { port = { onmessage: null, postMessage() {} }; }, registerProcessor(_name, type) { Processor = type; } };
  vm.createContext(scope);
  vm.runInContext(await fs.readFile(path.join(assets, name), 'utf8'), scope);
  const processor = new Processor();
  const input = new Float32Array(128).fill(0.5); const output = new Float32Array(128);
  const settings = { inputMode: 'ptt', noiseMode: 'off', pttReleaseMs: 160, threshold: -48, autoSensitivity: false };
  function process({ muted = false, ptt = false, at = 1 } = {}) {
    scope.currentTime = at;
    processor.port.onmessage({ data: { settings, muted, ptt, test: false, gain: 1 } });
    let audible=false;
    for(let i=0;i<20;i++){scope.currentTime=at+i*128/48000;processor.process([[input]], [[output]]);audible ||= output.some(value=>value!==0);}
    return audible;
  }
  assert.equal(process(), false);
  assert.equal(process({ ptt: true, at: 1.1 }), true);
  assert.equal(process({ ptt: true, muted: true, at: 1.11 }), false);
  assert.equal(process({ at: 1.12 }), false);
  assert.equal(process({ ptt: true, at: 1.2 }), true);
  assert.equal(process({ at: 1.5 }), false);
  // Repeat through the remote-reference echo path, including its delay buffer.
  settings.echoCancellation = true;
  settings.nearbyVoiceSuppression = true;
  for (let i = 0; i < 80; i++) {
    scope.currentTime = 2 + i * 128 / 48000;
    processor.port.onmessage({ data: { settings, muted: false, ptt: true, gain: 1 } });
    processor.process([[input], [input]], [[output]]);
  }
  for (const state of [{ muted: true, ptt: true }, { muted: false, ptt: false }]) {
    processor.port.onmessage({ data: { settings: { ...settings, pttReleaseMs: 0 }, ...state, gain: 1 } });
    scope.currentTime = 3;
    processor.process([[input], [input]], [[output]]);
    assert.ok(output.every(value => value === 0), 'echo history cannot bypass mute or released PTT');
  }
});

test('nearby voice suppression adds 80 ms only when explicitly enabled, independently of browser AEC', async () => {
  const name = (await fs.readdir(assets)).find(name => name.startsWith('gate-worklet-') && name.endsWith('.js'));
  let Processor;
  const scope = { sampleRate:48000,currentTime:0,AudioWorkletProcessor:class{port={onmessage:null,postMessage(){}};},registerProcessor(_name,type){Processor=type;} };
  vm.createContext(scope);vm.runInContext(await fs.readFile(path.join(assets,name),'utf8'),scope);
  const firstSample = (nearbyVoiceSuppression,echoCancellation) => {
    const processor=new Processor(),output=new Float32Array(128),reference=new Float32Array(128);
    processor.port.onmessage({data:{settings:{inputMode:'ptt',noiseMode:'off',pttReleaseMs:0,autoSensitivity:false,threshold:-80,nearbyVoiceSuppression,echoCancellation},muted:false,ptt:true,gain:1}});
    for(let block=0;block<80;block++){
      const input=new Float32Array(128);if(block===0)input.fill(.2);
      scope.currentTime=block*128/48000;processor.process([[input],[reference]],[[output]]);
      const index=output.findIndex(x=>Math.abs(x)>.001);if(index>=0)return block*128+index;
    }
    throw Error('No transmitted impulse');
  };
  const baseline=firstSample(false,false);
  assert.equal(firstSample(false,true),baseline,'ordinary browser AEC must not enable the extra delay buffer');
  assert.equal(firstSample(true,true)-baseline,3840);
  assert.equal(firstSample(true,false)-baseline,3840);
});
