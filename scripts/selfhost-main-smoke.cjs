const { app, BrowserWindow, session, clipboard } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
app.setPath('userData', path.join(os.tmpdir(), 'voicecord-selfhost-ui-'+process.pid));
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.disableHardwareAcceleration();
process.argv.push('--smoke');
process.argv.push('--offscreen-smoke');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 60000) {
  const end = Date.now()+timeout;
  while (Date.now()<end) { if (await fn()) return; await wait(100); }
  throw new Error('Timed out: '+label);
}
let handled = false;
app.on('browser-window-created', (_event, win) => {
  if (handled) return; handled = true;
  win.webContents.once('did-finish-load', async () => {
    let vite, guest;
    const js = code => win.webContents.executeJavaScript(code, true);
    try {
      await until(() => js('!!document.querySelector("h1")'), 'app ready');
      await js(`localStorage.setItem('voicecord.settings',JSON.stringify({noiseMode:'off',autoSensitivity:false,threshold:-80,echoCancellation:false,autoGainControl:false,sounds:false}))`);
      const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.reload(); await loaded;
      await until(() => js('!!document.querySelector("h1")'), 'reloaded app ready');
      await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Создать комнату').click()`);
      const password = randomBytes(24).toString('base64url');
      await js(`(()=>{const form=document.querySelector('.host-card form');const inputs=form.querySelectorAll('input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [i,value] of ${JSON.stringify([[0,'Host'],[1,password],[2,'30443']])}){set.call(inputs[i],value);inputs[i].dispatchEvent(new Event('input',{bubbles:true}));}})()`);
      await wait(100);
      await js(`document.querySelector('.host-card form').requestSubmit()`);
      console.log('selfhost UI submitted');
      await until(() => js('window.desktop.hostStatus().then(s=>s.running)'), 'host starts from UI');
      console.log('selfhost server ready');
      await until(() => js(`document.querySelectorAll('.person-card').length===1`), 'host joins own room');
      console.log('selfhost local participant joined');
      await js(`(()=>{
        window.testPlaybackGains=[];
        const create=AudioContext.prototype.createGain;
        AudioContext.prototype.createGain=function(){const node=create.call(this);window.testPlaybackGains.push(node);return node;};
        window.testPlaybackRMS=async()=>{
          const gain=window.testPlaybackGains.at(-1);
          if(!gain)throw new Error('No remote playback gain');
          const analyser=gain.context.createAnalyser();analyser.fftSize=2048;gain.connect(analyser);
          const data=new Float32Array(2048);let energy=0;
          try{for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,20));analyser.getFloatTimeDomainData(data);energy+=data.reduce((sum,x)=>sum+x*x,0)/data.length;}return Math.sqrt(energy/30);}
          finally{gain.disconnect(analyser);analyser.disconnect();}
        };
      })()`);
      const status = await js('window.desktop.hostStatus()');
      const diagnostic = await js(`window.desktop.diagnose(${JSON.stringify(status.localAddress)})`);
      assert.equal(diagnostic.ok, true, diagnostic.message);
      const ownInvitation = status.invitations[0];
      const ownDiagnostic = await js(`window.desktop.diagnose(${JSON.stringify(ownInvitation)})`);
      assert.equal(ownDiagnostic.ok, true, ownDiagnostic.message);
      assert.match(ownDiagnostic.message, /напрямую/);
      const ownToken = await js(`window.desktop.connect(${JSON.stringify({ address: ownInvitation, nickname: 'OwnInviteCheck', password })})`);
      assert.equal(ownToken.error, undefined, ownToken.error);
      assert.ok(ownToken.url.startsWith('wss://127.0.0.1:'), 'own invitation bypasses router hairpin');
      const stale = status.localAddress.slice(0,-1)+(status.localAddress.endsWith('a') ? 'b' : 'a');
      const staleDiagnostic = await js(`window.desktop.diagnose(${JSON.stringify(stale)})`);
      assert.equal(staleDiagnostic.ok, false);
      assert.match(staleDiagnostic.message, /устарело/);
      await js(`document.querySelector('.host-invite button').click()`);
      await until(() => js(`document.querySelector('.host-invite button').textContent==='Скопировано'`), 'copy invitation through real IPC');
      assert.equal(await clipboard.readText(), status.invitations[0]);
      const address = status.invitations[status.internet ? 1 : 0] || status.localAddress;
      const credentials = await new Promise((resolve, reject) => {
        const env = { ...process.env, VOICECORD_TEST_INVITATION: address, VOICECORD_TEST_PASSWORD: password };
        delete env.ELECTRON_RUN_AS_NODE;
        const client = spawn(process.execPath, [path.resolve('scripts/invitation-client-smoke.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        client.stdout.on('data', data => { stdout += data; });
        client.stderr.on('data', data => { stderr += data; });
        const timeout = setTimeout(() => { client.kill(); reject(new Error('Guest main process timed out')); }, 30000);
        client.once('error', error => { clearTimeout(timeout); reject(error); });
        client.once('exit', code => {
          clearTimeout(timeout);
          if (code !== 0) { reject(new Error(`Guest main failed: ${stderr}`)); return; }
          try {
            const line = stdout.split(/\r?\n/).find(line => line.startsWith('VOICECORD_TEST_CREDENTIALS:'));
            resolve(JSON.parse(line.slice('VOICECORD_TEST_CREDENTIALS:'.length)));
          } catch { reject(new Error('No guest credentials returned')); }
        });
      });
      assert.equal(credentials.error, undefined, credentials.error);
      assert.equal(new URL(credentials.url).hostname, new URL(address).hostname, 'separate client authenticates and connects through LAN');
      console.log('PASS separate main/preload client uses LAN invitation without a CA installation or loopback rewrite');
      const { createServer } = await import('vite');
      vite = await createServer({ server: { host: '127.0.0.1', port: 5178, strictPort: true } }); await vite.listen();
      const partition = session.fromPartition('selfhost-guest');
      partition.setPermissionRequestHandler((_wc,_permission,cb)=>cb(true)); partition.setPermissionCheckHandler(()=>true);
      partition.setCertificateVerifyProc((request, callback) => callback(new (require('node:crypto').X509Certificate)(request.certificate.data).fingerprint256.replaceAll(':','').toLowerCase() === status.fingerprint ? 0 : -2));
      guest = new BrowserWindow({ show: false, webPreferences: { session: partition, sandbox: true, backgroundThrottling: false, offscreen: true } });
      await guest.loadURL('http://127.0.0.1:5178/tests/voice.html');
      const guestJS = code => guest.webContents.executeJavaScript(code, true);
      await until(() => guestJS('window.ready === true'), 'guest ready');
      await guestJS(`window.start(${JSON.stringify(credentials)})`);
      await until(() => js(`document.querySelectorAll('.person-card').length===2`), 'two participants');
      await until(async () => await guestJS('window.outputRMS()') > 0.001, 'host audio reaches guest');
      await until(() => guestJS(`window.snapshot.people?.length===2`), 'guest sees host');
      const level = async volume => {
        await guestJS(`window.voice.setPerson([...window.voice.room.remoteParticipants.keys()][0],${volume},false)`);
        await wait(700);
        return guestJS('window.outputRMS()');
      };
      const full = await level(1), quarter = await level(0.25), double = await level(2), silent = await level(0);
      assert.ok(full > 0.001, `audible playback: ${full}`);
      assert.ok(quarter / full > 0.15 && quarter / full < 0.4, `25% output: ${quarter/full}`);
      assert.ok(double / full > 1.5 && double / full < 2.5, `200% output: ${double/full}`);
      assert.ok(silent < full * 0.001, `0% output: ${silent}`);
      await level(1);
      await guestJS('window.voice.setMute(false,true)'); await wait(700);
      assert.ok(await guestJS('window.outputRMS()') < full * 0.001, 'deafen silences decoded playback');
      await guestJS('window.voice.setMute(false,false)'); await wait(700);
      assert.ok(await guestJS('window.outputRMS()') > full * 0.5, 'deafen restores playback');
      console.log('PASS measured playback samples at 0%, 25%, 100%, 200%, deafen and restore');
      const uiLevel = async volume => {
        await js(`(()=>{const slider=document.querySelector('.person-controls input[type="range"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,${volume});slider.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await wait(700);
        return js('window.testPlaybackRMS()');
      };
      const uiFull=await uiLevel(1),uiQuarter=await uiLevel(0.25),uiSilent=await uiLevel(0);
      assert.ok(uiFull>0.001,'remote audio reaches host playback');
      assert.ok(uiQuarter/uiFull>0.15 && uiQuarter/uiFull<0.4,`UI slider 25% ratio: ${uiQuarter/uiFull}`);
      assert.ok(uiSilent<uiFull*0.001,'UI slider 0% is silent');
      await uiLevel(1);
      await js(`document.querySelector('.person-controls input[type="checkbox"]').click()`);await wait(700);
      assert.ok(await js('window.testPlaybackRMS()')<uiFull*0.001,'UI participant mute silences actual samples');
      await js(`document.querySelector('.person-controls input[type="checkbox"]').click()`);await wait(700);
      assert.ok(await js('window.testPlaybackRMS()')>uiFull*0.5,'UI unmute restores actual samples');
      console.log('PASS actual participant slider events and checkbox clicks change measured playback');
      await wait(300);
      await fs.mkdir('release/qa', { recursive: true });
      await fs.writeFile('release/qa/selfhost-room.png', (await win.webContents.capturePage()).toPNG());
      const badAddress = address.slice(0,-1)+(address.endsWith('a') ? 'b' : 'a');
      const rejected = await js(`window.desktop.connect(${JSON.stringify({ address: badAddress, nickname: 'BadPin', password })})`);
      assert.ok(rejected.error, 'wrong certificate pin must fail');
      app.emit('second-instance', {}, [process.execPath, address]);
      assert.equal(await js('window.desktop.pendingInvitation()'), address);
      await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Закрыть комнату для всех').click()`);
      await until(() => js('window.desktop.hostStatus().then(s=>!s.running)'), 'UI closes host');
      await until(() => guestJS(`window.snapshot.state==='disconnected'`), 'guest disconnects');
      await fs.writeFile('release/qa/selfhost.txt', 'PASS create room through UI\nPASS host joins using pinned TLS\nPASS guest API authentication through invitation\nPASS two participants and decoded audio received\nPASS incorrect certificate pin rejected\nPASS close room disconnects guest\n');
      console.log('PASS selfhost UI, real main/preload IPC, pinned TLS, two clients, decoded audio and shutdown');
    } catch (error) { console.error(error); console.error(await js(`({status:await window.desktop.hostStatus(),error:document.querySelector('[role="alert"]')?.textContent})`).catch(()=>({}))); process.exitCode = 1; }
    finally { guest?.destroy(); await vite?.close(); await js('window.desktop.stopHost()').catch(()=>{}); app.exit(process.exitCode || 0); }
  });
});
require('../electron/main.cjs');
