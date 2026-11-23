const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

app.setPath('userData', join(tmpdir(), `pawtalk-nickname-ui-${process.pid}`));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 680,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const until = async (condition, label) => {
    for (let attempt = 0; attempt < 125; attempt++) {
      if (await run(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error(`${label}\n${await run('document.body.innerText')}`);
  };
  const click = async (text, selector = 'button') => {
    const target = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(item => item.textContent.trim() === ${JSON.stringify(text)})`;
    await until(`!!${target}`, `Button ${text}`);
    await run(`${target}.click()`);
  };
  const change = (name) => run(`(() => {
    const input = [...document.querySelectorAll('dialog[open]')].at(-1).querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  try {
    for (const language of ['ru', 'en']) {
      const word = (ru, en) => language === 'en' ? en : ru;
      await win.loadURL(`${process.env.PAWTALK_UI_TEST_URL}/tests/notifications.html?language=${language}&protected=owner&own-profile&voice-profile`);
      await until("!!document.querySelector('.member-server-list button')", 'Protected server available');
      await run("document.querySelector('.member-server-list button').click()");
      await until("document.querySelector('#server-channels .member-channel[aria-current=true], #server-channels .member-channel.selected')?.textContent === 'General'", 'Protected channel available');
      const debuggerSession = win.webContents.debugger;
      debuggerSession.attach('1.3');
      try {
        await debuggerSession.sendCommand('DOM.enable');
        await debuggerSession.sendCommand('CSS.enable');
        const { root } = await debuggerSession.sendCommand('DOM.getDocument');
        for (const digit of ['2', '3']) {
          const selector = `[data-reorder-id="${digit.repeat(32)}"] .member-channel`;
          const cursor = () => run(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).cursor`);
          const { nodeId } = await debuggerSession.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
          await debuggerSession.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
          assert.equal(await cursor(), 'pointer');
          await debuggerSession.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover', 'active'] });
          assert.equal(await cursor(), 'grabbing');
          await debuggerSession.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
        }
      } finally { debuggerSession.detach(); }
      const hoverServer = () => run("document.querySelector('.member-server-list button').dispatchEvent(new MouseEvent('mouseover', {bubbles:true}))");
      const leaveServerPreview = () => run("document.querySelector('.member-server-list button').dispatchEvent(new MouseEvent('mouseout', {bubbles:true}))");
      await hoverServer();
      await until(`document.querySelector('.server-voice-preview')?.textContent.includes(${JSON.stringify(word('Нет данных об активных голосовых каналах.', 'No active voice channel information.'))})`, 'A connected API 3 server is not shown as offline');
      await leaveServerPreview();
      const serverMenu = () => run("document.querySelector('.protected-server-title').click()");
      await serverMenu();
      await click(word('Редактировать личный профиль', 'Edit server profile'), '.member-context button');
      await until("[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('input')?.value === 'Me'", 'Own nickname loads');
      await change('My room name');
      await click(word('Сохранить', 'Save'), 'dialog button');
      await until("!document.querySelector('dialog[open]') && document.querySelector('.member-user-text strong')?.textContent === 'My room name'", 'Own nickname updates the normal server UI');
      await run("document.querySelector('.member-user-name').click()");
      await until("document.querySelector('dialog input[maxlength]')?.value === 'My room name' && !document.querySelector('dialog input[maxlength]').disabled", 'Profile settings read the server nickname');
      await run(`(() => {
        const input = document.querySelector('dialog input[maxlength]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Saved from profile');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const image = document.createElement('canvas');
        image.width = image.height = 128;
        const context = image.getContext('2d');
        context.fillStyle = 'royalblue';
        context.fillRect(0, 0, 128, 128);
        return new Promise(resolve => image.toBlob(blob => {
          const picker = document.querySelector('dialog input[type=file]');
          const data = new DataTransfer();
          data.items.add(new File([blob], 'avatar.png', {type:'image/png'}));
          picker.files = data.files;
          picker.dispatchEvent(new Event('change', {bubbles:true}));
          resolve();
        }));
      })()`);
      await until("!!document.querySelector('.avatar-editor canvas')", 'The chosen avatar can be cropped');
      await click(word('Сохранить', 'Save'), '.avatar-editor button');
      await click(word('Сохранить', 'Save'), 'dialog.settings-modal .settings-card button');
      await until(`document.querySelector('dialog.settings-modal [role=status]')?.textContent === ${JSON.stringify(word('Профиль сохранён','Profile saved'))}`, 'Profile Save confirms the write');
      await run("document.querySelector('dialog.settings-modal > .modal-heading button').click()");
      await until("document.querySelector('.member-user-text strong')?.textContent === 'Saved from profile' && !!document.querySelector('.member-message .chat-avatar img')", 'Saved nickname and avatar appear in the active chat');
      assert.equal(await run("document.querySelector('.member-message .chat-avatar img').src === localStorage.getItem('pawtalk.avatar')"), true);
      await click('Meetings', '.member-channel');
      await until("typeof window.completeProtectedVoiceJoin === 'function'", 'Voice has received the profile before establishing the call');
      assert.equal(await run("window.publishedVoiceProfile.name === 'Saved from profile' && window.publishedVoiceProfile.avatar === localStorage.getItem('pawtalk.avatar')"), true);
      await run('window.completeProtectedVoiceJoin()');
      const voiceProfileVisible = name => `[...document.querySelectorAll('.person-card, .member-channel-person')]
        .filter(node => node.getAttribute('aria-label') === ${JSON.stringify(name)})
        .filter(node => node.querySelector('img')?.src === localStorage.getItem('pawtalk.avatar')).length === 2`;
      await until(voiceProfileVisible('Saved from profile'), 'Call and channel strip show the saved nickname and avatar');
      const serverVoiceProfileVisible = name => `document.querySelector('.server-preview-channel strong')?.textContent === 'Meetings' &&
        document.querySelector('.server-preview-people [aria-label="${name}"] img')?.src === localStorage.getItem('pawtalk.avatar')`;
      await hoverServer();
      await until(serverVoiceProfileVisible('Saved from profile'), 'Server hover shows the occupied voice channel and avatar');
      await leaveServerPreview();
      await serverMenu();
      await click(word('Настройки сервера', 'Server settings'), '.member-context button');
      await click(word('Участники', 'Participants'), 'dialog .settings-nav button');
      await until("[...document.querySelectorAll('.protected-server-roster .member-roster-nickname')].some(node => node.textContent === 'Saved from profile')", 'Settings member list sees the saved nickname');
      await run("[...document.querySelectorAll('.protected-server-roster .member-roster-nickname')].find(node => node.textContent === 'Saved from profile').closest('button').click()");
      await click(word('Изменить ник', 'Change nickname'), '.protected-server-roster button');
      await until("document.querySelector('.protected-server-roster dialog input')?.value === 'Saved from profile'", 'Member directory opens the active nickname');
      await change('Saved from directory');
      await click(word('Сохранить', 'Save'), '.protected-server-roster dialog button');
      await until("document.querySelector('.protected-server-roster .protected-roster-card-name strong')?.textContent === 'Saved from directory'", 'Directory card shows the new nickname');
      await run("document.querySelector('dialog.protected-server-settings > .modal-heading button').click()");
      await until("document.querySelector('.member-user-text strong')?.textContent === 'Saved from directory' && document.querySelector('.member-message .chat-meta strong')?.textContent === 'Saved from directory'", 'Directory change reaches the chat without reopening it');
      await until(voiceProfileVisible('Saved from directory'), 'Changing nickname during a call updates voice and the channel strip');
      assert.equal(await run("window.publishedVoiceProfile.name"), 'Saved from directory');
      await run("document.querySelector('.member-home').click()");
      await hoverServer();
      await until(serverVoiceProfileVisible('Saved from directory'), 'Hover still shows the active call from the home screen');
      await run("document.querySelector('.member-server-list button').click()");
      await until("[...document.querySelectorAll('.protected-channel-roster .member-roster-nickname')].some(node => node.textContent === 'Friend')", 'Text roster is available again');
      await run(`[...document.querySelectorAll('.protected-channel-roster .member-roster-nickname')]
        .find(node => node.textContent === 'Friend').closest('button').click()`);
      await click(word('Изменить ник', 'Change nickname'), '.protected-channel-roster button');
      await until("[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('input')?.value === 'Friend'", 'Target nickname loads');
      await change('New friend name');
      await click(word('Сохранить', 'Save'), 'dialog button');
      await until("document.querySelector('.protected-roster-card-name strong')?.textContent === 'New friend name'", 'Current card reflects the rename');

      const renameServer = word('Переименовать сервер', 'Rename server');
      const serverAvatar = word('Аватар сервера', 'Server avatar');
      await win.loadURL(`${process.env.PAWTALK_UI_TEST_URL}/tests/notifications.html?language=${language}&protected=reader`);
      await until("!!document.querySelector('.member-server-list button')", 'Protected viewer can select the server');
      await run("document.querySelector('.member-server-list button').click()");
      await until("document.querySelector('#server-channels .member-channel[aria-current=true], #server-channels .member-channel.selected')?.textContent === 'General'", 'Viewer connects');
      await serverMenu();
      assert.equal(await run(`[...document.querySelectorAll('.member-context button')].some(button =>
        ${JSON.stringify([renameServer, serverAvatar])}.includes(button.textContent.trim()))`), false);
      assert.equal(await run("!!document.querySelector('.member-server-list .member-server-avatar')"), true);

      await win.loadURL(`${process.env.PAWTALK_UI_TEST_URL}/tests/notifications.html?language=${language}&protected=community-editor`);
      await until("!!document.querySelector('.member-server-list button')", 'Protected editor can select the server');
      await run("document.querySelector('.member-server-list button').click()");
      await until("document.querySelector('#server-channels .member-channel[aria-current=true], #server-channels .member-channel.selected')?.textContent === 'General'", 'Editor connects');
      await serverMenu();
      await click(word('Настройки сервера', 'Server settings'), '.member-context button');
      const profile = '.protected-server-profile';
      const saveName = () => click(word('Сохранить изменения', 'Save changes'), `${profile} button`);
      await until("document.querySelector('.protected-server-profile input')?.value === 'Synthetic notification server'", 'The current community name loads');
      assert.equal(await run("document.querySelectorAll('dialog[open]').length"), 1);
      assert.equal(await run("!!document.querySelector('.protected-server-profile-actions')"), false);
      await change('Stale draft');
      assert.equal(await run(`(() => {
        const buttons = [...document.querySelectorAll('.protected-server-profile-actions button')];
        return buttons.length === 2 && buttons[0].offsetHeight === buttons[1].offsetHeight &&
          buttons[0].getBoundingClientRect().top === buttons[1].getBoundingClientRect().top;
      })()`), true, 'Save and reset align and have identical heights');
      await run("window.setCommunityName('Concurrent update')");
      await saveName();
      await until("!!document.querySelector('.protected-server-profile [role=alert]')", 'A stale community edit displays a conflict');
      assert.equal(await run("document.querySelector('.protected-server-profile input').value"), 'Stale draft');
      await click(word('Сбросить', 'Reset'), `${profile} button`);
      await until("document.querySelector('.protected-server-profile input')?.value === 'Concurrent update'", 'Reset loads the current name in place');
      await change('Renamed community');
      await saveName();
      await until("document.querySelector('.protected-server-title span')?.textContent === 'Renamed community' && document.querySelectorAll('dialog[open]').length === 1",
        'The updated name is shown in the sidebar');
      await until("!!document.querySelector('.protected-server-profile-toast [role=status]') && !document.querySelector('.protected-server-profile-actions')", 'Saved profile shows a notification and removes the save actions');
      await run("document.querySelector('dialog.protected-server-settings > .modal-heading button').click()");
      await serverMenu();
      await click(word('Настройки сервера', 'Server settings'), '.member-context button');
      await click(serverAvatar, 'dialog.protected-server-settings button');
      await click(word('Удалить аватар', 'Remove avatar'), 'dialog button');
      await click(word('Сохранить', 'Save'), 'dialog button');
      await until("document.querySelectorAll('dialog[open]').length === 1 && !document.querySelector('.member-server-list .member-server-avatar')",
        'Protected avatar disappears from the sidebar after removal');
      assert.deepEqual(await run('window.protectedAvatarUpdate'), { serverId: '1'.repeat(32), avatar: null, expectedRevision: 2 });

      await win.loadURL(`${process.env.PAWTALK_UI_TEST_URL}/tests/notifications.html?language=${language}&protected=roster-pagination`);
      await until("!!document.querySelector('.member-server-list button')", 'Protected paginated roster available');
      await run(`(() => {
        const schedule = window.setInterval.bind(window);
        window.setInterval = (callback, delay, ...args) => {
          if (delay === 15000) window.refreshRoster = () => callback(...args);
          return schedule(callback, delay, ...args);
        };
        document.querySelector('.member-server-list button').click();
      })()`);
      await click(word('Показать ещё', 'Show more'), '.protected-channel-roster button');
      const rowNames = "[...document.querySelectorAll('.protected-channel-roster .member-roster-nickname')]";
      await until(`${rowNames}.some(node => node.textContent === 'Friend')`, 'Second page contains the participant');
      await run('window.refreshRoster()');
      await until('window.rosterPageRequests.length === 3', 'Unchanged roster refreshes its first page only');
      assert.equal(await run('window.rosterPageRequests.filter(Boolean).length'), 1);
      await run(`${rowNames}.find(node => node.textContent === 'Friend').closest('button').click()`);
      await until("document.querySelector('.protected-roster-card-name strong')?.textContent === 'Friend'", 'Second-page member profile is open');
      await run('window.renameRosterFixtureMember(); window.refreshRoster()');
      await until("document.querySelector('.protected-roster-card-name strong')?.textContent === 'Updated on next page'", 'Open member profile reflects the new nickname');
      await click(word('Назад', 'Back'), '.protected-channel-roster button');
      await until(`${rowNames}.some(node => node.textContent === 'Updated on next page')`, 'Open second page displays the renamed participant');
      assert.equal(await run('window.rosterPageRequests.filter(Boolean).length'), 2);
    }
    console.log('PASS protected nickname and community name editors (RU/EN, synthetic IPC)');
  } finally {
    win.destroy();
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
