// Real native API + restricted Electron IPC. Only the advertised public media
// hostname is varied to reproduce published standalone Server LAN behavior.
const { app, net } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
app.setPath('userData',path.join(os.tmpdir(),'pawtalk-native-connect-'+process.pid));
app.disableHardwareAcceleration();
process.argv.push('--smoke','--offscreen-smoke');
const bare = process.env.PAWTALK_TEST_INVITATION;
const password = process.env.PAWTALK_TEST_PASSWORD;
const key = process.env.PAWTALK_TEST_MEDIA_KEY;
assert.ok(bare && password && key,'requires isolated native smoke fixture');
const fetch = net.fetch.bind(net);
net.fetch = async (value,options) => {
 const response = await fetch(value,options);
 if(new URL(String(value)).pathname==='/api/connect' && response.ok) {
  const body = await response.json();
  const voice = new URL(body.url); voice.hostname='203.0.113.10'; body.url=voice.toString();
  return new Response(JSON.stringify(body),{status:response.status,headers:{'Content-Type':'application/json'}});
 }
 return response;
};
app.on('browser-window-created',(_event,win)=>{
 win.webContents.once('did-finish-load',async()=>{
  const run=code=>win.webContents.executeJavaScript(code,true);
  const until=async code=>{for(let i=0;i<120;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,50));}throw Error('native connect UI timed out');};
  try {
   await until(`!!document.querySelector('.home-actions')`);
   const link=bare+'#password='+encodeURIComponent(password);
   await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith('Присоединиться к комнате')).click()`);
   await run(`(()=>{const el=document.querySelector('dialog input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(link)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   await run(`document.querySelector('.join-submit').click()`);
   await until(`document.querySelectorAll('dialog:last-of-type input[type=password]').length===2`);
   assert.equal(await run(`document.querySelector('dialog:last-of-type input[type=password]').value`),password);
   const base = process.env.PAWTALK_TEST_SERVER;
   let verified;
   for(const address of [link,base]) {
    const result = await run(`window.desktop.connect(${JSON.stringify({address,nickname:'Native IPC',password,e2eeKey:key})})`);
    assert.equal(result.error,undefined,result.error);
    assert.equal(result.url,base.replace('https:','wss:')+'/rtc');
    assert.equal(result.e2eeRequired,true);
    assert.equal(result.e2eeKey,key);
    assert.match(result.roomId,/^[a-f0-9]{64}$/);
    if(verified){assert.equal(result.roomId,verified.roomId);assert.equal(result.bookmarkAddress,verified.bookmarkAddress);}
    verified=result;
   }
   const wrong=await run(`window.desktop.connect(${JSON.stringify({address:link,nickname:'Native IPC',password,e2eeKey:'b'.repeat(64)})})`);
   assert.match(wrong.error,/E2EE/);
   const wrongPassword=await run(`window.desktop.connect(${JSON.stringify({address:link,nickname:'Native IPC',password:'explicit-wrong-password',e2eeKey:key})})`);
   assert.match(wrongPassword.error,/пароль/i,'edited password must override the old password embedded in the URL');
   await run(`window.desktop.savePassword(${JSON.stringify({address:verified.bookmarkAddress,password:'stale-bookmark-password',e2eeKey:key})})`);
   const locked=await run(`window.desktop.roomPreview(${JSON.stringify(verified.bookmarkAddress)},${JSON.stringify({after:0,roomId:verified.roomId})})`);
   assert.deepEqual(locked,{status:'locked'},'a wrong bookmark may not borrow the active session token');
   assert.equal(await run(`window.desktop.roomPresence(${JSON.stringify(verified.bookmarkAddress)})`),null);
   console.log('PASS real native API and Electron IPC: password-bearing invitation prompts for E2EE; manual IP/key login; public media host uses authenticated LAN proxy; wrong key rejected');
   app.exit(0);
  }catch(error){console.error(error?.stack||String(error));app.exit(1);}
 });
});
require('../electron/main.cjs');
