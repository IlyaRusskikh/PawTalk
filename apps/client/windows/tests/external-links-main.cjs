// Exercise Chromium target=_blank through the real main-process handler.
// Stub only the OS browser launch so this check does not open personal tabs.
const { app, BrowserWindow, shell } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
app.setPath('userData', path.join(require('node:os').tmpdir(), 'pawtalk-links-' + process.pid));
app.disableHardwareAcceleration();
process.argv.push('--smoke', '--offscreen-smoke');
const opened = [], originalOpen = shell.openExternal;
shell.openExternal = async url => { opened.push(url); };
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      const initialURL = win.webContents.getURL(), count = BrowserWindow.getAllWindows().length;
      for (const url of ['https://www.reddit.com/r/NoStupidQuestions/comments/kx7mm7/whats_the_difference_between_felid_and_feline/?tl=ru', 'http://example.com/path?a=1&b=2#part']) {
        const previous = opened.length;
        await win.webContents.executeJavaScript(`(()=>{const link=document.createElement('a');link.href=${JSON.stringify(url)};link.target='_blank';link.rel='noopener noreferrer';link.textContent='Chat link';document.body.append(link);link.click();link.remove();})()`, true);
        for (let i=0; i<100 && opened.length===previous; i++) await new Promise(resolve=>setTimeout(resolve,25));
        assert.equal(opened.length, previous+1, 'link click reaches the native browser launcher');
        assert.equal(opened.at(-1), url, 'path, query and fragment are preserved');
      }
      assert.equal(win.webContents.getURL(), initialURL, 'the app stays on its page');
      assert.equal(BrowserWindow.getAllWindows().length, count, 'no in-app browser window opens');
      console.log('PASS real Electron target=_blank clicks reach shell.openExternal; app navigation and window count stay unchanged. OS browser launch stubbed.');
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
    finally { shell.openExternal = originalOpen; }
  });
});
require('../electron/main.cjs');
