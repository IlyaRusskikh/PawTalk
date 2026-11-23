const { createPrivateKey } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { runLiveRotation, runArchiveRotation } = require('../electron/protected-archive-session.cjs');
const { ProtectedPolicyCheckpoint } = require('../electron/protected-policy-checkpoint.cjs');
const { deviceAgreementPrivateKey } = require('../electron/protected-device-agreement.cjs');

async function main() {
  const { trust, policy, requests } = JSON.parse(readFileSync(0, 'utf8'));
  const values = new Map();
  const checkpoint = new ProtectedPolicyCheckpoint({ async load(id) { return values.get(id); },
    async save(id, value) { values.set(id, value); } });
  const fetchPolicyPage = async after => ({ ...policy, proofs: policy.proofs.slice(after) });
  await checkpoint.accept(policy, trust, fetchPolicyPage);
  const device = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 0x65)]),
    type: 'pkcs8', format: 'der' });
  const privateKey = deviceAgreementPrivateKey('0b'.repeat(32));
  const results = [];
  const started = performance.now();
  for (const { task, targets } of requests) {
    const rotate = task.Purpose === 'archive' ? runArchiveRotation : runLiveRotation;
    await rotate({ serverId: trust.serverId, channelId: task.ChannelID, profileId: trust.ownerProfileId,
      identity: { deviceId: trust.ownerDeviceId, device }, privateKey,
      claim: async () => task,
      authorizeTask: pending => checkpoint.authorizeRotation(pending, trust, trust.ownerProfileId, trust.ownerDeviceId),
      authorizeEpoch: (epoch, context) => checkpoint.authorizeEpoch(epoch, trust, fetchPolicyPage, context),
      loadTargets: async (_task, batch) => batch.map(target => targets[target.KeyID]),
      commit: async (record, packages, links) => { results.push({ record, packages, links }); },
    });
  }
  process.stdout.write(JSON.stringify({ results, elapsedMs: Math.round(performance.now() - started) }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
