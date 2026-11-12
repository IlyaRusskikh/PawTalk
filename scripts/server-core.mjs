// One source tree, toolchain and build command for both Windows hosting modes.
import { access, copyFile, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';

export const repositoryRoot = path.resolve(import.meta.dirname, '..');

export async function serverDefinition(root = repositoryRoot) {
  const dockerfile = await readFile(path.join(root, 'server/standalone.Dockerfile'), 'utf8');
  const goVersion = dockerfile.match(/^FROM golang:(\d+\.\d+\.\d+)-alpine AS build\r?$/m)?.[1];
  const livekitVersion = dockerfile.match(/^FROM livekit\/livekit-server:v(\d+\.\d+\.\d+) AS media\r?$/m)?.[1];
  const version = (await readFile(path.join(root, 'server/VERSION'), 'utf8')).trim();
  if (!goVersion || !livekitVersion || !/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid shared Server version/toolchain definition');
  // Include paths and byte hashes: renaming or changing any Go build input changes the receipt.
  const inputs = [];
  async function visit(directory) {
    for (const entry of await readdir(path.join(root, 'server', directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile() && (/\.go$/.test(entry.name) || ['go.mod', 'go.sum', 'VERSION', 'standalone.Dockerfile'].includes(relative))) {
        inputs.push([relative, createHash('sha256').update(await readFile(path.join(root, 'server', relative))).digest('hex')]);
      }
    }
  }
  await visit('');
  inputs.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const sourceSha256 = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  return { schema: 2, source: 'server/', version, goVersion, livekitVersion, sourceSha256 };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw result.error || Error(`${command} failed (${result.status})`);
}

export async function buildWindowsServer(output, { root = repositoryRoot } = {}) {
  output = path.resolve(output);
  const definition = await serverDefinition(root);
  const source = path.join(root, 'server');
  const go = process.env.PAWTALK_GO || await access(path.join(tmpdir(), 'pawtalk-tools/go/bin/go.exe')).then(() => path.join(tmpdir(), 'pawtalk-tools/go/bin/go.exe')).catch(() => 'go');
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(path.join(root, 'resources/server'), { recursive: true });
  const actual = spawnSync(go, ['version'], { encoding: 'utf8', windowsHide: true });
  const args = ['build', '-trimpath', '-buildvcs=false', '-o', output, '.'];
  if (!actual.error && actual.status === 0) {
    if (!actual.stdout.includes(`go${definition.goVersion} `)) throw Error('Server requires Go ' + definition.goVersion);
    run(go, args, { cwd: source, env: { ...process.env, CGO_ENABLED: '0', GOOS: 'windows', GOARCH: 'amd64', GOAMD64: 'v1', GOTOOLCHAIN: 'local', GOWORK: 'off', GOFLAGS: '' } });
    const goroot = spawnSync(go, ['env', 'GOROOT'], { encoding: 'utf8', windowsHide: true });
    if (goroot.error || goroot.status !== 0) throw goroot.error || Error('Cannot resolve Go license');
    await copyFile(path.join(goroot.stdout.trim(), 'LICENSE'), path.join(root, 'resources/server/GO-LICENSE'));
  } else {
    // Same compiler and flags when a developer uses Docker instead of native Go.
    run('docker', ['run', '--rm', '--mount', `type=bind,source=${source},target=/src,readonly`, '--mount', `type=bind,source=${path.dirname(output)},target=/out`,
      '--mount', 'type=volume,source=pawtalk-go-mod,target=/go/pkg/mod', '--mount', 'type=volume,source=pawtalk-go-build,target=/root/.cache/go-build',
      '--mount', `type=bind,source=${path.join(root, 'resources/server')},target=/licenses`, '-w', '/src', '-e', 'CGO_ENABLED=0', '-e', 'GOOS=windows', '-e', 'GOARCH=amd64', '-e', 'GOAMD64=v1', '-e', 'GOTOOLCHAIN=local', '-e', 'GOWORK=off', '-e', 'GOFLAGS=',
      `golang:${definition.goVersion}-alpine`, 'sh', '-c', 'go build -trimpath -buildvcs=false -o /out/server.exe . && cp /usr/local/go/LICENSE /licenses/GO-LICENSE']);
    await rename(path.join(path.dirname(output), 'server.exe'), output);
  }
  const after = await serverDefinition(root);
  if (after.sourceSha256 !== definition.sourceSha256) throw Error('Server sources changed during build; rebuild the final candidate');
  return { ...definition, apiSha256: createHash('sha256').update(await readFile(output)).digest('hex') };
}
