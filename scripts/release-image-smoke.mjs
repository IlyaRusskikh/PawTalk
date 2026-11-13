// Local-only registry: proves multi-platform OCI preparation/copy preserves the signed index.
// Never authenticates to or pushes to GHCR. Requires Docker; downloaded tools stay in a temporary image.
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const directory = await mkdtemp(path.join(tmpdir(), 'pawtalk-oci-'));
const name = `pawtalk-oci-${randomUUID()}`;
const docker = async args => (await exec('docker', args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
try {
  await writeFile(path.join(directory, 'Dockerfile'), 'FROM scratch\nCOPY marker /marker\n');
  await writeFile(path.join(directory, 'marker'), 'synthetic release image, no production code or secrets\n');
  await writeFile(path.join(directory, 'Tools.Dockerfile'), 'FROM debian:12-slim\nRUN apt-get update && apt-get install -y --no-install-recommends skopeo ca-certificates && rm -rf /var/lib/apt/lists/*\nENTRYPOINT ["skopeo"]\n');
  await docker(['build', '-f', path.join(directory, 'Tools.Dockerfile'), '-t', name, directory]);
  await docker(['buildx', 'create', '--name', name, '--driver', 'docker-container']);
  await docker(['buildx', 'build', '--builder', name, '--platform', 'linux/amd64,linux/arm64', '--provenance=mode=min', '--output', `type=oci,dest=${path.join(directory, 'image.tar')}`, directory]);
  await docker(['network', 'create', name]);
  await docker(['run', '-d', '--name', name, '--network', name, 'registry:3']);
  const skopeo = args => docker(['run', '--rm', '--network', name, '--mount', `type=bind,source=${directory},target=/qa`, name, ...args]);
  // Write raw bytes inside Linux rather than transforming stdout/newlines in the host shell.
  await docker(['run', '--rm', '--network', name, '--mount', `type=bind,source=${directory},target=/qa`, '--entrypoint', 'sh', name, '-ec',
    `skopeo inspect --raw oci-archive:/qa/image.tar > /qa/before.json
skopeo copy --all --preserve-digests --dest-tls-verify=false oci-archive:/qa/image.tar docker://${name}:5000/pawtalk-test:1.0.0
skopeo inspect --tls-verify=false --raw docker://${name}:5000/pawtalk-test:1.0.0 > /qa/after.json`]);
  const before = await readFile(path.join(directory, 'before.json'));
  const after = await readFile(path.join(directory, 'after.json'));
  assert.deepEqual(after, before, 'Registry index bytes must equal prepared signed bytes');
  const index = JSON.parse(before);
  assert.deepEqual(index.manifests.map(entry => entry.platform.architecture).filter(arch => arch !== 'unknown').sort(), ['amd64', 'arm64']);
  assert.ok(index.manifests.some(entry => entry.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest'), 'Retain BuildKit provenance as in the release workflow');
  for (const manifest of index.manifests) await skopeo(['inspect', '--tls-verify=false', '--raw', `docker://${name}:5000/pawtalk-test@${manifest.digest}`]);
  console.log(`PASS local OCI registry roundtrip: linux/amd64 + linux/arm64; sha256:${createHash('sha256').update(before).digest('hex')}`);
} finally {
  for (const args of [['rm', '-f', name], ['network', 'rm', name], ['buildx', 'rm', name], ['image', 'rm', name]]) {
    await docker(args).catch(() => {}); // Only uniquely named disposable resources owned by this check.
  }
  await rm(directory, { recursive: true, force: true });
}
