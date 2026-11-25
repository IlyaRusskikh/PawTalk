const { app, BrowserWindow, session } = require('electron');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

app.setPath('userData', join(tmpdir(), 'pawtalk-protected-channel-ui-' + process.pid));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, allow) => allow(permission === 'media'));
  const win = new BrowserWindow({ show: false, width: 900, height: 680,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = async code => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (error) { throw Error(`Renderer command failed: ${code}`, { cause: error }); }
  };
  const until = async (condition, label, attempts = 125) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await run(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error(label + '\n' + await run('document.body.innerText'));
  };
  const click = async (text, selector = 'button') => {
    const match = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(button =>
      (button.querySelector('.permission-subject-name') ?? button).textContent.trim() === ${JSON.stringify(text)})`;
    await until(`!!${match}`, `Button ${text} matches ${selector}`);
    return run(`${match}.click()`);
  };
  const choose = (selector, value) => run(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const enter = (selector, value) => run(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  const motion = value => win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value }],
  });
  try {
    for (const language of ['ru', 'en']) {
      const english = language === 'en';
      const settings = english ? 'Channel settings' : 'Настройки канала';
      const reorder = english ? 'Reorder channels' : 'Изменить порядок каналов';
      const preview = english ? 'Preview' : 'Предпросмотр';
      const apply = english ? 'Apply' : 'Применить';
      const createChannel = english ? 'Create channel' : 'Создать канал';
      const createCategory = english ? 'Create category' : 'Создать категорию';
      const load = async (profile, seen) => {
        await win.loadURL(process.env.PAWTALK_UI_TEST_URL + `/tests/notifications.html?language=${language}&protected=${profile}`);
        await until("!!document.querySelector('.member-server-list button')", 'Server appears');
        if (profile.startsWith('paging-chat')) {
          const key = 'pawtalk.v3.read.' + ['1'.repeat(32), 'a'.repeat(64), '2'.repeat(32)].join(':');
          await run(seen === undefined ? `localStorage.removeItem(${JSON.stringify(key)})`
            : `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(String(seen))})`);
        }
        await run("window.chatOpenStarted = performance.now(); document.querySelector('.member-server-list button').click()");
        await until("document.querySelector('#server-channels .member-channel[aria-current=true], #server-channels .member-channel.selected')?.textContent === 'General'", 'Protected channel appears');
      };
      await load('paging-chat');
      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
      await motion('no-preference');
      const entry = position => `[...document.querySelectorAll('.member-history article')].find(row => row.textContent.includes('Entry ${position}'))`;
      await until(`!!${entry(96)} && !!${entry(65)}`, 'Opens on the latest page');
      await run("document.querySelector('.member-roster-toggle[aria-expanded=false]')?.click()");
      await until("document.querySelector('.member-roster-toggle').getAttribute('aria-expanded') === 'true'", 'The roster starts open for the resize test');
      await run(`(() => {
        const style = document.head.appendChild(document.createElement('style'));
        style.id = 'chat-resize-fixture';
        style.textContent = '.protected-chat-stream { container-type: inline-size } .protected-chat-stream article { min-height: 13cqw }';
        const list = document.querySelector('.protected-chat-stream');
        list.scrollTop = list.scrollHeight;
        Object.defineProperty(document, 'hasFocus', { value: () => true });
        window.dispatchEvent(new Event('focus'));
        window.lastVisibleEntry = () => {
          const box = list.getBoundingClientRect();
          return [...list.querySelectorAll('article')].reverse().find(row => {
            const bounds = row.getBoundingClientRect();
            return bounds.top < box.bottom && bounds.bottom > box.top;
          })?.textContent;
        };
      })()`);
      const toggleRoster = () => run("document.querySelector('.member-roster-toggle').click()");
      const drawer = "document.querySelector('.member-roster-drawer')";
      await toggleRoster();
      await until(`${drawer}.clientWidth === 0 && window.lastVisibleEntry()?.includes('Entry 96')`, 'Widening a chat keeps it at the latest message');
      await run(`(async () => {
        document.querySelector('.protected-chat-stream').scrollTop -= 233;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      })()`);
      await until("!window.lastVisibleEntry()?.includes('Entry 96')", 'Scroll back into history');
      const savedBottom = await run('window.lastVisibleEntry()');
      await toggleRoster();
      await until(`${drawer}.clientWidth === ${drawer}.querySelector('aside').clientWidth + 1`, 'Roster expands fully');
      assert.equal(await run('window.lastVisibleEntry()'), savedBottom, 'Changing chat width preserves the bottom visible message');
      await until("!!document.querySelector('.protected-chat-jump')", 'Scroll down is available while reading older messages');
      const correctJumpGeometry = `(() => {
        const button = document.querySelector('.protected-chat-jump');
        const rect = button.getBoundingClientRect();
        const feed = button.parentElement.getBoundingClientRect();
        const arrow = button.querySelector('svg').getBoundingClientRect();
        return rect.width === 40 && rect.height === 40 && getComputedStyle(button).borderRadius === '50%' &&
          Math.abs(feed.right - rect.right - 16) < 1 && Math.abs(feed.bottom - rect.bottom - 32) < 1 &&
          Math.abs(rect.left + rect.width / 2 - arrow.left - arrow.width / 2) < 1;
      })()`;
      assert.equal(await run(correctJumpGeometry), true, 'The jump uses the released circular geometry at the bottom right');
      assert.equal(await run("!!document.querySelector('.protected-chat-jump .chat-jump-count')"), false);
      await run("window.pagingChatLast = 97; window.invalidateGeneralChat()");
      await until(`!!${entry(97)} && document.querySelector('.protected-chat-jump .chat-jump-count')?.textContent === '1'`,
        'The unread count appears on the circular button');
      assert.equal(await run(correctJumpGeometry), true, 'The badge leaves the circular button in place');
      assert.equal(await run('window.lastVisibleEntry()'), savedBottom, 'An incoming message keeps the current viewport');
      await until("!!document.querySelector('.chat-unread-divider')", 'New messages have an inline divider');
      await run("document.querySelector('.member-composer textarea').click()");
      assert.equal(await run("!!document.querySelector('.chat-unread-divider:not([data-closing])')"), true,
        'Clicking the composer before reading retains the marker');
      const jump = await run(`(() => {
        const list = document.querySelector('.protected-chat-stream');
        const bottom = list.scrollHeight - list.clientHeight;
        const original = list.scrollTo;
        let request;
        list.scrollTo = function(options) {
          request = { behavior: options.behavior, top: options.top, start: this.scrollTop };
          original.call(this, options);
        };
        try { document.querySelector('.protected-chat-jump').click(); }
        finally { delete list.scrollTo; }
        return { request, bottom };
      })()`);
      assert.equal(jump.request?.behavior, 'smooth');
      assert.equal(jump.request.top, jump.bottom);
      assert.ok(jump.request.start < jump.bottom, 'The smooth scroll starts above the bottom');
      await until("window.lastVisibleEntry()?.includes('Entry 97') && !document.querySelector('.protected-chat-jump') && (() => {const list = document.querySelector('.protected-chat-stream'); return list.scrollHeight - list.clientHeight - list.scrollTop <= 1;})()",
        'The jump brings the latest message into view and dismisses the button');
      await run("document.getElementById('chat-resize-fixture').remove()");
      assert.equal(await run(`!!${entry(95)}.querySelector('.chat-avatar') &&
        ${entry(96)}.classList.contains('chat-message-continuation') && !!${entry(97)}.querySelector('.chat-avatar')`), true,
        'The unread divider is the only reason the third message starts a new group');
      await run("document.querySelector('.member-composer textarea').click()");
      await until("!!document.querySelector('[data-regrouping]')", 'Clicking the composer animates grouping alongside the divider');
      const regroupGeometry = await run(`(() => {
        const row = ${entry(97)};
        const list = row.closest('.protected-chat-stream');
        const animations = list.getAnimations({ subtree: true }).filter(animation =>
          /^chat-(unread-dismiss|regroup-)/.test(animation.animationName));
        const measure = () => [row.offsetHeight, row.querySelector('.member-message-text').getBoundingClientRect().top -
          row.getBoundingClientRect().top, Number(getComputedStyle(row.querySelector('.chat-avatar')).opacity)];
        const sample = time => {
          for (const animation of animations) {
            animation.pause();
            animation.currentTime = time * animation.effect.getTiming().duration;
          }
          return measure();
        };
        const start = sample(0), middle = sample(.5), end = sample(1);
        for (const animation of animations) animation.finish();
        return { start, middle, end };
      })()`);
      regroupGeometry.middle.forEach((value, index) => assert.ok(value < regroupGeometry.start[index] && value > regroupGeometry.end[index],
        'Message height, text offset and avatar opacity change throughout the animation'));
      await until("!document.querySelector('.chat-unread-divider')", 'The divider is removed when the animation ends');
      assert.equal(await run(`${entry(97)}.classList.contains('chat-message-continuation') && !${entry(97)}.querySelector('.chat-avatar')`), true);
      assert.ok(Math.abs(await run(`${entry(97)}.offsetHeight`) - regroupGeometry.end[0]) <= 1,
        'Regrouping completes without another change in message height');
      assert.equal(await run(`!!${entry(64)} || !!document.querySelector('.member-load:not(.chat-jump)')`), false);
      const offsetBeforePage = await run(`(() => {
        const history = document.querySelector('.member-history');
        history.scrollTop = 0;
        const offset = ${entry(65)}.querySelector('.member-message-text').getBoundingClientRect().top - history.getBoundingClientRect().top;
        history.dispatchEvent(new WheelEvent('wheel', {deltaY:-120,bubbles:true}));
        return offset;
      })()`);
      await until(`!!${entry(33)}`, 'Scrolling upward prepends an older page');
      assert.equal(await run(`${entry(65)}.classList.contains('chat-message-continuation')`), true);
      const offsetAfterPage = await run(`${entry(65)}.querySelector('.member-message-text').getBoundingClientRect().top -
        document.querySelector('.member-history').getBoundingClientRect().top`);
      assert.ok(Math.abs(offsetAfterPage - offsetBeforePage) < 2, 'Prepending keeps the same text at the same position even when the row regroups');
      const visibleGrowth = await run(`(async()=>{
        const history = document.querySelector('.member-history');
        const viewport = history.getBoundingClientRect(), middle = (viewport.top + viewport.bottom) / 2;
        const top = ${entry(65)};
        const distance = row => {
          const bounds = row.getBoundingClientRect();
          return Math.max(0, bounds.top - middle, middle - bounds.bottom);
        };
        const center = [...history.querySelectorAll('.chat-message-row')].sort((a, b) => distance(a) - distance(b))[0];
        if (!center || top.contains(center)) throw Error('Expected separate visible messages at the top and center');
        const before = center.getBoundingClientRect().top;
        const pendingCard = document.createElement('div');
        pendingCard.style.height = '64px';
        top.querySelector('.chat-message-row').append(pendingCard);
        // The browser can deliver scroll before resize when both land in the same frame.
        history.scrollTop -= 24;
        history.dispatchEvent(new Event('scroll'));
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return Math.abs(center.getBoundingClientRect().top - before - 24);
      })()`);
      assert.ok(visibleGrowth < 2, 'An expanding card preserves the concurrent upward scroll without adding a layout shift');
      await load('paging-chat', 48);
      await until(`!!${entry(49)} && !!${entry(80)}`, 'A previously read channel opens at the first unread message');
      assert.equal(await run(`!!${entry(48)}`), false);
      assert.equal(await run("document.querySelector('.chat-unread-divider').nextElementSibling.textContent.includes('Entry 49')"), true);
      await run(`(() => {
        const list = document.querySelector('.protected-chat-stream');
        const scrollTo = list.scrollTo;
        list.scrollTo = function(options) {
          if (options.behavior !== 'smooth') return scrollTo.call(this, options);
          delete list.scrollTo;
          // Deliver the next message before the native scroll reaches its target.
          window.latestScrollStarted = true;
        };
        document.querySelector('.protected-chat-jump').click();
      })()`);
      await until(`!!${entry(96)} && window.latestScrollStarted`, 'The jump loads the final page and starts scrolling');
      const incomingMotion = await run(`new Promise(resolve => {
        const list = document.querySelector('.protected-chat-stream');
        const start = list.scrollTop;
        const deadline = performance.now() + 3000;
        window.pagingChatLast = 97;
        window.invalidateGeneralChat();
        let faded = false, moved = false;
        function observe() {
          const row = ${entry(97)};
          const bottom = list.scrollHeight - list.clientHeight;
          if (row && Number(getComputedStyle(row).opacity) < 0.99) faded = true;
          if (list.scrollTop > start + 1 && list.scrollTop < bottom - 1) moved = true;
          if (performance.now() < deadline && (!faded || !moved || bottom - list.scrollTop >= 2)) requestAnimationFrame(observe);
          else resolve({ faded, moved, atBottom: bottom - list.scrollTop < 2 });
        }
        requestAnimationFrame(observe);
      })`);
      assert.deepEqual(incomingMotion, { faded: true, moved: true, atBottom: true }, 'A protected incoming message appears while the chat scrolls smoothly');
      await load('paging-chat', 95);
      await until(`!!${entry(84)} && !!${entry(96)}`, 'A single unread message arrives together with the preceding context');
      assert.deepEqual(await run('window.protectedHistoryReads.map(read => read.after)'), [83]);
      assert.equal(await run(`!!${entry(83)}`), false);
      await load('paging-chat&composer-activity');
      await until(`!!${entry(96)}`, 'The composer activity fixture opens');
      const compose = '.protected-chat-input-shell textarea';
      const composeGeometry = `(() => {
        const history = document.querySelector('.protected-chat-stream').getBoundingClientRect();
        const slot = document.querySelector('.chat-composer-activity-slot').getBoundingClientRect();
        const input = document.querySelector('${compose}').getBoundingClientRect();
        return [history.bottom, slot.top, slot.bottom, input.top];
      })()`;
      const reservedSpace = await run(composeGeometry);
      assert.ok(reservedSpace[0] <= reservedSpace[1] && reservedSpace[1] < reservedSpace[2] && reservedSpace[2] <= reservedSpace[3],
        'Composer activity has a reserved row between the history and input');
      await enter(compose, 'Hello');
      await enter(compose, 'Hello again');
      assert.deepEqual(await run('window.composerCalls.map(call => call.activity)'), ['typing']);
      await enter(compose, '');
      await until("window.composerCalls.at(-1)?.activity === 'idle'", 'Clearing text stops typing');
      assert.equal(await run("window.composerCalls.every(call => Object.keys(call).length === 3)"), true);
      await run("window.emitComposerActivity('typing', '6'.repeat(32)); window.emitComposerActivity('typing', '2'.repeat(32), 'a'.repeat(64))");
      assert.equal(await run("!!document.querySelector('.chat-composer-activity')"), false);
      const composerStatus = "document.querySelector('.chat-composer-activity')?.textContent";
      await run("window.emitComposerActivity('typing')");
      await until(`${composerStatus} === ${JSON.stringify(english ? 'Friend is typing…' : 'Friend печатает…')}`, 'An incoming typing event shows the author');
      assert.equal(await run("getComputedStyle(document.querySelector('.chat-composer-activity-slot')).marginBottom"), '4px');
      assert.deepEqual(await run(composeGeometry), reservedSpace, 'Typing does not shift the chat or input');
      assert.equal(await run("document.querySelectorAll('.chat-typing-paws svg').length"), 3);
      await run("window.emitComposerActivity('recording')");
      await until(`${composerStatus} === ${JSON.stringify(english ? 'Friend is recording a voice message…' : 'Friend записывает голосовое сообщение…')}`,
        'Recording replaces typing for the same author');
      assert.deepEqual(await run(composeGeometry), reservedSpace, 'Voice recording uses the same reserved row');
      const catFrames = await run(`[...document.querySelectorAll('.chat-recording-cats svg')].map(frame =>
        [!!frame.querySelector('ellipse'), getComputedStyle(frame).animationDelay])`);
      assert.deepEqual(catFrames, [[false, '0s'], [true, '0.16s'], [false, '0.32s']], 'The cat mouths and animation delays follow the three beats');
      await run("window.emitComposerActivity('idle')");
      await until(`!${composerStatus}`, 'The remote activity stops immediately');
      await run("document.querySelector('.chat-attachment-control button').click()");
      await click(english ? 'Record voice message' : 'Записать голосовое', '[role=menuitem]');
      await until("window.composerCalls.at(-1)?.activity === 'recording'", 'A live microphone recording is published');
      await run("document.querySelector('.voice-composer .voice-stop').click()");
      await until("window.composerCalls.at(-1)?.activity === 'idle'", 'Stopping recording clears the activity in preview');
      await load('formatted-chat');
      await until("document.querySelector('.member-history a[href=\"https://example.test/\"]')?.textContent === 'Example'", 'Protected messages render links');
      await until("document.querySelector('.chat-meta strong')?.textContent === 'Friend'", 'The authenticated author is labelled from the channel roster');
      assert.equal(await run("getComputedStyle(document.querySelector('.chat-meta strong')).color"), 'rgb(90, 137, 188)',
        'The chat nickname uses the same role color as the roster');
      assert.notEqual(await run("getComputedStyle(document.querySelector('.chat-message-body')).color"), 'rgb(90, 137, 188)',
        'Role color does not change the message body');
      await until("document.querySelector('.chat-avatar img')?.naturalWidth === 1", 'The channel uses the author avatar');
      await until("!!document.querySelector('.member-roster-toggle[aria-expanded=true]')", 'The roster toggle is always available');
      const togglePosition = await run("JSON.stringify(document.querySelector('.member-roster-toggle').getBoundingClientRect().toJSON())");
      await run("document.querySelector('.member-roster-toggle').click()");
      await until("document.querySelector('.member-roster-drawer').clientWidth === 0 && document.querySelector('.member-roster-drawer').inert",
        'The drawer collapses and becomes unfocusable');
      assert.equal(await run("JSON.stringify(document.querySelector('.member-roster-toggle').getBoundingClientRect().toJSON())"), togglePosition);
      await run("document.querySelector('.member-roster-toggle').click()");
      await until("document.querySelector('.member-roster-drawer').clientWidth === document.querySelector('.member-roster-drawer .member-roster').clientWidth + 1",
        'The open drawer settles at the roster width');
      assert.equal(await run("getComputedStyle(document.querySelector('.member-roster-toggle')).backgroundColor === getComputedStyle(document.querySelector('.member-roster-drawer .member-roster')).backgroundColor"), true);
      assert.equal(await run("getComputedStyle(document.querySelector('#server-channels .member-channel')).paddingTop"), '7px');
      assert.equal(await run("document.querySelectorAll('.member-history .chat-message-continuation').length"), 1);
      assert.equal(await run("document.querySelector('.chat-meta').tagName"), 'DIV');
      assert.equal(await run("getComputedStyle(document.querySelector('.protected-chat-submit')).clipPath"), 'inset(50%)');
      await run("document.querySelector('.chat-stream').dispatchEvent(new Event('scroll'))");
      await until("!!document.querySelector('.chat-stream.is-scrolling')", 'Scrollbar appears during scrolling');
      await until("!document.querySelector('.chat-stream.is-scrolling')", 'Scrollbar fades after scrolling');
      const selectChannel = name => run(`[...document.querySelectorAll('.member-channel')].find(button => button.textContent.trim() === ${JSON.stringify(name)}).click()`);
      await run(`(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const channels = [...document.querySelectorAll('.member-channel')];
        const lobby = channels.find(button => button.textContent.trim() === 'Lobby');
        const general = channels.find(button => button.textContent.trim() === 'General');
        lobby.click();
        await frame();
        general.click();
      })()`);
      assert.equal(await run("window.protectedHistoryReads.includes('6'.repeat(32))"), false, 'A channel passed during navigation does not start loading');
      await selectChannel('Lobby');
      await until("document.querySelector('#server-channels .member-channel[aria-current=true], #server-channels .member-channel.selected')?.textContent === 'Lobby' && window.protectedHistoryReads.length === 2", 'The second channel loads once');
      await selectChannel('General');
      await until("document.querySelector('.member-history a')?.textContent === 'Example'", 'History survives switching channels');
      assert.equal(await run('window.protectedHistoryReads.length'), 2);
      await run('window.throttleProtectedChat = true; window.invalidateGeneralChat()');
      await until("!!document.querySelector('.protected-chat-cooldown')", 'An open channel explains the server cooldown');
      assert.equal(await run("document.querySelector('#server-channels .member-channel[aria-current=true], #server-channels .member-channel.selected')?.textContent"), 'General');
      assert.equal(await run("document.querySelector('.member-history a')?.textContent"), 'Example');
      assert.equal(await run("document.body.textContent.includes('RATE_LIMIT')"), false);
      await run('window.throttleProtectedChat = false');
      await until('window.protectedHistoryReads.length === 3', 'The event invalidates cached history and the rate-limited request retries');
      await until("!document.querySelector('.protected-chat-cooldown')", 'An accepted response clears the cooldown notice');
      assert.deepEqual(await run("[...document.querySelectorAll('.member-history .chat-mention')].map(node => [node.textContent, node.parentElement.tagName])"),
        [['@Friend', 'STRONG'], ['@Crew', 'SPAN']]);
      await until("[...document.querySelectorAll('.chat-mention')].some(node => node.textContent === '@Crew' && getComputedStyle(node).backgroundColor === 'rgb(90, 137, 188)')", 'Verified role mentions use their role color');
      await until("document.querySelector('.member-history img.chat-link-gif')?.naturalWidth === 1", 'Protected link preview displays the resolved GIF');
      const composerHeight = () => run("document.querySelector('.protected-chat-input-shell').getBoundingClientRect().height");
      const emptyHeight = await composerHeight();
      await click('', '.member-composer .chat-preview-toggle');
      assert.equal(await composerHeight(), emptyHeight, 'Empty preview preserves composer height');
      await click('', '.member-composer .chat-preview-toggle');
      await enter('.member-composer textarea', '**Previewed** [Draft](https://example.test/draft)');
      await run("document.querySelector('.member-composer textarea').focus(); document.querySelector('.member-composer textarea').select()");
      await until("!!document.querySelector('.chat-format-toolbar')", 'Selection opens formatting in the protected composer');
      const draftHeight = await composerHeight();
      await click('', '.member-composer .chat-preview-toggle');
      await until("document.querySelector('.chat-compose-preview strong')?.textContent === 'Previewed'", 'Protected composer previews formatted drafts');
      assert.equal(await composerHeight(), draftHeight, 'Formatted preview preserves composer height');
      assert.equal(await run("document.querySelector('.chat-compose-preview a')?.textContent"), 'Draft');
      await click('', '.member-composer .chat-preview-toggle');
      await until("document.activeElement === document.querySelector('.member-composer textarea')", 'Closing the preview returns focus to the draft');
      assert.equal(await run("document.querySelector('.member-composer textarea')?.value"), '**Previewed** [Draft](https://example.test/draft)');
      assert.equal(await run('window.protectedSends.length'), 0);
      await enter('.member-composer textarea', '  \n**Previewed** [Draft](https://example.test/draft)\n\n\n\n\nMore\n  ');
      await run(`(() => {
        window.observedSendFlight = false;
        const observer = new MutationObserver(records => {
          for (const { addedNodes } of records) {
            const layer = [...addedNodes].find(node => node.classList?.contains('chat-send-flight'));
            if (!layer) continue;
            window.observedSendFlight = layer.parentElement === document.body && layer.getAnimations({ subtree: true }).length > 0;
            observer.disconnect();
          }
        });
        observer.observe(document.body, { childList: true });
        window.holdProtectedSend = true;
        document.querySelector('.member-composer button[type=submit]').click();
      })()`);
      await until("typeof window.releaseProtectedSend === 'function' && document.querySelector('.chat-message-pending')?.textContent.includes('Previewed')", 'Sending displays an outgoing row');
      assert.equal(await run(`(() => {
        const pendingText = document.querySelector('.chat-message-pending .member-message-text strong');
        const confirmedText = document.querySelector('.member-message:not(.chat-message-pending) .member-message-text');
        const swatch = document.createElement('span');
        swatch.style.color = 'var(--muted)';
        pendingText.append(swatch);
        const muted = getComputedStyle(swatch).color;
        const pending = getComputedStyle(pendingText).color;
        swatch.remove();
        return pending === muted && pending !== getComputedStyle(confirmedText).color;
      })()`), true, 'Unconfirmed text uses the muted theme color until receipt');
      await until('window.observedSendFlight', 'The protected send animates outside the scrolling history');
      assert.equal(await run('window.protectedSends[0].text'), '**Previewed** [Draft](https://example.test/draft)\n\n\nMore');
      await run('window.releaseProtectedSend()');
      await until("!document.querySelector('.chat-message-pending') && !document.querySelector('.member-composer textarea').value", 'Acknowledgement clears the pending state and draft');
      assert.equal(await run("document.querySelectorAll('.member-history .member-message-text strong').length"), 2, 'Acknowledged text remains visible while history catches up');
      await run('window.deliverFormattedSend = true; window.invalidateGeneralChat()');
      await until("document.querySelector('.member-message:has(.member-message-actions button:nth-child(2)) .member-message-text')?.textContent.includes('Previewed')", 'History replaces the acknowledged row');
      await enter('.member-composer textarea', '@Fri');
      await until(`!!document.querySelector('.protected-mention-input [role=option]')`, 'Protected mention choices open above the composer');
      assert.equal(await run(`(() => {
        const option = document.querySelector('.protected-mention-input [role=option]');
        const rect = option.getBoundingClientRect();
        return option.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
      })()`), true, 'The composer shell does not clip mention choices');
      if (!english) {
        await load('history');
        await until("document.querySelector('.member-history')?.textContent.includes('Old history')", 'Russian history page is open');
        await run('window.setConnected(false)');
        await until("document.querySelector('.member-chat')?.textContent.includes('Актуальность доступа не подтверждена.')", 'Offline access notice is localized');
        assert.ok(await run("document.querySelector('.member-history').textContent.includes('Old history')"));
        await run('window.setConnected(true)');
        await until("!document.querySelector('.member-chat').textContent.includes('Актуальность доступа не подтверждена.')", 'Restored connection clears the offline notice');
      }
      if (english) {
        await load('history');
        await until("document.querySelector('.member-history')?.textContent.includes('Old history')", 'First history page is open');
        assert.match(await run("document.querySelector('.chat-reply-quote')?.title"), /Old history/);
        await run("document.querySelector('.member-message button[aria-label=Reply]').click()");
        await until("document.querySelector('.protected-reply-draft')?.textContent.includes('Old history')", 'Reply draft previews its source');
        await enter('.member-composer textarea', 'Local draft');
        await run('window.historyFirst = 2');
        await until("document.querySelector('.member-history')?.textContent.includes('Continuous admission') && !document.querySelector('.member-history').textContent.includes('Old history')", 'History narrows while more pages are available', 200);
        assert.equal(await run("document.querySelector('.member-reply')?.textContent"), 'The original message is no longer available.');
        assert.equal(await run("!!document.querySelector('.protected-reply-draft')"), false);
        await run("document.querySelector('.member-message button[aria-label=Reply]').click()");
        await until("document.querySelector('.protected-reply-draft')?.textContent.includes('Continuous admission')", 'Second reply draft previews its source');
        await run('window.setConnected(false)');
        await until("document.querySelector('.member-chat')?.textContent.includes('Current access is unconfirmed.')", 'Cached access is marked unconfirmed offline');
        assert.ok(await run("document.querySelector('.member-history').textContent.includes('Continuous admission')"));
        assert.equal(await run("document.querySelector('.member-composer button[type=submit]').disabled"), true);
        assert.equal(await run("!!document.querySelector('.member-message-actions')"), false);
        await run('window.setProtectedChatVisible(false)');
        assert.ok(await run("document.querySelector('.member-history').textContent.includes('Continuous admission')"));
        await run('window.setConnected(true)');
        await until("!document.querySelector('.member-composer textarea')", 'Confirmed revocation after reconnect clears the offline view');
        assert.equal(await run("document.body.innerText.includes('Continuous admission')"), false);
        await run('window.setProtectedChatVisible(true)');
        await until("document.querySelector('.member-composer textarea')?.value === 'Local draft'", 'Re-admission restores the draft');
        assert.equal(await run('window.protectedSends.length'), 0);
        assert.equal(await run("!!document.querySelector('.protected-reply-draft')"), false);
        await until("!!document.querySelector('.member-message button[aria-label=Reply]')", 'Re-admission revalidates message actions');
        await run("document.querySelector('.member-message button[aria-label=Reply]').click()");
        await run("Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true }); void 0");
        await run("document.querySelector('.member-composer button[type=submit]').click()");
        await until('window.protectedSends.length === 1', 'Reply is sent after explicit submission');
        assert.equal(await run('window.protectedSends[0].replyTo'), 2);
        assert.equal(await run('window.protectedSends[0].text'), 'Local draft');
        await until("document.activeElement === document.querySelector('.member-composer textarea')", 'Sending restores focus to the composer');
        await run("delete document.hasFocus");
        assert.equal(await run("document.querySelector('.member-history').textContent.includes('Old history')"), false);
        await until("!!document.querySelector('.member-message-actions button[aria-label=\"Edit message\"]')", 'Own ordinary message can be edited');
        const originalTime = await run("document.querySelector('.member-message:has(button[aria-label=\"Edit message\"]) time').textContent");
        await run("document.querySelector('.member-message-actions button[aria-label=\"Edit message\"]').click()");
        const editHeight = await run("document.querySelector('.chat-inline-edit textarea').getBoundingClientRect().height");
        await enter('.chat-inline-edit textarea', 'Line\n'.repeat(120));
        const expanded = await run(`(() => {
          const field = document.querySelector('.chat-inline-edit textarea');
          return { height: field.getBoundingClientRect().height, content: field.scrollHeight,
            history: field.closest('.member-history').getBoundingClientRect().height };
        })()`);
        assert.ok(expanded.height > editHeight && expanded.height < expanded.content && expanded.height < expanded.history);
        await enter('.chat-inline-edit textarea', '  \nEdited in place\n  ');
        await click('save', '.chat-inline-edit button');
        await until("document.querySelector('.member-history').textContent.includes('Edited in place')", 'Edition updates the existing message');
        assert.equal(await run('window.protectedEdits[0].expectedRevision'), 1);
        assert.equal(await run('window.protectedEdits[0].text'), 'Edited in place');
        assert.equal(await run("document.querySelector('.member-message:has(button[aria-label=\"Edit message\"]) time').textContent"), originalTime);
        await until("document.querySelectorAll('.member-message-actions button[aria-label=\"Delete message\"]').length === 2", 'Reader can only remove their own ordinary messages');
        const otherMessageMenu = () => run(`[...document.querySelectorAll('.member-history article')].find(row =>
          row.textContent.includes('A moderator can remove this')).querySelector('.chat-message-row')
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true }))`);
        await otherMessageMenu();
        await until("!!document.querySelector('.member-context [role=menuitem]')", 'A foreign message has a context menu');
        assert.equal(await run("[...document.querySelectorAll('.member-context button')].some(button => button.textContent === 'Delete message')"), false);
        await run("document.querySelector('.member-context').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))");
        await run("document.querySelector('.member-message-actions button[aria-label=\"Delete message\"]').click()");
        await click('Delete', 'dialog .modal-actions button');
        await until("!document.querySelector('.member-history').textContent.includes('Edited in place')", 'Confirmed deletion removes the message');
        assert.deepEqual(await run('window.protectedRemoved'), [2]);
        await run('window.protectedCanDeleteOther = true');
        await until("document.querySelectorAll('.member-message-actions button[aria-label=\"Delete message\"]').length === 2", 'Moderator may remove another profile’s ordinary message', 200);
        await otherMessageMenu();
        await click('Delete message', '.member-context button');
        await click('Delete', 'dialog .modal-actions button');
        await until("!document.querySelector('.member-history').textContent.includes('A moderator can remove this')", 'Moderation from the context menu removes another profile’s message', 200);
        assert.deepEqual(await run('window.protectedRemoved'), [2, 3]);
        assert.ok(await run("document.querySelector('.member-history').textContent.includes('Closed poll')"));
        assert.equal(await run("!!document.querySelector('button[aria-label=\"Delete completed poll\"]')"), false);
        await run('window.protectedCanDeletePoll = true');
        await until("!!document.querySelector('button[aria-label=\"Delete completed poll\"]')", 'Separate poll grant exposes the action', 200);
        await run("document.querySelector('button[aria-label=\"Delete completed poll\"]').click()");
        assert.match(await run("document.querySelector('dialog').textContent"), /poll and its result/);
        await click('Delete', 'dialog .modal-actions button');
        await until("!document.querySelector('.member-history').textContent.includes('Poll result')", 'Poll deletion clears the result');
        assert.deepEqual(await run('window.protectedRemoved.slice(-2)'), [4, 5]);
        await run("document.querySelector('.member-history .chat-checklist').scrollIntoView()");
        await until("document.querySelector('.chat-checklist input')?.disabled === false", 'Imported checklist uses the scoped state');
        await run("document.querySelector('.chat-checklist input').click()");
        await until("document.querySelector('.chat-checklist input')?.checked === true", 'Checklist item reflects the committed action');
        await run("document.querySelector('.member-message:has(.chat-checklist) button[aria-label=\"Edit message\"]').click()");
        await enter('dialog .poll-option-field input', 'Task after edit');
        await click('Save', 'dialog .modal-actions button');
        await until("document.querySelector('.chat-checklist')?.textContent.includes('Task after edit')", 'Checklist editor updates the visible card');
        assert.equal(await run('window.protectedEdits.at(-1).expectedRevision'), 1);
        assert.equal(await run("document.querySelector('.chat-checklist input').checked"), true);
        await run("document.querySelector('.member-composer .chat-attach').click()");
        await click('Interactive checklist', '.chat-attachment-menu button');
        await enter('dialog .form-fields > label input', 'New checklist title');
        await enter('dialog .poll-option-field input', 'First task');
        await click('Send', 'dialog .modal-actions button');
        await until('window.protectedSends.length === 2', 'New checklist uses the protected send action');
        assert.deepEqual(await run('window.protectedSends[1].checklist.items.map(item => item.text)'), ['First task']);
        await run("document.querySelector('.member-composer .chat-attach').click()");
        await click('Create poll', '.chat-attachment-menu button');
        await enter('dialog .form-fields > label input', 'Which project?');
        await enter('dialog .poll-option-field:nth-child(1) input', 'Project A');
        await enter('dialog .poll-option-field:nth-child(2) input', 'Project B');
        await click('Publish', 'dialog .modal-actions button');
        await until('window.protectedSends.length === 3', 'New poll uses the protected send action');
        assert.deepEqual(await run('window.protectedSends[2].poll.options'), ['Project A', 'Project B']);
        await enter('.member-composer textarea', '@');
        await until("!!document.querySelector('.protected-mention-input [role=option]')", 'Mention options use the scoped roster');
        assert.deepEqual(await run("[...document.querySelectorAll('.protected-mention-input [role=option] > span')].map(item=>item.textContent)"), ['@Crew', '@Friend']);
        await run("document.querySelector('.member-composer textarea').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true, cancelable:true}))");
        await until("document.querySelector('.protected-mention-input [role=option][aria-selected=true] span')?.textContent === '@Friend'", 'Arrow Down changes the mention choice');
        await run("document.querySelector('.member-composer textarea').dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', bubbles:true, cancelable:true}))");
        await until("document.querySelector('.member-composer textarea')?.value === '@Friend '", 'Tab inserts the selected profile into the draft');
        await run("document.querySelector('.member-composer button[type=submit]').click()");
        await until('window.protectedSends.length === 4', 'Structured mention is sent');
        assert.deepEqual(await run('window.protectedSends[3].mentions'), [{ kind: 'profile', id: 'b'.repeat(64), start: 0, end: 7 }]);
        await run('window.protectedMentionMass = true');
        await enter('.member-composer textarea', '@everyone');
        await until("document.querySelector('.protected-mention-input [role=option] > span')?.textContent === '@everyone'", 'Mass option appears with its grant');
        await run("document.querySelector('.member-composer button[type=submit]').click()");
        await until('window.protectedSends.length === 5', 'Unconfirmed mention text can be sent');
        assert.equal(await run('window.protectedSends[4].mentions'), undefined);
        await until("[...document.querySelectorAll('.protected-channel-roster .member-roster-person')].some(button => button.textContent.includes('Friend'))",
          'Friend is available in the channel roster');
        await run(`(() => {
          const friend = [...document.querySelectorAll('.protected-channel-roster .member-roster-person')].find(button => button.textContent.includes('Friend'));
          const field = document.querySelector('.member-composer textarea');
          const transfer = new DataTransfer();
          friend.dispatchEvent(new DragEvent('dragstart', {bubbles:true, cancelable:true, dataTransfer:transfer}));
          field.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:transfer}));
        })()`);
        await until("document.querySelector('.member-composer textarea')?.value === '@Friend '", 'Dragging a roster participant inserts a mention');
        await run("document.querySelector('.member-composer button[type=submit]').click()");
        await until('window.protectedSends.length === 6', 'The dropped mention is sent');
        assert.deepEqual(await run('window.protectedSends[5].mentions'), [{ kind: 'profile', id: 'b'.repeat(64), start: 0, end: 7 }]);
        await run(`localStorage.setItem('pawtalk.v2.mute-channel.' + '1'.repeat(32) + '.' + '2'.repeat(32), String(Date.now() + 60000));
          localStorage.removeItem('pawtalk.v3.read.' + ['1'.repeat(32), 'a'.repeat(64), '2'.repeat(32)].join(':'));
          window.setWindowActive(false);`);
        const beforeSound = await run('window.notifications');
        const beforePoll = await run('window.protectedAlertPolls');
        await run("window.addProtectedAlert('group')");
        await until(`window.protectedAlertPolls > ${beforePoll}`, 'Protected inbox is polled');
        assert.equal(await run('window.desktopNotifications.length'), 0, 'Muted group produces no native alert');
        assert.equal(await run('window.notifications'), beforeSound, 'Muted group produces no sound');
        await run("window.addProtectedAlert('direct')");
        await until('window.desktopNotifications.length === 1 && window.desktopNotifications[0].position === 21', 'Direct mention reaches native delivery');
        await until(`window.notifications > ${beforeSound}`, 'Direct mention keeps its sound');
      }
      await load('poll-voting');
      await until("!!document.querySelector('.poll-answer:not(:disabled)')", 'Protected poll can be voted on in a read-only channel');
      assert.equal(await run("!!document.querySelector('.poll-count')"), false);
      await run("document.querySelectorAll('.poll-answer')[1].click()");
      await until("document.querySelectorAll('.poll-answer')[1]?.getAttribute('aria-pressed') === 'true'", 'Protected poll shows own selection');
      await click(english ? 'End poll' : 'Завершить опрос', '.poll-card button.poll-close');
      await until("document.querySelectorAll('.poll-count').length === 2 && !document.querySelector('.poll-answer:not(:disabled)')",
        'Protected close stops voting and reveals the tally');
      assert.equal(await run("!!document.querySelector('.poll-voters')"), false);
      await load('history');
      const attachSelector = `.member-composer button[aria-label="${english ? 'Attachments' : 'Вложения'}"]`;
      const voiceLabel = english ? 'Record voice message' : 'Записать голосовое';
      const fileLabel = english ? 'Send file' : 'Отправить файл';
      const attachmentMenuContains = label => `[...document.querySelectorAll('.chat-attachment-menu button')].some(button => button.textContent.trim() === ${JSON.stringify(label)})`;
      await run(`(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 24;
        canvas.getContext('2d').fillRect(0, 0, 32, 24);
        const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        window.photoDrop = new DataTransfer();
        window.photoDrop.items.add(new File([png], 'Photo.png', { type: 'image/png' }));
        window.dragPhoto = type => document.querySelector('.member-history').dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: window.photoDrop }));
        window.dragPhoto('dragenter');
        window.dragPhoto('drop');
      })()`);
      assert.equal(await run("!!document.querySelector('.chat-file-drop-overlay, .chat-attachment-draft')"), false,
        'Read-only attachment permission blocks the drop');
      await run('window.protectedCanAttach = true');
      await until("!!document.querySelector('.member-composer input[type=file]:enabled')", 'File permission enables the file picker', 200);
      await run("window.dragPhoto('dragenter')");
      await until("document.querySelector('.chat-file-drop-card')?.textContent.includes('General')", 'Dragging over history displays the upload target');
      await run("window.dragPhoto('dragleave')");
      await until("!document.querySelector('.chat-file-drop-overlay')", 'Leaving clears the upload target');
      await run("window.dragPhoto('dragenter'); window.dragPhoto('drop')");
      await until("document.querySelector('.attachment-thumbnail img')?.naturalWidth === 32 && !document.querySelector('.chat-file-drop-overlay')",
        'Dropping a photo shows a thumbnail in the composer');
      await run(`document.querySelector('.attachment-card-actions button[aria-label="${preview}"]').click()`);
      await until("document.querySelector('dialog .photo-viewer-image')?.naturalWidth === 32", 'Photo draft opens in the viewer');
      await run(`document.querySelector('dialog .video-viewer-actions button[aria-label="${english ? 'Close' : 'Закрыть'}"]').click()`);
      const editAttachment = english ? 'Edit' : 'Редактировать';
      await run(`document.querySelector('.attachment-card-actions button[aria-label="${editAttachment}"]').click()`);
      await enter('dialog input', 'Renamed.png');
      await run("document.querySelector('dialog form').requestSubmit()");
      await until("document.querySelector('.attachment-filename')?.textContent === 'Renamed.png'", 'Editing changes the draft name');
      await run("document.querySelector('.attachment-card-actions .danger-button').click()");
      await until("!document.querySelector('.attachment-thumbnail')", 'Removing the photo clears the draft');
      assert.equal(await run('window.protectedUploads.length'), 0, 'Draft actions keep files local');
      if (english) {
        const originalSize = await run(`(async () => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1400;
          const context = canvas.getContext('2d');
          const pixels = context.createImageData(canvas.width, canvas.height);
          const stride = canvas.width * 4;
          for (let row = 0; row < canvas.height; row++) {
            const colors = pixels.data.subarray(row * stride, (row + 1) * stride);
            crypto.getRandomValues(colors);
            for (let i = 3; i < colors.length; i += 4) colors[i] = 255;
          }
          context.putImageData(pixels, 0, 0);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
          const clipboardData = new DataTransfer();
          clipboardData.items.add(new File([blob], 'Clipboard.png', {type:'image/png'}));
          document.querySelector('.member-composer textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
          return blob.size;
        })()`);
        assert.ok(originalSize > 2 * 1024 * 1024);
        await until("document.querySelector('.attachment-filename')?.textContent === 'Clipboard.webp' && document.querySelector('.attachment-thumbnail img')?.naturalWidth > 0", 'Oversized pasted image is resized and attached');
        await run("document.querySelector('.attachment-thumbnail').click()");
        await until("document.querySelector('dialog .photo-viewer-image')?.naturalWidth > 0", 'Compressed attachment opens in the viewer');
        assert.ok(await run("fetch(document.querySelector('dialog .photo-viewer-image').src).then(response => response.blob()).then(blob => blob.type === 'image/webp' && blob.size <= 2 * 1024 * 1024)"));
        await run("document.querySelector('dialog .video-viewer-actions button[aria-label=\"Close\"]').click()");
        await run("document.querySelector('.attachment-card-actions .danger-button').click()");
      }
      await run(`document.querySelector(${JSON.stringify(attachSelector)}).click()`);
      assert.equal(await run(attachmentMenuContains(fileLabel)), true);
      assert.equal(await run(attachmentMenuContains(voiceLabel)), false);
      await run(`document.querySelector(${JSON.stringify(attachSelector)}).click()`);
      await run(`(() => {
        const picker = document.querySelector('.member-composer input[type=file]');
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array([3, 7])], 'fixture.bin'));
        picker.files = data.files;
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await until("document.querySelector('.protected-file-drafts')?.textContent.includes('fixture.bin')", 'Selection appears above the composer');
      await run("document.querySelector('.member-composer button[type=submit]').click()");
      await until('window.protectedSends.length === 1', 'The composer submits a file without a caption');
      assert.deepEqual(await run('Array.from(window.protectedUploads[0].file.bytes)'), [3, 7]);
      assert.equal(await run('window.protectedUploads[0].operationId === window.protectedSends[0].operationId'), true);
      assert.deepEqual(await run('window.protectedSends[0].fileIds'), ['a'.repeat(32)]);
      await until("!document.querySelector('.protected-file-drafts')", 'Successful send clears the selection');
      if (english) {
        await run(`(async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 80;
          canvas.height = 48;
          const context = canvas.getContext('2d');
          const paint = x => {
            context.fillStyle = '#2eab62';
            context.fillRect(0, 0, 80, 48);
            context.fillStyle = 'white';
            context.fillRect(x, 10, 20, 24);
          };
          paint(10);
          const stream = canvas.captureStream(15);
          const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
          const chunks = [];
          const done = new Promise(resolve => recorder.onstop = resolve);
          recorder.ondataavailable = event => chunks.push(event.data);
          recorder.start();
          const timer = setInterval(() => paint(Math.floor(performance.now() / 30) % 50), 60);
          await new Promise(resolve => setTimeout(resolve, 700));
          recorder.stop();
          await done;
          clearInterval(timer);
          stream.getTracks().forEach(track => track.stop());
          const transfer = new DataTransfer();
          transfer.items.add(new File(chunks, 'Clip.webm', { type: 'video/webm' }));
          const picker = document.querySelector('.member-composer input[type=file]');
          picker.files = transfer.files;
          picker.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await until("document.querySelector('.protected-file-drafts')?.textContent.includes('Clip.webm')", 'Video is selected');
        await until("document.querySelector('.attachment-thumbnail img')?.naturalWidth === 80", 'Video shows a frame before sending');
        await run("document.querySelector('.attachment-thumbnail').click()");
        await until("document.querySelector('dialog video')?.readyState >= HTMLMediaElement.HAVE_METADATA", 'Video draft opens in the player');
        await run(`document.querySelector('dialog .video-viewer-actions button[aria-label="${english ? 'Close' : 'Закрыть'}"]').click()`);
        await run("document.querySelector('.attachment-card-actions button:nth-child(2)').click()");
        await enter('dialog input', 'Renamed.webm');
        await run("document.querySelector('dialog form').requestSubmit()");
        await until("document.querySelector('.attachment-filename')?.textContent === 'Renamed.webm'", 'Video draft keeps its preview after renaming');
        await run("document.querySelector('.member-composer button[type=submit]').click()");
        await until('window.protectedSends.length === 2', 'The composer submits the video and its poster', 450);
        assert.equal(await run('window.protectedUploads[1].file.name'), 'Renamed.webm');
        assert.equal(await run('window.protectedUploads[1].file.poster.mime'), 'image/jpeg');
        assert.deepEqual(await run('Array.from(window.protectedUploads[1].file.poster.bytes.slice(0, 2))'), [255, 216]);
      }
      await run('window.protectedCanAttach = false; window.protectedCanSendVoice = true');
      await run(`document.querySelector(${JSON.stringify(attachSelector)}).click()`);
      await until(`!(${attachmentMenuContains(fileLabel)}) && ${attachmentMenuContains(voiceLabel)}`,
        'Voice permission alone exposes recording without file selection', 200);
      if (english) {
        await load('public-poll');
        await until("document.querySelector('.poll-voters [aria-label=\"Visible voter\"] img')?.naturalWidth > 0",
          'A public poll renders the visible voter’s channel profile avatar');
        const optionBefore = await run(`(async () => {
          const list = document.querySelector('.chat-stream');
          const content = list.querySelector('.protected-history-content');
          for (const edge of ['afterbegin', 'beforeend']) {
            const spacer = document.createElement('div');
            spacer.style.height = '700px';
            content.insertAdjacentElement(edge, spacer);
          }
          const option = document.querySelectorAll('.poll-answer')[1];
          option.scrollIntoView({block:'center'});
          list.dispatchEvent(new Event('scroll'));
          for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
          return option.getBoundingClientRect().top;
        })()`);
        await run('window.pollVoterVisible = false');
        await until("!document.querySelector('.poll-voters') && document.querySelector('.poll-count')?.textContent.includes('1')",
          'Revoking the voter removes the name and preserves the tally', 200);
        const optionAfter = await run(`(async () => {
          for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
          return document.querySelectorAll('.poll-answer')[1].getBoundingClientRect().top;
        })()`);
        assert.ok(Math.abs(optionAfter - optionBefore) < 2, 'A changed voter strip keeps the next poll option in place');
      }
      await load('attachment-grid&hold-photo-decode');
      await until("document.querySelectorAll('.chat-message-attachments .chat-media-card').length === 4", 'Mixed and single media render');
      assert.ok(await run('performance.now() - window.chatOpenStarted < 1000'), 'Mixed history renders in under a second');
      assert.ok(await run(`(() => {
        const [mixed, single] = document.querySelectorAll('.chat-message-attachments');
        const [first, second, third] = [...mixed.querySelectorAll('.chat-media-card')].map(card => card.getBoundingClientRect());
        return Math.abs(first.top - second.top) < 1 && second.left > first.left &&
          third.top >= first.bottom && Math.abs(first.left - third.left) < 1 &&
          getComputedStyle(single).gridTemplateColumns.split(' ').length === 1;
      })()`), 'Combined photos and videos fill two columns, while a single photo keeps its own layout');
      await until('window.photoDecodes > 0', 'A photo is waiting for its decoder');
      const heldPhoto = await run(`(async () => {
        const poster = document.querySelector('.chat-photo-card .video-poster');
        const height = poster.getBoundingClientRect().height;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return {height,stable:poster.getBoundingClientRect().height===height,hasImage:!!poster.querySelector('img')};
      })()`);
      assert.ok(heldPhoto.height > 0 && heldPhoto.stable && !heldPhoto.hasImage,
        `The photo placeholder keeps its height during decoding (${JSON.stringify(heldPhoto)})`);
      const sizedPhoto = `document.querySelectorAll('.chat-photo-card .video-poster')[1]`;
      assert.equal(await run(`${sizedPhoto}.getBoundingClientRect().height`), 1,
        'Encrypted preview metadata sets the initial height before decoding');
      assert.equal(await run(`!!${sizedPhoto}.querySelector('img')`), false);
      await run('window.releasePhotoDecode()');
      await until("document.querySelector('.chat-photo-card .video-poster img')?.naturalWidth > 0", 'The decoded photo replaces its placeholder');
      await until(`${sizedPhoto}.querySelector('img')?.naturalWidth === 1`, 'The sized preview loads');
      assert.equal(await run(`${sizedPhoto}.getBoundingClientRect().height`), 1, 'Decoding leaves the sized preview in place');
      const decodedPhoto = await run(`(() => {
        const poster = document.querySelector('.chat-photo-card .video-poster');
        const image = poster.querySelector('img');
        return {frameHeight:poster.getBoundingClientRect().height,imageHeight:image.getBoundingClientRect().height};
      })()`);
      assert.ok(decodedPhoto.imageHeight > 0 && Math.abs(decodedPhoto.frameHeight - decodedPhoto.imageHeight) < 1,
        `A decoded photo leaves no gap under the image (${JSON.stringify(decodedPhoto)})`);
      await run("document.querySelector('.chat-photo-card .chat-video-open').click()");
      await until("document.querySelector('.video-counter')?.textContent === '1 / 3'", 'Protected photo opens the entire message gallery');
      await run("document.querySelector('.video-viewer').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
      await until("document.querySelector('.video-counter')?.textContent === '2 / 3' && document.querySelector('.photo-viewer-image')?.alt === 'Second.png'", 'Keyboard arrows open the next protected photo');
      await run("document.querySelector('.video-previous').click()");
      await until("document.querySelector('.photo-viewer-image')?.alt === 'Photo.png'", 'Gallery button returns to the previous protected photo');
      await run("document.querySelector('.video-viewer-actions button:last-child').click()");
      await until("document.querySelector('.voice-wave use') && [...document.querySelectorAll('.voice-wave g rect')].some(bar => Number(bar.getAttribute('height')) > 2)",
        'Saved recordings render their waveforms immediately');
      await run(`(() => {
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          if (this.download === 'Video.webm') window.fullVideoSaved = true;
          else click.call(this);
        };
        document.querySelector('.chat-video-card .chat-video-save').click();
      })()`);
      await until("typeof window.releaseFullVideo === 'function'", 'Full video download is in progress');
      assert.ok(await run(`(async () => {
        const toggle = document.querySelector('.member-roster-toggle');
        const expanded = toggle.getAttribute('aria-expanded');
        const start = performance.now();
        toggle.click();
        await new Promise(resolve => requestAnimationFrame(resolve));
        const responsive = toggle.getAttribute('aria-expanded') !== expanded && performance.now() - start < 150;
        toggle.click();
        return responsive;
      })()`), 'Roster toggle responds while a full video is downloading');
      await run("document.querySelectorAll('.chat-photo-card')[2].scrollIntoView({block:'center'})");
      await until("window.photoRetried && document.querySelectorAll('.chat-photo-card')[2]?.querySelector('img')?.naturalWidth === 1",
        'The original photo is displayed after retrying a temporary failure');
      await run("document.querySelector('.chat-video-card').scrollIntoView({block:'center'})");
      await until("document.querySelector('.chat-video-card .video-poster img')?.naturalWidth === 1", 'The protected video poster is displayed');
      await until("window.clientPerformance.some(entry => entry.stage === 'media.preview.decoded')", 'The renderer logs the time to decode a thumbnail');
      await run('window.releaseFullVideo()');
      await until('window.fullVideoSaved === true', 'Full video finishes independently of previews');
      if (english) {
        await run("document.querySelector('.member-message-actions button[aria-label=\"Edit message\"]').click()");
        await click('Remove attachment', '.chat-inline-edit button');
        await click('save', '.chat-inline-edit button');
        await until("document.querySelector('dialog[open]')?.textContent.includes('will be deleted for everyone')", 'Removing the last attachment prompts for deletion');
        assert.deepEqual(await run('window.protectedRemoved'), []);
        await click('Cancel', 'dialog .modal-actions button');
        await until("!document.querySelector('dialog[open]') && !!document.querySelector('.chat-inline-edit')", 'Cancelling preserves the draft');
        await click('save', '.chat-inline-edit button');
        await click('Delete', 'dialog .modal-actions button');
        await until('window.protectedRemoved.includes(2) && !document.querySelector(".chat-inline-edit")', 'Confirming deletes the attachment-only message');
      }
      await load('poll-result-window');
      await until("document.querySelector('.chat-reply-quote')?.title.includes('Protected poll result')", 'Result and quote are initially visible');
      assert.match(await run("document.querySelector('.poll-result').textContent"), /Winning option/);
      assert.equal(await run("!!document.querySelector('.server-app > .member-main :is(.member-toolbar,.member-e2ee,.protected-history-search)')"), false);
      await run("document.querySelector('.chat-file button').click()");
      await until("!!document.querySelector('.chat-file a[download=\"archive.bin\"]')", 'Protected history opens the attachment');
      await run('window.historyFirst = 2');
      await until("document.querySelector('.member-history')?.textContent.includes('Reply to poll result') && !document.querySelector('.member-history').textContent.includes('Protected poll result')",
        'A narrowed history window clears the poll result and its quote', 200);
      assert.equal(await run("!!document.querySelector('.chat-file')"), false);
      assert.equal(await run("!!document.querySelector('dialog a[download=\"archive.bin\"]')"), false);
      await load('pins');
      const pinLabel = english ? 'Pin message' : 'Закрепить сообщение';
      const pinSelector = `.member-message:nth-child(2) button[aria-label="${pinLabel}"]`;
      await until(`!!document.querySelector(${JSON.stringify(pinSelector)})`, 'Pin right appears in the message actions');
      const pinIcon = await run(`document.querySelector(${JSON.stringify(pinSelector)}).querySelector('path').getAttribute('d')`);
      const pinMenu = () => run("document.querySelector('.member-message:nth-child(2) .chat-message-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))");
      await pinMenu();
      await click(pinLabel, '.member-context button');
      await until("!!document.querySelector('.protected-pin-banner')", 'Pin appears in the channel');
      await until("document.querySelector('.protected-pin-banner')?.textContent.includes('Continuous admission')", 'The pinned text stays above the message list');
      assert.equal(await run("document.querySelector('.protected-pin-banner').textContent"), 'Continuous admission');
      const badge = '.member-message:nth-child(2) .chat-message-pin path';
      assert.equal(await run(`document.querySelector('${badge}').getAttribute('d')`), pinIcon);
      const unpinLabel = english ? 'Unpin message' : 'Открепить сообщение';
      const unpinIcon = await run(`document.querySelector('.member-message:nth-child(2) button[aria-label="${unpinLabel}"] path').getAttribute('d')`);
      assert.notEqual(unpinIcon, pinIcon);
      await pinMenu();
      await click(unpinLabel, '.member-context button');
      await until("!document.querySelector('.protected-pin-banner')", 'Unpin from the context menu clears the banner');
      await run("window.protectedCanPin = false; window.invalidateGeneralChat()");
      await until(`!document.querySelector(${JSON.stringify(pinSelector)})`, 'Revoking pin permission removes the toolbar action', 200);
      await pinMenu();
      await until("!!document.querySelector('.member-context [role=menuitem]')", 'Message menu stays available without pin rights');
      assert.equal(await run(`[...document.querySelectorAll('.member-context button')].some(button => button.textContent === ${JSON.stringify(pinLabel)})`), false);
      await run("document.querySelector('.member-context').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await run("window.protectedCanPin = true; window.invalidateGeneralChat()");
      await until(`!!document.querySelector(${JSON.stringify(pinSelector)})`, 'Pin permission is restored', 200);
      await run(`document.querySelector(${JSON.stringify(pinSelector)}).click()`);
      await until("!!document.querySelector('.protected-pin-banner')", 'The toolbar uses the same pin operation');
      const pinDoesNotOverlapRoster = `(() => {
        const pin = document.querySelector('.protected-pin-banner').getBoundingClientRect();
        const roster = document.querySelector('.member-roster-toggle').getBoundingClientRect();
        return pin.right < roster.left && Math.abs(pin.top - roster.top) < 1 && Math.abs(pin.height - roster.height) < 1;
      })()`;
      assert.equal(await run(pinDoesNotOverlapRoster), true);
      await run("document.querySelector('.member-roster-toggle').click()");
      await until(pinDoesNotOverlapRoster, 'Pin and member toggle stay aligned with the drawer closed');
      await run("document.querySelector('.protected-pin-banner').click()");
      await until("document.querySelector('.chat-message-target')?.textContent.includes('Continuous admission') && !document.querySelector('dialog[open]')", 'Pin highlights its message in the chat');
      await run('window.revisePinnedFixture()');
      await until("document.querySelector('.protected-pin-banner')?.textContent.includes('Updated pinned text')", 'Pin follows an edit', 200);
      await run('window.historyFirst = 3');
      await until("!document.querySelector('dialog') && !document.querySelector('.protected-pin-banner') && !document.body.textContent.includes('Updated pinned text')", 'History narrowing closes and clears the pin', 200);

      await load('pins&old-pin');
      await until("!!document.querySelector('.chat-reply-quote') && document.querySelector('.protected-pin-banner')?.textContent === 'Earlier pinned message'", 'The newest page shows a preview of the older message');
      assert.equal(await run("document.querySelector('.member-history').textContent.includes('Earlier pinned message')"), false);
      await run("document.querySelector('.protected-pin-banner').click()");
      await until("document.querySelector('.chat-message-target')?.textContent.includes('Earlier pinned message') && !document.querySelector('dialog[open]')", 'An unloaded pin opens its history window in the same chat');
      assert.equal(await run('window.protectedHistoryReads.some(read => read.after === 1)'), true);
      await run("document.querySelector('.chat-message-target').classList.remove('chat-message-target'); document.querySelector('.chat-reply-quote').click()");
      assert.equal(await run("document.querySelector('.chat-message-target')?.textContent.includes('Earlier pinned message')"), true);
      await run(`document.querySelector('.chat-message-target .member-message-actions button[aria-label="${unpinLabel}"]').click()`);
      await until("!document.querySelector('.protected-pin-banner, .chat-message-pin')", 'Unpinning clears the banner and the marker');

      for (const [mime, label] of [
        ['image/png', english ? 'Photo' : 'Фото'],
        ['video/webm', english ? 'Video' : 'Видео'],
        ['audio/webm', english ? 'Voice message' : 'Голосовое сообщение'],
      ]) {
        await load(`pins&old-pin=${encodeURIComponent(mime)}`);
        await until(`document.querySelector('.protected-pin-banner')?.textContent === ${JSON.stringify(label)}`, 'An older media pin shows its type');
      }

      await load('hidden-original');
      await run('window.openOriginalFixture()');
      await until("document.querySelector('#server-channels .member-channel[aria-current=true], #server-channels .member-channel.selected')?.textContent === 'Private original room' && " +
        "document.querySelector('.chat-reply-quote')?.title.includes('Private original caption') && " +
        "document.querySelector('.video-poster img')?.naturalWidth === 1 && !!document.querySelector('.protected-pin-banner')",
      'The authorized original has a quote, thumbnail and pin');
      await run('window.historyFirst = 2');
      await until("document.querySelector('.member-history')?.textContent.includes('Retained reply') && " +
        "!document.querySelector('.chat-reply-quote, .video-poster, .protected-pin-banner') && " +
        "!document.querySelector('.member-history').textContent.includes('Private original caption')",
      'The later reply survives while the quote, thumbnail and pin disappear', 200);
      await run('window.revokeOriginalFixture()');
      await until("document.querySelector('#server-channels .member-channel[aria-current=true], #server-channels .member-channel.selected')?.textContent === 'General' && " +
        "!document.body.textContent.includes('Private original room')", 'Revocation removes the private channel name');
      await run('window.deniedOriginalReads = 0; window.openOriginalFixture(); window.refresh()');
      await until("document.querySelector('.member-history')?.textContent.includes('Visible room')", 'The hidden-channel deep link leaves the visible room open');
      assert.equal(await run("document.body.textContent.includes('Private original room') || !!document.querySelector('.video-poster')"), false);
      assert.equal(await run('window.deniedOriginalReads'), 0);

      await load('reader');
      assert.equal(await run(`[...document.querySelectorAll('button')].some(button => button.textContent.trim() === ${JSON.stringify(settings)})`), false);
      assert.equal(await run(`[...document.querySelectorAll('button')].some(button => button.textContent.trim() === ${JSON.stringify(reorder)})`), false);
      const globalRoster = `.member-server-title button[aria-label="${english ? 'Server members' : 'Список участников сервера'}"]`;
      assert.equal(await run(`!!document.querySelector(${JSON.stringify(globalRoster)})`), false);
      const auditText = english ? 'Audit log' : 'Журнал аудита';
      const openServerMenu = () => run("document.querySelector('.protected-server-title').click()");
      const serverSettingsLabel = english ? 'Server settings' : 'Настройки сервера';
      const openServerSettings = async tab => {
        await openServerMenu();
        await click(serverSettingsLabel, '.member-context button');
        await click(tab, '.protected-server-settings .settings-nav button');
        assert.equal(await run(`[...document.querySelectorAll('.protected-server-settings .settings-nav button')].every(button => {
          const icon = button.firstElementChild;
          const label = button.lastElementChild;
          return icon.tagName === 'svg' && icon.getAttribute('aria-hidden') === 'true' &&
            icon.getBoundingClientRect().right < label.getBoundingClientRect().left;
        })`), true, 'Server settings tabs have a leading icon');
      };
      const deleteTab = english ? 'Delete channel' : 'Удалить канал';
      const selectPermissions = async () => run("document.querySelector('.protected-channel-settings-dialog .settings-nav button:nth-of-type(2)').click()");
      const openChannelSettings = async () => {
        await until("!!document.querySelector('.protected-channel-row[data-selected=true] .protected-channel-settings')", 'Channel settings gear is available');
        await run("document.querySelector('.protected-channel-row[data-selected=true] .protected-channel-settings').click()");
      };
      const openChannelContext = () => run("document.querySelector('.protected-channel-row[data-selected=true]').dispatchEvent(new MouseEvent('contextmenu', { bubbles:true }))");
      const openOrder = async () => { await openChannelContext(); await click(reorder, '.member-context button'); };
      const resizeRoleWindow = async (size, viewportReady) => {
        const [width, height] = win.getSize();
        if (width === size[0] && height === size[1]) return;
        // An updated innerWidth can be visible before Chromium dispatches resize.
        // Wait for the event before opening a menu that closes on resize.
        await run(`(() => {
          window.roleResizeSettled = false;
          const onResize = () => {
            if (!(${viewportReady})) return;
            window.removeEventListener('resize', onResize);
            requestAnimationFrame(() => requestAnimationFrame(() => { window.roleResizeSettled = true; }));
          };
          window.addEventListener('resize', onResize);
        })()`);
        win.setSize(...size);
        await until('window.roleResizeSettled', 'The role settings viewport settles after resizing');
      };
      const openRoleEditor = async (label, scoped = false) => {
        await openServerSettings(label);
        if (scoped) await click(english ? 'Server roles' : 'Роли сервера', '.protected-server-settings .settings-panel button');
        else {
          const size = win.getSize();
          const originalWidth = await run('innerWidth');
          await resizeRoleWindow([660, size[1]], 'innerWidth <= 660');
          assert.equal(await run("document.querySelector('.server-settings-roles li').dataset.reorderId"), 'administrator');
          assert.equal(await run(`(() => {
            const label = document.querySelector('.role-list-name span:last-child');
            const original = label.textContent;
            label.textContent = 'W'.repeat(64);
            const fits = ['.settings-panel', '.settings-content', '.server-settings-roles'].every(selector => {
              const element = document.querySelector('.protected-server-settings ' + selector);
              return element.scrollWidth <= element.clientWidth;
            });
            label.textContent = original;
            return fits;
          })()`), true, 'The role list wraps long names without horizontal scrolling');
          assert.equal(await run("document.querySelector('.role-default-card').textContent.includes('@everyone')"), true);
          const roleRow = "document.querySelector('.server-settings-roles [data-reorder-id=member]')";
          assert.equal(await run(`${roleRow}.querySelector('.role-list-count').textContent`), '2');
          await run(`${roleRow}.querySelector('[aria-haspopup=menu]').click()`);
          await until("document.querySelectorAll('.member-context [role=menuitem]').length === 3", 'The role menu contains its three actions');
          assert.equal(await run("document.querySelector('.member-context [role=menuitem]:last-child').hasAttribute('data-separator-before')"), true);
          await run("document.querySelector('.member-context [role=menuitem]:first-child').click()");
          await until("document.querySelector('.protected-role-editor-content input:not([type])')?.value.includes('Legacy name')", 'Duplicating opens a populated new role draft');
          await click(english ? 'Back' : 'Назад', '.protected-role-editor-nav button');
          await click(english ? 'Discard changes' : 'Отбросить изменения', '.protected-role-editor-content button');
          await until(`!!${roleRow}`, 'Discarding the duplicate returns to the role list');
          await run("document.querySelector('.server-settings-roles [data-reorder-id=member] button').click()");
          await until("!!document.querySelector('.protected-role-editor-content')", 'Role editor opens at the narrow width');
          assert.equal(await run(`['.settings-panel', '.settings-content', '.protected-role-editor-content'].every(selector => {
            const element = document.querySelector('.protected-server-settings ' + selector);
            return element.scrollWidth <= element.clientWidth;
          })`), true, 'The role editor does not scroll horizontally');
          await resizeRoleWindow(size, `innerWidth === ${originalWidth}`);
        }
        await until("!!document.querySelector('.protected-server-settings .protected-role-editor')", 'Role editor is embedded in settings');
      };
      const membersTab = english ? 'Participants' : 'Участники';
      const openCategories = async () => {
        await openServerMenu();
        await click(english ? 'Create category' : 'Создать категорию', '.member-context button');
      };
      await openServerMenu();
      await until("!!document.querySelector('.member-context')", 'Server menu opens');
      assert.equal(await run("[...document.querySelectorAll('.member-context [role=menuitem]')].every(item => item.firstElementChild?.tagName === 'svg')"), true);
      await openServerMenu();
      await until("!document.querySelector('.member-context')", 'Clicking the server title again closes the menu');
      await openServerMenu();
      assert.equal(await run(`document.querySelector('.member-context').textContent.includes(${JSON.stringify(auditText)})`), false);
      const muteLabel = english ? 'Mute notifications' : 'Заглушить уведомления';
      const unmuteLabel = english ? 'Unmute notifications' : 'Включить уведомления';
      const muteDurations = english ? ['For 15 minutes', 'For 1 hour', 'For 3 hours', 'For 8 hours', 'For 24 hours', 'Until I turn it back on'] :
        ['На 15 минут', 'На 1 час', 'На 3 часа', 'На 8 часов', 'На 24 часа', 'До тех пор, пока не включу'];
      const serverMuteKey = 'pawtalk.v2.mute.' + '1'.repeat(32);
      const channelMuteKey = 'pawtalk.v2.mute-channel.' + '1'.repeat(32) + '.' + '2'.repeat(32);
      await click(muteLabel, '.member-context button');
      await until("document.querySelectorAll('dialog .member-mute-options button').length === 6", 'Mute duration choices appear');
      assert.deepEqual(await run("[...document.querySelectorAll('dialog .member-mute-options button')].map(button => button.textContent)"), muteDurations);
      await click(muteDurations[0], 'dialog .member-mute-options button');
      const remaining = await run(`Number(localStorage.getItem(${JSON.stringify(serverMuteKey)})) - Date.now()`);
      assert.ok(remaining > 14 * 60_000 && remaining <= 15 * 60_000);
      await openServerMenu();
      await click(unmuteLabel, '.member-context button');
      assert.equal(await run(`localStorage.getItem(${JSON.stringify(serverMuteKey)})`), null);
      assert.equal(await run("!!document.querySelector('dialog[open]')"), false, 'Unmuting never opens a dialog');
      await run(`localStorage.removeItem(${JSON.stringify(channelMuteKey)}); window.refresh()`);
      const openChannelMenu = () => run("[...document.querySelectorAll('.member-channel')].find(item => item.textContent === 'General')" +
        ".dispatchEvent(new MouseEvent('contextmenu', { bubbles:true }))");
      await openChannelMenu();
      await click(english ? 'Mute channel' : 'Заглушить канал', '.member-context button');
      await click(muteDurations[5], 'dialog .member-mute-options button');
      assert.equal(await run(`Number(localStorage.getItem(${JSON.stringify(channelMuteKey)}))`), Number.MAX_SAFE_INTEGER);
      await openChannelMenu();
      await click(unmuteLabel, '.member-context button');
      assert.equal(await run(`localStorage.getItem(${JSON.stringify(channelMuteKey)})`), null);
      await until("document.querySelectorAll('.protected-channel-roster .member-roster-person').length === 2", 'Scoped roster appears');
      assert.deepEqual(await run("[...document.querySelectorAll('.protected-channel-roster .member-roster-nickname')].map(name => name.textContent)"), ['Friend', 'Me']);
      assert.equal(await run("document.querySelector('.protected-channel-roster h2').textContent"), 'Featured');
      assert.equal(await run("getComputedStyle(document.querySelector('.protected-channel-roster .member-roster-nickname')).color"), 'rgb(90, 137, 188)');
      await run("document.querySelector('.protected-channel-roster .member-roster-person').click()");
      await until("document.querySelector('.protected-roster-roles')?.textContent.includes('Community')", 'All assigned roles appear in the card');
      await click(english ? 'Back' : 'Назад', '.protected-channel-roster button');
      if (english) {
        await load('auditor');
        await openServerSettings(auditText);
        await until("document.querySelectorAll('.protected-audit-entries li').length === 2", 'Delegated auditor sees the log');
        assert.equal(await run("!!document.querySelector('.protected-audit input[type=number]')"), false);
      }
      await load('audit-proof');
      await openServerSettings(auditText);
      const verifyLabel = english ? 'Verify signature' : 'Проверить подпись';
      const verifiedLabel = english ? 'Signature verified' : 'Подпись подтверждена';
      await until(`document.querySelector('.protected-audit-entries')?.textContent.includes(${JSON.stringify(verifyLabel)})`, 'Order evidence can be checked');
      await click(verifyLabel, '.protected-audit-entries button');
      await until(`document.querySelector('.protected-audit-entries [role=status]')?.textContent === ${JSON.stringify(verifiedLabel)}`, 'Audit displays the verified signature');
      assert.equal((await run('window.checkedOrder')).digest, 'b'.repeat(64));
      await load('editor');
      assert.ok(!await run(`[...document.querySelectorAll('.member-toolbar button')].some(button => button.textContent.trim() === ${JSON.stringify(settings)})`));
      await openOrder();
      await until("document.querySelectorAll('dialog select').length === 2 && !document.querySelector('dialog select').disabled", 'Delegated order dialog opens');
      assert.deepEqual(await run("[...document.querySelector('dialog select').options].slice(1).map(option => option.textContent)"), ['Meetings']);
      const gap = await run(`(() => {
        const [first, second] = document.querySelectorAll('dialog .form-fields > label');
        return second.getBoundingClientRect().top - first.getBoundingClientRect().bottom;
      })()`);
      assert.ok(Math.abs(gap - 20) <= 1, `Delegated order field gap is ${gap}`);
      await choose('dialog select', '3'.repeat(32));
      await choose('dialog .form-fields > label:nth-child(2) select', 'after');
      await click(preview, 'dialog button');
      await until(`document.querySelector('dialog .modal-actions')?.textContent.includes(${JSON.stringify(apply)}) &&
        document.querySelector('dialog .form-fields')?.textContent.includes('Meetings')`, 'Delegated confirmation shows the anchor');
      await click(apply, 'dialog button');
      await until("!document.querySelector('dialog') && document.querySelector('.member-channel-scroll .member-channel')?.textContent.includes('Meetings')", 'Delegated reorder refreshes the sidebar');
      const [change] = await run('window.protectedChanges');
      assert.equal(change.draft.action, 'channel.order');
      assert.equal(change.draft.after, true);
      assert.deepEqual(Object.keys(change.confirmation).sort(), ['previewId', 'serverId']);
      await openOrder();
      await until("!!document.querySelector('dialog[open]')", 'Order dialog can reopen');
      await run('window.revokeProtectedOrder()');
      await until(`!document.querySelector('dialog[open]') &&
        ![...document.querySelectorAll('.member-toolbar button')].some(button => button.textContent.trim() === ${JSON.stringify(reorder)})`,
      'Revoking the order grant closes the dialog and hides the action');
      assert.equal((await run('window.protectedChanges')).length, 1);
      const roleButton = english ? 'Roles' : 'Роли';
      const assignmentButton = english ? 'Role assignments' : 'Назначения ролей';
      await load('role-editor');
      await openRoleEditor(roleButton, true);
      const editor = '.protected-role-editor-content';
      const nameField = editor + ' input:not([type])';
      const tabs = '.protected-role-tabs button';
      const nav = '.protected-role-editor-nav button';
      const permissions = english ? 'Permissions' : 'Права доступа';
      const appearance = english ? 'Role appearance' : 'Оформление роли';
      const saveRole = english ? 'Save changes' : 'Сохранить изменения';
      const closeSettings = () => run("document.querySelector('.protected-server-settings > .modal-heading button').click()");
      assert.equal(await run(`document.querySelector('dialog').textContent.includes(${JSON.stringify(assignmentButton)})`), false);
      const advancedPermissions = english ? 'Advanced permissions' : 'Расширенные права';
      assert.equal(await run(`[...document.querySelectorAll('dialog summary')].some(summary => summary.textContent === ${JSON.stringify(advancedPermissions)})`), false);
      await click('Community', nav);
      await enter(nameField, 'Readers');
      await click(english ? 'Back' : 'Назад', nav);
      await click(english ? 'Keep editing' : 'Продолжить редактирование', 'dialog .modal-actions button');
      assert.equal(await run("document.querySelector('.protected-role-editor-content input:not([type])').value"), 'Readers');
      const saveBar = '.protected-role-save button';
      const roleSaveButtonsAligned = `(() => {
        const buttons = [...document.querySelectorAll('.protected-role-save-actions button')].map(button => button.getBoundingClientRect());
        return buttons.length === 2 && buttons[0].top === buttons[1].top && buttons[0].height === buttons[1].height;
      })()`;
      assert.equal(await run(roleSaveButtonsAligned), true, 'Role save buttons share a row and height');
      await run('window.changeScopedRoleOnCommit = true');
      await click(saveRole, saveBar);
      await until("!!document.querySelector('dialog input') && !!document.querySelector('dialog [role=alert]')", 'A stale save retains the draft');
      assert.equal(await run("document.querySelector('.protected-role-save-actions button:last-child').disabled"), true);
      assert.equal(await run('window.protectedChanges.length'), 0);
      await click(english ? 'Refresh role data' : 'Обновить данные роли', 'dialog button');
      await until("document.querySelector('dialog input[type=color]')?.value === '#305080'", 'Refresh keeps the concurrent color change');
      assert.equal(await run("document.querySelector('.protected-role-editor-content input:not([type])').value"), 'Readers');
      const clash = english ? 'The same fields changed on the server.' : 'На сервере изменились те же поля.';
      assert.equal(await run(`[...document.querySelectorAll('dialog [role=status]')].some(status => status.textContent.startsWith(${JSON.stringify(clash)}))`), true);
      await run('window.loseScopedRoleReply = true');
      await click(saveRole, saveBar);
      await until("!!document.querySelector('.protected-role-editor input') && !!document.querySelector('dialog [role=alert]')", 'Lost reply keeps the draft visible');
      await click(saveRole, saveBar);
      await until("window.protectedChanges.length === 1 && !document.querySelector('.protected-role-editor')", 'Retry applies the same signed change');
      assert.equal(await run('window.scopedRolePreviews'), 2, 'The retry reuses the prepared change');
      const edited = await run('window.protectedChanges[0].draft');
      assert.deepEqual([edited.name, edited.color, edited.revision, edited.policyHead], ['Readers', '#305080', 2, '8'.repeat(64)]);
      await closeSettings();
      const rosterToggle = english ? 'Show member list' : 'Показать список участников';
      for (const profile of ['role-assigner', 'directory-assigner']) {
        await load(profile);
        assert.equal(await run(`[...document.querySelectorAll('.member-toolbar button')].some(button => button.textContent.trim() === ${JSON.stringify(roleButton)})`), false);
        if (profile === 'directory-assigner') await openServerSettings(membersTab);
        else await run(`if (!document.querySelector('.member-roster-drawer[data-open=true] .protected-channel-roster'))
          document.querySelector(${JSON.stringify(`.member-roster-toggle[aria-label="${rosterToggle}"]`)}).click()`);
        const roster = profile === 'directory-assigner' ? '.protected-server-roster' : '.protected-channel-roster';
        await until(`!![...document.querySelectorAll('${roster} .member-roster-person')].find(button => button.textContent.includes('Friend'))`, 'Assignable roster target appears');
        await run(`[...document.querySelectorAll('${roster} .member-roster-person')].find(button =>
          button.querySelector('.member-roster-nickname')?.textContent === 'Friend').dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
        await click(assignmentButton, '.member-context button');
        const reader = "[...document.querySelectorAll('dialog [role=switch]')].find(toggle => toggle.closest('label')?.textContent === 'Reader')";
        await until(`!!${reader}`, 'Assignable roles appear');
        await run(`${reader}.click()`);
        const save = english ? 'Save' : 'Сохранить';
        const assignmentActions = 'dialog .modal-actions button';
        if (profile === 'role-assigner') {
          await run('window.loseScopedRoleReply = true');
          await click(save, assignmentActions);
          await until(`!!document.querySelector('dialog [role=alert]') && ${reader}?.checked === true`,
            'Failed assignment keeps the selected roles available for retry');
          assert.equal(await run('window.protectedChanges.length'), 0);
        }
        await click(save, assignmentActions);
        await until("window.protectedChanges.length === 1 && !document.querySelector('dialog[open]:not(.protected-server-settings)')", 'Delegated assignment applied');
        assert.equal(await run('window.scopedRolePreviews'), 1);
        assert.deepEqual(await run('window.protectedChanges[0].draft.roles'), ['member', 'reader']);
        assert.equal(await run('window.protectedChanges[0].draft.channelId'), profile === 'role-assigner' ? '2'.repeat(32) : undefined);
      }
      await load('owner');
      await openServerSettings(membersTab);
      await until("document.querySelector('.protected-server-roster')?.textContent.includes('Other channel')", 'Global roster includes other channels');
      await run("document.querySelector('.protected-server-settings .modal-heading button').click()");
      await until("!document.querySelector('dialog[open]')", 'Global roster closes');
      await openServerSettings(auditText);
      await until("document.querySelectorAll('.protected-audit-entries li').length === 2", 'Audit entries load');
      assert.equal(await run(`(() => {
        const list = document.querySelector('.protected-audit-entries');
        return list.textContent.includes('Friend') && list.textContent.includes('General') &&
          !/[a-f0-9]{8,}/i.test(list.innerText) && !list.querySelector('[title]');
      })()`), true, 'Audit shows names without raw identifiers or identifier tooltips');
      assert.equal(await run("document.querySelector('.protected-audit input[type=number]').value"), '365');
      await enter('.protected-audit input[type=number]', '7');
      await until("!!document.querySelector('.protected-audit [role=switch]')", 'Shortening requires confirmation');
      assert.equal(await run("document.querySelector('.protected-audit button[type=submit]').disabled"), true);
      await run("document.querySelector('.protected-audit [role=switch]').click()");
      await click(english ? 'Save' : 'Сохранить', '.protected-audit button');
      await until("document.querySelectorAll('.protected-audit-entries li').length === 1", 'Expired entry is removed from the log');
      const retention = await run('window.auditChanges[0]');
      assert.deepEqual([retention.days, retention.expected, retention.confirmShorter], [7, 365, true]);
      await run("document.querySelector('.protected-server-settings .modal-heading button').click()");
      await until("!document.querySelector('dialog[open]')", 'Audit closes');
      const timeout = english ? 'Member timeout' : 'Тайм-аут участника';
      const setTimeoutText = english ? 'Set timeout' : 'Назначить тайм-аут';
      await run("document.querySelector('.protected-channel-roster .member-roster-person').click()");
      await click(timeout, '.protected-channel-roster button');
      await until("!!document.querySelector('dialog input[type=number]')", 'Timeout controls load');
      assert.equal(await run("document.querySelector('dialog .danger-button').disabled"), true);
      assert.deepEqual(await run("[...document.querySelectorAll('dialog select option')].map(option => option.textContent)"),
        [english ? 'Custom duration' : 'Ручной ввод', ...[1, 5, 60, 1440, 10080, 40320].map(minutes => `${minutes} ${english ? 'min' : 'мин'}`)]);
      assert.deepEqual(await run("[...document.querySelectorAll('dialog datalist option')].map(option => option.value)"),
        english ? ['Server rules violation', 'Spam'] : ['Нарушение правил сервера', 'Спам']);
      await enter('dialog input:not([type=number])', 'Review needed');
      await enter('dialog input[type=number]', '40321');
      assert.equal(await run("document.querySelector('dialog .danger-button').disabled"), true);
      assert.equal(await run("document.querySelector('dialog input:not([type=number])').value"), 'Review needed');
      await choose('dialog select', '40320');
      await click(setTimeoutText, 'dialog button');
      await until("window.protectedTimeoutChanges.length === 1 && !document.querySelector('dialog[open]')", 'Timeout is confirmed');
      const imposed = await run('window.protectedTimeoutChanges[0]');
      assert.deepEqual([imposed.profileId, imposed.durationSeconds, imposed.reason], ['b'.repeat(64), 2419200, 'Review needed']);
      await click(timeout, '.protected-channel-roster button');
      await until("document.querySelector('dialog [role=status]')?.textContent.includes('Review needed')", 'Timeout deadline and reason appear');
      await enter('dialog input:not([type=number])', 'Review completed');
      await click(english ? 'Lift timeout' : 'Снять тайм-аут', 'dialog button');
      await until("window.protectedTimeoutChanges.length === 2 && !document.querySelector('dialog[open]')", 'Timeout lift is confirmed');
      assert.equal(await run('window.protectedTimeoutChanges[1].durationSeconds'), 0);
      await openChannelSettings();
      await until("!!document.querySelector('dialog[open] .form-fields input:not(:disabled)')", 'Verified channel settings load');
      assert.equal(await run("getComputedStyle(document.querySelector('dialog .form-fields')).gap"), '20px');
      const settingsBar = 'dialog .settings-save-bar';
      const saveSettings = saveRole;
      const resetSettings = english ? 'Reset' : 'Сбросить';
      const overviewInput = 'dialog .form-fields input:not([type=number])';
      assert.equal(await run(`!!document.querySelector('${settingsBar}')`), false);
      await enter(overviewInput, 'Unsaved channel name');
      assert.ok(await run(`(() => {
        const buttons = [...document.querySelectorAll('${settingsBar} button')].map(button => button.getBoundingClientRect());
        return buttons.length === 2 && Math.abs(buttons[0].height - buttons[1].height) < 1 &&
          Math.abs(buttons[0].top + buttons[0].height / 2 - buttons[1].top - buttons[1].height / 2) < 1;
      })()`));
      await click(resetSettings, settingsBar + ' button');
      assert.equal(await run(`!!document.querySelector('${settingsBar}')`), false);
      assert.equal(await run(`document.querySelector('${overviewInput}').value`), 'General');
      assert.equal(await run("document.querySelector('dialog').getBoundingClientRect().width === innerWidth"), true);
      assert.equal(await run("!!document.querySelector('dialog .settings-nav + .settings-panel-layout .settings-panel')"), true);
      await selectPermissions();
      await run("document.querySelector('dialog [data-permission=\"channel.view\"] [data-rule=deny]').click()");
      await run("document.querySelector('dialog .modal-heading button').click()");
      await openChannelSettings();
      await selectPermissions();
      await until("document.querySelector('dialog [data-permission=\"channel.view\"] [data-rule=inherit]')?.getAttribute('aria-pressed') === 'true'", 'Closing discards the draft');
      await run("document.querySelector('dialog [data-permission=\"channel.view\"] [data-rule=deny]').click()");
      await run("document.querySelector('dialog [data-permission=\"message.send\"] [data-rule=allow]').click()");
      assert.ok(await run(`(() => {
        const panel = document.querySelector('dialog .settings-panel');
        const bar = document.querySelector('${settingsBar}');
        const top = bar.getBoundingClientRect().top;
        panel.scrollTo({top: panel.scrollHeight, behavior: 'instant'});
        return panel.scrollTop > 0 && bar.getBoundingClientRect().top === top &&
          panel.getBoundingClientRect().bottom <= top && bar.getBoundingClientRect().bottom <= innerHeight;
      })()`), 'The save bar stays visible without covering the scrollable form');
      assert.equal(await run('window.protectedChanges.length'), 0);
      await click(saveSettings, settingsBar + ' button');
      await until("window.protectedChanges.length === 1 && !document.querySelector('dialog[open]')", 'One save commits and closes the dialog');
      const result = await run('window.protectedChanges[0]');
      assert.deepEqual(result.draft.changes, [
        { role: '@everyone', permission: 'channel.view', rule: 'deny' },
        { role: '@everyone', permission: 'message.send', rule: 'allow' },
      ]);
      assert.deepEqual(Object.keys(result.confirmation).sort(), ['previewId', 'serverId']);
      await motion('reduce');
      await openServerMenu();
      await click(createChannel, '.member-context button');
      await until("!!document.querySelector('dialog input:not(:disabled)')", 'Create form appears');
      await choose('dialog select', 'voice');
      assert.equal(await run("!!document.querySelector('dialog textarea')"), false, 'Voice channel creation has no description field');
      await enter('dialog input:not([type=number])', 'After Hours');
      await enter('dialog input[type=number]', '12');
      await click(createChannel, 'dialog .modal-actions button');
      await until("window.protectedChanges.length === 2 && !document.querySelector('dialog[open]')", 'Voice channel creation completes directly');
      const create = await run('window.protectedChanges[1].draft');
      assert.deepEqual([create.action, create.kind, create.name, create.voiceCapacity], ['channel.create', 'voice', 'After Hours', 12]);
      await openRoleEditor(roleButton);
      assert.equal(await run(`document.querySelector(${JSON.stringify(nameField)}).value`), 'Legacy name');
      await click(permissions, tabs);
      const administratorWarning = english ? 'Administrator grants full access, including all private channels.' :
        'Право «Администратор» даёт полный доступ, включая все закрытые каналы.';
      const administratorSwitch = "document.querySelector('.protected-role-permissions:last-of-type [role=switch]')";
      assert.equal(await run(`[...document.querySelectorAll('${editor} h4')].at(-1).textContent`), advancedPermissions);
      await run(`${administratorSwitch}.click()`);
      const hasAdministratorWarning = `[...document.querySelectorAll('dialog [role=status]')]
        .some(status => status.textContent.startsWith(${JSON.stringify(administratorWarning)}))`;
      await until(hasAdministratorWarning, 'Full access warning appears on selection');
      await run(`${administratorSwitch}.click()`);
      await click(appearance, tabs);
      await enter(nameField, 'Community');
      assert.equal(await run(roleSaveButtonsAligned), true, 'Server settings use the same aligned role save actions');
      const footerTop = await run("document.querySelector('.protected-role-save').getBoundingClientRect().top");
      await click(permissions, tabs);
      await run("document.querySelector('.protected-server-settings-panel .settings-content').scrollTop = 10000");
      assert.equal(await run("document.querySelector('.protected-role-save').getBoundingClientRect().top"), footerTop, 'Save bar stays in place while permissions scroll');
      await click(appearance, tabs);
      await run('window.previewRosterAvatar = true');
      await click(english ? 'Preview server as role' : 'Предпросмотр сервера от лица роли', editor + ' button');
      await until("document.querySelector('.protected-role-view-page .member-channel[aria-current=true]')?.textContent === 'General'", 'The preview uses the full server layout');
      const previewAvatar = "document.querySelector('.protected-role-view-page .member-roster-person img')?.naturalWidth > 0";
      await until(previewAvatar, 'The role preview shows the avatar for its visible member');
      assert.ok(await run("[...document.querySelectorAll('.protected-role-view-page .member-roster-person')].length === 1"),
        'The authorized roster only supplies appearances for members visible to the simulated role');
      assert.equal(await run(`(() => {
        const page = document.querySelector('.protected-role-view-page');
        return !!page.querySelector('.server-app .member-rail .member-server-list') &&
          !!page.querySelector('#server-channels .protected-channel-row') &&
          !!page.querySelector('.member-chat .protected-chat-preview-locked svg') &&
          !page.querySelector('.protected-channel-settings') &&
          ![...page.querySelectorAll('.member-channel')].some(button => button.textContent === 'Lobby') &&
          page.querySelector('.protected-role-view-bar').getBoundingClientRect().height <= 34;
      })()`), true, 'The normal layout shows only permitted channels and a compact toolbar');
      await click('Meetings', '.protected-role-view-page .member-channel');
      assert.equal(await run("document.querySelector('.protected-role-view-page .member-channel[aria-disabled=true]')?.textContent === 'Meetings' && document.querySelector('.protected-role-view-page .member-channel[aria-current=true]').textContent === 'General'"), true);
      await click(english ? 'Select roles' : 'Выберите роли', '.protected-role-view-bar button');
      assert.equal(await run(`[...document.querySelectorAll('.protected-role-view-options label')].every(label =>
        label.querySelector('input').getBoundingClientRect().right <= label.querySelector('span').getBoundingClientRect().left)`), true);
      await run("[...document.querySelectorAll('.protected-role-view-options label')].find(label => label.textContent === 'Administrator').querySelector('input').click()");
      await until("document.querySelector('.protected-role-view-controls > span').textContent.includes('2') && [...document.querySelectorAll('.protected-role-view-page .member-channel')].some(button => button.textContent === 'Lobby')", 'Two roles update the visible channel list');
      await until("!!document.querySelector('.protected-role-view-page textarea') && document.querySelector('.protected-role-view-page .protected-chat-submit').disabled", 'Allowed text composition is simulated');
      await click('Meetings', '.protected-role-view-page .member-channel');
      await until("document.querySelector('.protected-role-view-page .member-channel[aria-current=true]')?.textContent === 'Meetings'", 'Voice channel opens inside the preview');
      assert.equal(await run("!document.querySelector('.protected-role-view-page .room-split').hidden"), true);
      assert.ok(await run("window.roleViewOperations.every(action => action === 'roster.protected.read')"), 'Preview never reads chat or joins voice');
      await run("[...document.querySelectorAll('.protected-role-view-options label')].find(label => label.textContent === 'Administrator').querySelector('input').click()");
      await until("document.querySelector('.protected-role-view-page .member-channel[aria-current=true]')?.textContent === 'General'", 'Removing the administrator role restores the scoped text channel');
      await until(previewAvatar, 'Removing the administrator role retains the visible member avatar');
      await click(english ? 'Back to role settings' : 'Вернуться к настройкам ролей', '.protected-role-view-bar button');
      assert.equal(await run(`document.querySelector(${JSON.stringify(nameField)}).value`), 'Community');
      await click(saveRole, saveBar);
      await until("window.protectedChanges.length === 3 && !document.querySelector('.protected-role-editor')", 'Role rename confirmed');
      const renamed = await run('window.protectedChanges[2].draft');
      assert.deepEqual([renamed.roleId, renamed.name, renamed.grants], ['member', 'Community', ['channel.view']]);
      await closeSettings();
      await openRoleEditor(roleButton);
      await click(membersTab, tabs);
      const memberSearchAlignment = await run(`(() => {
        const row = document.querySelector('.protected-role-member-search');
        const search = row.querySelector('input').getBoundingClientRect();
        const add = row.querySelector('button').getBoundingClientRect();
        return { sameHeight: Math.abs(search.height - add.height) < 1, sameTop: Math.abs(search.top - add.top) < 1 };
      })()`);
      assert.deepEqual(memberSearchAlignment, { sameHeight: true, sameTop: true });
      await click(english ? 'Add members' : 'Добавить участников', '.protected-role-members button');
      const member = 'b'.repeat(64);
      await until("!!document.querySelector('dialog .protected-channel-recipients input')", 'Named participants appear');
      await run("document.querySelector('dialog .protected-channel-recipients input').click()");
      await run('window.assignmentRequiresRecovery = true');
      await click(preview, 'dialog .modal-actions button');
      const required = english ? 'Recovery setup is required for Friend.' : 'Этим участникам нужно настроить восстановление доступа — Friend.';
      await until(`document.querySelector('dialog [role=alert]')?.textContent === ${JSON.stringify(required)}`,
        'Assignment identifies the member needing recovery');
      await run('window.assignmentRequiresRecovery = false');
      await click(preview, 'dialog .modal-actions button');
      await until("document.querySelector('.protected-role-members dialog summary')?.textContent === 'General'", 'Assignment impact appears');
      await click(apply, 'dialog .modal-actions button');
      await until("window.protectedChanges.length === 4 && !document.querySelector('.protected-role-members dialog[open]')", 'Assignment confirmed');
      const assignment = await run('window.protectedChanges[3].draft');
      assert.deepEqual([assignment.profiles, assignment.roleId, assignment.add], [[member], 'member', true]);
      await closeSettings();
      await openChannelSettings();
      await until("!!document.querySelector('dialog input:not(:disabled)')", 'Channel settings reopen');
      await selectPermissions();
      await click(english ? 'Add role or member' : 'Добавить роль или участника', 'dialog .protected-permission-subjects button');
      await click('Friend', 'dialog .protected-permission-subjects button');
      assert.equal(await run('window.protectedChanges.length'), 4);
      await run("document.querySelector('dialog [data-permission=\"channel.view\"] [data-rule=deny]').click()");
      await click(saveSettings, settingsBar + ' button');
      await until("window.protectedChanges.length === 5 && !document.querySelector('dialog[open]')", 'Personal rule confirmed');
      assert.equal(await run('window.protectedChanges[4].draft.profileId'), member);
      assert.equal(await run("document.querySelector('#server-channels .member-channel-group h2').textContent"), 'General category');
      await run(`(() => {
        const source = document.querySelector('#server-channels .member-channel.selected');
        if (!source.draggable) throw Error('Managed channel is not draggable');
        window.channelTransfer = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.channelTransfer }));
      })()`);
      await until("[...document.querySelectorAll('[data-channel-drop-target] h2')].some(label => label.textContent === 'Destination')",
        'Visible category becomes a drop target');
      assert.equal(await run("[...document.querySelectorAll('#server-channels .member-channel-group h2')].some(label => label.textContent === 'Empty category')"), true);
      await run(`(() => {
        const target = [...document.querySelectorAll('[data-channel-drop-target] h2')]
          .find(label => label.textContent === 'Destination');
        for (const type of ['dragover', 'drop']) {
          const accepted = !target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: window.channelTransfer }));
          if (!accepted) throw Error('Category did not accept ' + type);
        }
      })()`);
      await until("!!document.querySelector('dialog select:not(:disabled) option[value=destination]')", 'Drop opens move dialog');
      assert.deepEqual(await run("[...document.querySelectorAll('dialog select')].map(select => select.value)"), ['destination', '']);
      assert.equal(await run("document.querySelector('dialog .modal-actions button:last-child').disabled"), true);
      assert.equal(await run('window.protectedMovePreviews.length'), 0);
      assert.equal(await run('window.protectedChanges.length'), 5);
      await choose('dialog .form-fields > label:last-child select', 'preserve');
      await click(preview, 'dialog button');
      await until("!!document.querySelector('dialog details')", 'Keep permissions preview appears');
      assert.equal(await run('window.protectedMovePreviews[0].mode'), 'preserve');
      await click(english ? 'Back' : 'Назад', 'dialog button');
      await choose('dialog .form-fields > label:last-child select', 'synchronize');
      await click(preview, 'dialog button');
      await until("!!document.querySelector('dialog details')", 'Move impact appears');
      assert.equal(await run('window.protectedChanges.length'), 5);
      await click(apply, 'dialog button');
      await until("window.protectedChanges.length === 6 && !document.querySelector('dialog[open]')", 'Move confirmed');
      const moved = await run('window.protectedChanges[5].draft');
      assert.deepEqual([moved.action, moved.categoryId, moved.mode], ['channel.move', 'destination', 'synchronize']);
      await openCategories();
      await until("!!document.querySelector('dialog option[value=category]')", 'Categories open');
      await choose('dialog select', 'category');
      await choose('dialog .form-fields > label:nth-child(2) select', 'category.delete');
      assert.equal(await run("document.querySelector('dialog .form-fields > label:last-of-type select').value"), 'keep_children');
      await click(english ? 'Delete category' : 'Удалить категорию', 'dialog button');
      await until("window.protectedChanges.length === 7 && !document.querySelector('dialog[open]')", 'Category removed with channels kept');
      assert.equal(await run('window.protectedChanges[6].draft.mode'), 'keep_children');
      await run(`(() => {
        const [source, target] = document.querySelectorAll('#server-channels .member-channel-group:has([data-reorder-id="${'2'.repeat(32)}"]) .member-channel');
        const transfer = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        const bounds = target.getBoundingClientRect();
        for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type,
          { bubbles: true, cancelable: true, clientY: bounds.top + bounds.height / 2, dataTransfer: transfer }));
        source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
      })()`);
      await until("window.protectedChanges.length === 8 && !document.querySelector('dialog[open]')", 'Drag applies channel order');
      const order = await run('window.protectedChanges[7].draft');
      assert.deepEqual([order.action, order.anchorId, order.after], ['channel.order', '3'.repeat(32), true]);
      await openCategories();
      await until("!!document.querySelector('dialog option[value=category]')", 'Categories reopen');
      await choose('dialog select', 'category');
      await choose('dialog .form-fields > label:nth-child(2) select', 'category.order');
      await choose('dialog .form-fields > label:nth-child(3) select', 'destination');
      await click(preview, 'dialog button');
      await until("document.querySelector('dialog .form-fields').textContent.includes('Destination')", 'Category order preview');
      await click(apply, 'dialog button');
      await until("window.protectedChanges.length === 9 && !document.querySelector('dialog[open]')", 'Category order applied');
      const categoryOrder = await run('window.protectedChanges[8].draft');
      assert.deepEqual([categoryOrder.action, categoryOrder.anchorId, categoryOrder.after], ['category.order', 'destination', false]);
      await motion('no-preference');

      await run('window.protectedTotalChannels = 1');
      await openChannelSettings();
      await click(deleteTab, 'dialog .settings-nav button');
      const lastChannel = english ? 'This is the last channel on the server.' : 'Это последний канал на сервере.';
      const deletion = '.protected-channel-delete-modal';
      await until(`document.querySelector('${deletion}')?.textContent.includes(${JSON.stringify(lastChannel)})`,
        'Deleting the last channel shows the explicit warning');
      assert.equal(await run('window.protectedChanges.length'), 9);
      await click(english ? 'Cancel' : 'Отмена', deletion + ' button');
      await until(`!document.querySelector('${deletion}') && !!document.querySelector('.protected-channel-settings-dialog[open]')`,
        'Cancelling returns to settings without changing the channel');
      await run("document.querySelector('.protected-channel-settings-dialog > .modal-heading button').click()");
      await openChannelContext();
      await click(deleteTab, '.member-context button');
      await until(`document.querySelector('${deletion} .chat-delete-confirm')?.disabled === false`, 'Context menu opens confirmation directly');
      assert.equal(await run(`document.querySelectorAll('dialog[open]').length === 1 &&
        document.querySelector('${deletion} .chat-delete-question').textContent.includes('General')`), true);
      assert.equal(await run('window.protectedChanges.length'), 9);
      await click(deleteTab, deletion + ' .modal-actions button');
      await until("window.protectedChanges.length === 10 && !document.querySelector('dialog[open]')", 'Last channel deletion is confirmed');
      assert.equal(await run('window.protectedChanges[9].draft.action'), 'channel.delete');
      await run("window.setTextProtection({ state:'yellow', reason:'CURRENT_KEY_PENDING', allowSend:false })");
      const pending = english ? 'Protection updating' : 'Защита обновляется';
      await until(`document.querySelector('.protected-text-status-button[data-state=yellow]')?.getAttribute('aria-label') === ${JSON.stringify(pending)}`,
        'Temporary key wait is shown');
      assert.equal(await run("document.querySelector('dialog[open]')"), null);
      await openChannelSettings();
      await click(english ? 'Create a new channel after key loss' : 'Создать новый канал после утраты ключей',
        'dialog .settings-nav button');
      assert.equal(await run("document.querySelector('dialog .modal-actions button:last-child').disabled"), true);
      assert.equal(await run('window.protectedCopyPreviews.length'), 0);
      assert.equal(await run('window.protectedChanges.length'), 10);
      await run("document.querySelector('dialog [role=switch]').click()");
      await click(preview, 'dialog .modal-actions button');
      const archive = english ? 'The encrypted archive will stay in the original channel.' : 'Старый шифрованный архив останется в исходном канале.';
      await until(`document.querySelector('dialog .form-fields')?.textContent.includes(${JSON.stringify(archive)})`, 'Continuation preview describes the preserved archive');
      assert.equal(await run('window.protectedChanges.length'), 10);
      assert.deepEqual(await run('window.protectedCopyPreviews.map(draft => [draft.action, draft.channelId])'), [['channel.copy', '2'.repeat(32)]]);
      await click(english ? 'Create new channel' : 'Создать новый канал', 'dialog .modal-actions button');
      await until("window.protectedChanges.length === 11 && document.querySelector('#server-channels .member-channel[aria-current=true], #server-channels .member-channel.selected')?.textContent === 'New channel'",
        'Confirmed continuation opens the new channel');
      assert.equal(await run("[...document.querySelectorAll('#server-channels .member-channel')].some(button => button.textContent === 'General')"), true);

      const openInvites = async () => {
        await run("document.querySelector('.member-server-title button.icon-button').click()");
        await until("!!document.querySelector('dialog .member-management-row')", 'Invitation list appears');
      };
      await load('inviter');
      await openInvites();
      await choose('dialog select', 'manual');
      await enter('dialog input[type=datetime-local]', '2035-05-01T12:00');
      await choose('dialog select:has(option[value=count])', 'count');
      await enter('dialog input[type=number]', '4');
      await until("document.querySelector('dialog .invite-author span[title]')?.textContent === 'Friend' && document.querySelector('dialog .invite-author img')?.naturalWidth === 1", 'Invitation creator uses the roster name and avatar');
      assert.equal(await run("document.querySelector('dialog').innerText.includes('bbbbbbbbbbbb')"), false);
      const nextInvites = english ? 'Next' : 'Далее';
      await click(nextInvites, 'dialog .invite-pagination button');
      await until(`document.querySelector('.invite-pagination span')?.textContent.endsWith('2')`, 'The invitation history changes page');
      await click(english ? 'Back' : 'Назад', 'dialog .invite-pagination button');
      await until("!!document.querySelector('dialog .invite-row')", 'Back restores the invitation history');
      const geometry = await run(`(() => {
        const labels = [...document.querySelectorAll('dialog form .invite-fields > label')].map(label => label.getBoundingClientRect());
        const buttons = [...document.querySelectorAll('dialog .member-management-list .modal-actions button')].map(button => button.getBoundingClientRect());
        return { gaps: labels.slice(2).map((label, i) => label.top - labels[i].bottom),
          sameRow: labels[0].top === labels[1].top, centers: buttons.map(b => b.top + b.height / 2) };
      })()`);
      assert.equal(geometry.sameRow, true);
      assert.deepEqual(geometry.gaps, [20, 20]);
      assert.equal(geometry.centers.length, 2);
      assert.equal(geometry.centers[0], geometry.centers[1]);
      await click(english ? 'Create link' : 'Создать ссылку', 'dialog button');
      await until("window.copied === 'synthetic-invitation-link' && !!document.querySelector('dialog .invite-toast [role=status]')", 'Creating an invite copies the link and shows a notification');
      assert.equal(await run("!!document.querySelector('dialog input[readonly]')"), false);
      const issued = await run('window.inviteRequests[0][1]');
      assert.equal(issued.maxUses, 4);
      assert.equal(issued.expiresAt, new Date('2035-05-01T12:00').getTime());
      await click(english ? 'Revoke' : 'Отозвать', 'dialog button');
      await until("window.inviteRequests.length === 2 && !document.querySelector('dialog .invite-row button')", 'Revoked invitation stays in history without the revoke action');
      await run("window.failClipboard = true; window.copied = ''");
      await click(english ? 'Create link' : 'Создать ссылку', 'dialog button');
      await until("!!document.querySelector('.invite-copy-retry button') && !document.querySelector('.invite-toast')", 'A clipboard failure offers a retry');
      await run("window.failClipboard = false; document.querySelector('.invite-copy-retry button').click()");
      await until("window.copied === 'synthetic-invitation-link' && !document.querySelector('.invite-copy-retry')", 'Retry copies successfully');
      assert.equal(await run("window.inviteRequests.filter(([action]) => action === 'create').length"), 2);
      await load('invite-viewer');
      await openInvites();
      assert.equal(await run("!!document.querySelector('dialog form, dialog input[readonly], dialog .member-management-row button')"), false);
      await win.loadURL(process.env.PAWTALK_UI_TEST_URL + `/tests/notifications.html?language=${language}&protected=membership-moderator`);
      await until("!!document.querySelector('.member-server-list button')", 'Moderated server appears');
      await run("document.querySelector('.member-server-list button').click()");
      await until("document.querySelector('#server-channels .member-channel[aria-current=true], #server-channels .member-channel.selected')?.textContent === 'General'", 'Moderated channel appears');
      if (!await run("!!document.querySelector('.protected-channel-roster')")) {
        const rosterButton = english ? 'Show participants' : 'Показать участников';
        await run(`document.querySelector('button[aria-label="${rosterButton}"]').click()`);
      }
      await until("document.querySelector('.protected-channel-roster')?.textContent.includes('Friend')", 'Moderation target appears');
      const presenceLabels = english ? ['Online', 'Away', 'Offline'] : ['В сети', 'Отошел', 'Не в сети'];
      assert.deepEqual(await run("[...document.querySelectorAll('.protected-channel-roster .member-status')].map(status => status.getAttribute('aria-label')).sort()"),
        presenceLabels.sort(), 'All three presence statuses are accessible');
      await run(`[...document.querySelectorAll('.protected-channel-roster .member-roster-person')].find(button =>
        button.querySelector('.member-roster-nickname')?.textContent === 'Friend').dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
      assert.ok(await run(`[...document.querySelectorAll('.member-context button')].some(button =>
        button.textContent.trim() === ${JSON.stringify(english ? 'Kick from server' : 'Исключить с сервера')})`), 'Kick is offered in the context menu');
      await click(english ? 'Ban' : 'Заблокировать', '.member-context button');
      await until("!!document.querySelector('dialog input[required]')", 'Ban reason appears');
      assert.equal(await run("document.querySelector('dialog button[type=submit]').disabled"), true);
      await enter('dialog input[required]', 'Synthetic reason');
      const cleanup = 'dialog select:has(option[value=none])';
      assert.equal(await run(`document.querySelector(${JSON.stringify(cleanup)}).value`), 'none');
      await choose(cleanup, 'hour');
      assert.equal(await run("document.querySelector('dialog button[type=submit]').disabled"), true);
      await click(english ? 'Preview' : 'Предпросмотр', 'dialog button');
      await until("document.querySelector('dialog [role=status]')?.textContent.endsWith('2')", 'Cleanup preview appears');
      assert.equal(await run("window.protectedCleanupPreview.window"), 'hour');
      await click(english ? 'Ban' : 'Заблокировать', 'dialog button');
      await until(`document.querySelector('dialog [role=status]')?.textContent === ${JSON.stringify(english ? 'Messages removed · 2' : 'Удалено сообщений · 2')}`, 'Cleanup result appears');
      await click(english ? 'Done' : 'Готово', 'dialog button');
      await until("window.protectedMembershipChanges.length === 1 && !document.querySelector('dialog[open]')", 'Ban submitted');
      assert.deepEqual(await run("window.protectedMembershipChanges.map(({action,reason,cleanupId}) => [action,reason,cleanupId])"),
        [['ban','Synthetic reason','a'.repeat(32)]]);
      await openServerSettings(english ? 'Bans' : 'Баны');
      await until("document.querySelector('dialog')?.textContent.includes('Synthetic reason')", 'Ban reason appears in list');
      await click(english ? 'Revoke ban' : 'Снять блокировку', 'dialog button');
      await until("window.protectedMembershipChanges.at(-1)?.action === 'unban'", 'Ban revoked');
      await load('owner');
      await run("document.querySelector('.member-channel-caption button[aria-label]').click()");
      await until("!!document.querySelector('dialog input:not(:disabled)')", 'Category opens channel creation');
      assert.equal(await run("document.querySelectorAll('dialog select').length"), 1, 'The category plus fixes the destination');
      await enter('dialog input:not([type=number]):not([type=checkbox])', 'Private channel fixture');
      await run("document.querySelector('dialog [role=switch]').click()");
      await click(english ? 'Continue' : 'Продолжить', 'dialog .modal-actions button');
      await until("document.querySelectorAll('.protected-channel-recipients input').length === 2", 'Private channel shows roles and members');
      await run("document.querySelector('.protected-channel-recipients input').click()");
      await click(createChannel, 'dialog .modal-actions button');
      await until("window.protectedChanges.length === 1 && !document.querySelector('dialog[open]')", 'Private channel creation completes directly');
      assert.deepEqual(await run("window.protectedChanges[0].draft.privateAccess"), { roles: ['member'], profiles: [] });
      assert.equal(await run("window.protectedChanges[0].draft.categoryId"), 'category');
      await openCategories();
      await until("!!document.querySelector('dialog input:not(:disabled)')", 'Category creation reads current policy');
      await enter('dialog input', 'New empty category');
      await click(createCategory, 'dialog .modal-actions button');
      const emptyCategory = "[...document.querySelectorAll('.member-channel-group')].find(group => group.querySelector('h2')?.textContent === 'New empty category')";
      await until(`!!${emptyCategory}`, 'An empty category appears immediately after creation');
      await run(`${emptyCategory}.querySelector('.member-channel-caption button').click()`);
      await until("!!document.querySelector('dialog input:not(:disabled)')", 'The new category’s plus opens channel creation');
      assert.equal(await run("document.querySelectorAll('dialog select').length"), 1);
      await load('root-layout');
      const groupHeadings = "document.querySelector('#server-channels .member-channel-scroll')";
      assert.equal(await run(`${groupHeadings}.firstElementChild.classList.contains('protected-root-channels')`), true);
      assert.deepEqual(await run("[...document.querySelectorAll('.protected-root-channels .member-channel')].map(channel => channel.textContent)"), ['General','Meetings']);
      assert.equal(await run("!!document.querySelector('.protected-root-channels h2, .category-drag-handle')"), false);
      assert.equal(await run("document.querySelectorAll('.protected-category-group h2[draggable=true]').length"), 3);
      const categoryHeading = "document.querySelector('.protected-category-group h2[draggable=true]')";
      assert.equal(await run(`getComputedStyle(${categoryHeading}).cursor`), 'default');
      await run(`(() => {
        window.categoryCursorTransfer = new DataTransfer();
        ${categoryHeading}.dispatchEvent(new DragEvent('dragstart', { bubbles:true, cancelable:true, dataTransfer:window.categoryCursorTransfer }));
      })()`);
      await until(`getComputedStyle(${categoryHeading}).cursor === 'grabbing'`, 'The category shows a drag cursor only during a drag');
      await run(`${categoryHeading}.dispatchEvent(new DragEvent('dragend', { bubbles:true, dataTransfer:window.categoryCursorTransfer }))`);
      await until(`getComputedStyle(${categoryHeading}).cursor === 'default'`, 'The drag cursor resets on release');
      await run(`(() => {
        const [source, target] = document.querySelectorAll('.protected-root-channels .member-channel');
        const transfer = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart', {bubbles:true,cancelable:true,dataTransfer:transfer}));
        const y = target.getBoundingClientRect().bottom - 1;
        for (const type of ['dragover','drop']) target.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:transfer,clientY:y}));
        source.dispatchEvent(new DragEvent('dragend', {bubbles:true,dataTransfer:transfer}));
      })()`);
      await until("window.protectedChanges.length === 1", 'Root text and voice channels reorder together');
      const rootOrder = await run('window.protectedChanges[0].draft');
      assert.deepEqual([rootOrder.action, rootOrder.anchorId, rootOrder.mixedOrder], ['channel.order','3'.repeat(32),true]);
      await openServerMenu();
      await click(createChannel, '.member-context button');
      await until("!!document.querySelector('dialog input:not(:disabled)')", 'Root channel creation opens');
      assert.equal(await run("document.querySelectorAll('dialog select').length"), 1, 'Server menu creation uses the root');
      await enter('dialog input:not([type=number]):not([type=checkbox])', 'Root channel');
      await click(createChannel, 'dialog .modal-actions button');
      await until("window.protectedChanges.length === 2 && !document.querySelector('dialog[open]')", 'Root channel creation completes directly');
      assert.deepEqual(await run("window.protectedChanges.map(({draft}) => [draft.action,draft.categoryId ?? ''])"),
        [['channel.order',''],['channel.create','']]);
      const aclSubjectButtons = 'dialog .protected-permission-subjects button[aria-pressed]';
      const addSubject = english ? 'Add role or member' : 'Добавить роль или участника';
      const permissionView = 'dialog [data-permission="channel.view"]';
      const assertPrivateDefaults = async () => {
        await until(`document.querySelector('${aclSubjectButtons}')?.textContent === '@everyone'`, 'Everyone is the initial subject');
        assert.deepEqual(await run(`[...document.querySelectorAll('${aclSubjectButtons}')].map(button => button.textContent)`), ['@everyone']);
        assert.ok(await run(`[...document.querySelectorAll('dialog .protected-permission-row button[aria-pressed=true]')].every(button => button.dataset.rule === 'inherit')`));
        await run("document.querySelector('dialog [role=switch]').click()");
        assert.equal(await run(`document.querySelector('${permissionView} button[aria-pressed=true]').dataset.rule`), 'deny');
        await click(addSubject, 'dialog .protected-permission-subjects button');
        await click('Friend', 'dialog .protected-permission-picker button');
        await run(`document.querySelector('${permissionView} [data-rule=allow]').click()`);
        await click(saveSettings, settingsBar + ' button');
      };
      await openChannelSettings();
      await selectPermissions();
      await assertPrivateDefaults();
      await until("window.protectedChanges.length === 3 && !document.querySelector('dialog[open]')", 'Channel ACL is saved');
      assert.deepEqual(await run('window.protectedChanges[2].draft.changes'), [
        {role:'@everyone',permission:'channel.view',rule:'deny'},
        {profileId:'b'.repeat(64),permission:'channel.view',rule:'allow'},
      ]);
      const openCategoryMenu = () => run("document.querySelector('.protected-category-group h2').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))");
      const editCategory = english ? 'Edit category' : 'Редактировать категорию';
      const deleteCategory = english ? 'Delete category' : 'Удалить категорию';
      const categoryPage = 'dialog.protected-category-settings.settings-full-page';
      const categoryNav = categoryPage + ' .settings-nav button';
      await openCategoryMenu();
      await until("!!document.querySelector('.member-context')", 'The category context menu opens');
      assert.deepEqual(await run("[...document.querySelectorAll('.member-context button')].map(button => button.textContent.trim())"),
        [editCategory, deleteCategory]);
      await click(editCategory, '.member-context button');
      await until(`document.querySelector('${categoryPage} .settings-content input')?.value === 'General category'`, 'Category settings open in the overview');
      assert.deepEqual(await run(`[...document.querySelectorAll('${categoryNav}')].map(button => button.textContent.trim())`),
        [english ? 'Overview' : 'Обзор', permissions]);
      assert.ok(await run(`(() => {
        const bounds = document.querySelector('${categoryPage}').getBoundingClientRect();
        return bounds.width === innerWidth && bounds.height === innerHeight;
      })()`), 'The dialog fills the window');
      assert.equal(await run(`document.querySelector('${categoryPage} select')`), null);
      await click(permissions, categoryNav);
      await assertPrivateDefaults();
      await until("window.protectedChanges.length === 4 && !document.querySelector('dialog[open]')", 'Category ACL is saved');
      assert.deepEqual(await run('window.protectedChanges[3].draft.changes'), [
        {role:'@everyone',permission:'channel.view',rule:'deny'},
        {profileId:'b'.repeat(64),permission:'channel.view',rule:'allow'},
      ]);
      await openCategoryMenu();
      await click(editCategory, '.member-context button');
      await until(`document.querySelector('${categoryPage} .settings-content input:not(:disabled)')?.value === 'General category'`, 'Rename form loads the selected category');
      await enter(categoryPage + ' .settings-content input', 'Renamed category');
      await click(saveSettings, settingsBar + ' button');
      await until("window.protectedChanges.length === 5 && !document.querySelector('dialog[open]')", 'Overview renames the category');
      assert.deepEqual(await run("(({ action, categoryId, name }) => [action, categoryId, name])(window.protectedChanges[4].draft)"),
        ['category.settings.update', 'category', 'Renamed category']);
      await openCategoryMenu();
      await click(deleteCategory, '.member-context button');
      const categoryDeletion = '.protected-category-delete-modal';
      await until(`!!document.querySelector('${categoryDeletion} select:not(:disabled) option[value=keep_children]')`, 'Delete opens its own confirmation');
      assert.equal(await run("!!document.querySelector('dialog.settings-full-page')"), false);
      assert.deepEqual(await run("[...document.querySelectorAll('dialog select')].map(select => select.value)"), ['keep_children']);
      const noChannels = english ? 'The server will have no channels left.' : 'На сервере не останется каналов.';
      await choose(categoryDeletion + ' select', 'delete_children');
      await until(`document.querySelector('${categoryDeletion} .protected-resource-delete-warning')?.textContent.includes(${JSON.stringify(noChannels)})`, 'Deleting the last channels warns before confirmation');
      await click(english ? 'Cancel' : 'Отмена', categoryDeletion + ' button');
      assert.equal(await run('window.protectedChanges.length'), 5);
      await openCategoryMenu();
      await click(deleteCategory, '.member-context button');
      await until(`document.querySelector('${categoryDeletion} select')?.value === 'keep_children'`, 'The safe choice is restored on a new confirmation');
      await choose(categoryDeletion + ' select', 'delete_children');
      await click(deleteCategory, categoryDeletion + ' button');
      await until("window.protectedChanges.length === 6 && !document.querySelector('dialog[open]')", 'Category and channels are removed from one confirmation');
      assert.deepEqual(await run("(({ action, categoryId, mode }) => [action, categoryId, mode])(window.protectedChanges[5].draft)"),
        ['category.delete', 'category', 'delete_children']);
      await load('owner');
      await openChannelSettings();
      await until("!!document.querySelector('dialog .form-fields input:not(:disabled)')", 'Channel overview is ready for editing');
      await enter(overviewInput, 'Renamed channel');
      await click(saveSettings, settingsBar + ' button');
      await until("window.protectedChanges.length === 1 && !document.querySelector('dialog[open]')", 'Channel overview saves in one step');
      assert.deepEqual(await run("(({ action, name }) => [action, name])(window.protectedChanges[0].draft)"),
        ['channel.settings.update', 'Renamed channel']);
      const copyLabel = english ? 'Create a channel copy' : 'Создать копию канала';
      const copyDialog = '.protected-channel-copy-dialog';
      const openCopy = async () => {
        await openChannelContext();
        await click(copyLabel, '.member-context button');
        await until(`!!document.querySelector('${copyDialog} .primary:not(:disabled)')`, 'Channel copy opens as a confirmation');
      };
      await openCopy();
      assert.ok(await run(`document.querySelector('${copyDialog} .chat-delete-question').textContent.includes('General')`));
      await click(english ? 'Cancel' : 'Отмена', copyDialog + ' button');
      assert.equal(await run('window.protectedCopyPreviews.length'), 0, 'Cancel does not prepare or copy the channel');
      await openCopy();
      await click(english ? 'Create copy' : 'Создать копию', copyDialog + ' button');
      await until("window.protectedChanges.length === 2 && !document.querySelector('dialog[open]')", 'One confirmation creates the copy');
      assert.deepEqual(await run("window.protectedCopyPreviews.map(({action,channelId}) => [action,channelId])"),
        [['channel.copy', '2'.repeat(32)]]);
      await run('window.explicitAdminView = true');
      await openChannelSettings();
      await selectPermissions();
      await until("!!document.querySelector('dialog [data-permission] button:not(:disabled)')", 'Channel permissions appear');
      assert.equal(await run("getComputedStyle(document.querySelector('.protected-channel-settings-dialog > .modal-heading button')).backgroundColor"), 'rgba(0, 0, 0, 0)');
      await click(addSubject, 'dialog .protected-permission-subjects button');
      await until("!!document.querySelector('.protected-permission-picker .permission-subject-avatar img')", 'The picker shows the candidate avatar');
      assert.equal(await run("getComputedStyle(document.querySelector('.protected-permission-picker .permission-subject-dot')).backgroundColor"), 'rgb(90, 137, 188)');
      await click('Reader', 'dialog .protected-permission-picker button');
      await click(addSubject, 'dialog .protected-permission-subjects button');
      await click('Friend', 'dialog .protected-permission-picker button');
      assert.deepEqual(await run("[...document.querySelectorAll('dialog .protected-permission-subjects button[aria-pressed] .permission-subject-name')].map(label => label.textContent)"),
        ['Reader', '@everyone', 'Friend']);
      assert.equal(await run("!!document.querySelector('dialog .protected-permission-subjects button[aria-pressed=true] .permission-subject-selected')"), true);
      await click(addSubject, 'dialog .protected-permission-subjects button');
      await click('Me', 'dialog .protected-permission-subjects button');
      assert.deepEqual(await run("[...document.querySelectorAll('dialog [data-permission]')].map(row => row.dataset.permission)"), ['channel.view']);
      assert.equal(await run("document.querySelector('dialog [data-rule=deny]').disabled"), true);
      assert.equal(await run("document.querySelector('dialog [data-rule=allow]').getAttribute('aria-pressed')"), 'true');
      await click(saveSettings, settingsBar + ' button');
      await until("window.protectedChanges.length === 3", 'The selected administrator saves as an explicit view entry');
      assert.deepEqual(await run('window.protectedChanges[2].draft.changes'),
        [{ profileId: 'a'.repeat(64), permission: 'channel.view', rule: 'allow' }]);
      await openChannelSettings();
      await selectPermissions();
      await until("!!document.querySelector('dialog .protected-permission-subjects button[aria-expanded] svg')", 'Add role or member has an icon');
      const createRoleLabel = english ? 'Create role' : 'Создать роль';
      assert.ok(await run(`(() => {
        const layout = document.querySelector('dialog .protected-permission-layout');
        const add = layout.querySelector('button[aria-expanded]');
        const create = [...layout.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(createRoleLabel)});
        const rows = layout.querySelector('.protected-permission-rows');
        return Math.abs(add.querySelector('svg').getBoundingClientRect().left - create.querySelector('svg').getBoundingClientRect().left) < 1 &&
          Math.abs(add.getBoundingClientRect().width - create.getBoundingClientRect().width) < 1 &&
          getComputedStyle(rows).borderInlineStartWidth === '1px';
      })()`), 'Subject actions align and a divider separates the permission rows');
      await click(createRoleLabel, '.protected-permission-subjects button');
      await until("!!document.querySelector('dialog.settings-full-page .protected-role-full-page .protected-role-tabs')", 'Creating a role from a channel opens the full-page editor');
      await run("localStorage.removeItem('pawtalk.v2.mute-channel.' + '1'.repeat(32) + '.' + '2'.repeat(32))");
      await load('formatted-chat');
      await run(`window.setWindowActive(false);
        localStorage.removeItem('pawtalk.v3.read.' + ['1'.repeat(32), 'a'.repeat(64), '2'.repeat(32)].join(':'));
        window.protectedAlerts = [{channelId:'${'2'.repeat(32)}',position:201,kind:'direct'}];
        window.protectedActivityPosition = 202;
        window.notificationTriggeredAt = performance.now();
        window.invalidateGeneralChat();`);
      await until("window.desktopNotifications.some(item => item.position === 201) && window.desktopNotifications.some(item => item.position === 202 && item.ordinary)", 'Both a mention and ordinary activity reach the desktop notification bridge');
      assert.ok(await run("performance.now() - window.notificationTriggeredAt < 2000"), 'Live alerts do not wait for the former 2.5-second debounce');
      assert.equal(await run("document.querySelector('.protected-channel-row .member-channel-count.has-mention')?.textContent"), '2');
      const unreadRow = "document.querySelector('.member-channel-count.has-mention').closest('.protected-channel-row')";
      const badgeRight = () => run(`${unreadRow}.querySelector('.member-channel-count').getBoundingClientRect().right`);
      const rightEdge = await badgeRight();
      const hover = await run(`(() => {
        const row = ${unreadRow}.getBoundingClientRect();
        return { x: Math.round(row.left + row.width / 2), y: Math.round(row.top + row.height / 2) };
      })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', ...hover });
      await until(`${unreadRow}.matches(':hover')`, 'The unread channel is hovered');
      assert.equal(await badgeRight(), rightEdge);
      assert.equal(await run(`!!${unreadRow}.querySelector('.protected-channel-settings')`), false);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
      await run('window.allowChannelSettings = true; window.refresh()');
      const gear = `${unreadRow}.querySelector('.protected-channel-settings')`;
      await until(`!!${gear} && !${unreadRow}.matches(':hover') && getComputedStyle(${gear}).opacity === '0'`,
        'The selected channel hides its settings gear until hovered');
      assert.equal(await badgeRight(), rightEdge);
      win.webContents.sendInputEvent({ type: 'mouseMove', ...hover });
      await until(`getComputedStyle(${gear}).opacity === '1' && ${unreadRow}.querySelector('.member-channel-count').getBoundingClientRect().right < ${rightEdge} - 20`,
        'On hover the unread badge moves left and the settings gear appears');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
      await until(`getComputedStyle(${gear}).opacity === '0' && Math.abs(${unreadRow}.querySelector('.member-channel-count').getBoundingClientRect().right - ${rightEdge}) < 1`,
        'The badge returns to the right edge when the pointer leaves');
      await openChannelContext();
      await click(english ? 'Mark as read' : 'Пометить как прочитанное', '.member-context button');
      await until("!document.querySelector('.protected-channel-row .member-channel-count') && window.notificationReads.some(read => read.messageId === 202)", 'Marking the channel read removes the badge and dismisses notifications');
      await run(`window.voiceSidebarFixture = { canEditSettings: true,
        settings: { voiceCapacity: 2 }, voiceParticipants: [{ profileId: '${'b'.repeat(64)}', sessionId: '${'f'.repeat(32)}', name: 'Friend', selfMuted: true }] };
        window.refresh();`);
      const voiceRow = "document.querySelector('.protected-channel-row:has(.member-channel-capacity)')";
      const voiceBadge = `${voiceRow}.querySelector('.member-channel-capacity')`;
      await until(`${voiceRow}?.querySelector('.member-channel-capacity')?.textContent.trim() === '1 / 2'`, 'Voice occupancy is visible at rest');
      assert.equal(await run(`${voiceRow}.parentElement.querySelector('.member-channel-person').title`), 'Friend');
      assert.equal(await run(`${voiceRow}.parentElement.querySelector('.protected-voice-member-name').textContent`), 'Friend');
      assert.equal(await run(`(() => {
        const member = ${voiceRow}.parentElement.querySelector('.protected-voice-member[data-muted=true]');
        return !!member && getComputedStyle(member.querySelector('.avatar')).filter !== 'none' &&
          !member.querySelector('button') && !!member.querySelector('.person-status-icons svg');
      })()`), true, 'Muted sidebar participants are dimmed and retain the mute icon without an action button');
      assert.ok(await run(`(() => {
        const member = ${voiceRow}.parentElement.querySelector('.protected-voice-member');
        const avatar = member.querySelector('.avatar').getBoundingClientRect();
        const name = member.querySelector('.protected-voice-member-name').getBoundingClientRect();
        return Math.abs((avatar.top + avatar.height / 2) - (name.top + name.height / 2)) < 1;
      })()`), 'The name and avatar share a vertical center');
      const voiceRight = await run(`${voiceBadge}.getBoundingClientRect().right`);
      const hoverVoice = await run(`(() => {
        const box = ${voiceRow}.getBoundingClientRect();
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
      })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', ...hoverVoice });
      await until(`${voiceBadge}.getBoundingClientRect().right < ${voiceRight} - 20`, 'Voice occupancy moves left for the settings gear');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
      await run("document.querySelector('.protected-voice-member').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))");
      await click(english ? 'Deafen' : 'Откл. звук', '.member-context button');
      await until("window.voiceModeration.some(({input}) => input.action === 'voice.deafen' && !input.serverWide)", 'Sidebar delegates channel deafen to the voice session action');
      await run(`(() => {
        window.voiceDrag = new DataTransfer();
        document.querySelector('.protected-voice-member').dispatchEvent(new DragEvent('dragstart', {bubbles:true,cancelable:true,dataTransfer:window.voiceDrag}));
      })()`);
      const destinationRow = `document.querySelector('[data-reorder-id="${'5'.repeat(32)}"] .protected-channel-row')`;
      await until(`(${destinationRow}.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:window.voiceDrag})), ${destinationRow}.hasAttribute('data-voice-drop'))`, 'An authorized drop target is highlighted');
      await run(`${destinationRow}.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.voiceDrag}))`);
      await until(`window.voiceModeration.some(({action,input}) => action === 'voice.protected.move' && input.targetSessionId === '${'f'.repeat(32)}' && input.destinationChannelId === '${'5'.repeat(32)}')`, 'Dragging sends the authorized request for the active voice session');
      await run('window.voiceSidebarFixture.settings.voiceCapacity = 0; window.refresh()');
      await until(`!${voiceRow}`, 'The unlimited channel has no occupancy badge');
      console.log('PASS protected channel UI ' + language);
    }
  } finally { win.destroy(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
