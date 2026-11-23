// Electron entry point for explicitly controlled development windows.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),net=require('node:net'),path=require('node:path');
const {config}=require('./review-app-config.cjs');
const component=process.argv.find(arg=>arg.startsWith('--component='))?.slice(12);
const profile=process.argv.find(arg=>arg.startsWith('--profile='))?.slice(10)||'';
const paths=config(component,profile),runtime=JSON.parse(fs.readFileSync(paths.runtime,'utf8'));
if(runtime.token!==process.env.PAWTALK_REVIEW_APP_TOKEN||!/^\\\\\.\\pipe\\pawtalk-app-[a-f0-9]{32}$/.test(runtime.pipe))throw Error('Invalid review launcher');
delete process.env.PAWTALK_REVIEW_APP_TOKEN;
delete process.env.PAWTALK_DEV_URL;
let entry,control,quitting=false;
const publish=ready=>fs.writeFileSync(paths.runtime,JSON.stringify({...runtime,pid:process.pid,ready})+'\n');
publish(false);
app.on('browser-window-created',(_event,win)=>{
 win.webContents.once('did-finish-load',()=>{
  const poll=setInterval(()=>{
   if(win.isDestroyed()){clearInterval(poll);return;}
   void win.webContents.executeJavaScript("!!document.querySelector('.server-app,.manager-app')").then(ready=>{if(ready){clearInterval(poll);publish(true);}}).catch(()=>{});
  },100);
 });
});
control=net.createServer(socket=>{
 let input='',handled=false;socket.setTimeout(3000,()=>socket.destroy());socket.on('error',()=>{});
 socket.on('data',chunk=>{
  if(handled)return;input+=chunk;if(input.length>1024){socket.destroy();return;}if(!input.includes('\n'))return;handled=true;
  let request;try{request=JSON.parse(input);}catch{socket.destroy();return;}
  if(request.token!==runtime.token||request.action!=='stop'){socket.destroy();return;}
  if(component==='manager'&&entry.reviewBusy()){socket.end('busy\n');return;}
  socket.end('stopping\n',()=>{quitting=true;if(component==='manager')void entry.closeReview();else app.quit();});
 });
});
control.on('error',error=>{console.error(error.message);app.exit(1);});control.listen(runtime.pipe);
app.on('will-quit',()=>{control.close();try{const current=JSON.parse(fs.readFileSync(paths.runtime,'utf8'));if(current.token===runtime.token)fs.unlinkSync(paths.runtime);}catch{}});
if(component==='client'){
 app.setPath('userData',paths.userData);process.env.PAWTALK_REVIEW_API3_ONLY='true';
 entry=require('../../apps/client/windows/electron/main.cjs');
}else{
 process.argv.push('--root',runtime.managerRoot,'--review-host-dir',runtime.managerHost,'--review-user-data',paths.userData,'--lang','ru');
 entry=require('../../apps/manager/windows/desktop/main.cjs');
}
