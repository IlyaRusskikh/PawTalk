const { openSignedRecoveryEpochPackage } = require('./protected-epoch-packages.cjs');

const fail = () => Object.assign(new Error('UNVERIFIED_EPOCH_RECIPIENT'), { code: 'UNVERIFIED_EPOCH_RECIPIENT' });

// The recovery key is supplied locally and used for the exact leased target.
// Folding that target into an archive always requires full history today.
async function openRecoveryArchiveTarget(delivery, context, profileId, recovery, authorizeEpoch) {
  if (!recovery || delivery.Package?.RecipientID !== context.recipientId || context.recipientId !== recovery.recoveryId ||
      context.recipientKey !== recovery.agreementKey || typeof recovery.authorizeRecipient !== 'function') {
    throw fail();
  }
  const expected = { serverId: context.serverId, profileId, channelId: context.channelId,
    recipientId: context.recipientId, recipientKey: context.recipientKey, kind: 'recovery', purpose: 'archive' };
  const authorize = () => recovery.authorizeRecipient(expected, delivery.textPolicy, delivery.previousRecoveryPolicy);
  await authorize();
  const signer = await authorizeEpoch(delivery.Epoch, context, delivery);
  const secret = openSignedRecoveryEpochPackage(delivery, context, recovery.agreement, signer);
  try {
    await authorize();
    return secret;
  } catch (error) {
    secret.fill(0);
    throw error;
  }
}

module.exports = { openRecoveryArchiveTarget };
