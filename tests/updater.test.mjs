import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { Updater, compare, selectRelease, validAssetURL } = createRequire(import.meta.url)('../electron/updater.cjs');
const { verifyManifest } = createRequire(import.meta.url)('../electron/update-manifest.cjs');
const { download } = createRequire(import.meta.url)('../electron/update-transport.cjs');
const pair = generateKeyPairSync('ed25519');
const keys = { test: pair.publicKey.export({type:'spki',format:'pem'}).toString() };
function manifest(v = '0.2.0', extra = {}) {
  const payload = Buffer.from(JSON.stringify({schema:1,version:v,name:`PawTalk.Setup.${v}.exe`,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),prerelease:v.includes('-'),publishedAt:Date.now()-1000,expiresAt:Date.now()+86400000,...extra}));
  return JSON.stringify({keyId:'test',payload:payload.toString('base64'),signature:sign(null,payload,pair.privateKey).toString('base64')});
}
const bytes = Buffer.from('synthetic installer, never executed');
function release(v, extra = {}) {
  return { tag_name: `v${v}`, prerelease: v.includes('-'), assets: [{ name: `PawTalk.Setup.${v}.exe`, state: 'uploaded', size: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, browser_download_url: `https://github.com/IlyaRusskikh/pawtalk/releases/download/v${v}/PawTalk.Setup.${v}.exe` }], ...extra };
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

test('GitHub repository casing does not hide releases or weaken tag and origin checks', async () => {
  for (const repository of ['IlyaRusskikh/PawTalk', 'IlyaRusskikh/pawtalk', 'ilyarusskikh/PAWTALK']) {
    const candidate = release('0.7.1');
    candidate.assets[0].browser_download_url = `https://github.com/${repository}/releases/download/v0.7.1/PawTalk.Setup.0.7.1.exe`;
    assert.equal(selectRelease([candidate], '0.6.0').version, '0.7.1');
    const updater = new Updater({ current: '0.7.0', keys,
      fetcher: async url => url.includes('api.github.com') ? Response.json([candidate]) : new Response(manifest('0.7.1')) });
    assert.equal((await updater.check()).status, 'available', repository);
  }
  for (const url of [
    'https://github.com/IlyaRusskikh/PawTalk-evil/releases/download/v0.7.1/setup.exe',
    'https://github.com/other/PawTalk/releases/download/v0.7.1/setup.exe',
    'https://github.com/IlyaRusskikh/PawTalk/releases/download/V0.7.1/setup.exe',
    'https://github.com/IlyaRusskikh/PawTalk/RELEASES/download/v0.7.1/setup.exe',
    'https://github.com/IlyaRusskikh/PawTalk/releases/download/v0.7.1/setup.exe?token=x',
    'https://user@github.com/IlyaRusskikh/PawTalk/releases/download/v0.7.1/setup.exe',
  ]) assert.equal(validAssetURL(url, 'v0.7.1'), false, url);
});
test('download verifies all bytes before launching hidden NSIS helper', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pawtalk-update-'));
  const script = path.join(directory, 'source-helper.ps1');
  await writeFile(script, '# synthetic helper');
  let launchArgs;
  const updater = new Updater({ keys, current: '0.1.0', directory, script, installDirectory: 'C:\\Program Files\\PawTalk',
    fetcher: async url => url.includes('api.github.com') ? Response.json([release('0.2.0')]) : url.endsWith('update-manifest.json') ? new Response(manifest()) : new Response(bytes),
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
    assert.deepEqual(await readFile(path.join(directory, 'PawTalk-0.2.0.exe')), bytes);
    assert.match(launchArgs[0], /powershell\.exe$/);
    assert.equal(launchArgs[2].windowsHide, true);
    assert.equal(launchArgs[2].detached, false, 'PowerShell must not use DETACHED_PROCESS');
    assert.ok(Buffer.from(launchArgs[1].at(-1), 'base64').toString('utf16le').includes('C:\\Program Files\\PawTalk'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('corrupt and truncated downloads never launch and can be retried', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pawtalk-update-'));
  let body = Buffer.alloc(bytes.length), launched = false;
  const updater = new Updater({ keys, current: '0.1.0', directory, script: '', installDirectory: '',
    fetcher: async url => url.includes('api.github.com') ? Response.json([release('0.2.0')]) : url.endsWith('update-manifest.json') ? new Response(manifest()) : new Response(body),
    launch: () => { launched = true; throw new Error('must not launch'); } });
  try {
    await updater.check();
    assert.equal((await updater.install()).status, 'security-failed');
    assert.equal(launched, false);
    body = bytes.subarray(0, 2);
    assert.equal((await updater.install()).status, 'failed');
    assert.equal(launched, false);
    await assert.rejects(readFile(path.join(directory, 'installer.part')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('network failures leave the installed app alone', async () => {
  const updater = new Updater({ keys, current: '0.1.0', fetcher: async () => { throw new Error('offline'); } });
  assert.equal((await updater.check()).status, 'check-failed');
});

test('signed manifests reject tampering, foreign keys, expiration and invalid artifact bindings', () => {
  assert.equal(verifyManifest(manifest(), keys).version, '0.2.0');
  const altered = JSON.parse(manifest());
  const value = JSON.parse(Buffer.from(altered.payload, 'base64'));
  value.sha256 = '0'.repeat(64); altered.payload = Buffer.from(JSON.stringify(value)).toString('base64');
  for (const raw of [JSON.stringify(altered), manifest('0.2.0', { expiresAt: Date.now() - 1 }),
    manifest('0.2.0', { name: 'other.exe' }), manifest('0.2.0', { publishedAt: Date.now() + 86400000 })]) {
    assert.throws(() => verifyManifest(raw, keys), { code: 'UPDATE_SECURITY' });
  }
  assert.throws(() => verifyManifest(manifest(), {}), { code: 'UPDATE_SECURITY' });
});

test('blocked GitHub metadata uses a favorite room and independently verifies its manifest', async () => {
  const requests = [];
  const updater = new Updater({ keys, current: '0.1.0', fetcher: async () => { throw Error('GitHub blocked'); },
    rooms: () => [{ name: 'Offline', prepare: async () => { throw Error('offline'); } }, { name: 'Favorite', prepare: async () => ({ base: 'https://room.example' }) }],
    roomFetcher: async (url, options) => { requests.push(url); assert.equal(options.redirect, 'error');
      return url.includes('/releases?') ? Response.json([release('0.2.0')]) : new Response(manifest()); } });
  assert.equal((await updater.check()).status, 'available');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => url.startsWith('https://room.example/api/updates/')));
});

test('untrusted manifests from a favorite report its name and never offer installation', async () => {
  const updater = new Updater({ keys, current: '0.1.0', fetcher: async () => { throw Error('blocked'); },
    rooms: () => [{ name: 'Bad room', prepare: async () => ({ base: 'https://room.example' }) }],
    roomFetcher: async url => url.includes('/releases?') ? Response.json([release('0.2.0')]) : new Response(manifest().replace('"test"', '"foreign"')) });
  assert.deepEqual(await updater.check(), { status: 'security-failed', source: 'Bad room' });
  assert.equal(updater.release, null);
});

test('persisted authenticated offers prevent rollback and signed metadata must match release data', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pawtalk-trust-'));
  try {
    let v = '0.3.0';
    const options = { keys, directory, current: '0.1.0', fetcher: async url => url.includes('api.github.com') ? Response.json([release(v)]) : new Response(manifest(v)) };
    assert.equal((await new Updater(options).check()).status, 'available');
    v = '0.2.0';
    assert.equal((await new Updater(options).check()).status, 'security-failed');
    const other = new Updater({ ...options, directory: undefined,
      fetcher: async url => url.includes('api.github.com') ? Response.json([release(v)]) : new Response(manifest('0.9.0')) });
    assert.equal((await other.check()).status, 'security-failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('broken direct downloads switch to streaming room relay; corrupt relays never launch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pawtalk-relay-'));
  try {
    let corrupt = false, launched = false;
    const sources = [];
    const updater = new Updater({ keys, directory, current: '0.1.0', script: path.join(directory, 'helper.ps1'), installDirectory: directory,
      fetcher: async url => {
        if (url.includes('api.github.com')) return Response.json([release('0.2.0')]);
        if (url.endsWith('update-manifest.json')) return new Response(manifest());
        sources.push('GitHub'); return new Response(bytes.subarray(0, 2));
      }, rooms: () => [{ name: 'Relay room', prepare: async () => ({ base: 'https://room.example' }) }],
      roomFetcher: async () => { sources.push('Relay room'); return new Response(corrupt ? Buffer.alloc(bytes.length) : bytes); },
      launch: () => { launched = true; throw Error('synthetic installer launch stopped'); } });
    await writeFile(updater.script, '# synthetic');
    await updater.check(); await updater.install();
    assert.deepEqual(sources, ['GitHub', 'Relay room']);
    assert.equal(launched, true);
    assert.deepEqual(await readFile(path.join(directory, 'PawTalk-0.2.0.exe')), bytes);
    corrupt = true; launched = false;
    const state = await updater.install();
    assert.equal(state.status, 'security-failed'); assert.equal(state.source, 'Relay room');
    assert.equal(launched, false);
    await assert.rejects(readFile(path.join(directory, 'installer.part')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real HTTP stalled and slow downloads abort and fall back to a room stream', async () => {
  const { createServer } = await import('node:http');
  const directory = await mkdtemp(path.join(tmpdir(), 'pawtalk-http-update-'));
  let mode = 'slow', relayCalls = 0;
  const primary = createServer((req, res) => {
    if (req.url.includes('/repos/')) return res.end(JSON.stringify([release('0.2.0')]));
    if (req.url.endsWith('update-manifest.json')) return res.end(manifest());
    res.writeHead(200); res.flushHeaders();
    if (mode === 'slow') res.write(bytes.subarray(0, 1));
  });
  const relay = createServer((_req, res) => { relayCalls++; res.end(bytes); });
  await Promise.all([new Promise(resolve => primary.listen(0, '127.0.0.1', resolve)), new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))]);
  try {
    for (mode of ['slow', 'stalled']) {
      let launched = false;
      const updater = new Updater({ keys, current: '0.1.0', directory, script: path.join(directory, 'helper.ps1'), installDirectory: directory,
        fetcher: (url, options) => fetch(`http://127.0.0.1:${primary.address().port}${new URL(url).pathname}`, options),
        rooms: () => [{ name: 'Local relay', prepare: async () => ({ base: `http://127.0.0.1:${relay.address().port}` }) }], roomFetcher: fetch,
        downloadPolicy: { idleMs: mode === 'stalled' ? 50 : 1000, windowMs: 50, minBytesPerSecond: mode === 'slow' ? 65536 : 0, totalMs: 2000 },
        launch: () => { launched = true; throw Error('test stops before execution'); } });
      await writeFile(updater.script, '# synthetic');
      assert.equal((await updater.check()).status, 'available');
      await updater.install();
      assert.equal(launched, true, mode);
      assert.deepEqual(await readFile(path.join(directory, 'PawTalk-0.2.0.exe')), bytes);
    }
    assert.equal(relayCalls, 2);
  } finally {
    primary.closeAllConnections(); relay.closeAllConnections();
    await Promise.all([new Promise(resolve => primary.close(resolve)), new Promise(resolve => relay.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('installer verification enforces signed size even for oversized responses', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pawtalk-size-'));
  try {
    await assert.rejects(download({ fetcher: async () => new Response(Buffer.alloc(bytes.length + 1)), source: { base: 'https://room.example', name: 'Oversize' },
      manifest: verifyManifest(manifest(), keys), partial: path.join(directory, 'installer.part'), onProgress: () => {} }), { code: 'UPDATE_SECURITY', source: 'Oversize' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
