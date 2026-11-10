// Build/sign artifacts locally; this script never publishes anything.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { versions } from './release-contract.mjs';
const { releasePlan } = createRequire(import.meta.url)('../shared/release.cjs');
const root = path.resolve(import.meta.dirname, '..');
const plan = releasePlan(process.env.GITHUB_REF_NAME, await versions());
if (plan.client) throw Error('Use sign-update.mjs for Client');
const component = plan.component;
const trust = JSON.parse(await readFile(path.join(root, 'deploy/trust.json'), 'utf8'))[component];
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
  publishedAt:now,expiresAt:now+365*86400,apiProtocol:1,dataSchema:1};
if (plan.server) {
  if (!/^sha256:[a-f0-9]{64}$/.test(process.env.PAWTALK_IMAGE_DIGEST || '')) throw Error('Exact GHCR digest required');
  Object.assign(payload,{image:'ghcr.io/ilyarusskikh/pawtalk-server',digest:process.env.PAWTALK_IMAGE_DIGEST});
} else {
  const bundle = `PawTalk.Deploy.${plan.version}.tar.gz`;
  // Explicit allowlist, never package deploy/generated, secrets or unreviewed files.
  const files = ['deploy/VERSION','deploy/trust.json','deploy/compose.server.yaml','deploy/launcher',
    'deploy/pawtalkctl','deploy/pawtalk-update.service','deploy/pawtalk-update.timer','deploy/pawtalk-health.service',
    'deploy/pawtalk-health.timer','LICENSE','THIRD_PARTY_NOTICES.md'];
  for (const name of ['__init__','release','config','runtime','controller','preflight','bundles','cli']) files.push(`deploy/pawtalk_agent/${name}.py`);
  if (!(await stat(path.join(root,'deploy/pawtalk_agent/cli.py'))).isFile()) throw Error('Deploy implementation is missing');
  execFileSync('tar',['-czf',path.join(output,bundle),'-C',root,...files],{windowsHide:true});
  const bytes = await readFile(path.join(output,bundle));
  Object.assign(payload,{bundle,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,launcherProtocol:1,configSchema:1});
}
const bytes = Buffer.from(JSON.stringify(payload));
await writeFile(path.join(output,`${component}-manifest.json`),JSON.stringify({keyId,payload:bytes.toString('base64'),signature:sign(null,bytes,key).toString('base64')})+'\n');
console.log(`Prepared signed ${component} ${plan.version}; no publication performed.`);
