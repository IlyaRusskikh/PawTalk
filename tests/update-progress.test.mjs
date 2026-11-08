import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { waitForHelper, confirmUpdateStarted } = createRequire(import.meta.url)('../electron/update-progress.cjs');
test('the app must receive the current helper token before exiting', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pawtalk-ready-'));
  const file = path.join(directory, 'ready');
  try {
    await writeFile(file, 'stale-token');
    let killed = false;
    await assert.rejects(waitForHelper(file, 'current-token', { kill() { killed = true; } }, 100), /ready/);
    assert.equal(killed, true);
    await writeFile(file, '\uFEFFcurrent-token');
    await waitForHelper(file, 'current-token', {});
    await assert.rejects(waitForHelper(file, 'current-token', { exitCode: 1 }), /exited/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('only the expected new executable/version can confirm startup', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pawtalk-started-'));
  const file = path.join(directory, 'installation.json');
  const state = { token: 'test', version: '0.1.1', executable: 'C:\\App\\PawTalk.exe', phase: 'installing' };
  try {
    await writeFile(file, '\uFEFF' + JSON.stringify(state));
    assert.equal(await confirmUpdateStarted(directory, '0.1.0', state.executable), false);
    assert.equal(await confirmUpdateStarted(directory, '0.1.1', 'C:\\Other.exe'), false);
    assert.equal(await confirmUpdateStarted(directory, '0.1.1', state.executable, 123), true);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).phase, 'launched');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
