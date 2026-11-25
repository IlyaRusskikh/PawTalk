const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs/promises');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}}),run=code=>win.webContents.executeJavaScript(code,true),wait=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(code,label)=>{for(let i=0;i<140;i++){if(await run(code))return;await wait(40);}throw Error(label+': '+await run("document.body.innerText.slice(-1200)"));};
 const type=value=>run(`(()=>{const input=document.querySelector('.member-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const send=()=>run("document.querySelector('.member-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
 try{
  await win.loadURL('about:blank');win.webContents.debugger.attach('1.3');
  for(const lang of ['ru','en'])for(const motion of ['no-preference','reduce']){
   await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:motion}]});
   await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/server-chat.html?features=1&lang='+lang);await until("!!document.querySelector('[data-message-row=\"180\"]')",'history ready');
   await run("window.sendFlights=[];const animate=Element.prototype.animate;Element.prototype.animate=function(...args){if(this.matches('.member-message-text'))window.sendFlights.push({pending:!!this.closest('.chat-message-pending'),frames:args[0]});return animate.apply(this,args);};true;");
   await run('window.hold=true');await type('**Before ACK**');await send();await until("window.sendRequests.length===1&&!!document.querySelector('.chat-message-pending')",'optimistic message before acknowledgment');
   const flights=motion==='reduce'?0:1;assert.equal(await run('window.sendFlights.length'),flights,'flight starts before server acknowledgment');if(flights)assert.equal(await run('window.sendFlights[0].pending'),true,'gray message flies from input immediately');
   const pendingColor=await run("getComputedStyle(document.querySelector('.chat-message-pending .member-message-text strong')).color");assert.equal(await run("!!document.querySelector('[data-read-id=\"-1\"]')"),false,'pending message is not a read cursor');
   if(lang==='ru'&&motion==='no-preference'){await fs.mkdir('release/qa',{recursive:true});await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await wait(150);await fs.writeFile('release/qa/chat-message-pending.png',(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());}
   await run('window.confirmPending()');await until("!!document.querySelector('[data-message-row=\"181\"]')&&!document.querySelector('.chat-message-pending')",'WS confirms before HTTP');
   assert.notEqual(await run("getComputedStyle(document.querySelector('[data-message-row=\"181\"] .member-message-text strong')).color"),pendingColor,'server acknowledgment restores normal color');
   await run('window.failNext=true;window.hold=false;window.release()');await until("!document.querySelector('.member-composer textarea').readOnly&&document.querySelector('.member-composer textarea').value===''",'WS acknowledgment survives lost HTTP response');
   assert.equal(await run("document.querySelectorAll('[data-message-row=\"181\"]').length"),1,'WS and HTTP do not duplicate messages');assert.equal(await run("!!document.querySelector('.member-chat > .text-error[role=alert]')"),false);
   assert.equal(await run('window.sendFlights.length'),flights,'WS/HTTP acknowledgment does not repeat the flight');
   await run('window.hold=true');await type('Retry safely');await send();await until("window.sendRequests.length===2&&!!document.querySelector('.chat-message-pending')",'second message pending');
   await run('window.failNext=true;window.hold=false;window.release()');await until("!document.querySelector('.member-composer textarea').readOnly&&!document.querySelector('.chat-message-pending')",'failure removes optimistic placeholder');assert.equal(await run("document.querySelector('.member-composer textarea').value"),'Retry safely');assert.equal(await run("!!document.querySelector('.member-chat > .text-error[role=alert]')"),true,'failed send reports an error');
   await run('window.hold=true');await send();await until("window.sendRequests.length===3&&!!document.querySelector('.chat-message-pending')",'retry is pending');assert.equal(await run('window.sendRequests[1].requestId===window.sendRequests[2].requestId'),true,'retry keeps idempotency key');
   await run('window.hold=false;window.release()');await until("!!document.querySelector('[data-message-row=\"182\"]')&&!document.querySelector('.member-composer textarea').readOnly",'HTTP acknowledgment confirms retry');assert.equal(await run("document.querySelectorAll('[data-message-row=\"182\"]').length"),1);
   assert.equal(await run('window.sendFlights.length'),flights*3,'failure and retry each animate once, never on acknowledgment');
   await run('window.holdUpload=true;window.hold=true;window.attachImage()');await until("!!document.querySelector('.chat-attachment-draft img')",'image attached');await send();
   await until("!!document.querySelector('.chat-message-pending img')",'gray local image appears during upload');assert.equal(await run('window.sendRequests.length'),3,'image is pending before message request');
   await until("document.querySelector('.chat-message-pending img')?.naturalHeight === 300",'pending photo has decoded');
   const photoHeight=await run("document.querySelector('.chat-pending-image').getBoundingClientRect().height");
   assert.equal(await run("getComputedStyle(document.querySelector('.chat-message-pending img')).filter"),'grayscale(1)');await run('window.holdUpload=false;window.releaseUpload()');await until('window.sendRequests.length===4','upload finished, send pending');
   await run('window.confirmPending()');await until("!!document.querySelector('[data-message-row=\"183\"]')&&!document.querySelector('.chat-message-pending')",'WS confirms attachment');await run('window.hold=false;window.release()');
   await until("!document.querySelector('.member-composer textarea').readOnly&&!document.querySelector('.chat-attachment-draft')",'attachment confirmed and draft cleared');assert.equal(await run("document.querySelectorAll('[data-message-row=\"183\"]').length"),1);
   await until("document.querySelector('[data-message-row=\"183\"] .chat-image img')?.naturalHeight === 300",'confirmed photo has decoded');
   const confirmed=await run(`(() => {
     const list=document.querySelector('.chat-stream'), photo=list.querySelector('[data-message-row="183"] .chat-image');
     return {height:photo.getBoundingClientRect().height,bottom:list.scrollHeight-list.scrollTop-list.clientHeight};
   })()`);
   assert.ok(Math.abs(confirmed.height-photoHeight)<1 && confirmed.bottom<2,'confirmation preserves photo height and keeps the chat at the bottom');
   assert.equal(await run('window.sendFlights.length'),flights*4,'attachment upload/confirmation does not repeat the flight');
   console.log('PASS pending messages '+lang+'/'+motion+': immediate single flight, gray text/image, upload, HTTP/WS acknowledgment, lost response, deduplication, failure and idempotent retry');
  }
  win.destroy();app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1);}
});
