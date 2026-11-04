import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSettings, remember } from '../src/settings.ts';
let value = '{}';
globalThis.localStorage = { getItem: () => value, setItem: (_key,next) => {value=next;} };
test('new preferences default to RNNoise; old disabled suppression stays disabled', () => {
 value='{}';assert.equal(loadSettings().noiseMode,'rnnoise');
 value=JSON.stringify({noiseSuppression:true});assert.equal(loadSettings().noiseMode,'rnnoise');
 value=JSON.stringify({noiseSuppression:false});assert.equal(loadSettings().noiseMode,'off');
});
test('noise mode validation and persistence preserve explicit choices', () => {
 value=JSON.stringify({noiseMode:'invalid'});assert.equal(loadSettings().noiseMode,'rnnoise');
 for(const noiseMode of ['off','standard','rnnoise']) { value=JSON.stringify({noiseMode});const settings=loadSettings();assert.equal(settings.noiseMode,noiseMode);remember(settings);assert.equal(JSON.parse(value).noiseMode,noiseMode); }
});
test('browser AEC stays enabled without the optional 80 ms nearby voice buffer', () => {
 value='{}';assert.equal(loadSettings().echoCancellation,true);assert.equal(loadSettings().nearbyVoiceSuppression,false);
 value=JSON.stringify({echoCancellation:true});assert.equal(loadSettings().nearbyVoiceSuppression,false);
 for(const nearbyVoiceSuppression of [false,true]){value=JSON.stringify({nearbyVoiceSuppression});const settings=loadSettings();assert.equal(settings.nearbyVoiceSuppression,nearbyVoiceSuppression);remember(settings);assert.equal(JSON.parse(value).nearbyVoiceSuppression,nearbyVoiceSuppression);}
});
