// Native development server, isolated from installed Server/Manager state.
import {spawn, execFile} from 'node:child_process';
import {createServer, createConnection, isIP} from 'node:net';
import {mkdir, open, readFile, writeFile, copyFile, unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {buildWindowsServer, repositoryRoot} from '../build/server-core.mjs';

const execute = promisify(execFile);
const {checkPorts} = createRequire(import.meta.url)('../../apps/client/windows/electron/selfhost.cjs');
export function reviewServerOptions(args) {
  const result = {profile: '', port: 28443, ip: '127.0.0.1', stop: false};
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split('=');
    if (flag === '--stop' && inline === undefined) {result.stop = true; continue;}
    if (!['--profile', '--port', '--ip'].includes(flag) || args[i].split('=').length > 2) throw Error('Use --profile NAME, --port PORT, --ip ADDRESS, or --stop');
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw Error(`Missing value for ${flag}`);
    result[flag.slice(2)] = flag === '--port' ? Number(value) : value;
  }
  if (result.profile && !/^[a-zA-Z0-9_-]{1,40}$/.test(result.profile)) throw Error('Profile must contain 1–40 letters, digits, underscores or hyphens');
  if (!Number.isInteger(result.port) || result.port < 1024 || result.port > 65532) throw Error('Port must be 1024..65532');
  if (!isIP(result.ip) || ['0.0.0.0', '::'].includes(result.ip)) throw Error('IP must be a specific local or LAN address');
  return result;
}
export function reviewServerPaths(profile) {
  // Validate independently of CLI callers; never accept a caller-supplied data path.
  reviewServerOptions(profile ? ['--profile', profile] : []);
  const directory = path.join(repositoryRoot, 'release', `review-server${profile ? '-' + profile : ''}`);
  return {directory, data: path.join(directory, 'data'), binary: path.join(directory, 'bin', 'pawtalk-server.exe'),
    media: path.join(directory, 'bin', 'livekit-server.exe'), runtime: path.join(directory, 'runtime.json'), invitation: path.join(directory, 'initial-admin.txt')};
}
async function run(file, args, env, timeout = 15000) {
  return (await execute(file, args, {cwd: repositoryRoot, env, windowsHide: true, timeout, maxBuffer: 1024 * 1024})).stdout.trim();
}
async function stopOrphanedReviewMedia(mediaPath) {
  // A forcibly terminated Windows server can leave LiveKit holding the binary and ports.
  // Only recover the executable belonging to this locked review profile.
  const script = `
    $ErrorActionPreference = 'Stop'
    $media = Get-CimInstance Win32_Process -Filter "Name = 'livekit-server.exe'"
    foreach ($candidate in $media) {
      if ($candidate.ExecutablePath -ne $env:PAWTALK_REVIEW_MEDIA_PATH) { continue }
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($candidate.ParentProcessId)"
      if ($parent -and $parent.CreationDate -le $candidate.CreationDate) { continue }
      $process = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
      if (!$process -or $process.Path -ne $candidate.ExecutablePath) { continue }
      try {
        $process.Kill()
        if (!$process.WaitForExit(5000)) { throw 'Orphaned review LiveKit did not exit' }
      } catch {
        if (!$process.HasExited) { throw }
      } finally {
        $process.Dispose()
      }
    }
  `;
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      {...process.env, PAWTALK_REVIEW_MEDIA_PATH: mediaPath});
  } catch (error) {
    throw Error('Could not clean up the previous review LiveKit process: ' + (error.stderr?.trim() || error.message));
  }
}
export async function stopReviewServer(options) {
  const paths = reviewServerPaths(options.profile);
  const raw = await readFile(paths.runtime, 'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(raw===null)return false;
  if (raw.length > 4096) throw Error('Invalid review server runtime record');
  const runtime = JSON.parse(raw);
  if (!/^\\\\\.\\pipe\\pawtalk-review-[a-f0-9]{32}$/.test(runtime.pipe) || !/^[a-f0-9]{64}$/.test(runtime.token)) throw Error('Invalid review server control endpoint');
  await new Promise((resolve, reject) => {
    const socket = createConnection(runtime.pipe);
    let response = '';
    socket.setTimeout(15000, () => socket.destroy(Error('Review server stop timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({action: 'stop', token: runtime.token}) + '\n'));
    socket.on('data', chunk => {response += chunk; if (response.length > 1024) socket.destroy(Error('Invalid stop response'));});
    socket.on('end', () => response.trim() === 'stopped' ? resolve() : reject(Error('Review server did not confirm shutdown')));
  });
}
export async function startReviewServer(options, {build = true, quiet = false} = {}) {
  if (process.platform !== 'win32') throw Error('Native server review currently requires Windows x64; use dev:server for Docker');
  const paths = reviewServerPaths(options.profile);
  await mkdir(paths.directory, {recursive: true});
  try {
    const previous = JSON.parse(await readFile(paths.runtime, 'utf8'));
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw Error('Invalid existing runtime record');
    try {process.kill(previous.pid, 0);} catch (error) {if (error.code !== 'ESRCH') throw error; await unlink(paths.runtime);}
  } catch (error) {if (error.code !== 'ENOENT') throw error;}
  const lock = await open(paths.runtime, 'wx').catch(error => {throw Error(error.code === 'EEXIST' ? 'This review profile is already running. Stop it with review:server -- --stop (and the same --profile).' : error.message);});
  const token = randomBytes(32).toString('hex'), pipe = '\\\\.\\pipe\\pawtalk-review-' + randomBytes(16).toString('hex');
  let child, control, stopping;
  let closed = Promise.resolve(0), spawnError;
  const stop = () => stopping ??= (async () => {
    if (child?.exitCode === null) child.stdin.end();
    const code = await closed;
    if (control?.listening) await new Promise(resolve => control.close(resolve));
    await lock.close();
    await unlink(paths.runtime).catch(error => {if (error.code !== 'ENOENT') throw error;});
    return code;
  })();
  try {
    await lock.writeFile(JSON.stringify({pid: process.pid, pipe, token}) + '\n');
    await stopOrphanedReviewMedia(paths.media);
    await checkPorts(options.port);
    await mkdir(path.dirname(paths.binary), {recursive: true});
    if (build) {
      await run(process.execPath, ['tooling/build/prepare-server.mjs', '--livekit-only'], process.env, 180000);
      await buildWindowsServer(paths.binary);
      await copyFile(path.join(repositoryRoot, 'resources/server/livekit-server.exe'), paths.media);
    }
    const env = {...process.env, PAWTALK_DATA_DIR: paths.data, PAWTALK_PUBLIC_IP: options.ip,
      PAWTALK_PORT: String(options.port), PAWTALK_LIVEKIT_EXECUTABLE: paths.media, PAWTALK_MANAGED_STDIN: 'true',
      PAWTALK_STANDALONE_AUTO_MIGRATION: 'true'};
    child = spawn(paths.binary, ['serve'], {env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    child.stdin.on('error', () => {});
    let diagnostics = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      diagnostics = (diagnostics + chunk).slice(-8000);
      if (!quiet) process.stderr.write(chunk);
    });
    closed = new Promise(resolve => {child.once('error', error => {spawnError = error; resolve(1);}); child.once('close', code => resolve(code ?? 1));});
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (spawnError || child.exitCode !== null) throw Error(`Review server failed: ${spawnError?.message || diagnostics}`);
      try {await run(paths.binary, ['serve', 'healthcheck'], env); ready = true; break;} catch {await delay(400);}
    }
    if (!ready) throw Error('Review server did not become ready');
    const status = JSON.parse(await run(paths.binary, ['serve', 'status'], env));
    const address = await run(paths.binary, ['serve', 'info'], env);
    if (!status.initialized) {
      const invitation = await run(paths.binary, ['serve', 'initial-admin'], env);
      await writeFile(paths.invitation, invitation + '\n', {mode: 0o600});
    } else await unlink(paths.invitation).catch(error => {if (error.code !== 'ENOENT') throw error;});
    control = createServer(socket => {
      let input = ''; socket.setTimeout(3000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', chunk => {
        input += chunk; if (input.length > 1024) {socket.destroy(); return;}
        if (!input.includes('\n')) return;
        try {const request = JSON.parse(input); if (request.action !== 'stop' || request.token !== token) throw Error('Unauthorized');}
        catch {socket.destroy(); return;}
        socket.setTimeout(0); socket.pause();
        // Close this client before waiting for server.close(), which waits for clients.
        child.stdin.end();
        void closed.then(() => socket.end('stopped\n'));
      });
    });
    await new Promise((resolve, reject) => {control.once('error', reject); control.listen(pipe, resolve);});
    return {paths, address, status, stop, closed};
  } catch (error) {await stop(); throw error;}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = reviewServerOptions(process.argv.slice(2));
    if (options.stop) {await stopReviewServer(options); console.log('Review server stopped; data retained.');}
    else {
      const server = await startReviewServer(options);
      console.log(`Review server ready: ${server.address}\nData: ${server.paths.data}`);
      if (server.status.maintenance) console.log('Open this server in the owner’s review Client and confirm the API 3 migration.');
      if (!server.status.initialized) console.log(`First administrator invitation: ${server.paths.invitation}\nPaste the file contents into the review Client's Join dialog. This is a private one-time link.`);
      console.log('Use npm run review in another terminal. Stop with Ctrl+C or npm run review:server -- --stop (same --profile if selected).');
      const shutdown = () => void server.stop();
      process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
      const code = await server.closed; await server.stop(); process.exitCode = code;
    }
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
