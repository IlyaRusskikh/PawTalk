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
 const en=language==='en';
 await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/notifications.html?language='+language);
 await until("window.ready&&!!document.querySelector('.home-screen')",'home ready');
 assert.equal(await run("document.querySelector('#home-title').textContent"),en?'The conversation starts here.':'Разговор начинается здесь.');
 win.webContents.debugger.attach('1.3');
 for(const motion of ['no-preference','reduce']){
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:motion}]});
  for(const [width,height] of [[1240,860],[1000,720],[800,600]]){
   win.setContentSize(width,height);await wait(100);
   assert.ok(await run("(()=>{const page=document.querySelector('.home-screen');return page.scrollWidth<=page.clientWidth&&[...page.querySelectorAll('.home-action')].every(e=>e.scrollWidth<=e.clientWidth)})()"),'home fits '+language+' '+width);
   assert.equal(await run("getComputedStyle(document.querySelector('.home-art-wave i')).animationName"),motion==='reduce'?'none':'home-signal');
  }
 }
 win.webContents.debugger.detach();win.setContentSize(1240,860);await wait(100);
 if(process.env.PAWTALK_HOME_SCREENSHOTS){const fs=require('node:fs');fs.mkdirSync('release/qa',{recursive:true});fs.writeFileSync('release/qa/home-'+language+'.png',(await win.webContents.capturePage()).toPNG());}
 await run("document.querySelector('.home-action-join').click()");
 await until("!!document.querySelector('.member-join-modal')",'home opens join dialog');
 await run("document.querySelector('dialog .modal-heading button').click();document.querySelector('.home-action-create').click()");
 await until("!!document.querySelector('dialog[open]')",'home opens create dialog');
 assert.ok((await run("document.querySelector('dialog').textContent")).includes(en?'Create a room':'Создать комнату'));
 await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/notifications.html?language='+language+'&wizard=1');
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
  const ghost=await run("(()=>{const source=document.querySelector('.member-roster-person'),box=source.getBoundingClientRect(),transfer=new DataTransfer();window.memberTransfer=transfer;let info;transfer.setDragImage=(surface)=>{const copy=surface.firstElementChild;info={background:getComputedStyle(surface).backgroundColor,padding:getComputedStyle(surface).padding,radius:getComputedStyle(copy).borderRadius,shadow:getComputedStyle(copy).boxShadow,avatar:!!copy.querySelector('.avatar'),label:copy.querySelector('.member-roster-nickname').textContent};};source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:box.left+10,clientY:box.top+10}));return info;})()");
  assert.equal(ghost.background,'rgba(0, 0, 0, 0)','member drag has a separate transparent surface');assert.equal(ghost.padding,'6px');assert.notEqual(ghost.radius,'0px');assert.equal(ghost.shadow,'none');assert.ok(ghost.avatar);
  await until("!!document.querySelector('.member-composer textarea')",'chat input ready for member drop');
  await run("document.querySelector('.member-composer textarea').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.memberTransfer}))");
  assert.ok((await run("document.querySelector('.member-composer textarea').value")).includes('@'+ghost.label),'rounded member drag still inserts a mention');
  await field('.member-composer textarea','');
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
  assert.equal(await run("!!document.querySelector('dialog textarea')"),false,'confirmation omits link string field');
  assert.equal(await run("[...document.querySelectorAll('.member-link-profile .avatar')].every(e=>parseFloat(getComputedStyle(e).fontSize)<=e.getBoundingClientRect().width/2)"),true,'avatar initials fit their circles');
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
  await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/notifications.html?language='+language+'&protected=recovery');
  const profileDevices = en ? 'Profile and devices' : 'Профиль и устройства';
  const addDevice = en ? 'Add a new device' : 'Добавить новое устройство';
  const openSettingsTab = async label => {
   if (!await run("!!document.querySelector('.protected-server-settings[open]')")) {
    await run("document.querySelector('.member-server-list button').click()");
    await until("!!document.querySelector('.protected-server-title')", 'Server title is ready');
    await run("document.querySelector('.protected-server-title').click()");
    await click(en ? 'Server settings' : 'Настройки сервера');
   }
   await click(label);
  };
  const openRecovery = async () => {
   await until("window.protectedAlertPolls > 0 && !!document.querySelector('.member-server-list button')", 'protected server ready');
   await openSettingsTab(profileDevices);
   await click(en ? 'Access recovery' : 'Восстановление доступа');
   await until("!!document.querySelector('.member-recovery-modal[open]')", 'recovery setup open');
  };
  const actionsAligned = (dialog='.member-recovery-modal') => run(`[...document.querySelectorAll(${JSON.stringify(dialog + ' .modal-actions')})].every(row => {
    const buttons = [...row.querySelectorAll('button')].map(button => button.getBoundingClientRect());
    return buttons.every(box => box.height >= 42 && Math.abs(box.top + box.height / 2 - buttons[0].top - buttons[0].height / 2) < 1)
      && row.scrollWidth <= row.clientWidth;
  })`);
  win.setContentSize(800,600);
  await openRecovery();
  await click(en ? 'Create recovery kit' : 'Создать резервный набор');
  await until("document.querySelector('.member-recovery-modal textarea')?.value === 'synthetic-recovery-kit'", 'local kit generated');
  assert.ok(await run(`document.querySelector('.member-recovery-modal').textContent.includes(${JSON.stringify(en
    ? 'The kit will work after you confirm setup.' : 'Набор начнёт действовать после подтверждения настройки.')})`));
  assert.equal(await run('window.recoveryCalls.length'), 1, 'generation has no enrollment');
  assert.equal(await run('window.recoveryInventoryCalls.length'), 0, 'ordinary setup does not fetch devices');
  assert.equal(await run("document.querySelector('.member-recovery-modal .modal-actions .primary').disabled"), true);
  assert.ok(await run("document.querySelector('.member-recovery-modal .ui-button-secondary').getBoundingClientRect().height >= 40"),
   'Copy uses the standard secondary button geometry');
  await click(en ? 'Copy kit' : 'Скопировать набор');
  await until("window.copied === 'synthetic-recovery-kit'", 'kit copied explicitly');
  await run("document.querySelector('.member-recovery-modal input[type=checkbox]').click()");
  await click(en ? 'Confirm setup' : 'Подтвердить настройку');
  await until("document.querySelectorAll('.member-recovery-modal input[type=checkbox]').length === 2", 'replacement requires separate consent');
  const devices = '.member-recovery-devices';
  const checkDevices = async expected => {
   await until(`document.querySelector('${devices} code')?.textContent === '${expected.repeat(64)}'`, 'replacement device inventory updates');
   assert.equal(await run(`document.querySelector('${devices} h3').textContent`),
     en ? 'Devices with access to the server' : 'Устройства с доступом к серверу');
   assert.deepEqual(await run(`[...document.querySelectorAll('${devices} li')].map(item =>
     [item.querySelector('code').textContent, item.querySelector('span')?.textContent ?? null])`),
   [[expected.repeat(64), null], ['c'.repeat(64), en ? 'This device' : 'Это устройство']]);
  };
  await until(`!!document.querySelector('${devices} [role=alert]')`, 'inventory failure appears separately');
  await run(`document.querySelector('${devices} button').click()`);
  await checkDevices('4');
  assert.equal(await run("document.querySelector('.member-recovery-modal .danger-button').disabled"), true);
  assert.ok(await actionsAligned(), 'replacement action buttons align');
  await run("document.querySelector('.member-recovery-modal input[type=checkbox]:not(:disabled)').click()");
  await click(en ? 'Replace and confirm' : 'Заменить и подтвердить');
  const retry = en ? 'Retry confirmation' : 'Повторить подтверждение';
  await until(`window.recoveryCalls.at(-1).replace === true && [...document.querySelectorAll('.member-recovery-modal button')].some(button => button.textContent === ${JSON.stringify(retry)})`, 'replacement can remain pending');
  await checkDevices('5');
  await click(retry);
  await until("!document.querySelector('.member-recovery-modal textarea')", 'replacement becomes ready');
  await checkDevices('6');
  assert.deepEqual(await run('window.recoveryInventoryCalls.map(call => call.phase)'), ['review', 'review', 'pending', 'ready']);
  assert.deepEqual(await run('window.recoveryCalls.map(c => c.replace === true)'), [false, false, true, false]);
  await click(en ? 'Done' : 'Готово');
  await openRecovery();
  await click(en ? 'Paste a saved kit' : 'Вставить сохранённый набор');
  assert.equal(await run("document.querySelector('.member-recovery-modal textarea').value"), '', 'closed dialog clears the kit');
  await field('.member-recovery-modal textarea', 'synthetic-recovery-kit');
  await click(en ? 'Confirm setup' : 'Подтвердить настройку');
  await until("!document.querySelector('.member-recovery-modal textarea')", 'confirmation resumes with a saved kit');
  assert.equal(await run('window.recoveryInventoryCalls.length'), 4, 'ready saved kit does not restart replacement review');
  await click(en ? 'Done' : 'Готово');
  await openRecovery();
  await click(en ? 'Paste a saved kit' : 'Вставить сохранённый набор');
  await field('.member-recovery-modal textarea', 'synthetic-retired-kit');
  await click(en ? 'Confirm setup' : 'Подтвердить настройку');
  const retired = en ? 'This recovery kit has been revoked. Create and confirm a new kit.'
    : 'Этот резервный набор отозван. Создайте и подтвердите новый набор.';
  await until(`document.querySelector('.member-recovery-modal [role=alert]')?.textContent === ${JSON.stringify(retired)}`,
    'The retired kit error explains how to proceed');
  await run("document.querySelector('.member-recovery-modal .modal-heading button').click()");
  await run("document.querySelector('.protected-server-settings .modal-heading button').click()");
  await run("document.querySelector('.member-rail > .member-orb:not(.member-home)').click()");
  await click(en ? 'Lost access to all your devices?' : 'Потеряли доступ ко всем устройствам?');
  await field('.member-recovery-modal textarea', 'synthetic-recovery-kit');
  assert.equal(await run("document.querySelector('.member-recovery-modal .danger-button').disabled"), true);
  assert.ok(await actionsAligned(), 'device recovery action buttons align');
  await run("document.querySelector('.member-recovery-modal input[type=checkbox]').click()");
  await click(en ? 'Recover access' : 'Восстановить доступ');
  await until("window.recoveryCalls.at(-1).action === 'recoverDevice' && !document.querySelector('.member-recovery-modal')", 'replacement device recovered');
  assert.equal(await run("Object.values(localStorage).some(value => value.includes('synthetic-recovery-kit'))"), false);
  console.log('PASS recovery setup, replacement, retry and device UI '+language);

  const openOwnership = async mode => {
   await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/notifications.html?language='+language+'&protected=ownership-'+mode);
   await until("window.protectedAlertPolls > 0 && !!document.querySelector('.member-server-list button')", 'ownership server ready');
   await openSettingsTab(en ? 'Server access' : 'Доступ к серверу');
   await click(en ? 'Transfer ownership' : 'Передача владения');
   await until("!!document.querySelector('.member-ownership-modal[open]')", 'ownership dialog open');
  };
  await openOwnership('offer');
  await until("document.querySelector('.member-ownership-modal select')?.options.length === 1", 'first roster page excludes current owner');
  await click(en ? 'Show more' : 'Показать ещё');
  await until("document.querySelector('.member-ownership-modal select')?.options.length === 2", 'second roster page lists recipient');
  await run("const select = document.querySelector('.member-ownership-modal select'); select.value = 'b'.repeat(64); select.dispatchEvent(new Event('change',{bubbles:true}));");
  assert.equal(await run("document.querySelector('.member-ownership-modal button.primary').disabled"), true);
  assert.ok(await actionsAligned('.member-ownership-modal'), 'ownership offer action buttons align');
  await run("document.querySelector('.member-ownership-modal input[type=checkbox]').click()");
  await click(en ? 'Send offer' : 'Отправить предложение');
  await until("!!document.querySelector('.member-ownership-modal button.danger-button') && window.ownershipCalls.filter(call => call.action === 'ownership.protected.read').length === 2", 'ownership offer remains pending');
  assert.deepEqual(await run("window.ownershipCalls.find(call => call.action === 'ownership.protected.offer').targetProfileId"), 'b'.repeat(64));
  await click(en ? 'Withdraw offer' : 'Отозвать предложение');
  await until("!!document.querySelector('.member-ownership-modal select')", 'owner can withdraw the pending offer');
  assert.equal(await run("window.ownershipCalls.find(call => call.action === 'ownership.protected.cancel').operationId"), 'd'.repeat(32));
  await openOwnership('accept');
  await until("!!document.querySelector('.member-ownership-modal input[type=checkbox]')", 'ordinary member can review the offer');
  assert.equal(await run("window.ownershipCalls.some(call => call.action === 'roster.protected.read')"), false, 'recipient does not need roster permission');
  assert.equal(await run("document.querySelector('.member-ownership-modal button.primary').disabled"), true);
  assert.ok(await actionsAligned('.member-ownership-modal'), 'ownership acceptance buttons align');
  await run("document.querySelector('.member-ownership-modal input[type=checkbox]').click()");
  await click(en ? 'Accept ownership' : 'Принять владение');
  const success = en ? 'You are now the server owner.' : 'Вы стали владельцем сервера.';
  await until(`document.querySelector('.member-ownership-modal p[role=status]')?.textContent === ${JSON.stringify(success)}`, 'accepted ownership receipt displayed');
  assert.equal(await run("window.ownershipCalls.find(call => call.action === 'ownership.protected.accept').operationId"), 'd'.repeat(32));
  console.log('PASS ownership offer, withdrawal, and ordinary recipient acceptance UI '+language);

  await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/notifications.html?language='+language+'&protected=device-binding');
  const bindingDialog = '.member-device-binding-modal';
  const writeableCard = bindingDialog+' textarea:not([readonly])';
  const closeDialog = () => run("document.querySelector('dialog[open] .modal-heading button').click()");
  const closeBinding = () => run(`document.querySelector('${bindingDialog} .modal-heading button').click()`);
  const closeServerSettings = () => run("document.querySelector('.protected-server-settings .modal-heading button').click()");
  const openBinding = async existing => {
   if (existing) {
    await until("window.protectedAlertPolls > 0 && !!document.querySelector('.member-server-list button')", 'device-binding server ready');
    await run("document.querySelector('.member-server-list button').click()");
    await until("!!document.querySelector('.protected-channel-roster .member-self-pin')", 'Own profile appears in the participant list');
    await run("if (document.querySelector('.member-roster-toggle')?.getAttribute('aria-expanded') === 'false') document.querySelector('.member-roster-toggle').click()");
    await run("document.querySelector('.protected-channel-roster .member-self-pin').closest('button').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))");
    await click(profileDevices);
    await click(addDevice);
   } else {
    await run("document.querySelector('.member-rail > .member-orb:not(.member-home)').click()");
    await click(en ? 'Link to an existing profile' : 'Привязать к существующему профилю');
   }
   await until(`!!document.querySelector('${bindingDialog}[open]')`, 'device-binding dialog open');
  };
  await until("window.protectedAlertPolls > 0 && !!document.querySelector('.member-server-list button')", 'Device linking server is ready');
  await run("document.querySelector('.member-server-list button').click()");
  await until("!!document.querySelector('.protected-channel-roster .member-self-pin')", 'Own profile is available');
  await run("if (document.querySelector('.member-roster-toggle')?.getAttribute('aria-expanded') === 'false') document.querySelector('.member-roster-toggle').click()");
  await run("document.querySelector('.protected-channel-roster .member-self-pin').closest('button').click()");
  await click(profileDevices);
  await click(addDevice);
  await until(`!!document.querySelector('${bindingDialog}[open]')`, 'Own participant card opens device linking');
  await closeBinding();
  await closeServerSettings();
  await run("document.querySelector('.protected-roster-back').click()");
  await run("document.querySelector('.member-user-name').click()");
  await click(profileDevices);
  await click(addDevice);
  await until("document.querySelectorAll('dialog[open]').length === 3", 'Profile settings stay open under device linking');
  await closeBinding();
  await closeServerSettings();
  await closeDialog();
  await openBinding(true);
  await click(en ? 'Create link card' : 'Создать карточку привязки');
  await until(`document.querySelector('${bindingDialog} textarea[readonly]')?.value === 'synthetic-link-card'`, 'link card generated');
  await click(en ? 'Copy card' : 'Скопировать карточку');
  await until("window.copied === 'synthetic-link-card'", 'link card copied');
  await closeBinding();
  await closeServerSettings();
  await openBinding(false);
  await field(writeableCard, 'synthetic-link-card');
  await click(en ? 'Create reply card' : 'Создать карточку ответа');
  await until(`document.querySelector('${bindingDialog} code')?.textContent === '1234567890ab'`, 'new device shows comparison code');
  await click(en ? 'Copy card' : 'Скопировать карточку');
  await until("window.copied === 'synthetic-reply-card'", 'reply card copied');
  await click(en ? 'Connect this device' : 'Подключить это устройство');
  const pendingBinding = en ? 'Linking is pending or the card has expired.' : 'Привязка ещё не подтверждена или срок карточки истёк.';
  await until(`document.querySelector('${bindingDialog}')?.textContent.includes(${JSON.stringify(pendingBinding)})`, 'new device can retry after approval');
  await closeDialog();
  await closeDialog();
  await openBinding(true);
  await field(writeableCard, 'synthetic-reply-card');
  await click(en ? 'Verify card' : 'Проверить карточку');
  await until(`document.querySelector('${bindingDialog} code')?.textContent === '1234567890ab'`, 'old device shows the same comparison code');
  assert.equal(await run(`document.querySelector('${bindingDialog} button.primary').disabled`), true);
  assert.ok(await actionsAligned(bindingDialog), 'device-binding approval buttons align');
  await run(`document.querySelector('${bindingDialog} input[type=checkbox]').click()`);
  await click(en ? 'Approve linking' : 'Подтвердить привязку');
  const bindingConfirmed = en ? 'Linking is confirmed.' : 'Привязка подтверждена.';
  await until(`document.querySelector('${bindingDialog} p[role=status]')?.textContent.includes(${JSON.stringify(bindingConfirmed)})`, 'old device confirmed binding');
  await click(en ? 'Done' : 'Готово');
  await closeServerSettings();
  await openBinding(false);
  await field(writeableCard, 'synthetic-link-card');
  await click(en ? 'Create reply card' : 'Создать карточку ответа');
  await until(`document.querySelector('${bindingDialog} code')?.textContent === '1234567890ab'`, 'same challenge resumes after reopening');
  await click(en ? 'Connect this device' : 'Подключить это устройство');
  await until(`!document.querySelector('${bindingDialog}') && window.bindingCalls.at(-1).action === 'device.protected.finish'`, 'new device connected');
  assert.deepEqual(await run('window.bindingCalls.map(call => call.action)'), [
   'device.protected.challenge', 'device.protected.request', 'device.protected.finish',
   'device.protected.preview', 'device.protected.approve', 'device.protected.request', 'device.protected.finish',
  ]);
  const revokeAccess = en ? 'Revoke access' : 'Отозвать доступ';
  await openSettingsTab(profileDevices);
  await until("document.querySelectorAll('.profile-device-list .member-management-row').length === 2", 'Both linked devices are listed');
  assert.equal(await run("document.querySelectorAll('.profile-device-list .member-management-row button').length"), 1);
  await click(revokeAccess);
  assert.equal(await run("window.bindingCalls.some(call => call.action === 'device.protected.revoke')"), false);
  await run("document.querySelector('dialog[open]:not(.protected-server-settings) .modal-actions .danger-button').click()");
  await until("document.querySelectorAll('.profile-device-list .member-management-row').length === 1", 'Only the selected device was removed');
  assert.equal(await run("window.bindingCalls.at(-1).deviceId"), '1234567890abcdef'.repeat(4));
  await closeServerSettings();
  await until("!!document.querySelector('.member-user-name .avatar img, .member-user-name img.avatar')", 'Server profile avatar is shown');
  await run("window.emitDeparture('device-revoked')");
  const revokedTitle = en ? 'This device was unlinked from the server' : 'Это устройство отвязано от сервера';
  const recoveryPrompt = en ? 'Lost access to all your devices?' : 'Потеряли доступ ко всем устройствам?';
  await until(`document.querySelector('dialog[open]')?.textContent.includes(${JSON.stringify(revokedTitle)})`, 'Revoked device sees a distinct notice');
  assert.ok((await run("document.querySelector('dialog[open]').textContent")).includes(recoveryPrompt));
  assert.equal(await run("document.querySelectorAll('.member-server-list button').length"), 0);
  await click(en ? 'Got it' : 'Понятно');
  await until("!document.querySelector('dialog[open]')", 'Revocation notice closes');
  await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/notifications.html?language='+language+'&protected=device-binding');
  await until("!!document.querySelector('.member-server-list button')", 'Profile server is listed');
  await run("window.emitDeparture('profile-unlinked')");
  const unlinkedTitle = en ? 'Profile unlinked' : 'Профиль отсоединён';
  await until(`document.querySelector('dialog[open] h2')?.textContent === ${JSON.stringify(unlinkedTitle)}`, 'Profile unlink notice is shown');
  assert.equal(await run("document.querySelectorAll('.member-server-list button').length"), 0);
  await click(en ? 'Join a server' : 'Присоединиться к серверу');
  await until("!!document.querySelector('.member-join-modal[open]')", 'Unlinked participant can enter a new invitation');
  console.log('PASS protected device linking cards, comparison, approval and retry UI '+language);
  console.log('PASS review follow-up UI '+language+': wizard Enter, badge clipping, avatar overflow, rights, departure modals, linking and transfer copy/finish');
 }
 app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1);}
});
