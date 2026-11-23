import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineMarkdown, messageMarkdown, messagePreview } from '../../../../shared/chat-format.mjs';

test('numbered markers survive independently of bullets; tables and rules stay HTML-free',()=>{
  assert.deepEqual(messageMarkdown('1. first\n2. second\n- third').map(node=>node.marker),['1.','2.','-']);
  const nodes=messageMarkdown('###### Heading\n---\n| Name | Value |\n| --- | --- |\n| **bold** | <script> |');
  assert.deepEqual(nodes.map(node=>node.type),['heading','rule','table']);
  assert.equal(nodes[0].level,6);
  assert.deepEqual(nodes[2].children[1].children[1].children,['<script>']);
});

test('notification previews remove formatting, preserve literals and hide spoilers',()=>{
  assert.equal(messagePreview('**bold** __under__ *italic* ~~gone~~ [label](https://example.test)'),'bold under italic gone label');
  assert.equal(messagePreview('\\*literal\\* `**code**`'),'*literal* **code**');
  assert.equal(messagePreview('before ||secret|| after','[spoiler]'),'before [spoiler] after');
  assert.equal(messagePreview('# Heading\n> Quote\n- Item\n```js\nconst x = 1;\n```'),'Heading Quote Item const x = 1;');
});

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

test('verified mention offsets survive rich text without styling duplicates or changing a link target', () => {
  const text = '# @Friend **@Friend**\n| [@Friend](https://example.test/@Friend) | Col |\n| --- | --- |';
  const boldMention = text.indexOf('@Friend', text.indexOf('**'));
  const linkMention = text.indexOf('@Friend', text.indexOf('['));
  const [heading, table] = messageMarkdown(text, [
    { start: boldMention, end: boldMention + 7 },
    { start: linkMention, end: linkMention + 7 },
  ]);
  assert.deepEqual(heading.children, ['@Friend ', { type: 'bold', children: [{ type: 'mention', text: '@Friend' }] }]);
  assert.deepEqual(table.children[0].children[0].children,
    [{ type: 'link', url: 'https://example.test/@Friend', children: [{ type: 'mention', text: '@Friend' }] }]);
});
