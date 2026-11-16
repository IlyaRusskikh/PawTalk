import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('published documentation has paired languages and valid local links', () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const check = spawnSync(process.execPath, ['scripts/check-docs.mjs'], { cwd, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + '\n' + check.stderr);
});
