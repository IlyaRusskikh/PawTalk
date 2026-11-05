const { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, powerMonitor, globalShortcut, net, safeStorage, clipboard } = require('electron');
const path = require('node:path');
const { localInvitation, verifyInvitation, connectionError } = require('./connection.cjs');
const { X509Certificate, createHash } = require('node:crypto');
const { serverURL, invitation } = require('./address.cjs');
const { diagnosticCommand } = require('./diagnostic-command.cjs');
const { SelfHost } = require('./selfhost.cjs');
const { HostCheck } = require('./host-check.cjs');
const { CredentialStore } = require('./credentials.cjs');
let credentials;
let pendingInvitation = '';
function acceptInvitation(args) {
  for (const address of args) {
    try {
      if (address.length <= 14000 && invitation(address)) {
        pendingInvitation = address.trim();
        send('invitation', pendingInvitation);
        break;
      }
    } catch { /* Ignore malformed external protocol arguments. */ }
  }
}
let hosting;
const hostCheck = new HostCheck(app.isPackaged ? path.join(process.resourcesPath, 'diagnostics/check-selfhost.ps1') : path.join(__dirname, '../scripts/check-selfhost.ps1'));
const certificatePins = new Map();
function trustInvitation(address) {
  const room = invitation(address);
  if (room) certificatePins.set(room.hostname, room.fingerprint);
}
function credentialKey(address) { return invitation(address) ? address.trim().split('#')[0] : serverURL(address, !app.isPackaged); }
function certificateFingerprint(certificate) {
  try { return new X509Certificate(certificate.data).fingerprint256.replace(/:/g, '').toLowerCase(); } catch { return ''; }
}
let win, tray, native, quitting = false, duckTimer;
let keyConfig = { ptt: 0x05, mute: '', deafen: '' };
try { native = require(app.isPackaged ? path.join(process.resourcesPath, 'voicecord.node') : '../native/build/Release/voicecord.node'); } catch {}
const devURL = process.env.VOICECORD_DEV_URL;
if (devURL && devURL !== 'http://127.0.0.1:5173') throw new Error('Invalid development URL');
function send(name, value) { if (win && !win.isDestroyed()) win.webContents.send(name, value); }
function restoreAudio() { clearTimeout(duckTimer); try { native?.setDucking(1); } catch {} }
function authorized(event) {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Unauthorized IPC');
}
function registerIPC() {
  ipcMain.handle('connection-diagnose', async (event, address) => {
    authorized(event);
    try {
      const base = serverURL(address, !app.isPackaged);
      const effective = invitation(address) ? localInvitation(address, hosting.status()) : address;
      const target = serverURL(effective, !app.isPackaged);
      await verifyInvitation(effective);
      trustInvitation(effective);
      for (const endpoint of invitation(effective) ? ['/healthz', '/rtc'] : ['/healthz']) {
        const response = await net.fetch(`${target}${endpoint}`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
        await response.body?.cancel();
        if (!response.ok) return { ok: false, message: `${endpoint === '/rtc' ? 'Голосовой сервер' : 'Сервер комнаты'} ответил HTTP ${response.status}. Проверьте запуск сервера и порт в приглашении.` };
      }
      const policyResponse = await net.fetch(`${target}/api/config`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      const policy = policyResponse.ok ? await policyResponse.json() : {};
      return { ok: true, e2eeRequired: policy.e2eeRequired === true, message: effective !== address
        ? 'Ваша комната доступна напрямую на этом компьютере. При подключении будет использован локальный адрес. Доступность для друга через интернет ещё не проверена.'
        : `Сервер ${new URL(base).host} доступен, защищённое соединение${invitation(effective) ? ', сертификат приглашения и голосовой сервер' : ''} проверены. Пароль и передача голоса проверяются при подключении. Это проверка из вашей текущей сети.` };
    } catch (error) { return { ok: false, message: connectionError(error) }; }
  });
  ipcMain.handle('diagnostic-command-copy', (event, address) => {
    authorized(event);
    if (typeof address !== 'string' || address.length > 14000) throw new Error('Неверное приглашение');
    clipboard.writeText(diagnosticCommand(address));
  });
  ipcMain.handle('invitation-copy', (event, address) => {
    authorized(event);
    if (typeof address !== 'string' || address.length > 14000 || !invitation(address)) throw new Error('Неверное приглашение');
    return clipboard.writeText(address);
  });
  ipcMain.handle('invitation-pending', event => { authorized(event); return pendingInvitation; });
  ipcMain.handle('host-status', event => { authorized(event); return hosting.status(); });
  ipcMain.handle('host-check', (event, port) => {
    authorized(event);
    if (hosting.status().running || hosting.starting || hosting.stopping) throw new Error('Закройте комнату перед проверкой сети.');
    return hostCheck.start(port);
  });
  ipcMain.handle('host-check-cancel', event => { authorized(event); return hostCheck.cancel(); });
  ipcMain.handle('host-start', async (event, input) => {
    authorized(event);
    if (hostCheck.running) throw new Error('Дождитесь завершения проверки сети.');
    const result = await hosting.start(input);
    trustInvitation(result.localAddress);
    return result;
  });
  ipcMain.handle('host-stop', async event => { authorized(event); if (hosting.starting) throw new Error('Дождитесь запуска комнаты'); await hosting.stop(); });
  ipcMain.handle('capabilities', async (event) => { authorized(event); return { native: !!native, platform: process.platform, packaged: app.isPackaged, secureStorage: await safeStorage.isAsyncEncryptionAvailable() }; });
  ipcMain.handle('credentials-load', async (event, address) => {
    authorized(event);
    return { password: await credentials.load(credentialKey(address)), e2eeKey: await credentials.load('e2ee:' + credentialKey(address)) };
  });
  ipcMain.handle('credentials-save', async (event, input) => {
    authorized(event);
    if (!input || (input.password !== null && (typeof input.password !== 'string' || input.password.length > 1024))) throw new Error('Неверный пароль');
    if (input.e2eeKey != null && (typeof input.e2eeKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.e2eeKey))) throw new Error('Неверный ключ E2EE');
    await credentials.save(credentialKey(input.address), input.password);
    if ('e2eeKey' in input || input.password === null) await credentials.save('e2ee:' + credentialKey(input.address), input.password === null ? null : input.e2eeKey ?? null);
  });
  ipcMain.handle('connect', async (event, input) => {
    authorized(event);
    if (!input || typeof input.nickname !== 'string' || typeof input.password !== 'string' || input.nickname.length > 64 || input.password.length > 1024) throw new Error('Неверные параметры подключения');
    const address = app.isPackaged || invitation(input.address) ? localInvitation(input.address, hosting.status()) : input.address;
    const base = serverURL(address, !app.isPackaged);
    try {
      const e2eeKey = invitation(input.address)?.e2eeKey ?? input.e2eeKey;
      if (e2eeKey != null && !/^[a-f0-9]{64}$/.test(e2eeKey)) return { error: 'Неверный ключ E2EE.' };
      await verifyInvitation(address);
      trustInvitation(address);
      const response = await net.fetch(`${base}/api/connect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ nickname: input.nickname, password: invitation(input.address)?.password ?? input.password, ...(e2eeKey ? { e2ee: true, e2eeKeyId: createHash('sha256').update(Buffer.from(e2eeKey, 'hex')).digest('hex') } : {}) }), signal: AbortSignal.timeout(12000),
      });
      if (Number(response.headers.get('content-length') || 0) > 16384) throw new Error('Некорректный ответ сервера');
      const raw = await response.text(); if (raw.length > 16384) throw new Error('Некорректный ответ сервера');
      const body = JSON.parse(raw);
      if (!response.ok) return { error: typeof body.error === 'string' ? body.error : `Ошибка сервера: ${response.status}` };
      if (body.e2eeRequired === true && !e2eeKey) return { error: 'Для комнаты нужен ключ E2EE из приглашения.' };
      if (e2eeKey && body.e2eeRequired !== true) return { error: 'Приглашение требует E2EE, но сервер не подтвердил защищённый режим.' };
      const mediaURL = new URL(body.url);
      const expected = new URL(base);
      if (mediaURL.hostname !== expected.hostname || !['wss:', ...(!app.isPackaged ? ['ws:'] : [])].includes(mediaURL.protocol) || mediaURL.username || mediaURL.password || typeof body.token !== 'string') throw new Error('Неверный адрес голосового сервера');
      const healthURL = new URL(mediaURL); healthURL.protocol = mediaURL.protocol === 'wss:' ? 'https:' : 'http:';
      try {
        const health = await net.fetch(healthURL.toString(), { redirect: 'error', signal: AbortSignal.timeout(3000) });
        if (!health.ok) throw new Error('LiveKit unavailable');
      } catch {
        const help = expected.hostname === '127.0.0.1' && !app.isPackaged
          ? 'Для локального запуска выполните: docker compose -f compose.dev.yaml up -d'
          : 'Проверьте запуск LiveKit и HTTPS-прокси на сервере.';
        return { error: `Пароль принят, но голосовой сервер ${mediaURL.host} недоступен. ${help}` };
      }
      // Never accept a media key supplied by the server, even as an extra response field.
      return { url: body.url, token: body.token, identity: body.identity, e2eeRequired: body.e2eeRequired === true, ...(e2eeKey ? { e2eeKey } : {}) };
    } catch (error) {
      return { error: connectionError(error) };
    }
  });
  ipcMain.handle('configure-keys', (event, config) => {
    authorized(event);
    if (!config || !Number.isInteger(config.ptt) || config.ptt < 1 || config.ptt > 254) throw new Error('Неверная клавиша PTT');
    for (const key of ['mute', 'deafen']) if (typeof config[key] !== 'string' || config[key].length > 64) throw new Error('Неверная комбинация');
    globalShortcut.unregisterAll();
    keyConfig = config;
    native?.setPttKey(config.ptt);
    const failed = [];
    for (const action of ['mute', 'deafen']) {
      if (config[action]) {
        try { if (!globalShortcut.register(config[action], () => send('action', action))) failed.push(action); }
        catch { failed.push(action); }
      }
    }
    return { native: !!native, failed };
  });
  ipcMain.handle('duck', (event, input) => {
    authorized(event);
    if (!input || typeof input.active !== 'boolean' || !Number.isFinite(input.factor) || input.factor < 0 || input.factor > 1) throw new Error('Invalid attenuation');
    clearTimeout(duckTimer);
    native?.setDucking(input.active ? input.factor : 1);
    // Renderer refreshes this lease. Restore even if its audio loop stalls.
    if (input.active) duckTimer = setTimeout(restoreAudio, 2000);
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, args) => { acceptInvitation(args); win?.restore(); win?.show(); win?.focus(); });
  app.on('open-url', (event, address) => { event.preventDefault(); acceptInvitation([address]); win?.show(); win?.focus(); });
  app.whenReady().then(async () => {
    if (app.isPackaged) app.setAsDefaultProtocolClient('voicecord');
    acceptInvitation(process.argv);
    hosting = new SelfHost(app.isPackaged ? path.join(process.resourcesPath, 'server') : path.join(__dirname, '../resources/server'), value => send('host-changed', value));
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      const pin = certificatePins.get(request.hostname);
      const actual = certificateFingerprint(request.certificate);
      callback(pin ? (actual === pin ? 0 : -2) : -3);
    });
    app.on('certificate-error', (event, _contents, url, _error, certificate, callback) => {
      const pin = certificatePins.get(new URL(url).hostname);
      if (pin && certificateFingerprint(certificate) === pin) { event.preventDefault(); callback(true); }
      else callback(false);
    });
    credentials = new CredentialStore(path.join(app.getPath('userData'), 'credentials'), {
      isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
      encryptString: value => safeStorage.encryptStringAsync(value),
      decryptString: async value => (await safeStorage.decryptStringAsync(value)).result,
    });
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === win?.webContents && permission === 'media' && details.mediaTypes?.every(type => type === 'audio'));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => contents === win?.webContents && permission === 'media' && details.mediaType === 'audio');
    win = new BrowserWindow({ show: !process.argv.includes('--smoke'), width: 1240, height: 820, minWidth: 940, minHeight: 650, backgroundColor: '#191b22', title: 'Voicecord', icon: path.join(__dirname, '../assets/voicecord.ico'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: process.argv.includes('--offscreen-smoke') },
    });
    win.removeMenu();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', restoreAudio);
    win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
    registerIPC();
    if (native) {
      try { native.startPtt(down => send('ptt', down)); }
      catch { native = undefined; console.error('Windows input hooks are unavailable'); }
    }
    const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/tray.ico'));
    if (icon.isEmpty()) throw new Error('Voicecord tray icon is missing');
    tray = new Tray(icon);
    tray.setToolTip('Voicecord');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Открыть Voicecord', click: () => win.show() }, { label: 'Выключить микрофон', click: () => send('action', 'force-mute') }, { type: 'separator' }, { label: 'Выйти', click: () => { quitting = true; app.quit(); } }]));
    tray.on('double-click', () => win.show());
    powerMonitor.on('suspend', () => { restoreAudio(); send('suspend', true); void hostCheck.cancel(); if (hosting.starting) hosting.cancelled = true; else void hosting.stop('Комната закрыта: компьютер перешёл в сон'); });
    powerMonitor.on('lock-screen', () => { restoreAudio(); send('ptt', false); });
    if (devURL) await win.loadURL(devURL); else await win.loadFile(path.join(__dirname, '../dist/index.html'));
  });
  let hostShutdown = false;
  app.on('before-quit', event => {
    quitting = true; restoreAudio(); native?.shutdown(); globalShortcut.unregisterAll();
    if (hosting && !hostShutdown) {
      event.preventDefault(); hostShutdown = true;
      void (async () => { await hostCheck.cancel(); while (hosting.starting) await new Promise(resolve => setTimeout(resolve, 100)); await hosting.stop(); })().finally(() => app.quit());
    }
  });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
