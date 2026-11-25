const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

app.setPath('userData', join(tmpdir(), 'pawtalk-text-protection-ui-' + process.pid));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 680,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const until = async (condition, label) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await run(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error(label + '\n' + await run('document.body.innerText'));
  };
  const button = "document.querySelector('.protected-text-status-button')";
  const tooltip = "document.querySelector('.protected-text-status-card[role=tooltip]')";
  const panel = "document.querySelector('.protected-text-status-card[role=group]')";
  const send = "document.querySelector('.member-composer button[type=submit]')";
  const selector = "document.querySelector('.member-composer textarea')";
  const status = (color, label) => until(
    `${button}?.dataset.state === ${JSON.stringify(color)} && ${button}.getAttribute('aria-label') === ${JSON.stringify(label)}`, label);

  try {
    for (const language of ['ru', 'en']) {
      const english = language === 'en';
      const green = english ? 'Protection verified' : 'Защита подтверждена';
      const yellow = english ? 'Protection updating' : 'Защита обновляется';
      const red = english ? 'Sending paused' : 'Отправка приостановлена';
      const grey = english ? 'Protection unverified' : 'Защита ещё не проверена';
      await win.loadURL(process.env.PAWTALK_UI_TEST_URL + `/tests/notifications.html?language=${language}&protected=text-protection&pending-chat`);
      await until("!!document.querySelector('.member-server-list button')", 'Server with pending keys appears');
      await run("document.querySelector('.member-server-list button').click()");
      const loading = english ? 'Waiting for the encryption key…' : 'Ждём ключ шифрования…';
      const locked = english ? 'The key for this message is unavailable.' : 'Нет ключа для этого сообщения.';
      await until(`document.querySelector('.protected-history-loading [role=status]')?.textContent.includes(${JSON.stringify(loading)})`, 'Secure access shows its loading state');
      assert.equal(await run("document.querySelectorAll('.protected-history-skeleton-row').length"), 3);
      await until('window.protectedHistoryReads.length === 1', 'The pending chat checks whether older history can already be read');
      assert.equal(await run(`document.body.textContent.includes(${JSON.stringify(locked)})`), false);
      await run("window.finishChannelSync()");
      await until("document.querySelector('.member-history')?.textContent.includes('Synchronized message')", 'Ready access loads the initial history');
      assert.equal(await run("!!document.querySelector('.protected-history-loading')"), false);
      assert.equal(await run(`document.querySelector('.member-history')?.textContent.includes(${JSON.stringify(locked)})`), true);

      await win.loadURL(process.env.PAWTALK_UI_TEST_URL + `/tests/notifications.html?language=${language}&protected=text-protection&pending-chat&pending-key-error`);
      await until("!!document.querySelector('.member-server-list button')", 'Server appears before it advertises the key wait');
      await run("document.querySelector('.member-server-list button').click()");
      await until(`document.querySelector('.protected-key-status')?.textContent.includes(${JSON.stringify(loading)})`, 'A pending-key response shows the waiting state');
      assert.equal(await run("!!document.querySelector('.member-chat-error')"), false);
      await run("window.finishChannelSync()");
      await until("document.querySelector('.member-history')?.textContent.includes('Synchronized message')", 'The pending-key response recovers automatically');

      await win.loadURL(process.env.PAWTALK_UI_TEST_URL + `/tests/notifications.html?language=${language}&protected=text-protection&pending-chat`);
      await until("!!document.querySelector('.member-server-list button')", 'Server with readable history appears');
      await run("window.readablePendingHistory = true; window.openStarted = performance.now(); document.querySelector('.member-server-list button').click()");
      await until("document.querySelector('.member-history')?.textContent.includes('Previously verified history')", 'Readable history opens while keys rotate');
      await until("window.clientPerformance.some(entry => entry.stage === 'chat.open.rendered' && entry.ms < 1000)", 'The renderer logs the time to open history');
      const elapsed = await run('performance.now() - window.openStarted');
      assert.ok(elapsed < 1000, `Readable chat took ${Math.round(elapsed)} ms to render`);
      assert.equal(await run("!!document.querySelector('.protected-history-loading')"), false);

      await win.loadURL(process.env.PAWTALK_UI_TEST_URL + `/tests/notifications.html?language=${language}&protected=text-protection`);
      await until("!!document.querySelector('.member-server-list button')", 'Server appears');
      await run(`(() => {
        const schedule = window.setTimeout.bind(window);
        window.setTimeout = (callback, delay, ...args) => {
          if (delay === 15000) window.expireProtectionObservation = () => callback(...args);
          return schedule(callback, delay, ...args);
        };
      })()`);
      await run("document.querySelector('.member-server-list button').click()");
      await status('green', green);
      assert.deepEqual(await run('window.textProtectionCalls.at(-1)'), {
        serverId: '1'.repeat(32), channelId: '2'.repeat(32), offline: false,
      });
      await run('window.setRotationQueue({waiting:1, processing:0})');
      assert.equal(await run("!!document.querySelector('.protected-rotation-queue')"), false);
      await status('green', green);
      await run(`${button}.focus(); ${button}.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));`);
      await until(`!!${tooltip}`, 'Keyboard focus shows status evidence');
      assert.equal(await run(`${button}.getAttribute('aria-describedby') === ${tooltip}.id`), true);
      await run(`${selector}.focus();
        ${button}.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));`);
      await until(`!!${tooltip}`, 'Hover shows status evidence');
      await run(`${button}.click(); ${button}.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));`);
      await until(`!!${panel} && ${button}.getAttribute('aria-expanded') === 'true'`, 'Click pins evidence');
      await run("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
      await until(`!${panel}`, 'Escape closes evidence');
      await run(`const monochrome = document.createElement('style');
        monochrome.textContent = '.protected-text-status-button svg { color: CanvasText !important; }';
        document.head.append(monochrome);`);
      await run('window.expireProtectionObservation()');
      await status('grey', grey);

      await run("window.setTextProtection({state:'yellow', reason:'PREVIOUS_GRACE', allowSend:true}, true)");
      await status('yellow', yellow);
      await run(`(() => {
        const input = ${selector};
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, 'Kept draft');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await until(`${send}?.disabled === false`, 'Applicable grace leaves send enabled');
      await run("window.setTextProtection({state:'yellow', reason:'CURRENT_GRACE', allowSend:true})");
      await status('yellow', yellow);
      assert.equal(await run(`${send}.disabled`), false);
      await run("window.setTextProtection({state:'red', reason:'KEY_PROOF_INVALID', allowSend:false}, true)");
      await status('red', red);
      assert.equal(await run(`${send}.disabled`), true);
      assert.equal(await run(`${selector}.value`), 'Kept draft');
      await run("document.querySelector('.member-composer').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}))");
      assert.equal(await run('window.protectedSends.length'), 0);

      await run('window.setRotationQueue({waiting:0, processing:0})');
      assert.equal(await run("!!document.querySelector('.protected-rotation-queue')"), false);
      await status('red', red);
      await run('window.setConnected(false)');
      await until('window.textProtectionCalls.some(call => call.offline)', 'IPC observes disconnected channel');
      await status('red', red);
      await run("window.setTextProtection({state:'green', reason:'CURRENT_VERIFIED', allowSend:true}); window.setConnected(true);");
      await status('green', green);
      await until(`${selector}?.value === 'Kept draft' && ${send}?.disabled === false`, 'Restored verified state permits retained draft');
      await run("window.setTextProtection({state:'grey', reason:'WINDOW_UNVERIFIED', allowSend:false})");
      await status('grey', grey);
      assert.equal(await run(`${send}.disabled`), false);
      await run("window.setTextProtection({state:'green', reason:'CURRENT_VERIFIED', allowSend:true})");
      await status('green', green);
      await run('window.setConnected(false)');
      await status('grey', grey);
      await run('window.setConnected(true)');
      await status('green', green);

      const waiting = "{state:'red', reason:'CUTOFF_EXPIRED', allowSend:false, deferredBasis:{revision:2,head:'a'.repeat(64)}}";
      const ready = "{state:'green', reason:'CURRENT_VERIFIED', allowSend:true, deferredBasis:{revision:3,head:'b'.repeat(64)}}";
      await run(`window.setTextProtection(${waiting})`);
      await status('red', red);
      await run(`(() => {
        const input = ${selector};
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, 'Kept draft, still typing');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await until(`${send}?.disabled === false`, 'Explicit queue action is available for a verified cutoff');
      await run(`${send}.click()`);
      await until(`${send}.disabled`, 'A queued draft cannot be submitted again');
      assert.equal(await run('window.protectedSends.length'), 0);
      assert.equal(await run(`${selector}.value`), 'Kept draft, still typing');
      await run(`window.setTextProtection(${ready})`);
      await until(`window.protectedSends.length === 1 && ${selector}?.value === ''`, 'The verified fresh key resumes the queued send');
      const sent = await run('window.protectedSends[0]');
      assert.equal(sent.text, 'Kept draft, still typing');
      assert.deepEqual(sent.deferred, { revision: 2, head: 'a'.repeat(64) });
      await run(`window.setTextProtection(${ready})`);
      assert.equal(await run('window.protectedSends.length'), 1);

      await run(`(() => {
        const input = ${selector};
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, 'Draft after readmission');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })(); window.setTextProtection(${waiting})`);
      await status('red', red);
      await run(`${send}.click(); window.protectedSendError = 'PROTECTED_DEFERRED_ADMISSION_CHANGED'`);
      await until(`${send}.disabled`, 'Second draft queued');
      await run(`window.setTextProtection(${ready})`);
      await until(`window.protectedSends.length === 2 && !${send}.disabled`, 'Re-admission disarms automatic sending');
      assert.equal(await run(`${selector}.value`), 'Draft after readmission');
      await run(`window.setTextProtection(${ready})`);
      assert.equal(await run('window.protectedSends.length'), 2);

      await run("[...document.querySelectorAll('.member-channel')].find(node => node.textContent === 'Meetings').click()");
      assert.equal(await run(`${button}.closest('[data-reorder-id]').dataset.reorderId`), '2'.repeat(32));
      await run('window.dispatchEvent(new Event("focus"))');
      assert.equal(await run("window.textProtectionCalls.some(call => call.channelId === '3'.repeat(32))"), false);

      await win.loadURL(process.env.PAWTALK_UI_TEST_URL + `/tests/notifications.html?language=${language}&protected=text-protection&empty-chat`);
      await until("!!document.querySelector('.member-server-list button')", 'Server with an empty channel appears');
      await run("document.querySelector('.member-server-list button').click()");
      await until("!!document.querySelector('.chat-empty-state .chat-empty-art') && !!document.querySelector('.chat-empty-state button')", 'Confirmed empty chat has a drawn illustration and compose action');
      await run("document.querySelector('.chat-empty-state button').click()");
      await until(`document.activeElement === ${selector}`, 'Compose action focuses the message field');
      assert.equal(await run('window.protectedSends.length'), 0);
      await run(`(() => {
        const input = ${selector};
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, 'Hello');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await until(`${send}?.disabled === false`, 'The first message can be sent normally');
      await run(`${send}.click()`);
      await until("window.protectedSends.length === 1 && !document.querySelector('.chat-empty-state')", 'First message replaces the empty state');

      await win.loadURL(process.env.PAWTALK_UI_TEST_URL + `/tests/notifications.html?language=${language}&protected=text-protection&empty-chat&read-only`);
      await until("!!document.querySelector('.member-server-list button')", 'Server with a read-only channel appears');
      await run("document.querySelector('.member-server-list button').click()");
      await until("!!document.querySelector('.chat-empty-state .chat-empty-art')", 'Read-only empty chat has an illustration');
      assert.equal(await run("!!document.querySelector('.chat-empty-state button')"), false);
    }
    console.log('Protected text status UI passed (RU/EN).');
  } catch (error) {
    console.error(error);
    app.exit(1);
    return;
  }
  app.quit();
});
