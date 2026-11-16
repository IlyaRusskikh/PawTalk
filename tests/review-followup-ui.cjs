const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.setPath('userData',require('node:path').join(require('node:os').tmpdir(),'pawtalk-followup-'+process.pid));
app.disableHardwareAcceleration();app.commandLine.appendSwitch('use-fake-ui-for-media-stream');app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const run=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){throw Error(code+'\n'+error.message);}},wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async(code,label)=>{for(let i=0;i<150;i++){if(await run(code))return;await wait(40);}throw Error(label+': '+await run('document.body.innerText.slice(-1400)'));};
 const click=text=>run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
 const field=(selector,value)=>run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 try{
 for(const language of ['ru','en']){
  const en=language==='en';await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/notifications.html?language='+language+'&wizard=1');
  await until("!!document.querySelector('.onboarding-progress')",'wizard ready');
  await field('dialog input[maxlength="32"]','Synthetic tester');
  await run("document.querySelector('dialog input[maxlength=\"32\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true}))");
  assert.ok((await run("document.querySelector('.onboarding-progress').textContent")).includes('1'));
  await run("document.querySelector('dialog input[maxlength=\"32\"]').focus()");win.webContents.sendInputEvent({type:'keyDown',keyCode:'ENTER'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'ENTER'});
  await until("document.querySelector('.onboarding-progress').textContent.includes('2')",'native Enter advances wizard');
  await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/notifications.html?language='+language);
  await until("window.ready&&!!document.querySelector('.member-server-list button')",'app ready');
  await run("window.setupReorder();window.populatePeople();window.addMessages(33)");
  await until("!!document.querySelector('.member-unread-badge')",'badge ready');
  assert.ok(await run("(()=>{const badge=document.querySelector('.member-unread-badge').getBoundingClientRect(),list=document.querySelector('.member-server-list').getBoundingClientRect();return badge.top>=list.top&&badge.right<=list.right})()"),'badge fits rail viewport');
  await run("document.querySelector('[data-reorder-id=\"'+ '1'.repeat(32)+'\"]').click()");
  await until("document.querySelectorAll('.member-channel-people .avatar').length>0",'voice avatars');
  assert.equal(await run("document.querySelectorAll('.member-self-pin').length"),1,'exactly one effective self profile has a badge');assert.equal(await run("document.querySelector('.member-self-pin').textContent"),en?'You':'Вы');
  const checkStrip=selector=>run(`(()=>{const row=document.querySelector(${JSON.stringify(selector)}),children=[...row.children],more=row.querySelector('.avatar-strip-more'),r=row.getBoundingClientRect();return {single:children.every(c=>Math.abs(c.getBoundingClientRect().top-children[0].getBoundingClientRect().top)<1),fits:children.at(-1).getBoundingClientRect().right<=r.right,total:children.length-1+Number(more?.textContent.slice(1)),more:!!more}})()`);
  assert.deepEqual(await checkStrip('.member-channel-people'),{single:true,fits:true,total:12,more:true});
  await run("document.querySelector('[data-reorder-id=\"'+ '1'.repeat(32)+'\"]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
  await until("!!document.querySelector('.server-voice-preview .avatar-strip-more')",'hover overflow preview');
  assert.deepEqual(await checkStrip('.server-preview-people'),{single:true,fits:true,total:12,more:true});
  await run("window.setRole('member')");const inviteSelector='.member-toolbar button[aria-label="'+(en?'Invite user':'Пригласить пользователя')+'"]';await until('!document.querySelector('+JSON.stringify(inviteSelector)+')','invite action hidden');
  for(const [kind,expiresAt] of [['kick',undefined],['ban',null],['ban',Date.now()+3600000]]){
   await run(`window.emitDeparture(${JSON.stringify(kind)},${expiresAt===undefined?'undefined':JSON.stringify(expiresAt)})`);
   await until("!!document.querySelector('dialog[open]')",'departure modal');
   assert.ok((await run("document.querySelector('dialog').textContent")).includes('Synthetic notice server'));
   await click(en?'Got it':'Понятно');await until("!document.querySelector('dialog[open]')",'notice acknowledged');
  }
  await run('window.openLink()');await click(en?'Create string':'Создать строку');
  await until("document.querySelector('.member-link-profiles')?.textContent.includes('Fresh profile')",'link shows incoming profile');
  await run('window.openDevices(true)');await click(en?'Make primary':'Сделать основным');
  await until("!!document.querySelector('.member-control-copy')",'transfer copy');
  assert.equal(await run("document.querySelector('.member-control-copy').disabled"),false);await run("document.querySelector('.member-control-copy').click()");
  await until("!!document.querySelector('p[role=status]')",'copy feedback');assert.equal(await run('window.copied'),'synthetic-control-offer');
  await field('.form-fields textarea:not([readonly])','synthetic-control-response');await click(en?'Finish transfer':'Завершить передачу');
  await until("!document.querySelector('.form-fields')",'transfer completed despite changing primary role');assert.equal(await run('window.finishCalls'),1);
  await run('window.openDevices(false)');await click(en?'Accept control':'Принять управление');await field('.form-fields textarea','synthetic-control-offer');await click(en?'Confirm transfer':'Подтвердить передачу');
  await until("!!document.querySelector('.member-control-copy')",'receiver copy');await run("document.querySelector('.member-control-copy').click()");await until("!!document.querySelector('p[role=status]')",'receiver copy feedback');assert.equal(await run('window.copied'),'synthetic-control-response');
  await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/notifications.html?language='+language);
  await until("window.ready&&!!document.querySelector('.member-server-list button')",'extras ready');
  await run("window.setCovered(true)");await until("!!document.querySelector('dialog[open]')",'settings open');
  await field('dialog input[maxlength="32"]','Preserved settings draft');
  await run("window.incomingLink=true");
  await until("document.querySelectorAll('dialog[open]').length===2&&!!document.querySelector('.member-link-code')",'incoming link overlays settings');
  await run("[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('.modal-heading button').click()");
  await until("window.linkCancelled&&document.querySelectorAll('dialog[open]').length===1",'closing confirmation rejects');
  assert.equal(await run("document.querySelector('dialog input[maxlength=\"32\"]').value"),'Preserved settings draft');
  await run("document.querySelector('dialog .modal-heading button').click()");
  await run("window.muteServer(true);window.addMessages(1)");
  await until("!!document.querySelector('.member-unread-badge.notifications-muted')",'server-muted pin gray');
  const before=await run('window.desktopNotifications.length');
  await run("window.addMention()");
  await until("!!document.querySelector('.member-unread-badge.has-mention')&&window.desktopNotifications.length>"+before,'mention bypasses server mute');
  assert.equal(await run('window.desktopNotifications.at(-1).mention'),true);
  await run("document.querySelector('.member-server-list button').click();window.setCovered(true)");
  await until("!!document.querySelector('.member-channel-count.has-mention')",'channel mention pin');
  console.log('PASS mute/mention/link overlay '+language);
  console.log('PASS review follow-up UI '+language+': wizard Enter, badge clipping, avatar overflow, rights, departure modals, linking and transfer copy/finish');
 }
 app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1);}
});
