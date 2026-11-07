import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultTheme, normalizeTheme, themePresets, luminance } from '../src/theme.ts';

test('theme migrates two-color preferences and constrains custom sizing',()=>{
  const theme=normalizeTheme({accent:'#abcdef',background:'#111111',fontSize:100,radius:-10,messageSpacing:NaN,text:'url(bad)'});
  assert.equal(theme.accent,'#abcdef');assert.equal(theme.surface,defaultTheme.surface);
  assert.equal(theme.text,defaultTheme.text);assert.equal(theme.fontSize,18);assert.equal(theme.radius,4);assert.equal(theme.messageSpacing,6);
  assert.equal(normalizeTheme({background:'#ffffff'}).text,'#252b3d');
  assert.deepEqual(normalizeTheme(null),defaultTheme);
});
test('light preset has dark text and separate persisted panel/sidebar/chat colors',()=>{
  const light=themePresets.find(preset=>preset.name==='Светлая');
  assert.ok(light);assert.ok(luminance(light.background)>.8);assert.ok(luminance(light.text)<.1);
  assert.notEqual(light.sidebar,light.surface);
  const restored=normalizeTheme(JSON.parse(JSON.stringify(light)));
  for(const key of Object.keys(defaultTheme))assert.equal(restored[key],light[key]);
});

test('light semantic colors remain readable and CSS cannot bypass the configurable palette', async () => {
  const light = themePresets[5];
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  for (const key of ['text', 'accent', 'success', 'warning', 'danger']) assert.ok(contrast(light[key], light.surface) >= 4.5, key + ' contrast');
  for (const file of ['style.css', 'interface.css', 'home.css']) {
    const css = await readFile(new URL('../src/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(css, /#[\da-f]{3,8}\b|\brgba?\(/i, file + ' only uses palette colors');
    for (const rule of css.matchAll(/border-radius\s*:\s*([^;}]+)/g)) assert.ok(!/\dpx/.test(rule[1]) || rule[1].includes('--ui-radius'), 'corners follow the Appearance setting');
  }
});
