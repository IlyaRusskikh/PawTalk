// Read-only check against published GitHub metadata and the trusted release
// signature using Electron's actual network stack. Never downloads or installs.
const { app, net } = require('electron');
const assert = require('node:assert/strict');
const { Updater, compare } = require('../electron/updater.cjs');

app.whenReady().then(async () => {
  try {
    const current = process.env.PAWTALK_UPDATE_TEST_CURRENT || '0.6.0';
    const updater = new Updater({ current, fetcher: (...args) => net.fetch(...args) });
    const state = await updater.check();
    assert.equal(state.status, 'available', JSON.stringify(state));
    assert.ok(compare(state.version, current) > 0);
    assert.equal(updater.release.manifest.version, state.version);
    console.log(`PASS live Electron update check: ${current} -> ${state.version}, trusted signed manifest, no installation`);
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
