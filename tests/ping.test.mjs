import test from 'node:test';
import assert from 'node:assert/strict';
import { pingLevel } from '../shared/ping.mjs';
test('RTT colors share exact boundaries and never turn missing measurements green', () => {
  for (const value of [undefined, null, NaN, Infinity, -1]) assert.equal(pingLevel(value), 'unknown');
  for (const value of [0, 80, 149.9]) assert.equal(pingLevel(value), 'good');
  for (const value of [150, 220, 299.9]) assert.equal(pingLevel(value), 'warning');
  for (const value of [300, 800]) assert.equal(pingLevel(value), 'bad');
});
