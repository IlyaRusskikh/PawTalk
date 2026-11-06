// Real production main/preload + built renderer + file-loaded E2EE worker.
const {app}=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');
const {randomBytes}=require('node:crypto');
app.setPath('userData',path.join(os.tmpdir(),'voicecord-e2ee-main-'+process.pid));
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.disableHardwareAcceleration();process.argv.push('--smoke','--offscreen-smoke');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(const end=Date.now()+60000;Date.now()<end;){if(await fn())return;await delay(150);}throw Error('Timeout: '+label);}
let handled=false;
app.on('browser-window-created',(_e,win)=>{
 if(handled)return;handled=true;
 win.webContents.once('did-finish-load',async()=>{
  win.webContents.on('console-message',event=>{if(event.level==='error')console.error('renderer:',event.message);});
  const js=code=>win.webContents.executeJavaScript(`(async()=>{try{return await (${code});}catch(e){console.error(e.stack);throw e;}})()`,true);
  let remoteHost;
  try {
   await until(()=>js('!!document.querySelector(".home-actions")'),'app ready');
   await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith('Создать комнату')).click()`);
   await until(()=>js('!!document.querySelector(".encryption-toggle")'),'host form');
   const password=randomBytes(18).toString('hex');
   await js(`(()=>{const inputs=document.querySelector('dialog form').querySelectorAll('input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [i,value] of ${JSON.stringify([[0,'E2EE QA'],[1,password],[2,'34443']])}){set.call(inputs[i],value);inputs[i].dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('.encryption-toggle input').click();})()`);
   await delay(200);await js(`document.querySelector('dialog form').requestSubmit()`);
   await until(()=>js(`!!document.querySelector('.e2ee-badge') && document.querySelectorAll('.person-card').length===1`),'real encrypted room from checkbox');
   await js(`document.querySelector('dialog [aria-label="Закрыть"]').click()`);
   await js(`document.querySelector('[title="Добавить в закладки"]').click()`);
   await until(()=>js('!!document.querySelector(".bookmark-orb")'),'bookmark saved');
   assert.equal(await js('document.querySelector(".participant-pin").textContent'),'1');
   assert.equal(await js('document.querySelector(".bookmark-add").getAttribute("aria-pressed")'),'true');
   await js(`document.querySelector('.bookmark-add').click()`);await delay(100);
   assert.equal(await js('document.querySelectorAll(".bookmark-orb").length'),0);
   assert.equal(await js('document.querySelector(".bookmark-add").getAttribute("aria-pressed")'),'false');
   await js(`document.querySelector('.bookmark-add').click()`);await delay(100);
   assert.equal(await js('document.querySelector(".bookmark-add").classList.contains("bookmarked")'),true);
   assert.equal(await js('document.querySelectorAll(".room-title button").length'),1,'no rename pencil beside title');
   await js(`document.querySelector('.bookmark-orb').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:30,clientY:120}))`);await delay(100);
   await js(`document.querySelector('.bookmark-menu button').click()`);
   await js(`(()=>{const el=document.querySelector('dialog input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'Renamed room');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   await delay(100);await js(`document.querySelector('dialog form').requestSubmit()`);await delay(100);
   assert.equal(await js('document.querySelector("h1").textContent'),'Renamed room');
   assert.equal(await js('document.querySelector(".bookmark-orb").title'),'Renamed room');
   await js(`document.querySelector('.home-orb').click()`);await delay(100);
   assert.ok(await js('!!document.querySelector(".home-actions")'));
   assert.ok(await js(`!!document.querySelector('[title="Отключиться"]')`),'voice stays connected in lobby');
   // Deleting saved credentials makes any unintended reconnect fail visibly.
   const address=await js('JSON.parse(localStorage.getItem("voicecord.bookmarks"))[0].address');
   await js(`window.desktop.savePassword(${JSON.stringify({address,password:null})})`);
   await js(`document.querySelector('.bookmark-orb').click()`);await delay(300);
   assert.equal(await js('document.querySelector("h1").textContent'),'Renamed room');
   assert.equal(await js('document.querySelectorAll("dialog[open]").length'),0,'active bookmark requires no credentials or reconnect');
   assert.equal(await js('document.querySelectorAll(".person-card").length'),1);
   for(const label of ['Устройство ввода','Устройство вывода']) {
    await js(`document.querySelector('[title="${label}"]').click()`);await delay(100);
    assert.equal(await js('document.querySelectorAll(".audio-quick-menu:popover-open").length'),1);
    await js(`(()=>{const el=document.querySelector('.audio-quick-menu:popover-open input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'0.5');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(100);
    const deviceKey=label==='Устройство ввода'?'inputDevice':'outputDevice';
    const device=await js(`navigator.mediaDevices.enumerateDevices().then(devices=>devices.find(device=>device.kind===${JSON.stringify(deviceKey==='inputDevice'?'audioinput':'audiooutput')} && device.deviceId && !['default','communications'].includes(device.deviceId)).deviceId)`);
    await js(`document.querySelector('.audio-quick-menu:popover-open .audio-device-trigger').click()`);await delay(100);
    assert.equal(await js('document.querySelectorAll(".audio-device-list:popover-open [aria-pressed=true]").length'),1);
    assert.ok(await js(`(()=>{const a=document.querySelector('.audio-quick-menu:popover-open').getBoundingClientRect();const b=document.querySelector('.audio-device-list:popover-open').getBoundingClientRect();return b.left>=a.right && b.right<=innerWidth && b.bottom<=innerHeight;})()`), 'device list opens beside the menu inside the viewport');
    await js(`document.querySelectorAll('.audio-device-list:popover-open .audio-device-option')[1].click()`);await delay(300);
    assert.equal(await js(`JSON.parse(localStorage.getItem('voicecord.settings')).${deviceKey}`),device);
    assert.equal(await js('document.querySelectorAll(".audio-quick-menu:popover-open").length'),1,'device selection keeps volume controls open');
    assert.equal(await js('document.querySelectorAll(".audio-device-list:popover-open").length'),0);
    const key=label==='Устройство ввода'?'inputGain':'outputVolume';
    assert.equal(await js(`JSON.parse(localStorage.getItem('voicecord.settings')).${key}`),0.5);
   }
   const fs=require('node:fs/promises');await fs.mkdir(path.resolve('release/qa'),{recursive:true});
   await js(`document.querySelector('.audio-quick-menu:popover-open .audio-device-trigger').click()`);await delay(100);
   assert.equal(await js(`document.querySelector('.audio-device-list:popover-open .audio-device-option[aria-pressed=true]')===document.querySelectorAll('.audio-device-list:popover-open .audio-device-option')[1]`),true,'reopening highlights the selected device');
   await fs.writeFile(path.resolve('release/qa/room-quick-audio.png'),(await win.webContents.capturePage()).toPNG());
   await js(`document.querySelector('.audio-quick-menu:popover-open').hidePopover()`);
   assert.equal(await js('window.desktop.getAutoStart()'),false,'development app never registers startup');
   const state=await js('window.desktop.hostStatus()');assert.equal(state.e2ee,true);assert.match(state.localAddress,/e2ee=[a-f0-9]{64}/);
   assert.equal(await js(`window.desktop.roomPresence(${JSON.stringify(state.localAddress)})`),1,'real LiveKit aggregate occupancy');
   const response=await js(`window.desktop.connect(${JSON.stringify({address:state.localAddress,nickname:'IPC QA',password})})`);
   assert.equal(response.error,undefined,response.error);assert.equal(response.e2eeRequired,true);assert.match(response.e2eeKey,/^[a-f0-9]{64}$/);
   const {invitation}=require('../electron/address.cjs');assert.equal(response.e2eeKey,invitation(state.localAddress).e2eeKey);
   const missing=state.localAddress.replace(/&e2ee=[a-f0-9]{64}/,'');
   const denied=await js(`window.desktop.connect(${JSON.stringify({address:missing,nickname:'Legacy',password})})`);assert.ok(denied.error);
   const caps=await js('window.desktop.capabilities()');
   if(caps.secureStorage){
    await js(`window.desktop.savePassword(${JSON.stringify({address:state.localAddress.split('#')[0],password,e2eeKey:response.e2eeKey})})`);
    const saved=await js(`window.desktop.loadPassword(${JSON.stringify(state.localAddress.split('#')[0])})`);assert.equal(saved.e2eeKey,response.e2eeKey);
    await js(`window.desktop.savePassword(${JSON.stringify({address:state.localAddress.split('#')[0],password:null})})`);
    assert.equal((await js(`window.desktop.loadPassword(${JSON.stringify(state.localAddress.split('#')[0])})`)).e2eeKey,null);
   }
   // A second local server models the VPS while the built-in host keeps running.
   const {SelfHost}=require('../electron/selfhost.cjs');remoteHost=new SelfHost(path.resolve('resources/server'));
   const remote=await remoteHost.start({port:35443,password,name:'VPS QA',e2ee:true});
   await js(`document.querySelector('.home-orb').click()`);await delay(100);
   await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith('Присоединиться к комнате')).click()`);await delay(100);
   await js(`(()=>{const input=document.querySelector('dialog input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(remote.localAddress)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(100);
   await js(`document.querySelector('dialog form').requestSubmit()`);
   await until(()=>js(`document.querySelector('h1')?.textContent==='VPS QA' && document.querySelectorAll('.person-card').length===1`),'join second server with selfhost running');
   assert.equal((await js('window.desktop.hostStatus()')).running,true);
   await js(`document.querySelector('[title="Пригласить пользователя"]').click()`);await delay(100);
   assert.equal(await js('document.querySelectorAll("dialog[open]").length'),1);
   assert.equal(await js('document.querySelectorAll(".host-stop").length'),0,'VPS invitation does not show selfhost controls');
   assert.ok((await js('document.querySelector("dialog input").value')).includes(':35443/'));
   await js(`document.querySelector('dialog [aria-label="Закрыть"]').click()`);await delay(100);
   await js('window.desktop.stopHost()');await delay(200);
   assert.equal(await js('document.querySelector("h1").textContent'),'VPS QA','stopping own host keeps remote voice session');
   await js(`document.querySelector('[title="Отключиться"]').click()`);await delay(100);
   assert.equal(await js(`window.desktop.roomPresence(${JSON.stringify(remote.localAddress)})`),0,'presence is available without a voice connection');
   await remoteHost.stop();remoteHost=null;
   await js(`window.desktop.setLanguage('en')`);await win.reload();
   await until(()=>js(`!!document.querySelector('h1') && document.documentElement.lang==='en'`),'English home');
   assert.equal(await js('document.querySelector(".bookmark-orb").title'),'Renamed room','alias persists after reload');
   await js(`document.querySelector('[title="Output device"]').click()`);await delay(100);
   assert.ok(await js('document.querySelector(".audio-quick-menu:popover-open").textContent.includes("Speaker volume")'));
   await js(`document.querySelector('.audio-quick-menu:popover-open .audio-device-trigger').click()`);await delay(100);
   assert.equal(await js('document.querySelector(".audio-device-list:popover-open").getAttribute("aria-label")'),'Output device');
   await fs.writeFile(path.resolve('release/qa/quick-audio-en.png'),(await win.webContents.capturePage()).toPNG());
   await js(`document.querySelector('.audio-quick-menu:popover-open').hidePopover()`);
   await js(`document.querySelector('[title="Settings"]').click()`);await delay(200);
   assert.ok(await js('document.querySelector("dialog").textContent.includes("Start Voicecord when signing in to Windows")'));
   await js(`document.querySelector('dialog [aria-label="Close"]').click()`);await delay(100);
   await js(`document.querySelector('.bookmark-orb').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:30,clientY:120}))`);await delay(100);
   await js(`document.querySelector('.bookmark-menu button').click()`);await delay(100);
   for(const width of [940,1100]) {
    win.setSize(width,760);await delay(100);
    const geometry=await js(`(()=>{const buttons=[...document.querySelectorAll('dialog .modal-actions button')];return buttons.map(b=>{const r=b.getBoundingClientRect();return {height:r.height,center:r.y+r.height/2};});})()`);
    assert.ok(Math.abs(geometry[0].center-geometry[1].center)<1);
    assert.equal(geometry[0].height,geometry[1].height);
   }
   await fs.writeFile(path.resolve('release/qa/rename-en.png'),(await win.webContents.capturePage()).toPNG());
   console.log('PASS production IPC, E2EE, room alias persistence, lobby navigation, active bookmark, live presence, quick audio, RU/EN UI');app.exit(0);
  }catch(error){console.error(error);try{await remoteHost?.stop();await js('window.desktop.stopHost()');}catch{}app.exit(1);}
 });
});
require('../electron/main.cjs');
