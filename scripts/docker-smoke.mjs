// Disposable, loopback-only Docker integration. Never modifies deploy/generated.
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
const folder = await mkdtemp(path.join(os.tmpdir(), 'pawtalk-docker-'));
const file = path.join(folder, 'compose.json');
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16);
const hash = ['pbkdf2-sha256', '600000', salt.toString('base64url'), pbkdf2Sync(password, salt, 600000, 32, 'sha256').toString('base64url')].join('$');
const key = 'test_' + randomBytes(8).toString('hex');
const secret = randomBytes(32).toString('hex');
const composeArgs = ['compose', '-p', project, '-f', file];
let vite;
let started = false;
function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    child.stdout.on('data', data => { output += data; process.stdout.write(data); });
    child.stderr.on('data', data => { output += data; process.stderr.write(data); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`${path.basename(executable)} failed (${code})`)));
  });
}
async function waitFor(url, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Service did not become ready: ' + url);
}
async function ensureFree(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer(); probe.once('error', () => reject(new Error(`Port ${port} is busy; stop the existing dev server first`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
try {
  for (const port of [8080, 7880, 7881, 5173]) await ensureFree(port);
  await run('docker', ['info', '--format', '{{.OSType}} {{.ServerVersion}}']);
  await run('docker', ['compose', '-f', 'compose.yaml', 'config', '--no-env-resolution', '-q']);
  await run('docker', ['compose', '-f', 'compose.dev.yaml', 'config', '--no-env-resolution', '-q']);
  await run('docker', ['compose', '-f', 'compose.yaml', '-f', 'compose.local.yaml', 'config', '--no-env-resolution', '-q']);
  const sfu = `port: 7880\nbind_addresses: [0.0.0.0]\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  node_ip: 127.0.0.1\n  use_external_ip: false\nkeys:\n  ${key}: ${secret}\nroom:\n  auto_create: true\n  max_participants: 30\nlogging:\n  level: warn\n`;
  await writeFile(path.join(folder, 'livekit.yaml'), sfu, { mode: 0o600 });
  const config = { services: {
    api: {
      build: { context: root, dockerfile: 'server/Dockerfile' },
      ports: ['127.0.0.1:8080:8080'],
      environment: { LISTEN_ADDR: '0.0.0.0:8080', LIVEKIT_URL: 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret, PAWTALK_PASSWORD_HASH: hash.replaceAll('$', () => '$$') },
      read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
    },
    livekit: {
      image: 'livekit/livekit-server:v1.13.11',
      command: ['--config', '/etc/livekit.yaml'],
      ports: ['127.0.0.1:7880:7880', '127.0.0.1:7881:7881/tcp', '127.0.0.1:7882:7882/udp'],
      volumes: [{ type: 'bind', source: path.join(folder, 'livekit.yaml'), target: '/etc/livekit.yaml', read_only: true }],
      read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
    },
  } };
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  await run('docker', [...composeArgs, 'config', '-q']);
  started = true;
  await run('docker', [...composeArgs, 'up', '-d', '--build']);
  await waitFor('http://127.0.0.1:8080/healthz');
  const env = { ...process.env, PAWTALK_TEST_PASSWORD: password }; delete env.ELECTRON_RUN_AS_NODE;
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  vite.on('error', error => console.error(error.message));
  await waitFor('http://127.0.0.1:5173/tests/voice.html');
  await run(require('electron'), ['scripts/integration.cjs'], { env });
  await run(require('electron'), ['scripts/main-smoke.cjs'], { env });
  await run('docker', [...composeArgs, 'ps']);
  await mkdir(path.join(root, 'release/qa'), { recursive: true });
  await writeFile(path.join(root, 'release/qa/docker.txt'), 'PASS Compose production/dev/LAN validation\nPASS Go multi-stage Docker build and Go tests\nPASS non-root read-only container API and read-only SFU\nPASS two Electron clients through containerized Go + LiveKit\nPASS main/preload authentication against container API\nSee integration.txt for individual audio/security checks.\n');
  console.log('PASS disposable Docker integration; report: release/qa/docker.txt');
} catch (error) {
  console.error(error.message);
  if (started) await run('docker', [...composeArgs, 'logs', '--tail', '30']).catch(() => {});
  process.exitCode = 1;
} finally {
  vite?.kill();
  if (started) await run('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans']).catch(error => { console.error(error.message); process.exitCode = 1; });
  // Only the exact temporary directory created by this test can be removed.
  if (path.dirname(path.resolve(folder)) === path.resolve(os.tmpdir()) && path.basename(folder).startsWith('pawtalk-docker-')) await rm(folder, { recursive: true, force: true });
}
