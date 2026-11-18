import {spawn}from'node:child_process';import{createRequire}from'node:module';
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const args of [['apps/manager/windows/tests/manager-window.cjs','double-click'],['apps/manager/windows/tests/manager-window.cjs','settings'],['apps/manager/windows/tests/manager-desktop.cjs'],['apps/manager/windows/tests/manager-tray.cjs']]){
 // Electron is a GUI executable. STARTF_USESHOWWINDOW/SW_HIDE would override
 // its first BrowserWindow.show(), exactly as in the native-launch regression.
 const code=await new Promise((resolve,reject)=>{const child=spawn(createRequire(import.meta.url)('electron'),args,{env,windowsHide:false,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>resolve(code??1));});
 if(code!==0)process.exit(code);
}
