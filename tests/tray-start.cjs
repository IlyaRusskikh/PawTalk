const { app } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
app.setPath('userData', path.join(require('node:os').tmpdir(), 'pawtalk-tray-start-' + process.pid));
app.disableHardwareAcceleration();
process.argv.push('--start-in-tray');
app.once('browser-window-created', (_event, win) => {
  assert.equal(win.isVisible(), false, 'startup creates a hidden window without flashing');
  win.webContents.once('did-finish-load', async () => {
    try {
      assert.equal(win.isVisible(), false);
      assert.equal(await win.webContents.executeJavaScript('window.desktop.windowActive()'), false);
      console.log('PASS tray startup stays hidden and pauses presence polling');
      app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require('../electron/main.cjs');
