// Real ephemeral core and encrypted API 2 history, without renderer/storage mocks.
const assert=require('node:assert/strict'),https=require('node:https'),path=require('node:path'),os=require('node:os'),fs=require('node:fs/promises');
const {spawnSync}=require('node:child_process');
const {SelfHost,checkPorts}=require('../electron/selfhost.cjs');
const {invitation}=require('../electron/address.cjs');
const host=new SelfHost(path.resolve('resources/server'));
function get(address,endpoint){const room=invitation(address);return new Promise((resolve,reject)=>{
 const request=https.get(room.origin+endpoint,{rejectUnauthorized:false,agent:false},response=>{const parts=[];response.on('data',data=>parts.push(data));response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(parts))}));});
 request.once('socket',socket=>socket.once('secureConnect',()=>{const pin=socket.getPeerCertificate().fingerprint256.replaceAll(':','').toLowerCase();if(pin!==room.fingerprint)request.destroy(Error('TLS pin mismatch'));}));request.once('error',reject);
});}
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pawtalk-selfhost-api2-'));let previous;
 try{
  for(let round=0;round<2;round++){
   let port;for(let attempt=0;attempt<100;attempt++){const candidate=22000+Math.floor(Math.random()*8000);try{await checkPorts(candidate);port=candidate;break;}catch{}}
   assert.ok(port);const status=await host.start({port,name:'Synthetic ephemeral server'});
   assert.equal(status.e2ee,true);assert.notEqual(status.serverId,previous,'new selfhost inherited old membership');previous=status.serverId;
   assert.equal((await get(status.localAddress,'/api/v2/state')).status,401);
   assert.equal((await get(status.localAddress,'/api/presence')).status,426);
   assert.equal((await get(status.localAddress,'/api/config')).body.e2eeRequired,true);
   const result=spawnSync(process.execPath,['apps/client/windows/tests/membership-host-client.cjs','join',directory,host.bootstrapAddress],{encoding:'utf8',windowsHide:true});
   assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS real API 2/);
   assert.ok(!JSON.stringify(status).includes('#'),'public host status leaked admission');
   await host.stop();assert.equal(host.status().running,false);
  }
  console.log('PASS ephemeral API 2 core: private bootstrap, mandatory E2EE, anonymous privacy, encrypted history and fresh identity on recreation');
 }finally{await host.stop();assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
