const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
app.setPath('userData', path.join(os.tmpdir(), 'pawtalk-website-ui-' + process.pid));
app.disableHardwareAcceleration();
const timeout = setTimeout(() => { console.error('Website integration timed out'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pawtalk-website-preview-'));
  const window = new BrowserWindow({ show: false, width: 1280, height: 950, webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  try {
    for (const motion of ['no-preference', 'reduce']) {
      for (const width of [1280, 390]) for (const page of ['/', '/ru/', '/downloads/', '/fail/downloads/']) {
        window.setSize(width, 950);
        await window.loadURL(process.env.PAWTALK_WEBSITE_TEST_URL + page);
        window.webContents.debugger.attach('1.3');
        await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
        const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const poll = () => {
            const status = document.querySelector('[data-status]').textContent;
            if (!/Published releases|Опубликованные выпуски|unavailable|недоступны/.test(status)) { if (Date.now() > deadline) reject(Error('Catalog did not settle')); else setTimeout(poll, 20); return; }
            resolve({status, links: [...document.querySelectorAll('[data-release]')].map(a => ({component:a.dataset.release, channel:a.dataset.channel, asset:a.dataset.asset, href:a.getAttribute('href'), text:a.textContent})), overflow: document.documentElement.scrollWidth > innerWidth, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches});
          }; poll();
        })`);
        assert.equal(result.reduced, motion === 'reduce');
        assert.equal(result.overflow, false, `${page} width ${width}: horizontal overflow`);
        if (page.startsWith('/fail')) {
          assert.match(result.status, /unavailable/);
          assert.ok(result.links.every(link => !link.href));
        } else {
          assert.ok(result.links.find(link => link.asset === 'PawTalk.Setup.').href.endsWith('/client-v1.0.0/PawTalk.Setup.1.0.0.exe'));
          for (const link of result.links) if (link.channel === 'stable') assert.equal(link.href, null);
          else assert.match(link.href, /^https:\/\/github.com\/IlyaRusskikh\/PawTalk\/releases\//);
          if (page === '/ru/') assert.ok(result.links.some(link => link.text.includes('предварительный')));
        }
        if (width === 1280 && motion === 'no-preference' && !page.startsWith('/fail')) await fs.writeFile(path.join(directory, `${page === '/' ? 'en' : page.split('/')[1]}.png`), (await window.webContents.capturePage()).toPNG());
        window.webContents.debugger.detach();
      }
    }
    console.log(`PASS actual Electron website: EN/RU/downloads, desktop/mobile, normal/reduced motion, failed API and absent stable channel. Previews: ${directory}`);
  } finally { window.destroy(); clearTimeout(timeout); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
