// Native Electron clipboard/paste; connection responses are synthetic fixtures.
const { app, BrowserWindow, session, clipboard } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
app.setPath('userData', path.join(require('node:os').tmpdir(), 'pawtalk-manager-invitation-' + process.pid));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
 session.defaultSession.setPermissionRequestHandler((_w,_p,cb)=>cb(true));
 session.defaultSession.setPermissionCheckHandler(()=>true);
 const win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { preload: path.join(__dirname,'ui-flow-preload.cjs'), contextIsolation: true, sandbox: true, offscreen: true } });
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error('renderer:',event.message);});
 const run = code => win.webContents.executeJavaScript(code);
 const wait = () => new Promise(resolve=>setTimeout(resolve,180));
 let clipboardItems;
 try {
  await win.loadURL(pathToFileURL(path.resolve('dist/index.html')).href);
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript("!!document.querySelector('.onboarding-actions .quiet')")) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await win.webContents.executeJavaScript("document.querySelector('.onboarding-actions .quiet')?.click()"); await wait();
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const snapshot = require('../scripts/clipboard-snapshot.cjs').snapshotClipboard;
  clipboardItems = await run(`(async()=>{
   const items = await (${snapshot.toString()})(navigator.clipboard, ClipboardItem);
   return Promise.all(items.map(async item=>{
    const entries=[];
    for(const type of item.types) entries.push([type,Array.from(new Uint8Array(await (await item.getType(type)).arrayBuffer()))]);
    return entries;
   }));
  })()`);
  const address = 'pawtalk://192.0.2.10:18443/' + 'e'.repeat(64);
  for (const lang of ['ru','en']) for (const reduced of [false,true]) for (const embedded of [false,true]) {
   await run(`localStorage.setItem('pawtalk.language',${JSON.stringify(lang)})`);
   await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
   await win.reload(); await wait();
   const join = lang==='ru'?'Присоединиться к комнате':'Join a room';
   await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim().startsWith(${JSON.stringify(join)})).click()`); await wait();
   await clipboard.clear();
   await run(`document.querySelector('dialog input').focus()`); win.webContents.paste(); await wait();
   assert.equal(await run(`document.querySelector('dialog input').value`),'');
   assert.equal(await run(`document.querySelector('.join-submit').disabled`),true);
   await clipboard.writeText(embedded ? address+'#password=fixture-password' : address+'\\\r\nfixture-password');
   win.webContents.paste(); await wait();
   assert.equal(await run(`document.querySelector('dialog input').value`),embedded ? address+'#password=fixture-password' : address);
   assert.equal(await run(`document.querySelector('.join-submit').disabled`),false);
   await run(`document.querySelector('.join-submit').click()`); await wait();
   assert.equal(await run(`document.querySelector('dialog:last-of-type input[type=password]').value`),'fixture-password');
   assert.equal(await run(`document.querySelectorAll('dialog:last-of-type .form-fields label').length`),2);
   const gap=await run(`(()=>{const [a,b]=document.querySelectorAll('dialog:last-of-type .form-fields label');return b.getBoundingClientRect().top-a.getBoundingClientRect().bottom})()`);
   assert.ok(gap>=19.9, 'password/E2EE fields keep shared 20px spacing');
   assert.equal(await run(`document.querySelector('dialog:last-of-type .join-submit').disabled`),true,'E2EE secret still required');
   await run(`(()=>{const input=document.querySelectorAll('dialog:last-of-type input')[1];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'a'.repeat(64));input.dispatchEvent(new Event('input',{bubbles:true}));})()`); await wait();
   assert.equal(await run(`document.querySelector('dialog:last-of-type .join-submit').disabled`),false);
  }
  console.log('PASS Manager paste and password-bearing links: actual Electron clipboard, empty/populated, RU/EN, normal/reduced motion, password separation and E2EE dialog geometry (synthetic connection)');
 } catch(error) { console.error(error?.stack || String(error)); process.exitCode=1; }
 finally {
  if(clipboardItems?.length) await run(`navigator.clipboard.write(${JSON.stringify(clipboardItems)}.map(entries=>new ClipboardItem(Object.fromEntries(entries.map(([type,data])=>[type,new Blob([new Uint8Array(data)],{type})])))))`).catch(error=>{console.error('Clipboard restore failed',error);process.exitCode=1;});
  else if(clipboardItems) await clipboard.clear();
  win.destroy(); app.exit(process.exitCode || 0);
 }
});
