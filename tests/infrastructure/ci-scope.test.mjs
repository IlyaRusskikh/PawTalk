import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ciScope } from '../../tooling/ci/ci-scope.mjs';
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve('app-builder-lib/package.json'))('js-yaml');
const check = yaml.load(await readFile(new URL('../../.github/workflows/check.yml', import.meta.url), 'utf8'));
const release = yaml.load(await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'));
const serverWindows = check.jobs['windows-server'];
const clientWindows = check.jobs['windows-client'];
const managerWindows = check.jobs['windows-manager'];
const windowsJobs = [serverWindows, clientWindows, managerWindows];
const windowsSteps = windowsJobs.flatMap(job => job.steps);

test('LiveKit API download entry points receive the scoped CI token', () => {
  const commands = ['npm run server:prepare', 'node tooling/build/prepare-server.mjs --livekit-only', 'npm run package'];
  for (const command of commands) {
    const step = windowsSteps.find(step => step.run === command);
    assert.ok(step, command);
    assert.equal(step.env.GH_TOKEN, '${{ github.token }}', command);
  }
});

// Evaluate the restricted boolean syntax used by these workflow conditions.
// This exercises the actual YAML guards, not a second copy of the routing table.
function evaluate(value, component, runner = 'windows-2025') {
  const expression = value.replace(/^\s*\$\{\{/, '').replace(/\}\}\s*$/, '');
  const outputs = Object.fromEntries(Object.entries(ciScope(component)).map(([k, v]) => [k, String(v)]));
  return Function('steps', 'matrix', 'github', 'inputs', 'startsWith', 'format', `return (${expression});`)(
    { scope: { outputs } }, { runner },
    { event_name: 'push', ref: component === 'all' ? 'refs/heads/test' : `refs/tags/${component}-v1.2.3` },
    { component }, (value, prefix) => value.startsWith(prefix),
    (pattern, value) => pattern.replace('{0}', value));
}

function enabled(step, component, runner) {
  return !step.if || Boolean(evaluate(step.if, component, runner));
}

function artifactName(step, component, runner) {
  const name = step.with.name;
  return name.startsWith('${{') ? evaluate(name, component, runner) : name;
}

test('component scope fails closed and PR default retains all components', () => {
  assert.deepEqual(ciScope(), { component: 'all', client: true, server: true, manager: true, host: true, publishedServer: false });
  for (const input of ['', 'other', 'Client', 'all\n']) assert.throws(() => ciScope(input));
  assert.equal(check.on.workflow_call.inputs.component.default, 'all');
  assert.equal(check.on.workflow_dispatch.inputs.component.default, 'all');
  assert.equal(release.jobs.verify.with.component, '${{ matrix.component }}');
  for (const job of [check.jobs.server, ...windowsJobs]) {
    const scope = job.steps.find(step => step.id === 'scope');
    assert.equal(scope.run, 'node tooling/ci/ci-scope.mjs');
    assert.equal(scope.env.PAWTALK_CI_COMPONENT, "${{ inputs.component || 'all' }}");
  }
});

test('Windows Client and Manager run independently after Server packaging and gate both required checks', () => {
  assert.equal(serverWindows.needs, undefined);
  for (const job of [clientWindows, managerWindows]) assert.equal(job.needs, 'windows-server');
  const gate = check.jobs.windows;
  assert.deepEqual(gate.needs, ['windows-server', 'windows-client', 'windows-manager']);
  assert.deepEqual(gate.strategy.matrix.runner, ['windows-2022', 'windows-2025']);
  assert.equal(gate.if, '${{ always() }}');
  for (const job of windowsJobs) assert.deepEqual(job.strategy.matrix.runner, gate.strategy.matrix.runner);
});

for (const component of ['all', 'client', 'server', 'manager']) {
  test(`${component}: actual Windows YAML builds and uploads only selected release packages`, () => {
    for (const runner of ['windows-2022', 'windows-2025']) {
      const steps = windowsSteps.filter(step => enabled(step, component, runner));
      const commands = steps.map(step => step.run || '').join('\n');
      const scope = ciScope(component);
      assert.equal(commands.includes('npm run package'), scope.client);
      const hostSteps = managerWindows.steps.filter(step => enabled(step, component, runner));
      const clientSteps = clientWindows.steps.filter(step => enabled(step, component, runner));
      const coreTest = step => step.name === 'Verify shared Go core on native Windows';
      const hostCoreTest = hostSteps.findIndex(coreTest);
      const clientCoreTest = clientSteps.findIndex(coreTest);
      assert.equal(hostCoreTest >= 0, scope.server);
      assert.equal(clientCoreTest >= 0, component === 'client');
      if (scope.server) {
        const download = hostSteps.findIndex(step => step.name === 'Download Windows Server package');
        const livekit = hostSteps.findIndex(step => step.name === 'Extract packaged LiveKit for native Go tests');
        const electron = hostSteps.findIndex(step => step.name === 'Install Electron with retries');
        assert.ok(download >= 0 && download < livekit && livekit < hostCoreTest);
        assert.ok(electron >= 0 && electron < hostCoreTest);
      }
      if (component === 'client') {
        const media = clientSteps.findIndex(step => step.run === 'npm run server:prepare');
        assert.ok(media >= 0 && media < clientCoreTest);
      }
      assert.equal(steps.some(step=>step.run==='node apps/server/scripts/build-windows-server.mjs'), scope.host);
      const managerBuilds = steps.filter(step => step.run?.startsWith('node apps/manager/windows/scripts/build-manager-windows.mjs'));
      assert.deepEqual(managerBuilds.map(step => step.run), [
        ...(scope.manager ? [
          'node apps/manager/windows/scripts/build-manager-windows.mjs',
          'node apps/manager/windows/scripts/build-manager-windows.mjs --tui-only',
        ] : []),
        ...(component === 'server' ? ['node apps/manager/windows/scripts/build-manager-windows.mjs --runtime-only'] : []),
      ]);
      assert.equal(commands.includes('apps/manager/windows/scripts/windows-manager-smoke.mjs'), scope.host);
      assert.equal(commands.includes('npm run native:build'), scope.client);
      const renderer = hostSteps.findIndex(step => step.run === 'npm run build');
      const lifecycle = hostSteps.findIndex(step => step.run?.includes('apps/manager/windows/scripts/windows-manager-smoke.mjs'));
      const tuiBootstrap = hostSteps.findIndex(step => step.run?.includes('windows-tui/pawtalkctl.exe --self-test'));
      if (scope.manager) {
        assert.ok(hostSteps.indexOf(managerBuilds[1]) < tuiBootstrap && tuiBootstrap < lifecycle);
        assert.match(hostSteps[lifecycle].run, /--installer/);
      } else {
        assert.equal(tuiBootstrap, -1);
      }
      if(scope.host){
        assert.ok(renderer >= 0 && renderer < lifecycle, `${component}: renderer exists before native host UI checks`);
        const media=steps.findIndex(step=>step.run==='npm run server:prepare'||step.run==='node tooling/build/prepare-server.mjs --livekit-only');
        const serverBuild=steps.findIndex(step=>step.run?.includes('apps/server/scripts/build-windows-server.mjs'));
        assert.ok(media>=0&&media<serverBuild,`${component}: LiveKit exists before the actual or fixture Server is built`);
      }
      const serverArtifact = scope.server
        ? (runner === 'windows-2025' ? 'pawtalk-server-windows' : 'pawtalk-server-windows-2022')
        : `pawtalk-server-fixture-${runner}`;
      const uploads = steps.filter(step => step.uses?.startsWith('actions/upload-artifact@')).map(step => artifactName(step, component, runner));
      const expected = [
        ...(scope.host ? [serverArtifact] : []),
        ...(scope.client && runner === 'windows-2025' ? ['pawtalk-windows'] : []),
        ...(scope.manager && runner === 'windows-2025' ? ['pawtalk-manager-windows'] : []),
      ];
      assert.deepEqual(uploads.sort(), expected.sort());
      for (const [job, expectedDownload] of [[clientWindows, component === 'all'], [managerWindows, scope.host]]) {
        const downloads = job.steps.filter(step => step.uses?.startsWith('actions/download-artifact@') && enabled(step, component, runner));
        assert.deepEqual(downloads.map(step => artifactName(step, component, runner)), expectedDownload ? [serverArtifact] : []);
      }
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
    assert.equal(commands.includes('infocmp xterm-256color'), scope.host);
    assert.equal(commands.includes('apps/server/scripts/server-smoke.mjs'), true);
  });
}

test('prepared publisher artifact names and extraction paths match independent uploads', () => {
  for (const component of ['server', 'manager']) {
    const upload = check.jobs[`windows-${component}`].steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    const preparation = release.jobs[`prepare-${component}`];
    const download = preparation.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
    if (component === 'server') {
      const expression = download.with.name.match(/^\$\{\{ (.*) \}\}$/)[1];
      const name = reused => Function('needs', `return (${expression});`)({'reuse-pr':{outputs:{reused}}});
      assert.equal(name(''), artifactName(upload, component, 'windows-2025'));
      assert.equal(name('true'), release.jobs['reuse-pr'].steps.find(step=>step.id==='server').with.name);
    } else assert.equal(download.with.name, upload.with.name);
    assert.equal(download.with.path, `release/${component}`);
    const packages = upload.with.path.trim().split('\n');
    assert.deepEqual(packages, component === 'manager' ? [
      'release/manager/PawTalk.Server.Manager.Setup.*.exe',
      'release/manager/PawTalk.Server.Manager.TUI.Setup.*.exe',
    ] : ['release/server/PawTalk.Server.*.windows-x64.zip']);
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
