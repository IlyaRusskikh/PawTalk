// Run through scripts/server-chat-ui-smoke.mjs with this file as the script argument.
// PAWTALK_MEDIA_SCROLL_CASES selects baseline, video or slow-photo. The default compares photos.
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync, readFileSync, mkdtempSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { cpus, totalmem, tmpdir } = require('node:os');
const { resolve, join } = require('node:path');

const root = resolve(__dirname, '../../../..');
const output = process.env.PAWTALK_MEDIA_SCROLL_OUTPUT || mkdtempSync(join(tmpdir(), 'pawtalk-media-scroll-'));
const url = process.env.PAWTALK_UI_TEST_URL || 'http://127.0.0.1:5173';
const selection = process.env.PAWTALK_MEDIA_SCROLL_CASES;
const modes = selection === 'baseline' || process.argv.includes('--baseline')
  ? ['text', 'current'] : ['current', 'preview', 'three'];
const cases = selection === 'video' ? [
  { count: 12, pixels: 1920, quality: 0.86, videoSeconds: 2 },
  { count: 36, pixels: 1920, quality: 0.86, videoSeconds: 4 },
] : selection === 'slow-photo' ? [
  { count: 36, pixels: 4000, quality: 0.72, mbps: 5 },
] : [
  { count: 12, pixels: 1600, quality: 0.86 },
  { count: 12, pixels: 4000, quality: 0.86 },
  { count: 36, pixels: 4000, quality: 0.86 },
  { count: 36, pixels: 4000, quality: 0.72 },
];
const source = ['ServerChat.tsx', 'VideoMessage.tsx', 'VideoViewer.tsx', 'ChatFile.tsx',
  'style.css', 'interface.css', 'membership.css'].map(name => 'apps/client/windows/src/' + name);
const fixture = ['media-scroll.cjs', 'media-scroll.tsx', 'media-scroll.html', 'media-scroll-video.ts']
  .map(name => 'apps/client/windows/tests/' + name);
app.setPath('userData', mkdtempSync(join(tmpdir(), 'pawtalk-media-scroll-profile-')));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  mkdirSync(output, { recursive: true });
  const snapshot = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    source: Object.fromEntries([...source, ...fixture].map(file =>
      [file, createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')])),
    versions: process.versions,
    cpu: cpus()[0].model,
    ramBytes: totalmem(),
    platform: process.platform,
    cases: [],
  };
  writeFileSync(join(output, 'source.diff'), execFileSync('git', ['diff', 'HEAD', '--', ...source], { cwd: root }));
  const resultPath = join(output, 'measurements.json');
  const save = () => writeFileSync(resultPath, JSON.stringify(snapshot, null, 2) + '\n');
  const videos = new Map();
  snapshot.videoFixtureHashes = {};
  console.log(resultPath);
  for (let repetition = 0; repetition < 2; repetition++) {
    for (const scenario of cases) {
      for (const mode of repetition % 2 ? [...modes].reverse() : modes) {
        if (mode === 'text' && scenario !== cases[0]) continue;
        const config = { mbps: 25, ...scenario, mode };
        const win = new BrowserWindow({ show: false, width: 1060, height: 800, useContentSize: true,
          webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true,
            partition: 'media-scroll-' + snapshot.cases.length } });
        let memoryPeakKB = 0;
        let sampler;
        try {
          await win.loadURL(url + '/tests/media-scroll.html');
          if (scenario.videoSeconds && !videos.has(scenario)) {
            const source = await win.webContents.executeJavaScript(
              'window.makeMediaScrollVideo(' + JSON.stringify(config) + ')');
            videos.set(scenario, source);
            snapshot.videoFixtureHashes[scenario.videoSeconds] = createHash('sha256')
              .update(Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')).digest('hex');
          }
          const pid = win.webContents.getOSProcessId();
          sampler = setInterval(() => {
            const memory = app.getAppMetrics().find(process => process.pid === pid)?.memory;
            if (memory) memoryPeakKB = Math.max(memoryPeakKB, memory.workingSetSize);
          }, 150);
          const result = await win.webContents.executeJavaScript(
            'window.runMediaScroll(...' + JSON.stringify([config, videos.get(scenario)]) + ')', true);
          snapshot.cases.push({ ...result, repetition, memoryPeakKB });
          save();
          console.log(JSON.stringify({ mode, ...scenario, repetition, p95Ms: result.p95Ms,
            framesOver25Ms: result.framesOver25Ms, bytes: result.requests.bytes, openMs: result.openMs }));
        } finally {
          clearInterval(sampler);
          win.destroy();
        }
      }
    }
  }
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
