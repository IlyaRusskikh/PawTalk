// Exercise the real restricted preload/main clipboard path without replacing
// the user's clipboard contents. Only the final native clipboard sink is mocked.
const { app, clipboard } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
app.setPath('userData', path.join(os.tmpdir(), 'voicecord-fixes-' + process.pid));
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.disableHardwareAcceleration();
process.argv.push('--smoke', '--offscreen-smoke');
let copied = '';
const originalWrite = clipboard.writeText;
clipboard.writeText = value => { copied = value; };
app.on('browser-window-created', (_event, win) => {
  const js = expression => win.webContents.executeJavaScript(expression, true);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async expression => { for (let i = 0; i < 100; i++) { if (await js(expression)) return; await wait(50); } throw new Error('Timed out: ' + expression); };
  win.webContents.once('did-finish-load', async () => {
    try {
      await until(`!!document.querySelector('.home-actions')`);
      await js(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Browser clipboard unavailable'); } } })`);
      await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Сгенерировать ключ шифрования').click()`);
      await until(`!!document.querySelector('#server-key-env')`);
      for (const name of ['secret', 'hash', 'env']) {
        const value = await js(`document.querySelector('#server-key-${name}').value`);
        await js(`document.querySelector('#server-key-${name}').parentElement.querySelector('button').click()`);
        await until(`document.querySelector('#server-key-${name}').parentElement.querySelector('button').textContent==='Скопировано'`);
        assert.equal(copied, value, name + ' reaches Electron clipboard');
      }
      assert.equal(await js(`window.desktop.copyServerKey('not a key').then(()=>false,()=>true)`), true);
      await js(`document.querySelector('dialog [aria-label="Закрыть"]').click();document.querySelector('[title="Настройки"]').click()`);
      await until(`!!document.querySelector('.settings-modal')`);
      const gap = await js(`(()=>{const [a,b]=document.querySelectorAll('.profile-settings .form-fields>label');return b.getBoundingClientRect().top-a.getBoundingClientRect().bottom})()`);
      assert.ok(gap >= 20, 'profile fields have a 20px gap');
      await wait(200);
      await fs.mkdir('release/qa', { recursive: true });
      await fs.writeFile('release/qa/profile-field-spacing.png', (await win.webContents.capturePage()).toPNG());
      if (process.env.VOICECORD_VERIFY_HOST_CHECK === '1') {
        const result = await js('window.desktop.checkHost(18443)');
        console.log('Real Electron IPC network result: ' + JSON.stringify(result));
        assert.equal(result.state, 'internet', 'current external network reachability');
      }
      console.log('PASS real main/preload clipboard IPC for key/hash/env with browser API denied; invalid payload rejection; profile field spacing.');
      app.quit();
    } catch (error) { console.error(error); app.exit(1); }
    finally { clipboard.writeText = originalWrite; }
  });
});
require('../electron/main.cjs');
