// Capture the real main/preload/renderer in an isolated profile and demo room.
// Run after npm run build: electron scripts/capture-docs.cjs
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { X509Certificate, createHash, randomBytes } = require('node:crypto');
const { invitation } = require('../electron/address.cjs');
app.setPath('userData', path.join(os.tmpdir(), 'pawtalk-docs-' + process.pid));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
delete process.env.PAWTALK_DEV_URL;
process.argv.push('--smoke', '--offscreen-smoke');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await wait(100);
  }
  throw new Error('Timed out waiting for ' + label);
}

function demoRequest(origin, fingerprint, endpoint, body, token) {
  return new Promise((resolve, reject) => {
    const request = https.request(origin + endpoint, {
      method: body === undefined ? 'GET' : 'POST', rejectUnauthorized: false, agent: false,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(endpoint + ' returned ' + response.statusCode));
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    });
    request.on('socket', socket => socket.once('secureConnect', () => {
      if (socket.getPeerX509Certificate()?.fingerprint256.replaceAll(':', '').toLowerCase() !== fingerprint) {
        request.destroy(new Error('Unexpected demo server certificate'));
      }
    }));
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('Demo server request timed out')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

let handled = false;
app.on('browser-window-created', (_event, win) => {
  if (handled) return;
  handled = true;
  win.setContentSize(1240, 860);
  win.webContents.once('did-finish-load', async () => {
    const run = source => win.webContents.executeJavaScript(`(async () => {
      try { return await (${source}); } catch (error) { console.error(error.stack); throw error; }
    })()`);
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('renderer:', event.message); });
    const click = text => run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith(${JSON.stringify(text)})).click()`);
    let vite, exitCode = 0;
    const guests = [];
    try {
      const output = process.env.PAWTALK_CAPTURE_DIR ? path.resolve(process.env.PAWTALK_CAPTURE_DIR) : path.resolve(__dirname, '../website/assets');
      await fs.mkdir(output, { recursive: true });
      for (let i = 0; i < 80 && !await run(`!!document.querySelector('.home-actions')`); i++) await wait(100);
      await wait(400);
      // Avoid registering shortcuts already used by the user's running client.
      await run(`localStorage.setItem('pawtalk.settings', JSON.stringify({muteKey:'',deafenKey:''}))`);
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.reload(); });
      for (let i = 0; i < 80 && !await run(`!!document.querySelector('.home-actions')`); i++) await wait(100);
      assert.equal(await run('window.desktop.pendingInvitation()'), '', 'no live invitation');
      assert.equal((await run('window.desktop.hostStatus()')).running, false, 'no room started');
      assert.equal((await run('window.desktop.capabilities()')).native, true, 'real native module');
      const capture = async name => {
        await wait(400);
        assert.deepEqual(await run(`Array.from(document.querySelectorAll('[role="alert"]')).map(el=>el.textContent)`), []);
        await fs.writeFile(path.join(output, name), (await win.webContents.capturePage()).toPNG());
      };
      for (const language of ['ru', 'en']) {
        await run(`window.desktop.setLanguage(${JSON.stringify(language)})`);
        await run(`localStorage.setItem('pawtalk.nickname',${JSON.stringify(language === 'en' ? 'Guest' : 'Гость')})`);
        await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.reload(); });
        for (let i = 0; i < 80 && !await run(`!!document.querySelector('.home-actions')`); i++) await wait(100);
        const suffix = language === 'en' ? '-en' : '';
        const create = language === 'en' ? 'Create a room' : 'Создать комнату';
        const settings = language === 'en' ? 'Settings' : 'Настройки';
        const close = language === 'en' ? 'Close' : 'Закрыть';
        const test = language === 'en' ? 'Test microphone' : 'Проверка микрофона';
        await capture(`home${suffix}.png`);
        await click(create);
        await capture(`create-room${suffix}.png`);
        await run(`document.querySelector('dialog [aria-label=${JSON.stringify(close)}]').click()`);
        await run(`document.querySelector('[title=${JSON.stringify(settings)}]').click()`);
        await run(`document.querySelector('#settings-tab-language').click()`);
        await capture(`language-settings${suffix}.png`);
        await run(`document.querySelector('#settings-tab-voice').click()`);
        for (let i = 0; i < 80 && !await run(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(test)}&&!b.disabled)`); i++) await wait(100);
        assert.equal(await run(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(test)}&&!b.disabled)`), true);
        await run(`document.querySelector('.voice-settings').scrollIntoView({block:'start'})`);
        await capture(`audio-settings${suffix}.png`);
        await run(`document.querySelector('#settings-tab-sounds').click()`);
        await wait(800);
        await capture(`sound-settings${suffix}.png`);
        await run(`document.querySelector('#settings-tab-profile').click()`);
        const avatarFile = path.join(app.getPath('userData'), 'demo-avatar.png');
        const png = await run(`(() => {
          const canvas = document.createElement('canvas');
          canvas.width = 360; canvas.height = 256;
          const ctx = canvas.getContext('2d');
          const sky = ctx.createLinearGradient(0, 0, 0, 256);
          sky.addColorStop(0, '#332456'); sky.addColorStop(1, '#a75684');
          ctx.fillStyle = sky; ctx.fillRect(0, 0, 360, 256);
          ctx.fillStyle = '#ffcb92'; ctx.beginPath(); ctx.arc(192, 101, 42, 0, Math.PI * 2); ctx.fill();
          for (const [color, points] of [
            ['#514379', [[0,219],[103,138],[157,187],[216,128],[360,223]]],
            ['#27234e', [[0,225],[76,197],[153,217],[250,166],[360,222]]],
          ]) {
            ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0,256);
            for (const point of points) ctx.lineTo(...point);
            ctx.lineTo(360,256); ctx.fill();
          }
          return canvas.toDataURL().split(',')[1];
        })()`);
        await fs.writeFile(avatarFile, Buffer.from(png, 'base64'));
        const devtools = win.webContents.debugger;
        devtools.attach('1.3');
        try {
          const { root } = await devtools.sendCommand('DOM.getDocument');
          const { nodeId } = await devtools.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '.profile-avatar input[type=file]' });
          await devtools.sendCommand('DOM.setFileInputFiles', { nodeId, files: [avatarFile] });
        } finally { devtools.detach(); }
        await until(() => run('!!document.querySelector(".avatar-crop-preview")'), 'avatar crop');
        assert.equal(await run('getComputedStyle(document.querySelector(".avatar-crop-preview")).borderRadius'), '50%');
        await capture(`avatar-crop${suffix}.png`);
        await run(`document.querySelector('.avatar-editor .primary').click()`);
        await until(() => run('!document.querySelector(".avatar-editor")'), 'saved avatar');
        await run(`document.querySelector('.settings-modal [aria-label=${JSON.stringify(close)}]').click()`);
        const demo = language === 'en' ? {
          room: 'Weekend lobby', names: ['Maya', 'Alex'],
          messages: ['I’ve set up a private lobby for tonight.', 'Nice! I’ll be ready in five.', 'I’m in. Let’s start with a warm-up round.'],
        } : {
          room: 'Вечерняя комната', names: ['Майя', 'Алекс'],
          messages: ['Я создала закрытое лобби на вечер.', 'Отлично! Буду готов через пять минут.', 'Я уже здесь. Начнём с разминочного раунда.'],
        };
        const password = randomBytes(18).toString('base64url');
        await click(create);
        await until(() => run('!!document.querySelector("dialog[open] .encryption-toggle")'), 'room creation form');
        await run(`(() => {
          const form = document.querySelector('dialog[open] form');
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          for (const [index, value] of ${JSON.stringify([[0, demo.room], [1, password], [2, '36443']])}) {
            const field = form.querySelectorAll('input')[index];
            set.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true }));
          }
          if (!${process.env.PAWTALK_CHAT_ACCEPTANCE === '1' && language === 'en'}) document.querySelector('.encryption-toggle input').click();
        })()`);
        if (process.env.PAWTALK_CHAT_ACCEPTANCE === '1') await run(`(()=>{
          window.sawConnectionLoading=false;
          const observer=new MutationObserver(()=>{ if(document.querySelector('.connection-loading[open] [role="status"]')) { window.sawConnectionLoading=true;observer.disconnect(); } });
          observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
        })()`);
        await run(`document.querySelector('dialog[open] form').requestSubmit()`);
        await until(() => run('!!document.querySelector(".room-content dialog[open] .host-stop") && !!document.querySelector(".chat-compose")'), 'demo room and invitation');
        if (process.env.PAWTALK_CHAT_ACCEPTANCE === '1') {
          assert.equal(await run('window.sawConnectionLoading'), true, 'connection shows a loading dialog');
          assert.equal(await run('!!document.querySelector(".connection-loading")'), false, 'loading closes after connection');
        }
        await run(`document.querySelector('dialog [aria-label=${JSON.stringify(close)}]').click()`);
        const status = await run('window.desktop.hostStatus()');
        const { origin, e2eeKey } = invitation(status.localAddress);
        if (!vite) {
          const { createServer } = await import('vite');
          vite = await createServer({ server: { host: '127.0.0.1', port: 0 } });
          await vite.listen();
        }
        const guestSession = session.fromPartition('docs-demo-' + language + '-' + process.pid);
        guestSession.setPermissionRequestHandler((_win, _permission, done) => done(true));
        guestSession.setPermissionCheckHandler(() => true);
        guestSession.setCertificateVerifyProc((request, callback) => {
          callback(new X509Certificate(request.certificate.data).fingerprint256.replaceAll(':', '').toLowerCase() === status.fingerprint ? 0 : -3);
        });
        const { chatKey, encryptChat, decryptChat } = await import('../src/chat.ts');
        let reader;
        const e2eeKeyId = e2eeKey ? createHash('sha256').update(Buffer.from(e2eeKey, 'hex')).digest('hex') : undefined;
        for (const [index, nickname] of demo.names.entries()) {
          const credentials = await demoRequest(origin, status.fingerprint, '/api/connect', { nickname, password, e2ee: !!e2eeKey, e2eeKeyId });
          reader = credentials;
          const guest = new BrowserWindow({ show: false, webPreferences: { session: guestSession, sandbox: true, offscreen: true, backgroundThrottling: false } });
          guests.push(guest);
          await guest.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/tests/voice.html`);
          await until(() => guest.webContents.executeJavaScript('window.ready === true'), 'demo guest');
          await guest.webContents.executeJavaScript(`window.start(${JSON.stringify({ ...credentials, e2eeKey })})`);
          await guest.webContents.executeJavaScript('window.voice.setMute(true, false)');
          const packet = await encryptChat(e2eeKey ? await chatKey(e2eeKey, credentials.chatFeed) : undefined, demo.messages[index]);
          await demoRequest(origin, status.fingerprint, '/api/chat', packet, credentials.chatToken);
        }
        await win.webContents.insertText(demo.messages[2]);
        await run(`document.querySelector('.chat-composer').requestSubmit()`);
        await until(() => run('document.querySelectorAll(".person-card").length === 3 && document.querySelectorAll(".chat-message").length === 3'), 'demo chat');
        assert.equal(await run('document.querySelectorAll("dialog[open]").length'), 0, 'no invitation is visible in the capture');
        await capture(`room-chat${suffix}.png`);
        if (process.env.PAWTALK_CHAT_ACCEPTANCE === '1') {
          await run(`(async()=>{
            const canvas=document.createElement('canvas');canvas.width=420;canvas.height=220;
            const context=canvas.getContext('2d');context.fillStyle='#486b85';context.fillRect(0,0,420,220);
            context.fillStyle='#dfba8f';context.beginPath();context.arc(300,70,30,0,Math.PI*2);context.fill();
            const mime=${JSON.stringify(language === 'en' ? 'image/webp' : 'image/png')};
            const blob=await new Promise(resolve=>canvas.toBlob(resolve,mime));
            const transfer=new DataTransfer();transfer.items.add(new File([blob],'local-acceptance.'+(mime==='image/webp'?'webp':'png'),{type:mime}));
            document.querySelector('.chat-composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
          })()`);
          await until(() => run('!!document.querySelector(".chat-attachment-draft")'), 'image draft through actual app');
          await run(`document.querySelector('.chat-composer').requestSubmit()`);
          await until(() => run('document.querySelector(".chat-image img")?.naturalWidth===420'), 'image upload and authenticated download through actual IPC and server');
          assert.ok(await run('document.querySelector(".chat-image img").src.startsWith("blob:")'));
          await capture(`room-image${suffix}.png`);
          await run(`document.querySelector('.chat-image-open').click()`);
          await until(() => run('!!document.querySelector(".image-viewer")'), 'actual image viewer');
          const { dialog, clipboard, ClipboardItem, nativeImage } = require('electron');
          const saveDialog = dialog.showSaveDialog;
          const clipboardBefore = await require('./clipboard-snapshot.cjs').snapshotClipboard(clipboard, ClipboardItem);
          const savedImage = path.join(output, `saved-attachment${suffix}.${language === 'en' ? 'webp' : 'png'}`);
          await fs.unlink(savedImage).catch(() => {});
          for (const mime of ['image/jpeg', 'image/webp']) {
            const bytes = await run(`(async()=>{const img=document.querySelector('.image-stage img');const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;canvas.getContext('2d').drawImage(img,0,0);const blob=await new Promise(resolve=>canvas.toBlob(resolve,${JSON.stringify(mime)}));return [...new Uint8Array(await blob.arrayBuffer())]})()`);
            const decoded = await require('../electron/image-actions.cjs').readImage({ bytes: Buffer.from(bytes), name: 'image' });
            assert.equal(decoded.extension, mime === 'image/jpeg' ? 'jpg' : 'webp', mime + ' original format is preserved');
          }
          try {
            dialog.showSaveDialog = async () => ({ canceled: false, filePath: savedImage });
            await run(`document.querySelectorAll('.image-toolbar button')[3].click()`);
            await until(async () => { try { return (await fs.stat(savedImage)).size > 0; } catch { return false; } }, 'native save image IPC');
            const savedMetadata = (await import('../shared/image.mjs')).inspectImage(await fs.readFile(savedImage));
            assert.equal(savedMetadata.width, 420); assert.equal(savedMetadata.height, 220);
            await until(() => run(`!document.querySelectorAll('.image-toolbar button')[4].disabled`), 'save finished');
            await run(`document.querySelectorAll('.image-toolbar button')[4].click()`);
            await until(() => run(`document.querySelector('.image-action-status').textContent===${JSON.stringify(language === 'en' ? 'Image copied' : 'Изображение скопировано')}`), 'actual system clipboard write');
            const items = await clipboard.read();
            const item = items.find(item => item.types.includes('image/png'));
            assert.ok(item, 'system clipboard contains an image');
            const blob = await item.getType('image/png');
            assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())).getSize(), { width: 420, height: 220 });
          } finally { dialog.showSaveDialog = saveDialog; if (clipboardBefore.length) await clipboard.write(clipboardBefore); else clipboard.clear(); }
          await run(`document.querySelector('.image-viewer [aria-label=${JSON.stringify(close)}]').click()`);
          await run(`document.querySelectorAll('.chat-message-more')[0].click()`);
          await until(() => run('!!document.querySelector(".chat-message-menu")'), 'actual reply menu');
          await run(`document.querySelector('.chat-message-menu button').click()`);
          await win.webContents.insertText(language === 'en' ? 'Reply from the real app.' : 'Ответ из настоящего приложения.');
          await run(`document.querySelector('.chat-composer').requestSubmit()`);
          await until(() => run('!!document.querySelector(".chat-reply-quote")'), 'reply saved through actual IPC and server');
          await wait(200);
          const editedKey = await run(`Array.from(document.querySelectorAll('[data-message-key]')).at(-1).dataset.messageKey`);
          await run(`Array.from(document.querySelectorAll('.chat-message-more')).at(-1).click()`);
          const editLabel = language === 'en' ? 'Edit' : 'Редактировать';
          await until(() => run(`Array.from(document.querySelectorAll('.chat-message-menu button')).some(b=>b.textContent===${JSON.stringify(editLabel)})`), 'own edit menu through main');
          await run(`Array.from(document.querySelectorAll('.chat-message-menu button')).find(b=>b.textContent===${JSON.stringify(editLabel)}).click()`);
          await until(() => run(`!!document.querySelector('.chat-inline-edit textarea')`), 'inline editor');
          await run(`(()=>{document.querySelector('.chat-inline-edit textarea').focus();document.querySelector('.chat-inline-edit textarea').select()})()`);
          await win.webContents.insertText('**Edited through actual IPC**');
          await run(`document.querySelector('.chat-inline-edit').requestSubmit()`);
          await until(() => run(`Array.from(document.querySelectorAll('.chat-message-body p strong')).some(b=>b.textContent==='Edited through actual IPC') && !document.querySelector('dialog[open]')`), 'saved formatted edit');
          const history = await demoRequest(origin, status.fingerprint, '/api/chat?after=0', undefined, reader.chatToken);
          const editedRecord = history.messages.find(message => message.requestId === editedKey);
          const decodedEdit = await decryptChat(e2eeKey ? await chatKey(e2eeKey, reader.chatFeed) : undefined, editedRecord);
          assert.equal(decodedEdit.text,'**Edited through actual IPC**');
          assert.equal(decodedEdit.edited,true); assert.ok(decodedEdit.reply,'edit preserves the reply');
          await wait(200);
          await run(`Array.from(document.querySelectorAll('.chat-message-more')).at(-1).click()`);
          const deleteLabel = language === 'en' ? 'Delete message' : 'Удалить сообщение';
          await until(() => run(`Array.from(document.querySelectorAll('.chat-message-menu button')).some(b=>b.textContent===${JSON.stringify(deleteLabel)})`), 'own delete menu');
          await run(`Array.from(document.querySelectorAll('.chat-message-menu button')).find(b=>b.textContent===${JSON.stringify(deleteLabel)}).click()`);
          await until(() => run(`!!document.querySelector('dialog[open] .modal-actions')`), 'delete confirmation');
          await run(`document.querySelector('dialog .chat-delete-confirm').click()`);
          await until(() => run(`!document.querySelector('[data-message-key="${editedKey}"]') && !document.querySelector('dialog[open]')`), 'delete through main');
          const afterDelete = await demoRequest(origin, status.fingerprint, '/api/chat?after=0', undefined, reader.chatToken);
          assert.ok(!afterDelete.messages.some(message=>message.requestId===editedKey),'deleted message is absent for another client');
        }
        while (guests.length) guests.pop().destroy();
        await run('window.desktop.stopHost()');
        await until(() => run('!!document.querySelector(".home-actions")'), 'return to lobby');
      }
      console.log('PASS: bilingual app screenshots with a temporary E2EE room and demo profiles.');
    } catch (error) {
      console.error(error);
      exitCode = 1;
    } finally {
      while (guests.length) guests.pop().destroy();
      await vite?.close();
      await run('window.desktop.stopHost()').catch(() => {});
      app.exit(exitCode);
    }
  });
});
require('../electron/main.cjs');
