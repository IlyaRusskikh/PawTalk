// Runs the actual built renderer with Chromium's synthetic microphone.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
app.setPath('userData', path.join(os.tmpdir(), 'voicecord-renderer-smoke-' + process.pid));
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
// Chromium's default fake microphone is an intermittent beep. Use a continuous,
// speech-like PCM fixture so capture reopens cannot land in a silent interval.
let audioFile = process.env.VOICECORD_TEST_AUDIO_FILE;
if (!audioFile) {
  audioFile = path.join(os.tmpdir(), `voicecord-renderer-audio-${process.pid}.wav`);
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
  const errors = [];
  let win;
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
    session.defaultSession.setPermissionCheckHandler(() => true);
    win = new BrowserWindow({ show: false, width: 1240, height: 860, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if(event.level === 'error') errors.push(event.message); });
    let latestFrame;
    win.webContents.on('paint', (_event, _dirty, frame) => { latestFrame = frame; });
    const capture = async () => {
      for (let i = 0; i < 50 && !latestFrame; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(latestFrame, 'offscreen renderer produces a frame');
      return latestFrame.toPNG();
    };
    await win.loadFile(path.resolve('dist/index.html'));
    const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
    await wait(600);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('h1')?.textContent`), 'Разговор начинается здесь.');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.participants-heading,.empty-room,.connection-popover').length`),0,'no pre-connection participants or diagnostics');
    assert.equal(await win.webContents.executeJavaScript(`document.body.textContent.includes('Диагностика соединения')`),false);
    const output = path.resolve('release/qa'); await fs.mkdir(output,{recursive:true});
    await fs.writeFile(path.join(output,'room.png'),await capture());
    await win.webContents.executeJavaScript(`(()=>{
      window.testStreams=[];
      window.testAudioContexts=[];
      const Context=window.AudioContext;
      window.AudioContext=new Proxy(Context,{construct(target,args){const context=Reflect.construct(target,args);window.testAudioContexts.push(context);return context;}});
      const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async options=>{const stream=await capture(options);window.testStreams.push(stream);return stream;};
    })()`);
    await win.webContents.executeJavaScript(`document.querySelector('button[title="Настройки"]').click()`);
    await wait(100);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('dialog h2')?.textContent`), 'Настройки');
    await win.webContents.executeJavaScript(`(()=>{const select=document.querySelector('[aria-label="Режим шумоподавления"]');select.value='standard';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    for(let i=0;i<50;i++) {
      if(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Проверка микрофона' && !b.disabled)`)) break;
      await wait(100);
    }
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.mic-bars .lit').length`),0,'test segments stay grey before button press');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.mic-bars').dataset.active`),'false');
    assert.equal(await win.webContents.executeJavaScript(`window.testStreams.at(-1).getAudioTracks()[0].getSettings().echoCancellation`),true,'preview retains configured AEC before monitoring');
    await fs.writeFile(path.join(output,'audio-idle.png'),await capture());
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Проверка микрофона').click()`);
    for(let i=0;i<40;i++) {
      await wait(100);
      if(await win.webContents.executeJavaScript(`document.body.textContent.includes('Прекратить проверку')`)) break;
    }
    assert.ok(await win.webContents.executeJavaScript(`document.body.textContent.includes('Прекратить проверку')`), 'synthetic microphone starts through built AudioWorklet');
    assert.equal(await win.webContents.executeJavaScript(`window.testStreams.at(-1).getAudioTracks()[0].getSettings().echoCancellation`),false,'local monitoring disables capture AEC to avoid self cancellation');
    for(let i=0;i<40;i++) {
      await wait(100);
      if(await win.webContents.executeJavaScript(`Number(document.querySelector('[role=meter]').getAttribute('aria-valuenow')) > -80`)) break;
    }
    const meterState = await win.webContents.executeJavaScript(`({db:Number(document.querySelector('[role=meter]').getAttribute('aria-valuenow')),contexts:window.testAudioContexts.map(c=>({state:c.state,time:c.currentTime})),tracks:window.testStreams.map(s=>s.getAudioTracks().map(t=>({ready:t.readyState,enabled:t.enabled,muted:t.muted})))})`);
    assert.ok(meterState.db > -80, `microphone level reaches UI: ${JSON.stringify(meterState)}`);
    assert.ok(await win.webContents.executeJavaScript(`document.querySelectorAll('.mic-bars .lit').length > 0`),'test segments turn yellow on sound');
    await fs.writeFile(path.join(output,'audio-test.png'),await capture());
    await win.webContents.executeJavaScript(`(()=>{const select=document.querySelector('[aria-label="Режим шумоподавления"]');select.value='off';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(500);
    assert.ok(await win.webContents.executeJavaScript(`document.body.textContent.includes('Прекратить проверку')`), 'noise suppression change preserves monitoring');
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.toggle-row')).find(el=>el.textContent.includes('Эхоподавление')).querySelector('input').click()`);
    await wait(400);
    assert.ok(await win.webContents.executeJavaScript(`document.body.textContent.includes('Прекратить проверку')`), 'echo cancellation change preserves monitoring');
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.toggle-row')).find(el=>el.textContent.includes('Эхоподавление')).querySelector('input').click()`);
    await wait(100);
    assert.equal(await win.webContents.executeJavaScript(`window.testStreams.at(-1).getAudioTracks()[0].getSettings().echoCancellation`),false,'enabling echo setting during local monitoring cannot re-enable self cancellation');
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.toggle-row')).find(el=>el.textContent.includes('Автоматически определять чувствительность')).querySelector('input').click()`);
    await wait(100);
    await win.webContents.executeJavaScript(`(()=>{const input=document.querySelector('[aria-label="Порог активации"]');if(!input.closest('.sensitivity-track'))throw new Error('Slider must be on the indicator');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'-75');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(300);
    assert.equal(await win.webContents.executeJavaScript(`Number(document.querySelector('.sensitivity').dataset.threshold)`),-75,'threshold marker follows manual setting');
    for(let i=0;i<40;i++) {
      if(await win.webContents.executeJavaScript(`document.querySelector('.sensitivity').dataset.speaking === 'true'`)) break;
      await wait(100);
    }
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.sensitivity').dataset.speaking`),'true','threshold highlights voice above threshold');
    await win.webContents.executeJavaScript(`(()=>{const input=Array.from(document.querySelectorAll('.slider-label')).find(el=>el.textContent.includes('Громкость микрофона')).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'0');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait(500);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.sensitivity').dataset.speaking`),'false','highlight clears when input falls below threshold');
    assert.ok(await win.webContents.executeJavaScript(`document.body.textContent.includes('Прекратить проверку')`), 'gain and threshold changes preserve monitoring');
    await win.webContents.executeJavaScript(`(()=>{const select=document.querySelector('select[aria-label="Микрофон"]');const option=Array.from(select.options).find(o=>o.value!=='default');if(!option)throw new Error('No explicit microphone device');select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(500);
    assert.ok(await win.webContents.executeJavaScript(`document.body.textContent.includes('Прекратить проверку')`), 'microphone device switch preserves monitoring');
    await win.webContents.executeJavaScript(`(()=>{const input=Array.from(document.querySelectorAll('.slider-label')).find(el=>el.textContent.includes('Громкость микрофона')).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'1');input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.sensitivity').scrollIntoView({block:'center'});})()`);
    await wait(300);
    await win.webContents.executeJavaScript(`(()=>{const select=document.querySelector('[aria-label="Режим шумоподавления"]');select.value='rnnoise';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(500);
    assert.ok(await win.webContents.executeJavaScript(`document.body.textContent.includes('Прекратить проверку')`),'switch to RNNoise preserves monitoring');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[aria-label="Режим шумоподавления"]').value`),'rnnoise');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[role="alert"]').length`),0,'no microphone configuration errors');
    await fs.writeFile(path.join(output,'audio.png'),await capture());
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Прекратить проверку').click()`);
    assert.ok(await win.webContents.executeJavaScript(`document.body.textContent.includes('Проверка микрофона')`));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.mic-bars .lit').length`),0,'segments return to grey after stop');
    await wait(100);
    assert.equal(await win.webContents.executeJavaScript(`window.testStreams.at(-1).getAudioTracks()[0].getSettings().echoCancellation`),true,'stopping monitoring restores configured AEC');
    assert.deepEqual(errors, [], 'renderer console errors');
    console.log('PASS: built renderer, navigation, synthetic microphone, AudioWorklet, meter, cleanup. Screenshots: release/qa');
    app.exit(0);
  } catch(error) { console.error(error, errors); app.exit(1); }
});
