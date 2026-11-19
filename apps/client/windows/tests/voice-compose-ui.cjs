const {app,BrowserWindow,session}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.whenReady().then(async()=>{
 session.defaultSession.setPermissionRequestHandler((_contents,permission,callback)=>callback(permission==='media'));
 const win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const run=code=>win.webContents.executeJavaScript(code,true),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async(code)=>{for(let i=0;i<200;i++){if(await run(code))return;await wait(50);}throw Error(code+': '+await run('document.body.innerText.slice(-1500)'));};
 const timer=setTimeout(()=>app.exit(1),60000);
 try{
 for(const lang of ['ru','en']){
 await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/server-chat.html?compose=1&lang='+lang);
 await until("document.querySelectorAll('[data-message-row]').length===25");
 await run("(()=>{window.testGains=[];const create=AudioContext.prototype.createGain;AudioContext.prototype.createGain=function(){const gain=create.call(this);window.testGains.push(gain);return gain;};})()");
 await run("document.querySelector('.chat-attach').click()");
 await until("!!document.querySelector('.chat-attachment-menu button')");
 await run("document.querySelectorAll('.chat-attachment-menu button')[1].click()");
 await until("document.querySelector('.voice-stop')?.disabled===false");
 assert.equal(await run("!!document.querySelector('dialog[open]')"),false,'recording stays inline');
 await wait(1200);
 assert.ok(await run("[...document.querySelectorAll('.voice-composer .voice-wave rect')].some(e=>Number(e.getAttribute('height'))>2)"),'real synthetic microphone drives bars');
 await fs.writeFile(path.join(os.tmpdir(),'pawtalk-voice-recording-'+lang+'.png'),(await win.capturePage()).toPNG());
 await run("window.recordedWave=document.querySelector('.voice-composer .voice-wave svg');document.querySelector('.voice-stop').click()");
 await until("!!document.querySelector('.voice-composer .voice-play')");
 assert.equal(await run("window.recordedWave===document.querySelector('.voice-composer .voice-wave svg')"),true,'record and preview retain the same wave element');
 assert.equal(await run("document.querySelector('.voice-composer .voice-wave g rect').getAttribute('width')"),'2.5');
 await run("document.querySelector('.voice-composer .voice-play').click()");
 await until("document.querySelector('.voice-composer audio')?.paused===false");
 await run("document.querySelector('.voice-composer .voice-play').click()");
 await until("document.querySelector('.voice-composer audio')?.paused===true");
 await run("document.querySelector('.voice-send').click()");
 await until("!!document.querySelector('.chat-voice .voice-player')&&document.querySelector('.chat-voice .voice-play').disabled===false");
 assert.ok(await run("window.sendRequests.at(-1).content.file.voice.duration>1"));
 assert.equal(await run("document.querySelector('.chat-voice .voice-wave g rect').getAttribute('width')"),'2.5','sent message keeps wave geometry');
 await run("document.querySelector('.chat-voice .voice-play').click()");
 await until("document.querySelector('.chat-voice audio')?.paused===false");
 for(const rate of [1.5,2,.75,1]){await run("document.querySelector('.chat-voice .voice-speed').click()");assert.equal(await run("document.querySelector('.chat-voice audio').playbackRate"),rate);}
 await run("document.querySelector('.chat-voice .voice-volume').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
 await until("!!document.querySelector('.voice-volume-popover input')");
 await run("(()=>{const input=document.querySelector('.voice-volume-popover input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'0.3');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
 assert.ok(Math.abs(await run("window.testGains.at(-1).gain.value")-.3)<.0001);
 await run("(()=>{const input=document.querySelector('.voice-volume-popover input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'2');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
 assert.equal(await run("window.testGains.at(-1).gain.value"),2);
 assert.equal(await run("getComputedStyle(document.querySelector('.voice-volume-popover input')).writingMode"),'vertical-lr');
 await fs.writeFile(path.join(os.tmpdir(),'pawtalk-voice-player-'+lang+'.png'),(await win.capturePage()).toPNG());
 console.log('PASS voice '+lang+': actual MediaRecorder + synthetic microphone, live amplitude, inline stop/preview/send, speed cycle and listener volume');
 }
 clearTimeout(timer);app.exit(0);
 }catch(e){console.error(e);clearTimeout(timer);app.exit(1);}
});
