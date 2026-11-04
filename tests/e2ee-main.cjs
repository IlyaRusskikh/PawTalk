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
  try {
   await until(()=>js('!!document.querySelector(".home-actions")'),'app ready');
   await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith('Создать комнату')).click()`);
   await until(()=>js('!!document.querySelector(".encryption-toggle")'),'host form');
   const password=randomBytes(18).toString('hex');
   await js(`(()=>{const inputs=document.querySelector('dialog form').querySelectorAll('input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [i,value] of ${JSON.stringify([[0,'E2EE QA'],[1,password],[2,'34443']])}){set.call(inputs[i],value);inputs[i].dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('.encryption-toggle input').click();})()`);
   await delay(200);await js(`document.querySelector('dialog form').requestSubmit()`);
   await until(()=>js(`!!document.querySelector('.e2ee-badge') && document.querySelectorAll('.person-card').length===1`),'real encrypted room from checkbox');
   const state=await js('window.desktop.hostStatus()');assert.equal(state.e2ee,true);assert.match(state.localAddress,/e2ee=[a-f0-9]{64}/);
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
   console.log('PASS real checkbox, production IPC, built file worker, E2EE admission, encrypted key storage');
   await js('window.desktop.stopHost()');app.exit(0);
  }catch(error){console.error(error);try{await js('window.desktop.stopHost()');}catch{}app.exit(1);}
 });
});
require('../electron/main.cjs');
