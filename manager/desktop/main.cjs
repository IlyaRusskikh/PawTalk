const {app,BrowserWindow,Tray,Menu,nativeImage,ipcMain,clipboard,dialog}=require('electron');
const {execFile,spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const net=require('node:net');
const {createHash}=require('node:crypto');
const {Broker,quote:winQuote}=require('./backend.cjs');
const strings=require('./strings.json');
const {trayItems,stopAndExit}=require('./tray-model.cjs');
const {createShowWindow}=require('./window.cjs');
const version=require('./package.json').version;
const args=process.argv.slice(1),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const root=path.resolve(option('--root')||path.join(process.env.ProgramData||'C:\\ProgramData','PawTalk'));
const rootKey=createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,16);
app.setPath('userData',path.join(app.getPath('appData'),'PawTalk Server Manager',rootKey));
const install=app.isPackaged?path.resolve(process.resourcesPath,'../..'):path.resolve(__dirname,'../../release/manager/windows');
const host=path.join(install,'pawtalkctl.exe');
const broker=new Broker(path.join(install,'pawtalk-server-tray.exe'),root);
let refreshing=false,showWindow;
const checks=new Set();
let language=option('--lang')==='ru'?'ru':'en',win,tray,quitting=false,busy=null,control,poll,publicState={},snapshot;
let state={state:'unavailable'};
const t=key=>strings[language][key]||strings[language].failed;
const command=(file,args,timeout=5000)=>new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout,maxBuffer:2*1024*1024},(error,stdout)=>error?reject(error):resolve(stdout)));
const status=()=>({...state,language,busy,operations:[...(busy?[busy]:[]),...checks],version,update:publicState.update||{status:'idle'},autoManager:publicState.autoManager??false});
function publish(){if(win&&!win.isDestroyed())win.webContents.send('manager:status',status());refreshTray();}
async function refresh(){
  if(refreshing)return;
  refreshing=true;
  try{
  try{state=JSON.parse(await command(host,['--desktop-status',root]));}catch{state={state:'unavailable'};}
  try{publicState=JSON.parse(await fs.readFile(path.join(install,'status-'+rootKey+'.json'),'utf8'));}catch{}
  if(publicState.update?.status==='installing'&&publicState.update.version===version)publicState.update={...publicState.update,status:'current'};
  publish();
  }finally{refreshing=false;}
}
function ensureTray(){
  if(tray)return;
  tray=new Tray(icon());tray.on('double-click',show);refreshTray();
}
function icon(){
  const name=state.state==='running'?'running':['starting','stopping'].includes(state.state)?'transition':'stopped';
  return nativeImage.createFromPath(path.join(__dirname,'icons',`server-${name}.ico`));
}
function refreshTray(){
  if(!tray)return;
  tray.setImage(icon());tray.setToolTip('PawTalk Server Manager — '+(strings[language].states[state.state]||t('unavailable')));
  const items=trayItems(status(),strings[language],{
    toggle:action=>void perform(action).catch(showError),show,
    update:()=>void perform('install-manager-update').catch(showError),
    exit:()=>void exitManager().catch(showError),
    hide:()=>{tray.destroy();tray=undefined;}
  });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}
