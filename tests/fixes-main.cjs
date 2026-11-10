// Exercise the real restricted preload/main clipboard path without replacing
// the user's clipboard contents. Only the final native clipboard sink is mocked.
const { app, clipboard } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
app.setPath('userData', path.join(os.tmpdir(), 'pawtalk-fixes-' + process.pid));
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
      assert.equal(await js('window.desktop.getUpdateChannel()'),'preview');
      assert.equal(await js("window.desktop.setUpdateChannel('stable')"),'stable');
      assert.equal(await js("window.desktop.setUpdateChannel('invalid').then(()=>false,()=>true)"),true);
      assert.equal(await js('window.desktop.getUpdateChannel()'),'stable');
      await js('window.desktop.setAutoUpdate(false)');
      assert.equal(await js('window.desktop.getAutoUpdate()'),false);
      await js(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Browser clipboard unavailable'); } } })`);
      await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Сгенерировать ключ шифрования').click()`);
      await until(`!!document.querySelector('#server-key-env')`);
      for (const name of ['secret', 'env']) {
        const value = await js(`document.querySelector('#server-key-${name}').value`);
        await js(`document.querySelector('#server-key-${name}').parentElement.querySelector('button').click()`);
        await until(`document.querySelector('#server-key-${name}').parentElement.querySelector('button').textContent==='Скопировано'`);
        assert.equal(copied, value, name + ' reaches Electron clipboard');
      }
      assert.equal(await js(`window.desktop.copyServerKey('not a key').then(()=>false,()=>true)`), true);
      const chatText = 'Сообщение\nSecond line';
      await js(`window.desktop.copyChatText(${JSON.stringify(chatText)})`);
      assert.equal(copied,chatText,'chat text reaches the current Electron clipboard API unchanged');
      assert.equal(await js(`window.desktop.copyChatText('x'.repeat(12001)).then(()=>false,()=>true)`),true,'oversized clipboard IPC is rejected');
      await js(`document.querySelector('dialog [aria-label="Закрыть"]').click();document.querySelector('[title="Настройки"]').click()`);
      await until(`!!document.querySelector('.settings-modal')`);
      const gap = await js(`(()=>{const a=document.querySelector('.profile-avatar'),b=document.querySelector('.profile-settings .form-fields');return b.getBoundingClientRect().top-a.getBoundingClientRect().bottom})()`);
      assert.ok(gap >= 20, 'profile fields have a 20px gap');
      await wait(200);
      await fs.mkdir('release/qa', { recursive: true });
      win.webContents.invalidate();
      await wait(200);
      await fs.writeFile('release/qa/profile-field-spacing.png', (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      win.webContents.debugger.attach('1.3');
      for (const motion of ['reduce','no-preference']) {
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:motion}]});
        for (const language of ['ru','en']) {
          await js("document.querySelector('#settings-tab-language').click()");
          await wait(80);
          await js(`(()=>{const s=document.querySelector('.settings-modal select');s.value=${JSON.stringify(language)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
          await until(`document.documentElement.lang===${JSON.stringify(language)}`);
          await js("document.querySelector('#settings-tab-updates').click()");
          await until("document.querySelector('.update-settings select')?.value === 'stable'");
          assert.equal(await js("document.querySelector('.update-settings select').value"),'stable');
          assert.equal(await js("document.querySelector('.update-settings select option').textContent"),language === 'en' ? 'Stable releases' : 'Стабильные версии');
          const geometry = await js(`(()=>{const f=document.querySelector('.update-settings .form-fields'),[a,b]=f.children;return {gap:b.getBoundingClientRect().top-a.getBoundingClientRect().bottom,overflow:f.scrollWidth>f.clientWidth}})()`);
          assert.ok(Math.abs(geometry.gap-20)<=1,'actual update field gap: '+geometry.gap);
          assert.equal(geometry.overflow,false);
        }
      }
      win.webContents.debugger.detach();
      console.log('PASS actual Electron update-channel IPC, validation, persistence and localized field geometry in both motion modes');
      if (process.env.PAWTALK_VERIFY_HOST_CHECK === '1') {
        const result = await js('window.desktop.checkHost(18443)');
        console.log('Real Electron IPC network result: ' + JSON.stringify(result));
        assert.equal(result.state, 'internet', 'current external network reachability');
      }
      console.log('PASS real main/preload clipboard IPC for participant key and server settings with browser API denied; invalid payload rejection; profile field spacing.');
      app.quit();
    } catch (error) { console.error(error); app.exit(1); }
    finally { clipboard.writeText = originalWrite; }
  });
});
require('../electron/main.cjs');
