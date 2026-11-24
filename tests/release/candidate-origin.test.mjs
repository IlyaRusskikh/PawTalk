import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { sourceRunId, sourceCandidate, verifyRun, downloadArtifact, confirmSource, reuseStepName } from '../../tooling/release/candidate-origin.mjs';
import { notesDigest } from '../../tooling/ci/check-release-notes.mjs';
import { absent, binding, createTags, publishAssets, assetNames } from '../../tooling/release/release-candidate.mjs';
import { inspectPR, importPR } from '../../tooling/release/pr-candidate.mjs';
const sha='a'.repeat(40), workflow={id:42,path:'.github/workflows/release.yml'};
const hash = b=>createHash('sha256').update(b).digest('hex');
const clone = value=>structuredClone(value);
const require=createRequire(import.meta.url),yaml=createRequire(require.resolve('app-builder-lib/package.json'))('js-yaml');
const load=async name=>yaml.load(await readFile(new URL('../../.github/workflows/'+name+'.yml',import.meta.url),'utf8'));
const checkJobs=(await load('check')).jobs;
const verificationNames=Object.entries(checkJobs).flatMap(([id,job])=>{
  const runners=job.strategy?.matrix?.runner;
  return runners ? runners.map(runner=>job.name.replace('${{ matrix.runner }}',runner)) : [job.name || id];
});
function fixture(components=['client','server','manager'], attempt=1) {
  const source={id:123,workflow_id:42,path:workflow.path,name:'Release Candidate Preflight',repository:{id:7,full_name:'IlyaRusskikh/PawTalk'},head_repository:{id:7,full_name:'IlyaRusskikh/PawTalk'},event:'workflow_dispatch',head_branch:'main',head_sha:sha,run_attempt:attempt,status:'completed',conclusion:'success'};
  const jobs=[];
  const add=(name,conclusion='success')=>jobs.push({id:jobs.length+1,name,run_id:123,run_attempt:attempt,head_sha:sha,status:'completed',conclusion,started_at:'2026-01-01T00:00:00Z',completed_at:'2026-01-01T01:00:00Z'});
  for (const name of ['plan','infrastructure','preflight','report']) add(name);
  add('tag','skipped');
  for (const c of ['client','server','manager']) {
    add('prepare-'+c,components.includes(c)?'success':'skipped');add('publish-'+c,'skipped');
    if (components.includes(c)) for (const name of verificationNames) add(`verify (${c}) / ${name}`,name==='infrastructure'?'skipped':'success');
  }
  const index={schema:1,workflow:workflow.path,repository:source.repository.full_name,sha,run:'123',attempt:String(attempt),components,
    plans:Object.fromEntries(components.map(c=>[c,{repository:source.repository.full_name,sha,run:'123',attempt:String(attempt),component:c,version:'1.2.3',channel:'preview',tag:c+'-v1.2.3'}])),receipts:Object.fromEntries(components.map(c=>[c,'b'.repeat(64)]))};
  const artifacts=['pawtalk-candidate-index',...components.map(c=>'pawtalk-'+c+'-prepared')].map((name,i)=>({id:100+i,name,digest:'sha256:'+'c'.repeat(64),expired:false,created_at:'2026-01-01T00:30:00Z',expires_at:'2099-01-01T00:00:00Z',workflow_run:{id:123,head_sha:sha,head_branch:'main',repository_id:7,head_repository_id:7}}));
  const calls=[];
  const api=async endpoint=>{
    calls.push(endpoint);
    if (endpoint==='actions/runs/123') return clone(source);
    if (endpoint==='actions/workflows/release.yml') return clone(workflow);
    if (endpoint.startsWith(`actions/runs/123/attempts/${attempt}/jobs?`)) return {total_count:jobs.length,jobs:clone(jobs)};
    if (endpoint.startsWith('actions/runs/123/artifacts?')) return {total_count:artifacts.length,artifacts:clone(artifacts)};
    throw Error('Unexpected API endpoint '+endpoint);
  };
  return {source,jobs,index,artifacts,api,calls,load:pinned=>sourceCandidate(api,'123',sha,async()=>clone(index),pinned)};
}

