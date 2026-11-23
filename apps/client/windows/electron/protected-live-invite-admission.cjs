const { createHash } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { textNewcomerAdmissionProjectionVersion, textNewcomerAdmissionDigest, verifyRotationProfiles, hasTextRecipientProjection } =
  require('./protected-channel-policy-commitments.cjs');
const { verifyAttestedTextAdmission } = require('./protected-policy-attestation.cjs');
const { verifyInviteAdmissionProjection, verifyInviteIssuer, verifyFreshInviteCredential, verifyInviteUse } =
  require('./protected-invite-admission-commitment.cjs');
const { verifyInviteApplicant, verifyInviteIssuanceTranscript, verifyScopedInviteReceipt } =
  require('./protected-invite-transcript.cjs');

const invalid = () => Object.assign(new Error('INVALID_PROTECTED_INVITE_PROOF'), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function inviteAdmissionEpochDigest(record, proof) {
  if (!['live', 'archive'].includes(record?.Purpose)) throw invalid();
  const { draft } = proof;
  return createHash('sha256').update(signatureFrame(`pawtalk-protected-${record.Purpose}-invite-admission-v1`,
    record.ChannelID, String(proof.previousRevision), proof.previousHead, String(record.Revision), proof.successorHead, record.PolicyDigest,
    draft.operationId, draft.actor.ProfileID, draft.actor.DeviceID, draft.signature)).digest('hex');
}

function liveInviteAdmissionDigest(record, proof) {
  if (record.Purpose !== 'live') throw invalid();
  return inviteAdmissionEpochDigest(record, proof);
}

// The caller supplies independently verified owner attestations for the exact
// predecessor and the policy under which the invitation was issued.
function verifyInviteTransition(trust, predecessor, issuanceView, record, proof) {
  const { draft } = proof ?? {};
  verifyInviteEpochPurpose(record);
  if (!draft || !predecessor ||
      proof.previousRevision !== predecessor.revision || proof.previousHead !== predecessor.digest ||
      draft.previousDigest !== predecessor.digest || record.Revision !== predecessor.revision + 1 || draft.revision !== record.Revision ||
      !digest(draft.digest) || proof.successorHead !== draft.digest || !digest(record.PolicyDigest) || draft.resultDigest !== record.PolicyDigest) throw invalid();
  return verifyInviteAdmissionEvidence(trust, predecessor, issuanceView, record, proof).applicant;
}

function verifyInviteEpochPurpose(record) {
  const purpose = record?.Purpose;
  if (!['live', 'archive'].includes(purpose) ||
      purpose === 'live' && ((record.ArchiveThrough ?? 0) !== 0 || (record.ArchiveTargets?.length ?? 0) !== 0) ||
      purpose === 'archive' && (!Number.isSafeInteger(record.ArchiveThrough) || record.ArchiveThrough < 1)) throw invalid();
}

function verifyInviteAdmissionEvidence(trust, predecessor, issuanceView, record, proof) {
  const { draft, freshness, issuerAuthority, newcomer, newcomerTextPolicy } = proof ?? {};
  const issuance = draft?.admission?.Issuance;
  const purpose = record.Purpose;
  const version = predecessor?.projectionVersion;
  if (!issuance || !hasTextRecipientProjection(version) || version < textNewcomerAdmissionProjectionVersion ||
      issuance.PolicyRevision > predecessor.revision || issuanceView?.revision !== issuance.PolicyRevision ||
      issuanceView.digest !== issuance.PolicyDigest || issuanceView.projectionVersion > version ||
      (issuanceView.revision === predecessor.revision && (issuanceView.digest !== predecessor.digest || issuanceView.root !== predecessor.root))) throw invalid();

  const applicant = verifyInviteApplicant(trust, draft.admission);
  if (draft.actor?.ProfileID !== applicant.profileId || draft.actor.DeviceID !== applicant.deviceId) throw invalid();
  verifyInviteAdmissionProjection(issuanceView, issuerAuthority);
  const issuerKey = verifyInviteIssuer(issuerAuthority.issuers, issuance.Issuer, issuerAuthority.opening);
  const { inviteId } = draft.admission.Claim;
  verifyInviteIssuanceTranscript(trust, issuance, inviteId, applicant.tokenHash, issuerKey);
  verifyScopedInviteReceipt(trust, draft);

  verifyInviteAdmissionProjection(predecessor, freshness);
  verifyFreshInviteCredential(freshness.credentials, 'profile', applicant.profileId, freshness.profile);
  verifyFreshInviteCredential(freshness.credentials, 'device', applicant.deviceId, freshness.device);
  verifyFreshInviteCredential(freshness.credentials, 'agreement', applicant.agreementKey, freshness.agreement);
  const baseUses = verifyInviteUse(freshness.credentials, inviteId, freshness.use, issuance.Signature, issuance.MaxUses);

  if (newcomer?.visible !== true || typeof newcomer.archive !== 'boolean' || (purpose === 'archive' && !newcomer.archive) ||
      typeof newcomer.canSend !== 'boolean') throw invalid();
  // The compact receipt binds only this transition's successor projection.
  // It is never installed as an owner attestation or global policy checkpoint.
  const admission = verifyAttestedTextAdmission({ revision: draft.revision, policyDigest: draft.resultDigest,
    projectionVersion: version, root: draft.projectionRoot }, record.ChannelID, newcomerTextPolicy, {
    recipientId: applicant.deviceId, profileId: applicant.profileId, recipientKey: applicant.agreementKey, purpose,
  });
  if (admission.archive !== newcomer.archive || admission.canSend !== newcomer.canSend ||
      admission.signingKey !== Buffer.from(draft.admission.Claim.devicePublicKey, 'base64url').toString('hex')) throw invalid();

  const { profileId, deviceId, agreementKey } = applicant;
  return { applicant: { admission, profileId, deviceId, agreementKey, signingKey: admission.signingKey,
    revision: draft.revision, firstPosition: admission.firstPosition, canSend: admission.canSend }, baseUses };
}

function verifyPredecessorAdmission(predecessor, channelId, proof, disclosure, recipient) {
  const admission = verifyAttestedTextAdmission(predecessor, channelId, disclosure, recipient);
  if (textNewcomerAdmissionDigest(proof.newcomer) !== disclosure.rotation.newcomer) throw invalid();
  return admission;
}

function verifyInviteRotationAudience(purpose, previousTextPolicy, previousOpenings, recipients, applicants) {
  if (!recipients || typeof recipients !== 'object' || Array.isArray(recipients)) throw invalid();
  const entries = Object.entries(recipients);
  if (entries.length > 8192) throw invalid();
  const devices = new Set(), profiles = new Set(), agreements = new Set();
  for (const { profileId, deviceId, agreementKey } of applicants) {
    const added = Object.hasOwn(recipients, deviceId) && recipients[deviceId];
    if (added?.ProfileID !== profileId || added.Kind !== 'device' || added.PublicKey !== agreementKey) throw invalid();
    devices.add(deviceId);
    profiles.add(profileId);
    agreements.add(agreementKey);
  }
  const previousRecipients = entries.filter(([id]) => !devices.has(id));
  if (previousRecipients.some(([, entry]) => profiles.has(entry?.ProfileID) || agreements.has(entry?.PublicKey))) throw invalid();
  const previousRoot = purpose === 'archive' ? previousTextPolicy.rotation.archiveProfiles : previousTextPolicy.rotation.liveProfiles;
  verifyRotationProfiles(purpose, previousRoot, Object.fromEntries(previousRecipients), previousOpenings);
}

function verifyInviteAdmissionRotation(trust, predecessor, issuanceView, task, recipient) {
  const proof = task?.inviteAdmission;
  const applicant = verifyInviteTransition(trust, predecessor, issuanceView, task, proof);
  const purpose = task.Purpose;
  if (recipient?.purpose !== purpose || recipient.profileId === applicant.profileId || recipient.recipientId === applicant.deviceId) throw invalid();
  const { previousTextPolicy, previousOpenings } = proof;
  const admission = verifyPredecessorAdmission(predecessor, task.ChannelID, proof, previousTextPolicy, recipient);
  verifyInviteRotationAudience(purpose, previousTextPolicy, previousOpenings, task.Recipients, [applicant]);
  const marker = inviteAdmissionEpochDigest(task, proof);
  return purpose === 'archive' ? { admission, archiveTransitionDigest: marker } : { admission, liveTransitionDigest: marker };
}

function verifyLiveInviteAdmission(trust, predecessor, issuanceView, task, recipient) {
  if (task?.Purpose !== 'live') throw invalid();
  return verifyInviteAdmissionRotation(trust, predecessor, issuanceView, task, recipient);
}

function verifyInviteAdmissionEpochSigner(trust, predecessor, issuanceView, epoch, proof) {
  const record = epoch?.Record;
  const applicant = verifyInviteTransition(trust, predecessor, issuanceView, record, proof);
  const purpose = record.Purpose;
  const marker = inviteAdmissionEpochDigest(record, proof);
  const signedMarker = purpose === 'archive' ? record.ArchiveTransitionDigest : record.LiveTransitionDigest;
  const principal = epoch.Principal;
  if (signedMarker !== marker || !principal || principal.ProfileID === applicant.profileId ||
      principal.DeviceID === applicant.deviceId) throw invalid();
  const disclosure = proof.previousSignerTextPolicy;
  const { signingKey } = verifyPredecessorAdmission(predecessor, record.ChannelID, proof, disclosure, {
    recipientId: principal.DeviceID, profileId: principal.ProfileID, purpose,
    recipientKey: disclosure?.recipient?.statement?.publicKey,
  });
  const signer = { profileId: principal.ProfileID, deviceId: principal.DeviceID, key: signingKey };
  return purpose === 'archive' ? { signer, applicant, archiveTransitionDigest: marker } : { signer, applicant, liveTransitionDigest: marker };
}

function verifyLiveInviteEpochSigner(trust, predecessor, issuanceView, epoch, proof) {
  if (epoch?.Record?.Purpose !== 'live') throw invalid();
  return verifyInviteAdmissionEpochSigner(trust, predecessor, issuanceView, epoch, proof);
}

function verifyInviteAdmissionDelivery(trust, predecessor, issuanceView, delivery, recipient) {
  const epoch = delivery?.Epoch;
  const record = epoch?.Record;
  const purpose = record?.Purpose;
  if (!['live', 'archive'].includes(purpose) || recipient?.purpose !== purpose) throw invalid();
  const proof = purpose === 'archive' ? delivery.archiveInviteAdmission : delivery.liveInviteAdmission;
  const verified = verifyInviteAdmissionEpochSigner(trust, predecessor, issuanceView, epoch, proof);
  const { applicant } = verified;
  let admission;
  if (recipient.profileId === applicant.profileId || recipient.recipientId === applicant.deviceId) {
    if (recipient.profileId !== applicant.profileId || recipient.recipientId !== applicant.deviceId ||
        recipient.recipientKey !== applicant.agreementKey || (recipient.kind ?? 'device') !== 'device' ||
        proof.previousTextPolicy !== undefined) throw invalid();
    admission = applicant.admission;
  } else {
    admission = verifyPredecessorAdmission(predecessor, record.ChannelID, proof, proof.previousTextPolicy, recipient);
  }
  return { ...verified, admission, predecessor, purpose, successorHead: proof.successorHead, channelId: record.ChannelID,
    revision: record.Revision, policyDigest: record.PolicyDigest, generation: record.Generation, keyId: record.KeyID };
}

function verifyLiveInviteAdmissionDelivery(trust, predecessor, issuanceView, delivery, recipient) {
  if (delivery?.Epoch?.Record?.Purpose !== 'live') throw invalid();
  return verifyInviteAdmissionDelivery(trust, predecessor, issuanceView, delivery, recipient);
}

function verifyLiveInviteAdmissionAuthor(transition, record, author, disclosure, position) {
  const { applicant } = transition;
  if (record.Purpose !== 'live' || record.LiveTransitionDigest !== transition.liveTransitionDigest ||
      record.ChannelID !== transition.channelId || record.Revision !== transition.revision || record.PolicyDigest !== transition.policyDigest ||
      record.Generation !== transition.generation || record.KeyID !== transition.keyId || !author ||
      !Number.isSafeInteger(position) || position < 1) throw invalid();
  const { ProfileID: profileId, DeviceID: deviceId } = author;
  if (profileId === applicant.profileId || deviceId === applicant.deviceId) {
    if (profileId !== applicant.profileId || deviceId !== applicant.deviceId || disclosure !== undefined ||
        !applicant.canSend || position < applicant.firstPosition) throw invalid();
    return { profileId, deviceId, key: applicant.signingKey };
  }
  const admission = verifyAttestedTextAdmission(transition.predecessor, record.ChannelID, disclosure, {
    recipientId: deviceId, profileId, purpose: 'live', recipientKey: disclosure?.recipient?.statement?.publicKey,
  });
  if (!admission.canSend || position < admission.firstPosition) throw invalid();
  return { profileId, deviceId, key: admission.signingKey };
}

module.exports = { inviteAdmissionEpochDigest, verifyInviteAdmissionRotation, verifyInviteAdmissionEpochSigner, verifyInviteAdmissionDelivery,
  liveInviteAdmissionDigest, verifyLiveInviteAdmission, verifyLiveInviteEpochSigner, verifyLiveInviteAdmissionDelivery, verifyLiveInviteAdmissionAuthor,
  verifyInviteEpochPurpose, verifyInviteAdmissionEvidence, verifyPredecessorAdmission, verifyInviteRotationAudience };
