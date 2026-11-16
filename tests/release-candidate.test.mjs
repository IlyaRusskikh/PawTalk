import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { selection, trusted, tagGuard } from '../scripts/release-candidate.mjs';
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve('app-builder-lib/package.json'))('js-yaml');
const workflow = async name => yaml.load(await readFile(new URL(`../.github/workflows/${name}.yml`,import.meta.url),'utf8'));
const sha = 'a'.repeat(40);

async function promoteFixture(directory, env, index) {
  for (const name of ['candidate-origin.mjs','extract-candidate.py']) await cp(new URL('../scripts/'+name,import.meta.url),path.join(directory,'scripts',name));
  const python=env.PAWTALK_PYTHON || (process.platform==='win32' && env.pythonLocation ? path.join(env.pythonLocation,'python.exe') : 'python3');
  const source={id:123,workflow_id:42,path:'.github/workflows/release.yml',name:'Release Candidate Preflight',repository:{id:7,full_name:'IlyaRusskikh/PawTalk'},head_repository:{id:7,full_name:'IlyaRusskikh/PawTalk'},head_sha:sha,head_branch:'main',event:'workflow_dispatch',run_attempt:1,status:'completed',conclusion:'success'};
  const jobs=[];
  const add=(name,conclusion='success')=>jobs.push({id:jobs.length+1,name,status:'completed',conclusion,head_sha:sha,run_id:123,run_attempt:1,started_at:'2026-01-01T00:00:00Z',completed_at:'2026-01-01T01:00:00Z'});
  for(const name of ['plan','infrastructure','preflight','report','prepare-client'])add(name);
  for(const name of ['tag','prepare-server','prepare-manager','publish-client','publish-server','publish-manager'])add(name,'skipped');
  for(const name of ['infrastructure','server (ubuntu-24.04)','server (ubuntu-24.04-arm)','windows (windows-2022)','windows (windows-2025)'])add('verify (client) / '+name,name==='infrastructure'?'skipped':'success');
  const {assetNames}=await import('../scripts/release-candidate.mjs');
  const archives=[['pawtalk-candidate-index','release/candidate-index',['candidate.json']],['pawtalk-client-prepared','release/client',[...assetNames('client','1.2.3'),'receipt.json']]];
  const artifacts=[];
  for(const [name,folder,names] of archives) {
    const file=path.join(directory,name+'.zip');
    await exec(python,['-B','-I','-c',`import sys,zipfile,pathlib
with zipfile.ZipFile(sys.argv[1],'w') as z:
 for name in sys.argv[3:]:z.write(pathlib.Path(sys.argv[2])/name,name)`,file,path.join(directory,folder),...names],{windowsHide:true});
    artifacts.push({id:100+artifacts.length,name,digest:'sha256:'+createHash('sha256').update(await readFile(file)).digest('hex'),expired:false,created_at:'2026-01-01T00:30:00Z',expires_at:'2099-01-01T00:00:00Z',workflow_run:{id:123,head_sha:sha,head_branch:'main',repository_id:7,head_repository_id:7}});
  }
  await writeFile(path.join(directory,'api-fixture.json'),JSON.stringify({source,jobs,artifacts}));
  await writeFile(path.join(directory,'api-state.json'),JSON.stringify({tags:{},commands:[]}));
  const mock=path.join(directory,'mock-api.mjs');
  await writeFile(mock,`import fs from 'node:fs';import path from 'node:path';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {createHash} from 'node:crypto';
const root=process.cwd(),f=JSON.parse(fs.readFileSync('api-fixture.json')),state=JSON.parse(fs.readFileSync('api-state.json'));
const save=()=>fs.writeFileSync('api-state.json',JSON.stringify(state));
const assets=()=>['PawTalk.Setup.1.2.3.exe','PawTalk.Licenses.1.2.3.zip','SHA256SUMS.txt','update-manifest.json'].map(name=>{const b=fs.readFileSync(path.join(root,'candidate/client',name));return {name,size:b.length,digest:'sha256:'+createHash('sha256').update(b).digest('hex')};});
const real=cp.execFileSync;cp.execFileSync=(command,args,options)=>{if(command==='git'){if(JSON.stringify(args)!==JSON.stringify(['rev-parse','HEAD']))throw Error('Unexpected Git mutation');return f.source.head_sha;}
if(command==='gh'){if(args[1]==='view')return JSON.stringify({databaseId:7});state.commands.push(args);if(args[1]==='create')state.release={tag_name:'client-v1.2.3',name:args[args.indexOf('--title')+1],body:fs.readFileSync(args[args.indexOf('--notes-file')+1],'utf8'),draft:true,prerelease:true,assets:assets()};else if(args[1]==='edit')state.release.draft=false;else throw Error('Unexpected gh command');save();return '';}
return real(command,args,options);};syncBuiltinESMExports();
globalThis.fetch=async(url,options={})=>{const u=new URL(url);if(u.hostname==='storage.example.test'){if(options.headers)throw Error('Credentials reached storage');const a=f.artifacts.find(a=>String(a.id)===u.pathname.slice(1));return new Response(fs.readFileSync(a.name+'.zip'));}
if(u.hostname!=='api.github.com')throw Error('External network forbidden in test');const e=u.pathname.replace('/repos/IlyaRusskikh/PawTalk/','');let value;
if(e==='git/ref/heads/main')value={object:{sha:f.source.head_sha}};
else if(e==='actions/runs/123')value=f.source;
else if(e==='actions/workflows/release.yml')value={id:42,path:f.source.path};
else if(e==='actions/runs/123/attempts/1/jobs')value={total_count:f.jobs.length,jobs:f.jobs};
else if(e==='actions/runs/123/artifacts')value={total_count:f.artifacts.length,artifacts:f.artifacts};
else if(e.startsWith('actions/artifacts/')&&e.endsWith('/zip'))return new Response(null,{status:302,headers:{location:'https://storage.example.test/'+e.split('/')[2]}});
else if(e.startsWith('git/ref/tags/'))value=state.tags[e.slice('git/ref/tags/'.length)];
else if(e.startsWith('releases/tags/')||e==='releases/7')value=state.release;
else if(e==='git/refs'&&options.method==='POST'){const body=JSON.parse(options.body);state.tags[body.ref.slice('refs/tags/'.length)]={object:{sha:body.sha,type:'commit'}};save();value={};}
else throw Error('Unexpected API endpoint '+e);
return new Response(value?JSON.stringify(value):'{}',{status:value?200:404});};
`);
  const promoted={...env,GITHUB_RUN_ID:'456',GITHUB_RUN_ATTEMPT:'2',SOURCE_RUN_ID:'123',GH_TOKEN:'synthetic-token'};
  delete promoted.PAWTALK_UPDATE_PRIVATE_KEY;
  const run=command=>exec(process.execPath,['--import',pathToFileURL(mock).href,path.join(directory,'scripts/release-candidate.mjs'),command],{cwd:directory,env:promoted,windowsHide:true});
  promoted.PAWTALK_CLIENT_CHANNEL='stable';
  await assert.rejects(run('promote-plan'),/Indexed version\/channel\/source contract mismatch|channel differs/);
  promoted.PAWTALK_CLIENT_CHANNEL='preview';
  const notesFile=path.join(directory,'releases/client-v1.2.3.md');
  const originalNotes=await readFile(notesFile,'utf8');
  await writeFile(notesFile,originalNotes+'\nAdditional reviewed content.\n');
  await assert.rejects(run('promote-plan'),/Indexed version\/channel\/source contract mismatch/);
  await writeFile(notesFile,originalNotes);
  for(const command of ['promote-plan','promote-tag','promote-publish']) {
    await rm(path.join(directory,'candidate/client'),{recursive:true,force:true});
    await run(command);
    if(command==='promote-plan') {
      const output=await readFile(env.GITHUB_OUTPUT,'utf8');
      promoted.ORIGIN=output.split(/\r?\n/).find(line=>line.startsWith('origin=')).slice('origin='.length);
    }
    const receipt=JSON.parse(await readFile(path.join(directory,'candidate/client/receipt.json'),'utf8'));
    assert.equal(receipt.run,'123');assert.equal(receipt.attempt,'1');
    assert.equal(receipt.sha,index.sha);
  }
  const state=JSON.parse(await readFile(path.join(directory,'api-state.json'),'utf8'));
  assert.deepEqual(Object.keys(state.tags),['client-v1.2.3']);
  assert.equal(state.release.draft,false);
  assert.deepEqual(state.commands.map(args=>args[1]),['create','edit']);
}

