import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('published documentation has paired languages and valid local links', () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const check = spawnSync(process.execPath, ['scripts/check-docs.mjs'], { cwd, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + '\n' + check.stderr);
});

test('prerelease locale views stay separate from publication sources in both CLIs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pawtalk-docs-regression-'));
  try {
    for (const folder of ['scripts', 'docs', 'architecture', 'changelog', 'releases', 'website']) {
      await mkdir(path.join(directory, folder));
    }
    for (const script of ['check-docs', 'check-release-notes']) {
      await cp(new URL(`../scripts/${script}.mjs`, import.meta.url), path.join(directory, `scripts/${script}.mjs`));
    }
    for (const name of ['README', 'CHANGELOG', 'SECURITY', 'CONTRIBUTING', 'website/README']) {
      for (const suffix of ['.md', '.ru.md']) {
        await writeFile(path.join(directory, name + suffix), '# Fixture\n\n' + 'Documentation fixture. '.repeat(8));
      }
    }
    const tag = 'client-v1.0.0-rc.1';
    const notes = (await readFile(new URL('../releases/client-v0.12.1.md', import.meta.url), 'utf8')).replaceAll('0.12.1', '1.0.0-rc.1');
    await writeFile(path.join(directory, `releases/${tag}.md`), notes);
    const view = `# Locale view\n\n[Publication source](${tag}.md)\n\n` + 'Human-readable release summary. '.repeat(6);
    for (const lang of ['en', 'ru']) await writeFile(path.join(directory, `releases/${tag}.${lang}.md`), view);
    const run = (script, ...args) => spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { cwd: directory, encoding: 'utf8' });
    for (const script of ['check-docs', 'check-release-notes']) {
      const result = run(script);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    const selected = run('check-release-notes', tag);
    assert.equal(selected.status, 0, selected.stdout + selected.stderr);

    await unlink(path.join(directory, `releases/${tag}.ru.md`));
    const missing = run('check-docs');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /missing .*ru\.md/);
    await writeFile(path.join(directory, `releases/${tag}.ru.md`), view);
    await writeFile(path.join(directory, `releases/${tag}.en.md`), view + '\n[Broken](missing.md)\n');
    const broken = run('check-docs');
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /broken relative link missing\.md/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
