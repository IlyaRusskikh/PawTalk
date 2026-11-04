import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { serverURL } = createRequire(import.meta.url)('../electron/address.cjs');
const { invitation } = createRequire(import.meta.url)('../electron/address.cjs');

test('room invitations carry a strict certificate pin without weakening IP/TLS validation', () => {
 const pin = 'a'.repeat(64);
 const address = `voicecord://203.0.113.10:18443/${pin}`;
 assert.equal(serverURL(address), 'https://203.0.113.10:18443');
 assert.equal(invitation(address).fingerprint, pin);
 for (const bad of [`voicecord://example.com:18443/${pin}`, `voicecord://203.0.113.10/${pin}`, `voicecord://203.0.113.10:18443/abc`, `${address}?x=1`, `${address}#x`, `voicecord://user@203.0.113.10:18443/${pin}`]) assert.throws(() => serverURL(bad));
});
test('accept IP literals and explicit TLS ports', () => {
 assert.equal(serverURL('203.0.113.10'), 'https://203.0.113.10');
 assert.equal(serverURL('203.0.113.10:8443'), 'https://203.0.113.10:8443');
 assert.equal(serverURL('[2001:db8::1]'), 'https://[2001:db8::1]');
});
test('reject plaintext, credentials, paths, redirects and arbitrary schemes', () => {
 for(const input of ['http://203.0.113.10', 'https://user:pass@203.0.113.10', 'https://203.0.113.10/api', 'https://203.0.113.10/?x=1', 'file:///etc/passwd', 'https://bad_host.example', 'https://203.0.113.10/#x']) assert.throws(() => serverURL(input));
 assert.throws(() => serverURL('http://127.0.0.1:8080'));
 assert.equal(serverURL('http://127.0.0.1:8080', true), 'http://127.0.0.1:8080');
});

test('password invitations preserve TLS pins and decode Unicode and special characters', () => {
 const pin = 'b'.repeat(64);
 const password = 'пароль & # ? / 🔑';
 const address = `voicecord://192.168.0.13:18443/${pin}#password=${encodeURIComponent(password)}&name=${encodeURIComponent('хостит Илья')}`;
 assert.equal(invitation(address).password, password);
 assert.equal(invitation(address).fingerprint, pin);
 assert.equal(serverURL(address), 'https://192.168.0.13:18443');
 assert.throws(() => invitation(address + '&unknown=value'));
 assert.throws(() => invitation(`voicecord://192.168.0.13:18443/${pin}#password=${'a'.repeat(1025)}`));
});

test('domain names use HTTPS and reject credentials and paths', () => {
 assert.equal(serverURL('voice.example.com:8443'), 'https://voice.example.com:8443');
 assert.equal(serverURL('example.com'), 'https://example.com');
 for (const value of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/api', 'https://example.com/#password=x']) assert.throws(() => serverURL(value));
});
