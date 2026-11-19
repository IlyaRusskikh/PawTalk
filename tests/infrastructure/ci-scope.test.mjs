import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ciScope } from '../../tooling/ci/ci-scope.mjs';
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve('app-builder-lib/package.json'))('js-yaml');
const check = yaml.load(await readFile(new URL('../../.github/workflows/check.yml', import.meta.url), 'utf8'));
const release = yaml.load(await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'));

test('LiveKit API download entry points receive the scoped CI token', () => {
  const commands = ['npm run server:prepare', 'node tooling/build/prepare-server.mjs --livekit-only', 'npm run package'];
  for (const command of commands) {
    const step = check.jobs.windows.steps.find(step => step.run === command);
    assert.ok(step, command);
    assert.equal(step.env.GH_TOKEN, '${{ github.token }}', command);
  }
  const fixture=check.jobs.windows.steps.find(step=>step.id==='api2fixture');
  assert.ok(fixture.run.includes('apps/server/scripts/build-windows-server.mjs'));
  assert.equal(fixture.env.GH_TOKEN,'${{ github.token }}');
});

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

test('component scope fails closed and PR default retains all components', () => {
  assert.deepEqual(ciScope(), { component: 'all', client: true, server: true, manager: true, host: true, publishedServer: false });
  for (const input of ['', 'other', 'Client', 'all\n']) assert.throws(() => ciScope(input));
  assert.equal(check.on.workflow_call.inputs.component.default, 'all');
  assert.equal(check.on.workflow_dispatch.inputs.component.default, 'all');
  assert.equal(release.jobs.verify.with.component, '${{ matrix.component }}');
  for (const job of [check.jobs.server, check.jobs.windows]) {
    const scope = job.steps.find(step => step.id === 'scope');
    assert.equal(scope.run, 'node tooling/ci/ci-scope.mjs');
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
      assert.equal(steps.some(step=>step.run==='node apps/server/scripts/build-windows-server.mjs'), scope.server);
      const managerBuilds = steps.filter(step => step.run?.startsWith('node apps/manager/windows/scripts/build-manager-windows.mjs'));
      assert.equal(managerBuilds.some(step => !step.run.includes('--runtime-only')), scope.manager);
      assert.equal(managerBuilds.some(step => step.run.includes('--runtime-only')), component === 'server');
      assert.equal(commands.includes('--output-dir release/qa/api2-server'), component === 'manager');
      assert.equal(commands.includes('apps/manager/windows/scripts/windows-manager-smoke.mjs'), scope.host);
      assert.equal(commands.includes('npm run native:build'), scope.client);
      const renderer=steps.findIndex(step=>step.run==='npm run build');
      assert.ok(renderer>=0,`${component}: Client renderer is a host-test dependency`);
      const lifecycle=steps.findIndex(step=>step.run?.includes('apps/manager/windows/scripts/windows-manager-smoke.mjs'));
      if(scope.host){
        assert.ok(renderer<lifecycle,`${component}: renderer exists before native host UI checks`);
        const media=steps.findIndex(step=>step.run==='npm run server:prepare'||step.run==='node tooling/build/prepare-server.mjs --livekit-only');
        const serverBuild=steps.findIndex(step=>step.run?.includes('apps/server/scripts/build-windows-server.mjs'));
        assert.ok(media>=0&&media<serverBuild,`${component}: LiveKit exists before the actual or fixture Server is built`);
      }
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
    assert.equal(commands.includes('apps/server/scripts/docker-smoke.mjs --containers-only'), scope.server);
    assert.equal(commands.includes('docker build -f apps/server/deploy/standalone.Dockerfile -t pawtalk-server:local'), true);
    assert.equal(commands.includes('tooling/ci/prepare-server-fixture.py --github-output'), false);
    assert.equal(commands.includes('apps/manager/tests/compose_integration.py'), scope.host);
    assert.equal(commands.includes('apps/server/scripts/server-smoke.mjs'), true);
  });
}

test('prepared publisher artifact names and extraction paths match independent uploads', () => {
  for (const component of ['server', 'manager']) {
    const upload = check.jobs.windows.steps.find(step => step.with?.name === `pawtalk-${component}-windows`);
    const preparation = release.jobs[`prepare-${component}`];
    const download = preparation.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
    if (component === 'server') {
      const expression = download.with.name.match(/^\$\{\{ (.*) \}\}$/)[1];
      const name = reused => Function('needs', `return (${expression});`)({'reuse-pr':{outputs:{reused}}});
      assert.equal(name(''), upload.with.name);
      assert.equal(name('true'), release.jobs['reuse-pr'].steps.find(step=>step.id==='server').with.name);
    } else assert.equal(download.with.name, upload.with.name);
    assert.equal(download.with.path, `release/${component}`);
    assert.ok(upload.with.path.startsWith(`release/${component}/`));
    assert.ok(!upload.with.path.includes('\n'));
    const prepared = preparation.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    const publisher = release.jobs[`publish-${component}`].steps.find(step => step.with?.name === prepared.with.name);
    assert.ok(publisher, `${component} consumes complete prepared output`);
    assert.equal(publisher.with.path, `candidate/${component}`);
  }
});

test('obsolete PR checks cancel without cancelling other components, forks or manual checks', () => {
  const group = (event, component = 'all', branch = '0.9.0', repository = 'IlyaRusskikh/PawTalk') => {
    const github = { repository: 'IlyaRusskikh/PawTalk', ref_name: event === 'pull_request' ? '9/merge' : branch,
      event_name: event, event: { pull_request: { head: { ref: event === 'pull_request' ? branch : '',
        repo: { full_name: event === 'pull_request' ? repository : '' } } } } };
    return check.concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_, expression) =>
      Function('github', 'inputs', `return (${expression});`)(github, { component }));
  };
  assert.equal(check.concurrency['cancel-in-progress'], true);
  assert.equal(check.on.push, undefined);
  assert.equal(group('pull_request'), group('pull_request'));
  assert.notEqual(group('push', 'server'), group('push', 'manager'));
  assert.notEqual(group('push'), group('workflow_dispatch'));
  assert.notEqual(group('push'), group('push', 'all', 'other-branch'));
  assert.notEqual(group('push'), group('pull_request', 'all', '0.9.0', 'someone/fork'));
});
