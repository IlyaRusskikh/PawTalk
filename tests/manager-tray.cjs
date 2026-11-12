const {app,Tray,Menu,nativeImage}=require('electron');const assert=require('node:assert/strict');const path=require('node:path');
const {trayItems}=require('../manager/desktop/tray-model.cjs');const words=require('../manager/desktop/strings.json');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 let tray;
 try{
  const images={};for(const state of ['running','transition','stopped']){
   const image=nativeImage.createFromPath(path.resolve(`manager/desktop/icons/server-${state}.ico`));assert.equal(image.isEmpty(),false);images[state]=image;
  }
  tray=new Tray(images.stopped);
  for(const state of ['stopped','starting','running','stopping']){
   tray.setImage(images[state==='running'?'running':['starting','stopping'].includes(state)?'transition':'stopped']);
   const menu=Menu.buildFromTemplate(trayItems({state,busy:null,update:{status:'available'}},words.ru,{toggle:()=>{},show:()=>{},update:()=>{},exit:()=>{},hide:()=>{}}));tray.setContextMenu(menu);
   assert.equal(menu.getMenuItemById('toggle').enabled,['stopped','running'].includes(state));
  }
  assert.equal(tray.isDestroyed(),false);tray.destroy();assert.equal(tray.isDestroyed(),true);assert.equal(app.isReady(),true);
  tray=new Tray(images.running);assert.equal(tray.isDestroyed(),false);tray.destroy();
  console.log('PASS real Electron Tray/Menu: all three native icons, transition states, action enablement, hide without process exit and icon recreation');app.exit(0);
 }catch(error){console.error(error);if(tray&&!tray.isDestroyed())tray.destroy();app.exit(1);}
});
