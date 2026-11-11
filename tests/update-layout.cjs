// Render the built UI in Electron; only the update notification is synthetic.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
app.setPath('userData', path.join(require('node:os').tmpdir(), `pawtalk-update-layout-${process.pid}`));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: {
    preload: path.join(__dirname, 'update-layout-preload.cjs'), contextIsolation: true, sandbox: true, offscreen: true,
  } });
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
  const run = source => win.webContents.executeJavaScript(`try { ${source} } catch (error) { console.error(error.stack); throw error; }`, true);
  const until = async source => {
    for (let i = 0; i < 100; i++) {
      if (await run(source)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(`Timed out: ${source}`);
  };
  const geometry = () => run(`(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; };
    return { home: rect('.home-screen'), main: rect('main'), settings: rect('.rail-settings'),
      overflow: ['html','body','main','.content'].map(s => { const e = document.querySelector(s); return [e.scrollWidth > e.clientWidth,e.scrollHeight > e.clientHeight]; }) };
  })()`);
  try {
    await win.loadFile(path.resolve('dist/index.html'));
    await win.webContents.debugger.attach('1.3');
    for (const motion of ['reduce', 'no-preference']) {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
      for (const language of ['ru', 'en']) {
        for (const [width,height] of [[1100,760],[900,640]]) {
          win.setSize(width,height);
          await win.loadFile(path.resolve('dist/index.html'));
          await run(`localStorage.setItem('pawtalk.language',${JSON.stringify(language)})`);
          await win.loadFile(path.resolve('dist/index.html'));
          await until(`document.documentElement.lang === '${language}' && !!document.querySelector('.home-screen')`);
          const before = await geometry();
          await run('window.offerTestUpdate()');
          await until(`!!document.querySelector('.update-modal[open]')`);
          await run(`document.querySelector('.update-modal .quiet').click()`);
          await until(`!!document.querySelector('.rail-actions .update-indicator')`);
          assert.deepEqual(await geometry(), before, `${language}/${motion}/${width}: update preserves content, settings and scroll geometry`);
          assert.ok(await run(`(() => {
            const u = document.querySelector('.update-indicator').getBoundingClientRect();
            const s = document.querySelector('.rail-settings').getBoundingClientRect();
            return u.bottom <= s.top && Math.abs(u.x + u.width/2 - s.x - s.width/2) < 1;
          })()`), 'update is above and centered with Settings');
          await run(`document.querySelector('.update-indicator').click()`);
          await until(`!!document.querySelector('.update-modal[open]')`);
        }
      }
    }
    console.log('Update layout passed: RU/EN, normal/reduced motion, two window sizes; dialog reopens.');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
