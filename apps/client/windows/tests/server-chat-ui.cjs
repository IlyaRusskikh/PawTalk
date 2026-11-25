const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:760,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error'){errors.push(event.message);console.error('renderer:',event.message);}});
 const timeout=setTimeout(()=>{console.error('chat UI watchdog timeout');app.exit(1);},90000);
 const run=code=>win.webContents.executeJavaScript(code,true),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async(code,label)=>{for(let i=0;i<180;i++){if(await run(code))return;await wait(50);}throw Error(label+': '+await run('document.body.innerText.slice(-1800)'));};
 const layout=()=>run('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
 const settledHistory=async()=>{
  await until("document.querySelector('.member-history')?.getAttribute('aria-busy')==='false'",'history requests complete');
  await layout();
  await run("Promise.all(document.querySelector('.member-history').getAnimations({subtree:true}).filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>{})))");
  await layout();
 };
 const set=(selector,value)=>run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const enter=extra=>run(`document.querySelector('.member-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...${JSON.stringify(extra||{})}}))`);
 try{
 await win.loadURL('about:blank');win.webContents.debugger.attach('1.3');
 for(const language of ['ru','en'])for(const reduced of ['reduce','no-preference']){
  win.setSize(1100,760);await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced}]});
  await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/server-chat.html?lang='+language);
  await until("document.querySelectorAll('[data-message-row]').length===25&&document.querySelector('.chat-reply-quote .chat-reply-text')?.textContent==='Original current'",'fresh off-page quote is visible without the author');
  assert.equal(await run("getComputedStyle(document.querySelector('.chat-reply-quote .chat-reply-text')).textOverflow"),'ellipsis');
  await until("document.activeElement===document.querySelector('.member-composer textarea')",'initial autofocus');
  assert.equal(await run("getComputedStyle(document.querySelector('.chat-stream'),'::-webkit-scrollbar').width"),'9px');
  await run("document.documentElement.style.setProperty('--ui-radius','24px')");
  await set('.member-composer textarea','Long composer line '.repeat(180));
  await until("document.querySelector('.member-composer textarea').scrollHeight>document.querySelector('.member-composer textarea').clientHeight",'composer overflows at maximum radius');
  const clipping=await run("(()=>{const shell=document.querySelector('.chat-input-shell'),field=shell.querySelector('textarea'),r=shell.getBoundingClientRect(),f=field.getBoundingClientRect();field.scrollTop=60;return {radius:getComputedStyle(shell).borderTopRightRadius,inside:f.right<=r.right&&f.bottom<=r.bottom,corner:document.elementFromPoint(r.right-2,r.top+2)!==field,scroll:field.scrollTop>0}})()");
  assert.deepEqual(clipping,{radius:'18px',inside:true,corner:true,scroll:true},'rounded composer clips the scrollbar and remains scrollable');
  if(language==='ru'&&reduced==='no-preference'){await fs.mkdir('release/qa',{recursive:true});win.webContents.invalidate();await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await wait(180);await fs.writeFile('release/qa/chat-composer-max-radius.png',(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());}
  await set('.member-composer textarea','');
  await settledHistory();
  if(language==='ru'&&reduced==='no-preference'){await fs.mkdir('release/qa',{recursive:true});await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await wait(180);await fs.writeFile('release/qa/chat-restored-ru.png',(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());}
  await run("document.querySelector('.member-reply').click()");
  await until("!!document.querySelector('[data-message-row=\"20\"].chat-message-target')",'around lookup highlights source');
  const target=await run("(()=>{const list=document.querySelector('.member-history'),row=document.querySelector('[data-message-row=\"20\"]'),a=list.getBoundingClientRect(),b=row.getBoundingClientRect();return b.top>=a.top&&b.bottom<=a.bottom})()");assert.equal(target,true,'source is visible');
  // Include a slow-renderer case so the resize assertion cannot depend on a
  // fast desktop or the old 150 ms delay.
  if(language==='en'&&reduced==='no-preference')await win.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate',{rate:4});
  for(const [width,height] of [[940,650],[1080,700],[940,650]]){
   // Wait for committed layout/ResizeObserver delivery, not an assumed amount
   // of runner CPU time. Hidden non-offscreen windows can suppress frames.
   await layout();
   const bottomAnchor=await run("(()=>{const list=document.querySelector('.member-history'),box=list.getBoundingClientRect(),row=[...list.querySelectorAll('[data-message-row]')].reverse().find(e=>{const r=e.getBoundingClientRect();return r.top<box.bottom&&r.bottom>box.top});return{id:row.dataset.messageRow,offset:row.getBoundingClientRect().bottom-box.bottom}})()");
   win.setSize(width,height);
   const [contentWidth,contentHeight]=win.getContentSize();
   await until(`innerWidth===${contentWidth}&&innerHeight===${contentHeight}`,'renderer receives native window size');
   await layout();
   const restored=await run(`(()=>{const list=document.querySelector('.member-history'),row=list.querySelector('[data-message-row="${bottomAnchor.id}"]');return row.getBoundingClientRect().bottom-list.getBoundingClientRect().bottom})()`);
   assert.ok(Math.abs(restored-bottomAnchor.offset)<3,`resize retains reading anchor ${language}/${reduced} at ${width}x${height}: row ${bottomAnchor.id}, expected ${bottomAnchor.offset}, actual ${restored}`);
  }
  await win.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate',{rate:1});
  await run("document.querySelector('.member-history').scrollTop=0;document.querySelector('.member-history').dispatchEvent(new Event('scroll'))");
  await until("Number(document.querySelector('[data-message-row]').dataset.messageRow)<8",'scroll loads previous page');
  assert.ok(await run("document.querySelectorAll('[data-message-row]').length>25"),'older pages retain the already loaded messages');
  await set('.member-composer textarea','Saved draft');await run("window.select('other')");await until("!!document.querySelector('.chat-empty-state')",'second chat');
  await run("window.select('general')");await until("document.querySelector('.member-composer textarea')?.value==='Saved draft'&&!!document.querySelector('[data-message-row]')",'draft and position restored');
  assert.ok(await run("Number(document.querySelector('[data-message-row]').dataset.messageRow)<100"),'reading position survives channel switch');
  await run("document.querySelector('.chat-jump').click()");
  await until("!!document.querySelector('[data-message-row=\"180\"]')",'return to latest');
  await run("window.update(20,'Updated **source**')");await until("document.querySelector('.member-reply')?.title.includes('Updated source')",'off-page edit refreshes quote');
  await run('window.remove(20)');await until("!document.querySelector('.member-reply')?.title.includes('Updated source')",'deleted source no longer quoted as live');
  await set('.member-composer textarea','Retry once');await run('window.failNext=true');await enter();
  await until("window.sendRequests.length===1&&!document.querySelector('.member-composer textarea').readOnly",'failed send returns control');
  assert.equal(await run("document.querySelector('.member-composer textarea').value"),'Retry once');
  await enter();await until("!!document.querySelector('[data-message-row=\"181\"]')",'retry confirms message');
  assert.equal(await run('window.sendRequests[0].requestId===window.sendRequests[1].requestId'),true,'retry retains request ID');
  await until("document.activeElement===document.querySelector('.member-composer textarea')&&!document.querySelector('.member-composer textarea').readOnly",'send restores focus');
  await set('.member-composer textarea','Not yet');await enter({repeat:true});await enter({isComposing:true});await enter({shiftKey:true});await wait(80);assert.equal(await run('window.sendRequests.length'),2,'repeat, IME and Shift+Enter do not submit');
  await run('window.hold=true');await set('.member-composer textarea','Delayed send');await enter();await enter();
  await until("document.querySelector('.member-composer textarea').readOnly",'pending composer retains focus');assert.equal(await run("document.querySelector('.member-composer textarea').disabled"),false);
  await until("document.querySelector('.chat-message-pending .member-message-text')?.textContent==='Delayed send'",'unconfirmed message appears immediately');
  assert.equal(await run("(()=>{const e=document.querySelector('.chat-message-pending .member-message-text'),probe=document.createElement('span');probe.style.color='var(--muted)';document.body.append(probe);const muted=getComputedStyle(probe).color;probe.remove();return getComputedStyle(e).color===muted})()"),true,'unconfirmed text is gray');
  assert.equal(await run("!!document.querySelector('.chat-message-pending .member-message-actions')"),false,'unconfirmed message cannot be edited/deleted');
  await run('window.hold=false;window.release()');await until("!!document.querySelector('[data-message-row=\"182\"]')",'delayed send');assert.equal(await run('window.sendRequests.length'),3,'double Enter creates one send');
  await until("!document.querySelector('.chat-message-pending')",'confirmation restores normal message color');
  assert.equal(await run(`(() => {
    const first = document.querySelector('[data-message-row="181"]');
    const next = document.querySelector('[data-message-row="182"]');
    return next.parentElement.classList.contains('chat-message-continuation') &&
      getComputedStyle(first).paddingBottom === getComputedStyle(next).paddingTop &&
      getComputedStyle(first.parentElement).paddingBottom === getComputedStyle(next.parentElement).paddingTop;
  })()`),true,'the first gap uses the compact group spacing');
  await run('window.reply(182,181)');
  await until("document.querySelector('[data-message-row=\"182\"] .member-reply')?.title.includes('Retry once')&&!document.querySelector('.chat-jump')",'recent reply is displayed at bottom');
  // The send flight transforms a descendant outside its normal bounds. Its
  // completion can shrink scrollHeight independently of clicking the quote.
  // Compare settled geometry so this assertion isolates reply navigation.
  await settledHistory();
  assert.equal(await run("(()=>{const list=document.querySelector('.member-history'),row=document.querySelector('[data-message-row=\"181\"]'),a=list.getBoundingClientRect(),b=row.getBoundingClientRect();return b.top>=a.top&&b.bottom<=a.top+list.clientHeight})()"),true,'reply source is already fully visible');
  const beforeVisibleJump=await run("document.querySelector('.member-history').scrollTop");
  await run("document.querySelector('[data-message-row=\"182\"] .member-reply').click()");
  await until("!!document.querySelector('[data-message-row=\"181\"].chat-message-target')",'visible source highlights');
  await layout();
  assert.equal(await run("document.querySelector('.member-history').scrollTop"),beforeVisibleJump,'visible source does not move history');
  assert.equal(await run("!!document.querySelector('.chat-jump')"),false,'visible source does not enter older-history mode');
  const textGeometry=()=>run("(()=>{const e=document.querySelector('[data-message-row=\"181\"] .member-message-text'),line=e.querySelector('.chat-markdown-line');return{height:e.getBoundingClientRect().height,line:line.getBoundingClientRect().height}})()");
  const plain=await textGeometry();assert.ok(Math.abs(plain.height-plain.line)<1,'unedited message has no reserved edited line');
  await run("window.update(181,'Retry once')");
  await until("!!document.querySelector('[data-message-row=\"181\"] .chat-edited')",'edited label appears');
  const edited=await textGeometry();assert.ok(edited.height>plain.height+8,'edited label adds its own space only after editing');
  await set('.member-composer textarea','Draft kept while editing');
  await run("document.querySelector('[data-message-row=\"182\"] .member-message-actions button:nth-child(2)').click()");
  await until("document.activeElement===document.querySelector('.chat-inline-edit textarea')",'inline editing focus');
  await run("document.querySelector('.chat-inline-edit').requestSubmit()");await until("!document.querySelector('.chat-inline-edit')",'no-op edit closes');assert.equal(await run('window.sendRequests.length'),3,'no-op edit makes no request');
  assert.equal(await run("document.querySelector('.member-composer textarea').value"),'Draft kept while editing');
  await run("document.querySelector('[data-message-row=\"182\"] .member-message-actions button:nth-child(2)').click()");await set('.chat-inline-edit textarea','Edited now');await run("document.querySelector('.chat-inline-edit').requestSubmit()");
  await until("document.querySelector('[data-message-row=\"182\"] .member-message-text')?.textContent.includes('Edited now')&&!document.querySelector('.chat-inline-edit')",'inline edit committed');
  await run("document.querySelector('[data-message-row=\"182\"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:140}))");
  await until("!!document.querySelector('.chat-message-menu')",'message context menu');await run("document.querySelector('.chat-message-menu button:nth-child(2)').click()");await until("window.copied==='Edited now'",'copy text');
  await run("document.querySelector('[data-message-row=\"182\"] .member-message-actions button:last-child').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))");await until("!document.querySelector('[data-message-row=\"182\"]')",'Shift delete skips confirmation');assert.equal(await run("!!document.querySelector('dialog[open]')"),false);assert.equal(await run("!!document.querySelector('.chat-jump')"),false,'deleting latest message does not show phantom newer history: '+JSON.stringify(await run("(()=>{const l=document.querySelector('.member-history');return{ids:[...document.querySelectorAll('[data-message-row]')].map(e=>e.dataset.messageRow),loaders:[...document.querySelectorAll('.chat-page-loader')].map(e=>e.textContent),scroll:[l.scrollTop,l.scrollHeight,l.clientHeight]}})()")));
  assert.equal(await run("!!document.querySelector('.member-message-actions')"),true,'quick actions retained');
  await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/server-chat.html?lang='+language+'&unread=1');
  await until(`(()=>{
    const divider=document.querySelector('.chat-divider');
    return divider?.nextElementSibling?.dataset.messageRow==='101'
      &&Math.abs(divider.getBoundingClientRect().top-document.querySelector('.member-history').getBoundingClientRect().top)<4;
  })()`,'first unread message starts at the top of the viewport');
  const historyReads=await run('window.liveReads.filter(options=>!options.ids)');
  assert.ok(historyReads.some(options=>options.around===101&&options.limit===25),'unread entry requests the configured batch around the read cursor');
  assert.ok(historyReads.every(options=>options.limit>0&&options.limit<=25),'history requests remain bounded when the next page loads automatically');
  console.log(`PASS restored chat UI ${language}/${reduced}: live quotes, around jump, paging/resize/position, draft/focus, retry, inline edit, copy and Shift-delete`);
 }
 assert.deepEqual(errors,[]);app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1);}
});
