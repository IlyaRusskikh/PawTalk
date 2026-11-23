const { createHash, randomBytes, sign } = require('node:crypto');
const { sealArchiveLink, openArchiveLinks } = require('./protected-archive-links.cjs');
const { openRecoveryArchiveTarget } = require('./protected-recovery-bootstrap.cjs');
const {
  sealEpochPackage, sealRecoveryEpochPackage, openSignedEpochPackage, packagesDigest, epochSignatureFrame, verifySignedEpoch,
  archiveRevisionPublicKey,
} = require('./protected-epoch-packages.cjs');

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const sourceOf = (serverId, record) => ({
  serverId, channelId: record.ChannelID, generation: record.Generation, keyId: record.KeyID,
});
const packageContext = (serverId, record, recipientId, recipientKey) => ({
  ...sourceOf(serverId, record), purpose: record.Purpose, revision: record.Revision, policyDigest: record.PolicyDigest,
  previousDigest: record.PreviousDigest, taskId: record.TaskID, leaseId: record.LeaseID, recipientId, recipientKey,
});

function assertSecret(secret, keyId) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32 || digest(secret) !== keyId) throw fail('ARCHIVE_KEY_MISMATCH');
}

function sealPackages(secret, serverId, record, recipients, openingProofRecipients = []) {
  if (!Array.isArray(openingProofRecipients) || openingProofRecipients.length > recipients.length) throw fail('INVALID_EPOCH_PACKAGES');
  const verifiedRecipients = new Map(recipients);
  let previous = '';
  for (const id of openingProofRecipients) {
    if (typeof id !== 'string' || id <= previous || verifiedRecipients.get(id)?.Kind !== 'recovery') {
      throw fail('INVALID_EPOCH_PACKAGES');
    }
    previous = id;
  }
  const opening = new Set(openingProofRecipients);
  return recipients.map(([id, recipient]) => {
    const seal = opening.has(id) ? sealRecoveryEpochPackage : sealEpochPackage;
    const context = packageContext(serverId, record, id, recipient.PublicKey);
    return { RecipientID: id, Purpose: record.Purpose, Ciphertext: seal(secret, context).toString('base64') };
  });
}

async function runLiveRotation({ serverId, channelId, profileId, identity, claim, authorizeTask, commit }) {
  const task = await claim(channelId, 'live');
  if (task?.ChannelID !== channelId || task.Purpose !== 'live') throw fail('UNVERIFIED_LIVE_TASK');
  const { liveTransitionDigest } = await authorizeTask(task) ?? {};
  const recipients = Object.entries(task.Recipients);
  if (recipients.length > 8192) throw fail('INVALID_EPOCH_PACKAGES');
  const secret = randomBytes(32);
  try {
    const { ChannelID, Purpose, Generation, Revision, PolicyDigest, PreviousDigest, TaskID, LeaseID } = task;
    const record = { ChannelID, Purpose, Generation, Revision, PolicyDigest, PreviousDigest, TaskID, LeaseID,
      ArchiveThrough: 0, ArchiveLinksDigest: '', KeyID: digest(secret),
      ...(liveTransitionDigest !== undefined && { LiveTransitionDigest: liveTransitionDigest }) };
    const packages = sealPackages(secret, serverId, record, recipients, task.openingProofRecipients);
    record.PackagesDigest = packagesDigest(packages);
    record.Signature = sign(null, epochSignatureFrame(serverId, profileId, identity.deviceId, record), identity.device).toString('base64');
    await commit(record, packages);
    return { generation: record.Generation, keyId: record.KeyID };
  } finally {
    secret.fill(0);
  }
}

