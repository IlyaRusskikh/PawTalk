import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chatKey, encryptChat, decryptChat, chatImageLimit } from '../src/chat.ts';
import { inspectImage, encodeImage, decodeImage, prepareChatImage } from '../src/chatImages.ts';
const { UpdatePreferences } = createRequire(import.meta.url)('../electron/update-settings.cjs');
const { requestChat } = createRequire(import.meta.url)('../electron/chat.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jmV0AAAAASUVORK5CYII=', 'base64');

test('image replies are encrypted, bound to attachment IDs, and cannot downgrade E2EE', async () => {
  const key = await chatKey('a'.repeat(64), 'b'.repeat(32));
  const image = { id: 'c'.repeat(32), name: 'moment.png', size: png.length, ...inspectImage(png) };
  const reply = { key: 'd'.repeat(32), id: 42, author: 'Alice', text: 'A moment' };
  const packet = await encryptChat(key, '', { image, reply });
  assert.deepEqual(await decryptChat(key, packet), { key: packet.requestId, text: '', image, reply });
  assert.equal(await decryptChat(key, { ...packet, attachmentId: 'e'.repeat(32) }), undefined);
  assert.equal(await decryptChat(undefined, packet), undefined);
  const clear = await encryptChat(undefined, 'hello', { reply });
  assert.equal((await decryptChat(undefined, clear)).text, 'hello');
  assert.equal(await decryptChat(key, clear), undefined);
});

test('attachments preserve authenticated bytes and reject oversized files before reading', async () => {
  const key = await chatKey('a'.repeat(64), 'b'.repeat(32));
  const image = { id: 'c'.repeat(32), name: 'moment.png', size: png.length, ...inspectImage(png) };
  const file = new File([png], image.name, { type: image.mime });
  const encrypted = await encodeImage(key, image, file);
  assert.equal(encrypted.length, png.length + 28);
  assert.deepEqual(Buffer.from(await (await decodeImage(key, image, encrypted)).arrayBuffer()), png);
  await assert.rejects(decodeImage(key, { ...image, id: 'd'.repeat(32) }, encrypted));
  const changed = encrypted.slice(); changed[changed.length - 1] ^= 1;
  await assert.rejects(decodeImage(key, image, changed));
  let read = false;
  await assert.rejects(prepareChatImage({ size: chatImageLimit + 1, arrayBuffer() { read = true; } }), /size/);
  assert.equal(read, false);
  const bomb = Buffer.from(png); bomb.writeUInt32BE(100000, 16);
  assert.equal(inspectImage(bomb), undefined);
  assert.equal(inspectImage(Buffer.from('<svg onload="bad"/>')), undefined);
});

test('chat IPC forwards bounded page cursors and keeps attachment bytes out of history', async () => {
  const access = { protocol: 2, encrypted: false, base: 'https://example.invalid', token: 'test', profileId: 'a'.repeat(64) };
  let url;
  const fetcher = async value => { url = value; return new Response(JSON.stringify({ first: 1, last: 200, messages: [] })); };
  await requestChat(fetcher, access, { before: 100, limit: 50, profilesAfter: 0, readAfter: 80 });
  const query = new URL(url).searchParams;
  assert.equal(query.get('before'), '100'); assert.equal(query.get('limit'), '50'); assert.equal(query.get('readAfter'), '80');
  await assert.rejects(requestChat(fetcher, access, { after: 0, limit: 501 }), /cursor/);
  await assert.rejects(requestChat(fetcher, access, { attachment: { id: 'b'.repeat(32), data: new Uint8Array(chatImageLimit + 29) } }), /size/);
  const bytes = await requestChat(async () => new Response(png), access, { attachment: { id: 'b'.repeat(32) } });
  assert.deepEqual(Buffer.from(bytes), png);
});

test('automatic update preference survives restarts and rejects untyped values', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voicecord-update-pref-'));
  try {
    const file = path.join(dir, 'updates.json'); const settings = new UpdatePreferences(file);
    assert.equal(settings.enabled, true); settings.setEnabled(false);
    assert.equal(new UpdatePreferences(file).enabled, false);
    assert.throws(() => settings.setEnabled('false'));
    await writeFile(file, 'broken'); assert.equal(new UpdatePreferences(file).enabled, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
