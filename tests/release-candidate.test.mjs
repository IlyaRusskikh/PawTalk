import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { selection, trusted, tagGuard } from '../scripts/release-candidate.mjs';
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve('app-builder-lib/package.json'))('js-yaml');
const workflow = async name => yaml.load(await readFile(new URL(`../.github/workflows/${name}.yml`,import.meta.url),'utf8'));
const sha = 'a'.repeat(40);

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
    for (const folder of ['scripts','shared','server','manager/desktop','electron','docs/releases','release/client']) await mkdir(path.join(directory,folder),{recursive:true});
    for (const file of ['scripts/release-candidate.mjs','scripts/release-contract.mjs','scripts/sign-update.mjs','shared/release.cjs']) await cp(new URL('../'+file,import.meta.url),path.join(directory,file));
    await writeFile(path.join(directory,'package.json'),JSON.stringify({version:'1.2.3',type:'module'}));
    await writeFile(path.join(directory,'package-lock.json'),JSON.stringify({version:'1.2.3',packages:{'':{version:'1.2.3'}}}));
    await writeFile(path.join(directory,'server/VERSION'),'2.3.4');
    await writeFile(path.join(directory,'manager/VERSION'),'3.4.5');
    await writeFile(path.join(directory,'manager/desktop/package.json'),JSON.stringify({version:'3.4.5'}));
    await writeFile(path.join(directory,'docs/releases/client-v1.2.3.md'),'# Synthetic release\nРусский\nEnglish\n');
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
    const target=path.join(directory,'candidate/client',installer);
    await writeFile(target,'corrupt');
    await assert.rejects(run('release-candidate',['validate']),/Corrupt artifact/);
    for (const command of ['tag','publish']) await assert.rejects(run('release-candidate',[command]),/Corrupt artifact/);
    await rm(target);
    await assert.rejects(run('release-candidate',['validate']));
    await writeFile(target,data);
    for (const [key,value] of [['GITHUB_RUN_ID','999'],['GITHUB_RUN_ATTEMPT','2'],['GITHUB_SHA','b'.repeat(40)],['PAWTALK_CLIENT_CHANNEL','stable']]) {
      const original=env[key];env[key]=value;await assert.rejects(run('release-candidate',['validate']),/mismatch/);env[key]=original;
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
  assert.deepEqual(pages.on.workflow_run.workflows,[w.name]);
  assert.match(pages.jobs.deploy.steps[0].run,/startswith\("publish-"\)/);
});
