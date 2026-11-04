import { mkdir, writeFile, access, unlink, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'resources/server');
const version = '1.13.11';
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (r.error || r.status !== 0) throw r.error || new Error(`${command} failed (${r.status})`);
}
async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`Download failed: ${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
}
await mkdir(output, { recursive: true });
const go = process.env.VOICECORD_GO || (await access(path.join(tmpdir(), 'voicecord-tools/go/bin/go.exe')).then(() => path.join(tmpdir(), 'voicecord-tools/go/bin/go.exe')).catch(() => 'go'));
run(go, ['build', '-trimpath', '-o', path.join(output, 'voicecord-api.exe'), '.'], { cwd: path.join(root, 'server'), env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64' } });
const goRoot = spawnSync(go, ['env', 'GOROOT'], { encoding: 'utf8', windowsHide: true });
if (goRoot.status !== 0) throw new Error('Could not locate Go license');
await copyFile(path.join(goRoot.stdout.trim(), 'LICENSE'), path.join(output, 'GO-LICENSE'));
const binary = path.join(output, 'livekit-server.exe');
const installed = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true });
if (installed.status !== 0 || !installed.stdout.includes(`version ${version}`)) {
  const archiveName = `livekit_${version}_windows_amd64.zip`;
  const base = `https://github.com/livekit/livekit/releases/download/v${version}`;
  const sums = (await download(`${base}/checksums.txt`)).toString();
  const expected = sums.split(/\r?\n/).find(line => line.trim().endsWith(archiveName))?.split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Missing LiveKit checksum');
  const archive = await download(`${base}/${archiveName}`);
  if (createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('LiveKit checksum mismatch');
  const zip = path.join(output, 'livekit.zip'); await writeFile(zip, archive);
  run('tar.exe', ['-xf', zip, '-C', output]);
  await unlink(zip);
}
const license = path.join(output, 'LIVEKIT-LICENSE');
try { await access(license); } catch { await writeFile(license, await download(`https://raw.githubusercontent.com/livekit/livekit/v${version}/LICENSE`)); }
console.log('Bundled API and LiveKit are ready.');
