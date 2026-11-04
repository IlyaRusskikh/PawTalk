import test from 'node:test';
import assert from 'node:assert/strict';
import { RttMeter } from '../shared/rtt.mjs';
test('RTT expires even if getStats keeps returning the same measurement', () => {
 const meter=new RttMeter(15000);const stat={id:'a',roundTripTime:.021,roundTripTimeMeasurements:1};
 assert.equal(meter.sample(stat,0),21);
 assert.equal(meter.sample(stat,14000),21);
 assert.equal(meter.sample({...stat,timestamp:17000},17000),undefined);
 assert.equal(meter.sample({...stat,roundTripTimeMeasurements:2},18000),21);
});
test('missing, negative and zero-count RTT values never become fresh, real zero RTT is valid', () => {
 const meter=new RttMeter();
 for(const stat of [undefined,{roundTripTime:NaN},{roundTripTime:-1},{roundTripTime:0,roundTripTimeMeasurements:0}])assert.equal(meter.sample(stat,0),undefined);
 assert.equal(meter.sample({id:'a',roundTripTime:0,roundTripTimeMeasurements:1},1),0);
 assert.equal(meter.sample(undefined,16000),undefined);
 meter.reset();assert.equal(meter.value(1),undefined);
});
