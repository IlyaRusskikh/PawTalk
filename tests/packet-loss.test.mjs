import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PacketLossMeter} from '../shared/packet-loss.mjs';
test('packet loss is a weighted percentage and reflects the latest interval',()=>{
 const meter=new PacketLossMeter();
 assert.equal(meter.sample([{id:'a',received:90,lost:10}]),10);
 assert.equal(meter.sample([{id:'a',received:190,lost:10}]),0);
 assert.equal(meter.sample([{id:'a',received:280,lost:20}]),10);
 meter.reset();
 assert.equal(meter.sample([{id:'a',received:90,lost:10},{id:'b',received:900,lost:0}]),1);
});
test('late packets, counter resets, no traffic and reconnects never produce invalid loss',()=>{
 const meter=new PacketLossMeter();meter.sample([{id:'a',received:100,lost:5}]);
 assert.equal(meter.sample([{id:'a',received:105,lost:3}]),0);
 assert.equal(meter.sample([{id:'a',received:9,lost:1}]),10);
 assert.equal(meter.sample([]),0);meter.reset();assert.equal(meter.sample([{id:'b',received:0,lost:4}]),100);
});
