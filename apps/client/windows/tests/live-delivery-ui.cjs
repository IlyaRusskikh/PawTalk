const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
app.disableHardwareAcceleration();app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}});const run=code=>win.webContents.executeJavaScript(code,true),wait=ms=>new Promise(r=>setTimeout(r,ms));const until=async(code,label)=>{for(let i=0;i<140;i++){if(await run(code))return;await wait(40)}throw Error(label+': '+await run("JSON.stringify({text:document.querySelector('.member-reply')?.textContent,reads:window.liveReads,live:window.lastLive})"))};try{
 await win.loadURL('about:blank');
 win.webContents.debugger.attach('1.3');
 await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 for(const language of ['ru','en']){await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/server-chat.html?features=1&lang='+language);await until("document.querySelectorAll('[data-message-row]').length===25",'initial history');await wait(150);await run('window.liveReads=[]');
 await run("window.pushLive('edit',20)");await until("document.querySelector('.member-reply')?.title.includes('Live edited 20')",'live quote updated outside visible window');assert.equal(await run('window.liveReads.length'),0);
 await run("(()=>{const p=document.querySelector('.member-history');p.scrollTop=0;p.dispatchEvent(new Event('scroll'));})()");await wait(150);await until("!document.querySelector('.chat-page-loader:disabled')",'manual older paging settled');await run('window.liveReads=[]');const top=await run("document.querySelector('.member-history').scrollTop");const id=await run("window.pushLive('new')");await wait(120);assert.equal(await run("document.querySelector('.member-history').scrollTop"),top,'arrival preserves older viewport');assert.equal(await run('window.liveReads.length'),0);await run("document.querySelector('.chat-jump').click()");await until("!!document.querySelector('[data-message-row=\""+id+"\"]')",'jump uses HTTP history');await wait(100);await run('window.liveReads=[]');
 await run("window.pushLive('new',undefined,true)");await wait(100);assert.equal(await run("document.querySelectorAll('[data-message-row=\""+id+"\"]').length"),1,'duplicate delivery is not appended');assert.equal(await run('window.liveReads.length'),0);
 await run("window.pushLive('edit',"+id+")");await until("document.querySelector('[data-message-row=\""+id+"\"]')?.textContent.includes('Live edited')",'visible edit');assert.equal(await run('window.liveReads.length'),0);
 await run("window.pushLive('delete',"+id+")");await until("!document.querySelector('[data-message-row=\""+id+"\"]')",'live deletion');assert.equal(await run('window.liveReads.length'),0);
 const reordered=await run("window.pushLive('reorder')");await until("!!document.querySelector('[data-message-row=\""+reordered+"\"]')&&!!document.querySelector('[data-message-row=\""+(reordered-1)+"\"]')",'out-of-order revisions become ordered without HTTP');assert.equal(await run('window.liveReads.length'),0);
 const quoted=await run("window.pushLive('reply',30)");await until("document.querySelector('[data-message-row=\""+quoted+"\"] .member-reply')?.title.includes('Synthetic message 30')",'new reply resolves uncached history');assert.deepEqual(await run('window.liveReads.map(o=>o.ids)'),[[30]],'only uncached quoted history is read');await run('window.liveReads=[]');
 const cachedReply=await run("window.pushLive('reply',"+reordered+")");await until("!!document.querySelector('[data-message-row=\""+cachedReply+"\"] .member-reply')",'new reply resolves visible message');assert.equal(await run('window.liveReads.length'),0);
 const stateFirst=await run("window.pushLive('state-first')");await until("!!document.querySelector('[data-message-row=\""+stateFirst+"\"]')",'envelope arrives after state');assert.equal(await run('window.liveReads.length'),0,'newer state waits for the live envelope');
 const gap=await run("window.pushLive('gap')");await until("!!document.querySelector('[data-message-row=\""+gap+"\"]')",'missing revision recovers through HTTP');assert.ok(await run('window.liveReads.length>0'));
 await until("(()=>{const list=document.querySelector('.chat-stream');return list.scrollHeight-list.clientHeight-list.scrollTop<2})()", 'Chat is at the bottom before another arrival');
 const motion = await run(`new Promise(resolve => {
   const list=document.querySelector('.chat-stream'), start=list.scrollTop, id=window.pushLive('new');
   let faded=false, movedGradually=false, count=0;
   function observe(){
     const row=list.querySelector('[data-message-row="'+id+'"]');
     const end=list.scrollHeight-list.clientHeight;
     if(row && Number(getComputedStyle(row).opacity)<0.99) faded=true;
     if(list.scrollTop>start+1 && list.scrollTop<end-1) movedGradually=true;
     if(++count<45 && (!faded || !movedGradually || end-list.scrollTop>=2)) requestAnimationFrame(observe);
     else resolve({faded,movedGradually,atBottom:end-list.scrollTop<2});
   }
   requestAnimationFrame(observe);
 })`);
 assert.deepEqual(motion,{faded:true,movedGradually:true,atBottom:true},'incoming message fades in while the viewport moves to the bottom');
 const anchored = await run(`(async()=>{
   const list=document.querySelector('.chat-stream'), rows=[...list.querySelectorAll('[data-message-row]')];
   const anchor=rows[8], earlier=rows[3], frame=()=>new Promise(requestAnimationFrame);
   list.scrollTop+=anchor.getBoundingClientRect().top-list.getBoundingClientRect().top-5;
   list.dispatchEvent(new Event('scroll'));
   await frame();await frame();
   const offset=anchor.getBoundingClientRect().top-list.getBoundingClientRect().top;
   const preview=document.createElement('div');preview.style.height='160px';earlier.append(preview);
   for(let i=0;i<4;i++)await frame();
   return Math.abs(anchor.getBoundingClientRect().top-list.getBoundingClientRect().top-offset);
 })()`);
 assert.ok(anchored<2,'an attachment expanding above the viewport preserves the reading anchor');
 const visibleGrowth=await run(`(async()=>{
   const list=document.querySelector('.chat-stream'), viewport=list.getBoundingClientRect();
   const rows=[...list.querySelectorAll('[data-message-row]')];
   const top=rows[8], middle=(viewport.top+viewport.bottom)/2;
   const distance=row=>{const rect=row.getBoundingClientRect();return Math.max(0,rect.top-middle,middle-rect.bottom);};
   const center=rows.sort((a,b)=>distance(a)-distance(b))[0];
   if(!center||center===top)throw Error('Expected a different message at the center of the viewport');
   const before=center.getBoundingClientRect().top;
   const initialScroll=list.scrollTop;
   const details=document.createElement('div');details.style.height='64px';top.append(details);
   list.scrollTop-=24;
   const motion=list.scrollTop-initialScroll;
   list.dispatchEvent(new Event('scroll'));
   for(let i=0;i<4;i++)await new Promise(requestAnimationFrame);
   return {motion, visualDelta:center.getBoundingClientRect().top-before};
 })()`);
 assert.ok(visibleGrowth.motion<0&&Math.abs(visibleGrowth.visualDelta+visibleGrowth.motion)<2,
   `a visible card expanding during scroll preserves the user scroll delta (${JSON.stringify(visibleGrowth)})`);
 const afterClamp=await run(`(async()=>{
   const list=document.querySelector('.chat-stream'), content=list.querySelector('.chat-history-edge').parentElement;
   const frame=()=>new Promise(requestAnimationFrame);
   const placeholder=document.createElement('div');placeholder.style.height='240px';
   content.append(placeholder);
   await frame();await frame();
   list.scrollTop=list.scrollHeight-list.clientHeight-60;
   list.dispatchEvent(new Event('scroll'));
   await frame();await frame();
   placeholder.remove();
   await frame();await frame();
   content.append(placeholder);
   await frame();await frame();
   return list.scrollHeight-list.clientHeight-list.scrollTop;
 })()`);
 assert.ok(afterClamp>30,`a temporary collapse at the bottom does not turn following back on (bottom gap ${afterClamp}px)`);
 console.log('PASS live payload UI '+language+': quote edit, scroll anchor, duplicate, reordered revisions, edit/delete without HTTP, HTTP gap recovery');}
 win.destroy();app.exit(0);
}catch(error){console.error(error.stack);app.exit(1)}});
