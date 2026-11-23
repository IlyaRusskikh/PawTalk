const assert = require('node:assert/strict');
const { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { createPinnedFixtureFetch } = require('./protected-fixture-fetch.cjs');
const { MembershipClient } = require('../electron/membership-client.cjs');
const { openMigratedHistoryRecord } = require('../electron/protected-migration-content.cjs');
const { createMigrationRecoveryCode, openMigrationRecoveryPackage } = require('../electron/protected-migration-recovery.cjs');
const { openRecoveryBundle, createRecoveryBundle } = require('../electron/protected-recovery-bundle.cjs');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { openSignedMigrationHistoryLink } = require('../electron/protected-migration-archive-link.cjs');
const { openProtectedText, openProtectedReply } = require('../electron/protected-live-text.cjs');
const { sealProtectedRevision, openProtectedRevisionForArchive } = require('../electron/protected-text-revision.cjs');
const { protectedPolicySignatureFrame } = require('../electron/protected-policy-checkpoint.cjs');
const { profileRoleAuthorityProjectionVersion } = require('../electron/protected-channel-policy-commitments.cjs');
const { runStandaloneProtectedMigration, recoveryBundleSlot } = require('../electron/protected-standalone-migration.cjs');

const { base, serverId, archiveSha256, certificate, legacySecret, owner, admin, revoked, legacyBanned, legacyBannedAlias, review, recipient, testAgreementSeed,
  policyApproval, keyChannelId, testRecoveryCode, testArchiveSecret, testFirstLiveKeyId, policyProof, legacyConfig } = JSON.parse(readFileSync(0, 'utf8'));
const fingerprint = createHash('sha256').update(new X509Certificate(certificate).raw).digest('hex');
const address = base.replace('https:', 'pawtalk:') + '/' + fingerprint;

const pinnedFetch = createPinnedFixtureFetch(base, certificate);

function client(seeds, fetcher = pinnedFetch, agreementKeys = new Map()) {
  const values = new Map([
    ['pawtalk:memberships:v2', JSON.stringify([{ address, serverId, name: 'Synthetic migration' }])],
    ['pawtalk:identity:v2', JSON.stringify(seeds)],
    ['pawtalk:server:v2:' + serverId, JSON.stringify({ secret: legacySecret })],
  ]);
  return new MembershipClient({
    credentials: {
      async load(key) { return agreementKeys.has(key) ? agreementKeys.get(key) : values.get(key); },
      async save(key, value) {
        if (key === 'pawtalk:memberships:v2') agreementKeys.set(key, value);
        else {
          assert.match(key, /^pawtalk:(agreement|protected-policy(?:-scope)?|protected-epoch|protected-runtime|protected-invite|recovery-device|standalone-migration-(?:code|bundle)|migration-archive):v1:/);
          agreementKeys.set(key, value);
        }
      },
    }, fetcher,
    async verify(endpoint) { assert.equal(endpoint, address); return fingerprint; }, async trust() {},
  });
}

async function migrateStandalone(runningServer = false) {
  const ownerClient = client(owner);
  const checkpoint = await ownerClient.protectedStandaloneMigrationCheckpoint(serverId);
  assert.equal(checkpoint.archiveSha256, archiveSha256);
  await assert.rejects(client(admin).protectedStandaloneMigrationCheckpoint(serverId), { code: 'MIGRATION_DEVICE_DENIED' });
  const tampered = client(owner, (url, options) => pinnedFetch(url, !url.endsWith('/control/report') ? options : {
    ...options, body: JSON.stringify({ ...JSON.parse(options.body), archiveSha256: 'f'.repeat(64) }),
  }));
  await assert.rejects(tampered.protectedStandaloneMigrationControl(serverId, archiveSha256, 'report'),
    { code: 'MIGRATION_DEVICE_DENIED' });
  const result = await runStandaloneProtectedMigration(ownerClient, serverId, archiveSha256);
  assert.match(result.recoveryBundle, /^pawtalk-recovery-v1\./);
  assert.equal(await ownerClient.credentials.load(recoveryBundleSlot(serverId)), result.recoveryBundle);
  if (!runningServer) {
    const repeated = await runStandaloneProtectedMigration(ownerClient, serverId, archiveSha256);
    assert.equal(repeated.recoveryBundle, result.recoveryBundle);
    return;
  }
  let session;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { session = await ownerClient.openStoredProtectedRuntime(serverId); break; }
    catch (error) {
      if (attempt === 99 || ![404, 503].includes(error.status) &&
          !['ECONNREFUSED', 'ECONNRESET', 'ABORT_ERR'].includes(error.code)) throw error;
      await delay(150);
    }
  }
  const state = await ownerClient.readProtectedRuntimeState(session);
  assert.equal(state.canEditCommunity, true);
  const renamed = await ownerClient.renameProtectedCommunity(session, {
    name: 'Мигрировавший сервер 🙂', revision: state.community.revision,
  });
  assert.deepEqual((await ownerClient.readProtectedRuntimeState(session)).community, renamed);
  assert.equal((await ownerClient.discoverMembership(session.address, serverId)).config.name, renamed.name);
  const channel = state.channels.find(item => item.kind === 'text');
  const history = await ownerClient.readProtectedChatPage(session, channel.id, 0);
  assert.ok(history.messages.some(message => message.text === 'legacy history /9007199254740991'));
  const invitation = await ownerClient.createProtectedInvite(session, { maxUses: 1 });
  const recipientRoute = base + '/api/v3/migration/runtime-recipient';
  assert.equal((await pinnedFetch(recipientRoute, { headers: {}, pawtalkTLSFingerprint: fingerprint })).status, 401);
  let lostReply = false;
  const participant = client(admin, async (url, options) => {
    const response = await pinnedFetch(url, options);
    if (!lostReply && url === recipientRoute && options.method === 'POST' && JSON.parse(options.body).Signature && response.ok) {
      lostReply = true;
      throw Object.assign(new Error('Lost enrollment receipt'), { code: 'LOST_REPLY' });
    }
    return response;
  });
  const { profileId } = await participant.identity();
  const previous = await ownerClient.readProtectedOwnerPolicy(session);
  await assert.rejects(participant.redeemProtectedInvite(invitation.link, 'Existing participant'), { code: 'LOST_REPLY' });
  const resumed = await participant.redeemProtectedInvite(invitation.link, 'Existing participant');
  assert.equal(resumed.apiProtocolVersion, 3);
  assert.equal(resumed.profileId, profileId);
  assert.deepEqual((await ownerClient.readProtectedOwnerPolicy(session)).snapshot.Members[profileId], previous.snapshot.Members[profileId]);
  const reconnected = await participant.openStoredProtectedRuntime(serverId);
  assert.equal(reconnected.profileId, resumed.profileId);
  assert.equal((await participant.redeemProtectedInvite(invitation.link, 'Existing participant')).profileId, resumed.profileId);
  await ownerClient.syncProtectedPolicyAttestations(session);
  await ownerClient.rotateProtectedRuntimeText(session, channel.id, 'live');
  await ownerClient.rotateProtectedRuntimeText(session, channel.id, 'archive');
  const text = 'Existing participant can read after migration';
  await ownerClient.withCurrentProtectedChatPolicy(session, options =>
    ownerClient.sendProtectedRuntimeText(session, channel.id, text, randomBytes(16).toString('hex'), options));
  const resumedHistory = await participant.readProtectedChatPage(reconnected, channel.id, 0);
  assert.ok(resumedHistory.messages.some(message => message.text === text));
  assert.ok(resumedHistory.messages.some(message => message.text === 'legacy history /9007199254740991'));
  const guest = client({ root: 'a1'.repeat(32), device: 'b1'.repeat(32) });
  assert.equal((await guest.redeemProtectedInvite(invitation.link, 'New participant')).keysPending, true,
    'continuation must leave the invitation use available');
  process.stdout.write(JSON.stringify({ cutoverDigest: session.cutoverDigest }));
}

