// A fresh main/preload process with no locally hosted room and no certificate
// installation. Parent captures the ephemeral test token; never print it to QA logs.
const { app } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
app.setPath('userData', path.join(os.tmpdir(), 'voicecord-invitation-client-' + process.pid));
process.argv.push('--smoke');
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      const address = process.env.VOICECORD_TEST_INVITATION;
      const input = { address, nickname: 'Guest', password: process.env.VOICECORD_TEST_PASSWORD };
      const diagnosis = await win.webContents.executeJavaScript(`window.desktop.diagnose(${JSON.stringify(address)})`);
      assert.equal(diagnosis.ok, true, diagnosis.message);
      const response = await win.webContents.executeJavaScript(`window.desktop.connect(${JSON.stringify(input)})`);
      assert.equal(response.error, undefined, response.error);
      assert.equal(new URL(response.url).hostname, new URL(address).hostname, 'guest must retain the LAN address');
      assert.notEqual(new URL(response.url).hostname, '127.0.0.1', 'guest cannot connect to the host loopback');
      process.stdout.write('VOICECORD_TEST_CREDENTIALS:' + JSON.stringify(response) + '\n');
      app.exit(0);
    } catch (error) { console.error(error.message); app.exit(1); }
  });
});
require('../electron/main.cjs');