test('valid API evidence selects the full original set, pins artifact IDs/digests and preserves source attempt', async()=>{
  for (const components of [['client'],['client','server'],['server','manager'],['client','server','manager']]) for (const attempt of [1,2]) {
    const f=fixture(components,attempt), result=await f.load();
    assert.deepEqual(result.index.components,components);
    assert.equal(result.origin.attempt,String(attempt));
    assert.equal(result.origin.run,'123');
    await f.load(result.origin);
    await confirmSource(f.api,result.origin);
    assert.ok(f.calls.some(p=>p.includes(`/attempts/${attempt}/jobs`)));
    assert.deepEqual(Object.keys(result.prepared),components);
    const receipt={...result.index.plans[components[0]],files:{}};
    binding(receipt,result.index.plans[components[0]],hash(Buffer.from(JSON.stringify(receipt)+'\n')));
    assert.throws(()=>binding(receipt,{...receipt,run:'456'},hash(Buffer.from(JSON.stringify(receipt)+'\n'))),/run mismatch/);
  }
});

test('source identity, workflow, status, event, SHA and attempt fail closed', async()=>{
  const changes=[s=>s.conclusion='failure',s=>s.conclusion='cancelled',s=>s.status='in_progress',s=>s.repository.full_name='other/PawTalk',
    s=>s.head_repository.full_name='fork/PawTalk',s=>s.repository.id=undefined,s=>s.event='pull_request',s=>s.head_branch='feature',
    s=>s.path='.github/workflows/check.yml',s=>s.workflow_id=99,s=>s.name='Fake preflight',s=>s.head_sha='b'.repeat(40),s=>s.run_attempt=0];
  for (const change of changes) {const f=fixture();change(f.source);await assert.rejects(f.load());}
  for (const value of ['../123','123?x=1','0','01','123\n','-1',Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>sourceRunId(value));
  assert.throws(()=>verifyRun(fixture().source,workflow,'main'));
});

test('successful run cannot hide failed, missing, skipped or mixed-attempt mandatory jobs', async()=>{
  for (const name of ['preflight','infrastructure','plan','prepare-client','verify (server) / Client + Server + Manager / Windows (windows-2022)','verify (manager) / Server + Manager / Linux (ubuntu-24.04-arm)']) {
    for (const conclusion of ['failure','cancelled','skipped']) {const f=fixture();f.jobs.find(j=>j.name===name).conclusion=conclusion;await assert.rejects(f.load());}
  }
  for (const change of [f=>f.jobs.pop(),f=>f.jobs[0].run_attempt=2,f=>f.jobs.push(clone(f.jobs[0])),f=>f.jobs.find(j=>j.name==='tag').conclusion='success',f=>f.jobs.find(j=>j.name==='publish-client').conclusion='failure']) {
    const f=fixture();change(f);await assert.rejects(f.load());
  }
});

test('promotion accepts a verified PR reuse decision or a complete rebuild, and rejects mixed or missing evidence', async()=>{
  const build = (conclusion, components=['client','server']) => {
    const f = fixture(components);
    const job = {...f.jobs[0], id: 90};
    f.jobs.push({...job,name:'reuse-pr',steps:[{name:reuseStepName,status:'completed',conclusion}]}, {...job,id:91,name:'verified'});
    if (conclusion === 'success') {
      f.jobs.splice(0, f.jobs.length, ...f.jobs.filter(j=>!j.name.startsWith('verify (')));
      f.jobs.push({...job,id:92,name:'verify',conclusion:'skipped'});
    }
    return f;
  };
  for (const conclusion of ['success','skipped']) {
    const f=build(conclusion);
    const {origin}=await f.load();
    await confirmSource(f.api,origin);
  }
  for (const change of [
    f=>f.jobs.find(j=>j.name==='reuse-pr').steps=[],
    f=>f.jobs.find(j=>j.name==='reuse-pr').steps[0].conclusion='skipped',
    f=>f.jobs.find(j=>j.name==='verified').conclusion='skipped',
    f=>f.jobs.find(j=>j.name==='verify').conclusion='failure',
    f=>f.jobs.push(fixture(['client']).jobs.find(j=>j.name.startsWith('verify (client)'))),
  ]) {
    const f=build('success');change(f);await assert.rejects(f.load());
  }
  await assert.rejects(build('success',['manager']).load(),/Manager requires/);
});

function prFixture() {
  const head='b'.repeat(40), parent='c'.repeat(40), tree='d'.repeat(40), checkout='e'.repeat(40);
  const source={id:123,name:'Verify and package',path:'.github/workflows/check.yml',workflow_id:42,event:'pull_request',head_branch:'work/client',head_sha:head,
    run_attempt:1,status:'completed',conclusion:'success',repository:{id:7,full_name:'IlyaRusskikh/PawTalk'},head_repository:{id:7,full_name:'IlyaRusskikh/PawTalk'}};
  const jobs=verificationNames.map(name=>({name,status:'completed',conclusion:'success',run_id:123,run_attempt:1,head_sha:head,
    started_at:'2026-01-01T00:00:00Z',completed_at:'2026-01-01T01:00:00Z'}));
  jobs.find(job=>job.name==='Windows Server package (windows-2025)').completed_at='2026-01-01T00:20:00Z';
  jobs.find(job=>job.name==='Windows Client and core (windows-2025)').started_at='2026-01-01T00:20:00Z';
  const artifacts=['pawtalk-pr-build','pawtalk-server-windows'].map((name,i)=>({id:i+1,name,digest:'sha256:'+tree+'0'.repeat(24),expired:false,
    expires_at:'2099-01-01T00:00:00Z',created_at:i===0?'2026-01-01T00:30:00Z':'2026-01-01T00:10:00Z',workflow_run:{id:123,head_branch:'work/client',head_sha:head,repository_id:7,head_repository_id:7}}));
  const proof={schema:1,pr:20,checkout};
  const pr={number:20,merged:true,merge_commit_sha:sha,base:{ref:'main',repo:{id:7}},head:{ref:source.head_branch,sha:head,repo:{id:7}}};
  const checked={sha:checkout,parents:[{sha:parent},{sha:head}],tree:{sha:tree}};
  const main={sha,parents:[{sha:parent}],tree:{sha:tree}};
  const request=async endpoint=>{
    if (endpoint==='actions/runs/123') return clone(source);
    if (endpoint==='actions/workflows/check.yml') return {id:42,path:source.path};
    if (endpoint===`git/commits/${sha}`) return clone(main);
    if (endpoint===`git/commits/${checkout}`) return clone(checked);
    if (endpoint==='pulls/20') return clone(pr);
    if (endpoint.startsWith('actions/runs/123/attempts/1/jobs?')) return {total_count:jobs.length,jobs:clone(jobs)};
    if (endpoint.startsWith('actions/runs/123/artifacts?')) return {total_count:artifacts.length,artifacts:clone(artifacts)};
    throw Error('Unexpected endpoint '+endpoint);
  };
  return {source,jobs,artifacts,pr,proof,checked,main,request};
}

test('PR reuse requires the successful workflow, exact tested squash tree, attempt and artifact provenance', async()=>{
  const first=prFixture();
  const evidence=await inspectPR(first.request,'123',sha,async()=>first.proof);
  assert.equal(evidence.tree,first.main.tree.sha);
  assert.equal(evidence.artifact('pawtalk-server-windows').id,2);
  const wrongJob=prFixture();
  wrongJob.artifacts[1].created_at=wrongJob.artifacts[0].created_at;
  const wrongEvidence=await inspectPR(wrongJob.request,'123',sha,async()=>wrongJob.proof);
  assert.throws(()=>wrongEvidence.artifact('pawtalk-server-windows'),/foreign-attempt artifact/);
  for (const change of [
    f=>f.source.event='workflow_dispatch', f=>f.source.workflow_id=43, f=>f.source.head_repository.id=8,
    f=>f.source.conclusion='failure', f=>f.jobs[0].conclusion='skipped', f=>f.jobs.find(j=>j.name==='Windows Manager and SCM (windows-2022)').conclusion='failure', f=>f.jobs[1].run_attempt=2, f=>f.jobs.pop(),
    f=>f.pr.merged=false, f=>f.pr.merge_commit_sha=f.proof.checkout, f=>f.pr.base.ref='feature',
    f=>f.checked.tree.sha='8'.repeat(40), f=>f.checked.parents[0].sha='8'.repeat(40), f=>f.checked.parents.pop(),
    f=>f.artifacts[0].expired=true, f=>f.artifacts[0].workflow_run.id=99, f=>f.artifacts.push(clone(f.artifacts[0])),
  ]) {
    const f=prFixture();change(f);
    await assert.rejects(inspectPR(f.request,'123',sha,async()=>f.proof));
  }
});

test('import selects only requested files and refuses a changed attempt or unavailable package', async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'pawtalk-pr-import-'));
  try {
    const f=prFixture(), calls=[];
    const download=async (artifact, destination, names)=>{
      calls.push([artifact.id,names]);
      await mkdir(destination,{recursive:true});
      await writeFile(path.join(destination,names[0]),artifact.id===1 ? JSON.stringify(f.proof) : 'synthetic package');
    };
    const input={request:f.request,runId:'123', mainSha:sha, components:['server'], version:{server:'1.2.3'},directory:folder,download};
    const evidence=await importPR(input);
    assert.deepEqual(calls,[[1,['source.json']],[2,['PawTalk.Server.1.2.3.windows-x64.zip']]]);
    assert.equal(evidence.artifacts['pawtalk-server-windows'].digest,f.artifacts[1].digest);
    assert.equal(await readFile(path.join(folder,'server','PawTalk.Server.1.2.3.windows-x64.zip'),'utf8'),'synthetic package');
    let reads=0;
    await assert.rejects(importPR({...input,request:async endpoint=>{
      const response=await f.request(endpoint);
      if (endpoint==='actions/runs/123' && ++reads===2) response.run_attempt++;
      return response;
    }}),/run changed/);
    f.artifacts.pop();
    await assert.rejects(importPR(input),/Missing\/ambiguous artifact/);
    await assert.rejects(importPR({...input,components:['manager']}),/available for Client and Server/);
  } finally { await rm(folder,{recursive:true,force:true}); }
});

