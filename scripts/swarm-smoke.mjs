// Disposable Swarm acceptance: real stack deploy, force-rollout, manual rollback.
// Only runs on a clean GitHub-hosted runner, NEVER on an existing Swarm/VPS.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 2 || process.platform !== 'linux' ||
    process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('Swarm smoke is restricted to disposable GitHub-hosted Linux runners');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stack = `pawtalkci${process.pid}`;
const service = `${stack}_server`;
const volume = `${stack}_data`;
const port = 35443;
const image = 'ghcr.io/ilyarusskikh/pawtalk-server:0.7.1'; // Already published: test the supported VPS image.
const folder = await mkdtemp(path.join(tmpdir(), 'pawtalk-swarm-ci-'));
const configPath = path.join(folder, 'swarm.env');
const marker = randomBytes(24).toString('hex');
const password = randomBytes(24).toString('base64url');
let initiated = false;
let volumeCreated = false;
let stackCreated = false;
let nodeId = '';

function command(executable, args, { input, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout.trim());
      const details = (stderr || stdout).replace(/Initial room password[^\n]*/gi, 'Initial room password: [redacted]').slice(-1600);
      reject(new Error(`${executable} ${args[0]} failed (${signal || code}): ${details}`));
    });
    child.stdin.end(input);
  });
}
const docker = (args, options) => command('docker', args, options);

