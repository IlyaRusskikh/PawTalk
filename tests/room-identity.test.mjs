import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {roomIdentity}=createRequire(import.meta.url)('../electron/room-identity.cjs');
const pin='a'.repeat(64),feed='b'.repeat(32);
test('verified native room is stable across LAN, public and loopback invitations',()=>{
 const lan=roomIdentity('https://192.0.2.10:18443',pin,feed);
 assert.equal(lan.roomId,roomIdentity('https://203.0.113.10:18443',pin,feed).roomId);
 assert.equal(lan.roomId,roomIdentity('https://127.0.0.1:18443',pin,feed).roomId);
 assert.equal(lan.bookmarkAddress,`pawtalk://192.0.2.10:18443/${pin}`);
 assert.notEqual(lan.roomId,roomIdentity('https://192.0.2.10:18443','c'.repeat(64),feed).roomId);
 assert.notEqual(lan.roomId,roomIdentity('https://192.0.2.10:18443',pin,'d'.repeat(32)).roomId);
});
test('domain bookmarks remain HTTPS and survive CA certificate renewal',()=>{
 const current=roomIdentity('https://voice.example.com',pin,feed);
 const renewed=roomIdentity('https://voice.example.com','e'.repeat(64),feed);
 assert.equal(current.bookmarkAddress,'https://voice.example.com');
 assert.equal(current.roomId,renewed.roomId);
 assert.notEqual(current.roomId,roomIdentity('https://other.example.com',pin,feed).roomId);
});
