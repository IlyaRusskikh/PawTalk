const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
app.setPath('userData', path.join(require('node:os').tmpdir(), 'pawtalk-notifications-' + process.pid));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1240, height: 820, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (code, label) => { for (let i = 0; i < 100; i++) { if (await run(code)) return; await delay(50); } throw Error(label); };
  const count = () => run('window.notifications');
  const baseline = async () => { await until('window.ready && document.querySelectorAll(".chat-message").length===100', 'history ready'); await delay(200); await run('window.setWindowActive(true)'); };
  const bottom = async () => {
    await run(`document.querySelector('.chat-jump')?.click()`); await delay(250);
    await run(`(()=>{const list=document.querySelector('.chat-stream');list.scrollTop=list.scrollHeight;list.dispatchEvent(new Event('scroll'));})()`); await delay(100);
  };
  const incoming = async (amount = 1, own = false) => { await run(`window.addMessages(${amount},${own})`); await delay(350); };
  try {
    await win.loadURL(process.env.PAWTALK_UI_TEST_URL + '/tests/notifications.html');
    await baseline();
    assert.equal(await count(), 0, 'initial history is silent');
    await bottom();
    await incoming();
    assert.equal(await count(), 0, 'visible latest chat is silent');
    await run('window.setWindowActive(false)');
    await incoming();
    assert.equal(await count(), 1, 'inactive/minimized window notifies');
    await incoming(1, true);
    assert.equal(await count(), 1, 'own messages are silent');
    await run('window.refresh()'); await delay(350);
    assert.equal(await count(), 1, 'same poll result never repeats');
    await run('window.setWindowActive(true); document.querySelector(".chat-stream").scrollTop=0; document.querySelector(".chat-stream").dispatchEvent(new Event("scroll"))');
    await delay(150); await incoming();
    assert.equal(await count(), 2, 'scrolled-up chat notifies');
    await bottom(); await incoming();
    assert.equal(await count(), 2, 'returning to latest suppresses sound');
    await run('window.setCovered(true)'); await delay(50); await incoming();
    assert.equal(await count(), 3, 'covered chat notifies');
    await run('window.setCovered(false); window.setChatVisible(false)'); await delay(50); await incoming(5);
    assert.equal(await count(), 4, 'one notification per unseen batch on the home screen');
    await run('window.setConnected(false)'); await delay(50); await incoming();
    assert.equal(await count(), 4, 'disconnected room stays silent');
    await run('window.setConnected(true)'); await delay(400);
    assert.equal(await count(), 4, 'reconnect catch-up is silent');
    await incoming();
    assert.equal(await count(), 5, 'subsequent live messages notify after reconnect');

    await win.loadURL(process.env.PAWTALK_UI_TEST_URL + '/tests/notifications.html?live=1');
    await until('window.ready', 'live ready'); await delay(100);
    await run('window.setWindowActive(false); window.emitLive()'); await delay(150);
    assert.equal(await count(), 1, 'legacy live chat notifies');
    await run('window.emitLive(false,true)'); await delay(150);
    assert.equal(await count(), 1, 'live packet replay is silent');
    await run('window.emitLive(true)'); await delay(150);
    assert.equal(await count(), 1, 'own live packets are silent');

    assert.equal(await run(`window.playSound('join',{sounds:false})`), undefined);
    assert.equal(await run(`window.playSound('join',{outputVolume:0})`), undefined);
    for (const event of ['join','leave','message','mute','unmute','deafen','undeafen']) assert.equal(await run(`window.playSound('${event}',{notificationVolume:0})`), undefined, 'one notification volume mutes every cue');
    assert.equal(await run('window.audioPlays.length'), 0, 'mute settings do not start an audio source');
    assert.equal(await run(`window.playSound('join',{outputDevice:'pawtalk-nonexistent-output'})`), undefined, 'native sink errors are contained');
    assert.equal(await run('window.audioPlays.length'), 0, 'invalid output never falls back to an unintended device');
    assert.equal(await run(`window.playSound('join',{notificationVolume:0.25,outputVolume:2})`), 'room-join.wav');
    assert.equal(await run(`window.playSound('leave')`), 'room-leave.wav');
    const names = [];
    for (let i = 0; i < 5; i++) {
      if (i) await delay(30);
      const previous = await run('window.audioPlays.length - 1');
      names.push(await run(`window.playSound('message')`));
      if(i) {
        assert.equal((await run(`window.soundState(${previous})`)).ended,false,'old message is not cut off immediately');
        await delay(35);
        const fading=await run(`window.soundState(${previous})`);
        assert.ok(fading.gain>0 && fading.gain<0.99,'previous message fades on the real AudioParam');
        await until(`window.soundState(${previous}).ended`,'old message releases its source after fading');
      }
    }
    assert.equal(new Set(names).size, 5, 'all five purrs play without repetition');
    const burstStart=await run('window.audioPlays.length');
    const burst=await run(`Promise.all(Array.from({length:8},()=>window.playSound('message')))`);
    assert.ok(burst.every(name=>/^message-purr-0[1-5]\.wav$/.test(name)),'rapid messages are never discarded by cooldown or voice limit');
    assert.equal(await run(`window.playSound('join')`),'room-join.wav','room entry is not dropped during a message burst');
    assert.equal(await run(`window.playSound('leave')`),'room-leave.wav','room exit is not dropped during a message burst');
    await until(`Array.from({length:7},(_,i)=>window.soundState(${burstStart}+i).ended).every(Boolean)`,'superseded burst sounds stop after fading');
    assert.equal((await run(`window.soundState(${burstStart}+7)`)).ended,false,'newest message keeps playing');
    for (const event of ['mute','unmute','deafen','undeafen']) {
      await delay(2200);
      assert.equal(await run(`window.playSound('${event}')`), event + '.wav');
    }
    const plays = await run('window.audioPlays');
    assert.equal(plays.length, 21, 'all twenty-one requested native audio sources start');
    assert.equal(plays[0].gain,0.5,'shared notification volume scales the selected output volume');
    assert.ok(plays[0].offset>0.1 && plays[0].offset<plays[0].seconds,'room entry skips the quiet phone-recording lead-in');
    assert.ok(plays[1].offset>0 && plays[1].offset<plays[1].seconds,'room exit starts at its audible attack');
    assert.ok(plays.every(play => play.channels >= 1 && play.channels <= 2 && play.sink === '' && play.seconds > .3 && play.seconds < 4), 'native playback uses the expected decoded assets and default sink');
    assert.deepEqual(errors, []);
    // Check packaged file:// asset resolution, independent of Vite's dev server.
    await win.loadFile(path.resolve('dist/index.html'));
    const decoded = await run(`(async()=>{const ctx=new OfflineAudioContext(1,1,48000);const results=[];for(const name of ${JSON.stringify(['mute.wav', 'unmute.wav', 'deafen.wav', 'undeafen.wav', 'room-join.wav', 'room-leave.wav', ...Array.from({length:5}, (_,i)=>`message-purr-0${i+1}.wav`)])}){const r=await fetch(new URL('./sounds/'+name,document.baseURI));if(!r.ok)throw Error(name);const b=await ctx.decodeAudioData(await r.arrayBuffer());results.push(b.duration);}return results;})()`);
    assert.equal(decoded.length, 11);
    console.log('PASS unseen-message conditions, own/history/replay/reconnect suppression, native audio playback, five purr variations, smooth message replacement, burst-safe room cues, mute settings and packaged file:// assets. Synthetic chat transport.');
    app.exit(0);
  } catch (error) { console.error(error, errors); app.exit(1); }
});
