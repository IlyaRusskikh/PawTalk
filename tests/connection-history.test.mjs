import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionHistory, chartSegments } from '../shared/connection-history.mjs';
import { RttMeter } from '../shared/rtt.mjs';
import { PacketLossMeter } from '../shared/packet-loss.mjs';

test('only new RTCP measurements add RTT points; reads/renders do not change history', () => {
  const history = new ConnectionHistory(), meter = new RttMeter();
  history.reset('connected', 0);
  const stat = { id: 'a', roundTripTime: .08, roundTripTimeMeasurements: 1 };
  for (const at of [0, 5000, 10000]) history.sample({ at, rtt: meter.sample(stat, at), rttAt: meter.measuredAt, loss: 0 });
  assert.deepEqual(history.getSnapshot().rtt, [{ at: 0, value: 80 }]);
  const snapshot = history.getSnapshot();
  for (let i = 0; i < 100; i++) assert.equal(history.getSnapshot(), snapshot);
  history.sample({ at: 15000, rtt: meter.sample({ ...stat, roundTripTimeMeasurements: 2 }, 15000), rttAt: meter.measuredAt });
  assert.equal(history.getSnapshot().rtt.length, 2);
});

test('two-minute retention, fixed upper bound and subscription cleanup', () => {
  const history = new ConnectionHistory(); let updates = 0;
  const unsubscribe = history.subscribe(() => updates++);
  history.reset('connected', 0);
  for (let at = 0; at <= 200000; at += 5000) history.sample({ at, rttAt: at, rtt: 100, loss: 1 });
  assert.equal(history.getSnapshot().rtt[0].at, 80000);
  assert.equal(history.getSnapshot().rtt.length, 25);
  unsubscribe(); const before = updates;
  for (let at = 200001; at < 201000; at++) history.sample({ at, rttAt: at, rtt: 100 });
  assert.equal(updates, before);
  assert.equal(history.getSnapshot().rtt.length, 256);
});

test('missing, expired and invalid measurements are gaps; real zero remains valid', () => {
  const history = new ConnectionHistory(), meter = new RttMeter();
  history.reset('connected', 0);
  history.sample({ at: 0 });
  assert.equal(history.getSnapshot().rtt[0].value, undefined);
  assert.equal(history.getSnapshot().loss[0].value, undefined);
  const rtt = meter.sample({ id: 'a', roundTripTime: 0, roundTripTimeMeasurements: 1 }, 1000);
  history.sample({ at: 1000, rttAt: meter.measuredAt, rtt, loss: 0 });
  assert.equal(history.getSnapshot().rtt.at(-1).value, 0);
  history.sample({ at: 17000, rttAt: meter.measuredAt, rtt: meter.value(17000), loss: NaN });
  history.sample({ at: 18000, rttAt: 1000, rtt: 0, loss: -1 });
  assert.equal(history.getSnapshot().rtt.at(-1).value, undefined);
  assert.equal(history.getSnapshot().loss.at(-1).value, undefined);
  assert.equal(chartSegments(history.getSnapshot().rtt, 18000, 100).length, 1);
});

test('reconnect breaks history; full disconnect and new connection clear it', () => {
  const history = new ConnectionHistory();
  history.reset('connected', 0);
  history.sample({ at: 1000, rttAt: 1000, rtt: 80, loss: 2 });
  history.setState('reconnecting', 2000);
  assert.equal(history.getSnapshot().rtt.at(-1).value, undefined);
  history.setState('connected', 3000);
  history.sample({ at: 4000, rttAt: 4000, rtt: 50, loss: 0 });
  assert.equal(chartSegments(history.getSnapshot().rtt, 4000, 100).length, 2);
  history.setState('disconnected', 5000);
  assert.deepEqual(history.getSnapshot().rtt, []);
  history.setState('connecting', 6000);
  assert.deepEqual(history.getSnapshot().loss, []);
});

test('chart segments use real timestamps and break on missing samples or long polling gaps', () => {
  const points = [{ at: 0, value: 10 }, { at: 5000, value: 20 }, { at: 10000, value: undefined }, { at: 15000, value: 30 }, { at: 35000, value: 40 }];
  const segments = chartSegments(points, 120000, 100, 120, 100);
  assert.deepEqual(segments.map(segment => segment.map(point => point.map(Math.round))), [[[0, 90], [5, 80]], [[15, 70]], [[35, 60]]]);
});

test('packet-loss gaps, stream changes and counter resets', () => {
  const meter = new PacketLossMeter();
  assert.equal(meter.sample([]), undefined);
  assert.equal(meter.sample([{ id: 'a', received: 0, lost: 0 }]), undefined);
  assert.equal(meter.sample([{ id: 'a', received: 90, lost: 10 }]), 10);
  assert.equal(meter.sample([{ id: 'a', received: 90, lost: 10 }]), undefined);
  assert.equal(meter.sample([{ id: 'a', received: 9, lost: 1 }]), 10);
  assert.equal(meter.sample([{ id: 'b', received: 100, lost: 0 }]), 0);
});
