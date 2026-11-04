const { app } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
app.setPath('userData',path.join(os.tmpdir(),'voicecord-main-smoke-'+process.pid));
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
process.argv.push('--smoke');
app.on('browser-window-created',(_event,win)=>{
 win.webContents.once('did-finish-load',async()=>{
  try {
   const capabilities=await win.webContents.executeJavaScript('window.desktop.capabilities()');
   assert.equal(capabilities.native,true,'native module loaded in real main process');
   const keys=await win.webContents.executeJavaScript(`window.desktop.configureKeys({ptt:135,mute:'',deafen:''})`);
   assert.deepEqual(keys.failed,[]);
   assert.equal(await win.webContents.executeJavaScript('typeof window.require'),'undefined','renderer has no Node access');
   assert.equal(capabilities.secureStorage,true,'Windows protected storage available');
   await win.webContents.executeJavaScript(`window.desktop.savePassword({address:'https://127.0.0.1',password:'credential-roundtrip-fixture'})`);
   assert.ok(await win.webContents.executeJavaScript(`window.desktop.loadPassword('https://127.0.0.1').then(x=>x.password==='credential-roundtrip-fixture')`),'encrypted password roundtrip');
   assert.ok(await win.webContents.executeJavaScript(`window.desktop.loadPassword('https://127.0.0.1:8443').then(x=>x.password===null)`),'credentials isolated per server');
   const folder=path.join(app.getPath('userData'),'credentials');
   for(const file of await fs.readdir(folder)) assert.ok(!(await fs.readFile(path.join(folder,file))).includes(Buffer.from('credential-roundtrip-fixture')),'no plaintext stored');
   await win.webContents.executeJavaScript(`window.desktop.savePassword({address:'https://127.0.0.1',password:null})`);
   assert.ok(await win.webContents.executeJavaScript(`window.desktop.loadPassword('https://127.0.0.1').then(x=>x.password===null)`),'password deletion');
   const input=JSON.stringify({address:process.env.VOICECORD_TEST_SERVER || 'http://127.0.0.1:8080',nickname:'main-smoke',password:process.env.VOICECORD_TEST_PASSWORD});
   const response=await win.webContents.executeJavaScript(`window.desktop.connect(${input})`);
   assert.equal(response.error,undefined,JSON.stringify(response));
   assert.ok(response.token);
   console.log('PASS real main/preload IPC, isolated renderer, native capabilities, key configuration, API authentication');
   app.quit();
  } catch(error) {console.error(error);app.exit(1);}
 });
});
require('../electron/main.cjs');
