import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function testPlan(paths) {
  const suites = new Set(['infrastructure']);
  const scripts = new Set(['check-docs', 'check-release-notes', 'check-agents', 'check-public', 'check-website', 'release-catalog', 'release-image-smoke', 'release-candidate', 'candidate-origin', 'pr-candidate', 'release-contract', 'release-metadata', 'website-smoke', 'test-plan']);
  const tests = new Set(['documentation', 'release-notes', 'agent-infrastructure', 'release-catalog', 'ci-scope', 'release-routing', 'release-metadata', 'release-candidate', 'candidate-origin']);
  for (const raw of paths) {
    const file = raw.replaceAll('\\', '/');
    if (/^(?:agents\/|\.agents\/|\.cursor\/|apps\/website\/|docs\/|architecture\/|changelog\/|releases\/|\.github\/)|^(?:AGENTS|CLAUDE|GEMINI|README|CONTRIBUTING|SECURITY|CHANGELOG)(?:\.ru)?\.md$|^\.gitignore$/.test(file)) continue;
    if (scripts.has(file.match(/^tooling\/(?:ci|release)\/(.+)\.mjs$/)?.[1]) || tests.has(file.match(/^tests\/(?:infrastructure|release)\/(.+)\.test\.mjs$/)?.[1]) || file === 'tooling/release/extract-candidate.py') continue;
    if (/^apps\/client\//.test(file)) suites.add('client');
    else if (/^apps\/manager\//.test(file)) { suites.add('manager'); suites.add('compatibility'); }
    else { for (const suite of ['client', 'server', 'manager', 'compatibility']) suites.add(suite); }
  }
  return [...suites];
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const paths = args[0] === '--diff' ? [...new Set([execFileSync('git', ['diff', '--name-only', args[1] ?? 'origin/main'], { encoding: 'utf8', windowsHide: true }), execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', windowsHide: true })].join('\n').split('\n').filter(Boolean))] : args;
  if (!paths.length) throw Error('Supply changed paths or --diff <base>; no changes found');
  console.log(JSON.stringify({ paths, suites: testPlan(paths), instructions: 'agents/testing/README.md', note: 'Selection only; run applicable check.yml integration steps. --diff includes tracked working changes and untracked nonignored paths.' }, null, 2));
}
