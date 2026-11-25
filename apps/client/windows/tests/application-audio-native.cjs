const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync } = require('node:fs');
const { copyFile, readdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'pawtalk-application-audio-')));
app.on('window-all-closed', () => {});

const title = frequency => `PawTalk synthetic application audio ${frequency}`;
let toneWindow;

async function playTone(frequency) {
  const win = new BrowserWindow({ show: false, title: title(frequency), width: 480, height: 280, webPreferences: { backgroundThrottling: false } });
  toneWindow = win;
  await win.loadURL('data:text/html,' + encodeURIComponent(`<title>${title(frequency)}</title>`));
  win.showInactive();
  win.setTitle(title(frequency));
  await win.webContents.executeJavaScript(`(async () => {
    const context = new AudioContext();
    const tone = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0.015;
    tone.frequency.value = ${frequency};
    tone.connect(gain).connect(context.destination);
    tone.start();
    await context.resume();
  })()`, true);
  setTimeout(() => app.quit(), 25000);
  process.stdout.write('READY\n');
}

async function verify() {
  const { registerScreenCapture } = require('../electron/screen-capture.cjs');
  const native = require('../native/build/Release/pawtalk.node');
  assert.equal(native.startApplicationAudio(process.pid), false, 'the capture process cannot record itself');
  const children = [];
  let win;
  try {
    for (const frequency of [440, 880]) {
      const child = spawn(process.execPath, [__filename, '--tone', String(frequency)], { stdio: ['pipe', 'pipe', 'inherit'] });
      children.push(child);
      const lines = createInterface({ input: child.stdout });
      const ready = await Promise.race([(async () => {
        for await (const line of lines) if (line === 'READY') return true;
        return false;
      })(), once(child, 'exit').then(() => false), delay(8000, false, { ref: false })]);
      lines.close();
      assert.equal(ready, true, `synthetic oscillator ${frequency} started in its own process`);
    }

    win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: true,
      preload: path.resolve(__dirname, '../electron/preload.cjs') } });
    registerScreenCapture({ ipcMain, session: session.defaultSession, native, getWindow: () => win, authorized(event) {
      assert.equal(event.sender, win.webContents);
      assert.equal(event.senderFrame, win.webContents.mainFrame);
    } });
    const targetWindows = native.listCaptureWindows().filter(window => window.title.startsWith('PawTalk synthetic application audio'));
    assert.deepEqual(targetWindows.map(window => window.title).sort(), [title(440), title(880)],
      `the native picker sees both test windows: ${JSON.stringify(targetWindows)}`);
    const assets = path.resolve(__dirname, '../dist/assets');
    const worklet = (await readdir(assets)).find(file => file.startsWith('application-audio-worklet-') && file.endsWith('.js'));
    assert.ok(worklet, 'production build ships the audio worklet as a local file');
    const page = path.join(app.getPath('userData'), 'check.html');
    const workletFile = path.join(app.getPath('userData'), worklet);
    await copyFile(path.join(assets, worklet), workletFile);
    await writeFile(page, `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; worker-src 'self'">`);
    await win.loadFile(page);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const read = () => window.desktop.readApplicationAudio();
      if (await read() !== null) throw Error('audio was readable before source consent');
      const sources = await window.desktop.screenCaptureSources('window');
      const item = sources.find(source => source.name === ${JSON.stringify(title(440))});
      if (!item?.available || !item.applicationAudio) throw Error('synthetic audio window is unavailable: ' + JSON.stringify(sources
        .filter(source => source.name.includes('synthetic application audio')).map(({id, available, minimized, applicationAudio}) => ({id, available, minimized, applicationAudio}))));
      await window.desktop.selectScreenCapture(item.id, false, true);
      if (await read() !== null) throw Error('selection alone enabled audio before display consent');
      const video = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const context = new AudioContext({ sampleRate: 44100 });
      try {
        await context.audioWorklet.addModule(${JSON.stringify(pathToFileURL(workletFile).href)});
        const node = new AudioWorkletNode(context, 'pawtalk-application-audio', { numberOfInputs: 0, outputChannelCount: [2] });
        const analyser = context.createAnalyser();
        analyser.fftSize = 4096;
        analyser.smoothingTimeConstant = 0.9;
        node.connect(analyser).connect(context.createMediaStreamDestination());
        await context.resume();
        const levels = new Float32Array(analyser.frequencyBinCount);
        const band = frequency => {
          const bin = Math.round(frequency * analyser.fftSize / context.sampleRate);
          return Math.max(...levels.slice(bin - 1, bin + 2));
        };
        const deadline = performance.now() + 5500;
        let level, unrelated;
        while (performance.now() < deadline) {
          const bytes = await read();
          if (bytes === null) throw Error('OS loopback activation or capture failed');
          if (bytes?.byteLength) node.port.postMessage(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2), [bytes.buffer]);
          analyser.getFloatFrequencyData(levels);
          level = band(440); unrelated = band(880);
          if (level > -66 && level - unrelated > 24) break;
          await new Promise(resolve => setTimeout(resolve, 15));
        }
        await window.desktop.releaseScreenCapture();
        return { level, unrelated, released: await read() === null, videoOnly: video.getAudioTracks().length === 0 };
      } finally {
        video.getTracks().forEach(track => track.stop());
        await context.close();
      }
    })()`, true);
    assert.ok(result.videoOnly && result.released, JSON.stringify(result));
    assert.ok(result.level > -66 && result.level - result.unrelated > 24, JSON.stringify(result));
    console.log('PASS native process loopback captures the selected application and excludes the unrelated tone');
  } finally {
    if (win) win.destroy();
    native.stopApplicationAudio();
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null) return;
      const done = once(child, 'exit').then(() => true);
      child.kill();
      if (!await Promise.race([done, delay(1500, false, { ref: false })])) child.kill();
    }));
  }
}

app.whenReady().then(async () => {
  if (process.argv[2] === '--tone') return playTone(Number(process.argv[3]));
  await verify();
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
