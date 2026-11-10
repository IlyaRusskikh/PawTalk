// Isolated container lifecycle test. --audio also runs two real Electron clients.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
const require = createRequire(import.meta.url);
const name = `pawtalk-server-smoke-${process.pid}`;
const volume = `${name}-data`;
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(command, args, { input, quiet = false, childEnv = env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; if (!quiet) process.stdout.write(data); });
    child.stderr.on('data', data => { if (quiet) output += data; else process.stderr.write(data); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} ${args[0]} exited ${code}: ${output.replace(/Initial room password[^\n]*/g, 'Initial room password: [redacted]')}`)));
    child.stdin.end(input);
  });
}
const docker = (args, options) => run('docker', args, options);
async function until(fn, label, timeout = 45000) {
  for (const end = Date.now() + timeout; Date.now() < end;) {
    if (await fn()) return;
    await sleep(250);
  }
  throw new Error(`Timed out: ${label}`);
}
let fingerprint;
function request(endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(`https://127.0.0.1:31443${endpoint}`, { rejectUnauthorized: false, agent: false, method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', data => text += data); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('socket', socket => socket.on('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const error = checkServerIdentity('127.0.0.1', cert);
      const actual = new X509Certificate(cert.raw).fingerprint256.replaceAll(':', '').toLowerCase();
      if (error || actual !== fingerprint) req.destroy(error || new Error('Certificate pin mismatch'));
    }));
    req.setTimeout(5000, () => req.destroy(new Error('HTTPS timeout')));
    req.on('error', reject); req.end(body && JSON.stringify(body));
  });
}
let vite;
const image = process.env.PAWTALK_TEST_IMAGE || 'pawtalk-server:local';
try {
  if (!process.env.PAWTALK_TEST_IMAGE) await docker(['build', '-f', 'server/standalone.Dockerfile', '-t', image, '.']);
  // Bridge mode makes this test work on Docker Desktop without host-network opt-in.
  await docker(['run', '-d', '--name', name, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--tmpfs', '/tmp:uid=65532,gid=65532,mode=0700', '-v', `${volume}:/data`, '-e', 'PAWTALK_PUBLIC_IP=127.0.0.1', '-e', 'PAWTALK_PORT=31443', '-p', '127.0.0.1:31443:31443', '-p', '127.0.0.1:31444:31444', '-p', '127.0.0.1:31445:31445/udp', image], { quiet: true });
  await until(async () => (await docker(['logs', name], { quiet: true })).includes('PawTalk ready'), 'server startup');
  // Use info rather than scraping logs for secrets.
  const invite = await docker(['exec', name, '/pawtalk', 'serve', 'info'], { quiet: true });
  fingerprint = invite.split('/').at(-1);
  // Rotate the generated password via stdin to avoid retaining it in test output.
  const password = 'container-smoke-' + process.pid;
  await docker(['exec', '-i', name, '/pawtalk', 'serve', 'reset-password'], { input: password, quiet: true });
  await docker(['restart', name], { quiet: true });
  await until(async () => { try { return (await request('/healthz')).status === 200; } catch { return false; } }, 'HTTPS readiness');
  await docker(['exec', name, '/pawtalk', 'serve', 'healthcheck'], { quiet: true });
  assert.equal((await request('/api/connect', { nickname: 'Smoke', password: 'wrong-password' })).status, 401);
  const joined = await request('/api/connect', { nickname: 'Smoke', password });
  assert.equal(joined.status, 200);
  assert.equal(JSON.parse(joined.text).url, 'wss://127.0.0.1:31443/rtc');
  assert.equal((await request('/rtc')).status, 200);
  const correct = fingerprint; fingerprint = '0'.repeat(64);
  await assert.rejects(request('/healthz'), /pin mismatch/); fingerprint = correct;
  assert.equal(await docker(['exec', name, '/pawtalk', 'serve', 'info'], { quiet: true }), invite);
  console.log('PASS read-only non-root container, pinned TLS, password rotation, auth, proxy, persistent invitation');
  if (process.argv.includes('--audio')) {
    vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
    vite.on('error', error => console.error(error.message));
    await until(async () => { try { return (await fetch('http://127.0.0.1:5173/tests/voice.html')).ok; } catch { return false; } }, 'Vite');
    await run(require('electron'), ['scripts/integration.cjs'], { childEnv: { ...env, PAWTALK_TEST_SERVER: 'https://127.0.0.1:31443', PAWTALK_TEST_INVITATION: invite, PAWTALK_TEST_PASSWORD: password } });
  }
  await docker(['exec', name, 'killall', '-STOP', 'livekit-server'], { quiet: true });
  assert.equal((await request('/healthz')).status, 503);
  await assert.rejects(docker(['exec', name, '/pawtalk', 'serve', 'healthcheck'], { quiet: true }));
  await docker(['exec', name, 'killall', '-CONT', 'livekit-server'], { quiet: true });
  await docker(['exec', name, 'killall', '-TERM', 'livekit-server'], { quiet: true });
  await until(async () => (await docker(['inspect', '--format', '{{.State.Running}}', name], { quiet: true })) === 'false', 'exit after media failure');
  await docker(['start', name], { quiet: true });
  await until(async () => { try { return (await request('/healthz')).status === 200; } catch { return false; } }, 'restart');
  assert.equal(await docker(['exec', name, '/pawtalk', 'serve', 'info'], { quiet: true }), invite);
  assert.equal((await request('/api/connect', { nickname: 'After restart', password })).status, 200);
  await docker(['stop', '-t', '15', name], { quiet: true });
  assert.equal(await docker(['inspect', '--format', '{{.State.ExitCode}}', name], { quiet: true }), '0');
  console.log('PASS media failure readiness, supervisor exit, restart persistence, graceful SIGTERM');
} finally {
  vite?.kill();
  await docker(['rm', '-f', name], { quiet: true }).catch(() => {});
  await docker(['volume', 'rm', volume], { quiet: true }).catch(() => {});
}
