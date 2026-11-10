import { mkdir, mkdtemp, readFile, rm, writeFile, access, unlink, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'resources/server');
const bundled = JSON.parse(await readFile(path.join(root, 'bundled-server.json'), 'utf8'));
if (!/^[a-f0-9]{40}$/.test(bundled.commit) || !/^\d+\.\d+\.\d+$/.test(bundled.version)) throw Error('Invalid pinned bundled server source');
const version = bundled.livekitVersion;
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (r.error || r.status !== 0) throw r.error || new Error(`${command} failed (${r.status})`);
}
async function download(url, headers = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'PawTalk build', ...headers },
        signal: AbortSignal.timeout(120000),
      });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      const error = new Error(`Download failed: ${r.status} ${url}`);
      if (r.status < 500 && r.status !== 429) throw error;
      if (attempt === 4) throw error;
      console.warn(`${error.message}; retrying (${attempt}/4).`);
    } catch (error) {
      if (attempt === 4 || /^Download failed: 4\d\d /.test(error.message)) throw error;
      console.warn(`Download failed for ${url}: ${error.message}; retrying (${attempt}/4).`);
    }
    await delay(attempt * 5000);
  }
  throw new Error(`Download failed after retries: ${url}`);
}
await mkdir(output, { recursive: true });
const go = process.env.PAWTALK_GO || (await access(path.join(tmpdir(), 'pawtalk-tools/go/bin/go.exe')).then(() => path.join(tmpdir(), 'pawtalk-tools/go/bin/go.exe')).catch(() => 'go'));
const source = await mkdtemp(path.join(tmpdir(), 'pawtalk-bundled-source-'));
try {
  const archive = path.join(source, 'server.tar');
  run('git', ['archive', '--format=tar', '-o', archive, bundled.commit, 'server']);
  run('tar', ['-xf', archive, '-C', source]);
  if ((await readFile(path.join(source, 'server/VERSION'), 'utf8')).trim() !== bundled.version) throw Error('Pinned server version mismatch');
  const goRoot = spawnSync(go, ['env', 'GOROOT'], { encoding: 'utf8', windowsHide: true });
  if (goRoot.status === 0) {
    const actualGo = spawnSync(go, ['version'], {encoding:'utf8',windowsHide:true});
    if (actualGo.status !== 0 || !actualGo.stdout.includes(`go${bundled.goVersion} `)) throw Error('Bundled server requires pinned Go '+bundled.goVersion);
    run(go, ['build', '-trimpath', '-o', path.join(output, 'pawtalk-api.exe'), '.'], { cwd: path.join(source, 'server'), env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64' } });
    await copyFile(path.join(goRoot.stdout.trim(), 'LICENSE'), path.join(output, 'GO-LICENSE'));
  } else {
    // Optional Docker fallback on developer PCs without a Go installation.
    run('docker', ['run', '--rm', '--mount', `type=bind,source=${path.join(source,'server')},target=/src`, '--mount', `type=bind,source=${output},target=/out`, '-w', '/src', '-e', 'GOOS=windows', '-e', 'GOARCH=amd64', `golang:${bundled.goVersion}-alpine`, 'sh', '-c', 'go build -trimpath -o /out/pawtalk-api.exe . && cp /usr/local/go/LICENSE /out/GO-LICENSE']);
  }
} finally { await rm(source, {recursive:true,force:true}); }
const binary = path.join(output, 'livekit-server.exe');
const installed = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true });
if (installed.status !== 0 || !installed.stdout.includes(`version ${version}`)) {
  const archiveName = `livekit_${version}_windows_amd64.zip`;
  const releaseUrl = `https://api.github.com/repos/livekit/livekit/releases/tags/v${version}`;
  const release = JSON.parse((await download(releaseUrl)).toString());
  if (release.tag_name !== `v${version}`) throw new Error(`Unexpected LiveKit release tag: ${release.tag_name}`);
  const sumsAsset = release.assets.find(asset => asset.name === 'checksums.txt');
  const binaryAsset = release.assets.find(asset => asset.name === archiveName);
  if (!sumsAsset || !binaryAsset) throw new Error(`LiveKit release ${version} is missing required assets`);
  const assetUrl = id => `https://api.github.com/repos/livekit/livekit/releases/assets/${id}`;
  const sums = (await download(assetUrl(sumsAsset.id), { Accept: 'application/octet-stream' })).toString();
  const expected = sums.split(/\r?\n/).find(line => line.trim().endsWith(archiveName))?.split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Missing LiveKit checksum');
  const archive = await download(assetUrl(binaryAsset.id), { Accept: 'application/octet-stream' });
  if (createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('LiveKit checksum mismatch');
  const zip = path.join(output, 'livekit.zip'); await writeFile(zip, archive);
  run('tar.exe', ['-xf', zip, '-C', output]);
  await unlink(zip);
}
const license = path.join(output, 'LIVEKIT-LICENSE');
try { await access(license); } catch { await writeFile(license, await download(`https://raw.githubusercontent.com/livekit/livekit/v${version}/LICENSE`)); }
const binaryHash = async name => createHash('sha256').update(await readFile(path.join(output, name))).digest('hex');
await writeFile(path.join(output, 'bundled-server.json'), JSON.stringify({...bundled, apiSha256:await binaryHash('pawtalk-api.exe'),livekitSha256:await binaryHash('livekit-server.exe')})+'\n');
console.log('Bundled API and LiveKit are ready.');
