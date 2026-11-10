import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtcDiagnosticsMeter } from '../shared/rtc-diagnostics.mjs';
import { ConnectionHistory, chartSegments } from '../shared/connection-history.mjs';

const report = (timestamp, bytesSent, id = 'out') => new Map([
  ['out', { id, type: 'outbound-rtp', kind: 'audio', timestamp, bytesSent, packetsSent: bytesSent / 100, codecId: 'codec', mediaSourceId: 'source', ssrc: 42, targetBitrate: 64000 }],
  ['codec', { id: 'codec', mimeType: 'audio/opus', clockRate: 48000 }],
  ['source', { id: 'source', audioLevel: .1 }],
  ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
  ['pair', { id: 'pair', type: 'candidate-pair', bytesSent: 30000, bytesReceived: 12000, availableOutgoingBitrate: 2000000, localCandidateId: 'local' }],
  ['local', { id: 'local', address: '192.0.2.1', protocol: 'udp' }],
]);

test('debug metrics use selected pair, codec and real counter deltas', () => {
  const meter = new RtcDiagnosticsMeter();
  const first = meter.sample(report(1000, 10000));
  assert.equal(first.bitrate, undefined);
  assert.equal(first.availableBitrate, 2000000);
  assert.equal(first.localAddress, '192.0.2.1');
  assert.equal(first.codec, 'audio/opus');
  assert.equal(first.audioDetected, 'yes');
  assert.equal(meter.sample(report(6000, 15000)).bitrate, 8000);
  assert.equal(meter.sample(report(11000, 1000)).bitrate, undefined, 'counter reset is not negative traffic');
  assert.equal(meter.sample(report(16000, 6000, 'replacement')).bitrate, undefined, 'new RTP stream has no prior interval');
  meter.reset();
  assert.equal(meter.sample(report(21000, 10000)).bitrate, undefined);
  assert.equal(meter.sample(undefined).bytesSent, undefined);
});

test('extended history is bounded, breaks on polling failure and resets with session', () => {
  const history = new ConnectionHistory(); history.reset('connected', 0);
  history.sample({ at: 1000, details: { bitrate: 10000, codec: 'audio/opus' } });
  history.sample({ at: 6000 });
  assert.deepEqual(history.getSnapshot().series.bitrate.map(point => point.value), [10000, undefined]);
  assert.equal(history.getSnapshot().current.bitrate, undefined);
  history.sample({ at: 130000, details: { bitrate: 9000 } });
  assert.equal(history.getSnapshot().series.bitrate.length, 1);
  history.setState('disconnected', 131000);
  assert.deepEqual(history.getSnapshot().series, {});
  assert.deepEqual(history.getSnapshot().current, {});
});

test('negative dB chart scale retains real positions', () => {
  const result = chartSegments([{ at: 0, value: -100 }, { at: 5000, value: -50 }], 5000, 0, 280, 100, -100);
  assert.equal(result[0][0][1], 100);
  assert.equal(result[0][1][1], 50);
});

test('transport counters and remote feedback use available report links without inventing zeros', () => {
  const meter = new RtcDiagnosticsMeter();
  const stats = report(1000, 10000);
  Object.assign(stats.get('transport'), { packetsReceived: 0, packetsSent: 50, bytesReceived: 8000 });
  Object.assign(stats.get('out'), { remoteId: 'feedback' });
  stats.set('feedback', { id: 'feedback', type: 'remote-inbound-rtp', packetsLost: 0 });
  const result = meter.sample(stats);
  assert.equal(result.transportPacketsReceived, 0);
  assert.equal(result.transportPacketsSent, 50);
  assert.equal(result.transportBytesReceived, 12000, 'selected pair takes precedence');
  assert.equal(result.packetsLost, 0);
  stats.delete('pair');
  const fallback = meter.sample(stats);
  assert.equal(fallback.transportBytesReceived, 8000);
  assert.equal(fallback.transportBytesSent, undefined);
});

test('outgoing loss is receiver-reported fraction, independent of incoming and local sent counters', () => {
  const meter = new RtcDiagnosticsMeter(), stats = report(1000, 10000);
  Object.assign(stats.get('out'), { remoteId: 'feedback' });
  stats.set('feedback', { id: 'feedback', type: 'remote-inbound-rtp', timestamp: 1000, fractionLost: .125, packetsLost: 7 });
  assert.equal(meter.sample(stats, 0).outgoingLoss, 12.5);
  stats.get('out').packetsSent = 100000;
  assert.equal(meter.sample(stats, 5000).outgoingLoss, 12.5, 'new local counters do not change receiver feedback');
  assert.equal(meter.sample(undefined, 10000).outgoingLoss, undefined);
  assert.equal(meter.sample(stats, 16000).outgoingLoss, undefined, 'repeated reports expire');
  Object.assign(stats.get('feedback'), { timestamp: 2000, fractionLost: 0 });
  assert.equal(meter.sample(stats, 17000).outgoingLoss, 0, 'fresh real zero remains valid');
  for (const fractionLost of [undefined, NaN, -1, 1.1]) {
    Object.assign(stats.get('feedback'), { timestamp: 3000, fractionLost });
    assert.equal(meter.sample(stats, 18000).outgoingLoss, undefined);
  }
  stats.delete('feedback');
  assert.equal(meter.sample(stats, 19000).outgoingLoss, undefined);
});

test('outgoing feedback follows stream changes and resets between sessions', () => {
  const meter = new RtcDiagnosticsMeter(), stats = report(1000, 10000);
  stats.set('feedback', { id: 'feedback', type: 'remote-inbound-rtp', localId: 'out', timestamp: 1000, fractionLost: .1 });
  assert.equal(meter.sample(stats, 0).outgoingLoss, 10);
  stats.get('out').id = 'replacement';
  assert.equal(meter.sample(stats, 1000).outgoingLoss, undefined, 'old stream feedback is not reused');
  Object.assign(stats.get('feedback'), { localId: 'replacement', fractionLost: .02 });
  assert.equal(meter.sample(stats, 2000).outgoingLoss, 2);
  meter.reset();
  assert.equal(meter.sample(undefined, 3000).outgoingLoss, undefined);
});
