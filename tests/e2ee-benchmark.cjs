const {app,BrowserWindow,session}=require('electron');
const assert=require('node:assert/strict');
const {randomBytes,createHash,X509Certificate}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const https=require('node:https');
const path=require('node:path');
const os=require('node:os');
const fs=require('node:fs/promises');
const {SelfHost}=require('../electron/selfhost.cjs');
const {invitation}=require('../electron/address.cjs');
app.setPath('userData',path.join(os.tmpdir(),'pawtalk-e2ee-electron-'+process.pid));
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture',process.env.PAWTALK_BENCH_WAV);
app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{}); // Trials intentionally destroy and recreate all windows.
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const name='pawtalk-e2ee-bench-'+process.pid, volume=name+'-data';
const password=randomBytes(18).toString('hex'), key=randomBytes(32).toString('hex');
const keyID=createHash('sha256').update(Buffer.from(key,'hex')).digest('hex');
const seconds=Number(process.argv.find(a=>a.startsWith('--seconds='))?.split('=')[1]||24);
const securityOnly=process.argv.includes('--security-only');
const latencyTest=process.argv.includes('--latency');
const noiseModes=process.argv.includes('--quick')||process.env.PAWTALK_BENCH_SOURCE==='synthetic tones'?['off']:['rnnoise','off'];
const docker=(args,input)=>execFileSync('docker',args,{encoding:'utf8',input,windowsHide:true,stdio:['pipe','pipe','pipe']}).trim();
let host,windows=[],currentPin,currentPort;
const js=(win,source)=>win.webContents.executeJavaScript(source,true);
async function until(fn,label,ms=25000) { for(const end=Date.now()+ms;Date.now()<end;){if(await fn())return;await delay(100);} throw Error('Timeout: '+label); }
function request(body,endpoint='/api/connect') {
 return new Promise((resolve,reject)=>{
  const req=https.request(`https://127.0.0.1:${currentPort}${endpoint}`,{method:body?'POST':'GET',rejectUnauthorized:false,agent:false,headers:{'Content-Type':'application/json'}},res=>{
   let text='';res.on('data',d=>text+=d);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(text)});}catch(e){reject(e);}});
  });
  req.on('socket',socket=>socket.once('secureConnect',()=>{
   const actual=new X509Certificate(socket.getPeerCertificate().raw).fingerprint256.replaceAll(':','').toLowerCase();
   if(actual!==currentPin)req.destroy(Error('Certificate pin mismatch'));
  }));
  req.setTimeout(5000,()=>req.destroy(Error('HTTPS timeout')));req.on('error',reject);req.end(body&&JSON.stringify(body));
 });
}
async function server(encrypted,transport='container') {
 await closeWindows();
 if(host){await host.stop();host=null;}
 try{docker(['rm','-f',name]);}catch{}
 if(transport==='embedded') {
  host=new SelfHost(path.resolve('resources/server'));
  const state=await host.start({password,port:33443,name:'E2EE QA',e2ee:encrypted});
  const invite=invitation(state.localAddress); currentPin=invite.fingerprint;currentPort=33443;
  return invite.e2eeKey;
 }
 currentPort=32443;
 docker(['run','-d','--name',name,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges:true','--tmpfs','/tmp:uid=65532,gid=65532,mode=0700','-v',volume+':/data','-e','PAWTALK_PUBLIC_IP=127.0.0.1','-e','PAWTALK_PORT=32443','-e','PAWTALK_E2EE='+encrypted,'-e','PAWTALK_E2EE_KEY_ID='+(encrypted?keyID:''),'-p','127.0.0.1:32443:32443','-p','127.0.0.1:32444:32444','-p','127.0.0.1:32445:32445/udp','pawtalk-server:local']);
 await until(()=>{try{currentPin=docker(['exec',name,'/pawtalk','serve','info']).split('/').at(-1);return !!currentPin;}catch{return false;}},'container state');
 docker(['exec','-i',name,'/pawtalk','serve','reset-password'],password);
 docker(['restart',name]);
 await until(async()=>{try{return(await request(null,'/healthz')).status===200;}catch{return false;}},'container readiness');
 return encrypted?key:null;
}
async function credentials(mediaKey,nickname='QA') {
 const body={nickname,password,...(mediaKey?{e2ee:true,e2eeKeyId:createHash('sha256').update(Buffer.from(mediaKey,'hex')).digest('hex')}:{})};
 const response=await request(body);assert.equal(response.status,200,JSON.stringify(response.body));
 return {...response.body,...(mediaKey?{e2eeKey:mediaKey}:{})};
}
async function client(data,noise='off',plaintext=false,jitter,shared) {
 const partition=session.fromPartition('e2ee-'+randomBytes(8).toString('hex'));
 partition.setPermissionRequestHandler((_w,_p,cb)=>cb(true));partition.setPermissionCheckHandler(()=>true);
 partition.setCertificateVerifyProc((req,cb)=>{
  const actual=new X509Certificate(req.certificate.data).fingerprint256.replaceAll(':','').toLowerCase();
  cb(req.hostname==='127.0.0.1'?(actual===currentPin?0:-2):-3);
 });
 const win=new BrowserWindow({show:false,webPreferences:{offscreen:true,session:partition,sandbox:true,backgroundThrottling:false}});
 windows.push(win);
 win.webContents.on('console-message',event=>{if(event.level==='error'&&!/failed to fetch|server returned|decrypt/i.test(event.message))console.error('renderer:',event.message);});
 await win.loadURL('http://127.0.0.1:5194/tests/e2ee-bench.html?noise='+noise+(jitter!==undefined?'&jitter='+jitter:'')+(shared!==undefined?'&shared='+shared:''));
 await until(()=>js(win,'window.ready===true'),'fixture ready');
 await js(win,`window.${plaintext?'startPlain':'start'}(${JSON.stringify(data)})`);
 return win;
}
async function closeWindows() {
 for(const win of windows){if(!win.isDestroyed()){try{await js(win,'Promise.all([window.voice.disconnect(),window.plain?.disconnect()]).then(()=>window.plainStream?.getTracks().forEach(t=>t.stop()))');}catch{}win.destroy();}}
 windows=[];await delay(300);
}
async function pair(a,b) {
 await until(async()=>await js(a,'window.snapshot.people.length===2')&&await js(b,'window.snapshot.people.length===2'),'participants');
 await until(async()=>await js(a,'window.energy()')>1e-8&&await js(b,'window.energy()')>1e-8,'bidirectional decoded audio');
}
async function security(transport) {
 const mediaKey=await server(true,transport);
 assert.equal((await request({nickname:'Legacy',password})).status,426);
 const badKey=randomBytes(32).toString('hex');
 assert.equal((await request({nickname:'Wrong key',password,e2ee:true,e2eeKeyId:createHash('sha256').update(Buffer.from(badKey,'hex')).digest('hex')})).status,403);
 const ca=await credentials(mediaKey,'A'),cb=await credentials(mediaKey,'B');
 let a=await client(ca),b=await client(cb);await pair(a,b);
 assert.equal(await js(a,'window.voice.room.isE2EEEnabled'),true);
 assert.equal(await js(b,'[...window.voice.room.remoteParticipants.values()][0].audioTrackPublications.values().next().value.isEncrypted'),true);
 await js(b,'window.voice.disconnect()');
 await js(b,`window.start(${JSON.stringify(cb)})`);await pair(a,b);
 console.log('PASS '+transport+': required E2EE, key commitment, encrypted bidirectional audio, reconnect');
 await closeWindows();
 // Possession of a valid token alone must not enable decryption.
 a=await client(ca);b=await client({...cb,e2eeKey:badKey});
 await until(async()=>!!await js(a,'window.lastError')||!!await js(b,'window.lastError'),'wrong key detected');
 assert.equal(await js(b,'window.energy()'),0);
 console.log('PASS '+transport+': wrong decryption key fails closed');
 await closeWindows();
 // Modified client lies to API but publishes plaintext; protected peer rejects it.
 a=await client(ca);b=await client({...cb,e2eeRequired:false,e2eeKey:undefined},'off',true);
 await until(()=>js(a,'window.lastError.includes("незашифрованную") || window.lastError.includes("без E2EE")'),'plaintext rejection');
 assert.equal(await js(a,'window.energy()'),0);
 console.log('PASS '+transport+': plaintext publication rejected before playback');
 await closeWindows();
}
const quantile=(values,q)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))];};
function latency(source,received) {
 const step=128/48,offsetA=(source.offset+source.offsetEnd)/2,offsetB=(received.offset+received.offsetEnd)/2;
 const anchor=source.frames[0][0]+offsetA;
 const toGrid=(tap,offset)=>{
  const grid=new Map();for(const [time,rms]of tap.frames)grid.set(Math.round((time+offset-anchor)/step),Math.sqrt(rms));return grid;
 };
 const a=toGrid(source,offsetA),b=toGrid(received,offsetB),samples=750,estimates=[];
 for(let start=0;start+samples<source.frames.length;start+=samples){
  let best={correlation:-1,delay:0};
  for(let lag=0;lag<=188;lag++){
   let n=0,sx=0,sy=0,sxx=0,syy=0,sxy=0;
   for(let i=start;i<start+samples;i++){
    const x=a.get(i),y=b.get(i+lag);if(x===undefined||y===undefined)continue;
    n++;sx+=x;sy+=y;sxx+=x*x;syy+=y*y;sxy+=x*y;
   }
   if(n<samples*.9)continue;
   const denominator=Math.sqrt((n*sxx-sx*sx)*(n*syy-sy*sy));
   const correlation=denominator>1e-8?(n*sxy-sx*sy)/denominator:0;
   if(correlation>best.correlation)best={correlation,delay:lag*step};
  }
  if(best.correlation>=.5)estimates.push(best);
 }
 assert.ok(estimates.length>=3,`Too few correlated audio windows: ${estimates.length}`);
 return estimates;
}
function cpuSnapshot(){return app.getAppMetrics().map(p=>({pid:p.pid,type:p.type,cpu:p.cpu.cumulativeCPUUsage}));}
function cpuDelta(before,after,ms,ids) {
 let seconds=0;
 for(const p of after){if(ids&&!ids.includes(p.pid))continue;const prev=before.find(v=>v.pid===p.pid);assert.ok(typeof p.cpu==='number','Cumulative CPU metric unavailable');if(prev)seconds+=p.cpu-prev.cpu;}
 return seconds*100000/ms; // 100% = one logical CPU, summed across processes/threads.
}
async function trial(encrypted,noise,index,jitter,shared) {
 const mediaKey=await server(encrypted);
 const a=await client(await credentials(mediaKey,'A'),noise,false,jitter,shared),b=await client(await credentials(mediaKey,'B'),noise,false,jitter,shared);
 await pair(a,b);await delay(6000);
 await Promise.all([js(a,'window.beginMeasure()'),js(b,'window.beginMeasure()')]);
 const statsBefore=await Promise.all([js(a,'window.receiverStats()'),js(b,'window.receiverStats()')]);
 const before=cpuSnapshot(),started=performance.now();
 await delay(seconds*1000);
 const elapsed=performance.now()-started,after=cpuSnapshot();
 const [ta,tb]=await Promise.all([js(a,'window.endMeasure()'),js(b,'window.endMeasure()')]);
 const statsAfter=await Promise.all([js(a,'window.receiverStats()'),js(b,'window.receiverStats()')]);
 const receiver=statsAfter.map((s,i)=>{
  const prior=statsBefore[i].inbound,now=s.inbound;
  const emitted=now.jitterBufferEmittedCount-prior.jitterBufferEmittedCount;
  const samples=now.totalSamplesReceived-prior.totalSamplesReceived;
  return {hintMs:s.hintMs,jitterBufferMs:1000*(now.jitterBufferDelay-prior.jitterBufferDelay)/emitted,targetMs:1000*(now.jitterBufferTargetDelay-prior.jitterBufferTargetDelay)/emitted,concealedPercent:100*(now.concealedSamples-prior.concealedSamples)/samples,packetsLost:now.packetsLost-prior.packetsLost,candidates:s.candidates,pair:s.pair};
 });
 const matches=[...latency(ta[0],tb[1]),...latency(tb[0],ta[1])],deltas=matches.map(m=>m.delay);
 const pids=[a,b].map(w=>w.webContents.getOSProcessId());
 const result={encrypted,noise,index,jitter,shared,receiver,microphoneMs:[quantile(latency(ta[0],ta[2]).map(m=>m.delay),.5),quantile(latency(tb[0],tb[2]).map(m=>m.delay),.5)],seconds:elapsed/1000,clientRendererCPU:pids.map(id=>cpuDelta(before,after,elapsed,[id])),electronTotalCPU:cpuDelta(before,after,elapsed),latencyP50:quantile(deltas,.5),latencyP95:quantile(deltas,.95),windowCount:deltas.length,correlations:matches.map(m=>m.correlation),clockOffsetDriftMs:[...ta,...tb].map(t=>t.offsetEnd-t.offset),latencies:deltas};
 if(!result.clockOffsetDriftMs.every(n=>Math.abs(n)<15)) {
  await fs.mkdir(path.resolve('release/qa'),{recursive:true});await fs.writeFile(path.resolve('release/qa/e2ee-clock-debug.json'),JSON.stringify({result,ta,tb}));
  throw Error('Audio clocks drifted too far: '+result.clockOffsetDriftMs.join(', '));
 }
 console.log(`TRIAL ${noise} E2EE=${encrypted}: renderer CPU ${result.clientRendererCPU.map(n=>n.toFixed(2)).join('/')}% of one core; software audio latency p50=${result.latencyP50.toFixed(1)}ms p95=${result.latencyP95.toFixed(1)}ms (${deltas.length} correlated windows)`);
 if(latencyTest)console.log('STAGES '+JSON.stringify({jitter,microphoneMs:result.microphoneMs,receiver:receiver.map(({jitterBufferMs,targetMs,concealedPercent,packetsLost,hintMs})=>({jitterBufferMs,targetMs,concealedPercent,packetsLost,hintMs}))}));
 await closeWindows();return result;
}
app.whenReady().then(async()=>{
 const report={date:new Date().toISOString(),platform:process.platform,cpus:os.cpus().length,cpuModel:os.cpus()[0].model,versions:process.versions,source:process.env.PAWTALK_BENCH_SOURCE,secondsPerTrial:seconds,notes:['Two simultaneous clients on one Windows computer; Linux LiveKit in Docker Desktop.','CPU 100% = one logical core. Renderer CPU includes its E2EE worker; total includes main/audio/GPU utility processes for both clients.','Latency: fake microphone speech capture tap to remote decoded playback gain tap, AudioContext output timestamp calibration. Excludes physical microphone/speaker and internet propagation.','Envelope cross-correlation in non-overlapping two-second windows, lag search 0..501 ms; minimum Pearson correlation 0.5. Resolution 128/48000 seconds (~2.67 ms). Small differences within jitter/resolution are inconclusive.','ABBA order per noise mode; six-second warmup plus 1.5-second meter clock warmup; no gaming load.','LiveKit disables audio RED for E2EE; the comparison measures the complete negotiated modes, not an isolated AES microbenchmark.'],security:[],trials:[]};
 try {
  if(!process.argv.includes('--skip-security')) {
   await security('container');report.security.push('container passed');
   await security('embedded');report.security.push('embedded passed');
  }
  const reportFile=path.resolve('release/qa',latencyTest?'latency-benchmark.json':securityOnly?'e2ee-security.json':'e2ee-benchmark.json');
  if(latencyTest) {
   if(process.argv.includes('--contexts')) {
    for(const [index,shared]of [false,true,true,false].entries()){
     report.trials.push(await trial(true,'rnnoise',index,'auto',shared));
     await fs.mkdir(path.resolve('release/qa'),{recursive:true});await fs.writeFile(reportFile,JSON.stringify(report,null,2));
    }
   } else {
   const targets=process.argv.includes('--probe')?['auto',20,0]:['auto',20,20,'auto'];
   for(const [index,target]of targets.entries()){
    report.trials.push(await trial(true,'rnnoise',index,target));
    await fs.mkdir(path.resolve('release/qa'),{recursive:true});await fs.writeFile(reportFile,JSON.stringify(report,null,2));
   }
   }
  }
  else if(!securityOnly)for(const noise of noiseModes)for(const [index,encrypted]of [false,true,true,false].entries()){
   report.trials.push(await trial(encrypted,noise,index));
   await fs.mkdir(path.resolve('release/qa'),{recursive:true});await fs.writeFile(reportFile,JSON.stringify(report,null,2));
  }
  await fs.mkdir(path.resolve('release/qa'),{recursive:true});await fs.writeFile(reportFile,JSON.stringify(report,null,2));
  console.log('PASS checks; report '+path.relative(process.cwd(),reportFile));
 }catch(error){console.error(error);app.exitCode=1;}
 finally {
  await closeWindows();if(host)await host.stop();try{docker(['rm','-f',name]);}catch{}try{docker(['volume','rm',volume]);}catch{}
  app.exit(app.exitCode||0);
 }
});
