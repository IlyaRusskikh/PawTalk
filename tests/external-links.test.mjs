import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { externalLinkHandler } = createRequire(import.meta.url)('../electron/external-links.cjs');

test('web links open externally while app popups remain denied', async () => {
  const opened = [], handler = externalLinkHandler(url => { opened.push(url); });
  for (const url of ['https://www.reddit.com/r/NoStupidQuestions/comments/kx7mm7/whats_the_difference_between_felid_and_feline/?tl=ru', 'http://example.com/path?a=1&b=2#part']) {
    assert.deepEqual(handler({ url }), { action: 'deny' });
    await Promise.resolve(); assert.equal(opened.at(-1), url);
  }
  const count = opened.length;
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/notepad.exe', 'data:text/html,test', 'pawtalk://room', 'mailto:test@example.com', 'https://user:password@example.com', 'https://example.com\n', 'not a URL', undefined, 'https://example.com/' + 'x'.repeat(8192)]) {
    assert.deepEqual(handler({ url }), { action: 'deny' });
  }
  await Promise.resolve(); assert.equal(opened.length, count);
});

test('browser launch failures are contained', async () => {
  for (const launch of [() => { throw Error('unavailable'); }, async () => { throw Error('unavailable'); }]) {
    assert.deepEqual(externalLinkHandler(launch)({ url: 'https://example.com/' }), { action: 'deny' });
  }
  await new Promise(resolve => setImmediate(resolve));
});
