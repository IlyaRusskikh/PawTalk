// Trusted main orchestration only. No build command is reachable from tag/publish.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, readdir, lstat, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { versions } from './release-contract.mjs';
const { releasePlan, channelFor } = createRequire(import.meta.url)('../shared/release.cjs');
const families = ['client', 'server', 'manager'];
const root = path.resolve(import.meta.dirname, '..');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, args) => execFileSync(command, args, {encoding:'utf8', windowsHide:true}).trim();
export function selection(value) {
  const selected = value === 'all' ? families : value.split(',');
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(c => !families.includes(c))) throw Error('Invalid component selection');
  return families.filter(c => selected.includes(c));
}
export function trusted(env) {
  if (env.GITHUB_REPOSITORY !== 'IlyaRusskikh/PawTalk' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw Error('Trusted main dispatch required');
}
export function binding(receipt, expected, digest) {
  if (!digest || hash(Buffer.from(JSON.stringify(receipt)+'\n')) !== digest) throw Error('Receipt digest mismatch');
  for (const key of ['repository','sha','run','attempt','component','version','channel','tag']) if (receipt[key] !== expected[key]) throw Error(`Candidate ${key} mismatch`);
}
export function tagGuard({ready, sha, main, artifacts}) {
  if (!ready || sha !== main || !artifacts) throw Error('Successful preflight, unchanged main and complete artifacts required');
}
export function assetNames(component, version) {
  if (component === 'client') return [`PawTalk.Setup.${version}.exe`, `PawTalk.Licenses.${version}.zip`, 'SHA256SUMS.txt', 'update-manifest.json'];
  if (component === 'server') return [`PawTalk.Server.${version}.windows-x64.zip`, 'server-manifest.json', 'server-image.tar'];
  if (component === 'manager') return [`PawTalk.Server.Manager.Setup.${version}.exe`, `PawTalk.Manager.${version}.tar.gz`, 'manager-manifest.json'];
  throw Error('Unknown component');
}
async function fileDigest(file) {
  const info = await lstat(file);
  if (!info.isFile() || !info.size) throw Error('Missing/empty/unsafe artifact: '+file);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return {size:info.size, sha256:digest.digest('hex')};
}
async function plan(component, env = process.env) {
  const source = await versions();
  const desktop = await json(path.join(root,'manager/desktop/package.json'));
  if (desktop.version !== source.manager) throw Error('Manager versions differ');
  const tag = `${component}-v${source[component]}`;
  const p = releasePlan(tag, source);
  const channel = channelFor(p.version, env[`PAWTALK_${component.toUpperCase()}_CHANNEL`] || 'preview');
  if (!(await readFile(path.join(root,`docs/releases/${tag}.md`),'utf8')).trim()) throw Error('Missing release notes');
  return {repository:env.GITHUB_REPOSITORY, sha:env.GITHUB_SHA, run:env.GITHUB_RUN_ID, attempt:env.GITHUB_RUN_ATTEMPT, component, version:p.version, channel, tag};
}
async function signatures(p, directory) {
  const name = p.component === 'client' ? 'update-manifest.json' : `${p.component}-manifest.json`;
  const envelope = await json(path.join(directory,name));
  const trust = p.component === 'client' ? await json(path.join(root,'electron/update-keys.json')) : (await json(path.join(root,'manager/trust.json')))[p.component];
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (!trust[envelope.keyId] || !verify(null, bytes, createPublicKey(trust[envelope.keyId]), Buffer.from(envelope.signature,'base64'))) throw Error('Invalid artifact signature');
  const payload = JSON.parse(bytes);
  if (payload.schema !== 1 || payload.component !== p.component || payload.version !== p.version) throw Error('Signed component/version mismatch');
  const client = p.component === 'client';
  if (client ? payload.prerelease !== (p.channel === 'preview') : payload.channel !== p.channel || payload.repository !== p.repository || payload.apiProtocol !== 2 || payload.dataSchema !== 2) throw Error('Signed release contract mismatch');
  if (payload.expiresAt <= (client ? Date.now() : Date.now()/1000)) throw Error('Expired manifest');
  const check = async entry => {
    if (!assetNames(p.component,p.version).includes(entry.name)) throw Error('Unexpected signed asset');
    const actual = await fileDigest(path.join(directory,entry.name));
    if (actual.sha256 !== entry.sha256 || actual.size !== entry.size) throw Error('Signed asset mismatch');
  };
  if (client) {
    await check(payload);
    const sums = (await readFile(path.join(directory,'SHA256SUMS.txt'),'utf8')).trim();
    if (sums !== `${payload.sha256}  ${payload.name}`) throw Error('Client checksum mismatch');
  } else if (p.component === 'manager') {
    await check(payload.windowsInstaller);
    await check({name:payload.bundle,sha256:payload.sha256,size:payload.size});
  } else {
    await check(payload.windows);
    if (payload.image !== 'ghcr.io/ilyarusskikh/pawtalk-server') throw Error('Unexpected image');
    const raw = execFileSync('skopeo',['inspect','--raw',`oci-archive:${path.join(directory,'server-image.tar')}`]);
    if (payload.digest !== 'sha256:'+hash(raw)) throw Error('OCI digest mismatch');
    const architectures = JSON.parse(raw).manifests.map(m=>m.platform?.architecture).filter(a=>a !== 'unknown').sort();
    if (JSON.stringify(architectures) !== JSON.stringify(['amd64','arm64'])) throw Error('Incomplete OCI platforms');
  }
  return payload;
}
async function api(endpoint, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${endpoint}`, {method, signal:AbortSignal.timeout(60000), headers:{Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json','Content-Type':'application/json'}, body:body && JSON.stringify(body)});
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw Error(`GitHub ${method} ${endpoint}: ${response.status}`);
  return response.json();
}
async function absent(p) {
  if (await api(`git/ref/tags/${p.tag}`) || await api(`releases/tags/${p.tag}`)) throw Error('Tag/release already exists: '+p.tag);
}
async function currentMain() {
  const main = await api('git/ref/heads/main');
  tagGuard({ready:true,sha:process.env.GITHUB_SHA,main:main?.object.sha,artifacts:true});
  if (run('git',['rev-parse','HEAD']) !== process.env.GITHUB_SHA) throw Error('Checkout SHA mismatch');
}
async function validate(p, directory, digest) {
  const receipt = await json(path.join(directory,'receipt.json'));
  binding(receipt,p,digest);
  const names = assetNames(p.component,p.version).sort();
  if (JSON.stringify(Object.keys(receipt.files).sort()) !== JSON.stringify(names)) throw Error('Incomplete receipt');
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify([...names,'receipt.json'].sort())) throw Error('Unexpected candidate files');
  for (const name of names) {
    const actual = await fileDigest(path.join(directory,name));
    if (JSON.stringify(actual) !== JSON.stringify(receipt.files[name])) throw Error('Corrupt artifact: '+name);
  }
  return signatures(p,directory);
}
async function main() {
  const [command, argument] = process.argv.slice(2);
  trusted(process.env);
  const components = selection(process.env.COMPONENTS || argument);
  const plans = await Promise.all(components.map(c=>plan(c)));
  if (command === 'compare-core') {
    const receipt = await json(path.join(root,'release/client-core/bundled-server.json'));
    const { serverDefinition } = await import('./server-core.mjs');
    for (const [key,value] of Object.entries(await serverDefinition())) if (receipt[key] !== value) throw Error('Shared core source mismatch');
    const server = plans.find(p=>p.component === 'server');
    if (!server) throw Error('Server candidate required for core equality');
    const zip = path.join(root,'release/server',`PawTalk.Server.${server.version}.windows-x64.zip`);
    for (const [name,expected] of [['pawtalk-server.exe',receipt.apiSha256],['livekit-server.exe',receipt.livekitSha256]]) {
      const bytes = execFileSync('unzip',['-p',zip,name],{maxBuffer:128*1024*1024});
      if (hash(bytes) !== expected) throw Error('Separately built Client/Server cores differ: '+name);
    }
    console.log('PASS separately built Client/Server Go and LiveKit byte equality');
    return;
  }
  if (command === 'plan') {
    await currentMain();
    for (const p of plans) await absent(p);
    await appendFile(process.env.GITHUB_OUTPUT,`components=${JSON.stringify(components)}\n`);
    for (const p of plans) for (const key of ['tag','version','channel']) await appendFile(process.env.GITHUB_OUTPUT,`${p.component}_${key}=${p[key]}\n`);
    return;
  }
  if (command === 'seal') {
    if (plans.length !== 1) throw Error('Seal one component');
    const p = plans[0], directory = path.join(root,'release',p.component);
    await signatures(p,directory);
    const files = {};
    for (const name of assetNames(p.component,p.version).sort()) files[name] = await fileDigest(path.join(directory,name));
    const bytes = JSON.stringify({...p,files})+'\n';
    await writeFile(path.join(directory,'receipt.json'),bytes);
    await appendFile(process.env.GITHUB_OUTPUT,`digest=${hash(bytes)}\n`);
    return;
  }
  const digests = JSON.parse(process.env.RECEIPTS);
  for (const p of plans) await validate(p,path.join(root,'candidate',p.component),digests[p.component]);
  if (command === 'validate') return;
  await currentMain();
  if (command === 'tag') {
    // Precheck the full set before the first mutation. REST ref writes are NOT atomic.
    for (const p of plans) await absent(p);
    for (const p of plans) {
      await api('git/refs','POST',{ref:`refs/tags/${p.tag}`,sha:p.sha});
      console.log(`Created ${p.tag} at ${p.sha}; do not retry a partially completed promotion.`);
    }
    return;
  }
  if (command !== 'publish') throw Error('Unknown candidate command');
  // Precheck all selected releases/tags before any public write.
  for (const p of plans) {
    const ref = await api(`git/ref/tags/${p.tag}`);
    if (ref?.object.type !== 'commit' || ref.object.sha !== p.sha || await api(`releases/tags/${p.tag}`)) throw Error('Tag mismatch or existing release');
  }
  for (const p of plans) {
    const directory = path.join(root,'candidate',p.component);
    const payload = await signatures(p,directory);
    if (p.component === 'server') {
      const image = `${payload.image}:${p.version}`;
      // Registry status must be exactly 404, never an auth/network failure.
      const tokenResponse = await fetch('https://ghcr.io/token?service=ghcr.io&scope=repository:ilyarusskikh/pawtalk-server:pull',{signal:AbortSignal.timeout(60000),headers:{Authorization:'Basic '+Buffer.from(`${process.env.GITHUB_ACTOR}:${process.env.GH_TOKEN}`).toString('base64')}});
      if (!tokenResponse.ok) throw Error('Registry authorization failed');
      const token = (await tokenResponse.json()).token;
      const response = await fetch(`https://ghcr.io/v2/ilyarusskikh/pawtalk-server/manifests/${p.version}`,{signal:AbortSignal.timeout(60000),headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.oci.image.index.v1+json'}});
      if (response.status !== 404) throw Error('Image exists or registry unavailable');
      // Credentials go through a temporary auth file, never argv/logs.
      const authFile = path.join(process.env.RUNNER_TEMP,'pawtalk-registry-auth.json');
      await writeFile(authFile,JSON.stringify({auths:{'ghcr.io':{auth:Buffer.from(`${process.env.GITHUB_ACTOR}:${process.env.GH_TOKEN}`).toString('base64')}}}),{mode:0o600});
      try {
        run('skopeo',['copy','--all','--preserve-digests','--authfile',authFile,`oci-archive:${path.join(directory,'server-image.tar')}`,`docker://${image}`]);
        const raw = execFileSync('skopeo',['inspect','--authfile',authFile,'--raw',`docker://${image}`]);
        if ('sha256:'+hash(raw) !== payload.digest) throw Error('Published OCI digest differs');
      } finally { await (await import('node:fs/promises')).rm(authFile,{force:true}); }
    }
    const notes = path.join(root,`docs/releases/${p.tag}.md`);
    const title = (await readFile(notes,'utf8')).split(/\r?\n/)[0].replace(/^# /,'');
    const flags = ['--latest=false',...(p.channel === 'preview' ? ['--prerelease'] : [])];
    const assets = assetNames(p.component,p.version).filter(n=>n !== 'server-image.tar').map(n=>path.join(directory,n));
    run('gh',['release','create',p.tag,'--verify-tag','--draft','--repo',p.repository,...flags,'--title',title,'--notes-file',notes,...assets]);
    run('gh',['release','edit',p.tag,'--repo',p.repository,'--draft=false',...flags]);
    const published = await api(`releases/tags/${p.tag}`);
    if (!published || published.draft || published.prerelease !== (p.channel === 'preview')) throw Error('Incomplete published release');
    for (const name of assetNames(p.component,p.version).filter(n=>n !== 'server-image.tar')) {
      const asset = published.assets.find(a=>a.name === name);
      const local = await fileDigest(path.join(directory,name));
      if (!asset || asset.size !== local.size || asset.digest !== 'sha256:'+local.sha256) throw Error('Published asset verification failed: '+name);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
