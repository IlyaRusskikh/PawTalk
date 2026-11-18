// Actual Client main/preload/renderer, core, protected storage and host lifecycle.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {t}=require('../../../../shared/i18n.cjs');
const language=process.env.PAWTALK_TEST_LANGUAGE==='en'?'en':'ru',reduced=process.env.PAWTALK_TEST_REDUCED==='1';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pawtalk-selfhost-ui-'));
app.setPath('userData',directory);fs.writeFileSync(path.join(directory,'language.json'),JSON.stringify({language}));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.commandLine.appendSwitch('use-fake-ui-for-media-stream');app.disableHardwareAcceleration();
process.argv.push('--smoke','--offscreen-smoke');
let handled=false;
app.on('browser-window-created',(_event,window)=>{
 if(handled)return;handled=true;
 window.webContents.once('did-finish-load',()=>void test(window).then(()=>app.exit(0)).catch(error=>{console.error(error.stack);app.exit(1);}));
});
require('../electron/main.cjs');
async function test(window){
 const run=code=>window.webContents.executeJavaScript(code,true),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async(code,label)=>{for(let i=0;i<600;i++){if(await run(code))return;await wait(100);}throw Error(label+': '+await run('document.body.innerText.slice(-1500)'));};
 const occupied=net.createServer();let port,host;
 try{
  await until("!!document.querySelector('.member-welcome')",'home');
  await run("document.querySelector('.onboarding-actions .quiet')?.click()");
  await until("!document.querySelector('dialog')",'finish setup');
  window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]});
  assert.equal(await run('document.documentElement.lang'),language);
  await run(`[...document.querySelectorAll('.member-home-navigation button')].find(e=>e.textContent.includes(${JSON.stringify(t('Создать сервер'))})).click()`);
  assert.equal(await run("getComputedStyle(document.querySelector('dialog .form-fields')).gap"),'20px');
  assert.equal(await run("!!document.querySelector('dialog input[type=password],dialog .encryption-toggle')"),false);
  port=18443;await require('../electron/selfhost.cjs').checkPorts(port);
  assert.ok(port,'free room port group');
  await new Promise((resolve,reject)=>{occupied.once('error',reject);occupied.listen(port,'0.0.0.0',resolve);});
  await run(`(()=>{const inputs=document.querySelectorAll('dialog form input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [e,v] of [[inputs[0],'Synthetic host']]){set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await run("document.querySelector('dialog form').requestSubmit()");
  await until("!!document.querySelector('dialog [role=alert]')",'occupied port');
  assert.equal(await run("document.querySelector('dialog [role=alert]').textContent"),t('Порты комнаты заняты. Укажите другой порт.'));
  await new Promise(resolve=>occupied.close(resolve));
  await until("!document.querySelector('dialog form .primary').disabled",'failed start settles');
  await run("document.querySelector('dialog form').requestSubmit()");
  await until("window.desktop.hostStatus().then(s=>s.running)",'actual host starts');
  await until("!!document.querySelector('.member-channel')&&!document.querySelector('dialog')",'creator joins automatically');
  host=await run('window.desktop.hostStatus()');assert.equal(host.e2ee,true);assert.ok(host.serverId);assert.ok(!host.bootstrap&&!host.secret&&!host.password);
  const state=await run(`window.desktop.membership('connect',{serverId:${JSON.stringify(host.serverId)}})`);assert.equal(state.value.self.role,'admin');assert.equal(state.value.channels.length,2);
  assert.equal(await run("!!document.querySelector('.member-audio-buttons .person-network')"),false,'creating server does not enter voice');
  const link=await run(`window.desktop.membership('invite',{serverId:${JSON.stringify(host.serverId)},kind:'single'})`);assert.match(link.value,/#v=2&/);assert.ok(new URL(link.value).hash.includes('open='));
  await run("document.querySelector('.member-server-list button').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:45,clientY:120}))");
  await run(`[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent===${JSON.stringify(t('Выйти с сервера'))}).click()`);
  assert.equal(await run("document.querySelector('dialog h2').textContent"),t('Остановить сервер и выйти?'));
  assert.ok(await run("parseFloat(getComputedStyle(document.querySelector('dialog .modal-actions button')).borderTopLeftRadius)>0"));
  await run("document.querySelector('dialog .danger-button').click()");
  await until(`window.desktop.membership('servers').then(r=>!r.value.some(s=>s.serverId===${JSON.stringify(host.serverId)}))`,'stopped selfhost removed from creator registry');
  const stale=await run(`window.desktop.membership('connect',{serverId:${JSON.stringify(host.serverId)}})`);
  assert.equal(stale.error.code,'NOT_A_MEMBER','stale requests after own shutdown stay local');
  await until("!document.querySelector('dialog')",'host cleanup completes');
  assert.equal((await run('window.desktop.hostStatus()')).running,false);
  const invalid=await run('window.desktop.checkHost(1).then(()=>null,e=>e.message)');assert.equal(invalid,t('Укажите порт от 1024 до 65532.'));
  console.log(`PASS actual selfhost IPC/UI, occupied port, creator admin, mandatory E2EE, timed invite, chat-only and stop cleanup (${language}, reduced=${reduced})`);
 }finally{if(occupied.listening)await new Promise(resolve=>occupied.close(resolve));await run('window.desktop.stopHost()').catch(()=>{});}
}
