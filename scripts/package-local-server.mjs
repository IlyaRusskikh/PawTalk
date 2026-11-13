// Create a portable Windows Server package locally; never publish or sign it.
import {mkdtemp,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--archive','--manifest'].includes(args[i])||!args[i+1])throw Error('Use --archive <Windows Server ZIP> [--manifest <server-manifest.json>]');options[args[i]]=path.resolve(args[i+1]);}
if(!options['--archive'])throw Error('--archive is required');
const archive=options['--archive'];
const match=/^PawTalk\.Server\.(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.windows-x64\.zip$/.exec(path.basename(archive));
if(!match)throw Error('Expected PawTalk.Server.X.Y.Z.windows-x64.zip');
const bytes=await readFile(archive);
const directory=await mkdtemp(path.join(os.tmpdir(),'pawtalk-local-package-'));
try{
 await copyFile(archive,path.join(directory,'server.zip'));
 await writeFile(path.join(directory,'package.json'),JSON.stringify({format:'pawtalk-server-package-v1',version:match[1],apiProtocol:1,dataSchema:1,sha256:createHash('sha256').update(bytes).digest('hex')})+'\n');
 const files=['package.json','server.zip'];
 if(options['--manifest']){await copyFile(options['--manifest'],path.join(directory,'server-manifest.json'));files.push('server-manifest.json');}
 const output=path.join(path.dirname(archive),`PawTalk.Server.${match[1]}.pawtalk-server.zip`);
 execFileSync('tar.exe',['-a','-cf',output,'-C',directory,...files],{windowsHide:true,stdio:'inherit'});
 console.log('Local Server package prepared:',output);
}finally{
 if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('pawtalk-local-package-'))throw Error('Unsafe package cleanup path');
 await rm(directory,{recursive:true,force:true});
}
