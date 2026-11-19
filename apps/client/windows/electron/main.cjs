const { t } = require('../../../../shared/i18n.cjs');
const { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, powerMonitor, globalShortcut, net, safeStorage, clipboard, dialog, shell, Notification } = require('electron');
const { appId, windowIdentity } = require('./app-identity.cjs');
if (process.platform === 'win32') app.setAppUserModelId(appId);
const { MembershipClient } = require('./membership-client.cjs');
const { MembershipLinks } = require('./membership-links.cjs');
const memberFetch=require('./membership-transport.cjs').membershipTransport(session,(...args)=>net.fetch(...args));
const path = require('node:path');
const { localInvitation, verifyInvitation, serverCertificate, connectionError } = require('./connection.cjs');
const { X509Certificate } = require('node:crypto');
const { externalLinkHandler } = require('./external-links.cjs');
const { serverURL, invitation } = require('./address.cjs');
const { diagnosticCommand } = require('./diagnostic-command.cjs');
const { SelfHost } = require('./selfhost.cjs');
const { HostCheck } = require('./host-check.cjs');
const { HostError, hostResult } = require('./host-errors.cjs');
const { CredentialStore } = require('./credentials.cjs');
const { Updater } = require('./updater.cjs');
const { UpdatePreferences } = require('./update-settings.cjs');
const { UpdateRooms } = require('./update-rooms.cjs');
const { confirmUpdateStarted } = require('./update-progress.cjs');
const { StartupSettings } = require('./startup.cjs');
const fs = require('node:fs');
const { setLanguage } = require('../../../../shared/i18n.cjs');
let updater;
let updatePreferences;
let updateRooms;
let startup;
let language = 'ru';
let credentials;
let membershipClient,membershipLinks,membershipIPC;
const voiceSignal=new (require('./voice-signal.cjs').VoiceSignal)();
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
let hostedServerId;
const hostCheck = new HostCheck(app.isPackaged ? path.join(process.resourcesPath, 'diagnostics/check-selfhost.ps1') : path.join(__dirname, '../scripts/check-selfhost.ps1'));
const certificatePins = new Map();
function tlsOrigin(address){const url=new URL(address);if(url.protocol==='pawtalk:')return 'https://'+url.host;if(url.protocol==='wss:')url.protocol='https:';else if(url.protocol==='ws:')url.protocol='http:';return url.origin;}
function knownPin(address){return certificatePins.get(tlsOrigin(address));}
function safeNetFetch(address,options={}){
  const pin=knownPin(typeof address==='string'?address:address.url);
  return pin?memberFetch(address,{...options,pawtalkTLSFingerprint:pin}):net.fetch(address,options);
}
function trustInvitation(address) {
  const room = invitation(address);
  if (room) certificatePins.set(room.origin, room.fingerprint);
}
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
  membershipIPC=require('./membership-ipc.cjs').registerMembershipIPC({ipcMain,authorized,client:membershipClient,links:membershipLinks,getIdleSeconds:()=>powerMonitor.getSystemIdleTime(),clipboard,send,getWindow:()=>win,Notification,notificationAppearance:require('./notification-appearance.cjs').notificationAppearance({directory:path.join(app.getPath('userData'),'notification-avatars'),nativeImage}),getHost:()=>hosting?.status(),stopHost:()=>hosting.stop(),setVoiceEndpoint:(address,pin)=>address?voiceSignal.open(address,pin):voiceSignal.close()});
  ipcMain.handle('chat-text-copy', (event, text) => {
    authorized(event);
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 12000) throw new Error('Invalid chat text');
    return clipboard.writeText(text);
  });
  require('./image-actions.cjs').registerImageActions({ ipcMain, authorized, nativeImage, clipboard, ClipboardItem: require('electron').ClipboardItem, dialog, getWindow: () => win, t });
  ipcMain.handle('window-active', event => { authorized(event); return win.isVisible() && !win.isMinimized() && win.isFocused(); });
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
  ipcMain.handle('update-channel-get', event => { authorized(event); return updatePreferences.channel; });
  ipcMain.handle('update-channel-set', (event, value) => {
    authorized(event);
    if (updater?.busy) throw Error('Updater is busy');
    const channel = updatePreferences.setChannel(value);
    if (updater) { updater.channel = channel; updater.release = null; updater.set({ status: 'idle' }); }
    return channel;
  });
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
        const response = await safeNetFetch(`${target}${endpoint}`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
        await response.body?.cancel();
        if (!response.ok) return { ok: false, message: t("{0} ответил HTTP {1}. Проверьте запуск сервера и порт в приглашении.", endpoint === '/rtc' ? t("Голосовой сервер") : t("Сервер комнаты"), response.status) };
      }
      const policyResponse = await safeNetFetch(`${target}/api/config`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
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
    return hostResult(() => {
      if (hosting.status().running || hosting.starting || hosting.stopping) throw new HostError(t("Закройте комнату перед проверкой сети."));
      return hostCheck.start(port);
    }, t("Не удалось получить результат проверки сети. Попробуйте ещё раз."));
  });
  ipcMain.handle('host-check-cancel', event => { authorized(event); return hostResult(() => hostCheck.cancel(), t("Не удалось получить результат проверки сети. Попробуйте ещё раз.")); });
  ipcMain.handle('host-start', async (event, input) => {
    authorized(event);
    return hostResult(async () => {
      if (hostCheck.running) throw new HostError(t("Дождитесь завершения проверки сети."));
      const result = await hosting.start(input);
      trustInvitation(result.localAddress);
      try {
        await membershipClient.join(hosting.bootstrapAddress, typeof input.nickname === 'string' ? input.nickname : t('Гость'), t('Компьютер'));
        hosting.bootstrapAddress = undefined;
        send('membership-changed', { serverId: result.serverId });
      } catch (error) { await hosting.stop(); throw error; }
      return result;
    }, t("Не удалось запустить встроенный сервер. Возможно, порт занят."));
  });
  ipcMain.handle('host-stop', async event => {
    authorized(event);
    return hostResult(async () => {
      if (hosting.starting) throw new HostError(t("Дождитесь запуска комнаты"));
      await hosting.stop();
    }, t("Не удалось закрыть комнату. Попробуйте ещё раз."));
  });
  ipcMain.handle('capabilities', async (event) => { authorized(event); return { native: !!native, platform: process.platform, packaged: app.isPackaged, secureStorage: await safeStorage.isAsyncEncryptionAvailable() }; });
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
      channel: updatePreferences.channel,
      directory: path.join(app.getPath('userData'), 'updates'), script: app.isPackaged ? path.join(process.resourcesPath, 'updates/install-update.ps1') : path.join(__dirname, '../scripts/install-update.ps1'),
      installDirectory: path.dirname(app.getPath('exe')), executable: app.getPath('exe'), language: () => language,
      rooms: () => updateRooms.sources(), roomFetcher: (...args) => safeNetFetch(...args),
      onState: state => send('update-changed', { ...state, installable: app.isPackaged }) });
    acceptInvitation(process.argv);
    hosting = new SelfHost(app.isPackaged ? path.join(process.resourcesPath, 'server') : path.join(__dirname, '../../../../resources/server'), value => {
      if(value.running)hostedServerId=value.serverId;
      else if(hostedServerId){const ended=hostedServerId;hostedServerId=undefined;void membershipIPC?.serverEnded(ended).catch(()=>{});}
      send('host-changed', value);
    });
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      // The callback exposes no port. Force the renderer's URL-aware error
      // handler to decide pinned origins; main-process requests use isolated pools.
      const pinned=[...certificatePins.keys()].some(origin=>new URL(origin).hostname.replace(/^\[|\]$/g,'')===request.hostname.replace(/^\[|\]$/g,''));
      callback(pinned?-2:-3);
    });
    app.on('certificate-error', (event, _contents, url, _error, certificate, callback) => {
      const pin = knownPin(url);
      if (_contents===win?.webContents && pin && certificateFingerprint(certificate) === pin) { event.preventDefault(); callback(true); }
      else callback(false);
    });
    credentials = new CredentialStore(path.join(app.getPath('userData'), 'credentials'), {
      isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
      encryptString: value => safeStorage.encryptStringAsync(value),
      decryptString: async value => (await safeStorage.decryptStringAsync(value)).result,
    });
    membershipClient=new MembershipClient({credentials,fetcher:memberFetch,verify:address=>serverCertificate(address),trust:address=>trustInvitation(address),allowLoopback:!app.isPackaged});
    membershipLinks=new MembershipLinks(membershipClient);
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === win?.webContents && (permission === 'fullscreen' || permission === 'media' && details.mediaTypes?.every(type => type === 'audio')));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => contents === win?.webContents && (permission === 'fullscreen' || permission === 'media' && details.mediaType === 'audio'));
    win = new BrowserWindow({ show: !process.argv.includes('--smoke') && !(process.argv.includes('--start-in-tray') && !pendingInvitation), width: 1240, height: 820, minWidth: 940, minHeight: 650, backgroundColor: '#191b22', title: 'PawTalk', icon: path.join(__dirname, '../assets/pawtalk.ico'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: process.argv.includes('--offscreen-smoke') },
    });
    win.removeMenu();
    if (process.platform === 'win32' && app.isPackaged) win.setAppDetails(windowIdentity(app.getPath('exe')));
    for (const event of ['show', 'hide', 'minimize', 'restore', 'focus', 'blur']) win.on(event, () => send('window-active-changed', win.isVisible() && !win.isMinimized() && win.isFocused()));
    win.webContents.setWindowOpenHandler(externalLinkHandler(url => shell.openExternal(url)));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', restoreAudio);
    win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
    registerIPC();
    membershipIPC.start();
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
    powerMonitor.on('suspend', () => { restoreAudio(); membershipIPC?.suspend();send('suspend', true); void hostCheck.cancel(); if (hosting.starting) hosting.cancelled = true; else void hosting.stop(t("Комната закрыта: компьютер перешёл в сон")); });
    powerMonitor.on('lock-screen', () => { restoreAudio(); send('ptt', false); });
    if (devURL) await win.loadURL(devURL); else await win.loadFile(path.join(__dirname, '../dist/index.html'));
    await confirmUpdateStarted(path.join(app.getPath('userData'), 'updates'), app.getVersion(), app.getPath('exe'));
    if (updatePreferences.enabled && app.isPackaged) void updater?.check();
  });
  let hostShutdown = false;
  app.on('before-quit', event => {
    quitting = true; membershipIPC?.stop();restoreAudio(); native?.shutdown(); globalShortcut.unregisterAll();
    if (hosting && !hostShutdown) {
      event.preventDefault(); hostShutdown = true;
      void (async () => { await hostCheck.cancel(); while (hosting.starting) await new Promise(resolve => setTimeout(resolve, 100)); await hosting.stop(); })().finally(() => app.quit());
    }
  });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
