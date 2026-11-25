// Opt-in real LiveKit integration. Requires API + SFU running on loopback, and Vite on 5173.
const { app, BrowserWindow, session, net } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const api2Fixture=process.env.PAWTALK_API2_FIXTURE?JSON.parse(require('node:fs').readFileSync(process.env.PAWTALK_API2_FIXTURE,'utf8')):undefined;
const api2Clients=[];let api2Heartbeat;
const serverAddress = process.env.PAWTALK_TEST_SERVER || 'http://127.0.0.1:8080';
const uiAddress = process.env.PAWTALK_UI_TEST_URL || 'http://127.0.0.1:5173';
const mediaKey = process.env.PAWTALK_TEST_MEDIA_KEY;
if(mediaKey && !/^[a-f0-9]{64}$/.test(mediaKey))throw Error('Invalid synthetic media key');
const encryption = mediaKey ? {e2ee:true,e2eeKeyId:require('node:crypto').createHash('sha256').update(Buffer.from(mediaKey,'hex')).digest('hex')} : {};
// Container integration uses the same certificate pin as a normal invitation.
const testInvitation = process.env.PAWTALK_TEST_INVITATION && require('../../apps/client/windows/electron/address.cjs').invitation(process.env.PAWTALK_TEST_INVITATION);
function pinTestServer(partition) {
 if (!testInvitation) return;
 partition.setCertificateVerifyProc((request, callback) => {
  const actual = new (require('node:crypto').X509Certificate)(request.certificate.data).fingerprint256.replaceAll(':', '').toLowerCase();
  callback(request.hostname === testInvitation.hostname ? (actual === testInvitation.fingerprint ? 0 : -2) : -3);
 });
}
app.setPath('userData',api2Fixture?.profile||path.join(os.tmpdir(),'pawtalk-integration-'+process.pid));
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
if (process.env.PAWTALK_TEST_AUDIO_FILE) app.commandLine.appendSwitch('use-file-for-fake-audio-capture',path.resolve(process.env.PAWTALK_TEST_AUDIO_FILE));
app.disableHardwareAcceleration();
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(fn, label, timeout = 20000) {
 const end=Date.now()+timeout;
 while(Date.now()<end) { if(await fn()) return; await wait(100); }
 throw new Error('Timed out: '+label);
}
app.whenReady().then(async () => {
 pinTestServer(session.defaultSession);
 const windows=[];
 const credentials=[];
 const firstVoiceEpoch = api2Fixture ? { epochId: randomBytes(16).toString('hex'), expiresAt: Date.now()+90000 } : undefined;
 const lines=[];
 const record = message => { lines.push(message); console.log(message); };
 const grant=async index=>{
  const client=api2Clients[index],state=await client.state(api2Fixture.serverId);
  const access=await client.voice(state.serverId,state.channels.find(channel=>channel.kind==='voice').id);
  return {...access,e2eeKey:access.key,voiceEpoch:firstVoiceEpoch};
 };
 const closeAPI2=async()=>{clearInterval(api2Heartbeat);await Promise.all(api2Clients.map(client=>client.request(api2Fixture.serverId,'/api/v2/voice/leave','POST',{}).catch(()=>{})));};
 try {
  if(api2Fixture){
   const {createClient}=require('../../apps/client/windows/tests/membership-electron-client.cjs');
   for(const directory of ['credentials','guest-credentials']){const client=createClient(path.join(api2Fixture.profile,directory));const saved=(await client.registry())[0];assert.equal(saved.serverId,api2Fixture.serverId);await client.connect({...saved,address:api2Fixture.address});api2Clients.push(client);}
   api2Heartbeat=setInterval(()=>{for(const client of api2Clients)for(const endpoint of ['/api/v2/heartbeat','/api/v2/voice/heartbeat'])void client.request(api2Fixture.serverId,endpoint,'POST',{}).catch(()=>{});},15000);
  }
  for(let i=0;i<2;i++) {
   const partition=session.fromPartition('integration-'+i);
   pinTestServer(partition);
   partition.setPermissionRequestHandler((_wc,_permission,cb)=>cb(true)); partition.setPermissionCheckHandler(()=>true);
   const win=new BrowserWindow({show:false,webPreferences:{offscreen:true,session:partition,backgroundThrottling:false,sandbox:true}});windows.push(win);
   win.webContents.on('console-message',event=>{ if(event.level === 'error') console.error('renderer:',event.message); });
   await win.loadURL(uiAddress+'/tests/voice.html?noise='+(process.env.PAWTALK_TEST_NOISE_MODE === 'rnnoise' ? 'rnnoise' : 'off'));
   await until(()=>win.webContents.executeJavaScript('window.ready === true'),'renderer ready');
   let data;
   if(api2Fixture)data=await grant(i);
   else{const response=await net.fetch(`${serverAddress}/api/connect`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nickname:'same-name',password:process.env.PAWTALK_TEST_PASSWORD,...encryption})});assert.equal(response.status,200);data=await response.json();if(mediaKey)data.e2eeKey=mediaKey;}
   credentials.push(data);
   await win.webContents.executeJavaScript(`window.start(${JSON.stringify(data)})`,true);
  }
  const [a,b]=windows.map(w=>w.webContents);
  await until(async()=>await a.executeJavaScript('window.snapshot.people?.length === 2') && await b.executeJavaScript('window.snapshot.people?.length === 2'),'both participants');
  record('PASS two clients, duplicate nicknames, actual Go token and LiveKit SFU');
  await until(async()=>(await b.executeJavaScript('window.energy()')).energy>0 && (await a.executeJavaScript('window.energy()')).energy>0,'bidirectional Opus audio');
  record('PASS real bidirectional RTP with nonzero decoded audio energy');
  if (process.env.PAWTALK_TEST_NOISE_MODE === 'rnnoise') {
   assert.equal(await a.executeJavaScript('window.voice.mic.stream.getAudioTracks()[0].getSettings().noiseSuppression'),false);
   const before=(await b.executeJavaScript('window.energy()')).energy;
   await a.executeJavaScript(`window.voice.updateSettings({...window.voice.settings,inputMode:'voice',autoSensitivity:true})`);
   await until(async()=>(await b.executeJavaScript('window.energy()')).energy>before+0.00001,'neural voice activation');
   await a.executeJavaScript(`window.voice.updateSettings({...window.voice.settings,inputMode:'ptt'});window.voice.setPtt(true)`);
   record('PASS RNNoise retains speech, neural VAD opens, browser noise suppression disabled');
  }
  await b.executeJavaScript(`(()=>{const id=[...window.voice.room.remoteParticipants.keys()][0];window.voice.setPerson(id,2,false)})()`);
  await wait(100);
  assert.equal(await b.executeJavaScript('[...window.voice.mixers.values()][0].track.getVolume()'),2);
  await b.executeJavaScript('window.voice.setMute(false,true)');
  await wait(100);
  assert.equal(await b.executeJavaScript('[...window.voice.mixers.values()][0].track.getVolume()'),0);
  await b.executeJavaScript('window.voice.setMute(false,false)');
  await wait(100);
  assert.equal(await b.executeJavaScript('[...window.voice.mixers.values()][0].track.getVolume()'),2);
  record('PASS 200% per-participant gain and deafen restore in playback graph');
  const level = async volume => {
    await b.executeJavaScript(`window.voice.setPerson([...window.voice.room.remoteParticipants.keys()][0],${volume},false)`);
    // LiveKit smooths gain with a 100 ms time constant. Wait on the audio
    // clock so a busy/offscreen renderer cannot measure the transition.
    await b.executeJavaScript(`new Promise(resolve=>{const end=window.voice.playback.currentTime+1.2;const timer=setInterval(()=>{if(window.voice.playback.currentTime>=end){clearInterval(timer);resolve();}},20);})`);
    return b.executeJavaScript('window.outputGain()');
  };
  const full = await level(1), quarter = await level(0.25), double = await level(2), silent = await level(0);
  assert.ok(full > 0.9 && full < 1.1, `100% output ratio ${full}`);
  assert.ok(quarter > 0.2 && quarter < 0.3, `25% output ratio ${quarter}`);
  assert.ok(double > 1.8 && double < 2.2, `200% output ratio ${double}`);
  assert.ok(silent < full * 0.001, `0% output ${silent}`);
  await level(1);
  record('PASS actual decoded playback samples at 0%, 25%, 100%, 200%; no HTML playback bypass');
  assert.equal(await a.executeJavaScript('window.tryCamera()'),true);
  record('PASS microphone-only token rejects camera publication at SFU');
  const bad = {...credentials[0],token:credentials[0].token.replace(/\.[^.]+$/,'.invalid-signature')};
  assert.equal(await a.executeJavaScript(`window.tryToken(${JSON.stringify(bad)})`),true);
  record('PASS SFU rejects token with invalid signature');
  await a.executeJavaScript('window.voice.setMute(true,false)');
  await wait(1000);
  const mutedBefore=await b.executeJavaScript('window.energy()');await wait(1200);const mutedAfter=await b.executeJavaScript('window.energy()');
  assert.ok(mutedAfter.energy-mutedBefore.energy<0.000001,`muted energy leaked: ${mutedAfter.energy-mutedBefore.energy}`);
  record('PASS mute stops incoming speech energy');
  await a.executeJavaScript('window.voice.setMute(false,false); window.voice.setPtt(true)');
  await until(async()=>(await b.executeJavaScript('window.energy()')).energy>mutedAfter.energy+0.000001,'unmute resumes');
  await a.executeJavaScript('window.voice.setPtt(false)');await wait(1000);
  const pttBefore=await b.executeJavaScript('window.energy()');await wait(1200);const pttAfter=await b.executeJavaScript('window.energy()');
  assert.ok(pttAfter.energy-pttBefore.energy<0.000001,`released PTT leaked: ${pttAfter.energy-pttBefore.energy}`);
  record('PASS released PTT stops incoming speech energy');
  await a.executeJavaScript('window.voice.disconnect()');
  await until(()=>b.executeJavaScript('window.snapshot.people?.length === 1'),'participant cleanup');
  if(api2Fixture)credentials[0]=await grant(0);
  await a.executeJavaScript(`window.start(${JSON.stringify(credentials[0])})`,true);
  await until(async()=>await a.executeJavaScript('window.snapshot.people?.length === 2') && await b.executeJavaScript('window.snapshot.people?.length === 2'),'participants after rejoin');
  await until(async()=>(await b.executeJavaScript('window.energy()')).energy>0,'audio after rejoin');
  record('PASS participant rejoin rebuilds playback graph and resumes audio');
  assert.equal(await a.executeJavaScript('window.voice.mic.context === window.voice.playback'),true);
  await a.executeJavaScript('window.voice.mic.stop()');
  assert.equal(await a.executeJavaScript('window.voice.playback.state'),'running');
  assert.ok(await a.executeJavaScript('window.outputRMS()')>0.001,'remote playback survives stopping local mic');
  await a.executeJavaScript('window.voice.replaceMicrophone(window.voice.generation)');
  assert.equal(await a.executeJavaScript('window.voice.mic.context === window.voice.playback'),true);
  const replacedBefore=await b.executeJavaScript('window.energy()');
  await until(async()=>(await b.executeJavaScript('window.energy()')).energy>replacedBefore.energy+0.000001,'audio after microphone replacement');
  record('PASS shared AudioContext survives mic stop/replacement and retains remote playback');
  if (api2Fixture && await a.executeJavaScript('window.snapshot.canShareScreenAudio === true')) {
    try {
      await a.executeJavaScript('window.startScreenFixture()',true);
      await until(() => b.executeJavaScript('window.voice.screenMixers.size && window.snapshot.screens.some(s => !s.local && s.track && s.hasAudio)'),
        'second client receives encrypted screen video and audio');
      await b.executeJavaScript(`(() => {
        const screen=window.snapshot.screens.find(s=>!s.local);
        const video=document.createElement('video');video.muted=true;video.autoplay=true;
        screen.track.attach(video);document.body.append(video);window.screenFixtureVideo=video;
      })()`);
      await until(() => b.executeJavaScript('window.screenFixtureVideo.videoWidth === 480'), 'remote screen decodes frames');
      await a.executeJavaScript('window.screenFixtureMinimized = true');
      await until(() => b.executeJavaScript('window.snapshot.screens.some(s => !s.local && s.minimized)'), 'second client receives the minimized window state');
      await a.executeJavaScript('window.screenFixtureMinimized = false');
      await until(() => b.executeJavaScript('window.snapshot.screens.some(s => !s.local && !s.minimized)'), 'second client returns to the same video after restore');
      const screenGain = () => b.executeJavaScript('[...window.voice.screenMixers.values()][0].gain.gain.value');
      assert.equal(await screenGain(),0,'overview starts with screen audio muted');
      await Promise.all([a, b].map(win => win.executeJavaScript('window.showScreenCall(true)')));
      await until(() => b.executeJavaScript('!!document.querySelector(".dev-stream-volume-button")'), 'focused viewer has stream controls');
      await until(() => a.executeJavaScript('!!document.querySelector(".dev-stream-picture video")'), 'presenter sees the own stream preview');
      const ownAudio = await a.executeJavaScript(`(() => {
        const voice = window.voice;
        const local = voice.room.localParticipant;
        voice.setScreenListening(local.identity, 2);
        return [Boolean(local.getTrackPublication('screen_share_audio')), Boolean(voice.screenListening),
          voice.screenMixers.size, document.querySelector('.dev-stream-picture video').muted,
          Boolean(document.querySelector('.dev-stream-volume-button'))];
      })()`);
      assert.deepEqual(ownAudio, [true, false, 0, true, false], 'published system audio never loops into the presenter preview or output');
      const button = '.dev-stream-volume-button';
      const range = '.dev-stream-volume input';
      assert.equal(await b.executeJavaScript(`getComputedStyle(document.querySelector('${range}')).visibility`), 'hidden');
      b.debugger.attach();
      try {
        for (const selector of ['.dev-stream-picture', button]) {
          const point = await b.executeJavaScript(`(() => { const rect = document.querySelector('${selector}').getBoundingClientRect();
            return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
          await b.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        }
      } finally { b.debugger.detach(); }
      await until(() => b.executeJavaScript(`getComputedStyle(document.querySelector('${range}')).visibility === 'visible'`), 'hovering the sound button reveals the slider');
      await b.executeJavaScript(`(() => {
        const slider = document.querySelector('${range}');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '1.6');
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await until(async () => Math.abs(await screenGain() - 1.6) < 0.001, 'focused stream slider controls its independent output');
      await b.executeJavaScript(`document.querySelector('${button}').click()`);
      await until(() => b.executeJavaScript(`document.querySelector('${range}').disabled && document.querySelector('${range}').value === '1.6'`), 'mute disables the slider and preserves its position');
      assert.equal(await screenGain(),0,'muting the stream does not change voice gain');
      await b.executeJavaScript(`document.querySelector('${button}').click()`);
      await until(async () => Math.abs(await screenGain() - 1.6) < 0.001, 'unmute restores the saved volume');
      await b.executeJavaScript('window.voice.setMute(false,true)');
      assert.equal(await screenGain(),0,'deafen applies to screen audio');
      await b.executeJavaScript('window.voice.setMute(false,false);window.showScreenCall(false)');
      await until(async () => await screenGain() === 0, 'leaving the focused view silences the stream');
      assert.ok(await b.executeJavaScript('[...window.voice.mixers.values()].some(m => m.track.getVolume()>0)'),
        'screen focus leaves ordinary voice playback active');
    } finally {
      await Promise.all([a, b].map(win => win.executeJavaScript('window.showScreenCall(false)')));
      await a.executeJavaScript('window.stopScreenFixture?.()');
    }
    await until(() => b.executeJavaScript('window.snapshot.screens.length === 0'), 'screen unpublication reaches the viewer');
    record('PASS second Electron client plays encrypted stream audio through viewer controls and presenter preview stays silent');
  }
  if (firstVoiceEpoch) {
    const next = { epochId: randomBytes(16).toString('hex'), key: randomBytes(32).toString('hex'), expiresAt: Date.now()+90000 };
    const rotate = `window.voice.rotateProtectedVoiceKey(${JSON.stringify(firstVoiceEpoch.epochId)},${JSON.stringify(next)})`;
    for (const client of [a,b]) await client.executeJavaScript('window.beforeRotation = { room: window.voice.room, mic: window.voice.mic }; undefined');
    await a.executeJavaScript(`window.nextVoiceKey = ${JSON.stringify(next)}; undefined`);
    await until(() => a.executeJavaScript(`window.voice.protectedEpoch?.epochId === ${JSON.stringify(next.epochId)}`), 'automatic first key refresh');
    await wait(1300);
    const stale = await b.executeJavaScript('window.energy()');
    await wait(1100);
    const stillStale = await b.executeJavaScript('window.energy()');
    assert.ok(stillStale.bytes > stale.bytes, 'encrypted RTP continues arriving during rotation');
    assert.ok(stillStale.energy - stale.energy < 0.000001, 'old key decoded audio after rotation');
    const beforeA = await a.executeJavaScript('window.energy()');
    await b.executeJavaScript(`window.nextVoiceKey = ${JSON.stringify(next)}; undefined`);
    await until(async () => (await b.executeJavaScript('window.energy()')).energy > stillStale.energy + 0.000001 &&
      (await a.executeJavaScript('window.energy()')).energy > beforeA.energy + 0.000001, 'bidirectional audio after key rotation');
    for (const client of [a,b]) {
      assert.equal(await client.executeJavaScript('window.voice.room === window.beforeRotation.room && window.voice.mic === window.beforeRotation.mic && window.voice.ptt && !window.voice.muted'),true);
      assert.equal(await client.executeJavaScript(`(async()=>{try{await ${rotate};return false}catch{return true}})()`),true);
    }
    record('PASS rotating E2EE in the open room drops stale-key audio and restores bidirectional audio without resetting PTT');
    const fresh = { ...await grant(0), key: next.key, epoch: { epochId: next.epochId, expiresAt: next.expiresAt } };
    assert.notEqual(fresh.token, credentials[0].token);
    await a.executeJavaScript(`window.nextVoiceGrant = ${JSON.stringify(fresh)}; undefined`);
    await a.executeJavaScript("window.voice.room.simulateScenario('full-reconnect')");
    await until(() => a.executeJavaScript("window.grantRequests === 1 && window.snapshot.state === 'connected' && window.voice.room !== window.beforeRotation.room && window.voice.ptt"), 'reconnect with a fresh application grant');
    const afterReconnect = await b.executeJavaScript('window.energy()');
    await until(async () => (await b.executeJavaScript('window.energy()')).energy > afterReconnect.energy + 0.000001,
      'audio after fresh-grant reconnect');
    record('PASS a signaling failure requests a fresh application grant and restores encrypted audio with PTT preserved');
  }
  await a.executeJavaScript('window.voice.disconnect()');
  await until(()=>b.executeJavaScript('window.snapshot.people?.length === 1'),'participant cleanup after rejoin');
  await b.executeJavaScript('window.voice.disconnect()');
  record('PASS disconnect releases tracks and updates participant list');
  const report=process.env.PAWTALK_TEST_SERVER ? 'integration-lan.txt' : process.env.PAWTALK_TEST_NOISE_MODE === 'rnnoise' ? 'integration-rnnoise.txt' : 'integration.txt';
  await fs.mkdir(path.resolve('release/qa'),{recursive:true});await fs.writeFile(path.resolve('release/qa',report),lines.join('\n')+'\n');
  await closeAPI2();app.exit(0);
 } catch(error) {
  console.error(error);
  for(const win of windows) {
   try { console.error(await win.webContents.executeJavaScript(`(async()=>JSON.stringify({snapshot:window.snapshot,lastError:window.lastError,context:window.voice?.mic?.context?.state,track:window.voice?.localTrack?.isMuted,raw:window.voice?.mic?.stream?.getAudioTracks().map(t=>({enabled:t.enabled,state:t.readyState})),energy:await window.energy(),reports:await Promise.all([...(window.voice.room?.remoteParticipants.values()||[])].map(async p=>{const track=[...p.audioTrackPublications.values()][0]?.track;const report=await track?.getRTCStatsReport();return {subscribed:!!track,stats:report?[...report.values()].filter(s=>['inbound-rtp','outbound-rtp'].includes(s.type)):[]}}))}))()`)); } catch (debugError) { console.error('debug:', debugError.message); }
  }
  await closeAPI2();app.exit(1);
 }
});
