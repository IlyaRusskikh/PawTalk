import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { Updater, compare, selectRelease } = createRequire(import.meta.url)('../electron/updater.cjs');
const bytes = Buffer.from('synthetic installer, never executed');
function release(v, extra = {}) {
  return { tag_name: `v${v}`, prerelease: v.includes('-'), assets: [{ name: `Voicecord.Setup.${v}.exe`, state: 'uploaded', size: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, browser_download_url: `https://github.com/IlyaRusskikh/voicecord/releases/download/v${v}/Voicecord.Setup.${v}.exe` }], ...extra };
}
test('version ordering includes prereleases without downgrading stable versions', () => {
  for (const [a, b] of [['0.2.0', '0.1.9'], ['0.2.0-beta.10', '0.2.0-beta.2'], ['0.2.0', '0.2.0-rc.1'], ['0.2.0-alpha', '0.2.0-1']]) assert.ok(compare(a, b) > 0);
  assert.equal(compare('v0.2.0', '0.2.0'), 0);
  assert.equal(selectRelease([release('0.1.0'), release('0.2.0-beta.1')], '0.1.0').version, '0.2.0-beta.1');
  assert.equal(selectRelease([release('0.2.0-beta.1')], '0.2.0'), null);
});
test('only complete, verifiable installers from this repository are offered', () => {
  const invalid = release('0.2.0'); invalid.assets[0].digest = null;
  const external = release('0.3.0'); external.assets[0].browser_download_url = 'https://evil.example/setup.exe';
  const otherTag = release('0.4.0'); otherTag.assets[0].browser_download_url = otherTag.assets[0].browser_download_url.replace('/v0.4.0/', '/v0.3.0/');
  assert.equal(selectRelease([invalid, external, otherTag, release('0.5.0', { draft: true })], '0.1.0'), null);
});
test('download verifies all bytes before launching hidden NSIS helper', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'voicecord-update-'));
  const script = path.join(directory, 'source-helper.ps1');
  await writeFile(script, '# synthetic helper');
  let launchArgs;
  const updater = new Updater({ current: '0.1.0', directory, script, installDirectory: 'C:\\Program Files\\Voicecord',
    fetcher: async url => url.includes('api.github.com') ? Response.json([release('0.2.0')]) : new Response(bytes),
    launch: (...args) => {
      launchArgs = args; const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => {
        child.emit('spawn');
        const command = Buffer.from(args[1].at(-1), 'base64').toString('utf16le');
        void writeFile(command.match(/"-ReadyFile" "([^"]+)"/)[1], command.match(/"-Token" "([^"]+)"/)[1]);
      });
      return child;
    } });
  try {
    assert.equal((await updater.check()).status, 'available');
    assert.equal((await updater.install()).status, 'installing');
    assert.deepEqual(await readFile(path.join(directory, 'Voicecord-0.2.0.exe')), bytes);
    assert.match(launchArgs[0], /powershell\.exe$/);
    assert.equal(launchArgs[2].windowsHide, true);
    assert.equal(launchArgs[2].detached, false, 'PowerShell must not use DETACHED_PROCESS');
    assert.ok(Buffer.from(launchArgs[1].at(-1), 'base64').toString('utf16le').includes('C:\\Program Files\\Voicecord'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('corrupt and truncated downloads never launch and can be retried', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'voicecord-update-'));
  let body = Buffer.alloc(bytes.length), launched = false;
  const updater = new Updater({ current: '0.1.0', directory, script: '', installDirectory: '',
    fetcher: async url => url.includes('api.github.com') ? Response.json([release('0.2.0')]) : new Response(body),
    launch: () => { launched = true; throw new Error('must not launch'); } });
  try {
    await updater.check();
    assert.equal((await updater.install()).status, 'failed');
    assert.equal(launched, false);
    body = bytes.subarray(0, 2);
    assert.equal((await updater.install()).status, 'failed');
    assert.equal(launched, false);
    await assert.rejects(readFile(path.join(directory, 'installer.part')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('network failures leave the installed app alone', async () => {
  const updater = new Updater({ current: '0.1.0', fetcher: async () => { throw new Error('offline'); } });
  assert.equal((await updater.check()).status, 'check-failed');
});
