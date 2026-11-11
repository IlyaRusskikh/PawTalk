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
    await cp(new URL('../manager/',import.meta.url),path.join(directory,'manager'),{recursive:true,filter:source=>!['__pycache__','generated'].includes(path.basename(source))});
    await writeFile(path.join(directory,'manager/pawtalk_manager/local_debug.py'),'# unreviewed local helper must not be distributed');
    const version = '0.9.0';
    await writeFile(path.join(directory,'package.json'),JSON.stringify({version}));
    await writeFile(path.join(directory,'package-lock.json'),JSON.stringify({version,packages:{'':{version}}}));
    await writeFile(path.join(directory,'server/VERSION'),version);
    const server = generateKeyPairSync('ed25519'), manager = generateKeyPairSync('ed25519');
    const trust = {server:{s:server.publicKey.export({type:'spki',format:'pem'}).toString()},manager:{d:manager.publicKey.export({type:'spki',format:'pem'}).toString()}};
    await writeFile(path.join(directory,'manager/trust.json'),JSON.stringify(trust));
    const env = {...process.env,GITHUB_REF_NAME:'server-v0.9.0',PAWTALK_IMAGE_DIGEST:'sha256:'+'b'.repeat(64),PAWTALK_SERVER_PRIVATE_KEY:server.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
    const run = () => exec(process.execPath,[path.join(directory,'scripts/release-metadata.mjs')],{env,windowsHide:true});
    await mkdir(path.join(directory,'release/server'),{recursive:true});
    const windowsBytes=Buffer.from('synthetic Windows artifact for signature binding');
    await writeFile(path.join(directory,'release/server',`PawTalk.Server.${version}.windows-x64.zip`),windowsBytes);
    await run();
    const check = async component => {
      const envelope = JSON.parse(await readFile(path.join(directory,'release',component,component+'-manifest.json'),'utf8'));
      const bytes = Buffer.from(envelope.payload,'base64');
      assert.ok(verify(null,bytes,createPublicKey(trust[component][envelope.keyId]),Buffer.from(envelope.signature,'base64')));
      const value = JSON.parse(bytes); assert.equal(value.component,component); return value;
    };
    const serverManifest=await check('server');
    assert.equal(serverManifest.digest,env.PAWTALK_IMAGE_DIGEST);
    assert.equal(serverManifest.windows.sha256,createHash('sha256').update(windowsBytes).digest('hex'));
    assert.equal(serverManifest.windows.size,windowsBytes.length);
    env.PAWTALK_SERVER_PRIVATE_KEY = manager.privateKey.export({type:'pkcs8',format:'pem'}).toString();
    await assert.rejects(run(),/No matching trusted component key/);
    const managerVersion = (await readFile(path.join(directory,'manager/VERSION'),'utf8')).trim();
    env.GITHUB_REF_NAME = 'manager-v'+managerVersion;
    env.PAWTALK_MANAGER_PRIVATE_KEY = env.PAWTALK_SERVER_PRIVATE_KEY;
    await mkdir(path.join(directory,'release/manager'),{recursive:true});
    const installerBytes=Buffer.from('synthetic Manager installer');
    await writeFile(path.join(directory,'release/manager',`PawTalk.Server.Manager.Setup.${managerVersion}.exe`),installerBytes);
    await run();
    const manifest = await check('manager');
    assert.equal(manifest.windowsInstaller.sha256,createHash('sha256').update(installerBytes).digest('hex'));
    const bundle = await readFile(path.join(directory,'release/manager',manifest.bundle));
    assert.equal(manifest.size,bundle.length); assert.equal(manifest.sha256,createHash('sha256').update(bundle).digest('hex'));
    const listing = (await exec('tar',['-tzf',path.join(directory,'release/manager',manifest.bundle)],{windowsHide:true})).stdout;
    assert.match(listing,/manager\/pawtalk_manager\/cli.py/); assert.match(listing,/LICENSE/);
    assert.doesNotMatch(listing,/generated|__pycache__|\.exe|node_modules|local_debug/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
