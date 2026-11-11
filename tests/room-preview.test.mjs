import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { hkdfSync, createCipheriv } from 'node:crypto';
const { RoomPreviews, avatar } = createRequire(import.meta.url)('../electron/room-preview.cjs');

test('preview keeps credentials in main and never falls back to public activity', async () => {
  let logins = 0, token;
  const previews = new RoomPreviews({ login: async () => { logins++; return { token: 'private-token' }; }, fetcher: async (url, options) => {
    if (url.includes('/api/preview')) { token = options.headers.Authorization; return new Response(JSON.stringify({ participants: 4, unread: 7, people: [{ name: 'Alice' }], feed: 'a'.repeat(32), encrypted: false })); }
    return new Response(JSON.stringify({ participants: 4 }));
  } });
  const first = await previews.read('bookmark', 'https://example.invalid', { after: 3, feed: 'a'.repeat(32) });
  assert.equal(first.unread, 7); assert.equal(first.people[0].name, 'Alice'); assert.equal(token, 'Bearer private-token');
  assert.equal(JSON.stringify(first).includes('private-token'), false);
  await previews.read('bookmark', 'https://example.invalid'); assert.equal(logins, 1);
  const older = new RoomPreviews({ login: async () => undefined, fetcher: async () => new Response('{"participants":0}') });
  assert.deepEqual(await older.read('old', 'https://example.invalid'), { status: 'locked' });
  const offline = new RoomPreviews({ login: async () => undefined, fetcher: async () => { throw Error('offline'); } });
  assert.deepEqual(await offline.read('offline', 'https://example.invalid'), { status: 'offline' });
});

test('revoked token and wrong bookmark credentials expose no count, names or unread data',async()=>{
 let valid=true,logins=0;const paths=[];
 const previews=new RoomPreviews({login:async address=>{logins++;return address==='wrong'?undefined:{token:valid?'old':'new'};},fetcher:async(url,options)=>{
  paths.push(url);
  if(url.endsWith('/healthz'))return new Response('ok');
  if(url.includes('/api/preview'))return valid||options.headers.Authorization==='Bearer new'?new Response(JSON.stringify({participants:1,unread:8,people:[{name:'Private Alice'}],feed:'a'.repeat(32)})):new Response('{"error":"revoked"}',{status:401});
  return new Response('{"participants":99}');
 }});
 assert.equal((await previews.read('old','https://same-room')).participants,1);
 valid=false;
 assert.deepEqual(await previews.read('old','https://same-room'),{status:'locked'});
 assert.deepEqual(await previews.read('wrong','https://same-room'),{status:'locked'});
 assert.equal(paths.some(path=>path.endsWith('/api/presence')),false);
 const deniedLogins=logins;
 await previews.read('old','https://same-room');assert.equal(logins,deniedLogins,'do not hammer login with revoked credentials');
 previews.forget('old');assert.equal((await previews.read('old','https://same-room')).participants,1);
});

test('preview avatars authenticate the profile/feed and are absent without an E2EE key', () => {
  const key = 'a'.repeat(64), feed = 'b'.repeat(32), id = 'c'.repeat(64);
  const clear = 'data:image/png;base64,aGVsbG8=';
  const secret = hkdfSync('sha256', Buffer.from(key, 'hex'), Buffer.from(feed), Buffer.from('PawTalk chat profile v1'), 32);
  const iv = Buffer.alloc(12, 7), cipher = createCipheriv('aes-256-gcm', secret, iv); cipher.setAAD(Buffer.from(id));
  const bytes = Buffer.concat([cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
  const profile = { id, nonce: iv.toString('base64'), ciphertext: bytes.toString('base64') };
  assert.equal(avatar(profile, key, feed, true), clear);
  assert.equal(avatar(profile, undefined, feed, true), undefined);
  assert.equal(avatar(profile, key, 'd'.repeat(32), true), undefined);
  assert.equal(avatar({ ...profile, id: 'e'.repeat(64) }, key, feed, true), undefined);
});
