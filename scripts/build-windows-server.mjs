// Package the same Windows core used by temporary Client rooms.
import {cp,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { serverDefinition, buildWindowsServer } from './server-core.mjs';
const root=path.resolve(import.meta.dirname,'..');
if(process.platform!=='win32')throw Error('Build Windows artifacts on Windows');
const definition=await serverDefinition();
const version=definition.version;
const output=path.join(root,'release/server');await mkdir(output,{recursive:true});
const stage=await mkdtemp(path.join(os.tmpdir(),'pawtalk-server-package-'));
const run=(cmd,args,cwd=root)=>execFileSync(cmd,args,{cwd,stdio:'inherit',windowsHide:true});
try{
 const mediaVersion=definition.livekitVersion;
 const actual=execFileSync(path.join(root,'resources/server/livekit-server.exe'),['--version'],{encoding:'utf8',windowsHide:true});
 if(!mediaVersion||!actual.includes(`version ${mediaVersion}`))throw Error('Windows and Linux Server LiveKit versions must match');
 await buildWindowsServer(path.join(stage,'pawtalk-server.exe'));
 for(const [from,to] of [['resources/server/livekit-server.exe','livekit-server.exe'],['resources/server/LIVEKIT-LICENSE','LIVEKIT-LICENSE'],['resources/server/GO-LICENSE','GO-LICENSE'],['licenses/go-runtime.txt','GO-DEPENDENCIES-LICENSE'],['LICENSE','LICENSE'],['THIRD_PARTY_NOTICES.md','THIRD_PARTY_NOTICES.md']])await cp(path.join(root,from),path.join(stage,to));
 const file=path.join(output,`PawTalk.Server.${version}.windows-x64.zip`);
 // Windows bsdtar creates a ZIP explicitly; no shell interpolation of paths.
 run('tar.exe',['-a','-cf',file,'-C',stage,'pawtalk-server.exe','livekit-server.exe','LICENSE','THIRD_PARTY_NOTICES.md','GO-LICENSE','LIVEKIT-LICENSE','GO-DEPENDENCIES-LICENSE']);
 console.log('Permanent Windows Server built:',file);
}finally{await rm(stage,{recursive:true,force:true});}