test('artifacts must be complete, unexpired, source-bound and created by the matching attempt jobs', async()=>{
  for (const change of [a=>a.expired=true,a=>a.expires_at='2000-01-01T00:00:00Z',a=>a.digest='unknown',a=>a.workflow_run.id=124,
    a=>a.workflow_run.head_sha='b'.repeat(40),a=>a.workflow_run.repository_id=9,a=>a.workflow_run.head_repository_id=9,
    a=>a.created_at='2025-12-31T23:59:59Z',a=>a.created_at='2026-01-01T01:00:01Z']) {
    const f=fixture();change(f.artifacts[1]);await assert.rejects(f.load());
  }
  for (const change of [f=>f.artifacts.shift(),f=>f.artifacts.pop(),f=>f.artifacts.push(clone(f.artifacts[1]))]) {
    const f=fixture();change(f);await assert.rejects(f.load());
  }
  const f=fixture(['client']);f.artifacts.push({...clone(f.artifacts[1]),id:555,name:'pawtalk-server-prepared'});await assert.rejects(f.load());
});

test('index rejects foreign run/attempt, changed component set and changes after planning', async()=>{
  for (const change of [i=>i.run='456',i=>i.attempt='2',i=>i.sha='b'.repeat(40),i=>i.components.push('client'),i=>delete i.receipts.client,
    i=>i.plans.client.channel='evil',i=>i.plans.client.run='456',i=>i.plans.client.tag='server-v1.2.3']) {
    const f=fixture();change(f.index);await assert.rejects(f.load());
  }
  const f=fixture(), result=await f.load();f.artifacts[1].id++;await assert.rejects(f.load(result.origin),/identity or attempt changed/);
  await assert.rejects(confirmSource(f.api,result.origin),/artifact changed/);
});