// All callbacks are main-process protocol adapters. Trust decisions must use
// locally verified policy rather than trust material from the task response.
async function runArchiveRotation({ serverId, channelId, profileId, identity, privateKey, claim, authorizeTask,
  authorizeEpoch, loadTarget, loadTargets, commit, recovery }) {
  const task = await claim(channelId, 'archive');
  if (task?.ChannelID !== channelId || task.Purpose !== 'archive' || !Array.isArray(task.ArchiveTargets) ||
      task.ArchiveTargets.length < 1 || task.ArchiveTargets.length > 129) throw fail('UNVERIFIED_ARCHIVE_TASK');
  const { archiveTransitionDigest } = await authorizeTask(task) ?? {};
  const recipients = Object.entries(task.Recipients ?? {});
  if (!recipients.length || recipients.length > 8192) throw fail('INVALID_EPOCH_PACKAGES');
  const ownPublicKey = task.Recipients[identity.deviceId]?.PublicKey;
  if (!ownPublicKey) throw fail('UNVERIFIED_ARCHIVE_TASK');
  const secret = randomBytes(32);
  try {
    const { ChannelID, Purpose, Generation, Revision, PolicyDigest, PreviousDigest, TaskID, LeaseID, ArchiveThrough } = task;
    const record = { ChannelID, Purpose, Generation, Revision, PolicyDigest, PreviousDigest, TaskID, LeaseID, ArchiveThrough, KeyID: digest(secret) };
    record.ArchiveWrapKey = archiveRevisionPublicKey(serverId, record, secret);
    if (archiveTransitionDigest !== undefined) record.ArchiveTransitionDigest = archiveTransitionDigest;
    const packages = sealPackages(secret, serverId, record, recipients, task.openingProofRecipients);
    const links = [];
    let covered = 0;
    let previousLiveDigest;
    for (let offset = 0; offset < task.ArchiveTargets.length; offset += 8) {
      const targets = task.ArchiveTargets.slice(offset, offset + 8);
      const deliveries = loadTargets ? await loadTargets(task, targets) :
        await Promise.all(targets.map(target => loadTarget(task, target)));
      if (!Array.isArray(deliveries) || deliveries.length !== targets.length) throw fail('INVALID_ARCHIVE_TARGETS');
      const batch = await Promise.allSettled(targets.map(async (target, index) => {
        const delivery = deliveries[index];
        const epoch = delivery.Epoch;
        const recovered = delivery.Package?.RecipientID !== identity.deviceId;
        const context = {
          ...packageContext(serverId, epoch.Record, recovered ? recovery?.recoveryId : identity.deviceId,
            recovered ? recovery?.agreementKey : ownPublicKey),
          channelId, purpose: target.Purpose, generation: target.Generation, keyId: target.KeyID,
        };
        const material = recovered ? await openRecoveryArchiveTarget(delivery, context, profileId, recovery, authorizeEpoch) :
          openSignedEpochPackage(delivery, context, privateKey, await authorizeEpoch(epoch, context, delivery));
        try {
          assertSecret(material, target.KeyID);
          return { link: sealArchiveLink(secret, sourceOf(serverId, record), target, material), epoch: epoch.Record };
        } finally {
          material.fill(0);
        }
      }));
      for (const result of batch) {
        if (result.status === 'rejected') throw result.reason;
        const { link, epoch } = result.value;
        const signedDigest = digest(Buffer.from(epoch.Signature, 'base64'));
        if (links.length === 0 && Generation > 1) {
          if (link.Purpose !== 'archive' || link.Generation !== Generation - 1 || signedDigest !== PreviousDigest) {
            throw fail('INVALID_ARCHIVE_TARGETS');
          }
          covered = epoch.ArchiveThrough;
        } else {
          if (link.Purpose !== 'live' || link.Generation !== covered + 1 ||
              (previousLiveDigest !== undefined && epoch.PreviousDigest !== previousLiveDigest)) throw fail('INVALID_ARCHIVE_TARGETS');
          covered = link.Generation;
          previousLiveDigest = signedDigest;
        }
        links.push(link);
      }
    }
    if (covered !== ArchiveThrough) throw fail('INVALID_ARCHIVE_TARGETS');
    record.PackagesDigest = packagesDigest(packages);
    record.ArchiveLinksDigest = digest(JSON.stringify(links));
    record.Signature = sign(null, epochSignatureFrame(serverId, profileId, identity.deviceId, record), identity.device).toString('base64');
    await commit(record, packages, links);
    return { generation: record.Generation, keyId: record.KeyID, through: record.ArchiveThrough };
  } finally {
    secret.fill(0);
  }
}