async function eventually(description, check, timeoutMs = 125000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { lastError = error; }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${description}: ${lastError?.message || 'not ready'}`);
}

async function container() {
  const ids = (await docker(['ps', '-q', '--filter', `label=com.docker.swarm.service.name=${service}`])).trim();
  const list = ids.split(/\s+/).filter(Boolean);
  if (list.length !== 1) return null;
  return list[0];
}

async function readyContainer() {
  return eventually('healthy Swarm service', async () => {
    const id = await container();
    if (!id) return null;
    await docker(['exec', id, '/pawtalk', 'serve', 'healthcheck'], { timeoutMs: 9000 });
    return id;
  });
}

async function inspectService() {
  return JSON.parse(await docker(['service', 'inspect', service]))[0];
}
async function invitation(id) {
  const invite = await docker(['exec', id, '/pawtalk', 'serve', 'info']);
  const parsed = new URL(invite);
  assert.equal(parsed.protocol, 'pawtalk:');
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.port, String(port));
  assert.match(parsed.pathname, /^\/[a-f0-9]{64}$/);
  return parsed.pathname.slice(1);
}
async function markerExists(id) {
  const found = await docker(['exec', id, 'cat', '/data/swarm-ci-marker']);
  assert.equal(found, marker, 'the external Docker volume must survive the task replacement');
}
async function connect(fingerprint, pass) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ nickname: 'Swarm smoke', password: pass });
    const req = https.request(`https://127.0.0.1:${port}/api/connect`, {
      method: 'POST', agent: false, rejectUnauthorized: false, timeout: 7000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      try {
        const cert = response.socket.getPeerCertificate();
        assert.equal(checkServerIdentity('127.0.0.1', cert), undefined);
        assert.equal(new X509Certificate(cert.raw).fingerprint256.replaceAll(':', '').toLowerCase(), fingerprint);
      } catch (error) {
        response.resume();
        reject(error);
        return;
      }
      let text = '';
      response.on('data', data => { text += data; });
      response.on('end', () => resolve({ status: response.statusCode, body: text }));
    });
    req.on('timeout', () => req.destroy(new Error('HTTPS timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
async function assertState(id, expectedFingerprint) {
  assert.equal(await invitation(id), expectedFingerprint);
  await markerExists(id);
  assert.equal((await connect(expectedFingerprint, 'incorrect-password')).status, 401);
  const ok = await connect(expectedFingerprint, password);
  assert.equal(ok.status, 200, 'reset password must persist across Swarm tasks');
  const response = JSON.parse(ok.body);
  assert.equal(response.url, `wss://127.0.0.1:${port}/rtc`);
  assert.equal(response.expiresIn, 300);
}

function firstIPv4() {
  return Object.values(networkInterfaces()).flat().find(address =>
    address?.family === 'IPv4' && !address.internal &&
    !address.address.startsWith('169.254.'))?.address;
}

try {
  assert.equal(await docker(['info', '--format', '{{.Swarm.LocalNodeState}}']), 'inactive',
    'Refusing to touch an existing Swarm');
  const ip = firstIPv4();
  assert.ok(ip, 'Docker Swarm requires a non-loopback IPv4 for advertise-addr');
  await docker(['swarm', 'init', '--advertise-addr', ip], { timeoutMs: 60000 });
  initiated = true;
  nodeId = await docker(['info', '--format', '{{.Swarm.NodeID}}']);
  assert.match(nodeId, /^[a-z0-9]+$/);
  await docker(['node', 'update', '--label-add', 'pawtalk.data=true', nodeId]);
  await docker(['volume', 'create', volume]);
  volumeCreated = true;

  // Real entrypoint in the server guide: scripts/server-update.py deploy calls docker stack deploy.
  await writeFile(configPath, [
    `PAWTALK_IMAGE=${image}`, 'PAWTALK_RELEASE=0.7.1',
    'PAWTALK_PUBLIC_IP=127.0.0.1', `PAWTALK_PORT=${port}`,
    `PAWTALK_DATA_VOLUME=${volume}`, 'PAWTALK_E2EE=false',
    'PAWTALK_CHAT_MAX_MB=8', 'PAWTALK_AUTO_UPDATE=false',
    'PAWTALK_UPDATE_PROXY=false',
    '',
  ].join('\n'), { mode: 0o600 });
  await docker(['pull', image], { timeoutMs: 240000 });
  stackCreated = true; // Also clean up if stack deployment fails partway through.
  await command('python3', ['scripts/server-update.py', 'deploy', '--config', configPath, '--stack', stack]);
  const original = await readyContainer();
  const firstSpec = await inspectService();
  assert.equal(firstSpec.Spec.Mode.Replicated.Replicas, 1);
  assert.equal(firstSpec.Spec.Labels['io.pawtalk.managed'], 'true');
  assert.equal(firstSpec.Spec.Labels['io.pawtalk.version'], '0.7.1');
  assert.ok(firstSpec.Spec.TaskTemplate.ContainerSpec.Mounts.some(m =>
    m.Type.toLowerCase() === 'volume' && m.Source === volume && m.Target === '/data'));
  const fingerprint = await invitation(original);
  await docker(['exec', '-i', original, 'sh', '-c', 'cat > /data/swarm-ci-marker'], { input: marker });
  await markerExists(original);
  await docker(['exec', '-i', original, '/pawtalk', 'serve', 'reset-password'], { input: password });
  console.log('PASS real Swarm deployment: one healthy service, managed label, mounted external volume, pinned invitation');

  // Same published image + forced task replacement simulates a healthy rollout.
  // This checks task orchestration/persistence, not compatibility with a different binary.
  await docker(['service', 'update', '--force',
    '--label-add', 'io.pawtalk.version=0.7.2',
    '--update-order', 'stop-first', '--update-parallelism', '1',
    '--update-failure-action', 'rollback', '--update-monitor', '20s',
    '--detach=false', service], { timeoutMs: 210000 });
  const updated = await readyContainer();
  assert.notEqual(updated, original, 'rollout must replace the original task');
  assert.equal((await inspectService()).Spec.Labels['io.pawtalk.version'], '0.7.2');
  await assertState(updated, fingerprint);
  console.log('PASS Swarm force-rollout: replaced task, persistent password, state, volume and TLS identity');

  // Use the real rollback wrapper; image and labels come from the previous service spec.
  await command('python3', ['scripts/server-update.py', 'rollback', '--config', configPath, '--stack', stack],
    { timeoutMs: 210000 });
  const restored = await readyContainer();
  assert.notEqual(restored, updated, 'rollback must replace the updated task');
  assert.equal((await inspectService()).Spec.Labels['io.pawtalk.version'], '0.7.1');
  await assertState(restored, fingerprint);
  console.log('PASS Swarm rollback: previous service spec restored with unchanged state and password');
} catch (error) {
  console.error(error.message);
  if (initiated && stackCreated) {
    const tasks = await docker(['service', 'ps', '--no-trunc', service]).catch(() => '');
    console.error('Swarm task summary:', tasks.slice(-2500));
    // Never print container logs: first-start output includes a generated password.
  }
  process.exitCode = 1;
} finally {
  if (initiated) {
    if (stackCreated) {
      await docker(['stack', 'rm', stack]).catch(error => {
        console.error('Could not remove disposable Swarm stack:', error.message); process.exitCode = 1;
      });
      await eventually('Swarm service removal', async () => {
        const services = await docker(['service', 'ls', '-q', '--filter', `label=com.docker.stack.namespace=${stack}`]);
        return !services.trim();
      }, 80000).catch(error => { console.error(error.message); process.exitCode = 1; });
    }
    if (volumeCreated) {
      await eventually('test volume release', async () => {
        try { await docker(['volume', 'rm', volume]); return true; }
        catch { return false; }
      }, 80000).catch(error => { console.error(error.message); process.exitCode = 1; });
    }
    if (nodeId) await docker(['node', 'update', '--label-rm', 'pawtalk.data', nodeId])
      .catch(error => { console.error(error.message); process.exitCode = 1; });
    await docker(['swarm', 'leave', '--force'])
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
  await rm(folder, { recursive: true, force: true });
}
