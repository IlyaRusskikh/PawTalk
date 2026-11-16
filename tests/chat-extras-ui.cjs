const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
 const run=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){throw Error(code+'\n'+error.message);}},wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async(code,label)=>{for(let i=0;i<160;i++){if(await run(code))return;await wait(50);}throw Error(label+': '+await run('document.body.innerText.slice(-1800)'));};
 const set=(selector,value)=>run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const timer=setTimeout(()=>app.exit(1),90000);
 try{
 for(const language of ['ru','en']){
 await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/server-chat.html?features=1&lang='+language);
 await until("document.querySelectorAll('[data-message-row]').length===25",'loaded history');
 await set('.member-composer textarea','Hello @Fr');
 await run("(()=>{const e=document.querySelector('.member-composer textarea');e.focus();e.setSelectionRange(e.value.length,e.value.length);e.dispatchEvent(new Event('select',{bubbles:true}));})()");
 await until("!!document.querySelector('.mention-options button')",'mention suggestions');
 await run("document.querySelector('.member-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
 assert.equal(await run('window.sendRequests.length'),0,'selecting a mention must not send');
 await run("document.querySelector('.member-composer').requestSubmit()");
 await until("document.querySelector('[data-message-row=\"181\"] .chat-mention')?.textContent==='@Friend'",'mention rendered');
 assert.equal(await run('window.sendRequests[0].content.mentions[0].profileId'),'b'.repeat(64));
 await until("document.querySelector('.chat-attach')?.disabled===false",'send finished');
 await run("document.querySelector('.chat-attach').click()");
 await until("!!document.querySelector('.chat-attachment-menu button')",'attachment menu');
 await run("document.querySelector('.chat-attachment-menu button:last-child').click()");
 await until("!!document.querySelector('.poll-dialog[open]')",'poll modal');
 await set('.poll-dialog .form-fields>label input','Choose a name');
 await set('.poll-option-field:nth-of-type(1) input','PawTalk');await set('.poll-option-field:nth-of-type(2) input','KitCast');
 const geometry=await run("(()=>{const d=document.querySelector('.poll-dialog'),r=d.getBoundingClientRect(),buttons=[...d.querySelectorAll('.modal-actions button')].map(e=>{const b=e.getBoundingClientRect();return b.top+b.height/2;});return {overflow:d.scrollWidth>d.clientWidth,top:r.top,bottom:r.bottom,buttons,options:[...d.querySelectorAll('select option')].map(e=>e.value)}})()");
 assert.equal(geometry.overflow,false);assert.ok(geometry.top>=0&&geometry.bottom<=900);assert.ok(Math.abs(geometry.buttons[0]-geometry.buttons[1])<1);assert.deepEqual(geometry.options,['3600','14400','28800','86400','259200','604800','1209600']);
 await fs.writeFile(path.join(os.tmpdir(),'pawtalk-poll-'+language+'.png'),(await win.webContents.capturePage()).toPNG());
 await run("document.querySelector('.poll-settings label:last-child input').click()");
 await run("document.querySelector('.poll-dialog form').requestSubmit()");
 await until("document.querySelectorAll('.poll-answer').length===2&&!document.querySelector('.poll-dialog')",'poll published');
 assert.equal(await run("!!document.querySelector('.poll-count')"),false,'hidden interim counts');
 await run("document.querySelector('.poll-answer').click()");await until("document.querySelector('.poll-answer')?.getAttribute('aria-pressed')==='true'",'vote selected');
 await run("document.querySelector('.poll-answer').click()");await until("document.querySelector('.poll-answer')?.getAttribute('aria-pressed')==='false'",'vote withdrawn');
 await run("document.querySelectorAll('.poll-answer')[1].click()");await until("document.querySelectorAll('.poll-answer')[1]?.getAttribute('aria-pressed')==='true'",'vote changed');
 await run("document.querySelector('.poll-close').click()");await until("!!document.querySelector('.poll-result')&&!!document.querySelector('.poll-count')",'finished result reply');
 await until("document.querySelector('.poll-result')?.textContent.includes('KitCast')",'winner loaded');assert.equal(await run("!!document.querySelector('.poll-voters')"),false,'anonymous identities hidden');
 await fs.writeFile(path.join(os.tmpdir(),'pawtalk-poll-result-'+language+'.png'),(await win.webContents.capturePage()).toPNG());
 console.log('PASS chat extras '+language+': mention selection/identity, poll form geometry, durations, hidden results, voting, withdrawal, early close and reply');
 }
 assert.deepEqual(errors,[]);clearTimeout(timer);win.destroy();app.exit(0);
 }catch(error){console.error(error);clearTimeout(timer);app.exit(1);}
});
