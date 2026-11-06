const { app, BrowserWindow, session }=require('electron');
const assert=require('node:assert/strict');const path=require('node:path');const os=require('node:os');const https=require('node:https');const {randomBytes}=require('node:crypto');
const {SelfHost}=require('../electron/selfhost.cjs');
app.setPath('userData',path.join(os.tmpdir(),'voicecord-realtime-'+process.pid));
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.disableHardwareAcceleration();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const host=new SelfHost(path.resolve('resources/server'));const windows=[];
 let exitCode=0;
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
   if(name==='QA A') {
    const avatarInfo=await js(`(()=>{
     const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
     const context=canvas.getContext('2d',{alpha:false});context.fillStyle='#7a559b';context.fillRect(0,0,128,128);
     window.testAvatar=canvas.toDataURL('image/webp',0.8);window.voice.setAvatar(window.testAvatar);
     return { accepted: !!window.snapshot.people.find(p=>p.local)?.avatar, header:Array.from(atob(window.testAvatar.split(',')[1]).slice(0,32), b=>b.charCodeAt(0)) };
    })()`);
    assert.ok(avatarInfo.accepted,JSON.stringify(avatarInfo));
   }
  }
  const a=source=>windows[0].webContents.executeJavaScript(source,true);const b=source=>windows[1].webContents.executeJavaScript(source,true);
  await until(()=>a('window.snapshot.people.length===2'),'two actual clients');
  await b('void (window.voice.onTyping=(identity,active)=>{window.lastTyping={identity,active}})');
  await a('window.voice.publishTyping(window.voice.room.localParticipant.identity,true)');
  await until(()=>b('window.lastTyping?.active===true'),'typing start reaches the other client');
  assert.equal(await b('window.lastTyping.identity'),await a('window.voice.room.localParticipant.identity'));
  await a('window.voice.publishTyping(window.voice.room.localParticipant.identity,false)');
  await until(()=>b('window.lastTyping?.active===false'),'typing stop reaches the other client');
  await b('void (window.voice.onChat=()=>{window.liveMessages=(window.liveMessages||0)+1})');
  await a(`Promise.all(Array.from({length:4},()=>window.voice.room.localParticipant.publishData(
    new Uint8Array([65]),{reliable:true,topic:'voicecord.chat.v1'})))`);
  await until(()=>b('window.liveMessages>=3'),'live chat delivers the allowed burst');
  await delay(250);
  assert.equal(await b('window.liveMessages'),3,'receiving client drops excess live chat packets');
  await until(()=>b('window.snapshot.people.some(p=>!p.local && p.avatar?.startsWith("data:image/webp;base64,"))'),'late join receives the current avatar');
  assert.equal(await b('window.snapshot.people.find(p=>!p.local).avatar'),await a('window.testAvatar'));
  await a('window.voice.setAvatar(undefined)');
  await until(()=>b('window.snapshot.people.every(p=>p.local || p.avatar===undefined)'),'avatar removal reaches the other client');
  await until(()=>b('window.snapshot.people.some(p=>!p.local && p.rtt!==undefined)'),'peer RTT delivered over actual data channel');
  await until(()=>b('window.snapshot.people.some(p=>!p.local && Number.isFinite(p.packetLoss))'),'peer packet loss delivered over actual data channel');
  assert.ok(await b('window.snapshot.people.find(p=>!p.local).rtt>=0'));
  for (const [rtt, level, color] of [[80,'good','rgb(126, 212, 172)'],[180,'warning','rgb(229, 189, 100)'],[450,'bad','rgb(238, 130, 149)'],[null,'unknown','rgb(133, 143, 163)']]) {
   await b('window.snapshot.people.find(p=>!p.local).rtt='+rtt+';window.renderParticipants()');await delay(80);
   assert.ok(await b("document.querySelectorAll('.person-network')[1].classList.contains('ping-"+level+"')"),'card RTT color '+level);
   assert.equal(await b("getComputedStyle(document.querySelectorAll('.person-network')[1]).color"),color);
  }
  for(const [language,expected] of [['ru','2,5 %'],['en','2.5 %']]) {
   await b('window.changeLanguage('+JSON.stringify(language)+')');
   await b('Object.assign(window.snapshot.people.find(p=>!p.local),{rtt:180,packetLoss:2.5});window.renderParticipants()');await delay(80);
    await b("document.querySelectorAll('.person-network')[1].click()");
    await until(()=>b("document.querySelectorAll('.connection-popover dd').length===2"),'connection tooltip opens');
   assert.equal(await b("document.querySelectorAll('.connection-popover dd')[1].textContent"),expected);
  }
  await b("window.changeLanguage('ru')");
  await b('window.snapshot.people.find(p=>!p.local).rtt=180;window.renderParticipants()');await delay(200);
  await require('node:fs/promises').writeFile('release/qa/participant-ping-colors.png',(await windows[1].webContents.capturePage()).toPNG());
  assert.equal(await b("document.querySelectorAll('.person-controls').length"),0,'volume controls removed from cards');
  await b("document.querySelectorAll('.person-card')[1].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:180,clientY:100}))");await delay(100);
  assert.equal(await b("!!document.querySelector('.person-menu input[type=range]')"),true,'context menu has slider');
  await b("(()=>{const el=document.querySelector('.person-menu input[type=range]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'0.5');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()");await delay(100);
  assert.equal(await b('window.changedPref.volume'),0.5,'context slider changes participant volume');
  await b("document.querySelectorAll('.person-network')[1].click()");
  await until(()=>b("document.querySelector('.connection-popover dd')?.textContent.includes('мс')"),'participant tooltip includes peer RTT');
  await b(`window.renderGuestShare(${JSON.stringify({address:state.localAddress,password})})`);await delay(200);
  assert.ok(await b("document.querySelector('dialog input').value.includes('#password=')"),'guest can share full invitation');
  assert.equal(await b("document.querySelectorAll('.host-stop').length"),0,'guest cannot stop host');
  await b("document.querySelector('dialog [aria-label=\"Закрыть\"]').click()");
  await a('window.voice.setMute(false,true)');await until(()=>a('window.voice.localTrack.isMuted'),'deafen mutes published microphone');
  await until(()=>b('window.snapshot.people.some(p=>!p.local && p.deafened && p.muted)'),'remote deafen state delivered over data channel');
  await b('window.renderParticipants()');await delay(150);
  assert.equal(await b("document.querySelectorAll('.person-card')[1].querySelectorAll('.person-status-icons svg').length"),2,'remote card shows crossed-out mic and headphones');
  assert.equal(await b("/Говорит|Слушает|Микрофон выкл|Звук выключен/.test(document.querySelectorAll('.person-card')[1].textContent)"),false,'no textual status on card');
  const fs=require('node:fs/promises');await fs.mkdir('release/qa',{recursive:true});await fs.writeFile('release/qa/participant-icons.png',(await windows[1].webContents.capturePage()).toPNG());
  await a('window.voice.setMute(false,false)');
  await until(()=>b('window.snapshot.people.some(p=>!p.local && !p.deafened && !p.muted)'),'unmute clears remote indicators');
  await b('window.renderParticipants()');await delay(150);
  await b("document.querySelectorAll('.person-card')[1].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:180,clientY:100}))");await delay(100);
  await b("document.querySelector('.person-menu input[type=checkbox]').click()");await delay(100);
  assert.equal(await b("document.querySelectorAll('.person-card')[1].querySelectorAll('.person-status-icons svg').length"),1,'local mute has its own headphones icon');
  await a('window.voice.setMute(false,true)');await until(()=>a('window.voice.localTrack.isMuted'),'restore deafen');
  await a(`(async()=>{const {Microphone}=await import('/src/audio.ts');window.preview=new Microphone(window.voice.settings);await window.preview.start();await window.preview.startMonitor();})()`);
  assert.equal(await a('window.preview.testing && window.voice.localTrack.isMuted'),true,'local mic test leaves published microphone muted');
  await a('window.preview.stop();window.voice.rttMeter.measuredAt=-Infinity;window.voice.emit()');assert.equal(await a('window.snapshot.rtt===undefined'),true,'stale local RTT removed');
  await b('for(const item of window.voice.peerNetwork.values())item.received=-Infinity;window.voice.emit()');assert.equal(await b('window.snapshot.people.filter(p=>!p.local).every(p=>p.rtt===undefined && p.packetLoss===undefined)'),true,'stale remote metrics removed');
  console.log('PASS real two-client voice session, typing status, live chat rate limit, peer telemetry/expiry, remote deafen, icon-only card states, local mute, microphone preview.');
 }catch(e){console.error(e);exitCode=1;}finally{for(const win of windows){await win.webContents.executeJavaScript('window.voice?.disconnect()').catch(()=>{});win.destroy();}await host.stop();app.exit(exitCode);}
});
