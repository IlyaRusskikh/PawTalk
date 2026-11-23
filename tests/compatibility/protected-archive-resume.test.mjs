import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import archiveResume from '../../apps/client/windows/electron/protected-archive-resume.cjs';

const { ProtectedArchiveResume } = archiveResume;
const connection = { serverId: 'synthetic-server' };
const cursor = () => ({ secret: Buffer.alloc(32, 7) });
const wiped = value => assert.ok(value.secret.every(byte => byte === 0));

test('archive resume is single-use and requires the same authenticated connection and exact binding', () => {
  const cache = new ProtectedArchiveResume();
  const valid = cursor();
  const walk = cache.begin(connection, 'text', 'verified-head');
  walk.retain(valid);
  walk.finish();
  assert.equal(cache.begin(connection, 'text', 'verified-head').cursor, valid);
  assert.equal(cache.begin(connection, 'text', 'verified-head').cursor, undefined);
  valid.secret.fill(0);

  for (const [session, binding] of [[connection, 'changed-policy'], [{ ...connection }, 'verified-head']]) {
    const stale = cursor();
    cache.begin(connection, 'text', 'verified-head').retain(stale);
    assert.equal(cache.begin(session, 'text', binding).cursor, undefined);
    wiped(stale);
  }
});

test('archive resume wipes evicted, expired and revoked cursors and rejects late publications', async () => {
  const cache = new ProtectedArchiveResume({ capacity: 1, lifetime: 10 });
  const first = cursor(), second = cursor(), cancelled = cursor();
  cache.begin(connection, 'first', 'head').retain(first);
  const newest = cache.begin(connection, 'second', 'head');
  newest.retain(second);
  wiped(first);
  cache.clear(connection.serverId, channelId => channelId === 'second');
  assert.ok(second.secret.some(byte => byte !== 0));
  cache.clear(connection.serverId);
  wiped(second);
  newest.retain(cancelled);
  wiped(cancelled);

  const expired = cursor();
  cache.begin(connection, 'second', 'head').retain(expired);
  await delay(30);
  assert.equal(cache.begin(connection, 'second', 'head').cursor, undefined);
  wiped(expired);
});
