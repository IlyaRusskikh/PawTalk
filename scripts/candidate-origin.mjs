// GitHub API evidence and immutable artifact transport; never builds, signs or publishes.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const repository = 'IlyaRusskikh/PawTalk';
const workflowPath = '.github/workflows/release.yml';
const families = ['client', 'server', 'manager'];
const digestPattern = /^sha256:[a-f0-9]{64}$/;
export function sourceRunId(value) {
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || String(Number(value)) !== String(value)) throw Error('Invalid source_run_id');
  return Number(value);
}
export function verifyRun(source, workflow, sha) {
  if (!Number.isSafeInteger(source.id) || source.id < 1 || !Number.isSafeInteger(source.repository?.id) || source.repository.id < 1 ||
      !Number.isSafeInteger(workflow.id) || workflow.id < 1 || source.repository?.full_name !== repository || source.head_repository?.full_name !== repository ||
      source.repository.id !== source.head_repository.id || source.event !== 'workflow_dispatch' || source.head_branch !== 'main' ||
      source.path !== workflowPath || source.name !== 'Release Candidate Preflight' || workflow.path !== workflowPath ||
      source.workflow_id !== workflow.id || source.status !== 'completed' || source.conclusion !== 'success' ||
      !Number.isSafeInteger(source.run_attempt) || source.run_attempt < 1 || !/^[a-f0-9]{40}$/.test(sha) || source.head_sha !== sha) {
    throw Error('Source must be successful approved main Preflight at the exact current SHA');
  }
}
function jobFor(jobs, name, source, conclusion = 'success') {
  const matches = jobs.filter(job => job.name === name);
  if (matches.length !== 1) throw Error('Missing/ambiguous source job: '+name);
  const job = matches[0];
  if (job.run_id !== source.id || job.run_attempt !== source.run_attempt || job.head_sha !== source.head_sha ||
      job.status !== 'completed' || job.conclusion !== conclusion) throw Error('Failed or mixed-attempt source job: '+name);
  return job;
}
export function verifyJobs(jobs, source, components) {
  for (const name of ['plan','infrastructure','preflight','report']) jobFor(jobs,name,source);
  jobFor(jobs,'tag',source,'skipped');
  for (const c of families) {
    const selected = components.includes(c);
    jobFor(jobs,'prepare-'+c,source,selected ? 'success' : 'skipped');
    jobFor(jobs,'publish-'+c,source,'skipped');
    const prefix = `verify (${c}) / `;
    const children = jobs.filter(job=>job.name.startsWith(prefix));
    if (!selected) { if (children.length) throw Error('Unexpected verification component'); continue; }
    const expected = ['infrastructure','server (ubuntu-24.04)','server (ubuntu-24.04-arm)','windows (windows-2022)','windows (windows-2025)'];
    if (children.length !== expected.length) throw Error('Incomplete component verification matrix');
    for (const suffix of expected) jobFor(jobs,prefix+suffix,source,suffix === 'infrastructure' ? 'skipped' : 'success');
  }
}
export function verifyArtifact(artifact, source, job, now = Date.now()) {
  const owner = artifact?.workflow_run;
  if (!artifact || !Number.isSafeInteger(artifact.id) || artifact.id < 1 || artifact.expired !== false ||
      !digestPattern.test(artifact.digest) || !(Date.parse(artifact.expires_at) > now) ||
      owner?.id !== source.id || owner.head_sha !== source.head_sha || owner.head_branch !== 'main' ||
      owner.repository_id !== source.repository.id || owner.head_repository_id !== source.repository.id ||
      !(Date.parse(artifact.created_at) >= Date.parse(job.started_at)) ||
      !(Date.parse(artifact.created_at) <= Date.parse(job.completed_at))) throw Error('Missing, expired or foreign-attempt artifact');
  return artifact;
}
function oneArtifact(artifacts, name, source, job) {
  const matches = artifacts.filter(artifact=>artifact.name === name);
  if (matches.length !== 1) throw Error('Missing/ambiguous artifact: '+name);
  return verifyArtifact(matches[0],source,job);
}
export function verifyIndex(index, source) {
  const origin = {repository,sha:source.head_sha,run:String(source.id),attempt:String(source.run_attempt)};
  if (index.schema !== 1 || index.workflow !== workflowPath ||
      Object.entries(origin).some(([key,value])=>index[key] !== value) || !Array.isArray(index.components) ||
      !index.components.length || JSON.stringify(index.components) !== JSON.stringify(families.filter(c=>index.components.includes(c))) ||
      JSON.stringify(Object.keys(index.receipts ?? {}).sort()) !== JSON.stringify([...index.components].sort()) ||
      JSON.stringify(Object.keys(index.plans ?? {}).sort()) !== JSON.stringify([...index.components].sort())) throw Error('Invalid source candidate index');
  for (const c of index.components) {
    const p = index.plans[c];
    if (Object.entries(origin).some(([key,value])=>p[key] !== value) || p.component !== c ||
        !/^[a-f0-9]{64}$/.test(index.receipts[c]) || !['preview','stable'].includes(p.channel) || p.tag !== `${c}-v${p.version}`) throw Error('Invalid indexed component');
  }
  return index;
}
async function list(api, endpoint, key) {
  const entries = [];
  for (let page=1;page<=100;page++) {
    const response = await api(`${endpoint}?per_page=100&page=${page}`);
    if (!response || !Array.isArray(response[key]) || !Number.isSafeInteger(response.total_count)) throw Error('Incomplete source API response');
    entries.push(...response[key]);
    if (entries.length === response.total_count) return entries;
    if (!response[key].length || entries.length > response.total_count) break;
  }
  throw Error('Source API pagination did not complete');
}
export async function inspectSource(api, runId, sha) {
  const id = sourceRunId(runId);
  const source = await api(`actions/runs/${id}`);
  const workflow = await api('actions/workflows/release.yml');
  if (!source || source.id !== id || !workflow) throw Error('Source Preflight unavailable');
  verifyRun(source,workflow,sha);
  const jobs = await list(api,`actions/runs/${id}/attempts/${source.run_attempt}/jobs`,'jobs');
  const preflight = jobFor(jobs,'preflight',source);
  const artifacts = await list(api,`actions/runs/${id}/artifacts`,'artifacts');
  const indexArtifact = oneArtifact(artifacts,'pawtalk-candidate-index',source,preflight);
  return {source,jobs,artifacts,indexArtifact};
}
export async function sourceCandidate(api, runId, sha, readIndex, pinned) {
  const evidence = await inspectSource(api,runId,sha);
  const {source,jobs,artifacts,indexArtifact} = evidence;
  const index = verifyIndex(await readIndex(indexArtifact),source);
  verifyJobs(jobs,source,index.components);
  const prepared = {};
  for (const c of index.components) prepared[c] = oneArtifact(artifacts,`pawtalk-${c}-prepared`,source,jobFor(jobs,'prepare-'+c,source));
  if (artifacts.some(artifact=>/^pawtalk-.*-prepared$/.test(artifact.name) && !index.components.some(c=>artifact.name === `pawtalk-${c}-prepared`))) throw Error('Unexpected prepared component artifact');
  const identity = a=>({id:a.id,digest:a.digest});
  const origin = {run:index.run,attempt:index.attempt,sha:index.sha,index:identity(indexArtifact),artifacts:Object.fromEntries(index.components.map(c=>[c,identity(prepared[c])]))};
  if (pinned && JSON.stringify(origin) !== JSON.stringify(pinned)) throw Error('Source identity or attempt changed since promotion plan');
  return {index,origin,prepared};
}
export async function confirmSource(api, origin) {
  const {source,jobs,artifacts,indexArtifact} = await inspectSource(api,origin.run,origin.sha);
  if (String(source.run_attempt) !== origin.attempt || indexArtifact.id !== origin.index.id || indexArtifact.digest !== origin.index.digest) throw Error('Source changed during promotion');
  const components = Object.keys(origin.artifacts);
  verifyJobs(jobs,source,components);
  for (const c of components) {
    const a = oneArtifact(artifacts,`pawtalk-${c}-prepared`,source,jobFor(jobs,'prepare-'+c,source));
    if (a.id !== origin.artifacts[c].id || a.digest !== origin.artifacts[c].digest) throw Error('Source artifact changed during promotion');
  }
}

