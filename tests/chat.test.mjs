import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatKey, continuesMessageGroup, decodeHistory, decryptChat, encryptChat, readChatCursor, readChatPosition, writeChatCursor, writeChatPosition } from '../src/chat.ts';

test('encrypted edits keep the message key, use fresh nonces and preserve attachments and replies', async () => {
 const key=await chatKey('a'.repeat(64),'b'.repeat(32));
 const original=await encryptChat(key,'before');
 const extra={edited:true,reply:{key:'c'.repeat(32),id:1,author:'A',text:'quote'}};
 const edited=await encryptChat(key,'**after**',extra,original.requestId);
 assert.equal(edited.requestId,original.requestId); assert.notEqual(edited.nonce,original.nonce);
 assert.deepEqual(await decryptChat(key,edited),{key:original.requestId,text:'**after**',...extra});
 assert.equal(JSON.stringify(edited).includes('after'),false);
});

test('message groups follow identity, a five minute window and the date boundary', () => {
  const first = { id: 1, key: 'one', author: 'Alice', authorIdentity: 'alice', text: 'hello', sent: new Date(2026, 10, 7, 12).getTime() };
  const next = { ...first, id: 2, key: 'two', text: 'again', sent: first.sent + 1000 };
  assert.equal(continuesMessageGroup(first, next), true);
  assert.equal(continuesMessageGroup(first, { ...next, author: 'New nickname' }), true);
  assert.equal(continuesMessageGroup(first, { ...next, authorIdentity: 'different-alice' }), false);
  assert.equal(continuesMessageGroup(first, { ...next, sent: first.sent + 300001 }), false);
  assert.equal(continuesMessageGroup(first, { ...next, sent: first.sent - 1 }), false);
  assert.equal(continuesMessageGroup(undefined, next), false);
  assert.equal(continuesMessageGroup({ ...first, authorIdentity: undefined }, { ...next, authorIdentity: undefined }), false);
  assert.equal(continuesMessageGroup({ ...first, authorId: 'persistent' }, { ...next, authorId: 'persistent', authorIdentity: 'rejoined' }), true);
  assert.equal(continuesMessageGroup({ ...first, authorId: 'persistent' }, { ...next, authorId: 'another' }), false);
  const midnight = new Date(2026, 10, 8).getTime();
  assert.equal(continuesMessageGroup({ ...first, sent: midnight - 1 }, { ...next, sent: midnight }), false);
});

test('chat ciphertext is bound to the key, feed and request ID', async () => {
  const secret = 'a'.repeat(64), feed = 'b'.repeat(32), text = 'Привет 👋';
  const sender = await chatKey(secret, feed);
  const receiver = await chatKey(secret, feed);
  const packet = await encryptChat(sender, text);
  assert.equal(JSON.stringify(packet).includes(text), false);
  assert.deepEqual(await decryptChat(receiver, packet), { key: packet.requestId, text });
  assert.equal(await decryptChat(await chatKey('c'.repeat(64), feed), packet), undefined);
  assert.equal(await decryptChat(await chatKey(secret, 'd'.repeat(32)), packet), undefined);
  assert.equal(await decryptChat(receiver, { ...packet, requestId: 'e'.repeat(32) }), undefined);
  assert.equal(await decryptChat(receiver, { requestId: packet.requestId, text }), undefined);
});

test('an invalid ciphertext does not block the next message or reset the fetch cursor', async () => {
  const key = await chatKey('a'.repeat(64), 'b'.repeat(32));
  const packet = await encryptChat(key, 'hello');
  const rows = [
    { ...packet, requestId: 'c'.repeat(32), id: 5, author: 'Alice', sent: 42 },
    { ...packet, id: 6, author: 'Bob', sent: 43 },
  ];
  const page = await decodeHistory({ first: 5, messages: rows }, 4, key);
  assert.deepEqual(page, { first: 5, cursor: 6, messages: [{ id: 6, author: 'Bob', sent: 43, key: packet.requestId, text: 'hello' }] });
  await assert.rejects(decodeHistory({ first: 5, messages: rows.toReversed() }, 4, key), /Invalid chat record/);
});

test('the ephemeral read marker follows the feed and survives rejoining in the same client', () => {
  const room = { handle: 'first', feed: 'b'.repeat(32), ephemeral: true };
  writeChatCursor(room, 13);
  assert.equal(readChatCursor({ ...room, handle: 'rejoined' }), 13);
  assert.equal(readChatCursor({ ...room, feed: 'c'.repeat(32) }), 0);
});

test('scroll position is per feed and independent of the read marker', () => {
  const room = { handle: 'first', feed: 'd'.repeat(32), ephemeral: true };
  writeChatCursor(room, 100);
  writeChatPosition(room, { id: 32, offset: 47 });
  assert.deepEqual(readChatPosition({ ...room, handle: 'rejoined' }), { id: 32, offset: 47 });
  assert.equal(readChatCursor(room), 100);
  assert.equal(readChatPosition({ ...room, feed: 'e'.repeat(32) }), undefined);
});
