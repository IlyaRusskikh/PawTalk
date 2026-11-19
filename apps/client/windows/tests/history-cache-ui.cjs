const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict');
app.disableHardwareAcceleration();app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}}),run=code=>win.webContents.executeJavaScript(code,true),wait=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(code,label,attempts=160)=>{for(let i=0;i<attempts;i++){if(await run(code))return;await wait(40);}throw Error(label+': '+await run("JSON.stringify({rows:document.querySelectorAll('[data-message-row]').length,reads:window.liveReads,top:document.querySelector('.member-history')?.scrollTop})"));};
 const atLatest="(()=>{const pane=document.querySelector('.member-history');return pane.scrollHeight-pane.clientHeight-pane.scrollTop<2&&!document.querySelector('.chat-jump');})()";
 const open=async(lang='ru')=>{await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/server-chat.html?features=1&lang='+lang);await until("document.querySelectorAll('[data-message-row]').length===25",'initial batch');await wait(150);};
 const older=async(count)=>{await run("(()=>{const p=document.querySelector('.member-history');p.scrollTop=0;p.dispatchEvent(new Event('scroll'));})()");await until('document.querySelectorAll("[data-message-row]").length==='+count,'automatic older page');await until("document.querySelector('.member-history').getAttribute('aria-busy')==='false'",'page settled');};
 try{
  for(const lang of ['ru','en']){
   await open(lang);assert.equal(await run("!!document.querySelector('.chat-page-loader')"),false,'history has no pagination buttons');await run("window.retainedTail=document.querySelector('[data-message-row=\"180\"]');window.liveReads=[]");
   await older(50);assert.equal(await run("window.retainedTail===document.querySelector('[data-message-row=\"180\"]')"),true,'loading above retains rows below');assert.ok(await run('window.liveReads.some(o=>o.before===156&&o.limit===25)'),'page uses configured batch size');
   await older(75);await run('window.liveReads=[];window.setBatch(50)');await wait(80);assert.equal(await run('window.liveReads.length'),0,'changing page size does not reload or discard history');await older(125);assert.ok(await run('window.liveReads.some(o=>o.before===106&&o.limit===50)'));
   await run("window.liveReads=[];document.querySelector('.chat-jump').click()");await until(atLatest,'return to loaded latest');assert.equal(await run('window.liveReads.length'),0,'returning down uses cached messages');assert.equal(await run("window.retainedTail===document.querySelector('[data-message-row=\"180\"]')"),true);
   await run('window.setBatch(25)');await older(150);await older(175);assert.equal(await run("!!document.querySelector('[data-message-row=\"180\"]')"),true,'many older pages do not unload newest messages');
   if(lang==='ru'){
    await run("document.querySelector('.chat-jump').click();window.lowMemory=true");await until('document.querySelectorAll("[data-message-row]").length===100','memory-pressure pruning',500);assert.equal(await run("window.retainedTail===document.querySelector('[data-message-row=\"180\"]')"),true,'pressure keeps visible messages');await run('window.lowMemory=false');
   }
   await run("window.select('other')");await until("!!document.querySelector('.member-chat-welcome')",'leave chat');await run("window.select('general')");await until("document.querySelectorAll('[data-message-row]').length===25",'reentry starts with a fresh batch');assert.equal(await run("window.retainedTail===document.querySelector('[data-message-row=\"180\"]')"),false,'old chat cache was released');
   await open(lang);await run("document.querySelector('.member-reply').click()");await until("!!document.querySelector('[data-message-row=\"20\"]')",'uncached reply jump');await until("document.querySelector('.member-history').getAttribute('aria-busy')==='false'",'reply history ready');
   await run("window.liveReads=[];window.holdOlderPage=true;const pane=document.querySelector('.member-history');pane.scrollTop=0;pane.dispatchEvent(new Event('scroll'))");
   await until("typeof window.releaseOlderPage==='function'&&!!document.querySelector('.chat-jump')",'older page in flight in a disjoint history block');
   await run("document.querySelector('.chat-jump').click();window.releaseOlderPage()");
   await until("!!document.querySelector('[data-message-row=\"180\"]')&&"+atLatest,'latest block restored during older paging');
   assert.equal(await run("window.liveReads.filter(o=>!o.before).length"),0,'the explicit jump uses the cached latest block');
   console.log('PASS history cache '+lang+': automatic paging, batch settings, retained rows, cached return/reply jumps, exit cleanup'+(lang==='ru'?', synthetic memory pressure':''));
  }
  await open();await run('window.setBatch(500);window.extendHistory(1200)');await until("document.querySelectorAll('[data-message-row]').length===500",'500-message latest batch');await older(1000);await run("window.liveReads=[];window.update(300,'Updated retained history')");await until("document.querySelector('[data-message-row=\"300\"]')?.textContent.includes('Updated retained history')",'large cache refresh applies edits');assert.ok(await run('window.liveReads.filter(o=>o.ids).length>=3'),'cache recovery refreshes multiple bounded selections');assert.ok(await run('window.liveReads.filter(o=>o.ids).every(o=>o.ids.length<=500)'));assert.equal(await run("document.querySelectorAll('[data-message-row]').length"),1000,'recovery retains a cache larger than the request limit');
  console.log('PASS large history recovery: 1000 retained messages, edits and HTTP selections bounded to 500 IDs');
  win.destroy();app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1);}
});
