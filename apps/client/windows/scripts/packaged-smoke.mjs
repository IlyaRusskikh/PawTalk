import { serverDefinition } from '../../../../tooling/build/server-core.mjs';
import { spawn } from 'node:child_process';
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
const definition = await serverDefinition();
for (const field of ['schema','source','version','livekitVersion','goVersion','sourceSha256']) assert.equal(receipt[field],definition[field],'packaged shared server source: '+field);
for (const [name,field] of [['pawtalk-api.exe','apiSha256'],['livekit-server.exe','livekitSha256']]) {
  assert.equal(createHash('sha256').update(await readFile(path.join(packagedServer,name))).digest('hex'),receipt[field],'packaged binary hash: '+name);
}
assert.deepEqual((await readdir(packagedServer)).sort(),['GO-LICENSE','LIVEKIT-LICENSE','bundled-server.json','livekit-server.exe','pawtalk-api.exe'].sort(),'only shared-core binaries and required receipts/licenses are packaged');
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
  const sounds = JSON.parse(await readFile('apps/client/windows/public/sounds/sources.json', 'utf8')).assets;
  const packagedSounds = await evaluate(`(async()=>{const ctx=new OfflineAudioContext(1,1,48000);const results=[];for(const asset of ${JSON.stringify(sounds.map(({ name, sha256 }) => ({ name, sha256 })))}){const response=await fetch(new URL('./sounds/'+asset.name,document.baseURI));if(!response.ok)throw Error(asset.name);const bytes=await response.arrayBuffer();const digest=await crypto.subtle.digest('SHA-256',bytes);const sha256=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');const buffer=await ctx.decodeAudioData(bytes);results.push({name:asset.name,sha256,channels:buffer.numberOfChannels,seconds:buffer.duration});}return results;})()`);
  assert.equal(packagedSounds.length, sounds.length, 'all notification recordings are packaged');
  for (const sound of packagedSounds) {
    assert.equal(sound.sha256, sounds.find(asset => asset.name === sound.name).sha256, 'packaged recording is the approved file');
    assert.ok(sound.channels >= 1 && sound.channels <= 2);
    assert.ok(sound.seconds > .3 && sound.seconds < 4);
  }
  const until=async(expression,label)=>{for(let i=0;i<300;i++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(label);};
  await until("!!document.querySelector('.member-welcome')",'packaged home');
  await evaluate("document.querySelector('.onboarding-actions .quiet')?.click()");
  await until("!document.querySelector('.onboarding-modal')",'setup dismissed');
  assert.equal(await evaluate('window.desktop.pendingInvitation()'),invite);
  await until("!!document.querySelector('dialog input')",'protocol invitation');
  assert.equal(await evaluate("document.querySelector('dialog input').value"),invite);
  assert.equal(await evaluate("!!document.querySelector('.member-audio-buttons .person-network')"),false);
  await evaluate("document.querySelector('dialog .modal-heading button').click();document.querySelector('.member-rail-settings').click()");
  await evaluate("document.querySelector('#settings-tab-voice').click()");
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Проверка микрофона'&&!b.disabled)",'packaged RNNoise microphone');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Режим шумоподавления\"]').value"),'rnnoise');
  const rejected=await evaluate("window.desktop.membership('join',{address:'http://127.0.0.1:8080',nickname:'Synthetic'})");
  assert.ok(rejected.error,'packaged Client rejects plaintext admission');
  await evaluate("document.querySelector('dialog .modal-heading button').click()");
  await evaluate("window.desktop.startHost({port:32443,name:'Synthetic packaged server',nickname:'Packaged'})");
  const hostStatus=await evaluate('window.desktop.hostStatus()');assert.equal(hostStatus.running,true);assert.equal(hostStatus.e2ee,true);
  const own=await evaluate("window.desktop.membership('connect',{serverId:"+JSON.stringify(hostStatus.serverId)+"})");
  assert.equal(own.value.self.role,'admin');assert.equal(own.value.channels.length,2);
  const created=await evaluate("window.desktop.membership('invite',{serverId:"+JSON.stringify(hostStatus.serverId)+",kind:'single'})");
  const fields=new URLSearchParams(new URL(created.value).hash.slice(1));assert.equal(fields.get('v'),'2');assert.equal(fields.get('server'),hostStatus.serverId);assert.match(fields.get('open'),/^[a-f0-9]{64}$/);
  const channel=own.value.channels.find(c=>c.kind==='text').id;
  const sent=await evaluate("window.desktop.membership('send',{serverId:"+JSON.stringify(hostStatus.serverId)+",channelId:"+JSON.stringify(channel)+",content:{text:'Synthetic packaged encrypted chat'}})");assert.ok(!sent.error);
  const history=await evaluate("window.desktop.membership('messages',{serverId:"+JSON.stringify(hostStatus.serverId)+",channelId:"+JSON.stringify(channel)+"})");assert.ok(history.value.messages.some(m=>m.content.text==='Synthetic packaged encrypted chat'));
  const certificate=await new Promise((resolve,reject)=>{const connection=tls.connect({host:'127.0.0.1',port:32443,rejectUnauthorized:false},()=>{const cert=connection.getPeerCertificate();connection.destroy();resolve(cert);});connection.once('error',reject);});
  for(const address of [hostStatus.localAddress,...hostStatus.invitations])assert.equal(tls.checkServerIdentity(new URL(address).hostname,certificate),undefined);
  const anonymous=await new Promise((resolve,reject)=>{const request=https.get({hostname:'127.0.0.1',port:32443,path:'/api/v2/state',rejectUnauthorized:false},response=>{response.resume();resolve(response.statusCode);});request.once('error',reject);});assert.equal(anonymous,401);
  await until("!!document.querySelector('.member-server-list button')",'host registry');
  await evaluate("document.querySelector('.member-server-list button').click()");
  await until("!!document.querySelector('.member-channel')",'host channels');
  await evaluate("document.querySelector('.member-channel').click()");
  await until("!!document.querySelector('.member-audio-buttons .person-network')",'packaged E2EE voice with RNNoise');
  await evaluate('window.desktop.stopHost()');
  await until("!document.querySelector('.member-audio-buttons .person-network')",'packaged host shutdown releases voice');
  assert.equal((await evaluate('window.desktop.hostStatus()')).running,false);
  await mkdir('release/qa',{recursive:true});
  await writeFile('release/qa/packaged.txt','PASS packaged API 2 Client, native resources/receipt, sounds, RNNoise, TLS bootstrap, OS storage, encrypted chat, E2EE voice, unique invitation and shutdown\n');
  console.log('PASS packaged Client/API 2, native module, verified receipt, sounds, RNNoise, TLS, creator membership, encrypted text/voice and shutdown');
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
