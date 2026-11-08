import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { UpdateRooms, normalizeRooms } = createRequire(import.meta.url)('../electron/update-rooms.cjs');
test('update favorites exclude credentials and validate origins', () => {
  for (const address of ['https://user:password@room.example', 'https://room.example/path', 'https://room.example#password=secret', 'http://room.example']) {
    assert.throws(() => normalizeRooms([{ name: 'Room', address }]));
  }
  assert.throws(() => normalizeRooms(Array(51).fill({ name: 'Room', address: 'room.example' })));
});
test('favorites persist, follow deletions, and verify invitation certificates before relay requests', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pawtalk-update-rooms-'));
  const calls = [], address = 'pawtalk://192.0.2.1:8443/' + 'a'.repeat(64);
  const options = { verify: async value => calls.push(['verify', value]), trust: value => calls.push(['trust', value]) };
  try {
    const rooms = new UpdateRooms(path.join(directory, 'rooms.json'), options);
    rooms.set([{ address, name: 'Favorite' }]);
    const reloaded = new UpdateRooms(rooms.file, options);
    assert.deepEqual(await reloaded.sources()[0].prepare(), { base: 'https://192.0.2.1:8443' });
    assert.deepEqual(calls.map(v => v[0]), ['verify', 'trust']);
    reloaded.set([]); assert.deepEqual(new UpdateRooms(rooms.file, options).sources(), []);
    rooms.verify = async () => { throw Error('Pin mismatch'); };
    await assert.rejects(rooms.sources()[0].prepare(), /Pin mismatch/);
    assert.equal(calls.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
