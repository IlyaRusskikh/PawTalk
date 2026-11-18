// Package the same Windows core used by temporary Client rooms.
import {cp,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { serverDefinition, buildWindowsServer } from '../../../tooling/build/server-core.mjs';
const root=path.resolve(import.meta.dirname,'../../..');
if(process.platform!=='win32')throw Error('Build Windows artifacts on Windows');
const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--output-dir'))throw Error('Supported option: --output-dir <release subdirectory>');
const definition=await serverDefinition();
const version=definition.version;
const output=path.resolve(args[1]||path.join(root,'release/server'));
const releaseRelative=path.relative(path.join(root,'release'),output);
if(releaseRelative.startsWith('..')||path.isAbsolute(releaseRelative))throw Error('Server build output must stay inside release/');
await mkdir(output,{recursive:true});
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
 run(process.execPath,['tooling/build/package-local-server.mjs','--archive',file]);
}finally{if(path.dirname(stage)!==path.resolve(os.tmpdir())||!path.basename(stage).startsWith('pawtalk-server-package-'))throw Error('Unsafe Server package cleanup path');await rm(stage,{recursive:true,force:true});}
