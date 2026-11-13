import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { checkAgents } from '../scripts/check-agents.mjs';
import { testPlan } from '../scripts/test-plan.mjs';
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve('app-builder-lib/package.json'))('js-yaml');
const workflow = async name => yaml.load(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
test('agent index and native adapters resolve without duplicated knowledge files', async () => {
  await checkAgents();
  for (const name of ['CLAUDE.md', 'GEMINI.md']) assert.equal((await readFile(new URL(`../${name}`, import.meta.url), 'utf8')).trim(), '@AGENTS.md');
  for (const name of ['verify', 'compat', 'security', 'release']) {
    const text = await readFile(new URL(`../.agents/skills/pawtalk-${name}/SKILL.md`, import.meta.url), 'utf8');
    const metadata = yaml.load(text.match(/^---\r?\n([\s\S]+?)\r?\n---/)[1]);
    assert.equal(metadata.name, `pawtalk-${name}`);
    assert.equal(typeof metadata.description, 'string');
    assert.equal(typeof metadata.metadata['short-description'], 'string');
    assert.ok(Object.keys(metadata).every(key => ['name', 'description', 'metadata', 'license', 'allowed-tools'].includes(key)));
  }
});
test('verification routes docs narrowly and cross-component dependencies conservatively', () => {
  for (const file of ['docs/ARCHITECTURE.md', '.agents/skills/pawtalk-verify/SKILL.md', 'website/ru/index.html', '.github/workflows/release.yml', 'tests/release-catalog.test.mjs']) assert.deepEqual(testPlan([file]), ['infrastructure']);
  assert.deepEqual(testPlan(['src/App.tsx']), ['infrastructure', 'client']);
  assert.deepEqual(testPlan(['manager/windows/main.go']), ['infrastructure', 'manager', 'compatibility']);
  for (const file of ['server/main.go', 'shared/protocol.cjs', 'scripts/server-core.mjs', 'package-lock.json', 'unknown-config']) assert.deepEqual(testPlan([file]), ['infrastructure', 'client', 'server', 'manager', 'compatibility']);
  assert.deepEqual(testPlan(['src/App.tsx', 'src/style.css']), ['infrastructure', 'client']);
});
test('development CI runs only on PR/manual/reuse; full main/push CI is absent', async () => {
  const check = await workflow('check');
  assert.deepEqual(Object.keys(check.on).sort(), ['pull_request', 'workflow_call', 'workflow_dispatch']);
  assert.ok(check.jobs.infrastructure);
  assert.deepEqual(check.jobs.server.strategy.matrix.runner, ['ubuntu-24.04', 'ubuntu-24.04-arm']);
  assert.deepEqual(check.jobs.windows.strategy.matrix.runner, ['windows-2022', 'windows-2025']);
  assert.ok(check.jobs.server.steps.some(step => step.run?.includes('tests/compose_integration.py')));
  assert.ok(check.jobs.windows.steps.some(step => step.run?.includes('scripts/packaged-smoke.mjs')));
});
test('publication gate follows checks and preparation, scopes write permissions and preserves signed outputs', async () => {
  const release = await workflow('release');
  assert.deepEqual(release.on.push.tags, ['client-v*', 'server-v*', 'manager-v*']);
  assert.ok(release.jobs.plan.steps.some(step => step.run?.includes('git merge-base --is-ancestor')));
  assert.equal(release.jobs.verify.uses, './.github/workflows/check.yml');
  for (const component of ['client', 'server', 'manager']) {
    const job = release.jobs[component];
    assert.equal(job.environment, 'release-publish');
    assert.ok(job.needs.includes('verify'));
    if (component !== 'client') assert.ok(job.needs.includes(`prepare-${component}`));
    assert.equal(job.permissions['packages'], component === 'server' ? 'write' : undefined);
    assert.equal(job.permissions.contents, 'write');
    const command = job.steps.find(step => step.run?.includes('gh release create')).run;
    assert.match(command, /--verify-tag --draft/);
    assert.match(command, /--notes-file/);
    assert.match(command, /gh release edit .*--draft=false/);
    assert.doesNotMatch(command, /--generate-notes|--clobber/);
    assert.ok(!job.steps.some(step => Object.keys(step.env ?? {}).some(key => key.includes('PRIVATE_KEY'))));
  }
  for (const component of ['server', 'manager']) {
    const preparation = release.jobs[`prepare-${component}`];
    assert.deepEqual(preparation.needs, ['plan', 'verify']);
    assert.equal(preparation.environment, undefined);
    assert.equal(preparation.permissions?.contents ?? release.permissions.contents, 'read');
    assert.ok(preparation.steps.some(step => step.run?.includes('scripts/release-metadata.mjs')));
  }
  const image = release.jobs['prepare-server'].steps.find(step => step.uses?.startsWith('docker/build-push-action'));
  assert.equal(image.with.push, false);
  assert.equal(image.with.platforms, 'linux/amd64,linux/arm64');
  assert.match(image.with.outputs, /type=oci/);
  assert.ok(release.jobs.server.steps.some(step => step.run?.includes('skopeo copy --all --preserve-digests')));
});
test('Pages chains successful publication from main; generation must precede deployment', async () => {
  const pages = await workflow('pages');
  assert.deepEqual(pages.on.release.types, ['published']);
  assert.deepEqual(pages.on.workflow_run.workflows, ['Publish component release']);
  assert.match(pages.jobs.deploy.if, /conclusion == 'success'/);
  const steps = pages.jobs.deploy.steps;
  assert.equal(steps.find(step => step.uses?.startsWith('actions/checkout')).with.ref, 'main');
  const generate = steps.findIndex(step => step.run === 'node scripts/release-catalog.mjs');
  const verify = steps.findIndex(step => step.run === 'node scripts/check-website.mjs --catalog');
  const upload = steps.findIndex(step => step.uses?.startsWith('actions/upload-pages-artifact'));
  assert.ok(generate >= 0 && verify > generate && upload > verify);
});
test('both README languages use the same permanent component addresses without pinned asset URLs', async () => {
  const links = [];
  for (const file of ['README.md', 'README.ru.md']) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /releases\/download\//);
    links.push([...text.matchAll(/https:\/\/ilyarusskikh.github.io\/PawTalk\/downloads\/(?:#(?:client|server|manager))?/g)].map(match => match[0]).sort());
  }
  assert.deepEqual(links[0], links[1]);
});
