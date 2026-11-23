const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

app.setPath('userData', join(tmpdir(), 'pawtalk-scoped-channel-settings-ui-' + process.pid));
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
  const button = (label, selector = 'button') =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find(item => item.textContent.trim() === ${JSON.stringify(label)})`;
  const click = (label, selector) => run(`${button(label, selector)}.click()`);
  const enter = (selector, value) => run(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const formButton = 'dialog .modal-actions button';
  const name = 'dialog input:not([type])';
  const count = 'dialog input[type=number]';
  const commits = "window.scopedSettingsCalls.filter(call => call.action.endsWith('.commit'))";
  const openMenu = async label => {
    await run(`${button(label, '#server-channels .member-channel')}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
    await until("!!document.querySelector('.member-context')", 'Open channel menu');
  };
  const menuButtons = '.member-context button';
  const openSettings = async (name, label) => { await openMenu(name); await click(label, menuButtons); };
  const close = () => run("document.querySelector('dialog .modal-heading button').click()");

  try {
    for (const language of ['ru', 'en']) {
      const english = language === 'en';
      const settings = english ? 'Channel settings' : 'Настройки канала';
      const save = english ? 'Save changes' : 'Сохранить изменения';
      const refresh = english ? 'Refresh verification' : 'Обновить подтверждение';
      const access = english ? 'Access rules' : 'Правила доступа';
      await win.loadURL(process.env.PAWTALK_UI_TEST_URL + `/tests/notifications.html?language=${language}&protected=scoped-settings`);
      await until("!!document.querySelector('.member-server-list button')", 'Server appears');
      await run("document.querySelector('.member-server-list button').click()");
      await until(`!!${button('General', '#server-channels .member-channel')}`, 'Protected channels appear');
      await openMenu('Read only');
      assert.equal(await run(`!!${button(settings, menuButtons)}`), false);
      assert.equal(await run(`!!${button(access, menuButtons)}`), false);
      assert.equal(await run('window.scopedSettingsCalls.length'), 0);
      await openSettings('General', access);
      const inherited = JSON.stringify(english ? 'Role rules are inherited from the category.' : 'Ролевые правила наследуются от категории.');
      await until(`document.querySelector('dialog')?.textContent.includes(${inherited})`, 'Verified ACL rules show their source');
      await run("document.querySelector('dialog [data-permission=\"channel.view\"] [data-rule=inherit]').click()");
      await until(`!!${button(save, formButton)}`, 'ACL edit exposes the save bar');
      assert.equal(await run('window.scopedACLCommit'), undefined);
      await click(save, formButton);
      await until('!!window.scopedACLCommit && !document.querySelector(".settings-save-bar")', 'Signed ACL receipt is shown');
      assert.deepEqual(await run('window.scopedACLCommit.rules'), { '@everyone': { Allow: null, Deny: ['message.send'] } });
      assert.equal(await run('window.scopedACLCommit.policyHead'), 'a'.repeat(64));
      await close();
      const personal = english ? 'Personal access rules' : 'Персональные правила доступа';
      await openSettings('General', personal);
      await enter('dialog input', 'b'.repeat(64));
      await click(english ? 'Check profile' : 'Проверить профиль', 'dialog button');
      await until("!!document.querySelector('dialog [data-permission]')", 'Selected profile rule loads');
      await run("document.querySelector('dialog [data-permission=\"channel.view\"] [data-rule=deny]').click()");
      assert.equal(await run('window.scopedPersonalACLCommit'), undefined);
      await click(save, formButton);
      await until('!!window.scopedPersonalACLCommit && !document.querySelector(".settings-save-bar")', 'Personal ACL receipt is shown');
      assert.deepEqual(await run('window.scopedPersonalACLCommit'), { serverId: '1'.repeat(32), channelId: '2'.repeat(32),
        profileId: 'b'.repeat(64), policyHead: 'b'.repeat(64), permission: 'channel.view', rule: 'deny' });
      await close();

      await run("window.scopedSettingsReadError = 'POLICY_ATTESTATION_UNAVAILABLE'");
      await openSettings('General', settings);
      await until(`!!${button(refresh, formButton)}`, 'Unavailable proof exposes a retry');
      assert.equal(await run('document.querySelectorAll("dialog input").length'), 0);
      await run("window.scopedSettingsReadError = ''");
      await click(refresh, formButton);
      await until("document.querySelector('dialog textarea')?.value === 'Existing description'", 'Verified settings populate form');
      assert.equal(await run("document.querySelectorAll('dialog select').length"), 0);
      assert.equal(await run(`document.querySelector(${JSON.stringify(count)}).max`), '21600');
      await enter('dialog textarea', 'My scoped description');
      await enter(count, '21601');
      assert.equal(await run(`${button(save, formButton)}.disabled`), true);
      await enter(count, '21600');
      await until(`!!${button(save, formButton)}`, 'The current draft is ready to save');
      assert.equal(await run(`${commits}.length`), 0);
      assert.ok(await run(`(() => {
        const buttons = [...document.querySelectorAll('${formButton}')].map(node => node.getBoundingClientRect());
        const body = document.querySelector('dialog .modal-body');
        return buttons.length === 2 && Math.abs(buttons[0].top - buttons[1].top) <= 1 && body.scrollWidth <= body.clientWidth;
      })()`));

      await run("window.scopedSettingsCommitError = 'PROTECTED_POLICY_CHANGED'");
      await click(save, formButton);
      await until(`!!${button(refresh, formButton)} && document.querySelector('dialog textarea')?.value === 'My scoped description'`,
        'Policy conflict retains draft and requires new proof');
      await run(`window.scopedSettingsCommitError = '';
        window.scopedSettingsRead.policyHead = 'b'.repeat(64);
        window.scopedSettingsRead.policyRevision = 2;
        window.scopedSettingsRead.settings.name = 'New verified name';`);
      await click(refresh, formButton);
      await until(`document.querySelector(${JSON.stringify(name)})?.value === 'New verified name'`, 'Refresh adopts untouched current values');
      assert.equal(await run("document.querySelector('dialog textarea').value"), 'My scoped description');
      await click(save, formButton);
      await until(`!!${button(refresh, formButton)} && !document.querySelector('dialog textarea')`, 'Receipt awaits matching signed state');
      assert.equal(await run("document.querySelector('#server-channels .member-channel[aria-current=true], #server-channels .member-channel.selected').textContent"), 'General');
      assert.deepEqual(await run(`${commits}.at(-1)`), {
        action: 'channel.settings.protected.commit', serverId: '1'.repeat(32), channelId: '2'.repeat(32), policyHead: 'b'.repeat(64),
        settings: { name: 'New verified name', description: 'My scoped description', slowmodeSeconds: 21600, voiceCapacity: 0 },
      });
      await run("window.scopedSettingsReadError = 'POLICY_ATTESTATION_UNAVAILABLE'");
      await click(refresh, formButton);
      await until(`!${button(refresh, formButton)}.disabled`, 'Pending proof can be checked again');
      assert.equal(await run(`${commits}.length`), 2);

      if (english) {
        await run(`window.scopedSettingsReadError = '';
          window.scopedSettingsRead.policyHead = 'c'.repeat(64);
          window.scopedSettingsRead.policyRevision = 4;
          window.scopedSettingsRead.settings.description = 'Newer concurrent description';`);
        await click(refresh, formButton);
        await until("document.querySelector('dialog [role=status]')?.textContent.includes('Newer concurrent description')",
          'Later conflicting signed settings show the current values');
        assert.equal(await run("document.querySelector('dialog textarea').value"), 'My scoped description');
        await click(save, formButton);
        await until(`!!${button(refresh, formButton)}`, 'Reapplying to the newer version waits for proof again');
      }
      await run(`window.scopedSettingsReadError = '';
        window.scopedSettingsRead.policyHead = 'd'.repeat(64);
        window.scopedSettingsRead.policyRevision++;
        window.scopedSettingsRead.settings = ${commits}.at(-1).settings;
        window.publishScopedSettingsName = true;`);
      await click(refresh, formButton);
      const done = english ? 'Done' : 'Готово';
      await until(`!!${button(done, formButton)} && document.querySelector('#server-channels .member-channel[aria-current=true], #server-channels .member-channel.selected')?.textContent === 'New verified name'`,
        'Matching verified settings refresh the main projection');
      await click(done, formButton);

      await run('window.scopedSettingsRead.settings = null');
      await openSettings('Meetings', settings);
      await until(`document.querySelector(${JSON.stringify(name)})?.placeholder === 'Meetings'`, 'Migrated metadata is a hint only');
      assert.equal(await run(`!!${button(save, formButton)}`), false);
      assert.equal(await run(`document.querySelector(${JSON.stringify(count)}).max`), '4294967295');
      await enter(name, 'Meetings');
      assert.equal(await run(`${button(save, formButton)}.disabled`), false);
      const readsBeforeCommit = await run("window.scopedSettingsCalls.filter(call => call.action.endsWith('.read')).length");
      await run("window.scopedSettingsCommitConfirmed = true; window.scopedSettingsReadError = 'POLICY_ATTESTATION_UNAVAILABLE'");
      await click(save, formButton);
      await until(`!!${button(done, formButton)}`, 'A verified receipt closes the editor flow while the owner is offline');
      assert.equal(await run("window.scopedSettingsCalls.filter(call => call.action.endsWith('.read')).length"), readsBeforeCommit);
      await click(done, formButton);
    }
    console.log('Delegated protected channel settings UI passed (RU/EN).');
  } catch (error) {
    console.error(error);
    app.exit(1);
    return;
  }
  app.quit();
});
