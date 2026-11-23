// Opt-in Windows shell check: creates synthetic, silent notifications.
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
 class ObservedNotification{static isSupported(){return Notification.isSupported();}constructor(options){assert.match(options.toastXml,/placement="appLogoOverride" hint-crop="circle"/);const notification=new Notification(options),entry={notification,options,shown:false,closed:false};native.push(entry);notification.on('show',()=>entry.shown=true);notification.on('close',()=>entry.closed=true);notification.on('failed',(_event,error)=>entry.failed=error||true);return notification;}}
 try{
  const avatar=nativeImage.createFromBitmap(Buffer.alloc(16*16*4,200),{width:16,height:16}).toDataURL();
  const profileId='a'.repeat(64),authorId='b'.repeat(64),address='https://127.0.0.1';
  const client={
    connections:new Map([[serverId,{}]]),
    registry:async()=>[{serverId,address,name:'PawTalk notification check'}],
    loadProtectedRuntimeTrust:async()=>({serverId}),
    openStoredProtectedRuntime:async()=>({serverId,profileId,address}),
    readProtectedRuntimeState:async()=>({apiProtocolVersion:3,serverId,profileId,channels:[{id:channelId,kind:'text',name:'Synthetic QA'}]}),
    readProtectedHistoryWindow:async()=>({first:1,last:4,cursor:'',removed:[],edits:[]}),
    readProtectedChatReference:async()=>({position:4,authorProfileId:authorId,sentAt:Date.now(),text:'Protected preview'}),
    readProtectedRuntimeRoster:async()=>({members:[{id:authorId,name:'Alice',avatar}]}),
  };
  service=registerMembershipIPC({ipcMain:{handle(_name,value){handler=value;}},authorized(){},client,links:{},send(){},getWindow:()=>undefined,Notification:ObservedNotification,notificationAppearance:require('../electron/notification-appearance.cjs').notificationAppearance({directory:require('node:path').join(app.getPath('userData'),'avatars'),nativeImage})});
  const call=(action,input)=>handler({},action,{serverId,channelId,...input}),notify=id=>call('notify',{messageId:id,channelName:'Synthetic QA',authorName:'PawTalk',authorAvatar:avatar,text:'Temporary notification lifecycle check'});
  assert.equal((await notify(1)).value,true);await until(()=>native[0].shown,'Windows accepts first toast');
  assert.equal(await history(),1,'synthetic toast exists in Windows Action Center');
  assert.equal((await notify(2)).value,true);await until(()=>native[1].shown,'Windows accepts replacement toast');assert.equal(await history(),1,'same tag/group replaces the toast in Action Center');
  assert.equal(native[0].notification.id,native[1].notification.id);assert.equal(native[0].notification.groupId,native[1].notification.groupId);
  await call('notify.read',{messageId:2});assert.equal(await history(),0,'reading removes the native toast from Windows Action Center');
  const pending=notify(3);await call('notify.read',{messageId:3});assert.equal((await pending).value,false);assert.equal((await notify(3)).value,false);assert.equal(native.length,2,'no stale toast was created');
  await call('connect');
  await call('chat.protected.muteNotifications',{serverMuted:false,mutedChannels:[]});
  assert.equal((await call('chat.protected.activity',{after:3,notify:true})).value.notified,true);
  await until(()=>native[2].shown,'Windows accepts the protected toast');
  assert.match(native[2].options.toastXml,/Alice: Protected preview/);
  assert.equal(await history(),1);
  await call('notify.read',{messageId:4});
  assert.equal(await history(),0);
  console.log('PASS Windows shell: legacy and protected toasts, sender avatar and preview, stable tag/group, replacement and read cancellation');service.stop();app.exit(0);
 }catch(error){console.error(error.stack);service?.stop();app.exit(1);}
});
