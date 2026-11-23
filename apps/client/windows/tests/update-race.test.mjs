import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {downloadFastest}=createRequire(import.meta.url)('../electron/update-race.cjs');
const bytes=Buffer.alloc(65536,42),manifest={version:'1.0.0',name:'test.exe',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};

async function fixture(run){
 const directory=await mkdtemp(path.join(tmpdir(),'pawtalk-race-')),requests=[],closed=new Set();
 const server=http.createServer((req,res)=>{
  const source=req.url.split('/')[1];requests.push(source);let offset=0;
  const tick=()=>{if(source==='stalled'||source==='bursty'&&offset>=8192)return;const count=['fast','corrupt','bursty'].includes(source)?4096:256;
   if(offset===bytes.length){res.end();return;}const chunk=Buffer.from(bytes.subarray(offset,offset+count));offset+=chunk.length;
   if(source==='corrupt')chunk[0]^=1;res.write(chunk);
  };
  const timer=setInterval(tick,['fast','corrupt','bursty'].includes(source)?2:15);tick();
  res.on('close',()=>{clearInterval(timer);closed.add(source);});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`,partial=path.join(directory,'installer.part');
 const options={manifest,tag:'client-v1.0.0',partial,policy:{sampleMs:70,sampleBytes:8192,headerMs:100,idleMs:120,windowMs:1000,totalMs:5000},
  fetchFor:source=>(url,init)=>fetch(source?url:base+'/github/file',init),rooms:[],onProgress(){}};
 try{await run({options,partial,base,requests,closed});}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
}
test('fastest room wins measured race, its existing stream continues and losers close',()=>fixture(async({options,partial,base,requests,closed})=>{
 let selected;
 await downloadFastest({...options,rooms:['slow','fast'].map(name=>({name,prepare:async()=>({base:base+'/'+name})})),onProgress:(_progress,source)=>selected=source});
 assert.equal(selected,'fast');assert.deepEqual(await readFile(partial),bytes);
 assert.equal(requests.filter(s=>s==='fast').length,1,'sample is retained without another download');
 await new Promise(resolve=>setTimeout(resolve,50));assert.ok(closed.has('github'));assert.ok(closed.has('slow'));
}));
test('stalled direct source and unavailable rooms do not block a healthy stream',()=>fixture(async({options,partial,base})=>{
 await downloadFastest({...options,fetchFor:source=>(url,init)=>fetch(source?url:base+'/stalled/file',init),rooms:[
  {name:'offline',prepare:async()=>{throw Error('offline');}},
  {name:'fast',prepare:async()=>({base:base+'/fast'})},
 ]});assert.deepEqual(await readFile(partial),bytes);
}));
test('a corrupt fastest stream fails closed and never falls back to valid slower bytes',()=>fixture(async({options,base})=>{
 await assert.rejects(downloadFastest({...options,rooms:[{name:'corrupt',prepare:async()=>({base:base+'/corrupt'})}]}),{code:'UPDATE_SECURITY',source:'corrupt'});
}));
test('a small complete GitHub artifact does not open mirror connections',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'pawtalk-small-'));let prepared=false;
 try{await downloadFastest({manifest,tag:'v1.0.0',partial:path.join(directory,'part'),fetchFor:()=>async()=>new Response(bytes),
  rooms:[{prepare:async()=>{prepared=true;}}],onProgress(){}});assert.equal(prepared,false);}
 finally{await rm(directory,{recursive:true,force:true});}
});
test('a source that stalls after winning is excluded and remaining sources are measured again',()=>fixture(async({options,partial,base,requests})=>{
 const selected=[];
 await downloadFastest({...options,policy:{...options.policy,minBytesPerSecond:1,sampleMs:200,headerMs:1000,idleMs:1000,totalMs:15000},
  fetchFor:source=>(url,init)=>fetch(source?url:base+'/bursty/file',init),
  rooms:[{name:'slow',prepare:async()=>({base:base+'/slow'})}],onProgress:(_progress,source)=>selected.push(source)});
 assert.equal(selected[0],'GitHub');assert.equal(selected.at(-1),'slow');assert.equal(requests.filter(s=>s==='bursty').length,1);
 assert.equal(requests.filter(s=>s==='slow').length,2);assert.deepEqual(await readFile(partial),bytes);
}));
