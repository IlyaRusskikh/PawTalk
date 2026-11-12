// Actual Windows binaries, Python runtime, Ed25519, SQLite and process-job lifecycle.
import {mkdtemp,readFile,writeFile,cp,mkdir,rm} from 'node:fs/promises';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import path from 'node:path';
import os from 'node:os';
const root=path.resolve(import.meta.dirname,'..');
if(process.platform!=='win32')throw Error('Windows smoke requires Windows');
const directory=await mkdtemp(path.join(os.tmpdir(),'pawtalk-windows-manager-'));
const stage=path.join(root,'release/manager/windows');
const hash=b=>createHash('sha256').update(b).digest('hex');
let vite;
try{
 const keys={},privateKeys={};
 for(const component of ['server','manager']){const pair=generateKeyPairSync('ed25519');keys[component]={test:pair.publicKey.export({type:'spki',format:'pem'}).toString()};privateKeys[component]=pair.privateKey;}
 await writeFile(path.join(directory,'trust.json'),JSON.stringify(keys));
 const now=Math.floor(Date.now()/1000);
 async function manifest(component,version,extra){
  const payload=Buffer.from(JSON.stringify({schema:1,component,repository:'IlyaRusskikh/PawTalk',version,channel:'preview',publishedAt:now,expiresAt:now+3600,apiProtocol:1,dataSchema:1,...extra}));
  await writeFile(path.join(directory,`${component}-${version}.json`),JSON.stringify({keyId:'test',payload:payload.toString('base64'),signature:sign(null,payload,privateKeys[component]).toString('base64')}));
 }
 const version=(await readFile(path.join(root,'server/VERSION'),'utf8')).trim();
 const archive=await readFile(process.env.PAWTALK_WINDOWS_SERVER_ZIP || path.join(root,`release/server/PawTalk.Server.${version}.windows-x64.zip`));
 for(const v of ['0.9.0','0.9.1','0.9.2']){
  const name=`PawTalk.Server.${v}.windows-x64.zip`;
  await writeFile(path.join(directory,name),archive);
  await manifest('server',v,{image:'ghcr.io/ilyarusskikh/pawtalk-server',digest:'sha256:'+hash(Buffer.from(v)),windows:{name,sha256:hash(archive),size:archive.length}});
 }
 for(const v of ['0.1.0','0.1.1']){
  const content=path.join(directory,'bundle-'+v);await mkdir(content);
  await cp(path.join(stage,'bootstrap/manager'),path.join(content,'manager'),{recursive:true});
  await writeFile(path.join(content,'manager/VERSION'),v);
  await writeFile(path.join(content,'manager/trust.json'),JSON.stringify(keys));
  for(const file of ['LICENSE','THIRD_PARTY_NOTICES.md'])await cp(path.join(root,file),path.join(content,file));
  const bundle=`PawTalk.Manager.${v}.tar.gz`;
  const files=['manager/VERSION','manager/trust.json','manager/compose.server.yaml','manager/launcher','manager/pawtalkctl','manager/pawtalk-update.service','manager/pawtalk-update.timer','manager/pawtalk-health.service','manager/pawtalk-health.timer','LICENSE','THIRD_PARTY_NOTICES.md',...['__init__','release','config','runtime','controller','preflight','bundles','cli','platforms','native'].map(n=>`manager/pawtalk_manager/${n}.py`)];
  execFileSync('tar.exe',['-czf',path.join(directory,bundle),'-C',content,...files],{windowsHide:true});
  const bytes=await readFile(path.join(directory,bundle));
  await manifest('manager',v,{bundle,size:bytes.length,sha256:hash(bytes),launcherProtocol:1,configSchema:1});
 }
 vite=await createServer({server:{host:'127.0.0.1',port:0,strictPort:false}});await vite.listen();
 const uiAddress=`http://127.0.0.1:${vite.httpServer.address().port}`;
 const env={...process.env,PAWTALK_MANAGER_HOST:path.join(stage,'pawtalkctl.exe'),PAWTALK_UI_TEST_URL:uiAddress,PAWTALK_ELECTRON:createRequire(import.meta.url)('electron')};delete env.ELECTRON_RUN_AS_NODE;
 const go=process.env.PAWTALK_GO||'go';
 if(spawnSync(go,['version'],{windowsHide:true}).status===0){
  execFileSync(go,['test','-c','-o',path.join(directory,'clipboard-test.exe')],{cwd:path.join(root,'manager/windows'),stdio:'inherit',windowsHide:true});
 }else{
  execFileSync('docker',['run','--rm','--mount',`type=bind,source=${path.join(root,'manager/windows')},target=/src,readonly`,'--mount',`type=bind,source=${directory},target=/out`,'--mount','type=volume,source=pawtalk-go-mod,target=/go/pkg/mod','--mount','type=volume,source=pawtalk-go-build,target=/root/.cache/go-build','-w','/src','-e','GOOS=windows','-e','GOARCH=amd64','golang:1.27.3-alpine','go','test','-c','-o','/out/clipboard-test.exe'],{stdio:'inherit',windowsHide:true});
 }
 await writeFile(path.join(directory,'clipboard.html'),'<!doctype html><meta charset="utf-8"><title>PawTalk clipboard fixture</title>');
 execFileSync(env.PAWTALK_ELECTRON,[path.join(root,'tests/windows-clipboard.cjs'),directory],{cwd:root,env,stdio:'inherit',windowsHide:true,timeout:30000});
 await new Promise((resolve,reject)=>{
  const child=spawn(path.join(stage,'runtime/python.exe'),['-B','-X','utf8','-I',path.join(root,'tests/windows_manager_smoke.py'),directory,stage,...process.argv.slice(2)],{cwd:root,stdio:'inherit',windowsHide:true,env});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Windows Manager smoke failed: '+code)));
 });
}finally{
 await vite?.close();
 if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('pawtalk-windows-manager-'))throw Error('Unsafe test cleanup path');
 await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:500});
}
