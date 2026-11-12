const { app, BrowserWindow, session }=require('electron');
const assert=require('node:assert/strict');const path=require('node:path');const os=require('node:os');const https=require('node:https');const {randomBytes}=require('node:crypto');
const {SelfHost}=require('../electron/selfhost.cjs');
app.setPath('userData',path.join(os.tmpdir(),'pawtalk-realtime-'+process.pid));
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const testPort=Number(process.env.PAWTALK_REALTIME_PORT||31443);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const host=new SelfHost(path.resolve('resources/server'));const windows=[];
 let exitCode=0;
 try{
  const password=randomBytes(16).toString('hex');const state=await host.start({port:testPort,password,name:'Realtime QA'});console.log('Temporary voice server ready');
  const partition=session.fromPartition('realtime-'+process.pid);partition.setPermissionRequestHandler((_w,_p,cb)=>cb(true));partition.setPermissionCheckHandler(()=>true);
  partition.setCertificateVerifyProc((_req,cb)=>cb(0));
  const credentials=name=>new Promise((resolve,reject)=>{const request=https.request(`https://127.0.0.1:${testPort}/api/connect`,{method:'POST',rejectUnauthorized:false,headers:{'Content-Type':'application/json'}},res=>{let data='';res.on('data',v=>data+=v);res.on('end',()=>resolve(JSON.parse(data)));});request.on('error',reject);request.end(JSON.stringify({nickname:name,password}));});
  const until=async(fn,label)=>{for(let i=0;i<250;i++){if(await fn())return;await delay(100);}throw Error('Timeout: '+label);};
  for(const name of ['QA A','QA B']){
   const win=new BrowserWindow({show:false,webPreferences:{session:partition,sandbox:true,contextIsolation:true,offscreen:true,backgroundThrottling:false}});windows.push(win);
   await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/voice.html?cues=1');
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
    new Uint8Array([65]),{reliable:true,topic:'pawtalk.chat.v1'})))`);
  await until(()=>b('window.liveMessages>=3'),'live chat delivers the allowed burst');
  await delay(250);
  assert.equal(await b('window.liveMessages'),3,'receiving client drops excess live chat packets');
  await until(()=>a('window.roomCues.length===2 && window.roomCues.every(c=>c.energy>0.01)'),'own entry and peer entry produce native output audio');
  await until(()=>b('window.roomCues.length===1 && window.roomCues[0].energy>0.01'),'second client hears own entry');
  await until(()=>b('window.snapshot.people.some(p=>!p.local && p.avatar?.startsWith("data:image/webp;base64,"))'),'late join receives the current avatar');
  assert.equal(await b('window.snapshot.people.find(p=>!p.local).avatar'),await a('window.testAvatar'));
  await b(`window.expectedAvatar=${JSON.stringify(await a('window.testAvatar'))}`);
  await b('window.voice.setAvatar(window.expectedAvatar)');
  await a('window.voice.disconnect()');
  assert.equal(await a('window.voice.diagnostics.getSnapshot().rtt.length+window.voice.diagnostics.getSnapshot().loss.length'),0,'full disconnect clears local history');
  await until(()=>b('window.snapshot.people.length===1'),'peer leaves');
  await until(async()=>await a('window.roomCues.length===3 && window.roomCues[2].energy>0.01') && await b('window.roomCues.length===2 && window.roomCues[1].energy>0.01'),'own exit and peer exit produce native output audio');
  await a(`window.start(${JSON.stringify(await credentials('QA A'))})`);
  assert.equal(await a('window.voice.diagnostics.getSnapshot().rtt.filter(p=>p.value!==undefined).length'),0,'new session starts without previous RTT points');
  await until(()=>b('window.snapshot.people.length===2'),'peer rejoins');
  await until(async()=>await a('window.roomCues.length===4 && window.roomCues[3].energy>0.01') && await b('window.roomCues.length===3 && window.roomCues[2].energy>0.01'),'entry sounds also work after reconnect');
  await a('window.voice.updateSettings({...window.voice.settings,sounds:false})');
  await b('window.voice.updateSettings({...window.voice.settings,sounds:false})');
  console.log('PASS audible own/peer entry and exit cues through real LiveKit session events');
  await until(()=>b('window.snapshot.people.find(p=>!p.local)?.avatar===window.expectedAvatar'),'avatar after rejoin');
  await until(()=>a('window.snapshot.people.find(p=>!p.local)?.avatar===window.testAvatar'),'rejoining peer receives existing avatar');
  await a('void (window.voice.onChatRefresh=()=>{window.refreshCount=(window.refreshCount||0)+1})');
  await b('window.voice.publishChatRefresh()');
  await until(()=>a('window.refreshCount===1'),'history refresh notification reaches peer');

  // Real data-channel notification drives RoomChat; history is synthetic here.
  await b(`(async()=>{
    const {chatKey,encryptChat}=await import('/src/chat.ts');
    const secret='a'.repeat(64), feed='b'.repeat(32);
    const key=await chatKey(secret,feed);
    window.historyFixture=[];window.historyReads=0;
    window.makeMessage=async(id,text)=>({...await encryptChat(key,text),id,author:'QA A',authorId:'c'.repeat(64),sent:Date.now()});
    window.desktop={duck:async()=>{},chatRequest:async(_handle,input)=>{
      window.historyReads++;
      const page={first:window.historyFixture[0]?.id||0,messages:window.historyFixture.filter(m=>m.id>input.after)};
      if(window.holdHistory){window.holdHistory=false;await new Promise(resolve=>{window.releaseHistory=resolve});}
      return page;
    }};
    window.renderChat({identity:window.voice.room.localParticipant.identity,nickname:'QA B',key:secret,access:{handle:'test',feed,ephemeral:true}});
  })()`);
  await until(()=>b('window.historyReads>=1 && !!document.querySelector(".chat-empty")'),'initial chat history read');
  await b(`(async()=>{window.historyFixture=[await window.makeMessage(1,'Immediate message'),await window.makeMessage(2,'Grouped message')];})()`);
  const notifiedAt=Date.now();
  await a('window.voice.publishChatRefresh()');
  await until(()=>b('document.querySelectorAll(".chat-message").length===2'),'chat refresh without polling delay');
  assert.ok(Date.now()-notifiedAt<1500,'notification renders history before the 2.5 second fallback');
  console.log(`Chat notification to rendered messages: ${Date.now()-notifiedAt} ms (local synthetic history).`);
  assert.equal(await b('document.querySelectorAll(".chat-message .chat-avatar").length'),1,'consecutive author has one avatar');
  assert.equal(await b('document.querySelectorAll(".chat-message .chat-meta").length'),1,'consecutive author has one header');
  await b(`document.querySelector('.chat-message-continuation time').focus()`);
  assert.equal(await b(`getComputedStyle(document.querySelector('.chat-continuation-time')).opacity`),'1','continuation time is visible on keyboard focus');
  await require('node:fs/promises').mkdir('release/qa',{recursive:true});
  await require('node:fs/promises').writeFile('release/qa/chat-grouping.png',(await windows[1].webContents.capturePage()).toPNG());
  await b('window.holdHistory=true');
  await a('window.voice.publishChatRefresh()');
  await until(()=>b('!!window.releaseHistory'),'history request is held in flight');
  await b(`(async()=>{window.historyFixture.push(await window.makeMessage(3,'Arrived during history fetch'));})()`);
  await a('window.voice.publishChatRefresh()');
  await delay(150);
  const releasedAt=Date.now();
  await b('window.releaseHistory()');
  await until(()=>b('document.querySelectorAll(".chat-message").length===3'),'notification during fetch triggers another read');
  assert.ok(Date.now()-releasedAt<1500,'queued notification does not wait for fallback polling');
  await b('window.renderParticipants()');
  await a('window.voice.setAvatar(undefined)');
  await until(()=>b('window.snapshot.people.every(p=>p.local || p.avatar===undefined)'),'avatar removal reaches the other client');
  await until(()=>b('window.snapshot.people.some(p=>!p.local && p.rtt!==undefined)'),'peer RTT delivered over actual data channel');
  await until(()=>b('window.snapshot.people.some(p=>!p.local && Number.isFinite(p.packetLoss))'),'peer packet loss delivered over actual data channel');
  assert.ok(await b('window.snapshot.people.find(p=>!p.local).rtt>=0'));
  await until(()=>b('window.voice.diagnostics.getSnapshot().rtt.filter(p=>p.value!==undefined).length>=2 && window.voice.diagnostics.getSnapshot().loss.filter(p=>p.value!==undefined).length>=2'),'real RTC history accumulates both metrics');
  await b('window.renderParticipants()');
  await delay(100);
  await b("document.querySelector('.person-network').click()");
  await until(()=>b("document.querySelectorAll('.connection-summary .connection-chart polyline').length===1"),'local summary renders real RTT history');
  assert.ok(await b("document.querySelector('.connection-popover dd').textContent.includes('мс') && Array.from(document.querySelectorAll('.connection-popover dd')).at(-1).textContent.includes('%')"),'local tooltip includes current real RTC measurements');
  await delay(200); // Wait for the offscreen compositor before capturing the new portal.
  await require('node:fs/promises').writeFile('release/qa/connection-real-rtc.png',(await windows[1].webContents.capturePage()).toPNG());
  await b("document.querySelector('.connection-debug-button').click()");
  await until(()=>b("!!document.querySelector('dialog.connection-debug-modal[open]')"),'debug opens a real modal');
  await until(()=>b("document.querySelectorAll('.rtc-metric .connection-chart polyline').length>=2"),'debug has live RTT and loss histories');
  await b("document.querySelectorAll('[role=tab]')[1].click()");
  await until(()=>b("document.querySelector('[role=tabpanel]').textContent.includes('opus')"),'outbound tab exposes actual codec');
  assert.ok(await b('Number.isFinite(window.voice.diagnostics.getSnapshot().current.bytesSent)'),'actual outgoing RTP counters');
  assert.equal(await b("document.querySelectorAll('.rtc-metric figcaption').length"),0,'debug charts omit upper-bound labels');
  assert.ok(await b("Array.from(document.querySelectorAll('.rtc-metric-value>span')).every(node=>node.textContent.trim() && !/Недоступно|Unavailable/.test(node.textContent))"),'each real debug chart has a current metric');
  await delay(200);
  await require('node:fs/promises').writeFile('release/qa/connection-outbound-real.png',(await windows[1].webContents.capturePage()).toPNG());
  await b("document.querySelector('.connection-debug-modal .modal-heading button').click()");
  await b("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
  await until(()=>b("!document.querySelector('dialog[open]')"),'local diagnostics close');
  await b("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
  for (const [rtt, level, token] of [[80,'good','success'],[180,'warning','warning'],[450,'bad','danger'],[null,'unknown','muted']]) {
   await b('window.snapshot.people.find(p=>!p.local).rtt='+rtt+';window.renderParticipants()');await delay(80);
   assert.ok(await b("document.querySelectorAll('.person-network')[1].classList.contains('ping-"+level+"')"),'card RTT color '+level);
   const expected=await b("(()=>{const el=document.createElement('span');el.style.color='var(--"+token+")';document.body.append(el);const color=getComputedStyle(el).color;el.remove();return color})()");
   assert.equal(await b("getComputedStyle(document.querySelectorAll('.person-network')[1]).color"),expected);
  }
  for(const [language,expected] of [['ru','2,5 %'],['en','2.5 %']]) {
   await b('window.changeLanguage('+JSON.stringify(language)+')');
   await b('Object.assign(window.snapshot.people.find(p=>!p.local),{rtt:180,packetLoss:2.5});window.renderParticipants()');await delay(80);
    await b("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));document.querySelectorAll('.person-network')[1].click()");
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
 }catch(e){console.error(e);console.error(JSON.stringify(await Promise.all(windows.map(w=>w.webContents.executeJavaScript('({cues:window.roomCues,sounds:window.voice?.settings.sounds})').catch(()=>({}))))));exitCode=1;}finally{for(const win of windows){await win.webContents.executeJavaScript('window.voice?.disconnect()').catch(()=>{});win.destroy();}await host.stop();app.exit(exitCode);}
});
