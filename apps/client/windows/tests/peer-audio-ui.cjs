const {app,BrowserWindow,session}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const phase=process.env.PAWTALK_PEER_AUDIO_PHASE;
app.disableHardwareAcceleration();
if(phase)app.setPath('userData',process.env.PAWTALK_PEER_AUDIO_DATA);
app.whenReady().then(async()=>{
 if(!phase){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pawtalk-peer-audio-'));
  let code=0;
  try{
   for(const next of ['write','read'])await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[__filename],{windowsHide:true,stdio:'inherit',env:{...process.env,PAWTALK_PEER_AUDIO_PHASE:next,PAWTALK_PEER_AUDIO_DATA:directory}});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Peer audio restart phase failed: '+next)));
   });
   console.log('PASS peer audio: persisted gain/mute survive two separate Electron processes and a new voice identity');
  }catch(error){console.error(error);code=1;}finally{
   if(path.dirname(path.resolve(directory))===path.resolve(os.tmpdir())&&path.basename(directory).startsWith('pawtalk-peer-audio-'))await fs.rm(directory,{recursive:true,force:true,maxRetries:4,retryDelay:200});
  }
  app.exit(code);return;
 }
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
 try{
  await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/peer-audio.html');
  const result=await win.webContents.executeJavaScript(`(async()=>{
   const {loadPeerAudio,savePeerAudio,projectPeerAudio}=await import('/src/peerAudio.mjs');
   const server='a'.repeat(32),profile='b'.repeat(64);
   if(${JSON.stringify(phase)}==='write'){savePeerAudio(localStorage,{[server+':'+profile]:{volume:1.65,muted:true}});return true;}
   return projectPeerAudio(loadPeerAudio(localStorage),server,[{identity:'new-voice-identity',profileId:profile}],id=>id)['new-voice-identity'];
  })()`,true);
  if(phase==='read')assert.deepEqual(result,{volume:1.65,muted:true});else assert.equal(result,true);
  session.defaultSession.flushStorageData();win.destroy();app.exit(0);
 }catch(error){console.error(error);app.exit(1);}
});