const validTarget = (generation, keyId) => Number.isSafeInteger(generation) && generation > 0 &&
  typeof keyId === 'string' && /^[0-9a-f]{64}$/.test(keyId);
const copyCursor = cursor => ({ ...cursor, context: { ...cursor.context }, secret: Buffer.from(cursor.secret) });
const pageTransportErrors = new Set(['CONNECTION_FAILED', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
  'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED',
  'ERR_CONNECTION_REFUSED', 'ABORT_ERR', 'RATE_LIMIT']);
const transportInterrupted = error => pageTransportErrors.has(error.code) || ['AbortError', 'TimeoutError'].includes(error.name) ||
  (error instanceof TypeError && (error.message === 'fetch failed' || pageTransportErrors.has(error.cause?.code)));

function normalizeArchiveTargets(targets, generation, keyId, purpose, epochDigest) {
  if (targets === undefined) {
    if (!validTarget(generation, keyId) || !['live', 'archive'].includes(purpose)) throw fail('INVALID_ARCHIVE_REQUEST');
    return purpose === 'live' ? new Map([[generation, keyId]]) : new Map();
  }
  if (generation !== undefined || keyId !== undefined || purpose !== 'live' || epochDigest !== undefined ||
      !Array.isArray(targets) || !targets.length || targets.length > 32) throw fail('INVALID_ARCHIVE_REQUEST');
  const pending = new Map();
  for (const target of targets) {
    if (!validTarget(target?.generation, target?.keyId) || pending.has(target.generation)) throw fail('INVALID_ARCHIVE_REQUEST');
    pending.set(target.generation, target.keyId);
  }
  return pending;
}