async function show(){ensureTray();if(showWindow)await showWindow();}
async function showError(error){await show();win?.webContents.send('manager:status',{...status(),error:error.code||error.message||'failed'});}
const allowed=new Set(['snapshot','apply','start','stop','copy-password','copy-invitation','reset-password','backup-create','backup-restore','backup-delete','diagnostics','logs','check-updates','check-server-updates','install-manager-update','install-server-update','select-server-package','install-server-package']);
async function perform(action,payload={}){
  if(!allowed.has(action)||!payload||typeof payload!=='object'||JSON.stringify(payload).length>65536)throw Object.assign(Error('invalid'),{code:'invalid'});
  const checking=['check-updates','check-server-updates'].includes(action);
  if((!checking&&busy)||checks.has(action))throw Object.assign(Error('busy'),{code:'busy'});
  if(checking)checks.add(action);else busy=action;publish();
  try{
    if(action==='select-server-package'){
      const choice=await dialog.showOpenDialog(win,{title:t('selectServerPackage'),properties:['openFile'],filters:[{name:'PawTalk Server',extensions:['zip']}]});
      if(choice.canceled)return null;
      return await broker.request('inspect-server-package',{path:choice.filePaths[0]});
    }
    const copy=action==='copy-password'||action==='copy-invitation'||action==='reset-password';
    const value=await broker.request(copy?(action==='reset-password'?'reset-password':'invitation'):action,payload);
    if(copy){if(value.unavailable)throw Object.assign(Error('passwordUnavailable'),{code:'passwordUnavailable'});await clipboard.writeText(action==='copy-password'?value.password:value.url);return {copied:true};}
    if(value?.values)snapshot=value;
    if(['check-updates','install-manager-update'].includes(action))publicState.update=value;
    return value;
  }finally{if(checking)checks.delete(action);else busy=null;publish();await refresh();}
}
async function exitManager(){await stopAndExit(()=>perform('stop'),finish);}
async function finish(){quitting=true;clearInterval(poll);tray?.destroy();tray=undefined;broker.close();control?.close();app.quit();}
function authorized(event){if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw Error('Unauthorized Manager window');}
app.on('window-all-closed',()=>{});
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',()=>show());
  app.whenReady().then(async()=>{
    await fs.mkdir(app.getPath('userData'),{recursive:true});
    try{const saved=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'preferences.json'),'utf8'));if(['ru','en'].includes(saved.language))language=saved.language;}catch{}
    win=new BrowserWindow({show:false,width:1140,height:820,minWidth:960,minHeight:680,title:'PawTalk Server Manager',backgroundColor:'#12141b',titleBarStyle:'hidden',titleBarOverlay:{color:'#12141b',symbolColor:'#cbd0e1',height:48},icon:path.join(__dirname,'icons/server-running.ico'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
    win.removeMenu();win.on('close',event=>{if(!quitting){event.preventDefault();win.hide();}});
    const painted=new Promise(resolve=>win.once('ready-to-show',resolve));
    const rendered=new Promise(resolve=>ipcMain.on('manager:ready',event=>{authorized(event);resolve();}));
    showWindow=createShowWindow(win,()=>win.loadFile(path.join(__dirname,'dist/index.html')),Promise.all([painted,rendered]));
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
    ipcMain.handle('manager:status',event=>{authorized(event);return status();});
    ipcMain.handle('manager:perform',async(event,action,payload)=>{authorized(event);try{return {value:await perform(action,payload)};}catch(error){return {error:error.code||'failed'};}});
    ipcMain.handle('manager:language',async(event,value)=>{authorized(event);if(!['ru','en'].includes(value))return;language=value;await fs.writeFile(path.join(app.getPath('userData'),'preferences.json'),JSON.stringify({language}));publish();});
    ipcMain.handle('manager:hide-window',event=>{authorized(event);win.hide();});
    control=net.createServer(socket=>{
      let buffer='',handled=false;socket.on('error',()=>{});socket.on('data',data=>{if(handled)return;buffer+=data;if(buffer.length>1024){socket.destroy();return;}if(!buffer.includes('\n'))return;handled=true;
        let message;try{message=JSON.parse(buffer.split('\n')[0]);}catch{socket.destroy();return;}
        if(message.action==='show'){show();socket.end('{"ok":true}\n');}
        else if(message.action==='maintenance'){
          void(async()=>{const deadline=Date.now()+195000;while(busy&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));if(busy){socket.end('{"ok":false}\n');return;}
            // Installation, unlike the explicit Exit action, leaves service state alone.
            if(message.restart===true)await prepareRestart();socket.end('{"ok":true}\n',()=>void finish());})();
        }else socket.destroy();
      });
    });
    control.on('error',()=>{});control.listen(String.raw`\\.\pipe\PawTalk.Manager.UI.${rootKey}`);
    await refresh();ensureTray();
    poll=setInterval(()=>void refresh(),1500);
    if(!args.includes('--tray')||args.includes('--settings'))await show();
    void command(host,['--desktop-check',root]).catch(()=>{});
  }).catch(()=>app.exit(1));
}
async function prepareRestart(){
  if(!app.isPackaged)return;
  const script=path.join(app.getPath('temp'),`pawtalk-manager-restart-${process.pid}.ps1`);
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  const target=path.join(install,'desktop/PawTalk Server Manager.exe');
  const installerStatus=path.join(install,'install-status.txt');
  const started=new Date().toISOString();
  const body=`$ErrorActionPreference='Stop'\n$deadline=(Get-Date).AddMinutes(12)\nwhile((Get-Date)-lt $deadline){ Start-Sleep -Seconds 2; if((Test-Path -LiteralPath ${quote(target)}) -and (Test-Path -LiteralPath ${quote(installerStatus)}) -and ((Get-Item -LiteralPath ${quote(installerStatus)}).LastWriteTimeUtc -ge [DateTime]::Parse(${quote(started)}).ToUniversalTime()) -and ((Get-Content -LiteralPath ${quote(installerStatus)} -Raw).Trim() -eq 'complete')){$start=New-Object System.Diagnostics.ProcessStartInfo; $start.FileName=${quote(target)}; $start.Arguments=${quote('--root '+winQuote(root)+' --tray')}; $start.UseShellExecute=$false; $start.CreateNoWindow=$true; [System.Diagnostics.Process]::Start($start) | Out-Null; break}}\nRemove-Item -LiteralPath $PSCommandPath -Force\n`;
  await fs.writeFile(script,body);
  const child=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{detached:true,windowsHide:true,stdio:'ignore'});child.unref();
}
