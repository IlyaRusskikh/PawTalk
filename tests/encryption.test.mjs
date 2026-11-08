import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { generateMediaKey, mediaKeyID, mediaKeyBytes, invitationMediaKey } from '../shared/encryption.mjs';
const { invitation } = createRequire(import.meta.url)('../electron/address.cjs');
test('media keys are random, independent of passwords, and have matching Node/WebCrypto identifiers', async () => {
  const a = generateMediaKey(), b = generateMediaKey();
  assert.notEqual(a, b); assert.equal(mediaKeyBytes(a).length, 32);
  assert.equal(await mediaKeyID(a), createHash('sha256').update(Buffer.from(a, 'hex')).digest('hex'));
  assert.throws(() => mediaKeyBytes('weak-password'));
});
test('encrypted invitations keep key local and validate unique fields', () => {
  const key = generateMediaKey(); const link = `pawtalk://127.0.0.1:18443/${'a'.repeat(64)}#password=secret&name=Room&e2ee=${key}`;
  assert.equal(invitation(link).e2eeKey, key); assert.equal(invitationMediaKey(link), key);
  assert.equal(invitation(link).origin, 'https://127.0.0.1:18443');
  for (const bad of [link+'&e2ee='+key, link.replace(key, 'bad'), link+'&unknown=x']) assert.throws(() => invitation(bad));
});
