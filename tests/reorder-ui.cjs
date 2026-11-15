const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.setPath('userData',require('node:path').join(require('node:os').tmpdir(),'pawtalk-reorder-'+process.pid));
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1240,height:820,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const run=code=>win.webContents.executeJavaScript(code,true),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async(code,label)=>{for(let i=0;i<140;i++){if(await run(code))return;await wait(50);}throw Error(label);};
 const order=selector=>run(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}+' > [data-reorder-id]'),e=>e.dataset.reorderId)`);
 // Exercise native DragEvent/DataTransfer in the real renderer; intercept only
 // setDragImage to inspect the separate surface before Chromium snapshots it.
 const start=(selector,index)=>run(`(()=>{const list=document.querySelector(${JSON.stringify(selector)}),item=list.querySelectorAll(':scope > [data-reorder-id]')[${index}],button=item.matches('button')?item:item.querySelector('button'),r=button.getBoundingClientRect();window.dragTransfer=new DataTransfer();window.dragImageInfo=null;window.dragTransfer.setDragImage=(surface)=>{const copy=surface.firstElementChild,s=getComputedStyle(surface),c=getComputedStyle(copy);window.dragImageInfo={background:s.backgroundColor,padding:s.padding,left:s.left,children:surface.children.length,status:copy.querySelectorAll('.member-status').length,badges:copy.querySelectorAll('.member-unread-badge,.member-channel-count').length,radius:c.borderRadius,shadow:c.boxShadow};};button.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:window.dragTransfer,clientX:r.left+10,clientY:r.top+10}));})()`);
 const over=(selector,index,type='dragover')=>run(`(()=>{const list=document.querySelector(${JSON.stringify(selector)}),items=list.querySelectorAll(':scope > [data-reorder-id]'),item=items[${index}],r=item.getBoundingClientRect(),transform=new DOMMatrix(getComputedStyle(item).transform);list.dispatchEvent(new DragEvent(${JSON.stringify(type)},{bubbles:true,cancelable:true,dataTransfer:window.dragTransfer,clientX:r.left+10,clientY:r.top+r.height/2-transform.m42}));})()`);
 const end=selector=>run(`document.querySelector(${JSON.stringify(selector)}+' [data-reorder-source]')?.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:window.dragTransfer}))`);
 try{
 await win.loadURL('about:blank');win.webContents.debugger.attach('1.3');
 for(const language of ['ru','en'])for(const reduced of ['reduce','no-preference']){
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced}]});
  await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/notifications.html?language='+language);
  await until("window.ready&&!!document.querySelector('.member-server-list button')",'fixture ready');
  await run('window.setupReorder()');await until("document.querySelectorAll('.member-server-list button').length===3",'three servers');
  const rail='.member-server-list';const saved=await order(rail);
  await start(rail,0);await until("!!document.querySelector('.member-server-list [data-reorder-source]')",'source placeholder');
  assert.deepEqual(await run('window.dragImageInfo'),{background:'rgba(0, 0, 0, 0)',padding:'6px',left:'-10000px',children:1,status:1,badges:0,radius:await run("getComputedStyle(document.querySelector('.member-server-list button')).borderRadius"),shadow:'none'});
  await over(rail,2);await wait(190);
  assert.ok(await run("[...document.querySelectorAll('.member-server-list > [data-reorder-id]')].every(e=>new DOMMatrix(getComputedStyle(e).transform).m42!==0)"),'siblings move before drop: '+JSON.stringify(await run("[...document.querySelectorAll('.member-server-list > [data-reorder-id]')].map(e=>({id:e.dataset.reorderId,style:e.getAttribute('style'),transform:getComputedStyle(e).transform,top:e.getBoundingClientRect().top}))")));
  assert.deepEqual(await order(rail),saved,'DOM order stays stable while previewing');
  await end(rail);await wait(220);assert.deepEqual(await order(rail),saved,'cancel keeps original order');
  await start(rail,0);await over(rail,2);await wait(190);await over(rail,2,'drop');
  const expected=[saved[1],saved[2],saved[0]];
  await until(`JSON.stringify([...document.querySelectorAll('.member-server-list > [data-reorder-id]')].map(e=>e.dataset.reorderId))===${JSON.stringify(JSON.stringify(expected))}`,'server drop commits');
  assert.deepEqual(await run("JSON.parse(localStorage.getItem('pawtalk.v2.server-order'))"),expected);
  await run('window.refresh()');await wait(250);assert.deepEqual(await order(rail),expected,'poll retains saved order');
  await wait(220);await run(`document.querySelector('[data-reorder-id="${saved[0]}"]').click()`);
  await until("document.querySelectorAll('.member-channel-group').length===2",'server channels');
  // A populated voice slot has a different height from an empty slot.
  await run("document.querySelector('.member-channel-group [data-reorder-id] .member-channel-people').style.height='55px'");
  for(const group of [1,2]){
   const selector='.member-channel-group:nth-child('+group+')',before=await order(selector),calls=await run('window.reorders.length');
   await start(selector,0);await until(`!!document.querySelector(${JSON.stringify(selector)}+' [data-reorder-source]')`,'channel placeholder');
   assert.equal((await run('window.dragImageInfo')).background,'rgba(0, 0, 0, 0)');
   await over(selector,before.length-1);await wait(190);
   assert.ok(await run(`new DOMMatrix(getComputedStyle(document.querySelectorAll(${JSON.stringify(selector)}+' > [data-reorder-id]')[1]).transform).m42<0`),'channel sibling shifts upward');
   const other='.member-channel-group:nth-child('+(group===1?2:1)+')';await over(other,0,'drop');
   assert.equal(await run('window.reorders.length'),calls,'other kind cannot accept drop');
   await over(selector,before.length-1,'drop');
   await until('window.reorders.length==='+String(calls+1),'one channel mutation on drop');
   assert.deepEqual(await run('window.reorders.at(-1).items.map(item=>item.id)'),[...before.slice(1),before[0]]);
   await until(`document.querySelector(${JSON.stringify(selector)}+' > [data-reorder-id]').dataset.reorderId===${JSON.stringify(before[1])}`,'channel order synchronized');
  }
 }
 console.log('Reorder UI passed: RU/EN, motion/reduced, transparent images, live slots, cancel, local persistence, channel kinds and single commit. Synthetic drag events in Electron.');app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1);}
});
