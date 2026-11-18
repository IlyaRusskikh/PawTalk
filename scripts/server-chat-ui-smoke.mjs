import {createServer} from 'vite';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const server=await createServer({server:{host:'127.0.0.1',port:0}});await server.listen();
const env={...process.env,PAWTALK_UI_TEST_URL:`http://127.0.0.1:${server.httpServer.address().port}`};delete env.ELECTRON_RUN_AS_NODE;
try{for(const script of process.argv[2]?[process.argv[2]]:['tests/server-chat-ui.cjs','tests/chat-extras-ui.cjs','tests/live-delivery-ui.cjs','tests/pending-message-ui.cjs','tests/send-stability-ui.cjs','tests/history-cache-ui.cjs']){const code=await new Promise((resolve,reject)=>{const child=spawn(createRequire(import.meta.url)('electron'),[script],{env,windowsHide:true,stdio:'inherit'});child.once('error',reject);child.once('exit',resolve);});if(code){process.exitCode=Number(code);break;}}}finally{await server.close();}
