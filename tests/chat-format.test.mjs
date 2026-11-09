import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineMarkdown, messageMarkdown } from '../shared/chat-format.mjs';

test('Discord-style formatting preserves nested emphasis, escapes and literal code', () => {
  assert.deepEqual(inlineMarkdown('**bold *italic***'), [{type:'bold',children:['bold ',{type:'italic',children:['italic']}]}]);
  assert.deepEqual(inlineMarkdown('\\*literal\\* `**code**`'), ['*literal* ',{type:'code',text:'**code**'}]);
  assert.deepEqual(inlineMarkdown('__u__ ~~s~~ ||secret||').filter(x=>typeof x!=='string').map(x=>x.type), ['underline','strike','spoiler']);
});
test('HTML and unsafe links remain inert text; code fences suppress formatting', () => {
  assert.deepEqual(inlineMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1))'), ['<img src=x onerror=alert(1)> [x](javascript:alert(1))']);
  assert.deepEqual(inlineMarkdown('[site](https://example.com)'), [{type:'link',url:'https://example.com',children:['site']}]);
  assert.deepEqual(messageMarkdown('```js\n**raw**\n```'), [{type:'pre',text:'**raw**'}]);
  assert.deepEqual(messageMarkdown('# Heading\n> Quote\n- item').map(x=>x.type), ['heading','quote','item']);
});
