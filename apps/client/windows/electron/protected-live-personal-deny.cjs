const { createHash } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { textGroupedRotationProjectionVersion, textGroupedArchiveRotationProjectionVersion, textGroupedRevisionAudienceProjectionVersion, verifyChannelACLEditor,
  verifyRotationProfiles, verifyRotationProfileRemoval } = require('./protected-channel-policy-commitments.cjs');
const { verifyPersonalACLTargetRank } = require('./protected-policy-profile-ranks.cjs');
const { verifyPersonalACLIntentSignature } = require('./protected-channel-acl-edit.cjs');
const { verifyAttestedTextAdmission } = require('./protected-policy-attestation.cjs');

const invalid = () => Object.assign(new Error('INVALID_LIVE_PERSONAL_DENY'), { code: 'INVALID_LIVE_PERSONAL_DENY' });
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// The caller authenticates the preceding policy independently. A proof of this
// local transition does not authenticate a new global policy root.
function verifyPersonalDenyProof(trust, predecessor, record, proof, minimumProjection) {
  const channelId = record.ChannelID;
  if (!proof || !(predecessor.projectionVersion >= minimumProjection) ||
      proof.previousRevision !== predecessor.revision || proof.previousHead !== predecessor.digest ||
      record.Revision !== predecessor.revision + 1 || !digest(proof.successorHead) || !digest(record.PolicyDigest) ||
      !proof.actor) throw invalid();
  const authority = verifyChannelACLEditor(predecessor, channelId, proof.authority, proof.actor);
  if (authority.kind !== 'text' || verifyPersonalACLTargetRank(predecessor, proof.rankBasis, proof.actor.ProfileID,
    proof.targetProfileId) !== false) throw invalid();
  verifyPersonalACLIntentSignature(trust, proof.actor, { ...authority, digest: predecessor.digest }, proof.targetProfileId,
    'channel.view', 'deny', proof.operationId, proof.editorProof, proof.authority.signingKey);
}

function personalDenyDigest(record, proof) {
  if (!['live', 'archive'].includes(record.Purpose)) throw invalid();
  return createHash('sha256').update(signatureFrame(`pawtalk-protected-${record.Purpose}-personal-deny-v1`,
    record.ChannelID, String(proof.previousRevision), proof.previousHead, String(record.Revision), proof.successorHead, record.PolicyDigest,
    proof.operationId, proof.actor.ProfileID, proof.actor.DeviceID, proof.targetProfileId, proof.editorProof)).digest('hex');
}

function verifyLivePersonalDeny(trust, predecessor, task, recipient) {
  const proof = task.livePersonalDeny;
  if (task.Purpose !== 'live' || recipient.purpose !== 'live') throw invalid();
  verifyPersonalDenyProof(trust, predecessor, task, proof, textGroupedRotationProjectionVersion);
  if (recipient.profileId === proof.targetProfileId) throw invalid();
  const admission = verifyAttestedTextAdmission(predecessor, task.ChannelID, proof.previousTextPolicy, recipient);
  verifyRotationProfileRemoval('live', proof.previousTextPolicy.rotation.liveProfiles, task.Recipients,
    proof.survivorOpenings, proof.targetProfileId, proof.removedGroup);
  return { admission, liveTransitionDigest: personalDenyDigest(task, proof) };
}

function verifyArchivePersonalDeny(trust, predecessor, task, recipient) {
  const proof = task.archivePersonalDeny;
  if (task.Purpose !== 'archive' || recipient.purpose !== 'archive') throw invalid();
  verifyPersonalDenyProof(trust, predecessor, task, proof, textGroupedArchiveRotationProjectionVersion);
  if (recipient.profileId === proof.targetProfileId) throw invalid();
  const admission = verifyAttestedTextAdmission(predecessor, task.ChannelID, proof.previousTextPolicy, recipient);
  const previousRoot = proof.previousTextPolicy.rotation.archiveProfiles;
  if (proof.removedGroup === undefined) {
    verifyRotationProfiles('archive', previousRoot, task.Recipients, proof.survivorOpenings);
    if (Object.values(task.Recipients).some(entry => entry.ProfileID === proof.targetProfileId)) throw invalid();
  } else {
    verifyRotationProfileRemoval('archive', previousRoot, task.Recipients, proof.survivorOpenings, proof.targetProfileId, proof.removedGroup);
  }
  return { admission, archiveTransitionDigest: personalDenyDigest(task, proof) };
}

function personalDenyEpochSigner(predecessor, epoch, proof) {
  const { Record: record, Principal: principal } = epoch;
  const signedDigest = record.Purpose === 'archive' ? record.ArchiveTransitionDigest : record.LiveTransitionDigest;
  if (signedDigest !== personalDenyDigest(record, proof) || principal?.ProfileID === proof.targetProfileId) throw invalid();
  const signer = verifyAttestedTextAdmission(predecessor, record.ChannelID, proof.previousSignerTextPolicy, {
    recipientId: principal?.DeviceID, profileId: principal?.ProfileID, purpose: record.Purpose,
    recipientKey: proof.previousSignerTextPolicy?.recipient?.statement?.publicKey,
  });
  return { profileId: principal.ProfileID, deviceId: principal.DeviceID, key: signer.signingKey };
}

function verifyPersonalDenyDelivery(trust, predecessor, delivery, recipient) {
  const { Epoch: epoch } = delivery;
  const record = epoch.Record;
  const purpose = record.Purpose;
  if (!['live', 'archive'].includes(purpose) || recipient.purpose !== purpose) throw invalid();
  const archive = purpose === 'archive';
  const proof = archive ? delivery.archivePersonalDeny : delivery.livePersonalDeny;
  verifyPersonalDenyProof(trust, predecessor, record, proof,
    archive ? textGroupedArchiveRotationProjectionVersion : textGroupedRotationProjectionVersion);
  if (recipient.profileId === proof.targetProfileId) throw invalid();
  const admission = verifyAttestedTextAdmission(predecessor, record.ChannelID, proof.previousTextPolicy, recipient);
  return { admission, signer: personalDenyEpochSigner(predecessor, epoch, proof) };
}

function verifyRevisionPersonalDenyArchiveSigner(trust, predecessor, epoch, proof) {
  if (epoch.Record.Purpose !== 'archive') throw invalid();
  verifyPersonalDenyProof(trust, predecessor, epoch.Record, proof, textGroupedRevisionAudienceProjectionVersion);
  return personalDenyEpochSigner(predecessor, epoch, proof);
}

function verifyLiveDenyAuthor(transition, record, author, disclosure, position) {
  if (!digest(record.LiveTransitionDigest) || record.Revision !== transition.predecessor.revision + 1 ||
      !author?.ProfileID || transition.excludedProfiles.has(author.ProfileID)) throw invalid();
  const signer = verifyAttestedTextAdmission(transition.predecessor, record.ChannelID, disclosure, {
    recipientId: author.DeviceID, profileId: author.ProfileID, purpose: 'live',
    recipientKey: disclosure?.recipient?.statement?.publicKey,
  });
  if (signer.canSend !== true || signer.firstPosition > position) throw invalid();
  return { profileId: author.ProfileID, deviceId: author.DeviceID, key: signer.signingKey };
}

module.exports = { verifyLivePersonalDeny, verifyArchivePersonalDeny, verifyPersonalDenyDelivery, verifyLiveDenyAuthor,
  verifyRevisionPersonalDenyArchiveSigner,
  personalDenyDigest };