async function readArchiveKey({ serverId, channelId, targetGeneration, targetKeyId, targetPurpose = 'live', targetEpochDigest, targets,
  head, headContext, privateKey,
  authorizeEpoch, acceptHead, fetchLinks, cursor, onInterrupted, revalidateRecipient = false, pageLimit = 32 }) {
  const pending = normalizeArchiveTargets(targets, targetGeneration, targetKeyId, targetPurpose, targetEpochDigest);
  const batch = targets !== undefined;
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 32 ||
      headContext.serverId !== serverId || headContext.channelId !== channelId || headContext.purpose !== 'archive') {
    throw fail('INVALID_ARCHIVE_REQUEST');
  }
  const signer = await authorizeEpoch(head.Epoch, headContext);
  const headDigest = verifySignedEpoch(head.Epoch, headContext, signer);
  let current = cursor;
  if (current) {
    if (current.headDigest !== headDigest) throw fail('ARCHIVE_CHAIN_CONFLICT');
    if (revalidateRecipient) {
      const headSecret = openSignedEpochPackage(head, headContext, privateKey, signer);
      try { assertSecret(headSecret, headContext.keyId); }
      finally { headSecret.fill(0); }
    }
    await acceptHead(head.Epoch);
    current = copyCursor(current);
  } else {
    const secret = openSignedEpochPackage(head, headContext, privateKey, signer);
    try {
      assertSecret(secret, headContext.keyId);
      await acceptHead(head.Epoch);
    } catch (error) {
      secret.fill(0);
      throw error;
    }
    current = { context: headContext, secret, proofDigest: headDigest, headDigest };
  }
  const keys = [];
  let retryPoint;
  let interrupted = false;
  let returnedKeys = false;
  const readPage = async (operation, malformedResponse = false) => {
    try { return await operation(); }
    catch (error) {
      interrupted = transportInterrupted(error) || (malformedResponse && error.code === 'INVALID_API_RESPONSE');
      throw error;
    }
  };
  try {
    for (let page = 0; page < pageLimit; page++) {
      if (current.context.serverId !== serverId || current.context.channelId !== channelId || current.context.purpose !== 'archive') {
        throw fail('INVALID_ARCHIVE_REQUEST');
      }
      const atTarget = targetPurpose === 'archive' && current.context.generation === targetGeneration;
      const { Epoch: epoch, Links: links } = atTarget && !current.predecessor
        ? { Epoch: head.Epoch } : await readPage(() => fetchLinks(channelId, current.context.keyId), true);
      const signer = await readPage(() => authorizeEpoch(epoch));
      const context = current.predecessor ? {
        ...current.context, revision: epoch.Record.Revision, policyDigest: epoch.Record.PolicyDigest,
        previousDigest: epoch.Record.PreviousDigest, taskId: epoch.Record.TaskID, leaseId: epoch.Record.LeaseID,
      } : current.context;
      if (verifySignedEpoch(epoch, context, signer) !== current.proofDigest) throw fail('ARCHIVE_CHAIN_CONFLICT');
      if (atTarget) {
        if (context.keyId !== targetKeyId || (targetEpochDigest !== undefined && current.proofDigest !== targetEpochDigest)) {
          throw fail('ARCHIVE_CHAIN_CONFLICT');
        }
        assertSecret(current.secret, targetKeyId);
        return { secret: Buffer.from(current.secret) };
      }
      if ([...pending.keys()].some(generation => generation > epoch.Record.ArchiveThrough)) throw fail('ARCHIVE_KEY_PENDING');
      let opened;
      try { opened = openArchiveLinks(current.secret, context, links, epoch.Record.ArchiveLinksDigest); }
      catch (error) {
        interrupted = ['INVALID_ARCHIVE_LINKS', 'INVALID_ARCHIVE_LINK'].includes(error.code ?? error.message);
        throw error;
      }
      try {
        for (const link of opened) {
          if (link.purpose !== 'live' || !pending.has(link.generation)) continue;
          if (link.keyId !== pending.get(link.generation)) throw fail('ARCHIVE_KEY_MISMATCH');
          assertSecret(link.secret, link.keyId);
          if (!batch) return { secret: Buffer.from(link.secret) };
          // A failed chunk must resume early enough to recover keys it did not return.
          if (!retryPoint && onInterrupted) retryPoint = copyCursor(current);
          keys.push({ generation: link.generation, keyId: link.keyId, secret: Buffer.from(link.secret) });
          pending.delete(link.generation);
        }
        if (batch && !pending.size) {
          returnedKeys = true;
          return { keys };
        }
        const previous = opened.find(link => link.purpose === 'archive');
        if (!previous || previous.generation !== context.generation - 1) throw fail('ARCHIVE_KEY_UNAVAILABLE');
        assertSecret(previous.secret, previous.keyId);
        current.secret.fill(0);
        current = {
          context: { serverId, channelId, purpose: 'archive', generation: previous.generation, keyId: previous.keyId },
          secret: Buffer.from(previous.secret), proofDigest: epoch.Record.PreviousDigest, headDigest, predecessor: true,
        };
      } finally {
        for (const link of opened) link.secret.fill(0);
      }
    }
    const next = copyCursor(current);
    returnedKeys = true;
    return batch ? { keys, cursor: next } : { cursor: next };
  } catch (error) {
    if (interrupted && onInterrupted) {
      const offered = copyCursor(retryPoint ?? current);
      // The synchronous main-process handler takes ownership of this copy.
      try { onInterrupted(offered); }
      catch { offered.secret.fill(0); }
    }
    throw error;
  } finally {
    if (!returnedKeys) for (const item of keys) item.secret.fill(0);
    retryPoint?.secret.fill(0);
    current.secret.fill(0);
  }
}

module.exports = { runLiveRotation, runArchiveRotation, readArchiveKey, packageContext };
