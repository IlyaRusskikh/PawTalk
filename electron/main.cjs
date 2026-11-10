const { t } = require('../shared/i18n.cjs');
const { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, powerMonitor, globalShortcut, net, safeStorage, clipboard, dialog, shell } = require('electron');
const path = require('node:path');
const { localInvitation, verifyInvitation, connectionError } = require('./connection.cjs');
const { X509Certificate, createHash, randomUUID } = require('node:crypto');
const { requestChat, validChatAccess } = require('./chat.cjs');
const { externalLinkHandler } = require('./external-links.cjs');
const { profileSigner } = require('./profile.cjs');
const { serverURL, invitation } = require('./address.cjs');
const { diagnosticCommand } = require('./diagnostic-command.cjs');
const { SelfHost } = require('./selfhost.cjs');
const { HostCheck } = require('./host-check.cjs');
const { CredentialStore } = require('./credentials.cjs');
const { Updater } = require('./updater.cjs');
const { UpdatePreferences } = require('./update-settings.cjs');
const { UpdateRooms } = require('./update-rooms.cjs');
const { RoomPreviews } = require('./room-preview.cjs');
const { confirmUpdateStarted } = require('./update-progress.cjs');
const { StartupSettings } = require('./startup.cjs');
const fs = require('node:fs');
const { setLanguage } = require('../shared/i18n.cjs');
let updater;
let updatePreferences;
let updateRooms;
let startup;
let language = 'ru';
let credentials;
let signProfile;
let chatAccess;
const previews = new RoomPreviews({ fetcher: (...args) => net.fetch(...args), login: async (address, base) => {
  try {
    if (chatAccess?.base === base) return { token: chatAccess.token, key: chatAccess.key, ephemeral: chatAccess.ephemeral };
    const scope = credentialKey(address);
    const password = await credentials.load(scope); if (password === null) return;
    const key = await credentials.load('e2ee:' + scope);
    const response = await net.fetch(base + '/api/connect', { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(6000),
      body: JSON.stringify({ nickname: 'Preview', password, ...(key ? { e2ee: true, e2eeKeyId: createHash('sha256').update(Buffer.from(key, 'hex')).digest('hex') } : {}) }) });
    if (!response.ok) { await response.body?.cancel(); return; }
    const raw = await response.text(); if (raw.length > 16384) return;
    const body = JSON.parse(raw); if (!validChatAccess(body)) return;
    return { token: body.chatToken, key, ephemeral: body.chatEphemeral === true };
  } catch { return undefined; }
} });
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
try { native = require(app.isPackaged ? path.join(process.resourcesPath, 'pawtalk.node') : '../native/build/Release/pawtalk.node'); } catch {}
const devURL = process.env.PAWTALK_DEV_URL;
if (devURL && devURL !== 'http://127.0.0.1:5173') throw new Error('Invalid development URL');
function send(name, value) { if (win && !win.isDestroyed()) win.webContents.send(name, value); }
function refreshTray() {
  tray?.setContextMenu(Menu.buildFromTemplate([{ label: language === 'en' ? 'Open PawTalk' : t("Открыть PawTalk"), click: () => win.show() }, { label: language === 'en' ? 'Mute microphone' : t("Выключить микрофон"), click: () => send('action', 'force-mute') }, { type: 'separator' }, { label: language === 'en' ? 'Quit' : t("Выйти"), click: () => { quitting = true; app.quit(); } }]));
}
function restoreAudio() { clearTimeout(duckTimer); try { native?.setDucking(1); } catch {} }
function authorized(event) {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Unauthorized IPC');
}
function registerIPC() {
  ipcMain.handle('chat-text-copy', (event, text) => {
    authorized(event);
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 12000) throw new Error('Invalid chat text');
    return clipboard.writeText(text);
  });
  require('./image-actions.cjs').registerImageActions({ ipcMain, authorized, nativeImage, clipboard, ClipboardItem: require('electron').ClipboardItem, dialog, getWindow: () => win, t });
  ipcMain.handle('room-preview', async (event, address, cursor) => {
    authorized(event);
    try {
      const effective = invitation(address) ? localInvitation(address, hosting.status()) : address;
      const base = serverURL(effective, !app.isPackaged);
      await verifyInvitation(effective); trustInvitation(effective);
      return await previews.read(address, base, cursor);
    } catch { return { status: 'offline' }; }
  });
  ipcMain.handle('window-active', event => { authorized(event); return win.isVisible() && !win.isMinimized() && win.isFocused(); });
  ipcMain.handle('room-presence', async (event, address) => {
    authorized(event);
    try {
      const effective = invitation(address) ? localInvitation(address, hosting.status()) : address;
      const base = serverURL(effective, !app.isPackaged);
      await verifyInvitation(effective);
      trustInvitation(effective);
      const response = await net.fetch(`${base}/api/presence`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) { await response.body?.cancel(); return null; }
      const raw = await response.text();
      if (raw.length > 1024) return null;
      const body = JSON.parse(raw);
      return Number.isSafeInteger(body.participants) && body.participants >= 0 ? body.participants : null;
    } catch { return null; }
  });
  ipcMain.handle('autostart-get', event => {
    authorized(event);
    return process.platform === 'win32' && app.isPackaged && startup.enabled();
  });
  ipcMain.handle('autostart-set', (event, enabled) => {
    authorized(event);
    if (typeof enabled !== 'boolean' || process.platform !== 'win32' || !app.isPackaged) throw new Error(t("Автозапуск доступен в установленном приложении Windows."));
    return startup.setEnabled(enabled);
  });
  ipcMain.handle('start-in-tray-get', event => { authorized(event); return startup.inTray; });
  ipcMain.handle('start-in-tray-set', (event, value) => {
    authorized(event);
    if (typeof value !== 'boolean' || process.platform !== 'win32' || !app.isPackaged) throw new Error(t("Автозапуск доступен в установленном приложении Windows."));
    return startup.setInTray(value);
  });
  ipcMain.handle('server-key-copy', (event, value) => {
    authorized(event);
    if (typeof value !== 'string' || !/^(?:[a-f0-9]{64}|PAWTALK_E2EE=true\nPAWTALK_E2EE_KEY_ID=[a-f0-9]{64})$/.test(value)) throw new Error('Invalid encryption key field');
    clipboard.writeText(value);
  });
  ipcMain.handle('language-get', event => { authorized(event); return language; });
  ipcMain.handle('language-set', (event, value) => {
    authorized(event);
    if (!['en', 'ru'].includes(value)) throw new Error('Invalid language');
    fs.writeFileSync(path.join(app.getPath('userData'), 'language.json'), JSON.stringify({ language: value }));
    language = value; setLanguage(value); refreshTray();
  });
  ipcMain.handle('update-state', event => { authorized(event); return { ...(updater?.state ?? { status: 'idle' }), installable: app.isPackaged }; });
  ipcMain.handle('update-rooms-set', (event, rooms) => { authorized(event); updateRooms.set(rooms); });
  ipcMain.handle('update-preference-get', event => { authorized(event); return updatePreferences.enabled; });
  ipcMain.handle('update-preference-set', (event, value) => { authorized(event); return updatePreferences.setEnabled(value); });
  ipcMain.handle('update-check', async event => { authorized(event); if (!updater) throw new Error('Updates require Windows'); return { ...await updater.check(), installable: app.isPackaged }; });
  ipcMain.handle('update-install', async event => {
    authorized(event);
    if (!updater || !app.isPackaged) throw new Error('Installing updates requires an installed Windows app');
    const state = await updater.install();
    if (state.status === 'installing') { quitting = true; app.quit(); }
    return state;
  });
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
        if (!response.ok) return { ok: false, message: t("{0} ответил HTTP {1}. Проверьте запуск сервера и порт в приглашении.", endpoint === '/rtc' ? t("Голосовой сервер") : t("Сервер комнаты"), response.status) };
      }
      const policyResponse = await net.fetch(`${target}/api/config`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      const policy = policyResponse.ok ? await policyResponse.json() : {};
      return { ok: true, e2eeRequired: policy.e2eeRequired === true, message: effective !== address
        ? t("Ваша комната доступна напрямую на этом компьютере. При подключении будет использован локальный адрес. Доступность для друга через интернет ещё не проверена.")
        : t("Сервер {0} доступен, защищённое соединение{1} проверены. Пароль и передача голоса проверяются при подключении. Это проверка из вашей текущей сети.", new URL(base).host, invitation(effective) ? t(", сертификат приглашения и голосовой сервер") : '') };
    } catch (error) { return { ok: false, message: connectionError(error) }; }
  });
  ipcMain.handle('diagnostic-command-copy', (event, address) => {
    authorized(event);
    if (typeof address !== 'string' || address.length > 14000) throw new Error(t("Неверное приглашение"));
    clipboard.writeText(diagnosticCommand(address));
  });
  ipcMain.handle('invitation-copy', (event, address) => {
    authorized(event);
    if (typeof address !== 'string' || address.length > 14000 || !invitation(address)) throw new Error(t("Неверное приглашение"));
    return clipboard.writeText(address);
  });
  ipcMain.handle('invitation-pending', event => { authorized(event); return pendingInvitation; });
  ipcMain.handle('host-status', event => { authorized(event); return hosting.status(); });
  ipcMain.handle('host-check', (event, port) => {
    authorized(event);
    if (hosting.status().running || hosting.starting || hosting.stopping) throw new Error(t("Закройте комнату перед проверкой сети."));
    return hostCheck.start(port);
  });
  ipcMain.handle('host-check-cancel', event => { authorized(event); return hostCheck.cancel(); });
  ipcMain.handle('host-start', async (event, input) => {
    authorized(event);
    if (hostCheck.running) throw new Error(t("Дождитесь завершения проверки сети."));
    const result = await hosting.start(input);
    trustInvitation(result.localAddress);
    return result;
  });
  ipcMain.handle('host-stop', async event => { authorized(event); if (hosting.starting) throw new Error(t("Дождитесь запуска комнаты")); await hosting.stop(); });
  ipcMain.handle('capabilities', async (event) => { authorized(event); return { native: !!native, platform: process.platform, packaged: app.isPackaged, secureStorage: await safeStorage.isAsyncEncryptionAvailable() }; });
  ipcMain.handle('credentials-load', async (event, address) => {
    authorized(event);
    return { password: await credentials.load(credentialKey(address)), e2eeKey: await credentials.load('e2ee:' + credentialKey(address)) };
  });
  ipcMain.handle('credentials-save', async (event, input) => {
    authorized(event);
    if (!input || (input.password !== null && (typeof input.password !== 'string' || input.password.length > 1024))) throw new Error(t("Неверный пароль"));
    if (input.e2eeKey != null && (typeof input.e2eeKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.e2eeKey))) throw new Error(t("Неверный ключ E2EE"));
    await credentials.save(credentialKey(input.address), input.password);
    previews.forget(input.address);
    if ('e2eeKey' in input || input.password === null) await credentials.save('e2ee:' + credentialKey(input.address), input.password === null ? null : input.e2eeKey ?? null);
  });
  ipcMain.handle('connect', async (event, input) => {
    authorized(event);
    if (!input || typeof input.nickname !== 'string' || typeof input.password !== 'string' || input.nickname.length > 64 || input.password.length > 1024) throw new Error(t("Неверные параметры подключения"));
    const address = app.isPackaged || invitation(input.address) ? localInvitation(input.address, hosting.status()) : input.address;
    const base = serverURL(address, !app.isPackaged);
    try {
      const e2eeKey = invitation(input.address)?.e2eeKey ?? input.e2eeKey;
      if (e2eeKey != null && !/^[a-f0-9]{64}$/.test(e2eeKey)) return { error: t("Неверный ключ E2EE.") };
      await verifyInvitation(address);
      trustInvitation(address);
      const login = { nickname: input.nickname, password: invitation(input.address)?.password ?? input.password, ...(e2eeKey ? { e2ee: true, e2eeKeyId: createHash('sha256').update(Buffer.from(e2eeKey, 'hex')).digest('hex') } : {}) };
      const scope = invitation(address)?.fingerprint ?? base;
      const join = async () => {
        let profile;
        {
          const policy = await net.fetch(`${base}/api/config`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
          if (policy.ok) {
            const config = await policy.text();
            if (config.length <= 1024) {
              const challenge = JSON.parse(config).profileChallenge;
              if (typeof challenge === 'string') profile = await signProfile(scope, challenge, input.nickname);
            }
          } else await policy.body?.cancel();
        }
        const response = await net.fetch(`${base}/api/connect`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
          body: JSON.stringify({ ...login, ...(profile ? { profile } : {}) }), signal: AbortSignal.timeout(12000),
        });
        if (Number(response.headers.get('content-length') || 0) > 16384) throw new Error(t("Некорректный ответ сервера"));
        const raw = await response.text(); if (raw.length > 16384) throw new Error(t("Некорректный ответ сервера"));
        const body = JSON.parse(raw);
        if (!response.ok) return { error: typeof body.error === 'string' ? t(body.error) : t("Ошибка сервера: {0}", response.status) };
        return body;
      };
      const body = await join();
      if (body.error) return { error: body.error };
      if (body.e2eeRequired === true && !e2eeKey) return { error: t("Для комнаты нужен ключ E2EE из приглашения.") };
      if (e2eeKey && body.e2eeRequired !== true) return { error: t("Приглашение требует E2EE, но сервер не подтвердил защищённый режим.") };
      const mediaURL = new URL(body.url);
      const expected = new URL(base);
      if (mediaURL.hostname !== expected.hostname || !['wss:', ...(!app.isPackaged ? ['ws:'] : [])].includes(mediaURL.protocol) || mediaURL.username || mediaURL.password || typeof body.token !== 'string') throw new Error(t("Неверный адрес голосового сервера"));
      const healthURL = new URL(mediaURL); healthURL.protocol = mediaURL.protocol === 'wss:' ? 'https:' : 'http:';
      try {
        const health = await net.fetch(healthURL.toString(), { redirect: 'error', signal: AbortSignal.timeout(3000) });
        if (!health.ok) throw new Error('LiveKit unavailable');
      } catch {
        const help = expected.hostname === '127.0.0.1' && !app.isPackaged
          ? t("Для локального запуска выполните: npm run dev:server")
          : t("Проверьте запуск LiveKit и HTTPS-прокси на сервере.");
        return { error: t("Пароль принят, но голосовой сервер {0} недоступен. {1}", mediaURL.host, help) };
      }
      // Never accept a media key supplied by the server, even as an extra response field.
      const local = hosting.status();
      const ownHost = local.running && !!invitation(address) && invitation(address).fingerprint === invitation(local.localAddress)?.fingerprint;
      const profileId = typeof body.profileId === 'string' && /^[a-f0-9]{64}$/.test(body.profileId) ? body.profileId : undefined;
      chatAccess = validChatAccess(body) && (!body.e2eeRequired || e2eeKey)
        ? { handle: randomUUID(), feed: body.chatFeed, token: body.chatToken, profileId, base, join, renewAfter: 0, protocol: body.chatProtocol, encrypted: body.e2eeRequired === true, key: e2eeKey, ephemeral: body.chatEphemeral === true }
        : undefined;
      return { url: body.url, token: body.token, identity: body.identity, ownHost, e2eeRequired: body.e2eeRequired === true, ...(e2eeKey ? { e2eeKey } : {}),
        ...(chatAccess ? { chat: { handle: chatAccess.handle, feed: chatAccess.feed, ephemeral: body.chatEphemeral === true, profileId, protocol: body.chatProtocol, encrypted: body.e2eeRequired === true, mutations: body.chatMutations === true } } : {}) };
    } catch (error) {
      return { error: connectionError(error) };
    }
  });
  ipcMain.handle('chat-request', async (event, handle, input) => {
    authorized(event);
    const access = chatAccess;
    if (!access || access.handle !== handle) throw new Error('Chat is disconnected');
    return requestChat(net.fetch.bind(net), access, input);
  });
  ipcMain.handle('chat-close', (event, handle) => {
    authorized(event);
    if (chatAccess?.handle === handle) chatAccess = undefined;
  });
  ipcMain.handle('configure-keys', (event, config) => {
    authorized(event);
    if (!config || !Number.isInteger(config.ptt) || config.ptt < 1 || config.ptt > 254) throw new Error(t("Неверная клавиша PTT"));
    for (const key of ['mute', 'deafen']) if (typeof config[key] !== 'string' || config[key].length > 64) throw new Error(t("Неверная комбинация"));
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
    if (app.isPackaged && !process.argv.includes('--smoke')) app.setAsDefaultProtocolClient('pawtalk');
    for (const location of [path.join(app.getPath('userData'), 'language.json'), path.join(path.dirname(app.getPath('exe')), 'language.json')]) {
      try { const saved = JSON.parse(fs.readFileSync(location, 'utf8')); if (['en', 'ru'].includes(saved.language)) { language = saved.language; break; } } catch {}
    }
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    startup = new StartupSettings(app, path.join(app.getPath('userData'), 'startup.json'));
    updatePreferences = new UpdatePreferences(path.join(app.getPath('userData'), 'update-settings.json'));
    updateRooms = new UpdateRooms(path.join(app.getPath('userData'), 'update-rooms.json'), {
      effective: address => localInvitation(address, hosting?.status()), verify: verifyInvitation, trust: trustInvitation });
    fs.writeFileSync(path.join(app.getPath('userData'), 'language.json'), JSON.stringify({ language }));
    setLanguage(language);
    if (process.platform === 'win32') updater = new Updater({ current: app.getVersion(),
      directory: path.join(app.getPath('userData'), 'updates'), script: app.isPackaged ? path.join(process.resourcesPath, 'updates/install-update.ps1') : path.join(__dirname, '../scripts/install-update.ps1'),
      installDirectory: path.dirname(app.getPath('exe')), executable: app.getPath('exe'), language: () => language,
      rooms: () => updateRooms.sources(), roomFetcher: (...args) => net.fetch(...args),
      onState: state => send('update-changed', { ...state, installable: app.isPackaged }) });
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
    signProfile = profileSigner(credentials);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === win?.webContents && permission === 'media' && details.mediaTypes?.every(type => type === 'audio'));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => contents === win?.webContents && permission === 'media' && details.mediaType === 'audio');
    win = new BrowserWindow({ show: !process.argv.includes('--smoke') && !(process.argv.includes('--start-in-tray') && !pendingInvitation), width: 1240, height: 820, minWidth: 940, minHeight: 650, backgroundColor: '#191b22', title: 'PawTalk', icon: path.join(__dirname, '../assets/pawtalk.ico'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: process.argv.includes('--offscreen-smoke') },
    });
    win.removeMenu();
    for (const event of ['show', 'hide', 'minimize', 'restore', 'focus', 'blur']) win.on(event, () => send('window-active-changed', win.isVisible() && !win.isMinimized() && win.isFocused()));
    win.webContents.setWindowOpenHandler(externalLinkHandler(url => shell.openExternal(url)));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', restoreAudio);
    win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
    registerIPC();
    if (native) {
      try { native.startPtt(down => send('ptt', down)); }
      catch { native = undefined; console.error('Windows input hooks are unavailable'); }
    }
    const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/tray.ico'));
    if (icon.isEmpty()) throw new Error('PawTalk tray icon is missing');
    tray = new Tray(icon);
    tray.setToolTip('PawTalk');
    refreshTray();
    tray.on('double-click', () => win.show());
    powerMonitor.on('suspend', () => { restoreAudio(); send('suspend', true); void hostCheck.cancel(); if (hosting.starting) hosting.cancelled = true; else void hosting.stop(t("Комната закрыта: компьютер перешёл в сон")); });
    powerMonitor.on('lock-screen', () => { restoreAudio(); send('ptt', false); });
    if (devURL) await win.loadURL(devURL); else await win.loadFile(path.join(__dirname, '../dist/index.html'));
    await confirmUpdateStarted(path.join(app.getPath('userData'), 'updates'), app.getVersion(), app.getPath('exe'));
    if (updatePreferences.enabled && app.isPackaged) void updater?.check();
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