test('pagination is exhaustive and API errors cannot imply success', async()=>{
  const f=fixture(), jobs=[...f.jobs,...Array.from({length:101},(_,i)=>({...f.jobs[0],id:1000+i,name:'unrelated '+i}))];
  const api=async endpoint=>{
    if (endpoint.includes('/jobs?')) {const page=Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));return {total_count:jobs.length,jobs:clone(jobs.slice((page-1)*100,page*100))};}
    return f.api(endpoint);
  };
  await sourceCandidate(api,'123',sha,async()=>clone(f.index));
  await assert.rejects(sourceCandidate(async endpoint=>endpoint.includes('/jobs?')?{total_count:99,jobs:[]}:f.api(endpoint),'123',sha,async()=>f.index),/pagination/);
  await assert.rejects(sourceCandidate(async()=>{throw Error('403 API unavailable');},'123',sha,async()=>f.index),/403/);
});

test('immutable tag prechecks and partial REST failures never retry or create extra tags', async()=>{
  const plans=Object.values(fixture(['client','manager']).index.plans);
  for (const kind of ['tag','release']) {
    const writes=[];
    await assert.rejects(createTags(plans,async(endpoint,method,body)=>{
      if (method==='POST') writes.push(body);
      return endpoint===(kind==='tag'?'git/ref/tags/':'releases/tags/')+plans[1].tag ? {} : null;
    }),/already exists/);
    assert.equal(writes.length,0);
  }
  const writes=[];
  await assert.rejects(createTags(plans,async(endpoint,method,body)=>{
    if (method==='POST') {writes.push(body);if(writes.length===2) throw Error('500 partial tag failure');}
    return null;
  }),/partial tag failure/);
  assert.deepEqual(writes.map(w=>w.ref),['refs/tags/client-v1.2.3','refs/tags/manager-v1.2.3']);
  assert.ok(writes.every(w=>w.sha===sha));
  await assert.rejects(absent(plans[0],async()=>{throw Error('API offline');}),/API offline/);
});

