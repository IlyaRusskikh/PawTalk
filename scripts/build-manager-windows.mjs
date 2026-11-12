// Local builds never publish. Python is private to Manager; users install no runtime.
import {cp,mkdir,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
const root=path.resolve(import.meta.dirname,'..');
if(process.argv.slice(2).some(arg=>arg!=='--runtime-only'))throw Error('Supported option: --runtime-only');
const runtimeOnly=process.argv.includes('--runtime-only');
if(process.platform!=='win32')throw Error('Build Windows Manager on Windows');
const output=path.join(root,'release/manager');
const stage=path.join(output,'windows');
if(path.dirname(stage)!==path.join(root,'release/manager')||path.basename(stage)!=='windows')throw Error('Unsafe generated staging directory');
await rm(stage,{recursive:true,force:true});
await mkdir(path.join(stage,'runtime'),{recursive:true});
const run=(cmd,args,cwd=root)=>execFileSync(cmd,args,{cwd,stdio:'inherit',windowsHide:true});
const go=process.env.PAWTALK_GO||'go';
let nativeGo=true;
try{execFileSync(go,['version'],{windowsHide:true,stdio:'ignore'});}catch{nativeGo=false;}
if(nativeGo){
 run(go,['build','-trimpath','-o',path.join(stage,'pawtalkctl.exe'),'.'],path.join(root,'manager/windows'));
 run(go,['build','-trimpath','-ldflags=-H=windowsgui','-o',path.join(stage,'pawtalk-server-tray.exe'),'.'],path.join(root,'manager/windows'));
}else{
 run('docker',['run','--rm','--mount',`type=bind,source=${path.join(root,'manager/windows')},target=/src,readonly`,'--mount',`type=bind,source=${stage},target=/out`,'--mount','type=volume,source=pawtalk-go-mod,target=/go/pkg/mod','--mount','type=volume,source=pawtalk-go-build,target=/root/.cache/go-build','-w','/src','-e','GOOS=windows','-e','GOARCH=amd64','-e','CGO_ENABLED=0','golang:1.27.3-alpine','sh','-c','go build -trimpath -o /out/pawtalkctl.exe . && go build -trimpath -ldflags=-H=windowsgui -o /out/pawtalk-server-tray.exe . && cp /usr/local/go/LICENSE /out/GO-LICENSE && cp /go/pkg/mod/golang.org/x/sys@v0.49.0/LICENSE /out/X-SYS-LICENSE']);
}
await cp(path.join(root,'assets/server.ico'),path.join(stage,'server.ico'));
const pythonVersion='3.14.10';
const expected='90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159';
const archive=path.join(os.tmpdir(),`pawtalk-python-${pythonVersion}-embed-amd64.zip`);
let bytes=await readFile(archive).catch(()=>null);
if(!bytes||createHash('sha256').update(bytes).digest('hex')!==expected){
 const response=await fetch(`https://www.python.org/ftp/python/${pythonVersion}/python-${pythonVersion}-embed-amd64.zip`,{signal:AbortSignal.timeout(120000)});
 if(!response.ok)throw Error('Unable to download embedded Python');bytes=Buffer.from(await response.arrayBuffer());
 if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Embedded Python SHA-256 mismatch');
 await writeFile(archive,bytes);
}
run('tar.exe',['-xf',archive,'-C',path.join(stage,'runtime')]);
await mkdir(path.join(stage,'bootstrap/manager/pawtalk_manager'),{recursive:true});
const files=['VERSION','trust.json','compose.server.yaml','pawtalkctl','launcher','pawtalk-update.service','pawtalk-update.timer','pawtalk-health.service','pawtalk-health.timer'];
for(const file of files)await cp(path.join(root,'manager',file),path.join(stage,'bootstrap/manager',file));
for(const name of ['__init__','release','config','runtime','controller','preflight','bundles','cli','platforms','native'])await cp(path.join(root,`manager/pawtalk_manager/${name}.py`),path.join(stage,`bootstrap/manager/pawtalk_manager/${name}.py`));
for(const file of ['LICENSE','THIRD_PARTY_NOTICES.md'])await cp(path.join(root,file),path.join(stage,file));
if(nativeGo){
 const goRoot=execFileSync(go,['env','GOROOT'],{encoding:'utf8',windowsHide:true}).trim();
 const modCache=execFileSync(go,['env','GOMODCACHE'],{encoding:'utf8',windowsHide:true}).trim();
 await cp(path.join(goRoot,'LICENSE'),path.join(stage,'GO-LICENSE'));
 await cp(path.join(modCache,'golang.org/x/sys@v0.49.0/LICENSE'),path.join(stage,'X-SYS-LICENSE'));
}
// The Go module cache marks files read-only; only its notice bytes belong in the
// installer. Keep the copied notice removable during explicit maintenance/QA.
await chmod(path.join(stage,'X-SYS-LICENSE'),0o644);
const version=(await readFile(path.join(root,'manager/VERSION'),'utf8')).trim();
if(!runtimeOnly){
// The new UI is bundled with the installer; the server/maintenance host remains Go.
const desktopPackage=JSON.parse(await readFile(path.join(root,'manager/desktop/package.json'),'utf8'));
if(desktopPackage.version!==version)throw Error('Manager desktop/VERSION mismatch');
run(process.execPath,['node_modules/typescript/bin/tsc','-p','manager/desktop/tsconfig.json']);
run(process.execPath,['node_modules/vite/bin/vite.js','build','--config','manager/desktop/vite.config.mjs']);
const iconEnv={...process.env};delete iconEnv.ELECTRON_RUN_AS_NODE;
execFileSync(createRequire(import.meta.url)('electron'),['scripts/manager-icons.cjs'],{cwd:root,stdio:'inherit',windowsHide:true,env:iconEnv});
run(process.execPath,['node_modules/electron-builder/cli.js','--config','manager/desktop/electron-builder.cjs','--win','dir','--x64','--publish','never']);
await cp(path.join(root,'release/manager-desktop/win-unpacked'),path.join(stage,'desktop'),{recursive:true});
await writeFile(path.join(stage,'desktop-version.json'),JSON.stringify({version})+'\n');
}
if(runtimeOnly){
 console.log('Windows Manager test host/runtime prepared; no installer built.');
 process.exit(0);
}
const {getMakeNsisPath}=createRequire(import.meta.url)('app-builder-lib/out/toolsets/windows.js');
const makensis=process.env.PAWTALK_MAKENSIS?{path:process.env.PAWTALK_MAKENSIS}:await getMakeNsisPath();
execFileSync(makensis.path,['/INPUTCHARSET','UTF8',`/DVERSION=${version}`,`/DSTAGE=${stage}`,`/DOUTPUT=${path.join(output,`PawTalk.Server.Manager.Setup.${version}.exe`)}`,path.join(root,'manager/windows/installer.nsi')],{cwd:root,stdio:'inherit',windowsHide:true,env:{...process.env,...makensis.env}});
console.log('Windows Manager installer built; no publication performed.');
