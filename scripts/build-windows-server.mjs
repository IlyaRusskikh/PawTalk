// Build the permanent Server from the working tree; temporary Client rooms stay pinned.
import {cp,mkdir,readFile,mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const root=path.resolve(import.meta.dirname,'..');
if(process.platform!=='win32')throw Error('Build Windows artifacts on Windows');
const version=(await readFile(path.join(root,'server/VERSION'),'utf8')).trim();
const output=path.join(root,'release/server');await mkdir(output,{recursive:true});
const stage=await mkdtemp(path.join(os.tmpdir(),'pawtalk-server-package-'));
const run=(cmd,args,cwd=root)=>execFileSync(cmd,args,{cwd,stdio:'inherit',windowsHide:true});
try{
 const go=process.env.PAWTALK_GO||'go';
 const definition=await readFile(path.join(root,'server/standalone.Dockerfile'),'utf8');
 const mediaVersion=definition.match(/FROM livekit\/livekit-server:v(\d+\.\d+\.\d+)/)?.[1];
 const actual=execFileSync(path.join(root,'resources/server/livekit-server.exe'),['--version'],{encoding:'utf8',windowsHide:true});
 if(!mediaVersion||!actual.includes(`version ${mediaVersion}`))throw Error('Windows and Linux Server LiveKit versions must match');
 run(go,['build','-trimpath','-o',path.join(stage,'pawtalk-server.exe'),'.'],path.join(root,'server'));
 for(const [from,to] of [['resources/server/livekit-server.exe','livekit-server.exe'],['resources/server/LIVEKIT-LICENSE','LIVEKIT-LICENSE'],['resources/server/GO-LICENSE','GO-LICENSE'],['licenses/go-runtime.txt','GO-DEPENDENCIES-LICENSE'],['LICENSE','LICENSE'],['THIRD_PARTY_NOTICES.md','THIRD_PARTY_NOTICES.md']])await cp(path.join(root,from),path.join(stage,to));
 const file=path.join(output,`PawTalk.Server.${version}.windows-x64.zip`);
 // Windows bsdtar creates a ZIP explicitly; no shell interpolation of paths.
 run('tar.exe',['-a','-cf',file,'-C',stage,'pawtalk-server.exe','livekit-server.exe','LICENSE','THIRD_PARTY_NOTICES.md','GO-LICENSE','LIVEKIT-LICENSE','GO-DEPENDENCIES-LICENSE']);
 console.log('Permanent Windows Server built:',file);
}finally{await rm(stage,{recursive:true,force:true});}
