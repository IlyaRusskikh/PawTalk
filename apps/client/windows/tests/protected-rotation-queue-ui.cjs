const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

app.setPath('userData', join(tmpdir(), 'pawtalk-rotation-queue-ui-' + process.pid));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 680,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const queue = "document.querySelector('.protected-rotation-queue')";
  const until = async (condition, label) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await run(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error(label + '\n' + await run('document.body.innerText'));
  };

  try {
    for (const language of ['ru', 'en']) {
      await win.loadURL(process.env.PAWTALK_UI_TEST_URL + `/tests/notifications.html?language=${language}&protected=rotation-queue`);
      await until("!!document.querySelector('.member-server-list button')", 'Server appears');
      await run("document.querySelector('.member-server-list button').click()");
      await run("window.setRotationQueue({waiting:1, processing:1, device:'Hidden device', channel:'Hidden channel'})");
      await until("!!document.querySelector('.member-composer textarea')", 'Protected text composer is available');
      assert.equal(await run(`!!${queue}`), false);
      await run(`(() => {
        const input = document.querySelector('.member-composer textarea');
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, 'Saved draft');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await until("document.querySelector('.member-composer button[type=submit]')?.disabled === false", 'Queue does not lock sending');
      assert.equal(await run('window.protectedSends.length'), 0);
      await run('window.delayRotationQueueResponse=true; window.setRotationQueue({waiting:2, processing:0});');
      await until('typeof window.releaseRotationQueueResponse === "function"', 'A queue response is in flight');
      await run('window.dispatchEvent(new Event("offline"))');
      await run(`window.releaseRotationQueueResponse();
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      assert.equal(await run(`!!${queue}`), false, 'Queue data stays out of the sidebar during network loss');
      await run('window.setConnected(false)');
      await until("document.querySelector('.member-composer button[type=submit]')?.disabled === true", 'Sending pauses offline');
      await run('window.setConnected(true)');
      await until("document.querySelector('.member-composer textarea')?.value === 'Saved draft' && document.querySelector('.member-composer button[type=submit]')?.disabled === false", 'Draft survives reconnect');
      await run('window.setRotationQueue({waiting:0, processing:0})');
      assert.equal(await run(`!!${queue}`), false);

      await win.loadURL(process.env.PAWTALK_UI_TEST_URL + `/tests/notifications.html?language=${language}`);
      await until("!!document.querySelector('.member-server-list button')", 'Legacy server appears');
      await run("document.querySelector('.member-server-list button').click()");
      await until("document.querySelector('#server-channels .member-channel.selected > span')?.textContent === 'General'", 'Legacy chat appears');
      assert.equal(await run(`!!${queue}`), false);
    }
    console.log('Protected rotation queue UI passed (RU/EN).');
  } catch (error) {
    console.error(error);
    app.exit(1);
    return;
  }
  app.quit();
});