// Verify the API's archive digest BEFORE parsing/extracting any source bytes.
export async function downloadArtifact(artifact, destination, names, {fetcher=fetch, token=process.env.GH_TOKEN} = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(),'pawtalk-import-'));
  const archive = path.join(temporary,'artifact.zip');
  const maxBytes = names.length === 1 && names[0] === 'candidate.json' ? 1024*1024 : 8*1024*1024*1024;
  try {
    const redirect = await fetcher(`https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`,{
      redirect:'manual',signal:AbortSignal.timeout(60000),headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'}});
    if (redirect.status !== 302) throw Error('Artifact download unavailable');
    const location = new URL(redirect.headers.get('location'));
    if (location.protocol !== 'https:' || location.username || location.password) throw Error('Unsafe artifact download redirect');
    // Signed storage URL receives no GitHub credentials. Do not log its query.
    const response = await fetcher(location,{signal:AbortSignal.timeout(15*60000)});
    if (!response.ok || !response.body) throw Error('Artifact storage unavailable');
    const digest = createHash('sha256');
    let size = 0;
    await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,encoding,callback) {
      size += chunk.length;
      if (size > maxBytes) return callback(Error('Artifact download limit exceeded'));
      digest.update(chunk); callback(null,chunk);
    }}),createWriteStream(archive,{flags:'wx'}));
    if (!size || 'sha256:'+digest.digest('hex') !== artifact.digest) throw Error('Artifact archive digest mismatch');
    const python = process.env.PAWTALK_PYTHON || (process.platform === 'win32' && process.env.pythonLocation ? path.join(process.env.pythonLocation,'python.exe') : 'python3');
    execFileSync(python,['-B','-I',path.join(import.meta.dirname,'extract-candidate.py'),archive,destination,String(maxBytes),...names],{windowsHide:true,stdio:'pipe'});
    if (!(await lstat(destination)).isDirectory()) throw Error('Artifact extraction failed');
  } finally { await rm(temporary,{recursive:true,force:true}); }
}
