import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ciScope } from '../scripts/ci-scope.mjs';
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve('app-builder-lib/package.json'))('js-yaml');
const check = yaml.load(await readFile(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8'));
const release = yaml.load(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));

// Evaluate the restricted boolean syntax used by these workflow conditions.
// This exercises the actual YAML guards, not a second copy of the routing table.
function enabled(step, component, runner = 'windows-2025') {
  if (!step.if) return true;
  const expression = step.if.replace(/^\s*\$\{\{/, '').replace(/\}\}\s*$/, '');
  const outputs = Object.fromEntries(Object.entries(ciScope(component)).map(([k, v]) => [k, String(v)]));
  return Function('steps', 'matrix', 'github', 'inputs', 'startsWith', `return Boolean(${expression});`)(
    { scope: { outputs } }, { runner },
    { event_name: 'push', ref: component === 'all' ? 'refs/heads/test' : `refs/tags/${component}-v1.2.3` },
    { component }, (value, prefix) => value.startsWith(prefix));
}

test('component scope fails closed and branch/PR default retains all components', () => {
  assert.deepEqual(ciScope(), { component: 'all', client: true, server: true, manager: true, host: true, publishedServer: false });
  for (const input of ['', 'other', 'Client', 'all\n']) assert.throws(() => ciScope(input));
  assert.equal(check.on.workflow_call.inputs.component.default, 'all');
  assert.equal(check.on.workflow_dispatch.inputs.component.default, 'all');
  assert.equal(release.jobs.verify.with.component, '${{ needs.plan.outputs.component }}');
  for (const job of Object.values(check.jobs)) {
    const scope = job.steps.find(step => step.id === 'scope');
    assert.equal(scope.run, 'node scripts/ci-scope.mjs');
    assert.equal(scope.env.PAWTALK_CI_COMPONENT, "${{ inputs.component || 'all' }}");
  }
});

for (const component of ['all', 'client', 'server', 'manager']) {
  test(`${component}: actual Windows YAML builds and uploads only selected release packages`, () => {
    for (const runner of ['windows-2022', 'windows-2025']) {
      const steps = check.jobs.windows.steps.filter(step => enabled(step, component, runner));
      const commands = steps.map(step => step.run || '').join('\n');
      const scope = ciScope(component);
      assert.equal(commands.includes('npm run package'), scope.client);
      assert.equal(commands.includes('node scripts/build-windows-server.mjs'), scope.server);
      const managerBuilds = steps.filter(step => step.run?.startsWith('node scripts/build-manager-windows.mjs'));
      assert.equal(managerBuilds.some(step => !step.run.includes('--runtime-only')), scope.manager);
      assert.equal(managerBuilds.some(step => step.run.includes('--runtime-only')), component === 'server');
      assert.equal(commands.includes('--windows-zip release/qa/windows-server-fixture.zip'), component === 'manager');
      assert.equal(commands.includes('scripts/windows-manager-smoke.mjs'), scope.host);
      assert.equal(commands.includes('npm run native:build'), scope.client);
      const uploads = steps.filter(step => step.uses?.startsWith('actions/upload-artifact@')).map(step => step.with.name).sort();
      const expected = runner === 'windows-2025' ? [
        ...(scope.client ? ['pawtalk-windows'] : []),
        ...(scope.server ? ['pawtalk-server-windows'] : []),
        ...(scope.manager ? ['pawtalk-manager-windows'] : []),
      ].sort() : [];
      assert.deepEqual(uploads, expected);
    }
  });
  test(`${component}: actual Linux YAML preserves relevant compatibility and host checks`, () => {
    const steps = check.jobs.server.steps.filter(step => enabled(step, component));
    const commands = steps.map(step => step.run || '').join('\n');
    const scope = ciScope(component);
    assert.equal(commands.includes('go test -race'), scope.server);
    assert.equal(commands.includes('scripts/docker-smoke.mjs --containers-only'), scope.server);
    assert.equal(commands.includes('scripts/prepare-server-fixture.py --github-output'), scope.publishedServer);
    assert.equal(commands.includes('tests/compose_integration.py'), scope.host);
    assert.equal(commands.includes('scripts/server-smoke.mjs'), true);
  });
}

test('publisher artifact names and extraction paths match independent uploads', () => {
  for (const component of ['server', 'manager']) {
    const upload = check.jobs.windows.steps.find(step => step.with?.name === `pawtalk-${component}-windows`);
    const download = release.jobs[component].steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
    assert.equal(download.with.name, upload.with.name);
    assert.equal(download.with.path, `release/${component}`);
    assert.ok(upload.with.path.startsWith(`release/${component}/`));
    assert.ok(!upload.with.path.includes('\n'));
  }
});
