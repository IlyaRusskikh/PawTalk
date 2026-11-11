import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const waitForProcessExit = async (pid, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`PowerShell helper ${pid} did not exit`);
};
test('hidden PowerShell executes and survives a real Electron parent shutdown', { skip: process.platform !== 'win32', timeout: 40000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pawtalk handoff '));
  const env = { ...process.env, PAWTALK_HANDOFF_DIRECTORY: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const childPid = path.join(directory, 'child-pid');
    await promisify(execFile)(require('electron'), ['tests/update-handoff.cjs'], { env, windowsHide: true, timeout: 25000 });
    let contents;
    for (let i = 0; i < 50; i++) {
      try { contents = await readFile(path.join(directory, 'done'), 'utf8'); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(contents, 'survived');
    await waitForProcessExit(Number(await readFile(childPid, 'utf8')));
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