async function main() {
  let signed;
  const ownerClient = client(owner, async (url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    if (options.method === 'POST') signed = { url, options };
    return pinnedFetch(url, options);
  });
  const first = await ownerClient.readProtectedMigrationHistory(serverId, { kind: 'messages' });
  assert.equal(first.archiveSha256, archiveSha256);
  assert.equal(first.next, '9007199254740991');
  const initialProgress = await ownerClient.protectedMigrationProgress(serverId, archiveSha256);
  assert.equal(initialProgress.complete, false);
  assert.deepEqual(initialProgress.counts.messages, { source: 2, imported: 0 });
  const policy = await ownerClient.protectedMigrationPolicyDraft(serverId, archiveSha256);
  assert.deepEqual(policy.blockers, []);
  assert.equal(policy.administratorPending.length, 1);
  await assert.rejects(client(admin).protectedMigrationPolicyDraft(serverId, archiveSha256), { code: 'MIGRATION_DEVICE_DENIED' });
  const record = first.records[0], kind = 'messages', secret = randomBytes(32);
  assert.equal(policy.state.Channels[record.metadata.channelId].NextPosition, 3);
  const archive = { purpose: 'archive', channelId: record.metadata.channelId, generation: 1, secret,
    keyId: createHash('sha256').update(secret).digest('hex') };
  const migrated = await ownerClient.reencryptProtectedMigrationRecord(serverId, { archiveSha256, kind, archive, record });
  const retry = await ownerClient.reencryptProtectedMigrationRecord(serverId, { archiveSha256, kind, archive, record });
  const alternateSecret = randomBytes(32);
  const alternate = await ownerClient.reencryptProtectedMigrationRecord(serverId, { archiveSha256, kind, record,
    archive: { ...archive, secret: alternateSecret, keyId: createHash('sha256').update(alternateSecret).digest('hex') } });
  const { device } = await ownerClient.identity();
  const migratorPublicKey = createPublicKey(device).export({ type: 'spki', format: 'der' }).subarray(-32);
  const clear = openMigratedHistoryRecord(migrated, { serverId, archiveSha256, kind, id: record.id, archive, migratorPublicKey });
  assert.equal(JSON.parse(clear.toString()).text, 'legacy history /9007199254740991');
  assert.notEqual(migrated.ciphertext, record.ciphertext);
  const replay = await pinnedFetch(signed.url, signed.options);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error.code, 'EXPIRED_CHALLENGE');
  await assert.rejects(ownerClient.readProtectedMigrationHistory(serverId, { kind: 'messages', cursor: first.next }), { code: 'INVALID_MIGRATION_PAGE' });
  const second = await ownerClient.readProtectedMigrationHistory(serverId, { kind: 'messages', cursor: first.next, archiveSha256 });
  assert.equal(second.records[0].id, '9007199254740994');
  assert.equal(second.records[0].metadata.messageId, second.records[0].id);
  const nextPacket = await ownerClient.reencryptProtectedMigrationRecord(serverId, { archiveSha256, kind, archive, record: second.records[0] });
  const attachmentPage = await ownerClient.readProtectedMigrationHistory(serverId, { kind: 'attachments', archiveSha256, limit: 1 });
  const attachmentPacket = await ownerClient.reencryptProtectedMigrationRecord(serverId, {
    archiveSha256, kind: 'attachments', archive, record: attachmentPage.records[0],
  });

  await assert.rejects(client(admin).readProtectedMigrationHistory(serverId, { kind: 'messages' }), { code: 'MIGRATION_DEVICE_DENIED' });
  await assert.rejects(client(revoked).readProtectedMigrationHistory(serverId, { kind: 'messages' }), { code: 'MIGRATION_DEVICE_DENIED' });
  await assert.rejects(ownerClient.readProtectedMigrationHistory(serverId, { kind: 'messages', archiveSha256: '0'.repeat(64) }), { code: 'MIGRATION_CHECKPOINT_CHANGED' });
  const tampered = client(owner, (url, options) => pinnedFetch(url, options.method !== 'POST' ? options : {
    ...options, body: JSON.stringify({ ...JSON.parse(options.body), limit: 2 }),
  }));
  await assert.rejects(tampered.readProtectedMigrationHistory(serverId, { kind: 'messages' }), { code: 'MIGRATION_DEVICE_DENIED' });
  const legacy = await pinnedFetch(base + '/api/v2/session', { pawtalkTLSFingerprint: fingerprint, method: 'POST' });
  assert.equal(legacy.status, 404);

  const receipt = await ownerClient.submitProtectedMigrationRecord(serverId, migrated);
  assert.equal(receipt.ciphertextSha256, createHash('sha256').update(Buffer.from(migrated.ciphertext, 'base64')).digest('hex'));
  assert.deepEqual(await ownerClient.submitProtectedMigrationRecord(serverId, retry), receipt);
  const continued = await ownerClient.readProtectedMigrationHistory(serverId, { kind: 'messages', archiveSha256, limit: 2 });
  assert.equal(continued.records[0].imported, true);
  assert.equal(continued.records[0].ciphertext, undefined);
  assert.equal(continued.records[0].archiveKeyId, migrated.keyId);
  assert.equal(continued.records[1].imported, undefined);
  assert.equal(continued.records[1].archiveKeyId, migrated.keyId);
  const partialProgress = await ownerClient.protectedMigrationProgress(serverId, archiveSha256);
  assert.deepEqual(partialProgress.counts.messages, { source: 2, imported: 1 });
  assert.equal(partialProgress.complete, false);
  await assert.rejects(ownerClient.submitProtectedMigrationRecord(serverId, alternate), { code: 'MIGRATION_ARCHIVE_KEY_CONFLICT' });
  const changedBody = client(owner, (url, options) => pinnedFetch(url, !url.endsWith('/import') ? options : { ...options, body: options.body + ' ' }));
  await assert.rejects(changedBody.submitProtectedMigrationRecord(serverId, nextPacket), { code: 'INVALID_MIGRATION_PACKET' });
  const administrator = client(admin);
  const badSigner = await administrator.reencryptProtectedMigrationRecord(serverId, { archiveSha256, kind, archive, record: second.records[0] });
  await assert.rejects(administrator.submitProtectedMigrationRecord(serverId, badSigner), { code: 'MIGRATION_DEVICE_DENIED' });
  const code = createMigrationRecoveryCode();
  let recoveryRequest, packageRequest, packageReceipt;
  let dropPackageResponse = false;
  const recovering = client(owner, async (url, options) => {
    if (options.method === 'POST' && url.endsWith('/recovery')) {
      assert.equal(options.body.includes(code), false);
      recoveryRequest = { url, options };
    }
    if (options.method === 'POST' && url.endsWith('/recovery/archive')) {
      assert.equal(options.body.includes(code), false);
      assert.equal(options.body.includes(secret.toString('hex')), false);
      packageRequest = { url, options };
      if (dropPackageResponse) {
        const response = await pinnedFetch(url, options);
        assert.equal(response.status, 200);
        packageReceipt = await response.json();
        throw new Error('synthetic connection loss after commit');
      }
    }
    return pinnedFetch(url, options);
  });
  const recoveryInput = { archiveSha256, ownerProfileId: policy.ownerProfileId, code };
  await assert.rejects(ownerClient.resumeProtectedMigrationRecoveryArchive(serverId, recoveryInput), { code: 'MIGRATION_RECOVERY_NOT_ENROLLED' });
  await assert.rejects(administrator.enrollProtectedMigrationRecovery(serverId, recoveryInput), { code: 'MIGRATION_DEVICE_DENIED' });
  await assert.rejects(recovering.enrollProtectedMigrationRecovery(serverId, { ...recoveryInput, archiveSha256: 'f'.repeat(64) }), { code: 'INVALID_MIGRATION_RECOVERY' });
  const recovery = await recovering.enrollProtectedMigrationRecovery(serverId, recoveryInput);
  const usedRecoveryRequest = await pinnedFetch(recoveryRequest.url, recoveryRequest.options);
  assert.equal(usedRecoveryRequest.status, 401);
  assert.deepEqual(await recovering.enrollProtectedMigrationRecovery(serverId, recoveryInput), recovery);
  await assert.rejects(recovering.enrollProtectedMigrationRecovery(serverId, { ...recoveryInput, code: createMigrationRecoveryCode() }), { code: 'MIGRATION_RECOVERY_ALREADY_ENROLLED' });
  const updatedPolicy = await ownerClient.protectedMigrationPolicyDraft(serverId, archiveSha256);
  assert.deepEqual(updatedPolicy.ownerRecovery, recovery);
  assert.equal(updatedPolicy.ownerRecoveryRequired, true);
  assert.deepEqual(updatedPolicy.ownerRecoveryArchive, { stagedKeys: 1, confirmedPackages: 0 });
  await assert.rejects(administrator.pendingProtectedMigrationRecoveryArchive(serverId, { archiveSha256 }), { code: 'MIGRATION_DEVICE_DENIED' });
  assert.deepEqual(await recovering.pendingProtectedMigrationRecoveryArchive(serverId, { archiveSha256, limit: 1 }), {
    recoveryId: recovery.recoveryId, keys: [{ channelId: archive.channelId, keyId: archive.keyId }],
  });
  const packageInput = { ...recoveryInput, recovery, archive };
  await assert.rejects(recovering.stageProtectedMigrationRecoveryArchive(serverId, { ...packageInput, code: createMigrationRecoveryCode() }), { code: 'INVALID_MIGRATION_RECOVERY' });
  await assert.rejects(recovering.stageProtectedMigrationRecoveryArchive(serverId, { ...packageInput, archive: {
    ...archive, secret: alternateSecret, keyId: alternate.keyId,
  } }), { code: 'MIGRATION_ARCHIVE_KEY_CONFLICT' });
  const withoutConfirmation = client(owner, (url, options) => {
    if (!url.endsWith('/recovery/archive')) return pinnedFetch(url, options);
    const request = JSON.parse(options.body);
    request.confirmation = Buffer.alloc(64).toString('base64url');
    const cipherDigest = createHash('sha256').update(Buffer.from(request.ciphertext, 'base64url')).digest('hex');
    request.deviceProof = sign(null, signatureFrame('pawtalk-migration-recovery-archive-request-v1',
      serverId, archiveSha256, request.recoveryId, request.channelId, request.keyId, request.deviceId,
      request.nonce, cipherDigest, request.signature, request.confirmation), device).toString('base64url');
    return pinnedFetch(url, { ...options, body: JSON.stringify(request) });
  });
  await assert.rejects(withoutConfirmation.stageProtectedMigrationRecoveryArchive(serverId, packageInput), { code: 'INVALID_MIGRATION_RECOVERY_PACKAGE' });
  await assert.rejects(recovering.resumeProtectedMigrationRecoveryArchive(serverId, recoveryInput), { code: 'MIGRATION_ARCHIVE_KEY_UNAVAILABLE' });
  const load = recovering.credentials.load.bind(recovering.credentials);
  recovering.credentials.load = key =>
    key === `pawtalk:migration-archive:v1:${serverId}:${archiveSha256}:${archive.channelId}` ? secret.toString('hex') : load(key);
  dropPackageResponse = true;
  await assert.rejects(recovering.resumeProtectedMigrationRecoveryArchive(serverId, recoveryInput), /synthetic connection loss after commit/);
  dropPackageResponse = false;
  const packet = JSON.parse(packageRequest.options.body);
  const context = { ...packet, serverId, ownerProfileId: policy.ownerProfileId, agreementKey: recovery.agreementKey };
  const recoveredSecret = openMigrationRecoveryPackage(packet, context, code, migratorPublicKey.toString('hex'));
  assert.deepEqual(recoveredSecret, secret);
  recoveredSecret.fill(0);
  assert.throws(() => openMigrationRecoveryPackage(packet, { ...context, channelId: 'f'.repeat(32) }, code,
    migratorPublicKey.toString('hex')), { code: 'INVALID_MIGRATION_RECOVERY' });
  assert.equal(packageReceipt.ciphertextSha256, createHash('sha256').update(Buffer.from(packet.ciphertext, 'base64url')).digest('hex'));
  assert.equal((await pinnedFetch(packageRequest.url, packageRequest.options)).status, 401);
  const resumed = client(owner, (url, options) => {
    assert.equal(url.endsWith('/recovery/archive'), false);
    return pinnedFetch(url, options);
  });
  assert.deepEqual(await resumed.resumeProtectedMigrationRecoveryArchive(serverId, recoveryInput), { stagedKeys: 1, confirmedPackages: 1 });
  await assert.rejects(resumed.resumeProtectedMigrationRecoveryArchive(serverId, { ...recoveryInput, code: createMigrationRecoveryCode() }),
    { code: 'INVALID_MIGRATION_RECOVERY' });
  assert.deepEqual(await recovering.stageProtectedMigrationRecoveryArchive(serverId, packageInput), packageReceipt);
  const finalPolicy = await ownerClient.protectedMigrationPolicyDraft(serverId, archiveSha256);
  assert.deepEqual(finalPolicy.ownerRecoveryArchive, { stagedKeys: 1, confirmedPackages: 1 });
  assert.equal(finalPolicy.ownerRecoveryRequired, true);
  process.stdout.write(JSON.stringify({ migrated, retry, nextPacket, attachmentPacket, packageReceipt,
    testRecoveryCode: code, testArchiveSecret: secret.toString('hex') }));
}

async function approveImport() {
  const confirmedReviewDigest = review.reviewDigest;
  const ownerClient = client(owner);
  await assert.rejects(ownerClient.signProtectedMigrationImportReview(serverId, {
    report: { ...review, messagePositionsDigest: '0'.repeat(64) }, confirmedReviewDigest,
  }), { code: 'INVALID_MIGRATION_IMPORT_REVIEW' });
  await assert.rejects(client(admin).signProtectedMigrationImportReview(serverId, {
    report: review, confirmedReviewDigest,
  }), { code: 'MIGRATION_DEVICE_DENIED' });
  const approval = await ownerClient.signProtectedMigrationImportReview(serverId, { report: review, confirmedReviewDigest });
  process.stdout.write(JSON.stringify(approval));
}

async function enrollRecipient() {
  const input = { archiveSha256, ownerProfileId: review.ownerProfileId, reviewDigest: review.reviewDigest };
  const enroll = instance => instance.enrollProtectedMigrationOwnerRecipient(serverId, input);
  if (recipient === 'before-approval') {
    await assert.rejects(enroll(client(owner)), { code: 'MIGRATION_IMPORT_APPROVAL_REQUIRED' });
    return;
  }
  await assert.rejects(enroll(client(admin)), { code: 'MIGRATION_DEVICE_DENIED' });
  const unsaved = client(owner);
  unsaved.credentials.save = async () => { throw new Error('synthetic secure storage failure'); };
  await assert.rejects(enroll(unsaved), /synthetic secure storage failure/);
  const saved = new Map();
  let confirmation;
  const current = client(owner, (url, options) => {
    if (url.endsWith('/migration/recipient')) {
      assert.equal(saved.size, 1);
      assert.equal(options.body.includes(saved.values().next().value), false);
      confirmation = { url, options };
    }
    return pinnedFetch(url, options);
  }, saved);
  const receipt = await enroll(current);
  assert.equal((await pinnedFetch(confirmation.url, confirmation.options)).status, 401);
  assert.deepEqual(await enroll(client(owner, pinnedFetch, saved)), receipt);
  await assert.rejects(enroll(client(owner)), { code: 'MIGRATION_RECIPIENT_ALREADY_ENROLLED' });
  await assert.rejects(current.enrollProtectedMigrationOwnerRecipient(serverId, { ...input, reviewDigest: 'e'.repeat(64) }),
    { code: 'MIGRATION_IMPORT_REVIEW_CHANGED' });
  process.stdout.write(JSON.stringify({ receipt, testAgreementSeed: saved.values().next().value }));
}

