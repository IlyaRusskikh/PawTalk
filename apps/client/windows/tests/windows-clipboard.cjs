// Preserve the user's standard clipboard representations, then exercise the
// production Win32 clipboard implementation through its native Go test helper.
const {app,BrowserWindow,session,clipboard}=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
const {promisify}=require('node:util');
const execute=promisify(require('node:child_process').execFile);
const directory=process.argv[2];
app.setPath('userData',path.join(directory,'clipboard-profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 session.defaultSession.setPermissionRequestHandler((_w,_p,cb)=>cb(true));
 session.defaultSession.setPermissionCheckHandler(()=>true);
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,offscreen:true}});
 const run=code=>win.webContents.executeJavaScript(code);
 let saved=false;
 try {
  await win.loadFile(path.join(directory,'clipboard.html'));
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  const snapshot=require('../scripts/clipboard-snapshot.cjs').snapshotClipboard;
  await run(`(${snapshot.toString()})(navigator.clipboard,ClipboardItem).then(items=>{window.savedClipboard=items})`);saved=true;
  await execute(path.join(directory,'clipboard-test.exe'),['-test.run=^TestNativeClipboardHelper$'],{env:{...process.env,PAWTALK_NATIVE_CLIPBOARD_HELPER:'1'},windowsHide:true,timeout:15000});
  assert.equal(await clipboard.readText(),'PawTalk native clipboard fixture');
  console.log('PASS actual native Win32 clipboard writes readable Unicode text; user clipboard restored');
 }catch(error){console.error(error?.stack||String(error));process.exitCode=1;}
 finally {
  if(saved) {
   const restored=await run(`window.savedClipboard.length ? navigator.clipboard.write(window.savedClipboard).then(()=>true) : Promise.resolve(false)`).catch(error=>{console.error(error);process.exitCode=1;return true;});
   if(!restored)await clipboard.clear();
  }
  win.destroy();app.exit(process.exitCode||0);
 }
});
