const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
app.setPath('userData', path.join(require('node:os').tmpdir(), 'pawtalk-connection-ui-' + process.pid));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 720, height: 580, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = source => win.webContents.executeJavaScript(source, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async source => { for (let i = 0; i < 100; i++) { if (await run(source)) return; await delay(50); } throw Error('Timed out: ' + source); };
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  try {
    await win.loadURL(process.env.PAWTALK_UI_TEST_URL + '/tests/connection-ui.html');
    await until('!!document.querySelector("button")');
    for (const language of ['ru', 'en']) for (const reduced of [false, true]) {
      await win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
      win.webContents.debugger.detach();
      await run(`fixture.language('${language}');fixture.state('connecting');fixture.state('connected')`);
      await run(`document.querySelector('button').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`);
      assert.equal(await run(`!!document.querySelector('[role=tooltip]')`), false, 'hover has a delay');
      await until(`!!document.querySelector('[role=tooltip]')`);
      assert.equal(await run(`document.querySelectorAll('.connection-chart').length`), 2);
      assert.ok(await run(`document.querySelector('[role=tooltip]').textContent.includes('${language === 'en' ? 'Waiting for measurements' : 'Ожидание измерений'}')`));
      await run(`window.originalPanel=document.querySelector('[role=tooltip]');fixture.sample()`);
      await until(`document.querySelector('[role=tooltip]').textContent.includes('${language === 'en' ? '83 ms' : '83 мс'}')`);
      await run(`fixture.render();fixture.sample(false)`);
      assert.equal(await run(`originalPanel===document.querySelector('[role=tooltip]')`), true, 'stats keep the same panel');
      assert.equal(await run(`fixture.snapshot().rtt.filter(p=>p.value!==undefined).length`), 1);
      assert.equal(await run(`document.querySelectorAll('.connection-chart polyline').length`), 1, 'no fabricated loss line without inbound audio');
      await run(`document.querySelector('button').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}));document.querySelector('[role=tooltip]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`);
      await delay(120);
      assert.equal(await run(`originalPanel===document.querySelector('[role=tooltip]')`), true, 'pointer can enter the panel without flicker');
      await run(`fixture.race()`);
      await until(`document.querySelector('[role=tooltip]').textContent.includes('${language === 'en' ? 'Reconnecting' : 'Переподключение'}')`);
      assert.equal(await run(`fixture.snapshot().rtt.at(-1).value`), undefined, 'pending collect cannot overwrite reconnect');
      await run(`(async()=>{fixture.state('connected');await fixture.sample();await fixture.fail()})()`);
      assert.equal(await run(`fixture.snapshot().rtt.at(-1).value`), undefined, 'poll failure is a gap');
      for (const theme of ['light', 'dark']) {
        await run(`fixture.theme('${theme}')`);
        for (const zoom of [0.8, 1.5]) {
          win.webContents.setZoomFactor(zoom); await delay(100);
          assert.equal(await run(`(()=>{const r=document.querySelector('[role=tooltip]').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`), true, 'panel stays inside viewport');
        }
      }
      win.webContents.setZoomFactor(1); await delay(100);
      win.setSize(360, 300); await delay(100);
      assert.equal(await run(`(()=>{const r=document.querySelector('[role=tooltip]').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`), true, 'small window clamps the panel');
      win.setSize(720, 580); await delay(100);
      await fs.mkdir('release/qa', { recursive: true });
      await fs.writeFile(`release/qa/connection-${language}-${reduced ? 'reduced' : 'normal'}.png`, (await win.webContents.capturePage()).toPNG());
      await run(`document.querySelector('button').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))`);
      await until(`!document.querySelector('[role=tooltip]')`);
      await run(`document.querySelector('button').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`);
      await until(`!!document.querySelector('[role=tooltip]')`);
      await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
      await until(`!document.querySelector('[role=tooltip]')`);
      win.focus();win.webContents.focus();
      await run(`document.querySelector('button').blur();document.querySelector('button').focus()`);
      await until(`!!document.querySelector('[role=tooltip]')`);
      await run(`document.querySelector('button').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      await until(`!document.querySelector('[role=tooltip]')`);
      await run(`document.querySelector('button').blur();document.querySelector('button').focus();document.querySelector('button').blur()`);
      await until(`!document.querySelector('[role=tooltip]')`);
      await run(`document.querySelectorAll('button')[1].focus()`);
      await until(`!!document.querySelector('[role=tooltip]')`);
      assert.equal(await run(`document.querySelectorAll('.connection-chart').length`), 0, 'peer keeps compact panel');
      assert.equal(await run(`document.querySelectorAll('dl>div').length`), 2);
      assert.ok(await run(`document.querySelector('[role=tooltip]').textContent.includes('222') && document.querySelector('[role=tooltip]').textContent.includes('%')`));
      await run(`document.activeElement.blur()`);
    }
    await run(`fixture.disconnect()`);
    assert.equal(await run(`fixture.snapshot().rtt.length+fixture.snapshot().loss.length`), 0, 'real disconnect clears history');
    assert.deepEqual(errors, []);
    console.log('PASS connection history: real collector with synthetic RTC reports; hover/focus/Escape/blur; RU/EN; themes/zoom; reconnect/reset; compact peers');
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