async function approveInitialPolicy() {
  const { reviewDigest, ownerRecipient } = review;
  const input = { report: review, confirmedReviewDigest: reviewDigest };
  const ownerClient = client(owner, pinnedFetch, new Map([[ `pawtalk:agreement:v1:${serverId}:${ownerRecipient.deviceId}`, testAgreementSeed ]]));
  await assert.rejects(client(owner).signProtectedMigrationInitialPolicy(serverId, input), { code: 'INVALID_MIGRATION_RECIPIENT' });
  await assert.rejects(ownerClient.signProtectedMigrationInitialPolicy(serverId, { ...input, confirmedReviewDigest: 'f'.repeat(64) }),
    { code: 'INVALID_MIGRATION_POLICY_APPROVAL' });
  const changed = JSON.parse(Buffer.from(review.initialPolicy.snapshot, 'base64'));
  changed.Members[review.ownerProfileId].Roles = ['invalid-role'];
  const bytes = Buffer.from(JSON.stringify(changed));
  await assert.rejects(ownerClient.signProtectedMigrationInitialPolicy(serverId, { ...input, report: { ...review,
    initialPolicy: { snapshot: bytes.toString('base64'), draft: { ...review.initialPolicy.draft,
      ResultDigest: createHash('sha256').update(bytes).digest('hex') } },
  } }), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  const reordered = JSON.parse(Buffer.from(review.initialPolicy.snapshot, 'base64'));
  assert.ok(review.initialPolicy.preserveChannelOrder && reordered.ChannelOrder.length > 1);
  reordered.ChannelOrder.reverse();
  const tampered = Buffer.from(JSON.stringify(reordered));
  await assert.rejects(ownerClient.signProtectedMigrationInitialPolicy(serverId, { ...input, report: { ...review,
    initialPolicy: { ...review.initialPolicy, snapshot: tampered.toString('base64'), draft: { ...review.initialPolicy.draft,
      ResultDigest: createHash('sha256').update(tampered).digest('hex') } },
  } }), { code: 'UNAUTHORIZED_POLICY_TRANSITION' });
  process.stdout.write(JSON.stringify(await ownerClient.signProtectedMigrationInitialPolicy(serverId, input)));
}

async function prepareChannelKeys(stopAfterLiveCommit = false) {
  const { ownerProfileId, ownerRecipient } = review;
  const input = { archiveSha256, ownerProfileId, policyApproval, channelId: keyChannelId, code: testRecoveryCode };
  const prepare = instance => instance.prepareProtectedMigrationChannelKeys(serverId, input);
  const saved = new Map([[`pawtalk:agreement:v1:${serverId}:${ownerRecipient.deviceId}`, testAgreementSeed]]);
  const archiveSlot = `pawtalk:migration-archive:v1:${serverId}:${archiveSha256}:${keyChannelId}`;
  saved.set(archiveSlot, testArchiveSecret);
  if (stopAfterLiveCommit) {
    const administrator = client(admin);
    await assert.rejects(administrator.migrationKeyRequest({ serverId, anchorDigest: review.policyAnchorDigest }, archiveSha256,
      await administrator.identity(), 'claim', { channelId: keyChannelId, purpose: 'live' }), { code: 'MIGRATION_DEVICE_DENIED' });
    const wrongCode = client(owner, pinnedFetch, saved);
    await assert.rejects(wrongCode.prepareProtectedMigrationChannelKeys(serverId, { ...input, code: createMigrationRecoveryCode() }),
      { code: 'INVALID_MIGRATION_RECOVERY' });
    let firstLiveKeyId;
    const interrupted = client(owner, async (url, options) => {
      const response = await pinnedFetch(url, options);
      if (url.endsWith('/keys/commit')) {
        assert.equal(response.status, 200);
        const { record } = JSON.parse(options.body);
        assert.equal(record.Purpose, 'live');
        firstLiveKeyId = record.KeyID;
        throw new Error('synthetic connection loss after epoch commit');
      }
      return response;
    }, saved);
    await assert.rejects(prepare(interrupted), /synthetic connection loss after epoch commit/);
    assert.match(firstLiveKeyId, /^[0-9a-f]{64}$/);
    process.stdout.write(JSON.stringify({ live: firstLiveKeyId }));
    return;
  }
  const resumeFetch = (url, options) => {
    if (/\/keys\/(claim|commit)$/.test(url)) {
      const request = JSON.parse(options.body);
      assert.notEqual(request.purpose ?? request.record?.Purpose, 'live');
    }
    return pinnedFetch(url, options);
  };
  let lostBackup = false;
  const interruptedBackup = client(owner, async (url, options) => {
    const response = await resumeFetch(url, options);
    if (url.endsWith('/keys/backup') && !lostBackup) {
      assert.equal(options.body.includes(testRecoveryCode), false);
      assert.equal(response.status, 200);
      lostBackup = true;
      throw new Error('synthetic connection loss after recovery backup');
    }
    return response;
  }, saved);
  await assert.rejects(prepare(interruptedBackup), /synthetic connection loss after recovery backup/);
  assert.equal(lostBackup, true);
  let lostLink = false;
  const interruptedLink = client(owner, async (url, options) => {
    const response = await resumeFetch(url, options);
    if (url.endsWith('/keys/history-link') && !lostLink) {
      assert.equal(options.body.includes(testArchiveSecret), false);
      assert.equal(response.status, 200);
      lostLink = true;
      throw new Error('synthetic connection loss after imported history link');
    }
    return response;
  }, saved);
  await assert.rejects(prepare(interruptedLink), /synthetic connection loss after imported history link/);
  assert.equal(lostLink, true);
  saved.delete(archiveSlot);
  const keys = await prepare(client(owner, resumeFetch, saved));
  assert.equal(keys.live, testFirstLiveKeyId);
  assert.match(keys.archive, /^[0-9a-f]{64}$/);
  assert.notEqual(keys.live, keys.archive);
  const readback = client(owner, (url, options) => {
    assert.doesNotMatch(url, /\/keys\/(claim|commit|backup|history-link)$/);
    return pinnedFetch(url, options);
  }, saved);
  assert.deepEqual(await prepare(readback), keys);
  process.stdout.write(JSON.stringify(keys));
}

async function approveCutover() {
  const ownerClient = client(owner);
  const input = { report: review, policyApproval, confirmedCutoverDigest: review.cutoverDigest };
  await assert.rejects(ownerClient.signProtectedMigrationCutover(serverId, {
    ...input, report: { ...review, historyLinks: { ...review.historyLinks, digest: 'f'.repeat(64) } },
  }), { code: 'INVALID_MIGRATION_CUTOVER_APPROVAL' });
  assert.equal(await ownerClient.loadProtectedRuntimeTrust(serverId), undefined);
  const approval = await ownerClient.signProtectedMigrationCutover(serverId, input);
  assert.equal(approval.scopeAuthority.sequence, 1);
  assert.equal(approval.scopeAuthority.revision, 1);
  assert.equal(approval.scopeAuthority.policyHead, review.policyAnchorDigest);
  assert.ok(Buffer.byteLength(JSON.stringify(approval)) <= 1024);
  assert.deepEqual(await ownerClient.loadProtectedRuntimeTrust(serverId), {
    serverId, ownerProfileId: review.ownerProfileId, ownerDeviceId: review.ownerRecipient.deviceId,
    anchorDigest: review.policyAnchorDigest, cutoverDigest: review.cutoverDigest,
  });
  assert.deepEqual(await ownerClient.signProtectedMigrationCutover(serverId, input), approval);
  await assert.rejects(ownerClient.prepareProtectedMigrationRecoveryBundle(serverId, createMigrationRecoveryCode()),
    { code: 'INVALID_MIGRATION_RECOVERY' });
  const bundle = await ownerClient.prepareProtectedMigrationRecoveryBundle(serverId, testRecoveryCode);
  const exported = openRecoveryBundle(bundle);
  assert.equal(exported.code, testRecoveryCode);
  assert.equal(exported.fingerprint, fingerprint);
  assert.deepEqual(exported.trust, await ownerClient.loadProtectedRuntimeTrust(serverId));
  process.stdout.write(JSON.stringify(approval));
}

async function rejectRestoredBackup() {
  const { ownerProfileId, ownerRecipient } = review;
  const trust = { serverId, ownerProfileId, ownerDeviceId: ownerRecipient.deviceId, anchorDigest: policyProof.Digest,
    cutoverDigest: review.cutoverDigest };
  const saved = new Map([[`pawtalk:agreement:v1:${serverId}:${ownerRecipient.deviceId}`, testAgreementSeed],
    [`pawtalk:protected-runtime:v1:${serverId}`, JSON.stringify(trust)]]);
  const active = client(owner, pinnedFetch, saved);
  const activeSession = await active.openStoredProtectedRuntime(serverId);
  const administrator = client(admin);
  const admitted = await administrator.openProtectedRuntimeSession(serverId, trust.cutoverDigest);
  assert.equal((await active.refreshProtectedRuntimePolicy(activeSession, trust)).revision, 1);
  await active.changeProtectedMembership(activeSession, 'kick', admitted.profileId, { reason: 'Synthetic backup rollback check' });
  await assert.rejects(administrator.openProtectedRuntimeSession(serverId, trust.cutoverDigest), { code: 'NOT_A_MEMBER' });
  const checkpoint = await active.readProtectedOwnerPolicy(activeSession);
  assert.equal(checkpoint.revision, 2);
  assert.equal(checkpoint.snapshot.Members[admitted.profileId].Active, false);
  assert.equal(checkpoint.snapshot.PolicyDevices[admitted.deviceId].Revoked, true);
  await active.syncProtectedPolicyAttestations(activeSession);

  const switchCopy = async path => {
    const response = await pinnedFetch(base + path, { method: 'POST', pawtalkTLSFingerprint: fingerprint });
    assert.equal(response.status, 200);
  };
  await switchCopy('/fixture/restore-older-copy');
  const oldSession = await administrator.openProtectedRuntimeSession(serverId, trust.cutoverDigest);
  assert.equal(oldSession.deviceId, admitted.deviceId);
  const anchorOnly = client(owner, pinnedFetch, new Map([
    [`pawtalk:agreement:v1:${serverId}:${ownerRecipient.deviceId}`, testAgreementSeed],
    [`pawtalk:protected-runtime:v1:${serverId}`, JSON.stringify(trust)],
  ]));
  const anchorSession = await anchorOnly.openStoredProtectedRuntime(serverId);
  const availablePolicy = await anchorOnly.readProtectedOwnerPolicy(anchorSession);
  assert.equal(availablePolicy.revision, 1);
  assert.equal(availablePolicy.digest, policyProof.Digest);
  assert.equal(availablePolicy.snapshot.Members[admitted.profileId].Active, true);
  let postAttempts = 0;
  const restarted = client(owner, (url, options) => {
    if (options.method === 'POST' && new URL(url).pathname === `/api/v3/history/live/${keyChannelId}`) postAttempts++;
    return pinnedFetch(url, options);
  }, saved);
  const restoredSession = await restarted.openStoredProtectedRuntime(serverId);
  assert.equal(restoredSession.fingerprint, activeSession.fingerprint);
  assert.equal(restoredSession.base, activeSession.base);
  await assert.rejects(restarted.readProtectedRuntimeState(restoredSession), { code: 'POLICY_ROLLBACK' });
  await assert.rejects(restarted.refreshProtectedRuntimePolicy(restoredSession, trust), { code: 'POLICY_ROLLBACK' });
  assert.deepEqual(await restarted.readProtectedTextStatus(serverId, keyChannelId, restoredSession),
    { state: 'red', reason: 'POLICY_PROOF_INVALID', allowSend: false });
  await assert.rejects(restarted.withCurrentProtectedChatPolicy(restoredSession, options =>
    restarted.sendProtectedRuntimeText(restoredSession, keyChannelId, 'Must stay a draft', 'ab'.repeat(16), options)),
  { code: 'POLICY_ROLLBACK' });
  assert.equal(postAttempts, 0);
  assert.equal((await restarted.policyCheckpoint().load(trust)).digest, checkpoint.digest);

  await switchCopy('/fixture/reconnect-current-copy');
  const recoveredSession = await restarted.openStoredProtectedRuntime(serverId);
  await restarted.readProtectedRuntimeState(recoveredSession);
  assert.equal((await restarted.refreshProtectedRuntimePolicy(recoveredSession, trust)).digest, checkpoint.digest);
  await assert.rejects(administrator.openProtectedRuntimeSession(serverId, trust.cutoverDigest), { code: 'NOT_A_MEMBER' });
  assert.equal((await restarted.readProtectedTextStatus(serverId, keyChannelId, recoveredSession)).allowSend, true);
  assert.equal(postAttempts, 0);
}

async function readProtectedHistory() {
  let enrollment;
  let lostWrite = false;
  let lostChecklistWrite = false;
  let tamperChecklist = false;
  let tamperPollResult = false;
  let corruptAttachment = false;
  let deleteDuringAttachment = false;
  let loseAttachmentWrite = false;
  let corruptLiveAttachment = false;
  let corruptText = false;
  let corruptImport = false;
  let corruptDisclosure;
  let discoveryTest;
  const text = 'Новое защищённое сообщение';
  const deviceId = review.ownerRecipient.deviceId;
  const saved = new Map([[`pawtalk:agreement:v1:${serverId}:${deviceId}`, testAgreementSeed]]);
  saved.set(`pawtalk:server:v2:${serverId}`, JSON.stringify({ secret: legacySecret }));
  const runtimeTrust = { serverId, ownerProfileId: review.ownerProfileId, ownerDeviceId: deviceId,
    anchorDigest: policyProof.Digest, cutoverDigest: review.cutoverDigest };
  saved.set(`pawtalk:protected-runtime:v1:${serverId}`, JSON.stringify(runtimeTrust));
  const ownerClient = client(owner, async (url, options) => {
    if (url.endsWith('/api/v3/session/open')) enrollment = { url, options };
    if (url.endsWith('/api/config') && discoveryTest === 'downgrade') return Response.json(legacyConfig);
    const response = await pinnedFetch(url, options);
    if (url.includes('/history/live-attachments/') && response.ok) {
      if (options.method === 'PUT') {
        const request = JSON.parse(options.body);
        assert.deepEqual(Object.keys(request).sort(), ['bytes', 'kind', 'offset', 'total']);
        assert.equal(Buffer.from(request.bytes, 'base64').includes(Buffer.alloc(256, 0x7a)), false);
        if (loseAttachmentWrite) {
          loseAttachmentWrite = false;
          throw Error('synthetic attachment response loss');
        }
      } else if (corruptLiveAttachment && url.endsWith('offset=1048576')) {
        const chunk = await response.json();
        const bytes = Buffer.from(chunk.bytes, 'base64');
        bytes[0] ^= 1;
        return Response.json({ ...chunk, bytes: bytes.toString('base64') });
      }
    }
    if (deleteDuringAttachment && url.includes('/history/attachments/') && url.endsWith('offset=0') && response.ok) {
      const chunk = await response.json();
      deleteDuringAttachment = false;
      await ownerClient.deleteProtectedMessage(session, keyChannelId, 1);
      return Response.json(chunk);
    }
    if (corruptAttachment && url.includes('/history/attachments/') && url.endsWith('offset=1048576') && response.ok) {
      const chunk = await response.json();
      const bytes = Buffer.from(chunk.bytes, 'base64');
      bytes[0] ^= 1;
      return Response.json({ ...chunk, bytes: bytes.toString('base64') });
    }
    if (corruptImport && url.includes('/history/imported/') && !url.endsWith('/link') && options.method === 'GET' && response.ok) {
      const history = await response.json();
      history.messages[0].packet.metadata.sentAt++;
      return Response.json(history);
    }
    if (corruptText && options.method === 'GET' && url.includes('/history/live/') && response.ok) {
      const history = await response.json();
      history.messages[0].Packet.Signature = Buffer.alloc(64).toString('base64');
      return Response.json(history);
    }
    if (tamperChecklist && options.method === 'GET' && url.includes('/history/live/') && response.ok) {
      const history = await response.json();
      history.messages[0].Packet.Checklist.Everyone = true;
      return Response.json(history);
    }
    if (tamperPollResult && options.method === 'GET' && url.includes('/history/live/') && response.ok) {
      const history = await response.json();
      const result = history.messages.find(message => message.PollResult)?.PollResult;
      if (result) result.counts.reverse();
      return Response.json(history);
    }
    if (url.endsWith('/api/config') && discoveryTest === 'altered') {
      const config = await response.json();
      return Response.json({ ...config, protectedVoice: !config.protectedVoice });
    }
    if (url.endsWith('/api/v3/session/challenge') && discoveryTest === 'binding') {
      const challenge = await response.json();
      return Response.json({ ...challenge, binding: 'a'.repeat(64) });
    }
    if (corruptDisclosure && url.includes('/api/v3/keys/current/') && response.ok) {
      const delivery = await response.json();
      if (corruptDisclosure === 'omitted') delete delivery.textPolicy;
      else delivery.textPolicy.inclusion.siblings[0] = '0'.repeat(64);
      return Response.json(delivery);
    }
    if (options.method === 'POST' && url.includes('/history/live/') && !lostWrite) {
      assert.equal(options.body.includes(text), false);
      assert.equal(response.status, 200);
      lostWrite = true;
      throw new Error('synthetic live message response loss');
    }
    if (options.method === 'POST' && url.includes('/history/live/') && !lostChecklistWrite &&
        JSON.parse(options.body).Checklist) {
      assert.equal(options.body.includes('New checklist'), false);
      assert.equal(options.body.includes('New encrypted item'), false);
      assert.equal(response.status, 200);
      lostChecklistWrite = true;
      throw new Error('synthetic checklist response loss');
    }
    if (options.method === 'POST' && url.includes('/history/live/') && JSON.parse(options.body).Poll) {
      assert.equal(options.body.includes('Which project?'), false);
      assert.equal(options.body.includes('Project A'), false);
      assert.equal(options.body.includes('Project B'), false);
    }
    return response;
  }, saved);
  await assert.rejects(ownerClient.openProtectedRuntimeSession(serverId, '0'.repeat(64)), { code: 'INVALID_PROTECTED_CHALLENGE' });
  await assert.rejects(ownerClient.verified(address, serverId), { code: 'PROTECTED_PROTOCOL_REQUIRED' });
  await assert.rejects(client(owner).openStoredProtectedRuntime(serverId), { code: 'UNTRUSTED_POLICY_ANCHOR' });
  discoveryTest = 'altered';
  await assert.rejects(ownerClient.openStoredProtectedRuntime(serverId), { code: 'INVALID_SERVER_IDENTITY' });
  discoveryTest = 'binding';
  await assert.rejects(ownerClient.openStoredProtectedRuntime(serverId), { code: 'INVALID_PROTECTED_CHALLENGE' });
  discoveryTest = 'downgrade';
  await assert.rejects(ownerClient.openStoredProtectedRuntime(serverId), { code: 'PROTECTED_PROTOCOL_DOWNGRADE' });
  await assert.rejects(ownerClient.connect({ serverId, address }), { code: 'PROTECTED_PROTOCOL_DOWNGRADE' });
  discoveryTest = undefined;
  assert.equal(enrollment, undefined);
  const session = await ownerClient.openStoredProtectedRuntime(serverId);
  assert.equal(session.config.apiProtocolVersion, 3);
  assert.equal(session.config.e2eeRequired, true);
  assert.deepEqual(session.policyTrust, runtimeTrust);
  const coverage = await ownerClient.readProtectedRecoveryCoverage(session);
  const genesis = JSON.parse(Buffer.from(review.initialPolicy.snapshot, 'base64'));
  assert.equal(coverage.recoveryId, genesis.RecoveryIdentities[review.ownerProfileId].ID);
  assert.deepEqual(coverage.items.map(({ channelId, purpose, generation, pending }) => ({ channelId, purpose, generation, pending }))
    .sort((left, right) => left.purpose.localeCompare(right.purpose)), [
    { channelId: keyChannelId, purpose: 'archive', generation: 1, pending: false },
    { channelId: keyChannelId, purpose: 'live', generation: 1, pending: false },
  ]);
  const challenge = { nonce: 'a'.repeat(64), expiresAt: Date.now() + 60_000 };
  for (const item of coverage.items) {
    const opening = await ownerClient.proveProtectedRecoveryPackageOpening(session, testRecoveryCode, coverage, item, challenge);
    assert.match(opening.openingProof, /^[A-Za-z0-9_-]{86}$/);
  }
  const view = await ownerClient.readProtectedRuntimeState(session);
  const expectedAvatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5e8AAAAASUVORK5CYII=';
  assert.deepEqual(view.communityAvatar, { revision: 2, avatar: expectedAvatar, pending: false });
  assert.deepEqual(await ownerClient.readProtectedCommunityAvatar(session), view.communityAvatar);
  const avatarRoster = await ownerClient.readProtectedRuntimeRoster(session, keyChannelId);
  assert.equal(avatarRoster.members.find(member => member.id === session.profileId)?.avatar, expectedAvatar);
  assert.deepEqual(await ownerClient.fetchJSON(session.base, '/api/v3/community/avatar/legacy', {
    fingerprint: session.fingerprint, headers: { Authorization: `Bearer ${session.token}` },
  }), {});
  assert.equal(view.canListInvites, true);
  assert.ok(view.channels.find(channel => channel.id === keyChannelId)?.name);
  assert.deepEqual(view.channels.map(channel => channel.id), genesis.ChannelOrder);
  assert.equal(session.profileId, review.ownerProfileId);
  const replay = await pinnedFetch(enrollment.url, enrollment.options);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error.code, 'EXPIRED_CHALLENGE');
  const first = await ownerClient.readProtectedImportedHistory(session, keyChannelId, { limit: 1 });
  const second = await ownerClient.readProtectedImportedHistory(session, keyChannelId, { after: first.next, limit: 1 });
  assert.deepEqual([first.messages[0].packet.id, second.messages[0].packet.id], ['9007199254740991', '9007199254740994']);
  assert.equal(second.next, undefined);
  const historyLink = await ownerClient.loadProtectedImportedHistoryLink(session, keyChannelId);
  assert.equal(historyLink.anchorDigest, review.policyAnchorDigest);
  const [archiveGenesis] = await ownerClient.fetchProtectedRuntimeEpochProofs(session, keyChannelId, 'archive', 0, 1);
  assert.equal(archiveGenesis.Record.KeyID, historyLink.archiveKeyId);
  assert.match(archiveGenesis.Record.ArchiveWrapKey, /^[0-9a-f]{64}$/);
  await assert.rejects(ownerClient.fetchProtectedRuntimeEpochProofs(session, keyChannelId, 'archive', 0, 2),
    { code: 'PROTECTED_KEY_PENDING' });
  const archiveLinks = await ownerClient.fetchProtectedRuntimeArchiveLinks(session, keyChannelId, historyLink.archiveKeyId);
  assert.deepEqual(archiveLinks.Epoch, archiveGenesis);
  assert.equal(archiveLinks.Links.length, 1);
  assert.equal(archiveLinks.Links[0].Purpose, 'live');
  const packet = first.messages[0].packet;
  const { device } = await ownerClient.identity();
  const migratorPublicKey = createPublicKey(device).export({ type: 'spki', format: 'der' }).subarray(-32);
  const policyTrust = runtimeTrust;
  await ownerClient.policyCheckpoint().accept({
    headRevision: 1, headDigest: policyProof.Digest, proofs: [{
      record: Buffer.from(JSON.stringify(policyProof)).toString('base64'),
      roleUpdate: Buffer.from('null').toString('base64'), snapshot: review.initialPolicy.snapshot,
    }],
  }, policyTrust);
  const trustOptions = { policyTrust };
  corruptDisclosure = 'sibling';
  await assert.rejects(ownerClient.loadProtectedRuntimeKey(session, keyChannelId, 'archive', trustOptions),
    { code: 'INVALID_CHANNEL_POLICY_PROOF' });
  corruptDisclosure = 'omitted';
  await assert.rejects(ownerClient.loadProtectedRuntimeKey(session, keyChannelId, 'archive', trustOptions),
    { code: 'UNVERIFIED_EPOCH_POLICY' });
  corruptDisclosure = undefined;
  const { secret: archiveHead } = await ownerClient.loadProtectedRuntimeKey(session, keyChannelId, 'archive', trustOptions);
  const secret = openSignedMigrationHistoryLink(archiveHead, { ...historyLink, serverId }, historyLink.link, migratorPublicKey.toString('hex'));
  archiveHead.fill(0);
  const clear = openMigratedHistoryRecord(packet, { serverId, archiveSha256, kind: 'messages', id: packet.id,
    archive: { channelId: keyChannelId, keyId: historyLink.importedKeyId, purpose: 'archive', generation: 1, secret }, migratorPublicKey });
  assert.equal(JSON.parse(clear.toString()).text, 'legacy history /9007199254740991');
  const migratedReply = openMigratedHistoryRecord(second.messages[0].packet, { serverId, archiveSha256, kind: 'messages',
    id: second.messages[0].packet.id, archive: { channelId: keyChannelId, keyId: historyLink.importedKeyId,
      purpose: 'archive', generation: 1, secret }, migratorPublicKey });
  const item = 'a'.repeat(32);
  const checklist = { everyone: true, items: [{ id: item, text: 'Encrypted item' }] };
  assert.deepEqual(JSON.parse(migratedReply.toString()),
    { text: 'legacy history /9007199254740994', reply: { id: 9007199254740991 }, checklist });
  migratedReply.fill(0);
  secret.fill(0);
  clear.fill(0);
  const operation = '7'.repeat(32);
  await assert.rejects(ownerClient.sendProtectedRuntimeText(session, keyChannelId, text, operation, trustOptions, 1), /synthetic live message response loss/);
  assert.deepEqual(await ownerClient.sendProtectedRuntimeText(session, keyChannelId, 'повтор', operation, trustOptions, 1),
    { Position: 3, Existing: true });
  const live = await ownerClient.readProtectedRuntimeText(session, keyChannelId, { after: second.messages[0].position });
  const display = await ownerClient.readProtectedChatPage(session, keyChannelId, second.messages[0].position);
  assert.deepEqual(display.messages.map(row => ({ position: row.position, text: row.text, own: row.own })),
    [{ position: 3, text, own: true }]);
  assert.equal(display.messages[0].replyTo, 1);
  corruptText = true;
  await assert.rejects(ownerClient.readProtectedChatPage(session, keyChannelId, second.messages[0].position),
    { code: 'INVALID_PROTECTED_TEXT' });
  corruptText = false;
  const combined = await ownerClient.readProtectedChatPage(session, keyChannelId, 0);
  const attachmentId = 'd'.repeat(32);
  assert.deepEqual(combined.messages[0].files, [{ id: attachmentId, name: 'archive.bin', mime: 'application/octet-stream', size: 1048587 }]);
  assert.equal(Object.hasOwn(combined.messages[0], 'importedAttachmentSource'), false);
  const downloaded = await ownerClient.readProtectedFile(session, keyChannelId, 1, attachmentId);
  assert.deepEqual(Buffer.from(downloaded), Buffer.alloc(1048587, 0x62));
  corruptAttachment = true;
  await assert.rejects(ownerClient.readProtectedFile(session, keyChannelId, 1, attachmentId), { code: 'INVALID_MIGRATION_SIGNATURE' });
  corruptAttachment = false;
  await assert.rejects(ownerClient.readProtectedImportedFile(session, keyChannelId, 2, attachmentId), { code: 'PROTECTED_ACCESS_DENIED' });
  await ownerClient.setProtectedMessagePin(session, keyChannelId, 2, true);
  assert.deepEqual((await ownerClient.readProtectedPins(session, keyChannelId)).items, [{ position: 2, revision: 1 }]);
  const pinnedReply = await ownerClient.readProtectedPinnedMessage(session, keyChannelId, 2);
  assert.equal(pinnedReply.text, 'legacy history /9007199254740994');
  assert.equal(pinnedReply.replyTo, 1);
  assert.deepEqual(combined.messages.map(row => [row.position, row.text]), [
    [1, 'legacy history /9007199254740991'], [2, 'legacy history /9007199254740994'], [3, text],
  ]);
  assert.equal(combined.messages[1].replyTo, 1);
  assert.deepEqual(combined.messages[1].checklist, checklist);
  assert.deepEqual(await ownerClient.protectedChecklist(session, keyChannelId, 2),
    { revision: 0, canCheck: true, checked: { [item]: true } });
  const mark = { operationId: '3'.repeat(32), item, checked: false };
  assert.deepEqual(await ownerClient.protectedChecklist(session, keyChannelId, 2, mark),
    { revision: 1, canCheck: true, checked: {} });
  assert.deepEqual(await ownerClient.protectedChecklist(session, keyChannelId, 2, mark),
    { revision: 1, canCheck: true, checked: {} });
  corruptImport = true;
  await assert.rejects(ownerClient.readProtectedChatPage(session, keyChannelId, 0), { code: 'INVALID_MIGRATION_SIGNATURE' });
  corruptImport = false;
  assert.equal(live.messages.length, 1);
  const { Author, Packet, Position } = live.messages[0];
  assert.equal(Position, 3);
  assert.equal(Packet.OperationID, operation);
  assert.equal(openProtectedReply(Packet, Position, 1), 1);
  assert.throws(() => openProtectedReply({ ...Packet, Reply: { ...Packet.Reply, Position: 2 } }, Position, 1),
    { code: 'INVALID_PROTECTED_TEXT' });
  const { secret: liveKey } = await ownerClient.loadProtectedRuntimeKey(session, keyChannelId, 'live', trustOptions);
  assert.equal(openProtectedText(liveKey, serverId, Author, Packet, migratorPublicKey.toString('hex')), text);
  assert.throws(() => openProtectedText(liveKey, serverId, Author, { ...Packet, OperationID: '8'.repeat(32) },
    migratorPublicKey.toString('hex')), { code: 'INVALID_PROTECTED_TEXT' });
  assert.throws(() => openProtectedText(liveKey, serverId, Author, { ...Packet, ReplyDigest: undefined },
    migratorPublicKey.toString('hex')), { code: 'INVALID_PROTECTED_TEXT' });
  liveKey.fill(0);
  const administrator = client(admin);
  const adminSession = await administrator.openProtectedRuntimeSession(serverId, review.cutoverDigest);
  await assert.rejects(administrator.protectedChecklist(adminSession, keyChannelId, 2), { code: 'PROTECTED_ACCESS_DENIED' });
  const lookupReferences = (connection, ids) => ownerClient.fetchJSON(connection.base, `/api/v3/history/imported/${keyChannelId}/references`, {
    method: 'POST', body: JSON.stringify({ ids }), fingerprint: connection.fingerprint,
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  await assert.rejects(lookupReferences(adminSession, ['9007199254740991']), { code: 'PROTECTED_ACCESS_DENIED' });
  await assert.rejects(administrator.readProtectedImportedHistory(adminSession, keyChannelId), { code: 'PROTECTED_ACCESS_DENIED' });
  await assert.rejects(administrator.loadProtectedImportedHistoryLink(adminSession, keyChannelId), { code: 'PROTECTED_ACCESS_DENIED' });
  await assert.rejects(administrator.fetchProtectedRuntimeEpochProofs(adminSession, keyChannelId, 'archive', 0, 1),
    { code: 'PROTECTED_ACCESS_DENIED' });
  await assert.rejects(administrator.fetchProtectedRuntimeArchiveLinks(adminSession, keyChannelId, historyLink.archiveKeyId),
    { code: 'PROTECTED_ACCESS_DENIED' });
  await assert.rejects(administrator.loadProtectedRuntimeKey(adminSession, keyChannelId, 'live', trustOptions), { code: 'PROTECTED_ACCESS_DENIED' });
  await assert.rejects(administrator.readProtectedRuntimeText(adminSession, keyChannelId), { code: 'PROTECTED_ACCESS_DENIED' });
  await assert.rejects(ownerClient.readProtectedImportedHistory({ ...session, token: Buffer.alloc(32).toString('base64url') }, keyChannelId),
    { code: 'INVALID_PROTECTED_SESSION' });
  const legacy = await pinnedFetch(base + '/api/v2/challenge', { pawtalkTLSFingerprint: fingerprint });
  assert.equal(legacy.status, 404);
  const revisionPath = `/api/v3/history/revision/${keyChannelId}/1`;
  const revisionHeaders = { Authorization: `Bearer ${session.token}` };
  const revisionBasis = await ownerClient.fetchJSON(session.base, revisionPath + '/basis', {
    fingerprint: session.fingerprint, headers: revisionHeaders,
  });
  assert.equal(revisionBasis.originalDigest, createHash('sha256').update(Buffer.from(packet.signature, 'base64url')).digest('hex'));
  const { revision, previousDigest, policyRevision, policyDigest: editPolicyDigest, archiveDigest } = revisionBasis;
  const revisionOperation = '9'.repeat(32);
  const editContext = {
    serverId, channelId: keyChannelId, position: 1, originalDigest: revisionBasis.originalDigest, revision, previousDigest,
    operationId: revisionOperation, authorProfileId: session.profileId, authorDeviceId: session.deviceId,
    policyRevision, policyDigest: editPolicyDigest, archive: revisionBasis.archive.Record, archiveDigest,
  };
  const edit = sealProtectedRevision(editContext, 'Edited imported text', revisionBasis.recipients, device);
  const revisionReceipt = await ownerClient.fetchJSON(session.base, revisionPath, {
    method: 'PUT', fingerprint: session.fingerprint, headers: revisionHeaders, body: JSON.stringify({
      revision, previousDigest, policyRevision, policyDigest: editPolicyDigest, archiveDigest, operationId: revisionOperation, ...edit,
    }),
  });
  const edition = await ownerClient.fetchJSON(session.base, revisionPath, { fingerprint: session.fingerprint, headers: revisionHeaders });
  assert.equal(edition.digest, revisionReceipt.digest);
  const { secret: editingArchive } = await ownerClient.loadProtectedRuntimeKey(session, keyChannelId, 'archive', trustOptions);
  try {
    assert.equal(openProtectedRevisionForArchive(editContext, edition.record.packet, editingArchive,
      migratorPublicKey.toString('hex')), 'Edited imported text');
  } finally {
    editingArchive.fill(0);
  }
  const cursor = combined.cursor;
  deleteDuringAttachment = true;
  await assert.rejects(ownerClient.readProtectedImportedFile(session, keyChannelId, 1, attachmentId), { code: 'PROTECTED_ACCESS_DENIED' });
  assert.equal(deleteDuringAttachment, false);
  await assert.rejects(ownerClient.readProtectedImportedFile(session, keyChannelId, 1, attachmentId), { code: 'PROTECTED_ACCESS_DENIED' });
  assert.equal((await ownerClient.readProtectedChatPage(session, keyChannelId, 2)).messages[0].replyTo, null);
  await assert.rejects(ownerClient.fetchJSON(session.base, revisionPath, { fingerprint: session.fingerprint, headers: revisionHeaders }),
    { code: 'PROTECTED_ACCESS_DENIED' });
  await ownerClient.deleteProtectedMessage(session, keyChannelId, 3);
  assert.deepEqual(await ownerClient.sendProtectedRuntimeText(session, keyChannelId, text, operation, trustOptions, 1),
    { Position: 3, Existing: true });
  const retained = await ownerClient.readProtectedChatPage(session, keyChannelId, 0, cursor);
  assert.deepEqual(retained.removed, [1, 3]);
  assert.deepEqual(retained.messages.map(message => message.position), [2]);
  assert.equal(retained.messages[0].replyTo, null);
  assert.deepEqual(await lookupReferences(session, ['9007199254740991', '9007199254740992', '9007199254740994']),
    [{ id: '9007199254740994', position: 2 }]);
  const audit = await ownerClient.readProtectedAudit(session);
  assert.equal(audit.retention, 365);
  assert.equal(audit.canChange, true);
  assert.deepEqual(audit.entries.map(({ actor, action, channelId, position }) => [actor, action, channelId, position]), [
    [session.profileId, 'message.delete', keyChannelId, 3],
    [session.profileId, 'message.delete', keyChannelId, 1],
    [session.profileId, 'message.edit', keyChannelId, 1],
    [session.profileId, 'message.pin', keyChannelId, 2],
    [session.profileId, 'server.avatar', undefined, undefined],
  ]);
  assert.ok(!JSON.stringify(audit).includes('legacy history'));
  const newList = { everyone: false, items: [{ id: 'b'.repeat(32), text: 'New encrypted item' }] };
  const newListOperation = '5'.repeat(32);
  const sendList = () => ownerClient.sendProtectedRuntimeText(session, keyChannelId, 'New checklist', newListOperation, trustOptions, 2, newList);
  await assert.rejects(sendList(), /synthetic checklist response loss/);
  assert.deepEqual(await sendList(), { Position: 4, Existing: true });
  const page = await ownerClient.readProtectedChatPage(session, keyChannelId, 3);
  assert.deepEqual(page.messages.map(message => [message.position, message.text, message.checklist, message.replyTo, message.canEdit]),
    [[4, 'New checklist', newList, 2, true]]);
  tamperChecklist = true;
  await assert.rejects(ownerClient.readProtectedChatPage(session, keyChannelId, 3), { code: 'INVALID_PROTECTED_TEXT' });
  tamperChecklist = false;
  assert.deepEqual(await ownerClient.protectedChecklist(session, keyChannelId, 4),
    { revision: 0, canCheck: true, checked: {} });
  assert.deepEqual(await ownerClient.protectedChecklist(session, keyChannelId, 4,
    { operationId: '4'.repeat(32), item: newList.items[0].id, checked: true }),
  { revision: 1, canCheck: true, checked: { [newList.items[0].id]: true } });
  await assert.rejects(ownerClient.editProtectedChatMessage(session, keyChannelId, 4, 1, '1'.repeat(32), 'Plain text'),
    { code: 'INVALID_PROTECTED_REVISION' });
  const revised = { everyone: true, items: [{ ...newList.items[0], text: 'Reworded item' }, { id: 'c'.repeat(32), text: 'Extra task' }] };
  const save = () => ownerClient.editProtectedChatMessage(session, keyChannelId, 4, 1, '2'.repeat(32), 'Edited checklist', revised);
  const savedList = await save();
  assert.deepEqual(await save(), { ...savedList, existing: true });
  const editedList = await ownerClient.readProtectedChatEdition(session, keyChannelId, 4);
  assert.deepEqual([editedList.text, editedList.checklist, editedList.revision, editedList.replyTo], ['Edited checklist', revised, 2, 2]);
  assert.deepEqual(await ownerClient.protectedChecklist(session, keyChannelId, 4),
    { revision: 2, canCheck: true, checked: { [newList.items[0].id]: true } });
  const reduced = { ...revised, items: revised.items.slice(1) };
  await ownerClient.editProtectedChatMessage(session, keyChannelId, 4, 2, '3'.repeat(32), 'Reduced checklist', reduced);
  assert.deepEqual(await ownerClient.protectedChecklist(session, keyChannelId, 4),
    { revision: 3, canCheck: true, checked: {} });
  await assert.rejects(ownerClient.protectedChecklist(session, keyChannelId, 4,
    { operationId: '6'.repeat(32), item: newList.items[0].id, checked: true }), { code: 'INVALID_PROTECTED_ACTION' });
  await ownerClient.editProtectedChatMessage(session, keyChannelId, 2, 1, '7'.repeat(32), 'Edited imported list', checklist);
  assert.equal((await ownerClient.readProtectedPinnedMessage(session, keyChannelId, 2)).text, 'Edited imported list');
  const poll = { duration: 3600, anonymous: false, multiple: false, intermediate: true, options: ['Project A', 'Project B'] };
  const createPoll = () => ownerClient.sendProtectedRuntimeText(session, keyChannelId, 'Which project?', 'b'.repeat(32),
    trustOptions, undefined, undefined, poll);
  assert.deepEqual(await createPoll(), { Position: 5, Existing: false });
  assert.deepEqual(await createPoll(), { Position: 5, Existing: true });
  const newPoll = (await ownerClient.readProtectedChatPage(session, keyChannelId, 4)).messages[0];
  assert.deepEqual([newPoll.position, newPoll.text, newPoll.poll, newPoll.canEdit], [5, 'Which project?', poll, false]);
  const status = await ownerClient.protectedPoll(session, keyChannelId, 5);
  assert.equal(status.closesAt, newPoll.sentAt + 3600000);
  assert.equal(status.canVote, true);
  assert.equal(await ownerClient.protectedPoll(session, keyChannelId, 5, { choices: [1], operationId: 'c'.repeat(32) }), true);
  const voted = await ownerClient.protectedPoll(session, keyChannelId, 5);
  assert.deepEqual([voted.counts, voted.own, voted.voters.map(group => group.map(voter => voter.id))],
    [[0, 1], [1], [[], [session.profileId]]]);
  assert.equal(typeof voted.voters[1][0].name, 'string');
  assert.equal(await ownerClient.protectedPoll(session, keyChannelId, 5, undefined, true), true);
  assert.deepEqual((await ownerClient.readProtectedChatPage(session, keyChannelId, 5)).messages, []);
  await ownerClient.serviceProtectedRuntimeRotations(session);
  const result = (await ownerClient.readProtectedChatPage(session, keyChannelId, 5)).messages[0];
  assert.deepEqual([result.position, result.text, result.originalPollPosition, result.pollResult],
    [6, 'Which project?', 5, { winners: ['Project B'] }]);
  await ownerClient.setProtectedMessagePin(session, keyChannelId, 6, true);
  assert.deepEqual((await ownerClient.readProtectedPinnedMessage(session, keyChannelId, 6)).pollResult, result.pollResult);
  tamperPollResult = true;
  await assert.rejects(ownerClient.readProtectedChatPage(session, keyChannelId, 5), { code: 'INVALID_SERVER_IDENTITY' });
  tamperPollResult = false;

  const fileOperation = '6'.repeat(32);
  const posterBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRrkAAAAASUVORK5CYII=', 'base64');
  const file = { name: 'new private file.webm', mime: 'video/webm', bytes: Buffer.alloc(1048587, 0x7a),
    duration: 1, poster: { mime: 'image/png', bytes: posterBytes } };
  assert.equal((await ownerClient.readProtectedHistoryWindow(session, keyChannelId)).canAttach, true);
  loseAttachmentWrite = true;
  const stage = () => ownerClient.stageProtectedAttachment(session, keyChannelId, fileOperation, 0, file);
  await assert.rejects(stage(), /synthetic attachment response loss/);
  const fileId = await stage();
  assert.equal(await stage(), fileId);
  const postFile = () => ownerClient.sendProtectedRuntimeText(session, keyChannelId, '', fileOperation,
    trustOptions, 2, undefined, undefined, [fileId]);
  assert.deepEqual(await postFile(), { Position: 7, Existing: false });
  assert.deepEqual(await postFile(), { Position: 7, Existing: true });
  const posted = (await ownerClient.readProtectedChatPage(session, keyChannelId, 6)).messages[0];
  const [postedFile] = posted.files;
  assert.match(postedFile.poster.id, /^[a-f0-9]{32}$/);
  assert.notEqual(postedFile.poster.id, fileId);
  assert.deepEqual(posted.files, [{ id: fileId, name: file.name, mime: file.mime, size: file.bytes.length, duration: file.duration,
    poster: { id: postedFile.poster.id, mime: 'image/png' } }]);
  assert.equal(posted.replyTo, 2);
  assert.equal('attachmentParts' in posted, false);
  const browse = (input, connection = session, member = ownerClient) => member.browseProtectedChat(connection, keyChannelId, {
    after: 0, ...input,
  });
  const search = await browse({ mode: 'search', query: 'PRIVATE FILE' });
  assert.deepEqual(search.matches.map(row => row.position), [7]);
  assert.equal(search.matches[0].files, undefined);
  const editedSearch = await browse({ mode: 'search', query: 'Edited imported list' });
  assert.deepEqual(editedSearch.matches.map(row => row.position), [2]);
  assert.deepEqual((await browse({ mode: 'search', query: 'legacy history /9007199254740994' })).matches, []);
  const gallery = await browse({ mode: 'gallery' });
  assert.deepEqual(gallery.matches.map(row => [row.position, row.files?.[0].name]), [[7, file.name]]);
  assert.equal('attachmentParts' in gallery.matches[0], false);
  assert.equal(gallery.matches[0].files[0].poster.id, postedFile.poster.id);
  assert.equal((await ownerClient.readProtectedChatReference(session, keyChannelId, 7)).files[0].id, fileId);
  for (const input of [{ mode: 'gallery' }, { mode: 'search', query: 'private' }]) {
    await assert.rejects(browse(input, adminSession, administrator), { code: 'PROTECTED_ACCESS_DENIED' });
  }
  await assert.rejects(administrator.readProtectedChatReference(adminSession, keyChannelId, 7), { code: 'PROTECTED_ACCESS_DENIED' });
  const readFile = () => ownerClient.readProtectedFile(session, keyChannelId, 7, fileId);
  const readPoster = position => ownerClient.readProtectedFile(session, keyChannelId, position, postedFile.poster.id);
  assert.deepEqual(Buffer.from(await readFile()), file.bytes);
  assert.deepEqual(Buffer.from(await readPoster(7)), posterBytes);
  await assert.rejects(readPoster(2), { code: 'PROTECTED_ACCESS_DENIED' });
  corruptLiveAttachment = true;
  await assert.rejects(readFile(), { code: 'INVALID_ATTACHMENT' });
  corruptLiveAttachment = false;
  await assert.rejects(administrator.readProtectedFile(adminSession, keyChannelId, 7, fileId), { code: 'PROTECTED_ACCESS_DENIED' });
  await ownerClient.deleteProtectedMessage(session, keyChannelId, 7);
  await assert.rejects(readFile(), { code: 'PROTECTED_ACCESS_DENIED' });
  await assert.rejects(readPoster(7), { code: 'PROTECTED_ACCESS_DENIED' });
  assert.deepEqual(await browse({ mode: 'gallery', after: 7, checkpoint: gallery.checkpoint }), { retry: true });
  assert.deepEqual((await browse({ mode: 'gallery' })).matches, []);
  assert.equal(await ownerClient.readProtectedChatReference(session, keyChannelId, 7), undefined);

  const mentionText = '@everyone @owner';
  const mentionRoster = await ownerClient.readProtectedRuntimeRoster(session, keyChannelId, undefined, undefined, true);
  assert.equal(mentionRoster.mentions.available, true);
  assert.equal(mentionRoster.mentions.mass, true);
  assert.ok(mentionRoster.members.some(member => member.id === session.profileId));
  await assert.rejects(administrator.readProtectedRuntimeRoster(adminSession, keyChannelId, undefined, undefined, true),
    { code: 'PROTECTED_ACCESS_DENIED' });
  const mentions = [{ kind: 'everyone', start: 0, end: 9 }, { kind: 'profile', id: session.profileId, start: 10, end: 16 }];
  const sendMentions = (operationId, spans) => ownerClient.sendProtectedRuntimeText(session, keyChannelId, mentionText, operationId,
    trustOptions, undefined, undefined, undefined, undefined, spans);
  await assert.rejects(sendMentions('a'.repeat(32), [mentions[0], { ...mentions[1], id: '01'.repeat(32) }]),
    { code: 'PROTECTED_ACCESS_DENIED' });
  assert.deepEqual(await sendMentions('a'.repeat(32), mentions), { Position: 8, Existing: false });
  const signedMention = (await ownerClient.readProtectedRuntimeText(session, keyChannelId, { after: 7 })).messages[0].Packet;
  assert.match(signedMention.MentionDigest, /^[a-f0-9]{64}$/);
  assert.equal(signedMention.MentionRouting, undefined);
  const openedMention = await ownerClient.readProtectedChatReference(session, keyChannelId, 8);
  assert.equal(openedMention.text, mentionText);
  assert.deepEqual(openedMention.mentions, mentions);
  assert.deepEqual((await ownerClient.pollProtectedMentions(session)).alerts, []);
  await assert.rejects(administrator.pollProtectedMentions(adminSession), { code: 'PROTECTED_ACCESS_DENIED' });
  await assert.rejects(administrator.readProtectedRuntimeText(adminSession, keyChannelId, { after: 7 }), { code: 'PROTECTED_ACCESS_DENIED' });
  const auditBeforeInvite = await ownerClient.readProtectedAudit(session);
  assert.ok(auditBeforeInvite.entries.some(entry => entry.kind === 'poll' && entry.action === 'poll.close'));
}

async function recoverMigratedOwner(position) {
  const ownerDeviceId = review.ownerRecipient.deviceId;
  const trust = { serverId, ownerProfileId: review.ownerProfileId, ownerDeviceId,
    anchorDigest: review.policyAnchorDigest, cutoverDigest: review.cutoverDigest };
  const bundle = createRecoveryBundle({ address, fingerprint, profileId: trust.ownerProfileId, trust, code: testRecoveryCode });
  const original = client(owner, pinnedFetch, new Map([[`pawtalk:protected-runtime:v1:${serverId}`, JSON.stringify(trust)]]));
  const retiredSession = await original.openStoredProtectedRuntime(serverId);
  const replacementKey = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex');
  const replacement = client({ root: replacementKey(), device: replacementKey() });
  const recovered = await replacement.recoverProtectedDeviceFromBundle(bundle);
  assert.equal(recovered.profileId, trust.ownerProfileId);
  assert.notEqual(recovered.deviceId, ownerDeviceId);
  await assert.rejects(original.readProtectedRuntimeState(retiredSession), { code: 'INVALID_PROTECTED_SESSION' });
  assert.equal((await replacement.readProtectedRuntimeState(recovered)).canManageChannels, true);
  for (let pass = 0; pass < 2; pass++) await replacement.serviceProtectedRuntimeRotations(recovered);
  const expectedText = position === 1 ? 'legacy history /9007199254740991' : 'Edited imported list';
  const page = await replacement.readProtectedChatPage(recovered, keyChannelId, position - 1);
  assert.equal(page.messages.find(message => message.position === position)?.text, expectedText,
    JSON.stringify({ first: page.first, retry: page.retry, positions: page.messages.map(({ position, locked }) => ({ position, locked })) }));
  if (position !== 1) return;
  const grant = { Action: 'channel.acl.update', OperationID: randomBytes(16).toString('hex'), ResourceChange: { ID: keyChannelId,
    ACL: { Roles: { '@everyone': { Allow: ['channel.view', 'history.full'], Deny: null } }, Profiles: null } } };
  const preview = await replacement.previewProtectedRuntimePolicy(recovered, grant, trust);
  await replacement.commitProtectedRuntimePolicy(recovered, { preview, intent: grant, expectedResultDigest: preview.draft.ResultDigest }, trust);
  const { link } = await replacement.createProtectedInvite(recovered);
  const guest = client({ root: replacementKey(), device: replacementKey() }, (url, options) => pinnedFetch(url, {
    ...options, headers: { ...options.headers, 'X-PawTalk-Test-Peer': 'invitee' },
  }));
  await guest.redeemProtectedInvite(link, 'Migrated history reader');
  const visitor = await guest.openStoredProtectedRuntime(serverId);
  await assert.rejects(guest.fetchProtectedRuntimePolicyPage(visitor, 0), { code: 'PROTECTED_ACCESS_DENIED' });
  for (let pass = 0; pass < 3; pass++) await replacement.serviceProtectedRuntimeRotations(recovered);
  const scopedPage = await guest.readProtectedChatPage(visitor, keyChannelId, 0);
  assert.equal(scopedPage.messages.find(message => message.position === 1)?.text, expectedText);
}

async function redeemProtectedInvites() {
  const deviceId = review.ownerRecipient.deviceId;
  const runtimeTrust = { serverId, ownerProfileId: review.ownerProfileId, ownerDeviceId: deviceId,
    anchorDigest: policyProof.Digest, cutoverDigest: review.cutoverDigest };
  const saved = new Map([
    [`pawtalk:agreement:v1:${serverId}:${deviceId}`, testAgreementSeed],
    [`pawtalk:protected-runtime:v1:${serverId}`, JSON.stringify(runtimeTrust)],
  ]);
  const ownerClient = client(owner, pinnedFetch, saved);
  const session = await ownerClient.openStoredProtectedRuntime(serverId);
  const administrator = client(admin);
  const adminSession = await administrator.openProtectedRuntimeSession(serverId, review.cutoverDigest);
  await ownerClient.refreshProtectedRuntimePolicy(session, runtimeTrust);
  const openChannel = randomBytes(16).toString('hex');
  const create = { Action: 'channel.create', OperationID: randomBytes(16).toString('hex'),
    ResourceChange: { ID: openChannel, Channel: { Kind: 'text', Settings: {
      Name: 'Invite fixture channel', Description: '', SlowmodeSeconds: 0, VoiceCapacity: 0,
    } }, ACL: { Roles: { '@everyone': { Allow: ['channel.view', 'history.full'], Deny: null } }, Profiles: null } } };
  const preview = await ownerClient.previewProtectedRuntimePolicy(session, create, runtimeTrust);
  await ownerClient.commitProtectedRuntimePolicy(session, { preview, intent: create, expectedResultDigest: preview.draft.ResultDigest }, runtimeTrust);
  const previous = await ownerClient.refreshProtectedRuntimePolicy(session, runtimeTrust);
  await ownerClient.serviceProtectedRuntimeRotations(session);

  const issued = await ownerClient.createProtectedInvite(session);
  const { invite, link } = issued;
  assert.deepEqual([invite.maxUses, invite.expiresAt - invite.createdAt], [1, 86400000]);
  const inviteList = await ownerClient.listProtectedInvites(session);
  assert.deepEqual(inviteList.invites, [invite]);
  assert.equal(inviteList.policyHead, previous.digest);
  const invitation = new URL(link);
  const fragment = new URLSearchParams(invitation.hash.slice(1));
  assert.deepEqual([...fragment.keys()], ['v', 'server', 'invite', 'token', 'cutover', 'anchor', 'owner', 'ownerDevice']);
  const capability = fragment.get('token');
  assert.equal(JSON.stringify(inviteList).includes(capability), false);
  const timed = await ownerClient.createProtectedInvite(session, { expiresAt: invite.expiresAt, maxUses: 0 });
  assert.deepEqual([timed.invite.expiresAt, timed.invite.maxUses], [invite.expiresAt, 0]);
  await ownerClient.revokeProtectedInvite(session, timed.invite.id);
  const profile = generateKeyPairSync('ed25519'), joiningDevice = generateKeyPairSync('ed25519');
  const rawPrivate = key => key.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
  const seeds = { root: rawPrivate(profile.privateKey), device: rawPrivate(joiningDevice.privateKey) };
  const credentialFiles = new Map();
  let sentClaim;
  let departureBody;
  const applicantFetch = async (url, options) => {
    options = { ...options, headers: { ...options.headers, 'X-PawTalk-Test-Peer': 'invitee' } };
    assert.equal(url.includes(capability), false);
    if (url.endsWith('/member/leave') && departureBody === undefined) {
      departureBody = options.body;
      const response = await pinnedFetch(url, options);
      assert.equal(response.status, 200);
      throw Object.assign(new Error('Synthetic lost departure reply'), { code: 'ECONNRESET' });
    }
    if (!url.endsWith('/invites/redeem')) return pinnedFetch(url, options);
    assert.equal(options.headers.Authorization, undefined);
    if (JSON.parse(options.body).inviteId !== invite.id) return pinnedFetch(url, options);
    assert.equal(options.body.includes(capability), false);
    if (sentClaim === undefined) {
      sentClaim = options.body;
      const response = await pinnedFetch(url, options);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).existing, false);
      throw Object.assign(new Error('Synthetic lost reply'), { code: 'LOST_REPLY' });
    }
    assert.equal(options.body, sentClaim);
    return pinnedFetch(url, options);
  };
  const nickname = 'Synthetic new member';
  const applicantClient = client(seeds, applicantFetch, credentialFiles);
  const wrongCutover = new URL(link);
  fragment.set('cutover', '0'.repeat(64));
  wrongCutover.hash = fragment.toString();
  await assert.rejects(applicantClient.redeemProtectedInvite(wrongCutover.href, nickname), { code: 'PROTECTED_CUTOVER_CHANGED' });
  assert.equal(sentClaim, undefined);
  const noPin = client(seeds, () => assert.fail('request before TLS pin check'));
  noPin.verify = async () => '0'.repeat(64);
  await assert.rejects(noPin.redeemProtectedInvite(link, nickname), { code: 'SERVER_KEY_CHANGED' });
  await assert.rejects(applicantClient.redeemProtectedInvite(link, nickname), { code: 'LOST_REPLY' });
  const restartedApplicant = client(seeds, applicantFetch, credentialFiles);
  const admission = await restartedApplicant.redeemProtectedInvite(link, 'Edited during retry');
  assert.equal(admission.inviteId, invite.id);
  assert.equal(admission.profileId, (await applicantClient.identity()).profileId);
  assert.equal(admission.keysPending, true);
  assert.equal(admission.existing, true);
  assert.equal(admission.nickname, nickname);
  assert.deepEqual(await restartedApplicant.loadProtectedRuntimeTrust(serverId), runtimeTrust);
  assert.equal(Array.from(credentialFiles.values()).some(value => value.includes(capability)), false);
  const joined = await restartedApplicant.openStoredProtectedRuntime(serverId);
  const state = await restartedApplicant.readProtectedRuntimeState(joined);
  assert.equal(state.channels.find(channel => channel.id === openChannel)?.keysPending, true);
  assert.equal(state.canListInvites, false);
  await assert.rejects(restartedApplicant.loadProtectedRuntimeKey(joined, openChannel, 'live', { policyTrust: runtimeTrust }),
    error => ['PROTECTED_ACCESS_DENIED', 'PROTECTED_KEY_PENDING', 'POLICY_ATTESTATION_UNAVAILABLE'].includes(error.code));
  const listed = (await ownerClient.listProtectedInvites(session)).invites.find(entry => entry.id === invite.id);
  assert.equal(listed.canRevoke, false);
  assert.equal(listed.uses, 1);
  const auditAfterInvite = await ownerClient.readProtectedAudit(session);
  const inviteAudit = auditAfterInvite.entries.filter(entry => entry.kind === 'invite');
  assert.ok(inviteAudit.some(entry => entry.action === 'invite.accept' && entry.objectId === invite.id));
  assert.equal(JSON.stringify(inviteAudit).includes(capability), false);
  const pending = await restartedApplicant.openProtectedPendingInviteSession(serverId, review.cutoverDigest);
  assert.equal(pending.profileId, admission.profileId);
  assert.equal(pending.deviceId, admission.deviceId);
  const evidencePath = `/api/v3/invites/admissions/${admission.deviceId}`;
  const evidence = connection => ownerClient.fetchJSON(connection.base, evidencePath, {
    fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
  });
  const candidate = await evidence(session);
  assert.equal(candidate.ID, admission.profileId);
  assert.equal(candidate.Admission.Issuance.PolicyDigest, previous.digest);
  assert.equal(candidate.Admission.Issuance.AcceptedAt, admission.acceptedAt);
  assert.ok(candidate.Admission.Issuance.Signature);
  assert.equal(JSON.stringify(candidate).includes(capability), false);
  await assert.rejects(evidence(pending), { code: 'INVALID_PROTECTED_SESSION' });
  await assert.rejects(evidence(adminSession), { code: 'PROTECTED_ACCESS_DENIED' });
  assert.deepEqual(await applicantClient.readProtectedPendingInviteState(pending), {
    inviteId: invite.id, profileId: admission.profileId, deviceId: admission.deviceId, acceptedAt: admission.acceptedAt,
    nickname, keysPending: true,
  });
  await assert.rejects(applicantClient.readProtectedRuntimeState(pending), { code: 'INVALID_PROTECTED_SESSION' });
  await assert.rejects(ownerClient.fetchJSON(session.base, '/api/v3/invites/session/state', {
    fingerprint: session.fingerprint, headers: { Authorization: `Bearer ${session.token}` },
  }), { code: 'INVALID_PROTECTED_SESSION' });
  const current = await ownerClient.refreshProtectedRuntimePolicy(session, runtimeTrust);
  assert.equal(current.revision, previous.revision + 1);
  const enrolled = await ownerClient.readProtectedOwnerPolicy(session);
  assert.deepEqual(enrolled.snapshot.Members[admission.profileId].Roles, null);
  assert.equal(enrolled.snapshot.InvitationUses[invite.id].Count, 1);
  for (let attempt = 0; attempt < 6; attempt++) await ownerClient.serviceProtectedRuntimeRotations(session);
  for (const purpose of ['live', 'archive']) {
    const delivery = await restartedApplicant.loadProtectedRuntimeKey(joined, openChannel, purpose, { policyTrust: runtimeTrust });
    assert.ok(delivery.record.Generation >= 1);
    delivery.secret.fill(0);
  }
  assert.equal((await restartedApplicant.readProtectedRuntimeState(joined)).channels.find(channel => channel.id === openChannel)?.keysPending, undefined);

  await assert.rejects(ownerClient.leave(serverId, { protectedConnection: session }), { code: 'PROTECTED_OWNER_LEAVE' });
  const assigned = { Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
    Roles: enrolled.snapshot.Roles, Order: enrolled.snapshot.Order, Assignments: { [admission.profileId]: ['member'] },
  } };
  const assignment = await ownerClient.previewProtectedRuntimePolicy(session, assigned, runtimeTrust);
  await ownerClient.commitProtectedRuntimePolicy(session, { preview: assignment, intent: assigned, expectedResultDigest: assignment.draft.ResultDigest }, runtimeTrust);
  const oldKey = enrolled.snapshot.KeyRecipients[admission.deviceId].PublicKey;
  await restartedApplicant.leave(serverId, { protectedConnection: joined });
  assert.deepEqual(await restartedApplicant.registry(), []);
  assert.ok(departureBody);
  await assert.rejects(restartedApplicant.readProtectedRuntimeState(joined), { code: 'INVALID_PROTECTED_SESSION' });
  const retryClient = client(seeds, applicantFetch, credentialFiles);
  assert.deepEqual(await retryClient.pendingDepartures(Date.now() + 61_000), [{ serverId, outcome: 'done' }]);
  const oldClaimRetry = await pinnedFetch(session.base + '/api/v3/invites/redeem', {
    method: 'POST', pawtalkTLSFingerprint: fingerprint, headers: { 'Content-Type': 'application/json' }, body: sentClaim,
  });
  assert.equal(oldClaimRetry.status, 403);
  const departed = await ownerClient.readProtectedOwnerPolicy(session);
  assert.equal(departed.snapshot.Members[admission.profileId].Active, false);
  assert.equal(departed.snapshot.RetiredRecipientKeys[oldKey], true);
  const reinvite = await ownerClient.createProtectedInvite(session);
  const readmitted = await retryClient.redeemProtectedInvite(reinvite.link, nickname);
  assert.deepEqual([readmitted.profileId, readmitted.deviceId], [admission.profileId, admission.deviceId]);
  const afterRejoin = await ownerClient.readProtectedOwnerPolicy(session);
  assert.deepEqual(afterRejoin.snapshot.Members[admission.profileId].Roles, null);
  assert.notEqual(afterRejoin.snapshot.KeyRecipients[admission.deviceId].PublicKey, oldKey);
  const retry = await pinnedFetch(session.base + '/api/v3/member/leave', {
    method: 'POST', pawtalkTLSFingerprint: fingerprint, headers: { 'Content-Type': 'application/json' }, body: departureBody,
  });
  assert.equal(retry.status, 200);
  await assert.rejects(restartedApplicant.readProtectedRuntimeState(joined), { code: 'INVALID_PROTECTED_SESSION' });
  const reopened = await retryClient.openStoredProtectedRuntime(serverId);
  assert.ok((await retryClient.readProtectedRuntimeState(reopened)).channels.find(channel => channel.id === openChannel));
}

