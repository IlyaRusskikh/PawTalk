// Real native serve mode, private TLS admission, persistence and graceful control.
import assert from 'node:assert/strict';
import {readFile, writeFile, access, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {reviewServerOptions, reviewServerPaths, startReviewServer, stopReviewServer} from './review-server.mjs';
import {repositoryRoot} from '../build/server-core.mjs';

const execute = promisify(execFile);
const {checkPorts} = createRequire(import.meta.url)('../../apps/client/windows/electron/selfhost.cjs');
const profile = 'smoke-' + randomBytes(6).toString('hex');
let port;
for (let i = 0; i < 50; i++) {const candidate = 30000 + Math.floor(Math.random() * 20000); try {await checkPorts(candidate); port = candidate; break;} catch {}}
assert.ok(port, 'no free test port group');
const options = reviewServerOptions(['--profile', profile, '--port', String(port)]);
const files = reviewServerPaths(profile);
let server;
try {
  server = await startReviewServer(options, {quiet: true});
  assert.equal(server.status.initialized, false);
  await assert.rejects(startReviewServer(options, {build: false, quiet: true}), /already running/);
  const credentials = path.join(files.directory, 'synthetic-client');
  await import('node:fs/promises').then(fs => fs.mkdir(credentials));
  await writeFile(path.join(credentials, 'client-keys.json'), '{}', {mode: 0o600});
  const invitation = (await readFile(files.invitation, 'utf8')).trim();
  const join = await execute(process.execPath, ['apps/client/windows/tests/membership-host-client.cjs', 'join', credentials, invitation], {cwd: repositoryRoot, windowsHide: true, timeout: 30000});
  assert.match(join.stdout, /PASS real API 2/);
  const identity = server.status.serverId;
  await stopReviewServer(options); await server.stop(); server = undefined;
  await assert.rejects(access(files.runtime));
  server = await startReviewServer(options, {build: false, quiet: true});
  assert.equal(server.status.serverId, identity, 'restart changed persistent server identity');
  assert.equal(server.status.initialized, true);
  await assert.rejects(access(files.invitation), 'stale first-admin invitation must be removed');
  const connect = await execute(process.execPath, ['apps/client/windows/tests/membership-host-client.cjs', 'connect', credentials, server.address], {cwd: repositoryRoot, windowsHide: true, timeout: 30000});
  assert.match(connect.stdout, /PASS real API 2/);
  await stopReviewServer(options); await server.stop(); server = undefined;
  console.log('PASS native review server: current shared build, isolated persistent data, pinned TLS, encrypted chat after restart, duplicate-profile rejection and graceful stop');
} finally {
  await server?.stop();
  const allowed = path.resolve(repositoryRoot, 'release');
  if (path.dirname(path.resolve(files.directory)) !== allowed || path.basename(files.directory) !== 'review-server-' + profile) throw Error('Unsafe review smoke cleanup path');
  await rm(files.directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
}
