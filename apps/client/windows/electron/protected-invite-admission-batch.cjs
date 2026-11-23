const { createHash } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { verifyInviteEpochPurpose, verifyInviteAdmissionEvidence, verifyPredecessorAdmission, verifyInviteRotationAudience,
  verifyLiveInviteAdmissionAuthor } =
  require('./protected-live-invite-admission.cjs');

const invalid = () => Object.assign(new Error('INVALID_PROTECTED_INVITE_PROOF'), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const validAdmissions = admissions => Array.isArray(admissions) && admissions.length >= 2 && admissions.length <= 8192;

function validateInviteAdmissionBatchChain(record, proof) {
  const { admissions, previousRevision, previousHead, successorHead } = proof ?? {};
  if (!['live', 'archive'].includes(record?.Purpose) || !validAdmissions(admissions) || !Number.isSafeInteger(previousRevision) ||
      !Number.isSafeInteger(record.Revision) || record.Revision !== previousRevision + admissions.length ||
      !isDigest(previousHead) || !isDigest(successorHead) || !isDigest(record.PolicyDigest)) throw invalid();
  let head = previousHead;
  for (const [index, entry] of admissions.entries()) {
    const draft = entry?.draft;
    if (draft?.revision !== previousRevision + index + 1 || draft.previousDigest !== head || !isDigest(draft.digest)) throw invalid();
    head = draft.digest;
  }
  if (head !== successorHead || admissions.at(-1).draft.resultDigest !== record.PolicyDigest) throw invalid();
  return admissions;
}

function inviteAdmissionBatchDigest(record, proof) {
  const admissions = validateInviteAdmissionBatchChain(record, proof);
  const signatures = createHash('sha256');
  for (const { draft } of admissions) {
    const encoded = draft.signature;
    if (typeof encoded !== 'string' || encoded.length !== 88) throw invalid();
    const signature = Buffer.from(encoded, 'base64');
    if (signature.length !== 64 || signature.toString('base64') !== encoded) throw invalid();
    signatures.update(signature);
  }
  return createHash('sha256').update(signatureFrame(`pawtalk-protected-${record.Purpose}-invite-admissions-v1`,
    record.ChannelID, String(proof.previousRevision), proof.previousHead, String(record.Revision), proof.successorHead, record.PolicyDigest,
    String(admissions.length), signatures.digest('hex'))).digest('hex');
}

function verifyInviteAdmissionBatch(trust, predecessor, issuanceViews, record, proof) {
  const admissions = validateInviteAdmissionBatchChain(record, proof);
  const { previousRevision, previousHead, newcomer } = proof;
  verifyInviteEpochPurpose(record);
  if (!predecessor || previousRevision !== predecessor.revision || previousHead !== predecessor.digest) throw invalid();

  const heads = new Set([previousHead]);
  const operations = new Set();
  const profiles = new Set(), devices = new Set(), agreements = new Set();
  const uses = new Map();
  const applicants = [];
  for (const entry of admissions) {
    const { draft } = entry;
    if (heads.has(draft.digest) || operations.has(draft.operationId)) throw invalid();

    const issuance = draft.admission?.Issuance;
    if (!issuance || issuance.PolicyRevision > previousRevision) throw invalid();
    const view = issuance.PolicyRevision === previousRevision ? predecessor : issuanceViews?.get(issuance.PolicyRevision);
    const { applicant, baseUses } = verifyInviteAdmissionEvidence(trust, predecessor, view, record, { ...entry, newcomer });
    for (const [identities, identity] of [[profiles, applicant.profileId], [devices, applicant.deviceId], [agreements, applicant.agreementKey]]) {
      if (identities.has(identity)) throw invalid();
      identities.add(identity);
    }

    const { inviteId } = draft.admission.Claim;
    const { Signature: issueSignature, MaxUses: maxUses } = issuance;
    const previous = uses.get(inviteId);
    if (previous && (previous.issueSignature !== issueSignature || previous.baseUses !== baseUses || previous.maxUses !== maxUses)) throw invalid();
    const afterUses = (previous?.afterUses ?? baseUses) + 1;
    if (!Number.isSafeInteger(afterUses) || (maxUses !== 0 && afterUses > maxUses)) throw invalid();
    uses.set(inviteId, { issueSignature, baseUses, maxUses, afterUses });

    heads.add(draft.digest);
    operations.add(draft.operationId);
    applicants.push(applicant);
  }
  return applicants;
}

function verifyInviteAdmissionBatchRotation(trust, predecessor, issuanceViews, task, recipient, proof = task?.inviteAdmissions) {
  const applicants = verifyInviteAdmissionBatch(trust, predecessor, issuanceViews, task, proof);
  const purpose = task.Purpose;
  if (recipient?.purpose !== purpose || applicants.some(({ profileId, deviceId }) =>
    recipient.profileId === profileId || recipient.recipientId === deviceId)) throw invalid();
  const { previousTextPolicy, previousOpenings } = proof;
  const admission = verifyPredecessorAdmission(predecessor, task.ChannelID, proof, previousTextPolicy, recipient);
  verifyInviteRotationAudience(purpose, previousTextPolicy, previousOpenings, task.Recipients, applicants);
  const marker = inviteAdmissionBatchDigest(task, proof);
  return purpose === 'archive' ? { admission, archiveTransitionDigest: marker } : { admission, liveTransitionDigest: marker };
}

function verifyInviteAdmissionBatchEpochSigner(trust, predecessor, issuanceViews, epoch, proof) {
  const record = epoch?.Record;
  const applicants = verifyInviteAdmissionBatch(trust, predecessor, issuanceViews, record, proof);
  const marker = inviteAdmissionBatchDigest(record, proof);
  const archive = record.Purpose === 'archive';
  const signedMarker = archive ? record.ArchiveTransitionDigest : record.LiveTransitionDigest;
  const principal = epoch.Principal;
  if (!principal || signedMarker !== marker || applicants.some(({ profileId, deviceId }) =>
    principal.ProfileID === profileId || principal.DeviceID === deviceId)) throw invalid();
  const disclosure = proof.previousSignerTextPolicy;
  const { signingKey } = verifyPredecessorAdmission(predecessor, record.ChannelID, proof, disclosure, {
    recipientId: principal.DeviceID, profileId: principal.ProfileID, purpose: record.Purpose,
    recipientKey: disclosure?.recipient?.statement?.publicKey,
  });
  return { applicants, signer: { profileId: principal.ProfileID, deviceId: principal.DeviceID, key: signingKey },
    ...(archive ? { archiveTransitionDigest: marker } : { liveTransitionDigest: marker }) };
}

function verifyInviteAdmissionBatchDelivery(trust, predecessor, issuanceViews, delivery, recipient) {
  const epoch = delivery?.Epoch;
  const record = epoch?.Record;
  const proof = record?.Purpose === 'archive' ? delivery.archiveInviteAdmissions : delivery?.liveInviteAdmissions;
  if (recipient?.purpose !== record?.Purpose) throw invalid();
  const verified = verifyInviteAdmissionBatchEpochSigner(trust, predecessor, issuanceViews, epoch, proof);
  const applicant = verified.applicants.find(({ profileId, deviceId }) =>
    recipient.profileId === profileId || recipient.recipientId === deviceId);
  let admission;
  if (applicant) {
    if (recipient.profileId !== applicant.profileId || recipient.recipientId !== applicant.deviceId ||
        recipient.recipientKey !== applicant.agreementKey || (recipient.kind ?? 'device') !== 'device' ||
        proof.previousTextPolicy !== undefined) throw invalid();
    admission = applicant.admission;
  } else {
    admission = verifyPredecessorAdmission(predecessor, record.ChannelID, proof, proof.previousTextPolicy, recipient);
  }
  return { ...verified, admission, predecessor, successorHead: proof.successorHead, channelId: record.ChannelID,
    revision: record.Revision, policyDigest: record.PolicyDigest, generation: record.Generation, keyId: record.KeyID };
}

function verifyLiveInviteAdmissionBatchAuthor(transition, record, author, disclosure, position) {
  const applicant = transition.applicants.find(({ profileId, deviceId }) =>
    author?.ProfileID === profileId || author?.DeviceID === deviceId) ?? transition.applicants[0];
  return verifyLiveInviteAdmissionAuthor({ ...transition, applicant }, record, author, disclosure, position);
}

module.exports = { inviteAdmissionBatchDigest, verifyInviteAdmissionBatchRotation, verifyInviteAdmissionBatchEpochSigner,
  verifyInviteAdmissionBatchDelivery, verifyLiveInviteAdmissionBatchAuthor };
