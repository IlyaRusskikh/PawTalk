import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, createPublicKey, verify, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
test('real component artifact builder signs exact digests/bundle bytes with separate keys and no cross artifacts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(),'pawtalk-component-signing-'));
  try {
    await mkdir(path.join(directory,'scripts')); await mkdir(path.join(directory,'shared')); await mkdir(path.join(directory,'server'));
    for (const name of ['scripts/release-metadata.mjs','scripts/release-contract.mjs','shared/release.cjs','LICENSE','THIRD_PARTY_NOTICES.md']) {
      await cp(new URL('../'+name,import.meta.url),path.join(directory,name));
    }
    await cp(new URL('../deploy/',import.meta.url),path.join(directory,'deploy'),{recursive:true,filter:source=>!['__pycache__','generated'].includes(path.basename(source))});
    await writeFile(path.join(directory,'deploy/pawtalk_agent/local_debug.py'),'# unreviewed local helper must not be distributed');
    const version = '0.9.0';
    await writeFile(path.join(directory,'package.json'),JSON.stringify({version}));
    await writeFile(path.join(directory,'package-lock.json'),JSON.stringify({version,packages:{'':{version}}}));
    await writeFile(path.join(directory,'server/VERSION'),version);
    const server = generateKeyPairSync('ed25519'), deploy = generateKeyPairSync('ed25519');
    const trust = {server:{s:server.publicKey.export({type:'spki',format:'pem'}).toString()},deploy:{d:deploy.publicKey.export({type:'spki',format:'pem'}).toString()}};
    await writeFile(path.join(directory,'deploy/trust.json'),JSON.stringify(trust));
    const env = {...process.env,GITHUB_REF_NAME:'server-v0.9.0',PAWTALK_IMAGE_DIGEST:'sha256:'+'b'.repeat(64),PAWTALK_SERVER_PRIVATE_KEY:server.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
    const run = () => exec(process.execPath,[path.join(directory,'scripts/release-metadata.mjs')],{env,windowsHide:true});
    await run();
    const check = async component => {
      const envelope = JSON.parse(await readFile(path.join(directory,'release',component,component+'-manifest.json'),'utf8'));
      const bytes = Buffer.from(envelope.payload,'base64');
      assert.ok(verify(null,bytes,createPublicKey(trust[component][envelope.keyId]),Buffer.from(envelope.signature,'base64')));
      const value = JSON.parse(bytes); assert.equal(value.component,component); return value;
    };
    assert.equal((await check('server')).digest,env.PAWTALK_IMAGE_DIGEST);
    env.PAWTALK_SERVER_PRIVATE_KEY = deploy.privateKey.export({type:'pkcs8',format:'pem'}).toString();
    await assert.rejects(run(),/No matching trusted component key/);
    const deployVersion = (await readFile(path.join(directory,'deploy/VERSION'),'utf8')).trim();
    env.GITHUB_REF_NAME = 'deploy-v'+deployVersion;
    env.PAWTALK_DEPLOY_PRIVATE_KEY = env.PAWTALK_SERVER_PRIVATE_KEY;
    await run();
    const manifest = await check('deploy');
    const bundle = await readFile(path.join(directory,'release/deploy',manifest.bundle));
    assert.equal(manifest.size,bundle.length); assert.equal(manifest.sha256,createHash('sha256').update(bundle).digest('hex'));
    const listing = (await exec('tar',['-tzf',path.join(directory,'release/deploy',manifest.bundle)],{windowsHide:true})).stdout;
    assert.match(listing,/deploy\/pawtalk_agent\/cli.py/); assert.match(listing,/LICENSE/);
    assert.doesNotMatch(listing,/generated|__pycache__|\.exe|node_modules|local_debug/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
