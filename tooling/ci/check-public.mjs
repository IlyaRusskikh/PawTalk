// Heuristic publication guard. Review diffs as well; this is not a full secret scanner.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, lstat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { versions } from '../release/release-contract.mjs';
const { releasePlan, parseVersion } = createRequire(import.meta.url)('../../shared/release.cjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const gitOptions = { cwd: root, windowsHide: true };
const gitBufferLimit = 32 * 1024 * 1024;
const git = args => execFileSync('git', args, { ...gitOptions, maxBuffer: gitBufferLimit });
const gitPaths = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const names = output => gitPaths.decode(output).split('\0').filter(Boolean);
let staged, untracked;
try {
  staged = git(['ls-files', '--stage', '-z']);
  untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
} catch {
  console.error('Run this check from a Git checkout (git init for a new repository).');
  process.exit(1);
}
const index = names(staged).map(entry => {
  const separator = entry.indexOf('\t');
  const [, oid, stage] = entry.slice(0, separator).split(' ');
  const name = entry.slice(separator + 1);
  if (separator < 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) || stage !== '0') {
    throw Error(`Cannot check unresolved or invalid index entry: ${JSON.stringify(name)}`);
  }
  return { name, oid };
});
const candidates = [...new Set([...index.map(entry => entry.name), ...names(untracked)])];

const forbidden = /^apps\/website\/releases\.json(?:\.tmp)?$|(?:^|\/)(?:plans|node_modules|release|dist|manager\/generated|manager\/desktop\/(?:dist|icons)|native\/build|resources\/server|src\/generated)(?:\/|$)|(?:^|\/)CONTINUE\.md$|(?:^|\/)connection-report[^/]*\.json$|\.(?:log|exe|test|key|pem|pfx|p12|crt|cer)$/i;
const secretPatterns = [
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['stored password hash', /pbkdf2-sha256\$\d+\$[A-Za-z0-9_-]{20,}\$[A-Za-z0-9_-]{30,}/],
  ['concrete server secret', /^\s*(?:LIVEKIT_API_SECRET|PAWTALK_PASSWORD(?:_HASH)?)\s*=\s*['"]?[A-Za-z0-9_-]{24,}/m],
  ['live room invitation', /pawtalk:\/\/[^\s"'`]+\/[a-f0-9]{64}#[^\s"'`]*(?:password|e2ee)=[^\s"'`]+/i],
];
const issues = new Set();
function inspect(name, bytes, origin) {
  const releaseSource = /^(?:tooling|tests)\/release\/[\w.-]+\.(?:mjs|py)$/.test(name);
  if (forbidden.test(name) && !releaseSource || /(?:^|\/)\.env(?:\..*)?$/.test(name) && !name.endsWith('.example')) {
    issues.add(`${name} (${origin}): private/generated file`);
  }
  if (bytes.length > 25 * 1024 * 1024) issues.add(`${name} (${origin}): over 25 MiB; use release assets`);
  if (bytes.includes(0)) return;
  const text = bytes.toString('utf8');
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(text)) issues.add(`${name} (${origin}): possible ${label}`);
  }
}

async function inspectIndex() {
  const batch = spawn('git', ['cat-file', '--batch'], { ...gitOptions, stdio: ['pipe', 'pipe', 'inherit'] });
  const chunks = batch.stdout[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);

  async function nextChunk() {
    const { done, value } = await chunks.next();
    if (done) throw Error('Unexpected end of Git index object stream');
    return value;
  }

  async function inspectObjects() {
    for (const { name, oid } of index) {
      // Git emits an ASCII header, exactly the declared number of bytes, then a newline.
      let headerEnd = pending.indexOf(10);
      while (headerEnd === -1 && pending.length < 128) {
        pending = Buffer.concat([pending, await nextChunk()]);
        headerEnd = pending.indexOf(10);
      }
      const [object, type, length] = pending.subarray(0, headerEnd).toString('ascii').split(' ');
      const size = Number(length);
      if (headerEnd < 0 || headerEnd >= 128 || object !== oid || type !== 'blob' || !/^\d+$/.test(length) || size > gitBufferLimit) {
        throw Error(`Cannot read staged blob: ${JSON.stringify(name)}`);
      }
      pending = pending.subarray(headerEnd + 1);
      const record = Buffer.allocUnsafe(size + 1);
      let offset = 0;
      while (offset < record.length) {
        if (!pending.length) pending = await nextChunk();
        const count = pending.copy(record, offset, 0, Math.min(pending.length, record.length - offset));
        pending = pending.subarray(count);
        offset += count;
      }
      if (record[size] !== 10) throw Error(`Invalid staged blob delimiter: ${JSON.stringify(name)}`);
      inspect(name, record.subarray(0, size), 'index');
    }
    if (pending.length || !(await chunks.next()).done) throw Error('Unexpected extra Git index object data');
  }

  try {
    const [[code]] = await Promise.all([
      once(batch, 'close'),
      pipeline(Readable.from(index.map(({ oid }) => oid + '\n')), batch.stdin),
      inspectObjects(),
    ]);
    if (code !== 0) throw Error('Git failed to read staged blobs');
  } finally {
    if (batch.exitCode === null && batch.signalCode === null) batch.kill();
  }
}

// Check staged content independently so an unstaged edit cannot hide a staged secret.
await inspectIndex();
for (const name of candidates) {
  const full = path.join(root, name);
  let info;
  try { info = await lstat(full); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (!info.isFile()) { issues.add(`${name}: non-regular file; review manually`); continue; }
  if (info.size > 25 * 1024 * 1024) { issues.add(`${name}: over 25 MiB; use release assets`); continue; }
  inspect(name, await readFile(full), 'worktree');
}

const pkg = JSON.parse(await readFile(path.join(root, 'apps/client/windows/package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const desktopVersion=JSON.parse(await readFile(path.join(root,'apps/manager/windows/desktop/package.json'),'utf8')).version;
if(desktopVersion!==(await readFile(path.join(root,'apps/manager/VERSION'),'utf8')).trim())issues.add('Manager desktop and VERSION differ');
if (pkg.version !== lock.packages['apps/client/windows']?.version) issues.add('Package and lockfile versions differ');
if (pkg.license !== 'AGPL-3.0-only' || lock.packages[''].license !== pkg.license) issues.add('Expected consistent AGPL-3.0-only metadata');
if (!parseVersion(pkg.version)) issues.add('Expected X.Y.Z or X.Y.Z-prerelease version');
for (const [component, value] of Object.entries(await versions())) if (!parseVersion(value)) issues.add('Invalid '+component+' version');
if (process.env.GITHUB_REF_TYPE === 'tag') {
  try { releasePlan(process.env.GITHUB_REF_NAME, await versions()); }
  catch { issues.add('Release tag must match its component version'); }
}
for (const required of ['LICENSE', 'README.md', 'README.ru.md', 'CHANGELOG.md', 'CONTRIBUTING.md']) {
  if (!candidates.includes(required)) issues.add(`Missing public file: ${required}`);
}

if (issues.size) {
  console.error([...issues].join('\n')); // Report paths and categories, never secret values.
  process.exitCode = 1;
} else console.log(`PASS publication guard: ${candidates.length} candidate files, staged content, version ${pkg.version}. Review diffs before publishing.`);
