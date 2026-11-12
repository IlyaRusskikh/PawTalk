// Compare the actual separately packaged Windows artifacts, not build-script text.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serverDefinition } from './server-core.mjs';

const definition = await serverDefinition();
const receipt = JSON.parse(await readFile('resources/server/bundled-server.json', 'utf8'));
for (const [key, value] of Object.entries(definition)) assert.equal(receipt[key], value, `shared source receipt: ${key}`);
const stage = await mkdtemp(path.join(os.tmpdir(), 'pawtalk-core-identity-'));
try {
  execFileSync('tar.exe', ['-xf', path.resolve(`release/server/PawTalk.Server.${definition.version}.windows-x64.zip`), '-C', stage], { windowsHide: true });
  const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  assert.equal(await hash('resources/server/pawtalk-api.exe'), receipt.apiSha256, 'Client core matches receipt');
  assert.equal(await hash(path.join(stage, 'pawtalk-server.exe')), receipt.apiSha256, 'Client and permanent Windows Server cores are byte-identical');
  assert.equal(await hash(path.join(stage, 'livekit-server.exe')), await hash('resources/server/livekit-server.exe'), 'LiveKit binaries are byte-identical');
  console.log('PASS Client and permanent Windows Server use byte-identical Go and LiveKit binaries');
} finally { await rm(stage, { recursive: true, force: true }); }
