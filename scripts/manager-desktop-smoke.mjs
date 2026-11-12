import {spawn}from'node:child_process';import{createRequire}from'node:module';
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const file of ['tests/manager-desktop.cjs','tests/manager-tray.cjs']){
 const code=await new Promise((resolve,reject)=>{const child=spawn(createRequire(import.meta.url)('electron'),[file],{env,windowsHide:true,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>resolve(code??1));});
 if(code!==0)process.exit(code);
}
