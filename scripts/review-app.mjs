import {spawn,execFile} from 'node:child_process';
import {mkdir,readFile,writeFile,open,unlink,access} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {randomBytes} from 'node:crypto';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{config}=require('./review-app-config.cjs'),execute=promisify(execFile);
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function state(paths){try{const raw=await readFile(paths.runtime,'utf8');if(raw.length>8192)throw Error('Invalid runtime');return JSON.parse(raw);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function command(file,args,cwd){await execute(file,args,{cwd,windowsHide:true,timeout:180000,maxBuffer:4*1024*1024});}
async function managerHost(root){
 let installed;
 try{const {stdout}=await execute('reg.exe',['query','HKLM\\Software\\PawTalk\\ServerManager'],{windowsHide:true});const field=name=>stdout.match(new RegExp('^\\s*'+name+'\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)$','m'))?.[1].trim();if(field('InstallDir')&&field('DataRoot'))installed={managerHost:field('InstallDir'),managerRoot:field('DataRoot')};}catch{}
 const result=installed||{managerHost:path.join(root,'release/manager/windows'),managerRoot:path.join(root,'release/review-apps/manager/server-data')};
 await access(path.join(result.managerHost,'pawtalkctl.exe')).catch(()=>{throw Error('Manager host runtime is missing. Install Manager or prepare scripts/build-manager-windows.mjs --runtime-only.');});return result;
}
async function build(component,root){
 console.log('Building '+component+' review...');
 if(component==='client'){
  for(const script of ['scripts/prepare-licenses.mjs','scripts/prepare-rnnoise.mjs','node_modules/typescript/bin/tsc','node_modules/vite/bin/vite.js'])await command(process.execPath,[script,...(script.endsWith('/tsc')?['--noEmit']:script.endsWith('/vite.js')?['build']:[])],root);
 }else{
  await command(process.execPath,['node_modules/typescript/bin/tsc','-p','manager/desktop/tsconfig.json'],root);
  await command(process.execPath,['node_modules/vite/bin/vite.js','build','--config','manager/desktop/vite.config.mjs'],root);
  await command(require('electron'),['scripts/manager-icons.cjs'],root);
 }
}
export async function stopApp(component,profile=''){
 const paths=config(component,profile),runtime=await state(paths);
 if(!runtime){console.log(component+' review is already stopped.');return;}
 if(!alive(runtime.pid)){await unlink(paths.runtime);console.log(component+' review is already stopped.');return;}
 if(!/^\\\\\.\\pipe\\pawtalk-app-[a-f0-9]{32}$/.test(runtime.pipe)||!/^[a-f0-9]{64}$/.test(runtime.token))throw Error('Invalid review control record');
 await new Promise((resolve,reject)=>{const socket=createConnection(runtime.pipe);let response='';socket.setTimeout(10000,()=>socket.destroy(Error('Stop timed out')));socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify({action:'stop',token:runtime.token})+'\n'));socket.on('data',chunk=>{response+=chunk;if(response.length>1024)socket.destroy(Error('Invalid response'));});socket.on('end',()=>response.trim()==='stopping'?resolve():reject(Error(response.trim()==='busy'?'Manager is busy; finish or cancel the current operation, then stop again':'Stop rejected')));});
 for(let i=0;i<200;i++){if(!alive(runtime.pid)){console.log(component+' review stopped.');return;}await delay(100);}
 throw Error('Review did not exit gracefully; no other process was terminated');
}
export async function startApp(component,profile='',{prepare=true,bootstrap='scripts/review-app.cjs'}={}){
 const paths=config(component,profile);await mkdir(paths.directory,{recursive:true});const previous=await state(paths);
 if(previous&&alive(previous.pid)){console.log(component+' review is already running.');return previous;}
 if(previous)await unlink(paths.runtime);
 const lock=await open(paths.runtime,'wx'),token=randomBytes(32).toString('hex');
 const runtime={pid:process.pid,token,pipe:'\\\\.\\pipe\\pawtalk-app-'+randomBytes(16).toString('hex'),ready:false};
 let child;
 try{
  await lock.writeFile(JSON.stringify(runtime)+'\n');await lock.close();
  if(component==='manager')Object.assign(runtime,await managerHost(paths.root));
  if(prepare)await build(component,paths.root);
  await writeFile(paths.runtime,JSON.stringify(runtime)+'\n');
  const out=await open(path.join(paths.directory,'stdout.log'),'a'),err=await open(path.join(paths.directory,'stderr.log'),'a');
  const env={...process.env,PAWTALK_REVIEW_APP_TOKEN:token};delete env.ELECTRON_RUN_AS_NODE;
  child=spawn(require('electron'),[bootstrap,'--component='+component,'--profile='+profile],{cwd:paths.root,env,detached:true,windowsHide:false,stdio:['ignore',out.fd,err.fd]});
  let failure;child.once('error',error=>{failure=error;});child.unref();await out.close();await err.close();
  for(let i=0;i<300;i++){
   if(failure)throw failure;if(child.exitCode!==null)throw Error('Review exited before ready; see '+paths.directory+'\\stderr.log');
   const current=await state(paths);if(current?.token===token&&current.ready){console.log(component+' review started (PID '+current.pid+').');return current;}await delay(100);
  }
  throw Error('Review startup timed out; see '+paths.directory+'\\stderr.log');
 }catch(error){await lock.close().catch(()=>{});const current=await state(paths);if(current?.token===token&&(!child||!alive(current.pid)))await unlink(paths.runtime);throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{const[component,action,...rest]=process.argv.slice(2);const profile=rest[0]||'';config(component,profile);if(rest.length>1)throw Error('Only an optional profile is supported');if(action==='start')await startApp(component,profile);else if(action==='stop')await stopApp(component,profile);else throw Error('Use client|manager start|stop [profile]');}catch(error){console.error(error.message);process.exitCode=1;}
}
