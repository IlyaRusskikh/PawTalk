// Launch the actual packaged binary in an isolated profile and inspect its renderer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const socket = net.createServer();
await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise(r => socket.close(r));
const profile = await mkdtemp(path.join(os.tmpdir(), 'voicecord-package-smoke-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VOICECORD_DEV_URL;
const child = spawn(path.resolve('release/win-unpacked/Voicecord.exe'), ['--smoke','--offscreen-smoke',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`], { env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
let exited = false, output = '';
child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
child.on('exit', () => { exited = true; });
let ws;
try {
 let page;
 for (let i=0;i<100;i++) {
  if (exited) throw Error('Packaged app exited before loading: '+output);
  try { const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); page=pages.find(p=>p.type==='page' && p.url.includes('index.html')); if(page)break; } catch {}
  await sleep(150);
 }
 assert.ok(page, 'Packaged renderer opens');
 ws=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 let next=0;const pending=new Map();
 ws.addEventListener('message', e=>{const v=JSON.parse(e.data);if(pending.has(v.id)){const {resolve,reject,timer}=pending.get(v.id);clearTimeout(timer);pending.delete(v.id);if(v.error)reject(Error(JSON.stringify(v.error)));else resolve(v.result);}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},8000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 for(let i=0;i<60;i++){if(await evaluate(`!!document.querySelector('.home-actions')`))break;await sleep(100);}
 assert.equal(await evaluate(`document.querySelector('h1').textContent`),'Разговор начинается здесь.');
 assert.equal(await evaluate(`document.querySelector('.rail img').naturalWidth > 0`),true,'packaged logo loads');
 const capabilities=await evaluate('window.desktop.capabilities()');assert.equal(capabilities.packaged,true);assert.equal(capabilities.native,true,'packaged native audio module loads');
 assert.equal(await evaluate(`typeof window.desktop.copyDiagnosticCommand`),'function');
 await evaluate(`document.querySelector('[title="Настройки"]').click()`);await sleep(250);
 assert.equal(await evaluate(`document.querySelector('dialog[open] h2').textContent`),'Настройки');
 const geometry=await evaluate(`(()=>{const d=document.querySelector('dialog');const b=d.getBoundingClientRect();return {width:b.width,height:b.height,windowHeight:innerHeight,overflow:getComputedStyle(d).overflow,scroll:!!d.querySelector('.modal-body')}})()`);
 assert.ok(geometry.scroll && geometry.overflow==='hidden' && geometry.height <= geometry.windowHeight,'modal shell clips scrolling body');
 const outDir=path.resolve('release/qa');await mkdir(outDir,{recursive:true});
 const image=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(outDir,'packaged-settings.png'),Buffer.from(image.data,'base64'));
 assert.equal(await evaluate('window.desktop.getLanguage()'), 'ru');
 assert.equal(await evaluate('typeof window.desktop.installUpdate'), 'function');
 assert.equal(await evaluate('typeof window.desktop.onUpdate'), 'function');
 await evaluate("window.desktop.setLanguage('en')");
 assert.equal(await evaluate('window.desktop.getLanguage()'), 'en');
 const languageFile=JSON.parse(await (await import('node:fs/promises')).readFile(path.join(profile,'language.json'),'utf8'));
 assert.equal(languageFile.language,'en','desktop persists language outside app directory');
 assert.match(await (await import('node:fs/promises')).readFile('release/win-unpacked/resources/updates/install-update.ps1','utf8'), /--updated --force-run/);
 await send('Page.reload');
 for(let i=0;i<60;i++){if(await evaluate("document.querySelector('h1')?.textContent === 'The conversation starts here.'"))break;await sleep(100);}
 assert.equal(await evaluate('document.documentElement.lang'),'en');
 assert.equal(await evaluate("document.querySelector('h1').textContent"),'The conversation starts here.');
 console.log('PASS packaged Voicecord: launch, preload, native module, logo, settings modal, language IPC/persistence, packaged update helper.');
 await send('Browser.close').catch(()=>{});
} finally {
 ws?.close();
 for(let i=0;i<20&&!exited;i++)await sleep(100);
 if(!exited){child.kill();await sleep(500);}
 await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:300}).catch(()=>{});
}
