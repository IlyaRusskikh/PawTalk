// Opt-in real LiveKit integration. Requires API + SFU running on loopback, and Vite on 5173.
const { app, BrowserWindow, session, net } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const serverAddress = process.env.PAWTALK_TEST_SERVER || 'http://127.0.0.1:8080';
// Container integration uses the same certificate pin as a normal invitation.
const testInvitation = process.env.PAWTALK_TEST_INVITATION && require('../electron/address.cjs').invitation(process.env.PAWTALK_TEST_INVITATION);
function pinTestServer(partition) {
 if (!testInvitation) return;
 partition.setCertificateVerifyProc((request, callback) => {
  const actual = new (require('node:crypto').X509Certificate)(request.certificate.data).fingerprint256.replaceAll(':', '').toLowerCase();
  callback(request.hostname === testInvitation.hostname ? (actual === testInvitation.fingerprint ? 0 : -2) : -3);
 });
}
app.setPath('userData',path.join(os.tmpdir(),'pawtalk-integration-'+process.pid));
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
 const lines=[];
 const record = message => { lines.push(message); console.log(message); };
 try {
  for(let i=0;i<2;i++) {
   const partition=session.fromPartition('integration-'+i);
   pinTestServer(partition);
   partition.setPermissionRequestHandler((_wc,_permission,cb)=>cb(true)); partition.setPermissionCheckHandler(()=>true);
   const win=new BrowserWindow({show:false,webPreferences:{offscreen:true,session:partition,backgroundThrottling:false,sandbox:true}});windows.push(win);
   win.webContents.on('console-message',event=>{ if(event.level === 'error') console.error('renderer:',event.message); });
   await win.loadURL('http://127.0.0.1:5173/tests/voice.html?noise='+(process.env.PAWTALK_TEST_NOISE_MODE === 'rnnoise' ? 'rnnoise' : 'off'));
   await until(()=>win.webContents.executeJavaScript('window.ready === true'),'renderer ready');
   const response=await net.fetch(`${serverAddress}/api/connect`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nickname:'same-name',password:process.env.PAWTALK_TEST_PASSWORD})});
   assert.equal(response.status,200);const data=await response.json();credentials.push(data);
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
  await a.executeJavaScript('window.voice.disconnect()');
  await until(()=>b.executeJavaScript('window.snapshot.people?.length === 1'),'participant cleanup after rejoin');
  await b.executeJavaScript('window.voice.disconnect()');
  record('PASS disconnect releases tracks and updates participant list');
  const report=process.env.PAWTALK_TEST_SERVER ? 'integration-lan.txt' : process.env.PAWTALK_TEST_NOISE_MODE === 'rnnoise' ? 'integration-rnnoise.txt' : 'integration.txt';
  await fs.mkdir(path.resolve('release/qa'),{recursive:true});await fs.writeFile(path.resolve('release/qa',report),lines.join('\n')+'\n');
  app.exit(0);
 } catch(error) {
  console.error(error);
  for(const win of windows) {
   try { console.error(await win.webContents.executeJavaScript(`(async()=>JSON.stringify({snapshot:window.snapshot,lastError:window.lastError,context:window.voice?.mic?.context?.state,track:window.voice?.localTrack?.isMuted,raw:window.voice?.mic?.stream?.getAudioTracks().map(t=>({enabled:t.enabled,state:t.readyState})),energy:await window.energy(),reports:await Promise.all([...(window.voice.room?.remoteParticipants.values()||[])].map(async p=>{const track=[...p.audioTrackPublications.values()][0]?.track;const report=await track?.getRTCStatsReport();return {subscribed:!!track,stats:report?[...report.values()].filter(s=>['inbound-rtp','outbound-rtp'].includes(s.type)):[]}}))}))()`)); } catch (debugError) { console.error('debug:', debugError.message); }
  }
  app.exit(1);
 }
});
