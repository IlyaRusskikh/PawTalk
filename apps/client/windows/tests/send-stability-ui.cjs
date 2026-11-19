const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict');
app.disableHardwareAcceleration();app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}}),run=code=>win.webContents.executeJavaScript(code,true),wait=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(code,label)=>{for(let i=0;i<140;i++){if(await run(code))return;await wait(40);}throw Error(label);};
 try{
  await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/server-chat.html?features=1');await until("!!document.querySelector('[data-message-row=\"180\"]')",'history ready');await wait(150);
  await run("window.hold=true;window.liveReads=[];window.previousRow=document.querySelector('[data-message-row=\"176\"]');const input=document.querySelector('.member-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Steady outgoing');input.dispatchEvent(new Event('input',{bubbles:true}));true;");
  await run("document.querySelector('.member-composer').requestSubmit()");await until("window.sendRequests.length===1&&!!document.querySelector('.chat-message-pending')",'message pending');
  const frames=await run("new Promise(resolve=>{const values=[];function frame(){const list=document.querySelector('.member-history');values.push({top:window.previousRow.getBoundingClientRect().top,height:list.scrollHeight,scroll:list.scrollTop});if(values.length<20)requestAnimationFrame(frame);else resolve(values);}requestAnimationFrame(frame);})");
  assert.ok(Math.max(...frames.map(f=>f.top))-Math.min(...frames.map(f=>f.top))<1,'older messages stay still during the send animation');
  assert.ok(Math.max(...frames.map(f=>f.height))-Math.min(...frames.map(f=>f.height))<1,'send animation does not change scrollable height');
  const before=frames.at(-1).top;await run('window.confirmPending()');await until("!!document.querySelector('[data-message-row=\"181\"]')",'WS acknowledgment');await run('window.hold=false;window.release()');await until("!document.querySelector('.member-composer textarea').readOnly",'send finished');await wait(100);
  const after=await run('window.previousRow.getBoundingClientRect().top');
  assert.equal(await run("window.previousRow===document.querySelector('[data-message-row=\"176\"]')"),true,'existing row DOM is retained');assert.ok(Math.abs(after-before)<1,'acknowledgment does not move older messages');assert.equal(await run('window.liveReads.length'),0,'confirmed live send does not reload history');
  console.log('PASS send stability: fixed older rows, stable scroll height, retained DOM and no history reload');win.destroy();app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1);}
});