test('shared publisher stays draft-first, verifies exact assets and stops on failed/partial publication', async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'pawtalk-publish-fixture-'));
  try {
    const p=fixture(['client']).index.plans.client, notes=path.join(directory,'notes.md');
    const text=(await readFile(new URL('../../releases/client-v0.12.1.md',import.meta.url),'utf8')).replaceAll('0.12.1','1.2.3');
    await writeFile(notes,text);p.notesSha256=notesDigest(text);
    const metadata={tag_name:p.tag,name:text.split(/\r?\n/)[0].slice(2),body:text,prerelease:true};
    const assets=[];
    for (const name of assetNames('client','1.2.3')) {const bytes=Buffer.from('synthetic '+name);await writeFile(path.join(directory,name),bytes);assets.push({name,size:bytes.length,digest:'sha256:'+hash(bytes)});}
    const commands=[],request=async endpoint=>({...metadata,draft:endpoint==='releases/7',assets});
    const execute=(command,args)=>{commands.push([command,args]);return args[1]==='view'?JSON.stringify({databaseId:7}):'';};
    await publishAssets(p,directory,{notes,request,execute});
    assert.ok(commands[0][1].includes('--draft'));assert.ok(commands[2][1].includes('--draft=false'));
    assert.ok(commands[0][1].includes('--prerelease'));assert.ok(commands[0][1].includes('--verify-tag'));
    for (const patch of [{name:'Wrong component'}, {body:text.slice(0,-20)}, {tag_name:'client-v9.9.9'}]) {
      const writes=[];
      await assert.rejects(publishAssets(p,directory,{notes,execute:(command,args)=>{writes.push(args);return JSON.stringify({databaseId:7});},request:async()=>({...metadata,...patch,draft:true,assets})}),/approved notes/);
      assert.ok(!writes.some(args=>args.includes('--draft=false')), 'invalid draft never becomes public');
    }
    await assert.rejects(publishAssets({...p,notesSha256:'0'.repeat(64)},directory,{notes,execute:()=>{throw Error('unexpected write');}}),/digest mismatch/);
    for (const failAt of [1,2]) {
      let count=0;
      await assert.rejects(publishAssets(p,directory,{notes,request,execute:()=>{if(++count===failAt)throw Error('partial upload/publication');return JSON.stringify({databaseId:7});}}),/partial/);
      assert.equal(count,failAt);
    }
    await assert.rejects(publishAssets(p,directory,{notes,execute,request:async()=>({...metadata,draft:true,assets})}),/Incomplete/);
    assets[0].digest='sha256:'+'f'.repeat(64);
    await assert.rejects(publishAssets(p,directory,{notes,execute,request}),/asset verification failed/);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('verified artifact transport checks archive digest before strict extraction and never forwards credentials', async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'pawtalk-artifact-fixture-'));
  const python=process.env.PAWTALK_PYTHON || (process.platform==='win32' && process.env.pythonLocation ? path.join(process.env.pythonLocation,'python.exe') : 'python3');
  try {
    const zip=path.join(directory,'fixture.zip');
    const makeZip=(name='candidate.json',mode=0o100644,duplicate=false)=>{
      execFileSync(python,['-B','-I','-c',`import sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w') as z:
 i=zipfile.ZipInfo(sys.argv[2]);i.external_attr=int(sys.argv[3])<<16;z.writestr(i,b'{"schema":1}')
 if sys.argv[4]=='yes':z.writestr(i,b'duplicate')`,zip,name,String(mode),duplicate?'yes':'no'],{windowsHide:true});
    };
    let bytes;
    const calls=[];
    const fetcher=async(url,options)=>{
      calls.push({url:String(url),options});
      if(String(url).startsWith('https://api.github.com/')) return new Response(null,{status:302,headers:{location:'https://storage.example.test/file?secret=signed'}});
      return new Response(bytes);
    };
    makeZip();bytes=await readFile(zip);
    const artifact={id:100,digest:'sha256:'+hash(bytes)};
    await downloadArtifact(artifact,path.join(directory,'valid'),['candidate.json'],{fetcher,token:'synthetic-token'});
    assert.equal((await readFile(path.join(directory,'valid/candidate.json'),'utf8')),'{"schema":1}');
    assert.equal(calls[1].options.headers,undefined);
    await assert.rejects(downloadArtifact({...artifact,digest:'sha256:'+'f'.repeat(64)},path.join(directory,'bad-digest'),['candidate.json'],{fetcher}),/archive digest mismatch/);
    bytes=Buffer.from('not a ZIP archive');
    await assert.rejects(downloadArtifact({id:100,digest:'sha256:'+hash(bytes)},path.join(directory,'invalid-zip'),['candidate.json'],{fetcher}));
    execFileSync(python,['-B','-I','-c',`import sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('candidate.json',b'x'*(1024*1024+1),compress_type=zipfile.ZIP_DEFLATED)`,zip],{windowsHide:true});
    bytes=await readFile(zip);
    await assert.rejects(downloadArtifact({id:100,digest:'sha256:'+hash(bytes)},path.join(directory,'oversized'),['candidate.json'],{fetcher}));
    for (const [name,mode,duplicate] of [['../candidate.json',0o100644,false],['folder/candidate.json',0o100644,false],['candidate.json',0o120777,false],['candidate.json',0o100644,true],['other.json',0o100644,false]]) {
      makeZip(name,mode,duplicate);bytes=await readFile(zip);
      await assert.rejects(downloadArtifact({id:100,digest:'sha256:'+hash(bytes)},path.join(directory,'malformed'),['candidate.json'],{fetcher}));
    }
    await assert.rejects(downloadArtifact(artifact,path.join(directory,'no-download'),['candidate.json'],{fetcher:async()=>new Response(null,{status:404})}),/unavailable/);
    await assert.rejects(downloadArtifact(artifact,path.join(directory,'unsafe-url'),['candidate.json'],{fetcher:async()=>new Response(null,{status:302,headers:{location:'http://storage.example.test/file'}})}),/Unsafe/);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('promotion YAML preserves both approvals, full-set routing, shared locks and Pages without builds or signing', async()=>{
  const w=await load('promote-candidate'),r=await load('release'),pages=await load('pages');
  assert.deepEqual(Object.keys(w.on),['workflow_dispatch']);
  assert.deepEqual(Object.keys(w.on.workflow_dispatch.inputs),['source_run_id']);
  assert.equal(w.permissions.contents,'read');assert.equal(w.permissions.actions,'read');
  assert.equal(w.concurrency.group,r.concurrency.group);assert.equal(w.concurrency['cancel-in-progress'],false);
  assert.match(w.jobs.plan.if,/refs\/heads\/main/);assert.match(w.jobs.plan.if,/IlyaRusskikh\/PawTalk/);
  assert.equal(w.jobs.tag.environment,'release-tag');assert.equal(w.jobs.tag.needs,'plan');
  assert.match(w.jobs.tag.if,/needs.plan.result == 'success'/);
  const evaluate=(expression,needs)=>Function('needs','github','contains','fromJSON',`return Boolean(${expression});`)(needs,{ref:'refs/heads/main'},(a,b)=>a.includes(b),JSON.parse);
  for(const result of ['failure','cancelled','skipped']) assert.equal(evaluate(w.jobs.tag.if,{plan:{result}}),false);
  for (const c of ['client','server','manager']) {
    const p=w.jobs['publish-'+c];assert.equal(p.environment,'release-publish');
    assert.ok(p.needs.includes('tag'));assert.match(p.if,/needs.tag.result == 'success'/);
    assert.match(p.if,new RegExp("'"+c+"'"));assert.equal(p.permissions.packages,c==='server'?'write':undefined);
    assert.equal(p.env.ORIGIN,'${{ needs.plan.outputs.origin }}');
    for(const result of ['failure','cancelled','skipped']) assert.equal(evaluate(p.if,{tag:{result},plan:{outputs:{components:'["client","server","manager"]'}}}),false);
  }
  const text=JSON.stringify(w);
  assert.doesNotMatch(text,/check\.yml|PRIVATE_KEY|secrets|build-push-action|sign-update|release-metadata|npm ci|npm run|server:prepare|--clobber/);
  assert.ok(r.jobs.preflight.steps.some(s=>s.run==='node tooling/release/release-candidate.mjs snapshot'));
  assert.ok(r.jobs.preflight.steps.some(s=>s.with?.name==='pawtalk-candidate-index'));
  assert.deepEqual(pages.on.workflow_run.workflows,[r.name,w.name]);
  assert.match(pages.jobs.deploy.if,/conclusion == 'success'/);
  assert.match(pages.jobs.deploy.steps[0].run,/startswith\("publish-"\)/);
});
