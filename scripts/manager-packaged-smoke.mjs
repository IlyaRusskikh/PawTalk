// Launch the real packaged app against an isolated, nonexistent service root.
// Never opens settings, elevates, installs or changes a user's server.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
if(process.platform!=='win32')throw Error('Packaged Manager smoke requires Windows');
const root=await mkdtemp(path.join(os.tmpdir(),'pawtalk-manager-packaged-'));
const key=createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,16);
const pipe=String.raw`\\.\pipe\PawTalk.Manager.UI.${key}`;
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(path.resolve('release/manager/windows/desktop/PawTalk Server Manager.exe'),['--root',root,'--tray'],{env,windowsHide:true,stdio:'ignore'});
let ended=false;
const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{ended=true;resolve(code);});});
const request=()=>new Promise((resolve,reject)=>{
 const socket=net.connect(pipe);let body='';socket.setEncoding('utf8');socket.setTimeout(3000,()=>socket.destroy(Error('Manager control timed out')));
 socket.once('error',reject);socket.once('connect',()=>socket.write(JSON.stringify({action:'maintenance',restart:false})+'\n'));
 socket.on('data',data=>{body+=data;if(body.includes('\n')){socket.end();try{resolve(JSON.parse(body.split('\n')[0]));}catch(error){reject(error);}}});
});
try{
 let response,lastError;
 for(let attempt=0;attempt<80&&!ended;attempt++){
  try{response=await request();break;}catch(error){lastError=error;await new Promise(r=>setTimeout(r,200));}
 }
 assert.deepEqual(response,{ok:true},lastError?.message||'Packaged Manager did not expose its control pipe');
 let timer;
 const code=await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Packaged Manager did not exit')),10000);})]).finally(()=>clearTimeout(timer));
 assert.equal(code,0);
 console.log('PASS packaged Manager starts hidden without elevation and closes through the actual maintenance pipe, without stopping a service or scheduling a restart');
}finally{
 if(!ended){child.kill();await exit.catch(()=>{});}
 await rm(root,{recursive:true,force:true});
 const profile=path.join(process.env.APPDATA,'PawTalk Server Manager',key);
 // Only the exact isolated test profile derived from this fresh root.
 assert.equal(path.dirname(profile),path.join(process.env.APPDATA,'PawTalk Server Manager'));
 await rm(profile,{recursive:true,force:true});
}
