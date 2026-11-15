import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createServer as createViteServer } from 'vite';
const root = process.cwd(), directory = await mkdtemp(path.join(tmpdir(), 'pawtalk-membership-app-'));
let core, electron, vite;
const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
try {
  const port = await freePort(), media = await freePort();
  const mediaConfig = path.join(directory, 'livekit.yaml');
  await writeFile(mediaConfig, `port: ${media}\nbind_addresses: [127.0.0.1]\nrtc:\n  use_external_ip: false\n  node_ip: 127.0.0.1\n  enable_loopback_candidate: true\nkeys:\n  synthetic: ${'c'.repeat(64)}\nlogging:\n  level: error\n`, { mode: 0o600 });
  core = spawn(path.join(root, 'resources/server/pawtalk-api.exe'), ['selfhost'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let coreErrors = ''; core.stderr.on('data', data => { coreErrors += data; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('selfhost readiness timeout')), 20000);
    const lines = createInterface({ input: core.stdout });
    lines.on('line', line => { try { const value = JSON.parse(line); if (value.bootstrap) { clearTimeout(timer); lines.close(); core.stdout.resume(); resolve(value); } } catch {} });
    core.once('error', reject); core.once('exit', code => { clearTimeout(timer); reject(Error(`selfhost exited ${code}: ${coreErrors}`)); });
  });
  core.stdin.write(JSON.stringify({ Port: port, MediaPort: media, Key: 'synthetic', Secret: 'c'.repeat(64), Name: 'Synthetic QA server', Addresses: ['127.0.0.1'], MediaExecutable: path.join(root, 'resources/server/livekit-server.exe'), MediaConfig: mediaConfig }) + '\n');
  const { fingerprint, bootstrap } = await ready;
  const address = `pawtalk://127.0.0.1:${port}/${fingerprint}#${new URLSearchParams({ v: '2', server: bootstrap.serverId, invite: bootstrap.inviteId, token: bootstrap.token, setup: '1' })}`;
  const input = path.join(directory, 'fixture.json'); await writeFile(input, JSON.stringify({ address, serverId: bootstrap.serverId }), { mode: 0o600 });
  const env = { ...process.env, PAWTALK_APP_TEST_DIR: directory, PAWTALK_APP_TEST_INPUT: input }; delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), ['tests/membership-app-native.cjs', '--smoke'], { windowsHide: true, env, stdio: 'inherit' });
  const timer = setTimeout(() => electron.kill(), 140000);
  const code = await new Promise((resolve, reject) => { electron.once('error', reject); electron.once('exit', resolve); }); clearTimeout(timer);
  if (code !== 0) throw Error(`native membership app smoke failed (${code})`);
  if(process.argv.includes('--audio')){
    const output=path.join(directory,'audio.json');
    await writeFile(input,JSON.stringify({mode:'audio-new',address}),{mode:0o600});
    const run=async(script,extra={})=>{
      electron=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),[script,'--smoke'],{windowsHide:true,env:{...env,...extra},stdio:'inherit'});
      const result=await new Promise((resolve,reject)=>{electron.once('error',reject);electron.once('exit',resolve);});if(result!==0)throw Error(`API 2 audio harness failed (${result})`);
    };
    await run('tests/manager-membership-client.cjs',{PAWTALK_APP_TEST_OUTPUT:output});
    vite=await createViteServer({server:{host:'127.0.0.1',port:0}});await vite.listen();
    await run('scripts/integration.cjs',{PAWTALK_API2_FIXTURE:output,PAWTALK_TEST_INVITATION:address,PAWTALK_UI_TEST_URL:`http://127.0.0.1:${vite.httpServer.address().port}`});
  }
} finally {
  await vite?.close();
  if (electron && electron.exitCode === null) electron.kill();
  if (core && core.exitCode === null) { const done = new Promise(resolve => core.once('exit', resolve)); core.stdin.end(); await Promise.race([done, new Promise(resolve => setTimeout(resolve, 4000))]); if (core.exitCode === null) core.kill(); }
  if(path.dirname(path.resolve(directory))!==path.resolve(tmpdir())||!path.basename(directory).startsWith('pawtalk-membership-app-'))throw Error('Invalid test cleanup directory');
  await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
