import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const english = require('../shared/en.json');
const { t, setLanguage } = require('../shared/i18n.cjs');
test('English catalog preserves placeholders and covers localized source strings', async () => {
  const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [source, translation] of Object.entries(english)) {
    assert.deepEqual(placeholders(translation), placeholders(source), source);
    assert.ok(translation.length, source);
    if (source !== 'Русский') assert.doesNotMatch(translation, /[А-Яа-яЁё]/, source);
  }
  for (const directory of ['src', 'electron']) {
    for (const file of await readdir(new URL(`../${directory}/`, import.meta.url))) {
      if (!/\.(tsx?|cjs)$/.test(file)) continue;
      const source = await readFile(new URL(`../${directory}/${file}`, import.meta.url), 'utf8');
      for (const match of source.matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)) {
        const key = JSON.parse(match[1]);
        assert.ok(Object.hasOwn(english, key), `${file}: ${key}`);
      }
    }
  }
});
test('desktop messages switch language and interpolate without translating user data', () => {
  try {
    setLanguage('en');
    assert.equal(t('Микрофон'), 'Microphone');
    assert.equal(t('Соединение {0}', 'Иван'), "Иван's connection");
    assert.equal(t('Неверный пароль сервера'), 'Incorrect server password');
    setLanguage('ru');
    assert.equal(t('Соединение {0}', 'Alice'), 'Соединение Alice');
  } finally { setLanguage('ru'); }
});
