const {app,BrowserWindow,ipcMain,Tray,Menu,nativeImage}=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createShowWindow}=require('../manager/desktop/window.cjs');
const {trayItems}=require('../manager/desktop/tray-model.cjs');
const words=require('../manager/desktop/strings.json');
const route=process.argv[2]||'double-click';
app.whenReady().then(async()=>{
 let win,tray;
 try{
  win=new BrowserWindow({show:false,webPreferences:{preload:path.resolve('manager/desktop/preload.cjs'),sandbox:true,contextIsolation:true}});
  ipcMain.handle('manager:status',()=>({state:'stopped',language:'ru',busy:null,version:require('../manager/desktop/package.json').version,update:{status:'idle'}}));
  ipcMain.handle('manager:perform',()=>({error:'permission'}));
  const ready=Promise.all([
   new Promise(resolve=>win.once('ready-to-show',resolve)),
   new Promise(resolve=>ipcMain.once('manager:ready',event=>{assert.equal(event.sender,win.webContents);resolve();})),
  ]);
  let release,loads=0;
  const gate=new Promise(resolve=>release=resolve);
  const show=createShowWindow(win,async()=>{loads++;await gate;await win.loadFile(path.resolve('manager/desktop/dist/index.html'));},ready);
  let first;
  const requestShow=()=>{first=show();};
  tray=new Tray(nativeImage.createFromPath(path.resolve('manager/desktop/icons/server-stopped.ico')));
  tray.on('double-click',requestShow);
  const menu=Menu.buildFromTemplate(trayItems({state:'stopped',busy:null,update:{status:'idle'}},words.ru,{show:requestShow,toggle:()=>{},exit:()=>{},hide:()=>{}}));
  tray.setContextMenu(menu);
  if(route==='settings')menu.getMenuItemById('settings').click();else tray.emit('double-click');
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(win.isVisible(),false,'first open must not reveal an unloaded window');
  assert.equal(loads,1);
  release();await first;
  assert.equal(win.isVisible(),true);
  assert.equal(await win.webContents.executeJavaScript('!!document.querySelector(".manager-app h1")'),true);
  win.hide();await Promise.all([show(),show()]);assert.equal(win.isVisible(),true);assert.equal(loads,1);
  console.log(`PASS cold Electron ${route}: a single first open is visible after React renders; repeated opens share content with hardware acceleration enabled. Tray/Menu events and management responses are synthetic.`);
  tray.destroy();win.destroy();app.exit(0);
 }catch(error){console.error(error);tray?.destroy();win?.destroy();app.exit(1);}
});
