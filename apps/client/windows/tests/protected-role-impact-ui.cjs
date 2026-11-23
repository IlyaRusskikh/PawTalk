const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

app.setPath('userData', join(tmpdir(), `pawtalk-role-impact-ui-${process.pid}`));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 760, height: 690,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code, true);
  const until = async (condition, label) => {
    for (let attempt = 0; attempt < 125; attempt++) {
      if (await run(condition)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error(`${label}\n${await run('document.body.innerText')}`);
  };
  const click = (text, selector = 'dialog button') => run(
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`);

  try {
    for (const language of ['ru', 'en']) {
      const word = (ru, en) => language === 'en' ? en : ru;
      await win.loadURL(`${process.env.PAWTALK_UI_TEST_URL}/tests/notifications.html?language=${language}&protected=owner`);
      await until("!!document.querySelector('.member-server-list button')", 'Protected room listed');
      await run("document.querySelector('.member-server-list button').click()");
      await until("document.querySelector('#server-channels .member-channel[aria-current=true], #server-channels .member-channel.selected')?.textContent === 'General'", 'Protected channel appears');
      await run(`(() => {
        const membership = window.desktop.membership;
        window.desktop.membership = async (action, input) => {
          const result = await membership(action, input);
          if (action !== 'role.protected.preview') return result;
          return { value: { ...result.value, impact: { keyChannels: 1, changedChannels: 1,
            administrator: { added: 0, ready: 0, removed: 0 }, details: [{ id: 'a'.repeat(32), name: 'Restricted',
              beforeView: 1, afterView: 2, beforeHistory: 0, afterHistory: 0,
              example: { profile: { id: 'b'.repeat(64), name: 'Friend' }, removedDeny: true,
                before: { decision: 'channel_restricted', permission: 'channel.view',
                  sources: [{ kind: 'category', roleId: 'member', roleName: 'Legacy name', effect: 'deny' }] },
                after: { decision: 'allowed', permission: 'channel.view',
                  sources: [{ kind: 'base', roleId: '@everyone', effect: 'allow' }] },
              },
            }],
          } } };
        };
      })()`);
      await click(word('Роли', 'Roles'), '.member-toolbar button');
      await until("!!document.querySelector('dialog option[value=member]')", 'Role editor loads');
      await run(`(() => { const select = document.querySelector('dialog select'); select.value = 'member';
        select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await run(`[...document.querySelectorAll('dialog details')].find(section =>
        section.querySelector('summary').textContent === ${JSON.stringify(word('Расширенные права', 'Advanced permissions'))}).open = true`);
      await run(`([...document.querySelectorAll('dialog label.toggle-row')]
        .find(row => row.querySelector('strong').textContent === ${JSON.stringify(word('Администратор', 'Administrator'))}))
        .querySelector('input').click()`);
      await until(`Array.from(document.querySelectorAll('dialog [role=status]')).some(item => item.textContent.includes(${JSON.stringify(
        word('Для новых назначений нужно настроить восстановление доступа', 'Members must set up recovery before gaining Administrator'))}))`,
      'Administrator explains broad access and recovery requirement');
      await click(word('Удалить роль', 'Delete role'));
      const dialog = await run("document.querySelector('dialog').innerText");
      assert.ok(dialog.includes('Restricted'));
      assert.ok(dialog.includes(word('Участники с доступом к каналу: 1 → 2', 'Members with channel access: 1 → 2')));
      assert.ok(dialog.includes(word('Удаление запрета роли откроет доступ.', 'Removing the role’s deny rule will grant access.')));
      assert.ok(dialog.includes(word('Правило категории · Legacy name · Запрещено', 'Category rule · Legacy name · Denied')));
      assert.ok(dialog.includes(word('Право из роли · Все участники · Разрешено', 'Role permission · All participants · Allowed')));
      assert.equal(await run('window.protectedChanges.length'), 0, 'Role is not changed by preview');
      const bounds = await run(`(() => {
        const buttons = [...document.querySelectorAll('dialog .modal-actions button')];
        const centers = buttons.map(button => { const r = button.getBoundingClientRect(); return r.top + r.height / 2; });
        const body = document.querySelector('dialog .modal-body');
        return { centers, fits: body.scrollWidth <= body.clientWidth };
      })()`);
      assert.ok(bounds.fits && Math.max(...bounds.centers) - Math.min(...bounds.centers) < 1);
      console.log(`PASS protected role impact renderer (${language})`);
    }
  } finally {
    win.destroy();
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
