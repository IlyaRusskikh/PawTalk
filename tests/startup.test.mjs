import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { StartupSettings } = createRequire(import.meta.url)('../electron/startup.cjs');

test('tray startup preserves login enablement, matches Windows arguments and persists separately from manual launches', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pawtalk-startup-'));
  let saved = { path: 'C:\\PawTalk.exe', args: [], openAtLogin: true };
  const app = { getPath: () => saved.path,
    getLoginItemSettings: options => ({ openAtLogin: options.path === saved.path && JSON.stringify(options.args) === JSON.stringify(saved.args) && saved.openAtLogin }),
    setLoginItemSettings: value => { saved = value; } };
  try {
    const file = path.join(dir, 'startup.json');
    const settings = new StartupSettings(app, file);
    assert.equal(settings.enabled(), true); assert.equal(settings.inTray, false);
    settings.setInTray(true); assert.deepEqual(saved.args, ['--start-in-tray']); assert.equal(settings.enabled(), true);
    const restored = new StartupSettings(app, file); assert.equal(restored.inTray, true); assert.equal(restored.enabled(), true);
    restored.setEnabled(false); assert.equal(restored.enabled(), false);
    restored.setInTray(false); assert.equal(saved.openAtLogin, false); assert.deepEqual(saved.args, []);
    restored.setEnabled(true); assert.equal(restored.enabled(), true);
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(tmpdir()), 'pawtalk-startup-')));
    await rm(dir, { recursive: true, force: true });
  }
});
