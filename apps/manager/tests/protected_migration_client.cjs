const assert = require('node:assert/strict');
const { X509Certificate } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { MembershipClient } = require('../../client/windows/electron/membership-client.cjs');
const { runProtectedMigrationResume, runProtectedMigrationRecoveryArchive } = require('../../client/windows/electron/protected-migration-resume.cjs');
const { createMigrationRecoveryCode } = require('../../client/windows/electron/protected-migration-recovery.cjs');
const { createPinnedFixtureFetch } = require('../../client/windows/scripts/protected-fixture-fetch.cjs');

async function runMigrationPhase(client, { phase, serverId, archiveSha256, ownerProfileId, report, policyApproval, cutoverDigest, expectedText }) {
  const { credentials } = client;
  const recoverySlot = 'test:protected-migration-recovery';
  switch (phase) {
    case 'import': {
      const code = createMigrationRecoveryCode();
      await credentials.save(recoverySlot, code);
      await client.enrollProtectedMigrationRecovery(serverId, { archiveSha256, ownerProfileId, code });
      await runProtectedMigrationResume(client, serverId, archiveSha256);
      return runProtectedMigrationRecoveryArchive(client, serverId, archiveSha256, code);
    }
    case 'review':
      return client.signProtectedMigrationImportReview(serverId, { report, confirmedReviewDigest: report.reviewDigest });
    case 'recipient':
      return client.enrollProtectedMigrationOwnerRecipient(serverId, { archiveSha256, ownerProfileId, reviewDigest: report.reviewDigest });
    case 'policy':
      return client.signProtectedMigrationInitialPolicy(serverId, { report, confirmedReviewDigest: report.reviewDigest });
    case 'keys': {
      const { state } = await client.protectedMigrationPolicyDraft(serverId, archiveSha256);
      const code = await credentials.load(recoverySlot);
      for (const [channelId, channel] of Object.entries(state.Channels)) {
        if (channel.Kind === 'text') {
          await client.prepareProtectedMigrationChannelKeys(serverId, { archiveSha256, ownerProfileId, channelId, policyApproval, code });
        }
      }
      return true;
    }
    case 'approve': {
      const approval = await client.signProtectedMigrationCutover(serverId, { report, policyApproval, confirmedCutoverDigest: report.cutoverDigest });
      if (report.initialPolicy.runtimeRecovery) {
        assert.equal(approval.scopeAuthority.policyHead, report.policyAnchorDigest);
        const code = await credentials.load(recoverySlot);
        assert.match(await client.prepareProtectedMigrationRecoveryBundle(serverId, code), /^pawtalk-recovery-v1\./);
        assert.ok(!JSON.stringify(approval).includes(code));
      }
      return approval;
    }
    case 'verify': {
      const session = await client.openStoredProtectedRuntime(serverId);
      assert.equal(session.cutoverDigest, cutoverDigest);
      const state = await client.readProtectedRuntimeState(session);
      const channel = state.channels.find(entry => entry.kind === 'text');
      assert.ok(channel);
      const history = await client.readProtectedChatPage(session, channel.id, 0);
      assert.ok(history.messages.some(message => message.text === expectedText));
      const legacy = await client.fetcher(session.base + '/api/v2/state', { pawtalkTLSFingerprint: session.fingerprint });
      assert.equal(legacy.status, 404);
      return true;
    }
    default:
      throw new Error('Unknown protected migration test phase');
  }
}

async function main() {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  const { file, address, certificate } = request;
  const base = new URL('https:' + address.slice('pawtalk:'.length)).origin;
  const fingerprint = address.split('/').at(-1);
  assert.equal(new X509Certificate(certificate).fingerprint256.replaceAll(':', '').toLowerCase(), fingerprint);
  const entries = JSON.parse(readFileSync(file, 'utf8'));
  const credentials = {
    async load(key) { return entries[key] ?? null; },
    async save(key, value) {
      entries[key] = value;
      writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
    },
  };
  const fetcher = createPinnedFixtureFetch(base, certificate);
  const client = new MembershipClient({
    credentials, fetcher, async verify(value) { assert.equal(value, address); return fingerprint; }, async trust() {},
  });
  return runMigrationPhase(client, { ...request, expectedText: 'Linux host encrypted lifecycle fixture' });
}

if (require.main === module) {
  main().then(result => process.stdout.write(JSON.stringify(result)), error => {
    console.error(error.stack);
    process.exitCode = 1;
  });
}

module.exports = { runMigrationPhase };
