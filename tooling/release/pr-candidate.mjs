// Import PR packages as data on trusted main. Signing stays in the release jobs.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { api, assetNames, checkCoreReceipt, compareWindowsCores, selection, trusted } from './release-candidate.mjs';
import { versions } from './release-contract.mjs';
import { downloadArtifact, jobFor, list, oneArtifact, repository, sourceRunId, verificationJobs, windowsArtifactJobs } from './candidate-origin.mjs';

const workflowPath = '.github/workflows/check.yml';
const proofName = 'pawtalk-pr-build';
const shaPattern = /^[a-f0-9]{40}$/;

function checkRun(source, workflow, id) {
  if (source?.id !== id || source.name !== 'Verify and package' || source.path !== workflowPath ||
      workflow?.path !== workflowPath || source.workflow_id !== workflow.id || !Number.isSafeInteger(workflow.id) || workflow.id < 1 ||
      source.repository?.full_name !== repository || source.head_repository?.full_name !== repository ||
      !Number.isSafeInteger(source.repository.id) || source.repository.id < 1 || source.repository.id !== source.head_repository.id ||
      source.event !== 'pull_request' || source.status !== 'completed' || source.conclusion !== 'success' ||
      !shaPattern.test(source.head_sha ?? '') || !source.head_branch ||
      !Number.isSafeInteger(source.run_attempt) || source.run_attempt < 1) throw Error('Expected a successful same-repository PR check run');
}

export async function inspectPR(request, runId, mainSha, readProof) {
  const id = sourceRunId(runId);
  if (!shaPattern.test(mainSha ?? '')) throw Error('Invalid main SHA');
  const [source, workflow, main] = await Promise.all([
    request(`actions/runs/${id}`), request('actions/workflows/check.yml'), request(`git/commits/${mainSha}`),
  ]);
  checkRun(source, workflow, id);
  const [jobs, artifacts] = await Promise.all([
    list(request, `actions/runs/${id}/attempts/${source.run_attempt}/jobs`, 'jobs'),
    list(request, `actions/runs/${id}/artifacts`, 'artifacts'),
  ]);
  if (jobs.length !== verificationJobs.length) throw Error('Incomplete PR verification matrix');
  for (const name of verificationJobs) jobFor(jobs, name, source);
  const clientJob = jobFor(jobs, windowsArtifactJobs.client, source);
  const serverJob = jobFor(jobs, windowsArtifactJobs.server, source);
  const proofArtifact = oneArtifact(artifacts, proofName, source, clientJob);
  const proof = await readProof(proofArtifact);
  if (proof?.schema !== 1 || !Number.isSafeInteger(proof.pr) || proof.pr < 1 || !shaPattern.test(proof.checkout ?? '')) throw Error('Invalid PR checkout evidence');
  const [pr, checkout] = await Promise.all([request(`pulls/${proof.pr}`), request(`git/commits/${proof.checkout}`)]);
  if (pr?.number !== proof.pr || pr.merged !== true || pr.merge_commit_sha !== mainSha ||
      pr.base?.ref !== 'main' || pr.base.repo?.id !== source.repository.id ||
      pr.head?.repo?.id !== source.repository.id || pr.head.sha !== source.head_sha || pr.head.ref !== source.head_branch ||
      checkout?.sha !== proof.checkout || checkout.parents?.length !== 2 || checkout.parents[1].sha !== source.head_sha ||
      main?.sha !== mainSha || main.parents?.length !== 1 || checkout.parents[0].sha !== main.parents[0].sha ||
      !shaPattern.test(main.tree?.sha ?? '') || checkout.tree?.sha !== main.tree.sha) throw Error('PR checkout does not match the exact main merge tree');
  const artifact = name => oneArtifact(artifacts, name, source, name === 'pawtalk-server-windows' ? serverJob : clientJob);
  return { source, proof, tree: main.tree.sha, proofArtifact, artifact };
}

async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

export async function importPR({request, runId, mainSha, components, version, directory, download = downloadArtifact}) {
  if (!components.length || components.some(c => !['client', 'server'].includes(c))) throw Error('PR reuse is available for Client and Server');
  const result = await inspectPR(request, runId, mainSha, async artifact => {
    const folder = path.join(directory, 'proof');
    await download(artifact, folder, ['source.json']);
    return JSON.parse(await readFile(path.join(folder, 'source.json'), 'utf8'));
  });
  const imported = {};
  let receipt;
  async function copy(name, folder, files) {
    const artifact = result.artifact(name);
    await download(artifact, path.join(directory, folder), files);
    imported[name] = {id: artifact.id, digest: artifact.digest};
  }
  if (components.includes('client')) {
    const [installer, licenses, sums] = assetNames('client', version.client);
    await copy('pawtalk-windows', 'client', [installer, licenses, sums]);
    const client = path.join(directory, 'client');
    const digest = await sha256(path.join(client, installer));
    if ((await readFile(path.join(client, sums), 'utf8')).trim() !== `${digest}  ${installer}`) throw Error('PR Client checksum mismatch');
    await copy('pawtalk-client-core', 'client-core', ['bundled-server.json']);
    receipt = JSON.parse(await readFile(path.join(directory, 'client-core', 'bundled-server.json'), 'utf8'));
    await checkCoreReceipt(receipt);
  }
  if (components.includes('server')) {
    const [zip] = assetNames('server', version.server);
    await copy('pawtalk-server-windows', 'server', [zip]);
    if (receipt) compareWindowsCores(receipt, path.join(directory, 'server', zip));
  }
  const latest = await request(`actions/runs/${result.source.id}`);
  if (latest?.run_attempt !== result.source.run_attempt || latest?.status !== 'completed' || latest?.conclusion !== 'success') throw Error('PR run changed during import');
  return {run: result.source.id, attempt: result.source.run_attempt, pr: result.proof.pr, checkout: result.proof.checkout, tree: result.tree,
    proofArtifact: {id: result.proofArtifact.id, digest: result.proofArtifact.digest}, artifacts: imported};
}

async function main() {
  const command = process.argv[2];
  if (command === 'record') {
    if (process.env.GITHUB_EVENT_NAME !== 'pull_request') throw Error('PR checkout required');
    const checkout = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    if (checkout !== process.env.GITHUB_SHA || !shaPattern.test(checkout)) throw Error('Unexpected PR checkout');
    await mkdir('release/pr-build', {recursive: true});
    await writeFile('release/pr-build/source.json', JSON.stringify({schema: 1, pr: sourceRunId(process.env.PR_NUMBER), checkout}));
    return;
  }
  if (command !== 'import') throw Error('Expected record or import');
  trusted(process.env);
  const runId = process.env.PR_RUN_ID;
  if (!runId) return;
  let evidence;
  try {
    evidence = await importPR({request: api, runId, mainSha: process.env.GITHUB_SHA, components: selection(process.env.COMPONENTS),
      version: await versions(), directory: path.join('release', 'pr-reuse')});
  } catch (error) {
    console.log('PR reuse unavailable; running full verification. '+error.message);
    return;
  }
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Verified PR artifact import\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n`);
  await appendFile(process.env.GITHUB_OUTPUT, 'ready=true\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
