import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presencePoll } from '../shared/presence-poll.mjs';

test('presence polls every 10 seconds only while active, resumes immediately and stops on cleanup', async () => {
  let tick, reads = 0, updates = [], cancelled = 0;
  const poll = presencePoll({ read: async () => ++reads, publish: value => updates.push(value),
    schedule: (fn, ms) => { assert.equal(ms, 10000); tick = fn; return 1; }, cancel: () => { cancelled++; } });
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  await flush(); assert.equal(reads, 0);
  poll.setActive(true); await flush(); assert.deepEqual(updates, [1]);
  tick(); await flush(); assert.deepEqual(updates, [1, 2]);
  poll.setActive(false); tick(); await flush(); assert.equal(reads, 2);
  poll.setActive(true); await flush(); assert.equal(reads, 3);
  poll.stop(); tick(); poll.setActive(true); await flush(); assert.equal(reads, 3); assert.ok(cancelled >= 3);
});

test('slow presence requests never overlap and stale responses are discarded after hiding', async () => {
  let resolve, tick, reads = 0, updates = [];
  const poll = presencePoll({ read: () => { reads++; return new Promise(done => { resolve = done; }); }, publish: value => updates.push(value),
    schedule: fn => { tick = fn; return 1; }, cancel: () => {} });
  poll.setActive(true); tick(); tick(); assert.equal(reads, 1);
  poll.setActive(false); poll.setActive(true); assert.equal(reads, 1);
  resolve('old'); await Promise.resolve(); await Promise.resolve();
  assert.equal(reads, 2); assert.deepEqual(updates, []);
  resolve('new'); await Promise.resolve(); assert.deepEqual(updates, ['new']);
  poll.stop();
});
