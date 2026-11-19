import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {avatarBytes,toastXML}=createRequire(import.meta.url)('../electron/notification-appearance.cjs');
test('notification avatars accept bounded actual images and reject paths and disguised data',()=>{
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
 assert.ok(avatarBytes(png));
 for(const value of ['file:///C:/private.png','https://example.test/avatar.png','data:image/png;base64,ZmFrZQ==',png+'A'.repeat(12000)])assert.equal(avatarBytes(value),undefined);
});
test('Windows toast uses a circular sender avatar and escapes untrusted text',()=>{
 const xml=toastXML('A < B','" & </text>','file:///C:/test/a&b.png');
 assert.match(xml,/placement="appLogoOverride" hint-crop="circle"/);
 assert.match(xml,/A &lt; B/);assert.match(xml,/&quot; &amp; &lt;\/text&gt;/);assert.match(xml,/a&amp;b.png/);assert.match(xml,/<audio silent="true"/);
});
