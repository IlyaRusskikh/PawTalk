// Real production main/preload + built renderer + file-loaded E2EE worker.
const {app}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash,randomBytes}=require('node:crypto');
const https=require('node:https');
app.setPath('userData',path.join(os.tmpdir(),'pawtalk-e2ee-main-'+process.pid));
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.disableHardwareAcceleration();process.argv.push('--smoke','--offscreen-smoke');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(const end=Date.now()+60000;Date.now()<end;){if(await fn())return;await delay(150);}throw Error('Timeout: '+label);}
async function sendWhileAway(address, password, message) {
 const {invitation}=require('../electron/address.cjs');
 const {origin,e2eeKey}=invitation(address);
 const post=(endpoint,data,token)=>new Promise((resolve,reject)=>{
   const req=https.request(origin+endpoint,{method:'POST',rejectUnauthorized:false,headers:{
     'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),
   }},res=>{
     let body='';res.setEncoding('utf8');res.on('data',value=>body+=value);
     res.on('end',()=>{if(res.statusCode===200) resolve(JSON.parse(body));else reject(Error(endpoint+' returned '+res.statusCode));});
   });
   req.on('error',reject);req.end(JSON.stringify(data));
 });
 const {chatFeed,chatToken}=await post('/api/connect',{nickname:'Guest while away',password,e2ee:true,
   e2eeKeyId:createHash('sha256').update(Buffer.from(e2eeKey,'hex')).digest('hex')});
 const {chatKey,encryptChat}=await import('../src/chat.ts');
 await post('/api/chat',await encryptChat(await chatKey(e2eeKey,chatFeed),message),chatToken);
}
let handled=false;
app.on('browser-window-created',(_e,win)=>{
 if(handled)return;handled=true;
 win.webContents.once('did-finish-load',async()=>{
  win.webContents.on('console-message',event=>{if(event.level==='error')console.error('renderer:',event.message);});
  const js=code=>win.webContents.executeJavaScript(`(async()=>{try{return await (${code});}catch(e){console.error(e.stack);throw e;}})()`,true);
  let remoteHost;
  try {
   await until(()=>js('!!document.querySelector(".home-actions")'),'app ready');
   await js(`document.querySelector('.rail-settings').click()`);
   await until(()=>js('!!document.querySelector(".profile-avatar input")'),'avatar picker');
   const sampleAvatar = await js(`(()=>{
     const canvas=document.createElement('canvas'); canvas.width=400; canvas.height=240;
     const ctx=canvas.getContext('2d'); ctx.fillStyle='#a23670';ctx.fillRect(0,0,200,240);
     ctx.fillStyle='#257c9e';ctx.fillRect(200,0,200,240);
     ctx.fillStyle='#ffffff';ctx.fillRect(250,90,30,30);
     return canvas.toDataURL().split(',')[1];
   })()`);
   const avatarFile=path.join(app.getPath('userData'),'avatar-fixture.png');
   await fs.writeFile(avatarFile,Buffer.from(sampleAvatar,'base64'));
   const pickerDebugger=win.webContents.debugger;
   pickerDebugger.attach('1.3');
   const {root}=await pickerDebugger.sendCommand('DOM.getDocument');
   const {nodeId}=await pickerDebugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'.profile-avatar input[type=file]'});
   await pickerDebugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[avatarFile]});
   await until(()=>js('!!document.querySelector(".avatar-crop-preview")'),'crop preview');
   assert.equal(await js('getComputedStyle(document.querySelector(".avatar-crop-preview")).borderRadius'),'50%','avatar editor previews the circular crop');
   const initialCrop = await js('document.querySelector(".avatar-crop-preview").toDataURL()');
   await js(`(()=>{
     const zoom=document.querySelector('.avatar-editor input[type=range]');
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(zoom,'2');
     zoom.dispatchEvent(new Event('input',{bubbles:true}));
   })()`);
   const zoomedCrop = await js('document.querySelector(".avatar-crop-preview").toDataURL()');
   assert.ok(zoomedCrop!==initialCrop,'zoom changes the crop preview');
   const cropPosition=await js(`(()=>{
     const r=document.querySelector('.avatar-crop-preview').getBoundingClientRect();
     return {x:r.left+r.width/2,y:r.top+r.height/2};
   })()`);
   await delay(100);
   await pickerDebugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...cropPosition});
   await delay(50);
   await pickerDebugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:cropPosition.x-75,y:cropPosition.y});
   await until(()=>js(`document.querySelector(".avatar-crop-preview").toDataURL()!==${JSON.stringify(zoomedCrop)}`),'drag moves the crop preview');
   await pickerDebugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:cropPosition.x-75,y:cropPosition.y});
   const avatarButtons=await js(`Array.from(document.querySelectorAll('.avatar-editor .modal-actions button'),button=>{
     const r=button.getBoundingClientRect();return [r.height,r.top+r.height/2];
   })`);
   assert.deepEqual(avatarButtons[0],avatarButtons[1]);
   await js(`document.querySelector('.avatar-editor .primary').click()`);
   await until(()=>js('!!document.querySelector(".profile-avatar img")'),'profile shows saved avatar');
   const savedAvatar = await js('localStorage.getItem("pawtalk.avatar")');
   assert.match(savedAvatar,/^data:image\/webp;base64,/);
   await until(()=>js('document.querySelector(".profile-avatar img").naturalWidth===128'),'saved crop renders at 128 pixels');
   pickerDebugger.detach();
   await js(`document.querySelector('.settings-modal [aria-label="Закрыть"]').click()`);
   await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith('Создать комнату')).click()`);
   await until(()=>js('!!document.querySelector(".encryption-toggle")'),'host form');
   assert.equal(await js('document.querySelector(".encryption-toggle").textContent'),'Сквозное шифрование E2EE');
   assert.equal(await js('document.querySelector(".host-chat-warning")'),null);
   const password=randomBytes(18).toString('hex');
   await js(`(()=>{const inputs=document.querySelector('dialog form').querySelectorAll('input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [i,value] of ${JSON.stringify([[0,'E2EE QA'],[1,password],[2,'34443']])}){set.call(inputs[i],value);inputs[i].dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('.encryption-toggle input').click();})()`);
   assert.match(await js('document.querySelector(".host-chat-kept").textContent'), /перезаходе/);
   assert.match(await js('document.querySelector(".host-chat-ends").textContent'), /закроете комнату/);
   await delay(200);await js(`document.querySelector('dialog form').requestSubmit()`);
   await until(()=>js(`!!document.querySelector('.e2ee-badge') && document.querySelectorAll('.person-card').length===1`),'real encrypted room from checkbox');
   const closeHostInvite = async () => {
     await until(()=>js('!!document.querySelector("dialog[open] .host-stop") && !!document.querySelector(".chat-compose textarea")'),'host invitation stays open in the room');
     assert.equal(await js('document.activeElement === document.querySelector(".chat-compose textarea")'),false);
     await js(`document.querySelector('dialog [aria-label="Закрыть"]').click()`);
     await until(()=>js('document.activeElement === document.querySelector(".chat-compose textarea") && !document.querySelector("dialog[open]")'),'chat receives focus after dismissing the invitation');
   };
   await closeHostInvite();
   const toggleDeafen = () => js(`document.querySelector('[title="Входящий звук"]').click()`);
   const micPressed = () => js(`document.querySelector('[title="Микрофон"]').getAttribute('aria-pressed')`);
   await toggleDeafen();
   await until(async () => (await micPressed()) === 'true', 'deafen visibly mutes the microphone in an active room');
   await toggleDeafen();
   await until(async () => (await micPressed()) === 'false', 'turning sound back on restores the microphone');
   assert.equal(await js('getComputedStyle(document.querySelector(".person-card .avatar")).borderRadius'),'50%');
   assert.equal(await js('getComputedStyle(document.querySelector(".person-details")).visibility'),'hidden');
   const paneHeights = () => js(`['.room-participants','.room-chat'].map(selector => document.querySelector(selector).getBoundingClientRect().height)`);
   const [beforeParticipants,beforeChat] = await paneHeights();
   await js(`document.querySelector('.room-divider').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
   const [afterParticipants,afterChat] = await paneHeights();
   assert.ok(afterParticipants > beforeParticipants && afterChat < beforeChat,'divider resizes both panes');
   assert.ok(await js(`(()=>{
     const controls=document.querySelector('.room-participants .call-controls');
     const buttons=Array.from(controls.children,child=>child.getBoundingClientRect());
     const settings=document.querySelector('.rail .rail-settings').getBoundingClientRect();
     const composer=document.querySelector('.chat-compose textarea').getBoundingClientRect();
     const title=document.querySelector('.room-title h1').getBoundingClientRect();
     const invite=document.querySelector('.page-title .room-presence').getBoundingClientRect();
     const pane=document.querySelector('.room-participants').getBoundingClientRect();
     const chat=document.querySelector('.room-chat');
     return buttons.length===3 && pane.bottom-buttons[0].bottom<28
       && Math.abs((buttons[0].left+buttons[2].right-pane.left-pane.right)/2)<1
       && settings.bottom<=innerHeight && settings.bottom>innerHeight-40
       && Math.abs(title.top+title.height/2-invite.top-invite.height/2)<1
       && !document.querySelector('.participants-heading,.chat-heading h2')
       && Math.abs(chat.getBoundingClientRect().bottom-innerHeight)<1 && getComputedStyle(chat).borderTopWidth==='0px';
   })()`),'call controls are centered above the divider and settings sit at the bottom of the sidebar');
   assert.equal(await js(`document.querySelector('.room-presence').textContent.includes('На связи')`),false);
   await js(`document.querySelector('.person-card').focus()`);
   await until(()=>js('getComputedStyle(document.querySelector(".person-details")).visibility==="visible"'),'focused participant reveals name and network icon');
   const hoverConnection = type => js(`document.querySelector('.person-network').dispatchEvent(new MouseEvent(${JSON.stringify(type)},{bubbles:true}))`);
   await hoverConnection('mouseover');
   assert.equal(await js(`!!document.querySelector('.connection-popover')`),false,'connection details wait before opening');
   await hoverConnection('mouseout');
   await delay(300);
   assert.equal(await js(`!!document.querySelector('.connection-popover')`),false,'passing over the connection icon cancels the tooltip');
   await hoverConnection('mouseover');
   await until(()=>js(`!!document.querySelector('.connection-popover')`),'participant connection tooltip opens');
   assert.match(await js(`document.querySelector('.connection-popover').textContent`), /Пинг до сервера.*Потеря входящих аудиопакетов/);
   await js(`document.querySelector('.person-network').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
   const dividerStyle = () => js(`(()=>{
     const divider=document.querySelector('.room-divider');
     return [getComputedStyle(divider,'::before').backgroundColor,parseFloat(getComputedStyle(divider,'::after').width)];
   })()`);
   const [lineColor,restingGrip] = await dividerStyle();
   const grip = await js(`(()=>{
     const r=document.querySelector('.room-divider').getBoundingClientRect();
     return {x:r.left+r.width/2,y:r.top+r.height/2};
   })()`);
   const debuggerClient=win.webContents.debugger;
   debuggerClient.attach('1.3');
   await debuggerClient.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...grip});
   await delay(200);
   const [hoverLineColor,hoverGrip] = await dividerStyle();
   assert.equal(hoverLineColor,lineColor,'hover does not highlight the full line');
   assert.ok(hoverGrip>restingGrip,'the center grip widens on hover');
   await debuggerClient.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:grip.x,y:grip.y+20});
   const firstLine = 'Encrypted embedded chat QA';
   const secondLine = 'Second line after Shift+Enter\n'+'Additional line for scroll fade\n'.repeat(24).trimEnd();
   const message = firstLine+'\n'+secondLine;
   const composerHeight = () => js(`document.querySelector('.chat-compose textarea').getBoundingClientRect().height`);
   const emptyHeight = await composerHeight();
   await js(`document.querySelector('.chat-compose textarea').focus()`);
   await debuggerClient.sendCommand('Input.insertText',{text:'Long draft line\n'.repeat(30)});
   assert.ok(await js(`(()=>{
     const field=document.querySelector('.chat-compose textarea');
     return field.offsetHeight<=164 && field.scrollHeight>field.clientHeight
       && document.querySelector('.chat-stream').clientHeight>0;
   })()`),'long drafts scroll inside the capped composer while chat remains visible');
   await js(`(()=>{
     const field=document.querySelector('.chat-compose textarea');
     Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'');
     field.dispatchEvent(new Event('input',{bubbles:true}));
   })()`);
   await debuggerClient.sendCommand('Input.insertText',{text:firstLine});
   await debuggerClient.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:8,text:'\r'});
   await debuggerClient.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:8});
   await debuggerClient.sendCommand('Input.insertText',{text:secondLine});
   assert.equal(await js(`document.querySelector('.chat-compose textarea').value`),message,'Shift+Enter adds a newline without sending');
   assert.ok(await composerHeight()>emptyHeight,'composer grows for multiline drafts');
   await debuggerClient.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
   await debuggerClient.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
   debuggerClient.detach();
   const checkMessage = () => until(()=>js(`document.querySelector('.chat-message p')?.textContent===${JSON.stringify(message)}`),'saved embedded message');
   await checkMessage();
   assert.equal(await composerHeight(),emptyHeight,'composer shrinks after send');
   assert.equal(await js(`document.querySelector('.chat-avatar img')?.src`),savedAvatar);
   assert.match(await js(`document.querySelector('.chat-meta time').textContent`), /^\d{2}:\d{2}$/);
   await js(`document.querySelector('.chat-meta time').focus({preventScroll:true})`);
   assert.match(await js(`document.querySelector('.chat-date-tip')?.textContent`), /\d{4}.*\d{2}:\d{2}/);
   assert.equal(await js(`document.querySelector('.person-card .avatar img')?.src`),savedAvatar);
   assert.ok(await js(`document.querySelector('.chat-stream').scrollHeight>document.querySelector('.chat-stream').clientHeight`),'long messages scroll inside the chat');
   await js(`document.querySelector('.rail-settings').click()`);
   await js(`(()=>{
     const field=document.querySelector('.profile-settings input[maxlength="32"]');
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'Переименованный автор');
     field.dispatchEvent(new Event('input',{bubbles:true}));
   })()`);
   await js(`document.querySelector('.settings-modal [aria-label="Закрыть"]').click()`);
   await until(()=>js(`document.querySelector('.chat-meta strong')?.textContent==='Переименованный автор'
     && document.querySelector('.person-card h3')?.textContent.startsWith('Переименованный автор')`),'rename updates an earlier message and the participant card');
   await js(`(()=>{
     Object.defineProperty(document,'visibilityState',{value:'visible'});
     document.hasFocus=()=>true;
     const stream=document.querySelector('.chat-stream');
     stream.scrollTop=stream.scrollHeight;
     window.dispatchEvent(new Event('focus'));
   })()`);
   await until(()=>js('!document.querySelector(".chat-jump")'),'first message is read');
   const anchorOffset=()=>js('document.querySelector("[data-message-row]").offsetTop-document.querySelector(".chat-stream").scrollTop');
   await js(`(()=>{const list=document.querySelector('.chat-stream');list.scrollTop=60;list.dispatchEvent(new Event('scroll'));})()`);
   await until(()=>js('document.querySelector(".chat-stream").hasAttribute("data-more-below")'),'reading an older part of the chat');
   const savedOffset=await anchorOffset();
   const previousInvite = (await js('window.desktop.hostStatus()')).localAddress;
   await js(`document.querySelector('[title="Отключиться"]').click()`);
   await until(()=>js(`Array.from(document.querySelectorAll('.home-action')).some(b=>b.textContent.startsWith('Моя комната'))`),'own room stays running after leaving');
   const missedMessage = 'Sent while you were away';
   await sendWhileAway(previousInvite,password,missedMessage);
   await js(`Array.from(document.querySelectorAll('.home-action')).find(b=>b.textContent.startsWith('Моя комната')).click()`);
   const hostButtons = await js(`Array.from(document.querySelectorAll('dialog .modal-actions button'), b => { const r=b.getBoundingClientRect(); return [r.height,r.y+r.height/2]; })`);
   assert.equal(hostButtons.length,2);
   assert.deepEqual(hostButtons[0],hostButtons[1],'join and stop buttons have the same height and center');
   await js(`Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent==='Войти в комнату').click()`);
   await closeHostInvite();
   await checkMessage();
   await until(()=>js('!!document.querySelector(".chat-jump")'),'jump button for the message sent while away');
   assert.equal(await js('document.querySelector(".chat-divider")?.textContent'),'Новые сообщения');
   const restoredOffset=await anchorOffset();
   assert.ok(Math.abs(restoredOffset-savedOffset)<=1,`rejoining restores the exact message offset (${savedOffset} → ${restoredOffset})`);
   assert.equal(await js('document.querySelector(".chat-jump").textContent'),'К новым сообщениям');
   assert.ok(await js(`(()=>{
     const button=document.querySelector('.chat-jump').getBoundingClientRect(), composer=document.querySelector('.chat-compose').getBoundingClientRect();
     return Math.abs(button.left+button.width/2-composer.left-composer.width/2)<1 && button.bottom<composer.top;
   })()`),'jump button is centered above the composer');
   await js('document.querySelector(".chat-jump").click()');
   await until(()=>js(`document.querySelector('.chat-message:last-child p')?.textContent===${JSON.stringify(missedMessage)}
     && !document.querySelector('.chat-jump')`),'jump shows and reads the missed message');
   await js(`(()=> {
     const input=document.querySelector('.chat-compose textarea');
     Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Первое сообщение после входа');
     input.dispatchEvent(new Event('input',{bubbles:true}));
   })()`);
   await js(`document.querySelector('.chat-composer').requestSubmit()`);
   await until(()=>js(`document.querySelector('.chat-message:last-child p')?.textContent==='Первое сообщение после входа'
     && !document.querySelector('.chat-divider,.chat-jump')`),'own message clears the entry marker without creating a new jump');
   assert.ok(await js(`(()=>{const list=document.querySelector('.chat-stream');return list.scrollHeight-list.scrollTop-list.clientHeight<2;})()`),'own message scrolls to the bottom');
   await js(`document.querySelector('[title="Пригласить пользователя"]').click()`);
   await js(`document.querySelector('.host-stop').click()`);
   await until(()=>js(`window.desktop.hostStatus().then(s=>!s.running && !document.querySelector('dialog[open]'))`),'embedded server stopped');
   await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith('Создать комнату')).click()`);
   await js(`(()=>{
     const form=document.querySelector('dialog form'), input=form.querySelector('input[autocomplete="new-password"]');
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(password)});
     input.dispatchEvent(new Event('input',{bubbles:true}));
   })()`);
   assert.equal(await js(`document.querySelectorAll('dialog form input[type=password]').length`),1,'create form requests only the room password');
   await js(`document.querySelector('dialog form').requestSubmit()`);
   await closeHostInvite();
   assert.notEqual((await js('window.desktop.hostStatus()')).localAddress,previousInvite,'restart issues a fresh TLS invitation');
   await until(()=>js(`document.querySelector('.chat-empty')?.textContent==='Сообщений пока нет.'`),'embedded chat is empty after server restart');
   await assert.rejects(fs.access(path.join(app.getPath('userData'),'hosted-room','chat.sqlite')),{code:'ENOENT'});
   await js(`document.querySelector('[title="Добавить в закладки"]').click()`);
   await until(()=>js('!!document.querySelector(".bookmark-orb")'),'bookmark saved');
   assert.equal(await js('document.querySelector(".participant-pin").textContent'),'1');
   assert.equal(await js('document.querySelector(".bookmark-add").getAttribute("aria-pressed")'),'true');
   await js(`document.querySelector('.bookmark-add').click()`);await delay(100);
   assert.equal(await js('document.querySelectorAll(".bookmark-orb").length'),0);
   assert.equal(await js('document.querySelector(".bookmark-add").getAttribute("aria-pressed")'),'false');
   await js(`document.querySelector('.bookmark-add').click()`);await delay(100);
   assert.equal(await js('document.querySelector(".bookmark-add").classList.contains("bookmarked")'),true);
   assert.equal(await js('document.querySelectorAll(".room-title button").length'),1,'no rename pencil beside title');
   await js(`document.querySelector('.bookmark-orb').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:30,clientY:120}))`);await delay(100);
   await js(`document.querySelector('.bookmark-menu button').click()`);
   await js(`(()=>{const el=document.querySelector('dialog input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'Renamed room');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   await delay(100);await js(`document.querySelector('dialog form').requestSubmit()`);await delay(100);
   assert.equal(await js('document.querySelector("h1").textContent'),'Renamed room');
   assert.equal(await js('document.querySelector(".bookmark-orb").getAttribute("aria-label")'),'Renamed room');
   await js(`document.querySelector('.home-orb').click()`);await delay(100);
   assert.ok(await js('!!document.querySelector(".home-actions")'));
   assert.equal(await js(`!!document.querySelector('.call-controls')`),false,'lobby has no call controls');
   assert.ok(await js(`!!document.querySelector('.return-room')`),'voice stays connected and lobby offers return to call');
   // Deleting saved credentials makes any unintended reconnect fail visibly.
   const address=await js('JSON.parse(localStorage.getItem("pawtalk.bookmarks"))[0].address');
   await js(`window.desktop.savePassword(${JSON.stringify({address,password:null})})`);
   await js(`document.querySelector('.bookmark-orb').click()`);await delay(300);
   assert.equal(await js('document.querySelector("h1").textContent'),'Renamed room');
   assert.equal(await js('document.querySelectorAll("dialog[open]").length'),0,'active bookmark requires no credentials or reconnect');
   assert.equal(await js('document.querySelectorAll(".person-card").length'),1);
   for(const label of ['Устройство ввода','Устройство вывода']) {
    await js(`document.querySelector('[title="${label}"]').click()`);await delay(100);
    assert.equal(await js('document.querySelectorAll(".audio-quick-menu:popover-open").length'),1);
    await js(`(()=>{const el=document.querySelector('.audio-quick-menu:popover-open input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'0.5');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(100);
    const deviceKey=label==='Устройство ввода'?'inputDevice':'outputDevice';
    const device=await js(`navigator.mediaDevices.enumerateDevices().then(devices=>devices.find(device=>device.kind===${JSON.stringify(deviceKey==='inputDevice'?'audioinput':'audiooutput')} && device.deviceId && !['default','communications'].includes(device.deviceId)).deviceId)`);
    await js(`document.querySelector('.audio-quick-menu:popover-open .audio-device-trigger').click()`);await delay(100);
    assert.equal(await js('document.querySelectorAll(".audio-device-list:popover-open [aria-pressed=true]").length'),1);
    assert.ok(await js(`(()=>{const a=document.querySelector('.audio-quick-menu:popover-open').getBoundingClientRect();const b=document.querySelector('.audio-device-list:popover-open').getBoundingClientRect();return b.left>=a.right && b.right<=innerWidth && b.bottom<=innerHeight;})()`), 'device list opens beside the menu inside the viewport');
    await js(`document.querySelectorAll('.audio-device-list:popover-open .audio-device-option')[1].click()`);await delay(300);
    assert.equal(await js(`JSON.parse(localStorage.getItem('pawtalk.settings')).${deviceKey}`),device);
    assert.equal(await js('document.querySelectorAll(".audio-quick-menu:popover-open").length'),1,'device selection keeps volume controls open');
    assert.equal(await js('document.querySelectorAll(".audio-device-list:popover-open").length'),0);
    const key=label==='Устройство ввода'?'inputGain':'outputVolume';
    assert.equal(await js(`JSON.parse(localStorage.getItem('pawtalk.settings')).${key}`),0.5);
   }
   await fs.mkdir(path.resolve('release/qa'),{recursive:true});
   await js(`document.querySelector('.audio-quick-menu:popover-open .audio-device-trigger').click()`);await delay(100);
   assert.equal(await js(`document.querySelector('.audio-device-list:popover-open .audio-device-option[aria-pressed=true]')===document.querySelectorAll('.audio-device-list:popover-open .audio-device-option')[1]`),true,'reopening highlights the selected device');
   await fs.writeFile(path.resolve('release/qa/room-quick-audio.png'),(await win.webContents.capturePage()).toPNG());
   await js(`document.querySelector('.audio-quick-menu:popover-open').hidePopover()`);
   assert.equal(await js('window.desktop.getAutoStart()'),false,'development app never registers startup');
   const state=await js('window.desktop.hostStatus()');assert.equal(state.e2ee,true);assert.match(state.localAddress,/e2ee=[a-f0-9]{64}/);
   assert.equal(await js(`window.desktop.roomPresence(${JSON.stringify(state.localAddress)})`),1,'real LiveKit aggregate occupancy');
   const response=await js(`window.desktop.connect(${JSON.stringify({address:state.localAddress,nickname:'IPC QA',password})})`);
   assert.equal(response.error,undefined,response.error);assert.equal(response.e2eeRequired,true);assert.match(response.e2eeKey,/^[a-f0-9]{64}$/);
   const {invitation}=require('../electron/address.cjs');assert.equal(response.e2eeKey,invitation(state.localAddress).e2eeKey);
   const missing=state.localAddress.replace(/&e2ee=[a-f0-9]{64}/,'');
   const denied=await js(`window.desktop.connect(${JSON.stringify({address:missing,nickname:'Legacy',password})})`);assert.ok(denied.error);
   const caps=await js('window.desktop.capabilities()');
   if(caps.secureStorage){
    await js(`window.desktop.savePassword(${JSON.stringify({address:state.localAddress.split('#')[0],password,e2eeKey:response.e2eeKey})})`);
    const saved=await js(`window.desktop.loadPassword(${JSON.stringify(state.localAddress.split('#')[0])})`);assert.equal(saved.e2eeKey,response.e2eeKey);
    await js(`window.desktop.savePassword(${JSON.stringify({address:state.localAddress.split('#')[0],password:null})})`);
    assert.equal((await js(`window.desktop.loadPassword(${JSON.stringify(state.localAddress.split('#')[0])})`)).e2eeKey,null);
   }
   // A second local server models the VPS while the built-in host keeps running.
   const {SelfHost}=require('../electron/selfhost.cjs');remoteHost=new SelfHost(path.resolve('resources/server'));
   const remote=await remoteHost.start({port:35443,password,name:'VPS QA',e2ee:true});
   await js(`document.querySelector('.home-orb').click()`);await delay(100);
   await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith('Присоединиться к комнате')).click()`);await delay(100);
   await js(`(()=>{const input=document.querySelector('dialog input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(remote.localAddress)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(100);
   await js(`document.querySelector('dialog form').requestSubmit()`);
   await until(()=>js(`document.querySelector('h1')?.textContent==='VPS QA' && document.querySelectorAll('.person-card').length===1`),'join second server with selfhost running');
   assert.equal((await js('window.desktop.hostStatus()')).running,true);
   await js(`document.querySelector('[title="Пригласить пользователя"]').click()`);await delay(100);
   assert.equal(await js('document.querySelectorAll("dialog[open]").length'),1);
   assert.equal(await js('document.querySelectorAll(".host-stop").length'),0,'VPS invitation does not show selfhost controls');
   assert.ok((await js('document.querySelector("dialog input").value')).includes(':35443/'));
   await js(`document.querySelector('dialog [aria-label="Закрыть"]').click()`);await delay(100);
   await js('window.desktop.stopHost()');await delay(200);
   assert.equal(await js('document.querySelector("h1").textContent'),'VPS QA','stopping own host keeps remote voice session');
   await js(`document.querySelector('.rail-settings').click()`);
   await js(`document.querySelector('#settings-tab-general').click()`);await delay(100);
   await js(`(()=>{
     const select=document.querySelector('#settings-panel select');
     select.value='en'; select.dispatchEvent(new Event('change',{bubbles:true}));
   })()`);
   await until(()=>js(`document.documentElement.lang==='en'`),'English call controls');
   await js(`document.querySelector('dialog [aria-label="Close"]').click()`);
   await js(`document.querySelector('[title="Output device"]').click()`);await delay(100);
   assert.ok(await js('document.querySelector(".audio-quick-menu:popover-open").textContent.includes("Speaker volume")'));
   await js(`document.querySelector('.audio-quick-menu:popover-open .audio-device-trigger').click()`);await delay(100);
   assert.equal(await js('document.querySelector(".audio-device-list:popover-open").getAttribute("aria-label")'),'Output device');
   await fs.writeFile(path.resolve('release/qa/quick-audio-en.png'),(await win.webContents.capturePage()).toPNG());
   await js(`document.querySelector('.audio-quick-menu:popover-open').hidePopover()`);
   await js(`document.querySelector('[title="Disconnect"]').click()`);await delay(100);
   await until(()=>js(`window.desktop.roomPresence(${JSON.stringify(remote.localAddress)}).then(count=>count===0)`),'presence eventually updates after leaving');
   await remoteHost.stop();remoteHost=null;
   await win.reload();
   await until(()=>js(`!!document.querySelector('h1') && document.documentElement.lang==='en'`),'English home');
   assert.equal(await js('document.querySelector(".bookmark-orb").getAttribute(\"aria-label\")'),'Renamed room','alias persists after reload');
   await js(`document.querySelector('[title="Settings"]').click()`);await delay(200);
   await js(`document.querySelector('#settings-tab-general').click()`);await delay(100);
   assert.ok(await js('document.querySelector("dialog").textContent.includes("Start PawTalk when signing in to Windows")'));
   await js(`document.querySelector('#settings-tab-profile').click()`);await delay(100);
   assert.equal(await js(`document.querySelector('.profile-avatar img')?.src`),savedAvatar,'avatar survives renderer restart');
   await js(`Array.from(document.querySelectorAll('.profile-avatar button')).find(b=>b.textContent==='Remove avatar').click()`);
   await until(()=>js('!document.querySelector(".profile-avatar img") && localStorage.getItem("pawtalk.avatar")===null'),'remove restores initials');
   await js(`document.querySelector('dialog [aria-label="Close"]').click()`);await delay(100);
   await js(`document.querySelector('.bookmark-orb').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:30,clientY:120}))`);await delay(100);
   await js(`document.querySelector('.bookmark-menu button').click()`);await delay(100);
   for(const width of [940,1100]) {
    win.setSize(width,760);await delay(100);
    const geometry=await js(`(()=>{const buttons=[...document.querySelectorAll('dialog .modal-actions button')];return buttons.map(b=>{const r=b.getBoundingClientRect();return {height:r.height,center:r.y+r.height/2};});})()`);
    assert.ok(Math.abs(geometry[0].center-geometry[1].center)<1);
    assert.equal(geometry[0].height,geometry[1].height);
   }
   await fs.writeFile(path.resolve('release/qa/rename-en.png'),(await win.webContents.capturePage()).toPNG());
   await js(`document.querySelector('dialog [aria-label="Close"]').click()`);
   await js(`Array.from(document.querySelectorAll('.home-action')).find(b=>b.textContent.startsWith('Create a room')).click()`);
   await js(`document.querySelector('.encryption-toggle input').click()`);
   assert.equal(await js(`document.querySelectorAll('dialog form input[type=password]').length`),1);
   assert.equal(await js('document.querySelector(".encryption-toggle").textContent'),'End-to-end encryption');
   assert.match(await js('document.querySelector(".host-chat-kept").textContent'), /rejoin the room/);
   console.log('PASS production IPC, E2EE, embedded chat rejoin and restart, room alias persistence, lobby navigation, active bookmark, live presence, quick audio, RU/EN UI');app.exit(0);
  }catch(error){console.error(error);try{await remoteHost?.stop();await js('window.desktop.stopHost()');}catch{}app.exit(1);}
 });
});
require('../electron/main.cjs');
