import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
const { verifyManifest } = createRequire(import.meta.url)('../electron/update-manifest.cjs');
test('release signing hashes the exact installer, matches the embedded key and fails closed without secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pawtalk-signing-'));
  try {
    await Promise.all(['scripts', 'electron', 'release'].map(name => mkdir(path.join(root, name))));
    await copyFile(new URL('../scripts/sign-update.mjs', import.meta.url), path.join(root, 'scripts/sign-update.mjs'));
    const pair = generateKeyPairSync('ed25519');
    const keys = { synthetic: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    await writeFile(path.join(root, 'electron/update-keys.json'), JSON.stringify(keys));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    const bytes = Buffer.from('exact bytes of synthetic installer');
    await writeFile(path.join(root, 'release/PawTalk.Setup.1.2.3.exe'), bytes);
    const env = { ...process.env, PAWTALK_PRERELEASE: 'true' };
    delete env.PAWTALK_UPDATE_PRIVATE_KEY; delete env.PAWTALK_UPDATE_KEY_FILE;
    const run = () => promisify(execFile)(process.execPath, [path.join(root, 'scripts/sign-update.mjs')], { env, windowsHide: true });
    await assert.rejects(run(), /Set PAWTALK_UPDATE_PRIVATE_KEY/);
    env.PAWTALK_UPDATE_PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await run();
    const raw = await readFile(path.join(root, 'release/update-manifest.json'), 'utf8');
    const value = verifyManifest(raw, keys);
    assert.equal(value.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(value.size, bytes.length); assert.equal(value.version, '1.2.3'); assert.equal(value.prerelease, true);
    const foreign = generateKeyPairSync('ed25519');
    env.PAWTALK_UPDATE_PRIVATE_KEY = foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await assert.rejects(run(), /does not match a trusted update key/);
    assert.equal(await readFile(path.join(root, 'release/update-manifest.json'), 'utf8'), raw);
  } finally { await rm(root, { recursive: true, force: true }); }
});
