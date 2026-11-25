const { desktopCapturer, screen } = require('electron');
const { release } = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');

const handleOf = id => /^window:(\d+):\d+$/.exec(id)?.[1];

function registerScreenCapture({ ipcMain, session, authorized, getWindow, native }) {
  let catalog;
  let selection;
  let capturedWindow;
  let audioLease;
  let releaseCount = 0;
  const supportsApplicationAudio = process.platform === 'win32' && Number(release().split('.')[2]) >= 20348 &&
    typeof native?.startApplicationAudio === 'function';
  const applicationAudioAllowed = window => supportsApplicationAudio && !!window?.process && window.process !== process.pid;
  function stopApplicationAudio() {
    clearTimeout(audioLease);
    audioLease = undefined;
    native?.stopApplicationAudio?.();
  }
  function renewAudioLease() {
    clearTimeout(audioLease);
    audioLease = setTimeout(stopApplicationAudio, 3000);
    audioLease.unref();
  }
  const windowMinimized = window => window && native?.captureWindowMinimized?.(Number(window.handle), window.process);
  ipcMain.handle('screen-capture-sources', async (event, kind) => {
    authorized(event);
    if (kind !== 'window' && kind !== 'screen') throw Error('Invalid capture source kind');
    const frame = event.senderFrame;
    const listing = { frame, kind, sources: new Map() };
    catalog = listing;
    selection = undefined;
    const options = { types: [kind] };
    const previews = desktopCapturer.getSources({ ...options, thumbnailSize: { width: 280, height: 158 }, fetchWindowIcons: kind === 'window' });
    // Enumeration without thumbnails can return a source the capture backend could not preview.
    const [images, additional] = await Promise.all([
      previews.catch(() => []),
      kind === 'window' ? desktopCapturer.getSources({ ...options, thumbnailSize: { width: 0, height: 0 } }).catch(() => []) : [],
    ]);
    if (catalog !== listing || frame !== getWindow()?.webContents.mainFrame) return [];
    const windows = kind === 'window' ? new Map((native?.listCaptureWindows?.() ?? []).map(window => [window.handle, window])) : new Map();
    const displayHeight = display => Math.round(display.size.height * display.scaleFactor);
    const displays = screen.getAllDisplays();
    // An unmatched monitor uses a conservative limit across connected displays.
    const fallbackHeight = Math.min(...displays.map(displayHeight));
    const cards = [];
    function windowHeight(window) {
      const height = !window?.minimized && window?.height > 0 ? window.height : Infinity;
      return Math.min(height, window?.monitorHeight || fallbackHeight);
    }
    for (const source of [...images, ...additional]) {
      if (listing.sources.has(source.id)) continue;
      const handle = handleOf(source.id);
      const window = windows.get(handle);
      windows.delete(handle);
      const display = kind === 'screen' ? displays.find(item => String(item.id) === source.display_id) : undefined;
      const maxHeight = display ? displayHeight(display) : windowHeight(window);
      listing.sources.set(source.id, { source, window });
      cards.push({ id: source.id, name: source.name, thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
        icon: source.appIcon?.toDataURL(), maxHeight, available: !window?.minimized || typeof native?.restoreCaptureWindow === 'function',
        minimized: window?.minimized === true,
        applicationAudio: applicationAudioAllowed(window) });
    }
    for (const window of windows.values()) {
      const id = 'native-window:' + window.handle;
      const available = window.minimized && typeof native?.restoreCaptureWindow === 'function';
      if (available) listing.sources.set(id, { window });
      cards.push({ id, name: window.title, thumbnail: '', available, minimized: window.minimized,
        maxHeight: windowHeight(window), applicationAudio: available && applicationAudioAllowed(window) });
    }
    return cards;
  });
  ipcMain.handle('screen-capture-select', (event, id, audio, applicationAudio = false) => {
    authorized(event);
    selection = undefined;
    const entry = catalog?.frame === event.senderFrame && typeof id === 'string' && catalog.sources.get(id);
    const minimized = entry?.window && windowMinimized(entry.window);
    if (!entry || entry.window && (minimized === undefined || minimized && typeof native?.restoreCaptureWindow !== 'function') ||
        typeof audio !== 'boolean' || audio && (catalog.kind !== 'screen' || process.platform !== 'win32') ||
        typeof applicationAudio !== 'boolean' || applicationAudio && (catalog.kind !== 'window' || !applicationAudioAllowed(entry.window))) {
      throw Error('Invalid capture selection');
    }
    selection = { catalog, ...entry, audio, applicationAudio, expires: performance.now() + 5000 };
  });
  ipcMain.handle('screen-capture-window-status', event => {
    authorized(event);
    if (capturedWindow?.frame === event.senderFrame) return windowMinimized(capturedWindow.window);
  });
  ipcMain.handle('screen-capture-release', event => {
    authorized(event);
    releaseCount++;
    if (capturedWindow?.frame === event.senderFrame) {
      stopApplicationAudio();
      capturedWindow = undefined;
    }
  });
  ipcMain.handle('screen-capture-application-audio', event => {
    authorized(event);
    if (!audioLease || capturedWindow?.frame !== event.senderFrame || !capturedWindow.applicationAudio) return null;
    if (windowMinimized(capturedWindow.window) === undefined) { stopApplicationAudio(); return null; }
    const samples = native.readApplicationAudio();
    if (samples === null) stopApplicationAudio();
    else renewAudioLease();
    return samples;
  });
  ipcMain.handle('screen-capture-clear', event => {
    authorized(event);
    catalog = undefined;
    selection = undefined;
  });
  async function resolveSource(chosen, current) {
    const { window, source } = chosen;
    if (!window) return source;
    const minimized = windowMinimized(window);
    if (minimized === undefined) return;
    if (!minimized && source) return source;
    if (minimized && !native.restoreCaptureWindow?.(Number(window.handle), window.process)) return;
    // Chromium may omit iconic windows until Windows has processed the restore.
    while (current()) {
      const state = windowMinimized(window);
      if (state === undefined) return;
      if (!state) {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
        const restored = sources.find(item => handleOf(item.id) === window.handle);
        if (restored) return restored;
      }
      await delay(100);
    }
  }

  session.setDisplayMediaRequestHandler(async (request, callback) => {
    const chosen = selection;
    selection = undefined;
    const generation = releaseCount;
    const current = () => catalog === chosen.catalog && releaseCount === generation && performance.now() <= chosen.expires &&
      request.frame === getWindow()?.webContents.mainFrame;
    if (!chosen || !request.frame || request.frame !== chosen.catalog.frame || !request.userGesture ||
        !request.videoRequested || request.audioRequested !== chosen.audio || !current()) {
      callback(null);
      return;
    }
    const source = await resolveSource(chosen, current).catch(() => undefined);
    if (!source || !current() || chosen.window && windowMinimized(chosen.window) !== false) {
      callback(null);
      return;
    }
    stopApplicationAudio();
    if (chosen.applicationAudio) {
      try {
        if (!native.startApplicationAudio(chosen.window.process)) { callback(null); return; }
      } catch { callback(null); return; }
      renewAudioLease();
    }
    capturedWindow = chosen.window ? { frame: request.frame, window: chosen.window, applicationAudio: chosen.applicationAudio } : undefined;
    callback({ video: source, ...(chosen.audio && { audio: 'loopback' }) });
  });
}

module.exports = { registerScreenCapture };
