import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);const server=await createServer({server:{host:'127.0.0.1',port:5187,strictPort:true}});await server.listen();
const env={...process.env,VOICECORD_UI_TEST_URL:'http://127.0.0.1:5187'};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),['tests/realtime.cjs'],{env,windowsHide:true,stdio:'inherit'});
child.on('exit',async code=>{await server.close();process.exit(code||0);});child.on('error',async e=>{console.error(e);await server.close();process.exit(1);});
