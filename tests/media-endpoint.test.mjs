import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { mediaEndpoint } = createRequire(import.meta.url)('../electron/media-endpoint.cjs');

test('standalone public /rtc address stays on the LAN or loopback API origin', () => {
 for (const base of ['https://192.0.2.10:18443','https://127.0.0.1:23443','https://[::1]:18443']) {
  assert.equal(mediaEndpoint('wss://203.0.113.10:18443/rtc',base).toString(),base.replace('https:','wss:')+'/rtc');
 }
 assert.equal(mediaEndpoint('wss://203.0.113.10:18443/rtc','https://203.0.113.10:18443').toString(),'wss://203.0.113.10:18443/rtc');
 assert.equal(mediaEndpoint('ws://127.0.0.1:7880','http://127.0.0.1:8080',true).toString(),'ws://127.0.0.1:7880/');
});
test('never follow a foreign endpoint, credentials, parameters or insecure production media', () => {
 for(const value of ['wss://evil.example/other','wss://user:pass@evil.example/rtc','wss://evil.example/rtc?redirect=1','wss://evil.example/rtc#x','ws://evil.example/rtc','not a URL']) {
  assert.throws(()=>mediaEndpoint(value,'https://192.0.2.10:18443'),{code:'PAWTALK_MEDIA_ADDRESS'});
 }
});
