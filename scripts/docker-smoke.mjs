// Disposable two-container Docker integration, without Docker Compose.
// Requires a Linux Docker Engine with loopback port publishing.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const project = `pawtalk-smoke-${process.pid}`;
const apiName = `${project}-api`;
const mediaName = `${project}-media`;
const network = `${project}-net`;
const folder = await mkdtemp(path.join(os.tmpdir(), 'pawtalk-docker-'));
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16);
const hash = ['pbkdf2-sha256', '600000', salt.toString('base64url'), pbkdf2Sync(password, salt, 600000, 32, 'sha256').toString('base64url')].join('$');
const key = 'test_' + randomBytes(8).toString('hex');
const secret = randomBytes(32).toString('hex');
let vite;
let networkCreated = false;
function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    child.stdout.on('data', data => { output += data; process.stdout.write(data); });
    child.stderr.on('data', data => { output += data; process.stderr.write(data); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`${path.basename(executable)} ${args[0]} failed (${code})`)));
  });
}
const docker = args => run('docker', args);
async function waitFor(url, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Service did not become ready: ' + url);
}
async function ensureFree(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`Port ${port} is busy; stop the existing dev server first`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
try {
  for (const port of [8080, 7880, 7881, 5173]) await ensureFree(port);
  await docker(['info', '--format', '{{.OSType}} {{.ServerVersion}}']);
  const sfu = `port: 7880\nbind_addresses: [0.0.0.0]\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  node_ip: 127.0.0.1\n  use_external_ip: false\nkeys:\n  ${key}: ${secret}\nroom:\n  auto_create: true\n  max_participants: 30\nlogging:\n  level: warn\n`;
  const mediaConfig = path.join(folder, 'livekit.yaml');
  await writeFile(mediaConfig, sfu, { mode: 0o600 });
  await docker(['build', '-f', 'server/Dockerfile', '-t', `${project}-api:local`, '.']);
  await docker(['network', 'create', network]);
  networkCreated = true;
  await docker(['run', '-d', '--name', mediaName, '--network', network, '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '-v', `${mediaConfig}:/etc/livekit.yaml:ro`,
    '-p', '127.0.0.1:7880:7880', '-p', '127.0.0.1:7881:7881/tcp', '-p', '127.0.0.1:7882:7882/udp',
    'livekit/livekit-server:v1.13.11', '--config', '/etc/livekit.yaml']);
  await docker(['run', '-d', '--name', apiName, '--network', network, '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '-e', 'LISTEN_ADDR=0.0.0.0:8080',
    '-e', 'LIVEKIT_URL=ws://127.0.0.1:7880', '-e', `LIVEKIT_API_KEY=${key}`,
    '-e', `LIVEKIT_API_SECRET=${secret}`, '-e', `PAWTALK_PASSWORD_HASH=${hash}`,
    '-p', '127.0.0.1:8080:8080', `${project}-api:local`]);
  await waitFor('http://127.0.0.1:8080/healthz');
  const env = { ...process.env, PAWTALK_TEST_PASSWORD: password };
  delete env.ELECTRON_RUN_AS_NODE;
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  vite.on('error', error => console.error(error.message));
  await waitFor('http://127.0.0.1:5173/tests/voice.html');
  await run(require('electron'), ['scripts/integration.cjs'], { env });
  await run(require('electron'), ['scripts/main-smoke.cjs'], { env });
  await docker(['ps', '--filter', `name=${project}`]);
  await mkdir(path.join(root, 'release/qa'), { recursive: true });
  await writeFile(path.join(root, 'release/qa/docker.txt'),
    'PASS Docker run (no Compose): two isolated containers and loopback port publishing\nPASS Go multi-stage Docker build and Go tests\nPASS non-root read-only container API and SFU\nPASS two Electron clients through containerized Go + LiveKit\nPASS main/preload authentication against container API\nSee integration.txt for individual audio/security checks.\n');
  console.log('PASS disposable Docker integration; report: release/qa/docker.txt');
} catch (error) {
  console.error(error.message);
  for (const name of [apiName, mediaName]) await docker(['logs', '--tail', '30', name]).catch(() => {});
  process.exitCode = 1;
} finally {
  vite?.kill();
  for (const name of [apiName, mediaName]) await docker(['rm', '-f', name]).catch(() => {});
  if (networkCreated) await docker(['network', 'rm', network]).catch(error => { console.error(error.message); process.exitCode = 1; });
  if (path.dirname(path.resolve(folder)) === path.resolve(os.tmpdir()) && path.basename(folder).startsWith('pawtalk-docker-')) {
    await rm(folder, { recursive: true, force: true });
  }
}