async function moderateProtectedMembers() {
  const ownerDeviceId = review.ownerRecipient.deviceId;
  const trust = { serverId, ownerProfileId: review.ownerProfileId, ownerDeviceId,
    anchorDigest: policyProof.Digest, cutoverDigest: review.cutoverDigest };
  const ownerClient = client(owner, pinnedFetch, new Map([[ `pawtalk:protected-runtime:v1:${serverId}`, JSON.stringify(trust) ]]));
  const session = await ownerClient.openStoredProtectedRuntime(serverId);
  const delegate = client(admin);
  const delegatedSession = await delegate.openProtectedRuntimeSession(serverId, review.cutoverDigest);
  const prior = (await ownerClient.readProtectedOwnerPolicy(session)).snapshot;
  const roleId = randomBytes(16).toString('hex');
  const roles = { Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
    Roles: { ...prior.Roles, [roleId]: { Grants: ['member.kick', 'member.ban'] } },
    Order: [...prior.Order, roleId], Assignments: { [delegatedSession.profileId]: [roleId] },
  } };
  const preview = await ownerClient.previewProtectedRuntimePolicy(session, roles, trust);
  await ownerClient.commitProtectedRuntimePolicy(session, { preview, intent: roles, expectedResultDigest: preview.draft.ResultDigest }, trust);
  const inherited = client(legacyBanned);
  const alias = client(legacyBannedAlias);
  const { profileId: inheritedId } = await inherited.identity();
  const reason = 'Legacy ban '.repeat(25) + 'source';
  assert.deepEqual((await delegate.listProtectedBans(delegatedSession)).bans,
    [{profileId: inheritedId, expiresAt: 0, reason, inherited: true}]);
  const rejoin = await ownerClient.createProtectedInvite(session);
  for (const bannedClient of [inherited, alias]) {
    await assert.rejects(bannedClient.redeemProtectedInvite(rejoin.link, 'Synthetic former member'), {
      code: 'BANNED', details: { reason, expiresAt: null },
    });
  }
  await delegate.changeProtectedMembership(delegatedSession, 'unban', inheritedId);
  assert.deepEqual((await delegate.listProtectedBans(delegatedSession)).bans, []);
  await assert.rejects(inherited.openProtectedRuntimeSession(serverId, review.cutoverDigest), { code: 'NOT_A_MEMBER' });
  assert.equal((await ownerClient.readProtectedOwnerPolicy(session)).snapshot.InheritedBanLifts[inheritedId], true);
  await inherited.redeemProtectedInvite(rejoin.link, 'Synthetic former member');
  const readmittedLegacy = await inherited.openStoredProtectedRuntime(serverId);
  assert.equal(readmittedLegacy.profileId, inheritedId);
  assert.equal((await ownerClient.readProtectedOwnerPolicy(session)).snapshot.InheritedBanLifts[inheritedId], true);
  await assert.rejects(alias.redeemProtectedInvite(rejoin.link, 'Synthetic former alias'), { code: 'PROTECTED_INVITE_CONFLICT' });
  await assert.rejects(delegate.changeProtectedMembership(delegatedSession, 'kick', session.profileId, { reason: 'Owner is protected' }),
    { code: 'PROTECTED_ACCESS_DENIED' });
  const seed = () => randomBytes(32).toString('hex');
  const guest = client({ root: seed(), device: seed() });
  const join = async () => {
    const invitation = await ownerClient.createProtectedInvite(session);
    await guest.redeemProtectedInvite(invitation.link, 'Synthetic moderation target');
    return guest.openStoredProtectedRuntime(serverId);
  };
  const first = await join();
  await assert.rejects(delegate.changeProtectedMembership(delegatedSession, 'kick', first.profileId), { code: 'INVALID_INPUT' });
  await assert.rejects(delegate.previewProtectedCleanup(delegatedSession, 'kick', session.profileId, 'all'), { code: 'PROTECTED_ACCESS_DENIED' });
  const cleanup = await delegate.previewProtectedCleanup(delegatedSession, 'kick', first.profileId, 'hour');
  assert.equal(cleanup.count, 0);
  const early = await pinnedFetch(session.base + '/api/v3/moderation/cleanup/apply', {
    method: 'POST', pawtalkTLSFingerprint: fingerprint,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${delegatedSession.token}` },
    body: JSON.stringify({ id: cleanup.id, operationId: randomBytes(16).toString('hex') }),
  });
  assert.equal(early.status, 409);
  assert.deepEqual(await delegate.changeProtectedMembership(delegatedSession, 'kick', first.profileId, {
    reason: 'Synthetic kick', cleanupId: cleanup.id,
  }), { cleanup: 'done', removed: 0 });
  await assert.rejects(guest.openStoredProtectedRuntime(serverId), { code: 'NOT_A_MEMBER', details: {
    membershipState: 'kicked', reason: 'Synthetic kick',
  } });
  const second = await join();
  assert.equal(second.profileId, first.profileId);
  await assert.rejects(guest.readProtectedRuntimeState(first), { code: 'INVALID_PROTECTED_SESSION' });
  const expiresAt = Date.now() + 120_000;
  assert.deepEqual(await ownerClient.changeProtectedMembership(session, 'ban', second.profileId, {
    reason: 'Synthetic ban', expiresAt, cleanupId: cleanup.id,
  }), { cleanup: 'failed' });
  const afterBan = await ownerClient.createProtectedInvite(session);
  await assert.rejects(guest.redeemProtectedInvite(afterBan.link, 'Synthetic moderation target'),
    { code: 'BANNED', details: { expiresAt, reason: 'Synthetic ban' } });
  await assert.rejects(guest.changeProtectedMembership(second, 'unban', second.profileId), { code: 'INVALID_PROTECTED_SESSION' });
  const banned = await delegate.listProtectedBans(delegatedSession);
  assert.deepEqual(banned.bans, [{ profileId: second.profileId, expiresAt, reason: 'Synthetic ban' }]);
  await delegate.changeProtectedMembership(delegatedSession, 'unban', second.profileId);
  assert.deepEqual((await delegate.listProtectedBans(delegatedSession)).bans, []);
  await assert.rejects(guest.openStoredProtectedRuntime(serverId), { code: 'NOT_A_MEMBER' });
  await guest.redeemProtectedInvite(afterBan.link, 'Synthetic moderation target');
  const third = await guest.openStoredProtectedRuntime(serverId);
  assert.equal(third.profileId, first.profileId);
  await assert.rejects(guest.readProtectedRuntimeState(second), { code: 'INVALID_PROTECTED_SESSION' });
  const current = (await ownerClient.readProtectedOwnerPolicy(session)).snapshot;
  assert.deepEqual(current.Members[third.profileId].Roles, null);
  assert.equal(current.MemberRemovals?.[third.profileId], undefined);
  const audit = (await ownerClient.readProtectedAudit(session)).entries;
  for (const [action, actor] of [['member.kick', delegatedSession.profileId], ['member.ban', session.profileId], ['member.unban', delegatedSession.profileId]]) {
    assert.ok(audit.some(entry => entry.action === action && entry.objectId === third.profileId && entry.actor === actor));
  }
}

async function changeProtectedPolicy() {
  const credentials = new Map();
  let corruptScope = false;
  let loseCommitResponse = false;
  const ownerClient = client(owner, async (url, options) => {
    assert.ok(!url.endsWith('/api/v3/policy/attestations'), 'policy commit must not require a second request');
    if (url.endsWith('/api/v3/policy/commit') && corruptScope) {
      const body = JSON.parse(options.body);
      assert.equal(Buffer.from(body.scopeAttestation, 'base64').length, 64);
      return pinnedFetch(url, { ...options, body: JSON.stringify({
        ...body, scopeAttestation: Buffer.alloc(64).toString('base64'),
      }) });
    }
    const response = await pinnedFetch(url, options);
    if (url.endsWith('/api/v3/policy/commit') && loseCommitResponse) {
      assert.equal(response.status, 200);
      throw new Error('synthetic committed policy response loss');
    }
    return response;
  }, credentials);
  const session = await ownerClient.openProtectedRuntimeSession(serverId, review.cutoverDigest);
  const policyTrust = { serverId, ownerProfileId: review.ownerProfileId, ownerDeviceId: session.deviceId,
    anchorDigest: policyProof.Digest, cutoverDigest: review.cutoverDigest };
  const trustedSession = { ...session, policyTrust };
  assert.equal((await ownerClient.refreshProtectedRuntimePolicy(session, policyTrust)).revision, 1);
  const initial = JSON.parse(Buffer.from(review.initialPolicy.snapshot, 'base64'));
  const administrator = client(admin);
  const adminSession = await administrator.openProtectedRuntimeSession(serverId, review.cutoverDigest);
  await assert.rejects(administrator.fetchProtectedRuntimePolicyPage(adminSession, 0), { code: 'PROTECTED_ACCESS_DENIED' });
  const scopedReader = { ...adminSession, policyTrust };
  const genesis = await administrator.readProtectedPolicyAttestation(scopedReader);
  assert.equal(genesis.revision, 1);
  assert.equal(genesis.digest, policyTrust.anchorDigest);
  const acl = { Action: 'channel.acl.update', OperationID: 'd'.repeat(32), ResourceChange: { ID: keyChannelId, ACL: {
    Roles: null, Profiles: { [adminSession.profileId]: { Allow: null, Deny: ['channel.view'] } },
  } } };
  await assert.rejects(administrator.fetchJSON(adminSession.base, '/api/v3/policy/preview', { method: 'POST',
    fingerprint: adminSession.fingerprint, body: JSON.stringify(acl), headers: { Authorization: `Bearer ${adminSession.token}` },
  }), { code: 'PROTECTED_ACCESS_DENIED' });
  const everyone = initial.Roles['@everyone'];
  const roles = { Action: 'roles.update', OperationID: 'e'.repeat(32), RoleUpdate: {
    Roles: { ...initial.Roles, '@everyone': { ...everyone,
      Grants: everyone.Grants.filter(grant => grant !== 'member.list'),
    } }, Order: initial.Order, Assignments: { [adminSession.profileId]: ['member'] },
    Presentation: { member: { Name: 'Community Members', Color: '#5a89bc', Icon: '🐾', Hoist: true, Mentionable: true } },
  } };
  const rolePreview = await ownerClient.previewProtectedRuntimePolicy(session, roles, policyTrust);
  assert.match(review.initialPolicy.draft.TextProjectionRoot, /^[0-9a-f]{64}$/);
  assert.equal(review.initialPolicy.draft.TextProjectionVersion, profileRoleAuthorityProjectionVersion);
  assert.equal(rolePreview.draft.TextProjectionVersion, profileRoleAuthorityProjectionVersion);
  const retryPreview = await ownerClient.previewProtectedRuntimePolicy(session, roles, policyTrust);
  assert.equal(rolePreview.draft.ResultDigest, retryPreview.draft.ResultDigest);
  assert.notEqual(rolePreview.draft.TextProjectionSeed, retryPreview.draft.TextProjectionSeed);
  assert.notEqual(rolePreview.draft.TextProjectionRoot, retryPreview.draft.TextProjectionRoot);
  const stale = await ownerClient.previewProtectedRuntimePolicy(session, acl, policyTrust);
  const commit = (preview, intent) => ownerClient.commitProtectedRuntimePolicy(trustedSession, {
    preview, intent, expectedResultDigest: preview.draft.ResultDigest,
  }, policyTrust);
  await assert.rejects(commit(rolePreview, { ...roles, OperationID: 'f'.repeat(32) }), { code: 'INVALID_POLICY_PREVIEW' });
  const forged = { ...rolePreview, draft: { ...rolePreview.draft, TextProjectionRoot: 'a'.repeat(64) } };
  await assert.rejects(commit(forged, roles), { code: 'INVALID_CHANNEL_POLICY_PROOF' });
  const identity = await ownerClient.identity();
  const frame = protectedPolicySignatureFrame(serverId, { ProfileID: session.profileId, DeviceID: session.deviceId },
    forged.draft, Buffer.from(forged.roleUpdate, 'base64'));
  const forgedSignature = sign(null, frame, identity.device).toString('base64');
  await assert.rejects(ownerClient.fetchJSON(session.base, '/api/v3/policy/commit', {
    method: 'POST', fingerprint: session.fingerprint,
    headers: { Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ ...forged.draft, Signature: forgedSignature }),
  }), { code: 'PROTECTED_POLICY_CHANGED' });
  corruptScope = true;
  await assert.rejects(commit(rolePreview, roles), { code: 'INVALID_POLICY_ATTESTATION' });
  assert.equal((await ownerClient.readProtectedOwnerPolicy(trustedSession)).revision, 1);
  corruptScope = false;
  loseCommitResponse = true;
  await assert.rejects(commit(rolePreview, roles), /synthetic committed policy response loss/);
  const admitted = await administrator.readProtectedPolicyAttestation(scopedReader);
  assert.equal(admitted.revision, 2);
  assert.equal(admitted.root, rolePreview.draft.TextProjectionRoot);
  loseCommitResponse = false;
  assert.equal((await commit(rolePreview, roles)).Digest, admitted.digest);
  await assert.rejects(commit(stale, acl), { code: 'PROTECTED_POLICY_CHANGED' });
  assert.equal((await ownerClient.refreshProtectedRuntimePolicy(session, policyTrust)).revision, 2);
  const revised = await ownerClient.previewProtectedRuntimePolicy(session, acl, policyTrust);
  const downgrade = { ...revised, draft: { ...revised.draft } };
  delete downgrade.draft.TextProjectionVersion;
  await assert.rejects(commit(downgrade, acl), { code: 'INVALID_CHANNEL_POLICY_PROOF' });
  assert.equal((await commit(revised, acl)).Draft.Revision, 3);
  assert.equal((await ownerClient.refreshProtectedRuntimePolicy(session, policyTrust)).revision, 3);
  const current = await ownerClient.policyCheckpoint().load(policyTrust);
  const snapshot = JSON.parse(Buffer.from(current.snapshot, 'base64'));
  assert.deepEqual(snapshot.Members[adminSession.profileId].Roles, ['member']);
  assert.deepEqual(snapshot.RolePresentation.member, roles.RoleUpdate.Presentation.member);
  assert.deepEqual(snapshot.Roles.member, initial.Roles.member);
  assert.deepEqual(snapshot.Order, initial.Order);
  const ownerProjection = await ownerClient.readProtectedOwnerPolicy({ ...session, policyTrust });
  assert.ok(ownerProjection.importedRoleNames.member);
  assert.ok(ownerProjection.importedProfileNames[adminSession.profileId]);
  assert.equal(ownerProjection.snapshot.RolePresentation.member.Name, 'Community Members');
  assert.deepEqual(snapshot.Channels[keyChannelId].ACL.Profiles[adminSession.profileId].Deny, ['channel.view']);
  const publicText = randomBytes(16).toString('hex');
  const createText = { Action: 'channel.create', OperationID: randomBytes(16).toString('hex'),
    ResourceChange: { ID: publicText, Channel: { Kind: 'text', Settings: {
      Name: 'Visible fixture text', Description: '', SlowmodeSeconds: 0, VoiceCapacity: 0,
    } }, ACL: { Roles: null, Profiles: { [adminSession.profileId]: { Allow: ['channel.view'], Deny: null } } } } };
  await commit(await ownerClient.previewProtectedRuntimePolicy(session, createText, policyTrust), createText);
  await ownerClient.refreshProtectedRuntimePolicy(session, policyTrust);
  const disclosure = await administrator.fetchProtectedRuntimeTextChannelProof(adminSession, publicText);
  const roster = await administrator.readProtectedRuntimeRoster(adminSession, publicText);
  assert.deepEqual(roster.members.map(member => member.id), [adminSession.profileId, session.profileId].sort());
  const listedAdmin = roster.members.find(member => member.id === adminSession.profileId);
  assert.equal(listedAdmin.color, '#5a89bc');
  assert.equal(listedAdmin.groupId, 'member');
  assert.deepEqual(listedAdmin.roles[0], { id: 'member', name: 'Community Members', icon: '🐾' });
  await assert.rejects(administrator.readProtectedRuntimeRoster(adminSession), { code: 'PROTECTED_ACCESS_DENIED' });
  const serverRoster = await ownerClient.readProtectedRuntimeRoster(session);
  assert.ok(serverRoster.members.some(member => member.id === adminSession.profileId && member.name));
  assert.deepEqual(Object.keys(disclosure).sort(), ['channelId', 'inclusion', 'policyDigest', 'revision']);
  assert.deepEqual(Object.keys(disclosure.inclusion).sort(), ['index', 'salt', 'siblings']);
  assert.equal(disclosure.inclusion.siblings.length, 10);
  await ownerClient.policyCheckpoint().verifyTextChannelDisclosure(publicText, disclosure, policyTrust);
  credentials.set(`pawtalk:agreement:v1:${serverId}:${session.deviceId}`, testAgreementSeed);
  const worker = { ...session, policyTrust };
  await ownerClient.serviceProtectedRuntimeRotations(worker);
  await ownerClient.serviceProtectedRuntimeRotations(worker);
  for (const purpose of ['live', 'archive']) {
    const { record, secret } = await ownerClient.loadProtectedRuntimeKey(session, publicText, purpose, { policyTrust });
    assert.equal(record.Generation, 1);
    secret.fill(0);
  }
  const denyText = { Action: 'channel.acl.update', OperationID: randomBytes(16).toString('hex'),
    ResourceChange: { ID: publicText, ACL: { Roles: null, Profiles: { [adminSession.profileId]: { Allow: null, Deny: ['channel.view'] } } } } };
  await commit(await ownerClient.previewProtectedRuntimePolicy(session, denyText, policyTrust), denyText);
  await ownerClient.refreshProtectedRuntimePolicy(session, policyTrust);
  await assert.rejects(administrator.readProtectedRuntimeRoster(adminSession, publicText, listedAdmin.id, roster.revision),
    { code: 'PROTECTED_ACCESS_DENIED' });
  await assert.rejects(ownerClient.readProtectedRuntimeRoster(session, publicText, listedAdmin.id, roster.revision),
    { code: 'PROTECTED_POLICY_CHANGED' });
  for (const channel of [publicText, randomBytes(16).toString('hex')]) {
    await assert.rejects(administrator.fetchProtectedRuntimeTextChannelProof(adminSession, channel), { code: 'PROTECTED_ACCESS_DENIED' });
  }
  await assert.rejects(ownerClient.policyCheckpoint().verifyTextChannelDisclosure(publicText, disclosure, policyTrust),
    { code: 'UNVERIFIED_EPOCH_POLICY' });
  const newDisclosure = await ownerClient.fetchProtectedRuntimeTextChannelProof(session, publicText);
  assert.equal(newDisclosure.revision, disclosure.revision + 1);
  const own = await ownerClient.policyCheckpoint().verifyTextChannelDisclosure(publicText, newDisclosure, policyTrust);
  assert.equal(own.id, session.deviceId);
  assert.equal(own.firstPosition, 1);
  assert.equal(own.archive, true);
  const voiceId = randomBytes(16).toString('hex');
  const settings = { Name: 'Fixture voice', Description: '', SlowmodeSeconds: 0, VoiceCapacity: 0 };
  const create = { Action: 'channel.create', OperationID: randomBytes(16).toString('hex'),
    ResourceChange: { ID: voiceId, Channel: { Kind: 'voice', Settings: settings } } };
  await commit(await ownerClient.previewProtectedRuntimePolicy(session, create, policyTrust), create);
  const first = await ownerClient.joinProtectedRuntimeVoice(session, voiceId, policyTrust);
  assert.match(first.key, /^[0-9a-f]{64}$/);
  assert.equal(first.keyEpoch, first.epoch.epochId);
  assert.equal(await ownerClient.refreshProtectedRuntimeVoiceKey(session, voiceId, policyTrust, first.keyEpoch), null);
  const signal = async token => (await pinnedFetch(base + '/rtc/rtc', { pawtalkTLSFingerprint: fingerprint,
    method: 'GET', headers: { Authorization: `Bearer ${token}` } })).status;
  assert.equal(await signal(first.token), 200);
  const edit = { Action: 'channel.settings.update', OperationID: randomBytes(16).toString('hex'),
    ResourceChange: { ID: voiceId, Settings: { ...settings, Name: 'Renamed fixture voice' } } };
  await commit(await ownerClient.previewProtectedRuntimePolicy(session, edit, policyTrust), edit);
  assert.equal(await signal(first.token), 403);
  const next = await ownerClient.refreshProtectedRuntimeVoiceKey(session, voiceId, policyTrust, first.keyEpoch);
  const view = await ownerClient.readProtectedRuntimeState(session);
  assert.equal(view.apiProtocolVersion, 3);
  assert.equal(view.channels.find(channel => channel.id === voiceId)?.settings?.name, edit.ResourceChange.Settings.Name);
  assert.notEqual(next.key, first.key);
  const fresh = await ownerClient.reconnectProtectedRuntimeVoice(session, voiceId, policyTrust);
  assert.equal(fresh.keyEpoch, next.epochId);
  assert.equal(fresh.key, next.key);
  assert.notEqual(fresh.token, first.token);
  assert.equal(await signal(fresh.token), 200);
  await ownerClient.leaveProtectedRuntimeVoice(session);
  assert.equal(await signal(fresh.token), 403);
  await assert.rejects(ownerClient.reconnectProtectedRuntimeVoice(session, voiceId, policyTrust), { code: 'PROTECTED_ACCESS_DENIED' });
  const ownerConnection = { ...session, policyTrust };
  const before = (await ownerClient.readProtectedOwnerPolicy(ownerConnection)).snapshot;
  const remove = { Action: 'roles.update', OperationID: randomBytes(16).toString('hex'), RoleUpdate: {
    Roles: before.Roles, Order: before.Order, Assignments: { [adminSession.profileId]: [] },
  } };
  await commit(await ownerClient.previewProtectedRuntimePolicy(session, remove, policyTrust), remove);
  const after = (await ownerClient.readProtectedOwnerPolicy(ownerConnection)).snapshot;
  assert.deepEqual(after.Members[adminSession.profileId].Roles, []);
  assert.deepEqual(after.Members[session.profileId], before.Members[session.profileId]);
  assert.deepEqual(after.RolePresentation, before.RolePresentation);
  const categoryA = randomBytes(16).toString('hex'), categoryB = randomBytes(16).toString('hex');
  const applyResource = async (Action, ResourceChange) => {
    const intent = { Action, OperationID: randomBytes(16).toString('hex'), ResourceChange };
    await commit(await ownerClient.previewProtectedRuntimePolicy(session, intent, policyTrust), intent);
    await ownerClient.refreshProtectedRuntimePolicy(session, policyTrust);
  };
  await applyResource('category.create', { ID: categoryA, Name: 'First category' });
  await applyResource('category.create', { ID: categoryB, Name: 'Open category' });
  const ownerCategories = (await ownerClient.readProtectedRuntimeState(ownerConnection)).categories;
  assert.deepEqual([categoryA, categoryB].map(id => ownerCategories.find(category => category.id === id)), [
    { id: categoryA, name: 'First category' }, { id: categoryB, name: 'Open category' },
  ]);
  await applyResource('category.acl.update', { ID: categoryB, ACL: { Roles: null, Profiles: {
    [adminSession.profileId]: { Allow: ['channel.view'], Deny: null },
  } } });
  await applyResource('channel.move', { ID: publicText, CategoryID: categoryA, Mode: 'preserve' });
  let memberView = await administrator.readProtectedRuntimeState(adminSession);
  assert.ok(!memberView.categories.some(category => category.id === categoryA || category.id === categoryB));
  assert.ok(!memberView.channels.some(channel => channel.id === publicText));
  await applyResource('channel.move', { ID: publicText, CategoryID: categoryB, Mode: 'synchronize' });
  await applyResource('category.settings.update', { ID: categoryB, Name: 'Renamed category' });
  memberView = await administrator.readProtectedRuntimeState(adminSession);
  assert.deepEqual(memberView.categories.find(category => category.id === categoryB), { id: categoryB, name: 'Renamed category' });
  assert.equal(memberView.channels.find(channel => channel.id === publicText)?.categoryId, categoryB);
  await applyResource('category.delete', { ID: categoryB, Mode: 'keep_children' });
  memberView = await administrator.readProtectedRuntimeState(adminSession);
  assert.ok(!memberView.categories.some(category => category.id === categoryB));
  assert.equal(memberView.channels.find(channel => channel.id === publicText)?.categoryId, '');
  const categoryCopy = randomBytes(16).toString('hex');
  await applyResource('category.copy', { ID: categoryCopy, SourceID: categoryA, Name: 'Copy of first category' });
  await applyResource('category.order', { ID: categoryCopy, AnchorID: categoryA });
  await applyResource('channel.order', { ID: publicText, AnchorID: keyChannelId, After: true });
  const ordered = (await ownerClient.readProtectedOwnerPolicy(ownerConnection)).snapshot;
  assert.ok(ordered.CategoryOrder.indexOf(categoryCopy) < ordered.CategoryOrder.indexOf(categoryA));
  assert.equal(ordered.CategoryNames[categoryCopy], 'Copy of first category');
  assert.deepEqual(ordered.Categories[categoryCopy], ordered.Categories[categoryA]);
  assert.ok(!Object.values(ordered.Channels).some(channel => channel.CategoryID === categoryCopy));
  const ownerView = await ownerClient.readProtectedRuntimeState(session);
  assert.ok(ownerView.channels.findIndex(channel => channel.id === publicText) > ownerView.channels.findIndex(channel => channel.id === keyChannelId));
}

(recipient === 'automatic-standalone-live' ? migrateStandalone(true) :
  recipient === 'automatic-standalone' ? migrateStandalone() :
  recipient === 'recover-migrated-owner' ? recoverMigratedOwner(1) :
  recipient === 'recover-migrated-owner-after-changes' ? recoverMigratedOwner(2) :
  recipient === 'restored-backup-runtime' ? rejectRestoredBackup() :
  recipient === 'moderation-runtime' ? moderateProtectedMembers() : recipient === 'invites-runtime' ? redeemProtectedInvites() :
  recipient === 'policy-runtime' ? changeProtectedPolicy() :
  recipient === 'read-protected' ? readProtectedHistory() : recipient === 'sign-cutover' ? approveCutover() :
  recipient === 'prepare-keys-before-restart' ? prepareChannelKeys(true) :
  recipient === 'prepare-keys' ? prepareChannelKeys() : recipient === 'sign-policy' ? approveInitialPolicy() :
  recipient ? enrollRecipient() : review ? approveImport() : main())
  .catch(error => { console.error(error); process.exitCode = 1; });
