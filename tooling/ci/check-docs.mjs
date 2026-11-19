// Paired-language and local Markdown-link guard for public documentation.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isCanonicalNotesFile } from './check-release-notes.mjs';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const markdown = [];
const roots = ['docs', 'architecture', 'changelog', 'releases'];
const errors = [];
// Ignore leftover build/runtime directories that a clean checkout never contains.
// Source archives/standalone fixtures without Git retain filesystem validation.
let sourceTargets;
try {
  const top = execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  const canonical=value=>{const resolved=realpathSync.native(value);return process.platform==='win32'?resolved.toLowerCase():resolved;};
  if(canonical(top)===canonical(root)){
    sourceTargets=new Set();
    const paths=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024});
    for(const file of paths.split('\0').filter(Boolean)){
      let entry=file;while(entry&&entry!=='.'){sourceTargets.add(entry);entry=path.posix.dirname(entry);}
    }
  }
} catch { /* A source archive has no Git index. */ }

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
  'apps/website/README.md','apps/website/README.ru.md');
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
  if (filename.startsWith('releases/') && isCanonicalNotesFile(path.posix.basename(filename))) {
    for (const lang of ['en','ru']) {
      const counterpart = filename.replace(/\.md$/, '.' + lang + '.md');
      if (!files.has(counterpart)) errors.push(filename + ': missing ' + counterpart);
    }
    // Preserve canonical publication sources and frozen failed-candidate bodies.
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
    try {
      const relative=path.relative(root,target).split(path.sep).join('/');
      if(sourceTargets&&!sourceTargets.has(relative))throw Error('not a source target');
      await stat(target);
    }
    catch { errors.push(filename + ': broken relative link ' + link); }
  }
}
if (errors.length) {
  for (const issue of errors) console.error(issue);
  process.exitCode = 1;
} else console.log('PASS bilingual docs: ' + markdown.length + ' Markdown files; pairs and relative links valid.');
