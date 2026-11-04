// Real main/preload/UI against the local dev server. Uses a muted fake microphone.
const {app}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
app.setPath('userData',path.join(os.tmpdir(),'voicecord-ui-session-'+process.pid));
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.disableHardwareAcceleration();
process.argv.push('--smoke','--offscreen-smoke');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.on('browser-window-created',(_event,win)=>{
  const js=expression=>win.webContents.executeJavaScript(expression,true);
  async function until(expression,message){for(let i=0;i<150;i++){if(await js(expression))return;await wait(100);}throw new Error('Timed out: '+message);}
  const load=()=>new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
  win.webContents.once('did-finish-load',async()=>{
    try{
      assert.ok(process.env.VOICECORD_TEST_PASSWORD,'test password required');
      await until(`!!document.querySelector('form')`,'connection form');
      assert.equal(await js(`document.querySelectorAll('.participants-heading,.empty-room,.connection-popover').length`),0);
      const secret=JSON.stringify(process.env.VOICECORD_TEST_PASSWORD);
      await js(`(()=>{const inputs=document.querySelectorAll('form input');const set=(input,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};set(inputs[0],'http://127.0.0.1:8080');set(inputs[1],'Проверка интерфейса');set(inputs[2],${secret});})()`);
      await until(`!document.querySelector('.save-password input').disabled`,'protected storage');
      await js(`document.querySelector('.save-password input').click();document.querySelector('button[title="Микрофон"]').click();document.querySelector('form').requestSubmit()`);
      await until(`document.querySelector('.connection-mini').textContent.includes('На связи') && !!document.querySelector('.person-card')`,'connected room');
      await until(`window.desktop.loadPassword('http://127.0.0.1:8080').then(x=>x.password===${secret})`,'successful password save');
      assert.equal(await js(`document.querySelectorAll('form,.empty-room,.stats-grid').length`),0);
      assert.equal(await js(`document.querySelector('.sidebar').textContent.includes('127.0.0.1')`),false);
      await wait(5200);
      await js(`document.querySelector('.connection-mini').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`);
      await until(`!!document.querySelector('[role=tooltip]')`,'hover popup');
      assert.equal(await js(`document.querySelectorAll('[role=tooltip] dl>div').length`),2);
      assert.ok(await js(`document.querySelector('[role=tooltip]').textContent.includes('Задержка') && document.querySelector('[role=tooltip]').textContent.includes('Потеря пакетов')`));
      assert.ok(await js(`document.querySelector('[role=tooltip]').textContent.includes('%')`));
      assert.equal(await js(`document.querySelector('[role=tooltip]').textContent.includes('127.0.0.1')`),false);
      assert.equal(await js(`document.body.textContent.includes('Как читать показатели') || document.body.textContent.includes('Диагностика соединения') || document.body.textContent.includes('Джиттер')`),false);
      await fs.mkdir('release/qa',{recursive:true});
      await fs.writeFile('release/qa/connection-popup.png',(await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('.connection-mini').focus();document.querySelector('.connection-mini').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      await until(`!document.querySelector('[role=tooltip]')`,'escape closes popup');
      await js(`document.querySelector('.disconnect').click()`);
      await until(`!!document.querySelector('form') && !document.querySelector('.person-card')`,'disconnected form');
      const reloaded=load();win.webContents.reload();await reloaded;
      await until(`document.querySelector('input[type=password]')?.value===${secret} && document.querySelector('.save-password input')?.checked`,'restored password after reload');
      await js(`document.querySelector('.save-password input').click()`);
      await until(`window.desktop.loadPassword('http://127.0.0.1:8080').then(x=>x.password===null)`,'opt out removes stored password');
      const clean=load();win.webContents.reload();await clean;await wait(700);
      assert.equal(await js(`document.querySelector('input[type=password]').value`),'');
      assert.equal(await js(`document.querySelector('.save-password input').checked`),false);
      await fs.writeFile('release/qa/ui-session.txt','PASS hidden pre-connection participants\nPASS real room connection and hover-only metrics\nPASS delay and percentage packet loss\nPASS no server address in connected sidebar/popup\nPASS Escape dismissal\nPASS Windows-encrypted password save and restore after reload\nPASS opt out removes password\n');
      console.log('PASS real UI connection, metrics popup, hidden address and encrypted password persistence');app.quit();
    }catch(error){console.error(error.message);app.exit(1);}
  });
});
require('../electron/main.cjs');
