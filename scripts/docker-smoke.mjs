// Disposable two-container Docker integration, without Docker Compose.
// Requires a Linux Docker Engine with loopback port publishing.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { randomBytes, pbkdf2Sync, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.slice(2).some(arg => arg !== '--containers-only')) {
  throw new Error('Usage: node scripts/docker-smoke.mjs [--containers-only]');
}
const containersOnly = process.argv.includes('--containers-only');
const require = createRequire(import.meta.url);
const project = `pawtalk-smoke-${process.pid}`;
const apiName = `${project}-api`;
const mediaName = `${project}-media`;
const network = `${project}-net`;
const apiImage = `${project}-api:local`;
const folder = await mkdtemp(path.join(os.tmpdir(), 'pawtalk-docker-'));
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16);
const hash = ['pbkdf2-sha256', '600000', salt.toString('base64url'), pbkdf2Sync(password, salt, 600000, 32, 'sha256').toString('base64url')].join('$');
const key = 'test_' + randomBytes(8).toString('hex');
const secret = randomBytes(32).toString('hex');
let vite;
let networkCreated = false;
let imageBuilt = false;
function run(executable, args, { quiet = false, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    child.stdout.on('data', data => { output += data; if (!quiet) process.stdout.write(data); });
    child.stderr.on('data', data => { output += data; if (!quiet) process.stderr.write(data); });
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
  await docker(['build', '-f', 'server/Dockerfile', '-t', apiImage, '.']);
  imageBuilt = true;
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
    '-p', '127.0.0.1:8080:8080', apiImage]);
  await waitFor('http://127.0.0.1:8080/healthz');
  // Real HTTP requests against both running containers: this is not a YAML or syntax check.
  const mediaResponse = await fetch('http://127.0.0.1:7880/', { signal: AbortSignal.timeout(5000) });
  assert.equal(mediaResponse.status, 200, 'LiveKit must answer on its published loopback port');
  const apiHealth = await fetch('http://127.0.0.1:8080/healthz', { signal: AbortSignal.timeout(5000) });
  assert.deepEqual(await apiHealth.json(), { status: 'ok' });
  const connect = body => fetch('http://127.0.0.1:8080/api/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  const invalid = await connect({ nickname: 'Docker smoke', password: 'incorrect-password' });
  assert.equal(invalid.status, 401, 'invalid credentials must be rejected');
  const valid = await connect({ nickname: 'Docker smoke', password });
  assert.equal(valid.status, 200, 'correct credentials must be accepted');
  const joined = await valid.json();
  assert.equal(joined.url, 'ws://127.0.0.1:7880');
  assert.equal(joined.expiresIn, 300);
  assert.equal(joined.e2eeRequired, false);
  const jwt = joined.token.split('.');
  assert.equal(jwt.length, 3, 'server must return a signed JWT');
  assert.equal(jwt[2], createHmac('sha256', secret).update(jwt[0] + '.' + jwt[1]).digest('base64url'),
    'token must be signed by the configured LiveKit secret');
  const claims = JSON.parse(Buffer.from(jwt[1], 'base64url').toString('utf8'));
  assert.equal(claims.iss, key);
  assert.equal(claims.sub, joined.identity);
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.canSubscribe, true);
  assert.deepEqual(claims.video.canPublishSources, ['microphone']);
  assert.equal(claims.video.canUpdateOwnMetadata, false);
  const inspected = JSON.parse(await run('docker', ['inspect', apiName], { quiet: true }))[0];
  assert.equal(inspected.Config.User, '65532:65532');
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspected.HostConfig.NetworkMode, network);
  console.log('PASS real Docker containers: LiveKit, API health, rejected/accepted password, signed microphone-only token, non-root read-only API');
  if (!containersOnly) { 
  const env = { ...process.env, PAWTALK_TEST_PASSWORD: password };
  delete env.ELECTRON_RUN_AS_NODE;
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  vite.on('error', error => console.error(error.message));
  await waitFor('http://127.0.0.1:5173/tests/voice.html');
  await run(require('electron'), ['scripts/integration.cjs'], { env });
  await run(require('electron'), ['scripts/main-smoke.cjs'], { env });
  }
  await docker(['ps', '--filter', `name=${project}`]);
  await mkdir(path.join(root, 'release/qa'), { recursive: true });
  await writeFile(path.join(root, 'release/qa/docker.txt'), [
    'PASS Docker run (no Compose): two isolated containers and loopback port publishing',
    'PASS Go multi-stage Docker build and Go tests',
    'PASS non-root read-only API, LiveKit HTTP readiness, password authentication and JWT signature/grants',
    ...(containersOnly ? ['SKIP Electron client integration (--containers-only)'] : [
      'PASS two Electron clients through containerized Go + LiveKit',
      'PASS main/preload authentication against container API',
      'See integration.txt for individual audio/security checks.',
    ]),
    '',
  ].join('\n'));
  console.log('PASS disposable Docker integration; report: release/qa/docker.txt');
} catch (error) {
  console.error(error.message);
  for (const name of [apiName, mediaName]) await docker(['logs', '--tail', '30', name]).catch(() => {});
  process.exitCode = 1;
} finally {
  vite?.kill();
  for (const name of [apiName, mediaName]) await docker(['rm', '-f', name]).catch(() => {});
  if (networkCreated) await docker(['network', 'rm', network]).catch(error => { console.error(error.message); process.exitCode = 1; });
  if (imageBuilt) await run('docker', ['image', 'rm', apiImage], { quiet: true }).catch(error => { console.error(error.message); process.exitCode = 1; });
  if (path.dirname(path.resolve(folder)) === path.resolve(os.tmpdir()) && path.basename(folder).startsWith('pawtalk-docker-')) {
    await rm(folder, { recursive: true, force: true });
  }
}
