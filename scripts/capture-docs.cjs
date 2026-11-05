// Capture the real main/preload/renderer in an isolated profile, never a user's room.
// Run after npm run build: electron scripts/capture-docs.cjs
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
app.setPath('userData', path.join(os.tmpdir(), 'voicecord-docs-' + process.pid));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
delete process.env.VOICECORD_DEV_URL;
process.argv.push('--smoke');
const timeout = setTimeout(() => { console.error('Documentation capture timed out'); app.exit(1); }, 30000);
app.on('browser-window-created', (_event, win) => {
  win.setContentSize(1240, 860);
  win.webContents.once('did-finish-load', async () => {
    const run = source => win.webContents.executeJavaScript(source);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const click = text => run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith(${JSON.stringify(text)})).click()`);
    try {
      const output = path.resolve(__dirname, '../website/assets');
      await fs.mkdir(output, { recursive: true });
      for (let i = 0; i < 80 && !await run(`!!document.querySelector('.home-actions')`); i++) await wait(100);
      await wait(400);
      // Avoid registering shortcuts already used by the user's running client.
      await run(`localStorage.setItem('voicecord.settings', JSON.stringify({muteKey:'',deafenKey:''}))`);
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.reload(); });
      for (let i = 0; i < 80 && !await run(`!!document.querySelector('.home-actions')`); i++) await wait(100);
      assert.equal(await run('window.desktop.pendingInvitation()'), '', 'no live invitation');
      assert.equal((await run('window.desktop.hostStatus()')).running, false, 'no room started');
      assert.equal((await run('window.desktop.capabilities()')).native, true, 'real native module');
      const capture = async name => {
        await wait(400);
        assert.deepEqual(await run(`Array.from(document.querySelectorAll('[role="alert"]')).map(el=>el.textContent)`), []);
        await fs.writeFile(path.join(output, name), (await win.webContents.capturePage()).toPNG());
      };
      await capture('home.png');
      await click('Создать комнату');
      await capture('create-room.png');
      await run(`document.querySelector('dialog [aria-label="Закрыть"]').click()`);
      await run(`document.querySelector('[title="Настройки"]').click()`);
      for (let i = 0; i < 80 && !await run(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Проверка микрофона'&&!b.disabled)`); i++) await wait(100);
      assert.equal(await run(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Проверка микрофона'&&!b.disabled)`), true);
      await run(`document.querySelector('.voice-settings').scrollIntoView({block:'start'})`);
      await capture('audio-settings.png');
      console.log('PASS: real app screenshots, isolated profile, synthetic microphone; no room or invitation created.');
      clearTimeout(timeout);
      app.quit();
    } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
  });
});
require('../electron/main.cjs');
