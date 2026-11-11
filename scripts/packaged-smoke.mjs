import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import tls from 'node:tls';
import https from 'node:https';
const profile = await mkdtemp(path.join(os.tmpdir(), 'pawtalk-packaged-'));
const packagedServer = path.resolve(process.env.PAWTALK_PACKAGED_DIR || 'release/win-unpacked','resources/server');
const receipt = JSON.parse(await readFile(path.join(packagedServer,'bundled-server.json'),'utf8'));
const pinned = JSON.parse(await readFile('bundled-server.json','utf8'));
for (const field of ['version','commit','livekitVersion','goVersion','securityPatch','securityPatchSha256']) assert.equal(receipt[field],pinned[field],'packaged server pin: '+field);
for (const [name,field] of [['pawtalk-api.exe','apiSha256'],['livekit-server.exe','livekitSha256']]) {
  assert.equal(createHash('sha256').update(await readFile(path.join(packagedServer,name))).digest('hex'),receipt[field],'packaged binary hash: '+name);
}
assert.deepEqual((await readdir(packagedServer)).sort(),['GO-LICENSE','LIVEKIT-LICENSE','bundled-server.json','livekit-server.exe','pawtalk-api.exe'].sort(),'only pinned binaries and required receipts/licenses are packaged');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.PAWTALK_DEV_URL;
const invite = `pawtalk://127.0.0.1:32443/${'a'.repeat(64)}`;
const child = spawn(path.resolve(process.env.PAWTALK_PACKAGED_DIR || 'release/win-unpacked', 'PawTalk.exe'), ['--smoke', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=19337', `--user-data-dir=${profile}`, invite], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-131072); });
let socket;
let next = 0;
const pending = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 60000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
try {
  let target;
  for (let i = 0; i < 100; i++) {
    try { const list = await (await fetch('http://127.0.0.1:19337/json/list')).json(); target = list.find(item => item.type === 'page' && item.url.startsWith('file:')); if (target) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(target, 'packaged window loads');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data); const request = pending.get(message.id);
    if (request) { pending.delete(message.id); if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); }
  });
  // A file: debugger target can appear before preload initializes its context.
  // Wait for the bridge rather than racing the first document navigation.
  let bridgeReady = false;
  for (let i = 0; i < 100; i++) {
    try { bridgeReady = await evaluate('typeof window.desktop?.capabilities === "function"'); } catch { /* Navigation may replace the context. */ }
    if (bridgeReady) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(bridgeReady, 'packaged preload exposes the desktop bridge');
  const info = await evaluate('window.desktop.capabilities()');
  assert.equal(info.native, true); assert.equal(info.packaged, true);
  assert.equal(await evaluate('typeof window.require'), 'undefined');
  const sounds = JSON.parse(await readFile('public/sounds/sources.json', 'utf8')).assets;
  const packagedSounds = await evaluate(`(async()=>{const ctx=new OfflineAudioContext(1,1,48000);const results=[];for(const asset of ${JSON.stringify(sounds.map(({ name, sha256 }) => ({ name, sha256 })))}){const response=await fetch(new URL('./sounds/'+asset.name,document.baseURI));if(!response.ok)throw Error(asset.name);const bytes=await response.arrayBuffer();const digest=await crypto.subtle.digest('SHA-256',bytes);const sha256=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');const buffer=await ctx.decodeAudioData(bytes);results.push({name:asset.name,sha256,channels:buffer.numberOfChannels,seconds:buffer.duration});}return results;})()`);
  assert.equal(packagedSounds.length, 7, 'all notification recordings are packaged');
  for (const sound of packagedSounds) {
    assert.equal(sound.sha256, sounds.find(asset => asset.name === sound.name).sha256, 'packaged recording is the approved file');
    assert.equal(sound.channels, 1);
    assert.ok(sound.seconds > .3 && sound.seconds < .9);
  }
  for(let i=0;i<100;i++) {
    if(await evaluate('!!document.querySelector("h1")')) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(await evaluate('document.querySelector("h1")?.textContent'), 'Разговор начинается здесь.');
  assert.equal(await evaluate('window.desktop.pendingInvitation()'), invite, 'protocol argument reaches preload');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('input')).some(el=>el.value===${JSON.stringify(invite)})`), true, 'protocol invitation fills the connection form');
  assert.equal(await evaluate(`document.querySelectorAll('.person-card').length`), 0, 'opening invitation does not auto-connect');
  await evaluate(`document.querySelector('button[title="Настройки"]').click()`);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluate('document.querySelector("dialog h2")?.textContent'), 'Настройки');
  await evaluate(`document.querySelector('#settings-tab-voice').click()`);
  for(let i=0;i<100;i++) {
    if(await evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Проверка микрофона'&&!b.disabled)`)) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Проверка микрофона'&&!b.disabled)`),true,'packaged RNNoise model loads and microphone starts');
  await evaluate(`document.querySelector('#settings-tab-voice').click()`);
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await evaluate(`document.querySelector('[aria-label="Режим шумоподавления"]').value`),'rnnoise');
  await assert.rejects(evaluate(`window.desktop.connect({address:'http://127.0.0.1:8080',nickname:'test',password:'test'})`));
  await evaluate(`window.selfhostPassword=crypto.randomUUID(); window.desktop.startHost({port:32443,password:window.selfhostPassword})`);
  const hostStatus = await evaluate('window.desktop.hostStatus()');
  assert.equal(hostStatus.running, true, 'packaged server resources start');
  await evaluate(`document.querySelector('dialog [aria-label="Закрыть"]').click()`);
  const myRoomButton = `Array.from(document.querySelectorAll('.home-action')).find(b=>b.textContent.startsWith('Моя комната'))`;
  for (let i = 0; i < 50; i++) {
    if (await evaluate(`!!(${myRoomButton})`)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(await evaluate(`!!(${myRoomButton})`), 'lobby reflects the running host');
  await evaluate(`(${myRoomButton}).click()`);
  for (let i = 0; i < 50; i++) {
    if (await evaluate(`!!document.querySelector('.host-invite button')`)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const selectedInvitation = await evaluate(`document.querySelector('.host-invite input').value`);
  assert.ok(hostStatus.invitations.includes(selectedInvitation), 'selected invitation belongs to the running host');
  await evaluate(`document.querySelector('.host-invite button').click()`);
  for (let i = 0; i < 50; i++) {
    if (await evaluate(`document.querySelector('.host-invite button').textContent==='Скопировано'`)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await evaluate(`document.querySelector('.host-invite button').textContent`), 'Скопировано', 'copy button uses installed preload and main');
  const clipboard = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8', windowsHide: true });
  assert.equal(clipboard.status, 0, 'system clipboard can be read');
  assert.ok(clipboard.stdout.trim() === selectedInvitation, 'system clipboard contains the selected invitation');
  const afterSharing = await evaluate('window.desktop.hostStatus().then(s=>({running:s.running,message:s.message}))');
  assert.equal(afterSharing.running, true, `host is still running after sharing: ${afterSharing.message || 'no status message'}`);
  const certificate = await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port: 32443, rejectUnauthorized: false }, () => {
      const peer = socket.getPeerCertificate(); socket.destroy(); resolve(peer);
    });
    socket.setTimeout(5000, () => socket.destroy(new Error('Packaged TLS timed out')));
    socket.once('error', reject);
  });
  for (const address of [hostStatus.localAddress, ...hostStatus.invitations]) {
    assert.equal(tls.checkServerIdentity(new URL(address).hostname, certificate), undefined, 'packaged certificate covers every invitation IP');
  }
  const anonymousPresence=await new Promise((resolve,reject)=>{
    const request=https.get({hostname:'127.0.0.1',port:32443,path:'/api/presence',rejectUnauthorized:false,timeout:5000},response=>{
      assert.deepEqual(response.socket.getPeerCertificate().raw,certificate.raw,'same verified embedded host certificate');
      let raw='';response.on('data',data=>raw+=data);response.on('end',()=>resolve({status:response.statusCode,raw}));
    });request.once('timeout',()=>request.destroy(Error('Presence check timed out')));request.once('error',reject);
  });
  assert.equal(anonymousPresence.status,401,'packaged temporary room does not expose anonymous occupancy');
  assert.doesNotMatch(anonymousPresence.raw,/participants/);
  const localDiagnosis = await evaluate('window.desktop.hostStatus().then(s=>window.desktop.diagnose(s.localAddress))');
  assert.equal(localDiagnosis.ok, true, localDiagnosis.message);
  const ownDiagnosis = await evaluate('window.desktop.hostStatus().then(s=>window.desktop.diagnose(s.invitations[0]))');
  assert.equal(ownDiagnosis.ok, true, ownDiagnosis.message);
  assert.match(ownDiagnosis.message, /напрямую/);
  if (process.env.PAWTALK_EXPECT_PORT_MAPPING === '1') assert.equal(hostStatus.mapped, true, 'packaged mapper opens all ports on test router');
  const hosted = await evaluate(`window.desktop.hostStatus().then(s=>window.desktop.connect({address:s.localAddress,nickname:'Packaged',password:window.selfhostPassword}))`);
  assert.equal(hosted.error, undefined, hosted.error);
  assert.ok(hosted.token, 'packaged TLS room returns token');
  await evaluate('window.desktop.stopHost()');
  assert.equal(await evaluate('window.desktop.hostStatus().then(s=>s.running)'), false);
  await mkdir('release/qa', { recursive: true });
  await writeFile('release/qa/packaged.txt', 'PASS packaged Windows executable\nPASS native resource loaded outside ASAR\nPASS renderer and settings navigation\nPASS isolated preload IPC\nPASS packaged client rejects plaintext HTTP\nPASS embedded API and LiveKit start from packaged resources\nPASS packaged invitation TLS and password authentication\nPASS embedded host shutdown\n');
  console.log('PASS packaged executable, native module, renderer, IPC, HTTPS-only policy and embedded selfhost');
} catch (error) {
  await mkdir('release/qa', { recursive: true });
  await writeFile('release/qa/packaged-stderr.log', stderr);
  console.error(error.stack || error.message); process.exitCode = 1;
} finally {
  if (socket?.readyState === WebSocket.OPEN) await evaluate('window.desktop.stopHost()').catch(() => {});
  socket?.close();
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 10000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  }
}
