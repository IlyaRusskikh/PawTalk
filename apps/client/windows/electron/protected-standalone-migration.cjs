const { createMigrationRecoveryCode } = require('./protected-migration-recovery.cjs');
const { runProtectedMigrationResume, runProtectedMigrationRecoveryArchive, retryThrottled } = require('./protected-migration-resume.cjs');

const recoveryBundleSlot = serverId => `pawtalk:standalone-migration-bundle:v1:${serverId}`;

async function runStandaloneProtectedMigration(client, serverId, archiveSha256) {
  const checkpoint = await retryThrottled(() => client.protectedStandaloneMigrationCheckpoint(serverId));
  if (checkpoint.archiveSha256 !== archiveSha256) throw Object.assign(
    Error('MIGRATION_CHECKPOINT_CHANGED'), { code: 'MIGRATION_CHECKPOINT_CHANGED' });
  const policy = await retryThrottled(() => client.protectedMigrationPolicyDraft(serverId, archiveSha256));
  const { ownerProfileId } = policy;
  const recoverySlot = `pawtalk:standalone-migration-code:v1:${serverId}:${archiveSha256}`;
  let code = await client.credentials.load(recoverySlot, { required: true });
  if (!code) {
    if (policy.ownerRecovery) throw Object.assign(Error('MIGRATION_RECOVERY_CODE_MISSING'), { code: 'MIGRATION_RECOVERY_CODE_MISSING' });
    code = createMigrationRecoveryCode();
    await client.credentials.save(recoverySlot, code);
  }
  if (!policy.ownerRecovery) await retryThrottled(() => client.enrollProtectedMigrationRecovery(serverId, { archiveSha256, ownerProfileId, code }));
  await runProtectedMigrationResume(client, serverId, archiveSha256);
  await runProtectedMigrationRecoveryArchive(client, serverId, archiveSha256, code);

  const control = (action, payload) => retryThrottled(() => client.protectedStandaloneMigrationControl(serverId, archiveSha256, action, payload));
  let report = await control('report');
  if (!report.ownerRecipient) {
    const approval = await retryThrottled(() => client.signProtectedMigrationImportReview(serverId, {
      report, confirmedReviewDigest: report.reviewDigest,
    }));
    await control('approve-import', approval);
    await retryThrottled(() => client.enrollProtectedMigrationOwnerRecipient(serverId, { archiveSha256, ownerProfileId, reviewDigest: report.reviewDigest }));
    report = await control('report');
  }
  const policyApproval = await retryThrottled(() => client.signProtectedMigrationInitialPolicy(serverId, {
    report, confirmedReviewDigest: report.reviewDigest,
  }));
  if (!report.policyAnchorDigest) await control('stage-policy', policyApproval);
  for (const [channelId, channel] of Object.entries(policy.state.Channels)) {
    if (channel.Kind === 'text') await retryThrottled(() => client.prepareProtectedMigrationChannelKeys(serverId, {
      archiveSha256, ownerProfileId, channelId, policyApproval, code,
    }));
  }
  report = await control('report');
  const approval = await retryThrottled(() => client.signProtectedMigrationCutover(serverId, {
    report, policyApproval, confirmedCutoverDigest: report.cutoverDigest,
  }));
  const recoveryBundle = await client.prepareProtectedMigrationRecoveryBundle(serverId, code);
  await client.credentials.save(recoveryBundleSlot(serverId), recoveryBundle);
  await control('approve-cutover', approval);
  return { recoveryBundle };
}

module.exports = { runStandaloneProtectedMigration, recoveryBundleSlot };