test('component sets are exact, canonical and fail closed', () => {
  for (const input of ['client','server','manager','client,server','server,manager','client,manager','all']) {
    const result = selection(input);
    assert.equal(new Set(result).size,result.length);
    for (const c of result) assert.ok(input === 'all' || input.split(',').includes(c));
  }
  assert.deepEqual(selection('manager,client'),['client','manager']);
  for (const input of ['', 'client,client','Client','client, server','all,client','client\n']) assert.throws(()=>selection(input));
});

test('trust and tagging reject forks, PRs, tags, changed SHA and failed/incomplete preflight', () => {
  const env = {GITHUB_REPOSITORY:'IlyaRusskikh/PawTalk',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_SHA:sha};
  trusted(env);
  for (const override of [{GITHUB_REPOSITORY:'fork/PawTalk'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_REF:'refs/tags/client-v1.2.3'},{GITHUB_SHA:'main'}]) assert.throws(()=>trusted({...env,...override}));
  tagGuard({ready:true,sha,main:sha,artifacts:true});
  for (const override of [{ready:false},{main:'b'.repeat(40)},{artifacts:false}]) assert.throws(()=>tagGuard({ready:true,sha,main:sha,artifacts:true,...override}));
});

test('real seal/validation rejects missing, corrupted, foreign and re-signed receipts with synthetic signing keys', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(),'pawtalk-preflight-'));
  try {
    for (const folder of ['scripts','shared','server','manager/desktop','electron','releases','release/client']) await mkdir(path.join(directory,folder),{recursive:true});
    for (const file of ['scripts/release-candidate.mjs','scripts/check-release-notes.mjs','scripts/release-contract.mjs','scripts/sign-update.mjs','shared/release.cjs']) await cp(new URL('../'+file,import.meta.url),path.join(directory,file));
    await writeFile(path.join(directory,'package.json'),JSON.stringify({version:'1.2.3',type:'module'}));
    await writeFile(path.join(directory,'package-lock.json'),JSON.stringify({version:'1.2.3',packages:{'':{version:'1.2.3'}}}));
    await writeFile(path.join(directory,'server/VERSION'),'2.3.4');
    await writeFile(path.join(directory,'manager/VERSION'),'3.4.5');
    await writeFile(path.join(directory,'manager/desktop/package.json'),JSON.stringify({version:'3.4.5'}));
    await writeFile(path.join(directory,'releases/client-v1.2.3.md'),(await readFile(new URL('../releases/client-v0.12.1.md',import.meta.url),'utf8')).replaceAll('0.12.1','1.2.3'));
    const keys = generateKeyPairSync('ed25519');
    await writeFile(path.join(directory,'electron/update-keys.json'),JSON.stringify({test:keys.publicKey.export({type:'spki',format:'pem'}).toString()}));
    const env = {...process.env,GITHUB_REPOSITORY:'IlyaRusskikh/PawTalk',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',COMPONENTS:'client',PAWTALK_CLIENT_CHANNEL:'preview',PAWTALK_PRERELEASE:'true',GITHUB_OUTPUT:path.join(directory,'output'),PAWTALK_UPDATE_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
    const run = (script,args=[]) => exec(process.execPath,[path.join(directory,'scripts',script+'.mjs'),...args],{cwd:directory,env,windowsHide:true});
    const installer = 'PawTalk.Setup.1.2.3.exe', data=Buffer.from('synthetic installer');
    const hash = b=>createHash('sha256').update(b).digest('hex');
    await writeFile(path.join(directory,'release/client',installer),data);
    await writeFile(path.join(directory,'release/client/PawTalk.Licenses.1.2.3.zip'),'synthetic licenses');
    await writeFile(path.join(directory,'release/client/SHA256SUMS.txt'),hash(data)+'  '+installer+'\n');
    await run('sign-update',[path.join(directory,'release/client')]);
    await run('release-candidate',['seal']);
    const receipt = await readFile(path.join(directory,'release/client/receipt.json'));
    env.RECEIPTS=JSON.stringify({client:hash(receipt)});
    await cp(path.join(directory,'release/client'),path.join(directory,'candidate/client'),{recursive:true});
    await run('release-candidate',['validate']);
    const notesFile=path.join(directory,'releases/client-v1.2.3.md');
    const originalNotes=await readFile(notesFile,'utf8');
    await writeFile(notesFile,originalNotes+'\nPublication pending.\n');
    for (const command of ['plan','tag','publish']) await assert.rejects(run('release-candidate',[command]),/temporary publication\/CI status/);
    await writeFile(notesFile,originalNotes+'\nAdditional reviewed content.\n');
    for (const command of ['validate','tag','publish']) await assert.rejects(run('release-candidate',[command]),/Candidate notesSha256 mismatch/);
    await writeFile(notesFile,originalNotes);
    await run('release-candidate',['snapshot']);
    const index=JSON.parse(await readFile(path.join(directory,'release/candidate-index/candidate.json'),'utf8'));
    assert.deepEqual(index.components,['client']);
    assert.equal(index.run,'123');assert.equal(index.attempt,'1');
    assert.equal(index.receipts.client,hash(receipt));
    assert.deepEqual(await readFile(path.join(directory,'candidate/client/receipt.json')),receipt);
    await promoteFixture(directory,env,index);
    const target=path.join(directory,'candidate/client',installer);
    await writeFile(target,'corrupt');
    await assert.rejects(run('release-candidate',['validate']),/Corrupt artifact/);
    for (const command of ['tag','publish']) await assert.rejects(run('release-candidate',[command]),/Corrupt artifact/);
    await rm(target);
    await assert.rejects(run('release-candidate',['validate']));
    await writeFile(target,data);
    for (const [key,value] of [['GITHUB_RUN_ID','999'],['GITHUB_RUN_ATTEMPT','2'],['GITHUB_SHA','b'.repeat(40)],['PAWTALK_CLIENT_CHANNEL','stable']]) {
      const original=env[key];env[key]=value;await assert.rejects(run('release-candidate',['validate']),/mismatch|differs/);env[key]=original;
    }
    const bad=JSON.parse(receipt);bad.sha='b'.repeat(40);
    await writeFile(path.join(directory,'candidate/client/receipt.json'),JSON.stringify(bad)+'\n');
    await assert.rejects(run('release-candidate',['validate']),/Receipt digest mismatch/);
    env.RECEIPTS=JSON.stringify({client:hash(Buffer.from(JSON.stringify(bad)+'\n'))});
    await assert.rejects(run('release-candidate',['validate']),/Candidate sha mismatch/);
    await assert.rejects(run('release-candidate',['tag']),/Candidate sha mismatch/);
    await writeFile(path.join(directory,'candidate/client/receipt.json'),receipt);
    env.RECEIPTS=JSON.stringify({client:hash(receipt)});
    await writeFile(path.join(directory,'candidate/client/unexpected.exe'),'extra');
    await assert.rejects(run('release-candidate',['validate']),/Unexpected candidate files/);
    await rm(path.join(directory,'candidate/client/unexpected.exe'));
    const manifestFile=path.join(directory,'candidate/client/update-manifest.json');
    const envelope=JSON.parse(await readFile(manifestFile,'utf8'));
    envelope.signature=Buffer.alloc(64).toString('base64');
    const forged=JSON.stringify(envelope)+'\n';
    await writeFile(manifestFile,forged);
    const forgedReceipt=JSON.parse(receipt);
    forgedReceipt.files['update-manifest.json']={size:Buffer.byteLength(forged),sha256:hash(Buffer.from(forged))};
    const forgedBytes=JSON.stringify(forgedReceipt)+'\n';
    await writeFile(path.join(directory,'candidate/client/receipt.json'),forgedBytes);
    env.RECEIPTS=JSON.stringify({client:hash(Buffer.from(forgedBytes))});
    await assert.rejects(run('release-candidate',['validate']),/Invalid artifact signature/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('actual workflow enforces preflight before tags and separate publication approvals without rebuilds', async () => {
  const w = await workflow('release'), check = await workflow('check'), pages=await workflow('pages');
  assert.deepEqual(Object.keys(w.on),['workflow_dispatch']);
  assert.equal(w.on.workflow_dispatch.inputs.promote.default,false);
  assert.match(w.jobs.plan.if,/refs\/heads\/main/);
  assert.match(w.jobs.plan.if,/IlyaRusskikh\/PawTalk/);
  assert.equal(w.jobs.verify.with.component,'${{ matrix.component }}');
  assert.equal(w.jobs.verify.with['skip-infrastructure'],true);
  assert.equal(check.jobs.infrastructure.if,'${{ !inputs.skip-infrastructure }}');
  for (const infra of [check.jobs.infrastructure,w.jobs.infrastructure]) {
    assert.ok(infra.steps.some(step=>step.run === 'node scripts/check-release-notes.mjs'));
    assert.ok(infra.steps.some(step=>step.run?.includes('tests/release-notes.test.mjs')));
  }
  assert.equal(check.on.workflow_call.secrets,undefined);
  assert.doesNotMatch(JSON.stringify(check),/PRIVATE_KEY|sign-update/);
  assert.match(w.jobs.preflight.if,/needs.verify.result == 'success'/);
  assert.match(w.jobs.preflight.if,/needs.infrastructure.result == 'success'/);
  assert.match(w.jobs.preflight.if,/failure/);
  assert.equal(w.jobs.tag.environment,'release-tag');
  assert.ok(w.jobs.tag.needs.includes('preflight'));
  assert.match(w.jobs.tag.if,/inputs.promote/);
  const evaluate = (expression, needs, github = {ref:'refs/heads/main'}) => Function('needs','github','inputs','always','contains',
    `return Boolean(${expression.replaceAll('needs.*.result','Object.values(needs).map(job=>job.result)')});`)(
    needs,github,{promote:true},()=>true,(values,value)=>values.includes(value));
  const success=Object.fromEntries(w.jobs.preflight.needs.map(name=>[name,{result:'success'}]));
  assert.equal(evaluate(w.jobs.preflight.if,success),true);
  for (const stage of w.jobs.preflight.needs) for (const result of ['failure','cancelled']) {
    assert.equal(evaluate(w.jobs.preflight.if,{...success,[stage]:{result}}),false,`${stage} ${result} prevents preflight`);
  }
  for (const result of ['failure','cancelled','skipped']) assert.equal(evaluate(w.jobs.tag.if,{plan:{result:'success'},preflight:{result}}),false);
  assert.equal(evaluate(w.jobs.tag.if,{plan:{result:'success'},preflight:{result:'success'}},{ref:'refs/heads/untrusted'}),false);
  assert.equal(w.jobs.tag.permissions.contents,'write');
  assert.equal(w.jobs.tag.permissions.packages,undefined);
  for (const c of ['client','server','manager']) {
    const prepare=w.jobs['prepare-'+c], publish=w.jobs['publish-'+c];
    assert.ok(prepare.needs.includes('verify'));
    assert.match(prepare.if,new RegExp(`'${c}'`));
    assert.equal(publish.environment,'release-publish');
    assert.ok(publish.needs.includes('tag'));
    assert.ok(publish.needs.includes('preflight'));
    assert.equal(publish.env.COMPONENTS,c);
    for (const result of ['failure','cancelled','skipped']) assert.equal(evaluate(publish.if,{preflight:{result:'success'},tag:{result}}),false);
    assert.equal(publish.permissions.packages,c==='server'?'write':undefined);
    assert.match(publish.if,/refs\/heads\/main/);
    assert.doesNotMatch(JSON.stringify(publish),/PRIVATE_KEY|build-push-action|npm run|release-metadata|sign-update/);
    assert.ok(publish.steps.some(s=>s.with?.name===`pawtalk-${c}-prepared`));
    assert.ok(w.jobs.preflight.needs.includes('prepare-'+c));
  }
  const script=await readFile(new URL('../scripts/release-candidate.mjs',import.meta.url),'utf8');
  assert.match(script,/'copy','--all','--preserve-digests'/);
  assert.match(script,/Published OCI digest differs/);
  assert.match(script,/'--verify-tag','--draft'/);
  assert.match(script,/'--draft=false'/);
  assert.doesNotMatch(script,/--clobber/);
  assert.deepEqual(pages.on.workflow_run.workflows,[w.name,'Promote Existing Preflight']);
  assert.match(pages.jobs.deploy.steps[0].run,/startswith\("publish-"\)/);
});
