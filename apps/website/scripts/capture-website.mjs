// Real Client/Go/LiveKit capture; isolated profiles and synthetic participants.
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {createServer as createViteServer} from 'vite';
const root=process.cwd(),directory=await mkdtemp(path.join(tmpdir(),'pawtalk-website-capture-'));
const freePort=()=>new Promise(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
let core,electron,vite;
try{
 vite=await createViteServer({server:{host:'127.0.0.1',port:0}});await vite.listen();
 for(const language of ['en','ru']){
  const port=await freePort(),media=await freePort(),config=path.join(directory,`livekit-${language}.yaml`),secret='c'.repeat(64);
  await writeFile(config,`port: ${media}\nbind_addresses: [127.0.0.1]\nrtc:\n  use_external_ip: false\n  node_ip: 127.0.0.1\n  enable_loopback_candidate: true\nkeys:\n  synthetic: ${secret}\nlogging:\n  level: error\n`);
  core=spawn(path.join(root,'resources/server/pawtalk-api.exe'),['selfhost'],{windowsHide:true,stdio:['pipe','pipe','pipe']});core.stderr.resume();
  const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Capture Server readiness timed out')),20000),lines=createInterface({input:core.stdout});lines.on('line',line=>{try{const data=JSON.parse(line);if(data.bootstrap){clearTimeout(timer);lines.close();core.stdout.resume();resolve(data);}}catch{}});core.once('error',reject);core.once('exit',code=>{clearTimeout(timer);reject(Error('Capture Server exited '+code));});});
  core.stdin.write(JSON.stringify({Port:port,MediaPort:media,Key:'synthetic',Secret:secret,Name:language==='en'?'Weekend lobby':'Вечерняя компания',Addresses:['127.0.0.1'],MediaExecutable:path.join(root,'resources/server/livekit-server.exe'),MediaConfig:config})+'\n');
  const {fingerprint,bootstrap}=await ready,address=`pawtalk://127.0.0.1:${port}/${fingerprint}#${new URLSearchParams({v:'2',server:bootstrap.serverId,invite:bootstrap.inviteId,token:bootstrap.token,setup:'1'})}`,input=path.join(directory,`fixture-${language}.json`);
  await writeFile(input,JSON.stringify({language,address,serverId:bootstrap.serverId,fingerprint,profile:path.join(directory,'profile-'+language)}));
  const env={...process.env,PAWTALK_CAPTURE_INPUT:input,PAWTALK_UI_TEST_URL:`http://127.0.0.1:${vite.httpServer.address().port}`};delete env.ELECTRON_RUN_AS_NODE;delete env.PAWTALK_DEV_URL;
  electron=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),['apps/website/tests/website-capture.cjs','--smoke'],{env,windowsHide:true,stdio:'inherit'});
  const timer=setTimeout(()=>electron.kill(),120000),code=await new Promise((resolve,reject)=>{electron.once('error',reject);electron.once('exit',resolve);});clearTimeout(timer);if(code!==0)throw Error('Website capture failed ('+code+')');
  const closed=new Promise(resolve=>core.once('close',resolve));core.stdin.end();await closed;core=undefined;
 }
}finally{
 if(electron?.exitCode===null)electron.kill();if(core?.exitCode===null)core.stdin.end();await vite?.close();
 if(path.dirname(directory)!==path.resolve(tmpdir())||!path.basename(directory).startsWith('pawtalk-website-capture-'))throw Error('Unsafe capture cleanup path');await rm(directory,{recursive:true,force:true});
}
