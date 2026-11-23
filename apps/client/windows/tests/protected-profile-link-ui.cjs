const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

app.setPath('userData', join(tmpdir(), `pawtalk-profile-link-ui-${process.pid}`));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 640, height: 680,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const dialog = 'dialog[open]:not(.protected-server-settings)';
  const until = async (condition, label) => {
    for (let attempt = 0; attempt < 125; attempt++) {
      if (await run(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error(`${label}\n${await run('document.body.innerText')}`);
  };
  const button = (text, base = dialog) => `([...document.querySelectorAll(${JSON.stringify(base + ' button')})].find(element => element.textContent.trim() === ${JSON.stringify(text)}))`;
  const click = (text, base) => run(`${button(text, base)}.click()`);
  const textIncludes = text => `document.querySelector(${JSON.stringify(dialog)})?.textContent.includes(${JSON.stringify(text)})`;
  const waitText = (text, label) => until(textIncludes(text), label);
  const disabled = text => run(`${button(text)}.disabled`);
  const input = (selector, value) => run(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  })()`);
  const close = async () => {
    await run(`document.querySelector('${dialog} .modal-heading button').click()`);
    await until(`!document.querySelector('${dialog}')`, 'Dialog closes');
  };
  try {
    for (const language of ['ru', 'en']) {
      const word = (ru, en) => language === 'en' ? en : ru;
      const profileDevices = word('Профиль и устройства', 'Profile and devices');
      const serverAccess = word('Доступ к серверу', 'Server access');
      const settingsTab = async label => {
        if (!await run("!!document.querySelector('.protected-server-settings[open]')")) {
          await run("document.querySelector('.member-server-list button').click()");
          await until("!!document.querySelector('.protected-server-title')", 'Room title appears');
          const settings = word('Настройки сервера', 'Server settings');
          if (!await run(`!!${button(settings, '.member-context')}`))
            await run("document.querySelector('.protected-server-title').click()");
          await click(settings, '.member-context');
        }
        await click(label, '.protected-server-settings .settings-nav');
      };
      const expandAdditionalActions = () => run("document.querySelector('.profile-device-actions details:not([open]) summary')?.click()");
      const menu = async (label, tab = profileDevices) => {
        await settingsTab(tab);
        if (tab === profileDevices) await expandAdditionalActions();
        await until(`!!${button(label, '.protected-server-settings .settings-content')}`, 'Settings action appears');
        await click(label, '.protected-server-settings .settings-content');
      };
      await win.loadURL(`${process.env.PAWTALK_UI_TEST_URL}/tests/notifications.html?language=${language}&protected=owner`);
      await until("!!document.querySelector('.member-server-list button') && !!window.desktop?.membership", 'Room is listed');
      await run(`(() => {
        const original = window.desktop.membership;
        const local = 'a'.repeat(64), peer = 'b'.repeat(64), head = '5'.repeat(64);
        const originalSigner = 'e'.repeat(64), target = 'd'.repeat(64), expiresAt = Date.now() + 1_000_000;
        const preview = primaryIsLocal => ({ primaryProfileId: primaryIsLocal ? local : peer,
          secondaryProfileId: primaryIsLocal ? peer : local, primaryRoles: ['Readers'], secondaryRoles: ['Editors'],
          movedDevices: 2, policyHead: head, policyRevision: 3 });
        window.profileLinkCalls = [];
        window.linkedFixture = false;
        window.scopeLocal = originalSigner;
        window.scopeSigner = originalSigner;
        window.scopeCalls = [];
        window.desktop.membership = (action, input) => {
          if (action.startsWith('scope.protected.')) {
            window.scopeCalls.push({ action, input });
            if (action.endsWith('.status')) {
              const canOffer = window.scopeSigner === window.scopeLocal;
              return { value: { ownerProfileId: local, localDeviceId: window.scopeLocal, signerDeviceId: window.scopeSigner,
                canOffer, candidates: canOffer && window.scopeSigner === originalSigner ? [{ deviceId: target, originProfileId: peer }] : [] } };
            }
            if (action.endsWith('.offer')) return { value: { offerCard: 'scope-offer', expiresAt } };
            if (action.endsWith('.preview')) return { value: {
              signerDeviceId: originalSigner, targetDeviceId: input.offerCard === 'wrong-target' ? 'f'.repeat(64) : target, expiresAt,
            } };
            if (action.endsWith('.accept')) {
              window.scopeSigner = target;
              window.profileLinkHandoverRequired = false;
              return { value: { signerDeviceId: target } };
            }
            throw Error(action);
          }
          if (!action.startsWith('profile.protected.')) return original(action, input);
          window.profileLinkCalls.push({ action, input });
          if (action.endsWith('.participant')) return { value: { participantCard: 'profile-a' } };
          if (action.endsWith('.prepare')) return { value: { preview: preview(input.primaryIsLocal), linkCard: 'draft-a' } };
          if (action.endsWith('.review')) {
            if (input.linkCard === 'wrong') return { error: { code: 'INVALID_PROFILE_LINK_CARD' } };
            const primaryIsLocal = input.linkCard !== 'other-primary';
            const ready = input.linkCard === 'both-agreed';
            return { value: { preview: preview(primaryIsLocal), primaryIsLocal, ready, agreed: ready } };
          }
          if (action.endsWith('.sign')) return { value: { linkCard: input.linkCard === 'draft-a' ? 'signed-a' : 'signed-b',
            ready: input.linkCard === 'other-primary' } };
          if (action.endsWith('.apply')) {
            window.linkedFixture = true;
            return { value: { primaryProfileId: local } };
          }
          if (action.endsWith('.status')) return { value: { profileId: local, policyHead: head,
            sources: window.linkedFixture ? [peer] : [] } };
          if (action.endsWith('.unlink')) {
            if (window.profileLinkHandoverRequired) return { error: { code: 'PROTECTED_SCOPE_SIGNER_HANDOVER_REQUIRED' } };
            window.linkedFixture = false;
            return { value: { sourceProfileId: peer } };
          }
          throw Error(action);
        };
      })()`);
      const openLink = word('Объединить два существующих профиля', 'Merge two existing profiles');
      const choosePrimary = word('Выбрать основной профиль', 'Choose primary profile');
      const signApproval = word('Подписать согласие', 'Sign approval');
      const apply = word('Применить связывание', 'Apply profile link');
      const copy = word('Скопировать карточку', 'Copy card');
      const reviewCard = word('Проверить карточку', 'Verify card');
      const check = () => run("document.querySelector('dialog input[type=checkbox]').click()");
      await run(`document.querySelector('.member-server-list button').dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 75, clientY: 130,
      }))`);
      assert.deepEqual(await run("[...document.querySelectorAll('.member-context button')].map(button => button.textContent.trim())"),
        [word('Заглушить уведомления', 'Mute notifications'), word('Выйти с сервера', 'Leave server')]);
      await run("document.querySelector('.member-context button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await settingsTab(profileDevices);
      assert.equal(await run("document.querySelector('.profile-device-actions button').textContent.trim()"),
        word('Добавить новое устройство', 'Add a new device'));
      assert.equal(await run("document.querySelector('.profile-device-actions details').open"), false);
      await menu(openLink);
      await click(word('Создать карточку профиля', 'Create profile card'));
      await until("document.querySelector('dialog textarea')?.value === 'profile-a'", 'Participant card appears');
      await click(copy);
      await until("window.copied === 'profile-a'", 'Participant card copied');
      await click(choosePrimary);
      await input('dialog textarea', 'profile-b');
      const preview = word('Посмотреть последствия', 'Review changes');
      assert.equal(await disabled(preview), true);
      await input('dialog select', 'true');
      await click(preview);
      await waitText(word('Роли будут сняты: Editors', 'Roles removed: Editors'), 'Preview shows secondary roles');
      await waitText(word('Роли сохранятся: Readers', 'Roles kept: Readers'), 'Preview shows primary roles');
      await waitText(word('Устройств перейдёт в основной профиль: 2', 'Devices moving to the primary profile: 2'), 'Preview shows the device count');
      assert.equal(await disabled(signApproval), true);
      assert.equal(await run('window.profileLinkCalls.filter(call => call.action.endsWith(".sign")).length'), 0);
      await check();
      await click(signApproval);
      await until("document.querySelector('dialog textarea')?.value === 'signed-a'", 'Primary consent card appears');
      await click(copy);
      await until("window.copied === 'signed-a'", 'Primary consent card copied');
      assert.equal(await run(`!!${button(apply)}`), false);
      await click(word('Проверить другую карточку', 'Review another card'));
      await input('dialog textarea', 'wrong');
      await click(reviewCard);
      await waitText(word('Проверьте, что карточка вставлена целиком', 'Check that you pasted the entire card'), 'Invalid card is rejected');
      await input('dialog textarea', 'both-agreed');
      await click(reviewCard);
      await until(`!!${button(apply)}`, 'Primary can apply both consents');
      const centers = await run(`([...document.querySelectorAll('dialog .modal-actions button')].map(node => {
        const box = node.getBoundingClientRect(); return box.y + box.height / 2;
      }))`);
      assert.ok(Math.max(...centers) - Math.min(...centers) < 1);
      await click(apply);
      await waitText(word('Профили связаны.', 'Profiles are linked.'), 'Link completes');
      await close();

      await menu(openLink);
      await click(word('Проверить карточку связывания', 'Review profile link card'));
      await input('dialog textarea', 'other-primary');
      await click(reviewCard);
      await until(`!!${button(signApproval)}`, 'Secondary reviews transferred permissions');
      assert.equal(await disabled(signApproval), true);
      await check();
      await click(signApproval);
      await until("document.querySelector('dialog textarea')?.value === 'signed-b'", 'Secondary consent is ready to send');
      assert.equal(await run(`!!${button(apply)}`), false);
      await close();

      await menu(word('Связанные профили', 'Linked profiles'));
      const unlink = word('Отвязать профиль', 'Unlink profile');
      const row = word('Отвязать', 'Unlink');
      await until(`!!${button(row)}`, 'Linked profile appears');
      await click(row);
      await waitText(word('Прежние роли и членство не восстановятся.', 'Its previous roles and membership will stay removed.'), 'Unlink shows irreversible access changes');
      assert.equal(await disabled(unlink), true);
      await check();
      await run('window.profileLinkHandoverRequired = true');
      await click(unlink);
      await waitText(word('Сначала передайте подпись поканальных подтверждений', 'First transfer authority to sign channel attestations'),
        'Current attester must be handed over before unlink');
      assert.equal(await run('window.linkedFixture'), true);
      await click(word('Открыть передачу подписи', 'Open signing transfer'));
      await waitText(word('Устройство, которое примет подпись', 'Device to receive signing authority'), 'Blocked unlink opens owner transfer');
      const createTransfer = word('Создать карточку передачи', 'Create transfer card');
      assert.equal(await disabled(createTransfer), true);
      await input('dialog select', 'd'.repeat(64));
      await click(createTransfer);
      await until("document.querySelector('dialog textarea')?.value === 'scope-offer'", 'Offer card appears');
      assert.deepEqual(await run("window.scopeCalls.find(call => call.action.endsWith('.offer')).input"), {
        serverId: '1'.repeat(32), targetDeviceId: 'd'.repeat(64),
      });
      await click(copy);
      await until("window.copied === 'scope-offer'", 'Signing transfer card copied');
      assert.equal(await run("window.scopeCalls.filter(call => call.action.endsWith('.accept')).length"), 0);
      await close();

      await run("window.scopeLocal = 'd'.repeat(64)");
      await menu(word('Передать подпись подтверждений', 'Transfer attestation signing'), serverAccess);
      await waitText(word('Получите карточку передачи', 'Get a transfer card'), 'Other device can receive a card');
      await input('dialog textarea', 'wrong-target');
      await click(reviewCard);
      await waitText(word('Карточка передачи подписи не подходит', 'The signing transfer card does not match'), 'Recipient mismatch is rejected');
      await input('dialog textarea', 'scope-offer');
      await click(reviewCard);
      const acceptSigning = word('Принять подпись', 'Accept signing authority');
      await until(`!!${button(acceptSigning)}`, 'Receiving device previews the offer');
      assert.equal(await disabled(acceptSigning), true);
      assert.equal(await run("window.scopeCalls.filter(call => call.action.endsWith('.accept')).length"), 0);
      await check();
      const scopeCenters = await run(`([...document.querySelectorAll('dialog .modal-actions button')].map(node => {
        const box = node.getBoundingClientRect(); return box.y + box.height / 2;
      }))`);
      assert.ok(Math.max(...scopeCenters) - Math.min(...scopeCenters) < 1);
      await click(acceptSigning);
      await waitText(word('Это устройство теперь подписывает', 'This device now signs'), 'Owner device accepts signing authority');
      assert.deepEqual(await run("window.scopeCalls.find(call => call.action.endsWith('.accept')).input"), {
        serverId: '1'.repeat(32), offerCard: 'scope-offer',
      });
      await close();

      await menu(word('Связанные профили', 'Linked profiles'));
      await until(`!!${button(row)}`, 'Linked profile can be selected again after handover');
      await click(row);
      await check();
      await click(unlink);
      await waitText(word('Профиль отвязан.', 'Profile unlinked.'), 'Unlink completes');
      assert.deepEqual(await run(`window.profileLinkCalls.find(call => call.action.endsWith('.unlink')).input`), {
        serverId: '1'.repeat(32), sourceProfileId: 'b'.repeat(64), policyHead: '5'.repeat(64),
      });
      const applications = await run("window.profileLinkCalls.filter(call => call.action.endsWith('.apply')).map(call => call.input.linkCard)");
      assert.deepEqual(applications, ['both-agreed']);
      for (const scope of ['history', 'administrator']) {
        await win.loadURL(`${process.env.PAWTALK_UI_TEST_URL}/tests/notifications.html?language=${language}&protected=${scope}`);
        await until("!!document.querySelector('.member-server-list button')", 'Non-owner room is listed');
        if (scope === 'administrator') {
          await run("document.querySelector('.member-server-list button').click()");
          await until("!!document.querySelector('.protected-server-title')", 'Administrator can open the server menu');
          await run("document.querySelector('.protected-server-title').click()");
          await until(`!!${button(word('Создать категорию', 'Create category'), '.member-context')}`, 'Administrator can create categories');
        }
        await settingsTab(profileDevices);
        await expandAdditionalActions();
        await until(`!!${button(openLink, '.protected-server-settings .settings-content')}`, 'Non-owner can link profiles');
        await settingsTab(serverAccess);
        assert.equal(await run(`!!${button(word('Передать подпись подтверждений', 'Transfer attestation signing'), '.protected-server-settings .settings-content')}`), false);
      }
      await win.loadURL(`${process.env.PAWTALK_UI_TEST_URL}/tests/notifications.html?language=${language}&protected=inviter`);
      await until("window.protectedAlertPolls > 0 && !!document.querySelector('.member-server-list button')", 'Invitation issuer is ready');
      await run("document.querySelector('.member-server-list button').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))");
      assert.deepEqual(await run("[...document.querySelectorAll('.member-context button')].map(button => button.textContent.trim())"),
        [word('Заглушить уведомления', 'Mute notifications'), word('Приглашения', 'Invitations'), word('Выйти с сервера', 'Leave server')]);
      await run("document.querySelector('.member-context button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await settingsTab(serverAccess);
      const changeAddress = word('Изменить адрес сервера', 'Change server address');
      assert.ok(await run(`!!${button(changeAddress, '.protected-server-settings .settings-content')}`));
      await run("document.querySelector('.protected-server-settings .modal-heading button').click(); window.setConnected(false)");
      await until("!!document.querySelector('.member-server-list .member-status.offline')", 'Saved server becomes unavailable');
      await run("document.querySelector('.member-server-list button').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))");
      await click(changeAddress, '.member-context');
      await until("!!document.querySelector('dialog[open] input[required]')", 'Offline address dialog opens from the saved server icon');
      console.log(`PASS protected profile linking and signing handover renderer (${language})`);
    }
  } finally {
    win.destroy();
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
