// Heuristic publication guard. Review diffs as well; this is not a full secret scanner.
import { execFileSync } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const names = output => output.toString('utf8').split('\0').filter(Boolean);
let tracked, candidates;
try {
  tracked = names(git(['ls-files', '-z']));
  candidates = [...new Set([...tracked, ...names(git(['ls-files', '--others', '--exclude-standard', '-z']))])];
} catch {
  console.error('Run this check from a Git checkout (git init for a new repository).');
  process.exit(1);
}

const forbidden = /(?:^|\/)(?:node_modules|release|dist|deploy\/generated|native\/build|resources\/server|src\/generated)(?:\/|$)|(?:^|\/)CONTINUE\.md$|(?:^|\/)connection-report[^/]*\.json$|\.(?:log|exe|test|key|pem|pfx|p12|crt|cer)$/i;
const secretPatterns = [
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['stored password hash', /pbkdf2-sha256\$\d+\$[A-Za-z0-9_-]{20,}\$[A-Za-z0-9_-]{30,}/],
  ['concrete server secret', /^\s*(?:LIVEKIT_API_SECRET|VOICECORD_PASSWORD|VOICECORD_PASSWORD_HASH)\s*=\s*['"]?[A-Za-z0-9_-]{24,}/m],
  ['live room invitation', /voicecord:\/\/[^\s"'`]+\/[a-f0-9]{64}#[^\s"'`]*(?:password|e2ee)=[^\s"'`]+/i],
];
const issues = new Set();
function inspect(name, bytes, origin) {
  if (forbidden.test(name) || /(?:^|\/)\.env(?:\..*)?$/.test(name) && !name.endsWith('.example')) {
    issues.add(`${name} (${origin}): private/generated file`);
  }
  if (bytes.length > 25 * 1024 * 1024) issues.add(`${name} (${origin}): over 25 MiB; use release assets`);
  if (bytes.includes(0)) return;
  const text = bytes.toString('utf8');
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(text)) issues.add(`${name} (${origin}): possible ${label}`);
  }
}

// Check staged content independently so an unstaged edit cannot hide a staged secret.
for (const name of tracked) inspect(name, git(['show', `:${name}`]), 'index');
for (const name of candidates) {
  const full = path.join(root, name);
  let info;
  try { info = await lstat(full); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (!info.isFile()) { issues.add(`${name}: non-regular file; review manually`); continue; }
  if (info.size > 25 * 1024 * 1024) { issues.add(`${name}: over 25 MiB; use release assets`); continue; }
  inspect(name, await readFile(full), 'worktree');
}

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) issues.add('Package and lockfile versions differ');
if (pkg.license !== 'AGPL-3.0-only' || lock.packages[''].license !== pkg.license) issues.add('Expected consistent AGPL-3.0-only metadata');
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) issues.add('Expected X.Y.Z version');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${pkg.version}`) issues.add('Release tag must match package version');
for (const required of ['LICENSE', 'README.md', 'README.ru.md', 'CHANGELOG.md', 'CONTRIBUTING.md']) {
  if (!candidates.includes(required)) issues.add(`Missing public file: ${required}`);
}

if (issues.size) {
  console.error([...issues].join('\n')); // Report paths and categories, never secret values.
  process.exitCode = 1;
} else console.log(`PASS publication guard: ${candidates.length} candidate files, staged content, version ${pkg.version}. Review diffs before publishing.`);
