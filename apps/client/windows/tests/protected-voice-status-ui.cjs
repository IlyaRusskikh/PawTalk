const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

app.setPath('userData', join(tmpdir(), 'pawtalk-voice-protection-ui-' + process.pid));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 760, height: 680,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const until = async (condition, label) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await run(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error(label + '\n' + await run('document.body.innerText'));
  };
  const channelStatus = digit => `document.querySelector('[data-reorder-id="${digit.repeat(32)}"] .protected-voice-status-button')`;
  let button = channelStatus('3');
  const card = "document.querySelector('.protected-voice-status-card')";
  const connected = "document.querySelector('.member-audio-buttons .member-voice-disconnect')";
  const room = name => run(`[...document.querySelectorAll('.member-channel')].find(node => node.textContent === ${JSON.stringify(name)}).click()`);
  const status = (color, label) => until(
    `${button}?.dataset.state === ${JSON.stringify(color)} && ${button}.getAttribute('aria-label') === ${JSON.stringify(label)}`, label);

  try {
    for (const language of ['ru', 'en']) {
      button = channelStatus('3');
      const english = language === 'en';
      const volume = english ? 1.65 : 1.4;
      const green = english ? 'Voice protection verified' : 'Защита голоса подтверждена';
      const yellow = english ? 'Voice protection updating' : 'Защита голоса обновляется';
      const grey = english ? 'Voice protection unverified' : 'Защита голоса ещё не проверена';
      const red = english ? 'Voice paused' : 'Голос приостановлен';
      const failure = english ? 'Encryption verification was lost. Voice disconnected.' : 'Подтверждение шифрования утрачено. Голос отключён.';
      const selectedText = "document.querySelector('#server-channels .member-channel[aria-current=true]')?.textContent";
      const lastTextKey = 'pawtalk.v3.last-text.' + ['1'.repeat(32), 'a'.repeat(64)].join(':');
      await win.loadURL(process.env.PAWTALK_UI_TEST_URL + `/tests/notifications.html?language=${language}&protected=voice-protection&voice-profile`);
      await until("!!document.querySelector('.member-server-list button')", 'Server appears');
      await run(`localStorage.setItem(${JSON.stringify(lastTextKey)}, '3'.repeat(32))`);
      await run("document.querySelector('.member-server-list button').click()");
      await until(`${selectedText} === 'General'`, 'An invalid saved selection opens the first text channel');
      await room('Lobby');
      await until(`${selectedText} === 'Lobby'`, 'The last visited text channel changes');
      await run(`window.voiceSidebarFixture = { voiceParticipants: [
        { profileId: '${'b'.repeat(64)}', sessionId: '${'e'.repeat(32)}', serverMuted: true }
      ] }; window.refresh();`);
      await run("document.querySelector('.member-sidebar-divider').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))");
      await until("document.getElementById('server-channels').clientWidth === 220", 'Minimum sidebar width is active');
      await status('grey', grey);
      await room('Meetings');
      await until(`${selectedText} === 'Lobby'`, 'The text channel stays visible while voice connects');
      await status('yellow', yellow);
      assert.equal(await run("!!document.querySelector('.member-toolbar button, .member-main > .member-content button')"), false);
      assert.deepEqual(await run('window.voiceProtectionScope'), { serverId: '1'.repeat(32), channelId: '3'.repeat(32) });
      await run(`${button}.focus(); ${button}.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));`);
      await until(`${card}?.role === 'tooltip'`, 'Keyboard focus opens voice protection details');
      assert.equal(await run(`${button}.getAttribute('aria-describedby') === ${card}.id`), true);
      await run(`${button}.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        ${button}.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));`);
      await until(`${card}?.role === 'tooltip'`, 'Hover opens voice protection details');
      await run(`${button}.click(); ${button}.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));`);
      await until(`${card}?.role === 'group' && ${button}.getAttribute('aria-expanded') === 'true'`, 'Click pins the voice card');
      assert.ok(await run(`(() => {
        const card = ${card};
        const panel = document.getElementById('server-channels').getBoundingClientRect();
        const rect = card.getBoundingClientRect();
        return card.scrollWidth <= card.clientWidth && rect.left >= panel.left && rect.right <= panel.right;
      })()`));
      await run("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
      await until(`!${card}`, 'Escape closes the voice card');

      await run('window.completeProtectedVoiceJoin()');
      await status('green', green);
      await until(`!!${connected}`, 'Active voice session exposes disconnect');
      await until("!!document.querySelector('.room-split .member-call-controls .call-leave') && !!document.querySelector('.room-split .member-composer')",
        'The original call toolbar and text composer share the split view');
      await until("!!document.querySelector('.room-split .person-card') && !!document.querySelector('.protected-voice-members .member-channel-person')",
        'The participant appears in the call and beside the voice channel');
      await until("document.querySelector('.room-split .person-card .avatar img')?.naturalWidth === 1",
        'The call uses the authenticated profile avatar');
      await until("!!document.querySelector('.room-split .person-card [data-server=true]')",
        'The server restriction is shown in the call');
      const peerRow = "document.querySelector('.protected-voice-member:not([data-self])')";
      const peerCard = "document.querySelector('.room-split .person-card')";
      const moderationLabels = english ? ['Mute', 'Deafen', 'Server mute', 'Server deafen', 'Disconnect from call'] :
        ['Заглушить', 'Откл. звук', 'Откл. микрофон на сервере', 'Сервер: откл. звук', 'Отключить от звонка'];
      const hasPeerIcons = (selector, count) => `[${peerRow}, ${peerCard}].every(row =>
        row.querySelectorAll('.person-status-icons ${selector}').length === ${count})`;
      const setVoiceFlags = flags => run(`window.voiceSidebarFixture.voiceParticipants[0] = {
        profileId: 'b'.repeat(64), sessionId: 'e'.repeat(32), ...${JSON.stringify(flags)}
      }; window.refresh()`);
      for (const [restriction, icons] of [['serverMuted', 1], ['serverDeafened', 2]]) {
        await setVoiceFlags({ [restriction]: true });
        await until(hasPeerIcons('[data-server=true]', icons), 'The server restriction is red on both surfaces');
        await run(`window.voicePeerTransport = { muted: true, deafened: ${icons === 2} };
          window.voiceLocalTransport = { muted: true };
          window.emitVoiceProtection('green', 'VOICE_VERIFIED', 'connected');`);
        await setVoiceFlags({});
        await until(hasPeerIcons('svg', 0), 'Removing the restriction clears indicators while transport status still lags');
        assert.equal(await run("!!document.querySelector('.protected-voice-member[data-self] .person-status-icons svg')"), false,
          'A stale local publishing permission does not show a self-mute');
      }
      await setVoiceFlags({ serverDeafened: true, selfMuted: true, selfDeafened: true });
      await until(hasPeerIcons('[data-server=true]', 2), 'Server restrictions take precedence over actual self-mute');
      await setVoiceFlags({ selfMuted: true, selfDeafened: true });
      await until(hasPeerIcons('span:not([data-server])', 2), 'An actual self-mute remains visible after lifting server deafen');
      await setVoiceFlags({});
      await until(hasPeerIcons('svg', 0), 'Self-unmute clears both indicators');
      await run("document.querySelector('.protected-voice-member[data-self=true]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))");
      await until("document.querySelectorAll('.member-context [role=menuitem]').length === 2", 'Right-click opens your own audio controls');
      assert.deepEqual(await run("[...document.querySelectorAll('.member-context button')].map(button => button.textContent)"),
        english ? ['Mute microphone', 'Deafen'] : ['Выключить микрофон', 'Выключить звук']);
      await run("document.querySelector('.member-context').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await run(`window.voiceShowServerChoices = true; ${peerRow}.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
      await until("document.querySelectorAll('.member-context button').length === 6", 'Peer menu opens with all moderation actions');
      assert.deepEqual(await run("[...document.querySelectorAll('.member-context button')].slice(1).map(button => button.textContent)"), moderationLabels);
      const peerIcons = `${peerRow}.querySelectorAll('.person-status-icons svg').length`;
      const beforeLocalMute = await run(peerIcons);
      await run("document.querySelector('.member-context button').click()");
      await run(`${peerRow}.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
      await until(`document.querySelector('.member-context button')?.textContent === ${JSON.stringify(english ? 'Unmute participant' : 'Снова слышать участника')}`,
        'Local listening preference is changed');
      assert.equal(await run(peerIcons), beforeLocalMute, 'Local listening preference adds no status icon');
      await run("document.querySelector('.member-context').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      const openCallMenu = () => run(`${peerCard}.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, clientX: innerWidth - 12, clientY: innerHeight - 12
      }))`);
      await openCallMenu();
      assert.equal(await run("!!document.querySelector('.person-menu [role=slider], .person-menu input[type=range]') && !!document.querySelector('.person-menu input[type=checkbox]')"), true);
      await until("document.querySelectorAll('.person-voice-restrictions button').length === 5", 'Moderation actions extend the volume menu');
      assert.deepEqual(await run("[...document.querySelectorAll('.person-voice-restrictions button')].map(button => button.textContent.trim())"), moderationLabels);
      await until(`(() => {
        const menu = document.querySelector('.person-menu');
        const rect = menu.getBoundingClientRect();
        return rect.left >= 8 && rect.top >= 8 && rect.right <= innerWidth - 8 && rect.bottom <= innerHeight - 8;
      })()`, 'Expanded menu stays inside the viewport near the bottom-right corner');
      assert.equal(await run("document.querySelector('.person-menu-profile img')?.naturalWidth === 1"), true);
      assert.equal(await run(`(() => {
        const avatar = document.querySelector('.person-menu-profile .avatar').getBoundingClientRect();
        const name = document.querySelector('.person-menu-profile strong').getBoundingClientRect();
        return name.left - avatar.right < 12;
      })()`), true, 'The participant name sits next to the avatar');
      assert.equal(await run(`[...document.querySelectorAll('.person-menu-action')].every(button => {
        const icon = button.querySelector('svg').getBoundingClientRect();
        const label = button.querySelector('span').getBoundingClientRect();
        return icon.right < label.left;
      })`), true, 'Each moderation action starts with an icon');
      assert.equal(await run("document.querySelectorAll('.person-menu-action[data-separator]').length"), 2);
      assert.equal(await run(`['svg', 'span'].every(selector => {
        const toggle = document.querySelector('.person-menu-toggle > ' + selector).getBoundingClientRect();
        const action = document.querySelector('.person-menu-action > ' + selector).getBoundingClientRect();
        return Math.abs(toggle.left - action.left) < 1;
      })`), true, 'The local listening control aligns with the moderation menu');
      await run("document.querySelector('.person-menu [role=switch]').click()");
      assert.equal(await run("document.querySelector('.person-menu [role=switch]').checked"), false, 'The local listening toggle keeps working');
      await run(`(() => {
        const slider = document.querySelector('.person-menu input[type=range]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, ${volume});
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await until(`JSON.parse(localStorage.getItem('pawtalk.peer-audio.v1'))?.['1'.repeat(32) + ':' + 'b'.repeat(64)]?.volume === ${volume}`,
        'Changing volume saves it by server and profile');
      await run("window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))");
      await until(`!document.querySelector('.person-menu') && document.activeElement === ${peerCard}`, 'Escape restores focus to the participant');
      await openCallMenu();
      await until("document.querySelectorAll('.person-voice-restrictions button').length === 5", 'Moderation actions are available after reopening');
      assert.equal(await run("!!document.querySelector('.person-voice-move')"), false);
      await run("document.querySelector('.person-voice-restrictions button:last-child').click()");
      await until("window.voiceModeration[0]?.action === 'voice.protected.disconnect'", 'Disconnect is applied to the selected participant');
      assert.equal(await run('window.voiceModeration[0].input.targetSessionId'), 'e'.repeat(32));
      await run("window.emitVoiceProtection('grey', 'VOICE_OFFLINE', 'reconnecting')");
      await status('grey', grey);
      await run(`const monochrome = document.createElement('style');
        monochrome.textContent = '.protected-voice-status-button svg { color: CanvasText !important; }';
        document.head.append(monochrome);`);
      await run("window.emitVoiceProtection('red', 'VOICE_ENCRYPTION_LOST', 'disconnected')");
      await status('red', red);
      await until(`!${connected}`, 'Terminal failure clears active connection controls');
      await until(`${selectedText} === 'Lobby' && !!document.querySelector('.member-composer')`, 'A dropped call returns to the last text channel');
      await run(`${button}.click()`);
      await until(`${card}?.textContent.includes(${JSON.stringify(failure)})`, 'Terminal failure is explained after disconnection');
      button = channelStatus('5');
      await room('Breakout');
      await status('yellow', yellow);
      await run('window.completeProtectedVoiceJoin()');
      await status('green', green);
      await until(`!!${connected}`, 'The call can be left manually');
      await run(`${connected}.click()`);
      await until(`${selectedText} === 'Lobby' && !${connected}`, 'Leaving the call returns to the last text channel');
      await win.reload();
      await until("!!document.querySelector('.member-server-list button')", 'Server appears after reload');
      await run("document.querySelector('.member-server-list button').click()");
      await until(`${selectedText} === 'Lobby'`, 'Reopening the server restores the text channel after voice');
      button = channelStatus('5');
      await room('Breakout');
      await status('yellow', yellow);
      await run('window.completeProtectedVoiceJoin()');
      await status('green', green);
      await room('General');
      await status('green', green);
      assert.equal(await run("!!document.querySelector('.protected-text-status-button')"), true);
      button = channelStatus('3');
      await run(`window.voicePeerTransport = { id: 'f'.repeat(32) };
        window.voiceSidebarFixture = { voiceParticipants: [{ profileId: 'b'.repeat(64), sessionId: 'f'.repeat(32) }] };
        window.refresh();`);
      await room('Meetings');
      await status('yellow', yellow);
      await run('window.completeProtectedVoiceJoin()');
      await status('green', green);
      await until(`window.voicePeerAudio['f'.repeat(32)]?.volume === ${volume}`,
        'Volume survives a reload and a new voice session for the same profile');
      await run("window.emitVoiceProtection('green', 'VOICE_VERIFIED', 'connected', { serverId: '4'.repeat(32) })");
      await status('grey', grey);
      await run("document.querySelector('.member-server-list button').dispatchEvent(new MouseEvent('mouseover', {bubbles:true}))");
      await until("!!document.querySelector('.server-voice-preview')", 'Server hover remains available');
      assert.equal(await run("!!document.querySelector('.server-preview-channel, .server-preview-people')"), false, 'An unrelated voice scope is never shown in this server preview');
    }
    console.log('Protected voice status UI passed (RU/EN).');
  } catch (error) {
    console.error(error);
    app.exit(1);
    return;
  }
  app.quit();
});
