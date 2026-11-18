// Build/sign artifacts locally; this script never publishes anything.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { managerSourceFiles, stageManagerSource } from '../build/manager-layout.mjs';
import { versions } from './release-contract.mjs';
const { releasePlan } = createRequire(import.meta.url)('../../shared/release.cjs');
const {apiProtocolVersion,dataSchemaVersion}=createRequire(import.meta.url)('../../shared/membership.cjs');
const root = path.resolve(import.meta.dirname, '../..');
const plan = releasePlan(process.env.PAWTALK_RELEASE_TAG || process.env.GITHUB_REF_NAME, await versions());
if (plan.client) throw Error('Use sign-update.mjs for Client');
const component = plan.component;
const trust = JSON.parse(await readFile(path.join(root, 'apps/manager/linux/trust.json'), 'utf8'))[component];
const secret = process.env[`PAWTALK_${component.toUpperCase()}_PRIVATE_KEY`];
if (!secret) throw Error('Component signing key is required');
const key = createPrivateKey(secret);
const publicKey = createPublicKey(key).export({type:'spki',format:'pem'}).toString();
const keyId = Object.keys(trust).find(id => trust[id] === publicKey);
if (key.asymmetricKeyType !== 'ed25519' || !keyId) throw Error('No matching trusted component key');
if (process.argv.includes('--check-key')) {
  console.log('Trusted component signing key verified.');
  process.exit(0);
}
const output = path.join(root, 'release', component);
await mkdir(output, {recursive:true});
const now = Math.floor(Date.now()/1000);
const payload = {schema:1,component,repository:'IlyaRusskikh/PawTalk',version:plan.version,
  channel:process.env.PAWTALK_PRERELEASE === 'false' && !plan.version.includes('-') ? 'stable' : 'preview',
  publishedAt:now,expiresAt:now+365*86400,apiProtocol:apiProtocolVersion,dataSchema:dataSchemaVersion};
if (plan.server) {
  if (!/^sha256:[a-f0-9]{64}$/.test(process.env.PAWTALK_IMAGE_DIGEST || '')) throw Error('Exact GHCR digest required');
  Object.assign(payload,{image:'ghcr.io/ilyarusskikh/pawtalk-server',digest:process.env.PAWTALK_IMAGE_DIGEST});
  const name = `PawTalk.Server.${plan.version}.windows-x64.zip`;
  const windows = await readFile(path.join(output,name));
  Object.assign(payload,{windows:{name,sha256:createHash('sha256').update(windows).digest('hex'),size:windows.length}});
} else {
  const bundle = `PawTalk.Manager.${plan.version}.tar.gz`;
  // Preserve installed protocol 1 archive paths while sources live under apps/.
  const stage = await mkdtemp(path.join(os.tmpdir(),'pawtalk-manager-bundle-'));
  try {
    await stageManagerSource(root,stage);
    execFileSync('tar',['-czf',path.join(output,bundle),'-C',stage,...Object.keys(managerSourceFiles)],{windowsHide:true});
  } finally {
    if(path.dirname(stage)!==path.resolve(os.tmpdir())||!path.basename(stage).startsWith('pawtalk-manager-bundle-'))throw Error('Unsafe Manager bundle cleanup path');
    await rm(stage,{recursive:true,force:true});
  }
  const bytes = await readFile(path.join(output,bundle));
  Object.assign(payload,{bundle,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,launcherProtocol:1,configSchema:1});
  const name=`PawTalk.Server.Manager.Setup.${plan.version}.exe`;
  const installer=await readFile(path.join(output,name));
  Object.assign(payload,{windowsInstaller:{name,sha256:createHash('sha256').update(installer).digest('hex'),size:installer.length}});
}
const bytes = Buffer.from(JSON.stringify(payload));
await writeFile(path.join(output,`${component}-manifest.json`),JSON.stringify({keyId,payload:bytes.toString('base64'),signature:sign(null,bytes,key).toString('base64')})+'\n');
console.log(`Prepared signed ${component} ${plan.version}; no publication performed.`);
