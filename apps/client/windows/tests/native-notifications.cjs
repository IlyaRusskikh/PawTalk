// Opt-in Windows shell check: creates only two synthetic, silent notifications.
const {app,Notification,nativeImage}=require('electron'),assert=require('node:assert/strict');
const {promisify}=require('node:util'),execute=promisify(require('node:child_process').execFile);
const {registerMembershipIPC}=require('../electron/membership-ipc.cjs');
app.setPath('userData',require('node:path').join(require('node:os').tmpdir(),'pawtalk-native-notifications-'+process.pid));
if(process.platform==='win32')app.setAppUserModelId('local.pawtalk.desktop');
app.whenReady().then(async()=>{
 if(process.platform!=='win32'||!Notification.isSupported()){console.error('UNAVAILABLE native Windows notifications');app.exit(2);return;}
 let handler,service;const native=[],serverId='0'.repeat(32),channelId='f'.repeat(32),wait=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(predicate,label)=>{for(let i=0;i<100;i++){if(predicate())return;await wait(40);}throw Error(label+': '+JSON.stringify(native.map(n=>({shown:n.shown,closed:n.closed,failed:n.failed}))));};
 const history=async()=>{const n=native.at(-1).notification,script="[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null; @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('local.pawtalk.desktop') | Where-Object { $_.Tag -eq '"+n.id+"' -and $_.Group -eq '"+n.groupId+"' }).Count";return Number((await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000})).stdout.trim());};
 class ObservedNotification{static isSupported(){return Notification.isSupported();}constructor(options){assert.match(options.toastXml,/placement="appLogoOverride" hint-crop="circle"/);const notification=new Notification(options),entry={notification,shown:false,closed:false};native.push(entry);notification.on('show',()=>entry.shown=true);notification.on('close',()=>entry.closed=true);notification.on('failed',(_event,error)=>entry.failed=error||true);return notification;}}
 try{
  service=registerMembershipIPC({ipcMain:{handle(_name,value){handler=value;}},authorized(){},client:{connections:new Map([[serverId,{}]]),registry:async()=>[{serverId,name:'PawTalk notification check'}]},links:{},send(){},getWindow:()=>undefined,Notification:ObservedNotification,notificationAppearance:require('../electron/notification-appearance.cjs').notificationAppearance({directory:require('node:path').join(app.getPath('userData'),'avatars'),nativeImage})});
  const call=(action,input)=>handler({},action,{serverId,channelId,...input}),notify=id=>call('notify',{messageId:id,channelName:'Synthetic QA',authorName:'PawTalk',authorAvatar:nativeImage.createFromBitmap(Buffer.alloc(16*16*4,200),{width:16,height:16}).toDataURL(),text:'Temporary notification lifecycle check'});
  assert.equal((await notify(1)).value,true);await until(()=>native[0].shown,'Windows accepts first toast');
  assert.equal(await history(),1,'synthetic toast exists in Windows Action Center');
  assert.equal((await notify(2)).value,true);await until(()=>native[1].shown,'Windows accepts replacement toast');assert.equal(await history(),1,'same tag/group replaces the toast in Action Center');
  assert.equal(native[0].notification.id,native[1].notification.id);assert.equal(native[0].notification.groupId,native[1].notification.groupId);
  await call('notify.read',{messageId:2});assert.equal(await history(),0,'reading removes the native toast from Windows Action Center');
  const pending=notify(3);await call('notify.read',{messageId:3});assert.equal((await pending).value,false);assert.equal((await notify(3)).value,false);assert.equal(native.length,2,'no stale toast was created');
  console.log('PASS Windows shell: actual native show, WinRT Action Center history, stable tag/group, replacement, read cancellation and stale-event suppression');service.stop();app.exit(0);
 }catch(error){console.error(error.stack);service?.stop();app.exit(1);}
});
