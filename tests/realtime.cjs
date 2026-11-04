const { app, BrowserWindow, session }=require('electron');
const assert=require('node:assert/strict');const path=require('node:path');const os=require('node:os');const https=require('node:https');const {randomBytes}=require('node:crypto');
const {SelfHost}=require('../electron/selfhost.cjs');
app.setPath('userData',path.join(os.tmpdir(),'voicecord-realtime-'+process.pid));
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.disableHardwareAcceleration();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const host=new SelfHost(path.resolve('resources/server'));const windows=[];
 try{
  const password=randomBytes(16).toString('hex');const state=await host.start({port:31443,password,name:'Realtime QA'});console.log('Temporary voice server ready');
  const partition=session.fromPartition('realtime-'+process.pid);partition.setPermissionRequestHandler((_w,_p,cb)=>cb(true));partition.setPermissionCheckHandler(()=>true);
  partition.setCertificateVerifyProc((_req,cb)=>cb(0));
  const credentials=name=>new Promise((resolve,reject)=>{const request=https.request('https://127.0.0.1:31443/api/connect',{method:'POST',rejectUnauthorized:false,headers:{'Content-Type':'application/json'}},res=>{let data='';res.on('data',v=>data+=v);res.on('end',()=>resolve(JSON.parse(data)));});request.on('error',reject);request.end(JSON.stringify({nickname:name,password}));});
  const until=async(fn,label)=>{for(let i=0;i<250;i++){if(await fn())return;await delay(100);}throw Error('Timeout: '+label);};
  for(const name of ['QA A','QA B']){
   const win=new BrowserWindow({show:false,webPreferences:{session:partition,sandbox:true,contextIsolation:true,offscreen:true,backgroundThrottling:false}});windows.push(win);
   await win.loadURL(process.env.VOICECORD_UI_TEST_URL+'/tests/voice.html');
   const js=source=>win.webContents.executeJavaScript(source,true);
   await until(()=>js('window.ready===true'),'voice fixture ready');
   const result=await credentials(name);assert.ok(result.token,'API token');await js(`window.start(${JSON.stringify(result)})`);
  }
  const a=source=>windows[0].webContents.executeJavaScript(source,true);const b=source=>windows[1].webContents.executeJavaScript(source,true);
  await until(()=>a('window.snapshot.people.length===2'),'two actual clients');
  await until(()=>b('window.snapshot.people.some(p=>!p.local && p.rtt!==undefined)'),'peer RTT delivered over actual data channel');
  assert.ok(await b('window.snapshot.people.find(p=>!p.local).rtt>=0'));
  await b('window.renderParticipants()');await delay(200);
  assert.equal(await b("document.querySelectorAll('.person-controls').length"),0,'volume controls removed from cards');
  await b("document.querySelectorAll('.person-card')[1].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:180,clientY:100}))");await delay(100);
  assert.equal(await b("!!document.querySelector('.person-menu input[type=range]')"),true,'context menu has slider');
  await b("(()=>{const el=document.querySelector('.person-menu input[type=range]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'0.5');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()");await delay(100);
  assert.equal(await b('window.changedPref.volume'),0.5,'context slider changes participant volume');
  assert.ok(await b("document.querySelectorAll('.person-network')[1].title.includes('мс')"),'participant tooltip includes peer RTT');
  await b(`window.renderGuestShare(${JSON.stringify({address:state.localAddress,password})})`);await delay(200);
  assert.ok(await b("document.querySelector('dialog input').value.includes('#password=')"),'guest can share full invitation');
  assert.equal(await b("document.querySelectorAll('.host-stop').length"),0,'guest cannot stop host');
  await b("document.querySelector('dialog [aria-label=\"Закрыть\"]').click()");
  await a('window.voice.setMute(false,true)');await until(()=>a('window.voice.localTrack.isMuted'),'deafen mutes published microphone');
  await a(`(async()=>{const {Microphone}=await import('/src/audio.ts');window.preview=new Microphone(window.voice.settings);await window.preview.start();await window.preview.startMonitor();})()`);
  assert.equal(await a('window.preview.testing && window.voice.localTrack.isMuted'),true,'local mic test leaves published microphone muted');
  await a('window.preview.stop();window.voice.rttMeter.measuredAt=-Infinity;window.voice.emit()');assert.equal(await a('window.snapshot.rtt===undefined'),true,'stale local RTT removed');
  await b('for(const item of window.voice.peerRtt.values())item.received=-Infinity;window.voice.emit()');assert.equal(await b('window.snapshot.people.filter(p=>!p.local).every(p=>p.rtt===undefined)'),true,'stale remote RTT removed');
  console.log('PASS real two-client voice session, peer RTT telemetry/expiry, microphone preview while deafened.');
 }catch(e){console.error(e);process.exitCode=1;}finally{for(const win of windows){await win.webContents.executeJavaScript('window.voice?.disconnect()').catch(()=>{});win.destroy();}await host.stop();app.exit(process.exitCode||0);}
});
