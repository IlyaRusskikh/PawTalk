import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
export async function checkAgents() {
  const files = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursor/rules/pawtalk.mdc'];
  async function walk(dir) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(file);
      else if (file.endsWith('.md')) files.push(file);
    }
  }
  await walk('agents');
  await walk('.agents/skills');
  for (const file of files) {
    const text = await readFile(path.join(root, file), 'utf8');
    assert.ok(text.trim().length, `${file}: empty instructions`);
    for (const [, link] of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      if (/^https?:/.test(link)) continue;
      const target = path.resolve(root, path.dirname(file), link);
      assert.ok(!path.relative(root, target).startsWith('..'), `${file}: link outside repo`);
      await stat(target);
    }
    if (file.endsWith('/SKILL.md')) {
      const header = text.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
      assert.ok(header, `${file}: YAML frontmatter required`);
      const name = header[1].match(/^name: ([a-z0-9-]+)$/m)?.[1];
      assert.equal(name, path.basename(path.dirname(file)), `${file}: skill name`);
      assert.match(header[1], /^description: .{20,}$/m, `${file}: meaningful trigger description`);
      assert.match(header[1], /^metadata:\r?\n  short-description: .+$/m, `${file}: metadata`);
      assert.doesNotMatch(text, /TODO|PLACEHOLDER/, `${file}: unfinished skill`);
    }
  }
  for (const name of ['verify', 'compat', 'security', 'release']) assert.ok(files.includes(`.agents/skills/pawtalk-${name}/SKILL.md`));
  assert.ok((await readFile(path.join(root, 'AGENTS.md'), 'utf8')).length < 4000, 'Keep entry point concise');
  console.log(`PASS agent knowledge: ${files.length} entry points, rules and skill references`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkAgents();
