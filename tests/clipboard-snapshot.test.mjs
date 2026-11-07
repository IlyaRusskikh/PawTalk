import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { snapshotClipboard } = createRequire(import.meta.url)('../scripts/clipboard-snapshot.cjs');

class Item {
  constructor(data) { assert.ok(Object.keys(data).length > 0, 'empty ClipboardItem must never be constructed'); this.data = data; }
}
test('clipboard snapshots accept both empty Windows clipboard representations', async () => {
  for (const items of [[], [{ types: [], getType() { throw Error('must not be read'); } }]]) {
    assert.deepEqual(await snapshotClipboard({ read: async () => items }, Item), []);
  }
});
test('clipboard snapshots preserve mixed text/image formats and omit empty entries', async () => {
  const png = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  const values = { 'text/plain': new Blob(['Привет']), 'image/png': png };
  const result = await snapshotClipboard({ read: async () => [{ types: [] }, { types: Object.keys(values), getType: async type => values[type] }] }, Item);
  assert.equal(result.length, 1);
  assert.equal(await result[0].data['text/plain'].text(), 'Привет');
  assert.equal(result[0].data['image/png'], png);
});
test('unreadable clipboard contents fail before a test can replace them', async () => {
  await assert.rejects(snapshotClipboard({ read: async () => [{ types: ['image/png'], getType: async () => { throw Error('unreadable'); } }] }, Item), /unreadable/);
});
