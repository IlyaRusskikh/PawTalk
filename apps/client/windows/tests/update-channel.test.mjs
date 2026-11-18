import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { UpdatePreferences } = createRequire(import.meta.url)('../electron/update-settings.cjs');
test('Client channel persists independently of the automatic-check toggle and rejects unknown channels', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(),'pawtalk-channel-'));
  try {
    const file = path.join(directory,'settings.json');
    const settings = new UpdatePreferences(file);
    assert.equal(settings.channel,'preview');
    settings.setChannel('stable'); settings.setEnabled(false);
    const restored = new UpdatePreferences(file);
    assert.equal(restored.channel,'stable'); assert.equal(restored.enabled,false);
    assert.throws(() => restored.setChannel('unknown'));
    assert.equal(new UpdatePreferences(file).channel,'stable');
  } finally { await rm(directory,{recursive:true,force:true}); }
});
