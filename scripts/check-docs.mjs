// Paired-language and local Markdown-link guard for public documentation.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const markdown = [];
const roots = ['docs', 'architecture', 'changelog', 'releases'];
const errors = [];
async function walk(relative) {
  const dir = path.join(root, relative);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) await walk(name);
    else if (entry.isFile() && name.endsWith('.md')) markdown.push(name);
  }
}
for (const dir of roots) await walk(dir);
markdown.push('README.md','README.ru.md','CHANGELOG.md','CHANGELOG.ru.md',
  'SECURITY.md','SECURITY.ru.md','CONTRIBUTING.md','CONTRIBUTING.ru.md',
  'website/README.md','website/README.ru.md');
const files = new Set(markdown);
for (const filename of markdown) {
  if (filename.endsWith('.en.md') && !files.has(filename.replace(/\.en\.md$/, '.ru.md'))) {
    errors.push(filename + ': missing .ru.md partner');
  }
  if (filename.endsWith('.ru.md')) {
    const en = filename.replace(/\.ru\.md$/, '.en.md');
    const defaultEn = filename.replace(/\.ru\.md$/, '.md');
    if (!files.has(en) && !files.has(defaultEn)) errors.push(filename + ': missing English partner');
  }
  if (filename.startsWith('releases/') && /^(?:client|server|manager)-v\d+\.\d+\.\d+(?:-[\w.-]+)?\.md$/.test(path.posix.basename(filename))) {
    for (const lang of ['en','ru']) {
      const counterpart = filename.replace(/\.md$/, '.' + lang + '.md');
      if (!files.has(counterpart)) errors.push(filename + ': missing ' + counterpart);
    }
    // Canonical bodies are immutable published/failed-candidate snapshots.
    continue;
  }
  if (!filename.includes('.en.') && !filename.includes('.ru.') && filename.endsWith('.md')
    && roots.some(dir => filename.startsWith(dir + '/')) && path.posix.basename(filename) !== 'README.md') {
      errors.push(filename + ': unlocalized author-facing Markdown file');
  }
  const body = await readFile(path.join(root, filename), 'utf8');
  if (body.trim().length < 100) errors.push(filename + ': suspiciously short document');
  const links = /!?\[[^\]]*\]\(([^)\n]+)\)/g;
  for (const match of body.matchAll(links)) {
    const link = match[1].trim().split(/\s+["']/)[0];
    if (/^(?:https?:|mailto:|#|data:)/i.test(link)) continue;
    const withoutFragment = link.split('#')[0].split('?')[0];
    if (!withoutFragment) continue;
    let decoded = withoutFragment;
    try { decoded = decodeURIComponent(withoutFragment); } catch {
      errors.push(filename + ': malformed link ' + link);
      continue;
    }
    const target = path.resolve(root, path.dirname(filename), decoded);
    if (!target.startsWith(root + path.sep)) {
      errors.push(filename + ': relative link escapes repository ' + link);
      continue;
    }
    try { await stat(target); }
    catch { errors.push(filename + ': broken relative link ' + link); }
  }
}
if (errors.length) {
  for (const issue of errors) console.error(issue);
  process.exitCode = 1;
} else console.log('PASS bilingual docs: ' + markdown.length + ' Markdown files; pairs and relative links valid.');
