// Runs the actual built renderer with Chromium's synthetic microphone.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
app.setPath('userData', path.join(os.tmpdir(), 'pawtalk-renderer-smoke-' + process.pid));
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
// Chromium's default fake microphone is an intermittent beep. Use a continuous,
// speech-like PCM fixture so capture reopens cannot land in a silent interval.
let audioFile = process.env.PAWTALK_TEST_AUDIO_FILE;
if (!audioFile) {
  audioFile = path.join(os.tmpdir(), `pawtalk-renderer-audio-${process.pid}.wav`);
  const rate = 48000, count = rate * 6, wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(count * 2, 40);
  let phase = 0;
  for (let i = 0; i < count; i++) {
    const time = i / rate;
    phase += 2 * Math.PI * (185 + 24 * Math.sin(2 * Math.PI * 0.7 * time)) / rate;
    const envelope = 0.07 + 0.1 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3.1 * time));
    const sample = envelope * (Math.sin(phase) + 0.45 * Math.sin(phase * 2) + 0.2 * Math.sin(phase * 4));
    wav.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  require('node:fs').writeFileSync(audioFile, wav);
}
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', path.resolve(audioFile));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let win;
  try {
    session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(true));
    session.defaultSession.setPermissionCheckHandler(() => true);
    win = new BrowserWindow({ show: false, width: 1240, height: 860, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    const run = source => win.webContents.executeJavaScript(source, true);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (test, label) => { for (let i = 0; i < 100; i++) { if (await test()) return; await wait(100); } throw Error(label); };
    const tab = async name => { await run(`document.querySelector('#settings-tab-${name}').click()`); await wait(50); await until(() => run(`(()=>{const panel=document.querySelector('#settings-panel');const anchor=document.querySelector('#settings-anchor-${name}')||panel;const heading=anchor.querySelector('h1');return !!heading&&Math.abs(heading.getBoundingClientRect().top-panel.getBoundingClientRect().top-parseFloat(getComputedStyle(panel).paddingTop))<1;})()`), 'anchor settles: '+name); };
    const output = path.resolve('release/qa'); await fs.mkdir(output, { recursive: true });
    const capture = async name => { await wait(200); await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    await win.loadFile(path.resolve('dist/index.html'));
    await until(() => run(`!!document.querySelector('.home-actions')`), 'home renders');
    assert.ok(await run(`(()=>{const home=document.querySelector('.home-screen');const stack=document.querySelector('.toast-stack');const before=home.getBoundingClientRect().top;stack.style.display='none';const after=home.getBoundingClientRect().top;stack.style.removeProperty('display');return Math.abs(before-after)<1&&getComputedStyle(stack).position==='fixed'})()`), 'notifications do not move page content');
    await capture('home-review');
    await run(`document.querySelector('.toast').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`);
    await wait(5200);
    assert.ok(await run(`!!document.querySelector('.toast')`),'hover pauses toast dismissal');
    await run(`document.querySelector('.toast').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}))`);
    await wait(2500);
    await run(`document.querySelector('.toast').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
    await wait(2800);
    assert.ok(await run(`!!document.querySelector('.toast')`),'interaction restarts the five-second idle period');
    await wait(2500);
    assert.equal(await run(`!!document.querySelector('.toast')`),false,'idle toast fades away after five seconds');
    await run(`document.querySelector('[title="Настройки"]').click()`);
    await until(() => run(`document.querySelectorAll('[role=tab]').length===9`), 'settings navigation renders');
    assert.equal(await run(`!!document.querySelector('.voice-settings')`), false, 'profile does not render unrelated sound settings');
    assert.equal(await run(`document.querySelectorAll('.profile-settings select').length`),0,'language is not in profile');
    await capture('settings-profile-review');
    await tab('language');
    assert.ok(await run(`document.querySelector('#settings-panel label').textContent.includes('Язык приложения')`),'language has its own page');
    await tab('voice');
    await until(() => run(`!document.querySelector('.mic-test-button').disabled`), 'microphone preview ready');
    assert.equal(await run(`document.querySelector('.mic-bars').dataset.active`), 'false');
    await run(`document.querySelector('.mic-test-button').click()`);
    await until(() => run(`document.querySelector('.mic-test-button').getAttribute('aria-pressed')==='true'`), 'monitor starts');
    await until(() => run(`document.querySelectorAll('.mic-bars .lit').length>3`), 'actual synthetic microphone reaches meter');
    await capture('settings-audio-review');
    await run(`document.querySelector('.mic-test-button').click()`); await wait(100);
    assert.equal(await run(`document.querySelectorAll('.mic-bars .lit').length`), 0, 'monitor stops');
    await run(`(()=>{const el=document.querySelector('.voice-settings input[type=range]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'0.5');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    assert.ok(await run(`!!document.querySelector('.sensitivity')`), 'input sensitivity shares the voice page');
    assert.equal(await run(`document.querySelector('.settings-advanced').open`), false);
    await run(`document.querySelector('.settings-advanced summary').click()`);
    await run(`document.querySelector('.settings-advanced').scrollIntoView({block:'start'})`);
    await capture('settings-advanced-review');
    await run(`(()=>{const el=document.querySelector('[aria-label="Режим шумоподавления"]');el.value='standard';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    assert.equal(await run(`JSON.parse(localStorage.getItem('pawtalk.settings')).noiseMode`), 'standard');
    await run(`Array.from(document.querySelectorAll('#settings-panel button')).find(button=>button.textContent==='Сбросить настройки вкладки').click()`); await wait(100);
    assert.equal(await run(`JSON.parse(localStorage.getItem('pawtalk.settings')).noiseMode`), 'rnnoise', 'reset applies current processing defaults');
    assert.equal(await run(`JSON.parse(localStorage.getItem('pawtalk.settings')).inputGain`), 1, 'reset includes all voice settings');
    await tab('voice');
    await run(`window.settingsScrollFrames=[];document.querySelector('#settings-panel').addEventListener('scroll',event=>window.settingsScrollFrames.push(event.target.scrollTop));window.settingsVoiceNode=document.querySelector('.voice-settings');true`);
    await tab('sounds');
    assert.ok(await run(`window.settingsVoiceNode===document.querySelector('.voice-settings')`), 'audio anchors preserve mounted voice controls');
    assert.ok(await run(`new Set(window.settingsScrollFrames).size>2`), 'anchor scroll animates over multiple frames');
    assert.equal(await run(`document.querySelector('.settings-advanced').open`), true, 'anchor navigation preserves expanded controls');
    await tab('voice');
    await run(`document.querySelector('.settings-advanced').open=false`);
    await tab('sounds');
    assert.equal(await run(`document.querySelectorAll('.settings-reset').length`), 1, 'one reset per audio page');
    assert.equal(await run(`document.querySelectorAll('[id^="settings-anchor-"] .settings-reset').length`), 0, 'no resets in subsections');
    assert.ok(await run(`document.querySelector('.settings-content').lastElementChild.matches('.settings-page-footer')`), 'reset follows all audio sections');
    assert.equal(await run(`document.querySelectorAll('.notification-previews button').length`), 2);
    await capture('settings-sounds-review');
    await tab('shortcuts');
    assert.equal(await run(`document.querySelectorAll('#settings-anchor-shortcuts .toggle-row').length`), 0, 'attenuation lives in voice advanced settings');
    assert.equal(await run(`document.querySelectorAll('.settings-reset').length`), 1, 'one reset per system page');
    assert.ok(await run(`document.querySelector('.settings-content').lastElementChild.matches('.settings-page-footer')`), 'reset follows updates at the end of the system page');
    await capture('settings-shortcuts-review');
    await tab('appearance');
    await run(`document.querySelectorAll('.theme-preset')[2].click()`); await wait(100);
    assert.equal(await run(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`), '#7bcdb0');
    await capture('settings-appearance-review');
    assert.equal(await run(`document.querySelectorAll('.theme-color-field').length`),13,'separate palette controls');
    await run(`Array.from(document.querySelectorAll('.theme-preset')).find(button=>button.textContent==='Светлая').click()`); await wait(100);
    assert.equal(await run(`getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim()`),'#f4f5fa');
    assert.equal(await run(`getComputedStyle(document.documentElement).getPropertyValue('--text').trim()`),'#252b3d');
    await capture('settings-light-review');
    await run(`document.querySelector('dialog [aria-label="Закрыть"]').click()`); await wait(100);
    await capture('home-light-review');
    win.setSize(940,650); await wait(100);
    await capture('home-light-narrow-review');
    assert.ok(await run(`document.querySelector('.home-screen').scrollWidth<=document.querySelector('.home-screen').clientWidth+1`),'home fits minimum width');
    win.setSize(1240,860);
    await run(`document.querySelector('[title="Настройки"]').click()`); await wait(100);
    await tab('appearance');
    await run(`document.querySelectorAll('.theme-preset')[2].click()`); await wait(100);
    await run(`(()=>{const el=document.querySelector('input[aria-label="Боковая панель"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'#15202b');el.dispatchEvent(new Event('input',{bubbles:true}));})()`); await wait(100);
    assert.equal(await run(`getComputedStyle(document.documentElement).getPropertyValue('--sidebar-bg').trim()`),'#15202b');
    await run(`(()=>{const el=document.querySelector('.appearance-sliders input[type=range]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'16');el.dispatchEvent(new Event('input',{bubbles:true}));})()`); await wait(100);
    assert.equal(await run(`getComputedStyle(document.documentElement).getPropertyValue('--ui-font-size').trim()`),'16px');
    const radiusBefore = await run(`parseFloat(getComputedStyle(document.querySelector('.settings-modal')).borderTopLeftRadius)`);
    await run(`(()=>{const el=document.querySelectorAll('.appearance-sliders input[type=range]')[1];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'8');el.dispatchEvent(new Event('input',{bubbles:true}));})()`); await wait(100);
    assert.ok(await run(`parseFloat(getComputedStyle(document.querySelector('.settings-modal')).borderTopLeftRadius)<${radiusBefore}`), 'corner preference updates actual modal geometry');
    await tab('chat');
    await run(`(()=>{const el=document.querySelector('#settings-panel select');el.value='50';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    assert.equal(await run(`localStorage.getItem('pawtalk.chat.window')`), '50');
    await capture('settings-chat-review');
    for (const name of ['shortcuts', 'general', 'updates']) { await tab(name); assert.ok(await run(`document.querySelector('[role=tabpanel]').scrollWidth<=document.querySelector('[role=tabpanel]').clientWidth+1`), name + ' does not overflow'); }
    assert.equal(await run(`document.querySelector('.current-version').textContent`), 'Текущая версия: ' + require('../package.json').version);
    await capture('settings-updates-review');
    const headingGeometry = [];
    for (const name of ['general', 'shortcuts', 'updates', 'voice', 'sounds', 'appearance', 'chat', 'language', 'profile']) {
      await tab(name);
      headingGeometry.push(await run(`(()=>{const panel=document.querySelector('#settings-panel');const anchor=document.querySelector('#settings-anchor-${name}')||panel;const heading=anchor.querySelector('h1');const r=heading.getBoundingClientRect();const c=panel.getBoundingClientRect();return {name:'${name}',left:r.left-c.left,top:r.top-c.top,width:r.width};})()`));
    }
    for (const geometry of headingGeometry) {
      assert.ok(Math.abs(geometry.left-headingGeometry[0].left)<1, JSON.stringify(geometry)+' same left inset');
      assert.ok(Math.abs(geometry.top-headingGeometry[0].top)<1, JSON.stringify(geometry)+' same top inset');
      assert.ok(Math.abs(geometry.width-headingGeometry[0].width)<1, JSON.stringify(geometry)+' same content width');
    }
    await tab('general');
    await run(`window.settingsStartupNode=document.querySelector('#settings-anchor-general');true`);
    await tab('shortcuts');
    assert.ok(await run(`window.settingsStartupNode===document.querySelector('#settings-anchor-general')`), 'system anchors preserve mounted startup settings');
    await run(`document.querySelector('#settings-panel').scrollTo({top:0,behavior:'instant'})`);
    await until(() => run(`document.querySelector('#settings-tab-general').getAttribute('aria-selected')==='true'`), 'manual scrolling updates current anchor');
    win.webContents.debugger.attach('1.3');
    for (const motion of ['reduce', 'no-preference']) {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
      for (const language of ['en', 'ru']) {
        await tab('language');
        await run(`(()=>{const el=document.querySelector('#settings-panel select');el.value='${language}';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await until(() => run(`document.documentElement.lang==='${language}'`), 'language switches');
        for (const section of ['voice', 'sounds', 'shortcuts', 'appearance', 'chat', 'general', 'updates', 'language', 'profile']) {
          await tab(section);
          assert.ok(await run(`document.querySelector('#settings-panel').scrollWidth<=document.querySelector('#settings-panel').clientWidth+1`), section + ' fits ' + language + ' ' + motion);
          if (section === 'voice') {
            assert.equal(await run(`document.querySelector('.settings-advanced').open`), false);
            await run(`document.querySelector('.input-settings button:last-child').click()`);
            assert.ok(await run(`!!document.querySelector('.input-settings select')`), 'PTT options remain accessible');
            await run(`document.querySelector('.input-settings button:first-child').click()`);
          }
          if (motion === 'no-preference' && ['voice', 'sounds', 'shortcuts', 'general', 'language'].includes(section)) await capture('settings-' + section + '-' + language);
        }
      }
    }
    win.webContents.debugger.detach();
    await run(`document.querySelector('dialog [aria-label="Закрыть"]').click()`); await wait(100);
    await win.reload();
    await until(() => run(`!!document.querySelector('.home-actions')`), 'reload');
    assert.equal(await run(`localStorage.getItem('pawtalk.chat.window')`), '50');
    assert.equal(await run(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`), '#7bcdb0');
    assert.equal(await run(`getComputedStyle(document.documentElement).getPropertyValue('--sidebar-bg').trim()`),'#15202b');
    assert.equal(await run(`getComputedStyle(document.documentElement).getPropertyValue('--ui-font-size').trim()`),'16px');
    assert.deepEqual(errors, [], 'no renderer errors');
    console.log('PASS built renderer, settings navigation, synthetic microphone, theme persistence, chat window setting and panel geometry.');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
