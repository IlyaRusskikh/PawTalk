const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { MembershipClient } = require('../electron/membership-client.cjs');
const { deriveRecoveryIdentity } = require('../electron/protected-migration-recovery.cjs');
const { createPinnedFixtureFetch } = require('./protected-fixture-fetch.cjs');

const data = JSON.parse(readFileSync(0, 'utf8'));
const { serverId, channelId, owner, policyTrust } = data;
const secrets = new Map([
  ['pawtalk:identity:v2', JSON.stringify({ root: '01'.repeat(32), device: '65'.repeat(32) })],
  [`pawtalk:agreement:v1:${serverId}:${owner.deviceId}`, '0b'.repeat(32)],
]);
const pinnedFetch = createPinnedFixtureFetch(data.base, data.certificate);
const requests = [];
const client = new MembershipClient({
  credentials: { load: async key => secrets.get(key), save: async (key, value) => secrets.set(key, value) },
  fetcher: async (url, options) => {
    const response = await pinnedFetch(url, options);
    requests.push({
      method: options.method,
      path: new URL(url).pathname,
      request: [url, JSON.stringify(options.headers), options.body ?? ''].join('\n'),
      response: await response.clone().text(),
    });
    return response;
  },
});
const connection = { ...owner, serverId, policyTrust, cutoverDigest: policyTrust.cutoverDigest,
  base: data.base, fingerprint: data.fingerprint };

async function main() {
  await client.rotateProtectedRuntimeText(connection, channelId, 'live');
  const opened = await client.withCurrentProtectedChatPolicy(connection, options =>
    client.loadProtectedRuntimeKey(connection, channelId, 'live', options));
  const liveKey = opened.secret.toString('hex');
  const liveKeyBytes = Buffer.from(opened.secret);
  opened.secret.fill(0);
  const operation = '2'.repeat(32);
  const contents = Buffer.from(data.attachment);
  const attachmentId = await client.stageProtectedAttachment(connection, channelId, operation, 0, {
    name: data.filename, mime: 'application/octet-stream', bytes: contents,
  });
  const receipt = await client.withCurrentProtectedChatPolicy(connection, options =>
    client.sendProtectedRuntimeText(connection, channelId, data.message, operation, options,
      undefined, undefined, undefined, [attachmentId]));
  assert.equal(receipt.Position, 1);
  const original = await client.readProtectedChatReference(connection, channelId, receipt.Position);
  assert.ok(original?.text === data.message, 'message did not decrypt locally');
  assert.ok(original?.files?.some(file => file.id === attachmentId && file.name === data.filename), 'filename did not decrypt locally');
  const file = await client.readProtectedFile(connection, channelId, receipt.Position, attachmentId);
  assert.ok(contents.equals(Buffer.from(file)), 'attachment did not decrypt locally');

  await client.setProtectedMessagePin(connection, channelId, receipt.Position, true);
  await client.enrollProtectedRuntimeRecovery(connection, data.recoveryCode, policyTrust.anchorDigest);
  const recovery = deriveRecoveryIdentity(data.recoveryCode, serverId, owner.profileId);
  const coverage = await client.readProtectedRecoveryCoverage(connection);
  assert.equal(coverage.recoveryId, recovery.recoveryId);
  const privateBytes = key => key.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const recoverySigning = privateBytes(recovery.signing);
  const recoveryAgreement = privateBytes(recovery.agreement);
  const audit = await client.readProtectedAudit(connection);
  assert.ok(audit.entries.some(entry => entry.action === 'message.pin' && entry.actor === owner.profileId &&
    entry.channelId === channelId && entry.position === receipt.Position), 'audit omitted approved pin metadata');
  assert.ok(audit.entries.some(entry => entry.action === 'recovery.enroll' && entry.actor === owner.profileId),
    'audit omitted approved recovery enrollment metadata');
  const state = await client.readProtectedRuntimeState(connection);
  assert.ok(state.channels.some(channel => channel.id === channelId && channel.name === data.channelName),
    'state omitted approved channel metadata');

  for (const [method, path] of [
    ['PUT', `/api/v3/history/live-attachments/${channelId}/${attachmentId}`],
    ['POST', `/api/v3/history/live/${channelId}`],
    ['GET', `/api/v3/history/live-attachments/${channelId}/${receipt.Position}/${attachmentId}`],
    ['POST', '/api/v3/recovery/enroll'],
    ['GET', '/api/v3/audit'],
  ]) {
    assert.ok(requests.some(request => (request.method ?? 'GET') === method && request.path === path), `missing TLS exchange for ${path}`);
  }
  try {
    for (const [label, marker] of Object.entries({
      message: Buffer.from(data.message), filename: Buffer.from(data.filename), attachment: contents, 'live key': liveKeyBytes,
      'recovery code': Buffer.from(data.recoveryCode, 'base64url'), 'recovery signing key': recoverySigning,
      'recovery agreement key': recoveryAgreement,
    })) {
      for (const encoding of ['utf8', 'hex', 'base64', 'base64url']) {
        const secret = marker.toString(encoding);
        for (const { path, request, response } of requests) {
          assert.ok(!request.includes(secret) && !response.includes(secret), `${label} leaked in TLS exchange for ${path}`);
        }
      }
    }
    // Send synthetic observations only through the private parent fixture pipe.
    process.stdout.write(JSON.stringify({ attachmentId, recoveryId: recovery.recoveryId, liveKey, recoverySigning: recoverySigning.toString('hex'),
      recoveryAgreement: recoveryAgreement.toString('hex') }));
  } finally {
    liveKeyBytes.fill(0);
    recoverySigning.fill(0);
    recoveryAgreement.fill(0);
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n${error.stack}\n`);
  process.exitCode = 1;
});
