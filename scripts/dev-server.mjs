// One bundled Go/LiveKit container for localhost development; VPS uses Compose.
// --smoke exercises this exact docker run configuration with a temporary volume and port.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';

const flags = process.argv.slice(2);
if (flags.some(flag => !['--build', '--smoke'].includes(flag)) ||
    flags.includes('--smoke') && flags.includes('--build')) {
  console.error('Usage: npm run dev:server [-- --build | --smoke]');
  process.exit(2);
}
const build = flags.includes('--build');
const smoke = flags.includes('--smoke');
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// CI builds this exact standalone image first (scripts/server-smoke.mjs).
const image = smoke ? 'pawtalk-server:local' : build ? 'pawtalk-server:dev'
  : `ghcr.io/ilyarusskikh/pawtalk-server:${version}`;
const name = smoke ? `pawtalk-dev-smoke-${process.pid}` : 'pawtalk-dev-server';
const volume = smoke ? `${name}-data` : 'pawtalk-dev-server-data';
const port = smoke ? 32443 : 18443;

function docker(args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true,
    });
    let output = '';
    if (capture) {
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
    }
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim())
      : reject(new Error(`docker ${args[0]} exited with code ${code}`)));
  });
}

async function pinnedHealthcheck(fingerprint) {
  await new Promise((resolve, reject) => {
    const req = https.get(`https://127.0.0.1:${port}/healthz`, {
      rejectUnauthorized: false, timeout: 5000, agent: false,
    }, response => {
      try {
        const certificate = response.socket.getPeerCertificate();
        assert.equal(checkServerIdentity('127.0.0.1', certificate), undefined,
          'server certificate must match localhost');
        const actual = new X509Certificate(certificate.raw).fingerprint256
          .replaceAll(':', '').toLowerCase();
        assert.equal(actual, fingerprint, 'TLS certificate must match the invitation pin');
        assert.equal(response.statusCode, 200, 'media and API health must be ready');
      } catch (error) {
        response.resume();
        reject(error);
        return;
      }
      let body = '';
      response.on('data', data => { body += data; });
      response.on('end', () => {
        try {
          assert.deepEqual(JSON.parse(body), { status: 'ok' });
          resolve();
        } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('localhost HTTPS timed out')));
    req.on('error', reject);
  });
}

let started = false;
try {
  if (build) await docker(['build', '-f', 'server/standalone.Dockerfile', '-t', image, '.']);
  if (!smoke) {
    console.log('Local development only: this server is exposed on 127.0.0.1.');
    console.log('On first start, save the generated password from the logs.');
    console.log('In another terminal: npm run dev. Invitation: docker exec pawtalk-dev-server /pawtalk serve info');
    console.log('Keep volume pawtalk-dev-server-data to retain the room identity and chat.');
  }
  const args = [
    'run', ...(smoke ? ['-d'] : []), '--rm', '--name', name,
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--tmpfs', '/tmp:uid=65532,gid=65532,mode=0700',
    '-v', `${volume}:/data`,
    '-e', 'PAWTALK_PUBLIC_IP=127.0.0.1', '-e', `PAWTALK_PORT=${port}`,
    '-p', `127.0.0.1:${port}:${port}/tcp`,
    '-p', `127.0.0.1:${port + 1}:${port + 1}/tcp`,
    '-p', `127.0.0.1:${port + 2}:${port + 2}/udp`, image,
  ];
  if (!smoke) {
    await docker(args);
  } else {
    await docker(args, true);
    started = true;
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        await docker(['exec', name, '/pawtalk', 'serve', 'healthcheck'], true);
        ready = true;
        break;
      } catch { await delay(500); }
    }
    assert.ok(ready, 'Docker dev server failed to become ready within 40 seconds');
    const invite = await docker(['exec', name, '/pawtalk', 'serve', 'info'], true);
    const fingerprint = invite.match(/\/([a-f0-9]{64})$/)?.[1];
    assert.ok(fingerprint, 'dev server must generate a pinned invitation');
    await pinnedHealthcheck(fingerprint);
    const inspected = JSON.parse(await docker(['inspect', name], true))[0];
    assert.equal(inspected.Config.User, '65532:65532');
    assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspected.HostConfig.PortBindings[`${port}/tcp`][0].HostIp, '127.0.0.1');
    assert.equal(inspected.HostConfig.PortBindings[`${port + 2}/udp`][0].HostIp, '127.0.0.1');
    console.log('PASS dev-server docker run: HTTPS, pinned certificate, Go/LiveKit health, non-root, read-only, localhost-only ports');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (smoke) {
    if (started) await docker(['rm', '-f', name], true).catch(error => {
      console.error('Failed to clean up dev smoke container:', error.message);
      process.exitCode = 1;
    });
    await docker(['volume', 'rm', volume], true).catch(error => {
      // A run failure before volume creation should not mask the original error.
      if (started) { console.error('Failed to clean up dev smoke volume:', error.message); process.exitCode = 1; }
    });
  }
}
