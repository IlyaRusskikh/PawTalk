import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const { readImage, registerImageActions } = createRequire(import.meta.url)('../electron/image-actions.cjs');
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=', 'base64');
const decoded = { getSize: () => ({ width: 1, height: 1 }), isEmpty: () => false, toPNG: () => bytes };
const nativeImage = { createFromBuffer: () => decoded };

test('image actions reject oversized, malformed and huge dimensions before native decoding', async () => {
  let decodes = 0;
  const decoder = { createFromBuffer: () => { decodes++; return decoded; } };
  for (const input of [null, { bytes: new Uint8Array(2 * 1024 * 1024 + 1) }, { bytes: new Uint8Array([1, 2, 3]) }]) await assert.rejects(readImage(input, decoder));
  const huge = Buffer.from(bytes); huge.writeUInt32BE(100000, 16);
  await assert.rejects(readImage({ bytes: huge }, decoder));
  assert.equal(decodes, 0);
  const result = await readImage({ bytes, name: '../../picture.exe' }, decoder);
  assert.equal(result.name, 'picture.png');
  assert.deepEqual(result.bytes, bytes);
});

test('image IPC authorizes before copying, preserves original bytes when saving and respects cancellation', async () => {
  const handlers = new Map(); let allowed = false, copied;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pawtalk-image-actions-'));
  const file = path.join(dir, 'saved.png'); let cancel = true;
  registerImageActions({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, authorized: () => { if (!allowed) throw Error('Unauthorized'); }, nativeImage,
    ClipboardItem: class { constructor(items) { this.items = items; } }, clipboard: { write: async value => { copied = value; } }, dialog: { showSaveDialog: async () => ({ canceled: cancel, filePath: file }) }, getWindow: () => ({}), t: value => value });
  const input = { bytes, name: 'picture.png' };
  try {
    await assert.rejects(handlers.get('chat-image-copy')({}, input), /Unauthorized/);
    assert.equal(copied, undefined); allowed = true;
    await handlers.get('chat-image-copy')({}, input); assert.deepEqual(Buffer.from(await copied[0].items['image/png'].arrayBuffer()), bytes);
    assert.equal(await handlers.get('chat-image-save')({}, input), false);
    await assert.rejects(readFile(file), /ENOENT/);
    cancel = false; assert.equal(await handlers.get('chat-image-save')({}, input), true);
    assert.deepEqual(await readFile(file), bytes);
  } finally { await unlink(file).catch(() => {}); await rmdir(dir); }
});
