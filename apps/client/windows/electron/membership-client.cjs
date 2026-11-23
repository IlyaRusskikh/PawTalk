const {validatePoll}=require('../../../../shared/polls.mjs');
const {validMentions}=require('../../../../shared/mentions.mjs');
const { permissionFitsACL } = require('../../../../shared/protected-access.mjs');
const { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } = require('node:crypto');
const { isIP } = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { serverURL, invitation } = require('./address.cjs');
const { readBoundedResponse, readProtectedProofResponse } = require('./protected-proof-response.cjs');
const { mediaEndpoint } = require('./media-endpoint.cjs');
const { ProtectedPolicyCheckpoint, runtimePolicyPreviewFrame, verifyPolicyTextProjection, protectedPolicySignatureFrame,
  validateScopedChannelOrderPreview } =
  require('./protected-policy-checkpoint.cjs');
const { isDeepStrictEqual } = require('node:util');
const { ProtectedEpochCheckpoint } = require('./protected-epoch-checkpoint.cjs');
const { PolicyAttestationCheckpoint, policyAttestationFrame, verifyPolicyAttestation, verifyAttestedTextAdmission, verifyAttestedVoiceRoster } =
  require('./protected-policy-attestation.cjs');
const { hasTextRecipientProjection, textRevisionProjectionVersion, textRevisionAudienceVersion, textRotationAudienceVersion,
  voiceRecipientProjectionVersion,
  textRotationDigest, verifyChannelOrderAuthority, verifyChannelSettings, channelACLProjectionVersion,
  verifyChannelACLAuthority, channelACLRulesJSON, channelACLRulesDigest, profileRankProjectionVersion,
  textGroupedRotationProjectionVersion, textGroupedArchiveRotationProjectionVersion,
  textGroupedRevisionAudienceProjectionVersion,
  profileRoleAuthorityProjectionVersion, verifyRotationProfiles } = require('./protected-channel-policy-commitments.cjs');
const { roleViewDenyDigest, verifyRoleViewDenyRotation, verifyRoleViewDenyDelivery,
  verifyRoleViewDenyEpochSigner } = require('./protected-role-view-deny.cjs');
const { inviteAdmissionEpochDigest, verifyInviteAdmissionRotation, verifyInviteAdmissionDelivery, verifyInviteAdmissionEpochSigner,
  verifyLiveInviteAdmissionAuthor } = require('./protected-live-invite-admission.cjs');
const { inviteAdmissionBatchDigest, verifyInviteAdmissionBatchRotation, verifyInviteAdmissionBatchEpochSigner,
  verifyInviteAdmissionBatchDelivery, verifyLiveInviteAdmissionBatchAuthor } = require('./protected-invite-admission-batch.cjs');
const { verifyPersonalACLTargetRank } = require('./protected-policy-profile-ranks.cjs');
const { sealCommunityAvatar, openCommunityAvatar, rewrapCommunityAvatar, verifyCommunityAvatarAudience, verifyCommunityAvatarPublisher } =
  require('./protected-community-avatar.cjs');
const { verifyLivePersonalDeny, verifyArchivePersonalDeny, verifyPersonalDenyDelivery,
  verifyLiveDenyAuthor, verifyRevisionPersonalDenyArchiveSigner, personalDenyDigest } = require('./protected-live-personal-deny.cjs');
const { signProtectedChannelSettingsEdit, verifyProtectedChannelSettingsReceipt } = require('./protected-channel-settings-edit.cjs');
const { signProtectedChannelACLRoleEdit, signProtectedChannelACLPersonalEdit } = require('./protected-channel-acl-edit.cjs');
const { signScopedRoleEdit, verifyScopedRoleReceipt } = require('./protected-scoped-roles.cjs');
const { scopedRoleRosterAlias } = require('./protected-role-roster.cjs');
const { verifyRoleAssignmentRotation, roleAssignmentEpochDigest, verifyRoleAssignmentEpochSigner,
  verifyRoleAssignmentDelivery, verifyRoleAssignmentAuthor, verifyLiveRoleHistory } = require('./protected-role-assignment-transition.cjs');
const { channelLayoutFrame, verifyChannelLayoutEvidence } = require('./protected-channel-layout.cjs');
const { verifyRevisionAudience, verifyGroupedRevisionAudience } = require('./protected-revision-audience.cjs');
const { openSignedEpochPackage, openSignedRecoveryEpochPackage, verifySignedEpoch, proveSignedRecoveryEpochOpening,
  proveMigrationRuntimeRecoveryOpening } = require('./protected-epoch-packages.cjs');
const { runLiveRotation, runArchiveRotation, readArchiveKey, packageContext } = require('./protected-archive-session.cjs');
const { ProtectedArchiveResume } = require('./protected-archive-resume.cjs');
const { classifyProtectedTextStatus, validateProtectedTextWindow } = require('./protected-text-status.cjs');
const { reencryptMigratedHistoryRecord, openMigratedHistoryRecord, openMigratedAttachment } = require('./protected-migration-content.cjs');
const { runProtectedMigrationResume, runProtectedMigrationRecoveryArchive, loadMigrationArchiveKey } = require('./protected-migration-resume.cjs');
const { createMigrationRecoveryCode, proposeMigrationRecovery, sealMigrationRecoveryPackage, confirmMigrationRecoveryPackage, deriveRecoveryIdentity } =
  require('./protected-migration-recovery.cjs');
const { prepareProtectedRecoveryEnrollment, prepareProtectedRecoveryConfirmation } = require('./protected-runtime-recovery.cjs');
const { prepareProtectedRecoveryDevice } = require('./protected-recovery-device.cjs');
const { createRecoveryBundle, openRecoveryBundle } = require('./protected-recovery-bundle.cjs');
const { checkProtectedDeviceBindingApplicant, prepareProtectedDeviceBindingApplicant, prepareProtectedDeviceBindingApproval,
  verifyProtectedDeviceBindingReceipt } = require('./protected-device-binding.cjs');
const { deviceBindingCard, openDeviceBindingCard } = require('./protected-device-binding-card.cjs');
const { ProtectedDeviceBindingStorage } = require('./protected-device-binding-storage.cjs');
const { makeProfileLinkCard, openProfileLinkCard, linkDraft } = require('./protected-profile-link-card.cjs');
const { signProtectedProfileLinkConsent, signProtectedProfileUnlinkConsent } = require('./protected-profile-linking.cjs');
const { advanceScopeAuthority, scopeAuthorityGenesis, signScopeAuthorityLink,
  buildScopeOwnerTransferOffer, acceptScopeOwnerTransferOffer, scopeAuthorityRequiresV2,
  buildScopeDeviceHandoverOffer, verifyScopeDeviceHandoverOffer, acceptScopeDeviceHandoverOffer } = require('./protected-scope-authority.cjs');
const { loadDeviceAgreementKey, proposeMigrationRecipient, deviceAgreementPrivateKey } = require('./protected-device-agreement.cjs');
const { prepareProtectedSelfHost } = require('./protected-selfhost.cjs');
const { verifyMigrationInitialSnapshot, epochRecipients, epochSigner, textRevisionAudience, canAuthorTextRevision,
  channelGrantSummary, canInspectFullPolicy } = require('./protected-policy-replay.cjs');
const { sealMigrationHistoryLink, openSignedMigrationHistoryLink } = require('./protected-migration-archive-link.cjs');
const { sealProtectedText, openProtectedText, protectedReplyFields, openProtectedReply } = require('./protected-live-text.cjs');
const { encodeProtectedMentions, decodeProtectedMentions } = require('./protected-mentions.cjs');
const { attachmentBlockSize, attachmentMaxSize, newAttachmentSecret, validateAttachmentSecret, sealAttachment, openAttachmentAsync } =
  require('./protected-attachment.cjs');
const { sealProtectedRevision, openProtectedRevisionForArchive, openProtectedRevisionForDevice } = require('./protected-text-revision.cjs');
const { verifyVoiceKeyBasis, createVoiceKeyOffer, openVoiceKeyPackage } = require('./protected-voice-keys.cjs');
const { signatureFrame, apiProtocolVersion } = require('../../../../shared/membership.cjs');
const cryptoV2 = require('../../../../shared/server-crypto.mjs');
const {inspectImage}=require('../../../../shared/image.mjs');
const seedHeader = Buffer.from('302e020100300506032b657004220420', 'hex');
const hexID = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const hash = value => createHash('sha256').update(value).digest('hex');

async function readHistoryBatches(items, read) {
  const values = [];
  for (let start = 0; start < items.length; start += 4) {
    const batch = await Promise.allSettled(items.slice(start, start + 4).map(read));
    const failed = batch.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    values.push(...batch.map(result => result.value));
  }
  return values;
}

function signProtectedPolicyScope(trust, draft, digest, device) {
  const frame = policyAttestationFrame(trust, { revision: draft.Revision, digest,
    previous: draft.PreviousDigest, policyDigest: draft.ResultDigest, root: draft.TextProjectionRoot,
    ...(draft.TextProjectionVersion >= textRevisionProjectionVersion && { projectionVersion: draft.TextProjectionVersion }),
  });
  return sign(null, frame, device);
}
const protectedImageMime = mime => ['image/png', 'image/jpeg', 'image/webp'].includes(mime);
const byteView = bytes => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const revisionNumber = value => Number.isSafeInteger(value) && value >= 2;
const requestID = () => randomBytes(16).toString('hex');
const protectedOwner = (connection, trust = connection.policyTrust) => connection.ownership?.ownerProfileId ?? trust?.ownerProfileId;
const isProtectedOwner = (connection, trust) => typeof connection.profileId === 'string' && connection.profileId === protectedOwner(connection, trust);
const ownershipSlot = trust => `pawtalk:ownership:v1:${trust.serverId}:${trust.cutoverDigest}:${trust.anchorDigest}`;
const scopeDeviceCardPrefix = 'pawtalk-scope-device-v1.';
const protectedRuntimeTrustSlot = serverId => `pawtalk:protected-runtime:v1:${serverId}`;
function failure(code) { return Object.assign(Error(code), { code }); }

function scopedDenyEvidence(role, personal) {
  if (role !== undefined && personal !== undefined) throw failure('INVALID_CHANNEL_POLICY_PROOF');
  return role === undefined ? personal : role;
}

function scopedRotationEvidence(task, purpose) {
  const deny = scopedDenyEvidence(task.roleViewDeny, purpose === 'archive' ? task.archivePersonalDeny : task.livePersonalDeny);
  const invite = selectInviteEvidence(task.inviteAdmission, task.inviteAdmissions);
  return selectTextTransition(task.roleAssignment, invite, deny);
}

function selectTextTransition(assignment, invite, deny) {
  if (assignment !== undefined) {
    if (!assignment || invite !== undefined || deny !== undefined) throw failure('INVALID_ROLE_ASSIGNMENT_TRANSITION');
    return assignment;
  }
  if (invite !== undefined && deny !== undefined) throw failure('INVALID_PROTECTED_INVITE_PROOF');
  return invite ?? deny;
}

function epochTextTransition(proof, purpose) {
  const archive = purpose === 'archive';
  return selectTextTransition(proof.roleAssignment, inviteEpochEvidence(proof, purpose),
    scopedDenyEvidence(archive ? proof.archiveRoleViewDeny : proof.liveRoleViewDeny,
      archive ? proof.archivePersonalDeny : proof.livePersonalDeny));
}

function roleAssignmentBase(evidence, revision) {
  const { Draft: draft, Digest: successorHead } = evidence?.record ?? {};
  const change = draft?.ResourceChange?.RolesEdit?.Change;
  const base = { previousRevision: change?.revision, previousHead: draft?.PreviousDigest,
    successorHead, successorRoot: draft?.TextProjectionRoot };
  if (draft?.Action !== 'roles.scoped' || draft.Revision !== revision || change?.policyHead !== base.previousHead ||
      !transitionBaseMatches(base, revision) || !hexID(successorHead, 64) || !hexID(base.successorRoot, 64)) {
    throw failure('INVALID_ROLE_ASSIGNMENT_TRANSITION');
  }
  return base;
}

function selectInviteEvidence(single, batch) {
  if (batch === undefined && (single === undefined || (single?.draft && single.admissions === undefined))) return single;
  if (single === undefined && Array.isArray(batch?.admissions) && batch.admissions.length >= 2 &&
      batch.admissions.length <= 8192 && batch.draft === undefined) return batch;
  throw failure('INVALID_PROTECTED_INVITE_PROOF');
}

function inviteEpochEvidence(proof, purpose = proof.Record.Purpose) {
  return purpose === 'archive' ? selectInviteEvidence(proof.archiveInviteAdmission, proof.archiveInviteAdmissions) :
    selectInviteEvidence(proof.liveInviteAdmission, proof.liveInviteAdmissions);
}

function transitionBaseMatches(proof, revision) {
  return Number.isSafeInteger(proof?.previousRevision) && proof.previousRevision >= 1 &&
    proof.previousRevision === revision - (proof.admissions?.length ?? 1) && hexID(proof.previousHead, 64);
}

function transitionPreviousHead(proof) {
  return proof.admissions?.at(-1)?.draft?.previousDigest ?? proof.previousHead;
}

function inviteApplicant(transition, profileId) {
  return transition?.applicants?.find(applicant => applicant.profileId === profileId) ??
    (transition?.applicant?.profileId === profileId ? transition.applicant : undefined);
}
const textProtectionFailures = new Map([
  ['SERVER_KEY_CHANGED', 'SERVER_BINDING_INVALID'], ['SERVER_ID_CHANGED', 'SERVER_BINDING_INVALID'],
  ['INVALID_SERVER_IDENTITY', 'SERVER_BINDING_INVALID'], ['SERVER_BINDING_MISMATCH', 'SERVER_BINDING_INVALID'],
  ['PROTECTED_CUTOVER_CHANGED', 'SERVER_BINDING_INVALID'], ['PROTECTED_PROTOCOL_DOWNGRADE', 'SERVER_BINDING_INVALID'],
  ['POLICY_ROLLBACK', 'POLICY_PROOF_INVALID'], ['POLICY_FORK', 'POLICY_PROOF_INVALID'],
  ['UNTRUSTED_POLICY_ANCHOR', 'POLICY_PROOF_INVALID'], ['INVALID_SCOPE_AUTHORITY', 'POLICY_PROOF_INVALID'],
  ['INVALID_POLICY_ATTESTATION', 'POLICY_PROOF_INVALID'], ['INVALID_CHANNEL_POLICY_PROOF', 'POLICY_PROOF_INVALID'],
  ['INVALID_LIVE_PERSONAL_DENY', 'POLICY_PROOF_INVALID'], ['INVALID_PROFILE_RANK_PROOF', 'POLICY_PROOF_INVALID'],
  ['INVALID_PROTECTED_CHANNEL_ACL_EDIT', 'POLICY_PROOF_INVALID'],
  ['INVALID_PROTECTED_INVITE_PROOF', 'POLICY_PROOF_INVALID'],
  ['INVALID_ROLE_ASSIGNMENT_TRANSITION', 'POLICY_PROOF_INVALID'],
  ['INVALID_SCOPED_ROLE_ROSTER', 'POLICY_PROOF_INVALID'],
  ['INVALID_PROTECTED_PROOF_RESPONSE', 'POLICY_PROOF_INVALID'],
  ['EPOCH_ROLLBACK', 'KEY_PROOF_INVALID'], ['EPOCH_FORK', 'KEY_PROOF_INVALID'], ['EPOCH_CHAIN_CONFLICT', 'KEY_PROOF_INVALID'],
  ['INVALID_LOCAL_EPOCH_CHECKPOINT', 'KEY_PROOF_INVALID'], ['INVALID_EPOCH_PACKAGE', 'KEY_PROOF_INVALID'],
  ['EPOCH_KEY_MISMATCH', 'KEY_PROOF_INVALID'], ['INVALID_EPOCH_SIGNATURE', 'KEY_PROOF_INVALID'],
  ['INVALID_EPOCH_PACKAGE_CONTEXT', 'KEY_PROOF_INVALID'], ['INVALID_EPOCH_PACKAGE_ENCODING', 'KEY_PROOF_INVALID'],
  ['INVALID_EPOCH_PACKAGE_PROOF', 'KEY_PROOF_INVALID'], ['INVALID_MIGRATION_RECIPIENT', 'KEY_PROOF_INVALID'],
  ['SECURE_STORAGE_UNAVAILABLE', 'KEY_PROOF_INVALID'],
  ['UNTRUSTED_EPOCH_SIGNER', 'KEY_PROOF_INVALID'], ['UNVERIFIED_EPOCH_SIGNER', 'KEY_PROOF_INVALID'],
]);
function ed25519SeedKey(seed) {
  const material = Buffer.concat([seedHeader, seed]);
  try {
    return createPrivateKey({ key: material, format: 'der', type: 'pkcs8' });
  } finally {
    material.fill(0);
    seed.fill(0);
  }
}
function protectedInviteMetadata(invite) {
  const { id, creator, createdAt, expiresAt, maxUses, uses, revokedAt, canRevoke } = invite ?? {};
  if (!hexID(id, 32) || !hexID(creator, 64) || ![createdAt, expiresAt, maxUses, uses].every(Number.isSafeInteger) ||
      createdAt < 1 || expiresAt <= createdAt || maxUses < 0 || uses < 0 || maxUses > 0 && uses > maxUses ||
      revokedAt !== undefined && (!Number.isSafeInteger(revokedAt) || revokedAt < createdAt) || typeof canRevoke !== 'boolean') {
    throw failure('INVALID_API_RESPONSE');
  }
  return { id, creator, createdAt, expiresAt, maxUses, uses, ...(revokedAt !== undefined && { revokedAt }), canRevoke };
}
const mediaVariantKinds = ['preview', 'view'];
const mediaAttachmentParts = file => [file, file.poster, file.preview, file.view].filter(Boolean);

function validatedAttachment(f,images=false){
 const image=images&&['image/png','image/jpeg','image/webp'].includes(f?.mime);
 if(!f||!hexID(f.id,32)||typeof f.name!=='string'||!f.name.length||f.name.length>255||(!image&&!['image/gif','video/mp4','video/webm','audio/webm','audio/ogg','application/octet-stream'].includes(f.mime))||!Number.isSafeInteger(f.size)||f.size<1||f.size>(image?2:50)*1024*1024)throw failure('INVALID_ATTACHMENT');
 const result={id:f.id,name:f.name,mime:f.mime,size:f.size};
 if(f.poster!==undefined){if(!f.mime.startsWith('video/')||!f.poster||!hexID(f.poster.id,32)||!['image/png','image/jpeg','image/webp'].includes(f.poster.mime))throw failure('INVALID_ATTACHMENT');result.poster={id:f.poster.id,mime:f.poster.mime};}
 for (const kind of mediaVariantKinds) {
   const part = f[kind];
   if (part === undefined) continue;
   const limit = kind === 'preview' ? 80 * 1024 : f.size / 2;
   const supported = kind === 'preview' ? image || f.mime === 'image/gif' : image && !!result.preview;
   if (!supported || result.poster || !part || !hexID(part.id, 32) || part.mime !== 'image/webp' ||
       !Number.isSafeInteger(part.size) || part.size < 1 || part.size > limit) throw failure('INVALID_ATTACHMENT');
   result[kind] = { id: part.id, mime: part.mime, size: part.size };
 }
 if(f.duration!==undefined){if(!f.mime.startsWith('video/')||!Number.isFinite(f.duration)||f.duration<0||f.duration>7*86400)throw failure('INVALID_ATTACHMENT');result.duration=f.duration;}
 if(f.voice!==undefined){const v=f.voice;if(!f.mime.startsWith('audio/')||!v||!Number.isFinite(v.duration)||v.duration<=0||v.duration>14400||!Array.isArray(v.waveform)||v.waveform.length>128||v.waveform.some(n=>!Number.isFinite(n)||n<0||n>1))throw failure('INVALID_ATTACHMENT');result.voice={duration:v.duration,waveform:v.waveform};}
 return result;
}
function validatedContent(content) {
  if (!content || typeof content !== 'object' || typeof content.text !== 'string') throw failure('INVALID_MESSAGE');
  if (Buffer.byteLength(content.text) > 4096) throw failure('MESSAGE_TOO_LARGE');
  const result = { text: content.text };
  if(content.mentions!==undefined)result.mentions=validMentions(content.text,content.mentions);
  if (content.reply !== undefined) {
    const reply = content.reply;
    if (!reply || !Number.isSafeInteger(reply.id) || reply.id <= 0 || typeof reply.author !== 'string' || reply.author.length > 64 || typeof reply.text !== 'string' || Buffer.byteLength(reply.text) > 4096) throw failure('INVALID_MESSAGE');
    result.reply = { id: reply.id, author: reply.author, text: reply.text };
  }
  if (content.image !== undefined) {
    const image = content.image;
    if (!image || !hexID(image.id, 32) || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mime)) throw failure('INVALID_IMAGE');
    result.image = { id: image.id, mime: image.mime };
    if(image.name!==undefined){if(typeof image.name!=='string'||!image.name.length||image.name.length>255)throw failure('INVALID_IMAGE');result.image.name=image.name;}
    if (image.size !== undefined || image.preview !== undefined || image.view !== undefined) {
      const { size, preview, view } = validatedAttachment({ ...image, name: image.name ?? 'image' }, true);
      Object.assign(result.image, { size, ...(preview && { preview }), ...(view && { view }) });
    }
  }
  if(content.gif!==undefined){const g=content.gif;const safe=value=>{try{const u=new URL(value);return typeof value==='string'&&value.length<=2048&&u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443');}catch{return false;}};if(!g||content.text!==g.source||!safe(g.source)||!safe(g.url)||content.file||content.image||content.poll)throw failure('INVALID_MESSAGE');if(g.mime!==undefined&&!['image/gif','video/mp4','video/webm'].includes(g.mime))throw failure('INVALID_MESSAGE');result.gif={source:g.source,url:g.url,...(g.mime?{mime:g.mime}:{})};}
  if(content.checklist!==undefined){
    const c=content.checklist;
    if(!c||typeof c.everyone!=='boolean'||!Array.isArray(c.items)||!c.items.length||c.items.length>100||content.poll||content.image||content.file)throw failure('INVALID_CHECKLIST');
    const seen=new Set();for(const item of c.items){if(!item||!hexID(item.id,32)||seen.has(item.id)||typeof item.text!=='string'||!item.text.trim()||item.text.length>300)throw failure('INVALID_CHECKLIST');seen.add(item.id);}
    result.checklist={everyone:c.everyone,items:c.items.map(({id,text})=>({id,text}))};
  }
  if(content.file!==undefined){if(content.image)throw failure('INVALID_ATTACHMENT');result.file=validatedAttachment(content.file);}
  if(content.files!==undefined){
    if(content.file||content.image||content.gif||content.poll||content.checklist||!Array.isArray(content.files)||!content.files.length||content.files.length>10)throw failure('INVALID_ATTACHMENT');
    result.files=content.files.map(file=>validatedAttachment(file,true));
  }
  const attachmentIDs=[result.image,result.file,...(result.files??[])].filter(Boolean)
    .flatMap(file=>mediaAttachmentParts(file).map(part=>part.id));
  if(attachmentIDs.length>20||new Set(attachmentIDs).size!==attachmentIDs.length)throw failure('INVALID_ATTACHMENT');
  if(content.poll!==undefined){
    if(!hexID(content.poll.id,32)||!content.text.trim()||Array.from(content.text).length>300||content.image||content.reply)throw failure('INVALID_POLL');
    result.poll={id:content.poll.id,...validatePoll(content.poll)};
    if(content.pollResult!==undefined){if(content.pollResult!==true)throw failure('INVALID_POLL');result.pollResult=true;}
  }else if(content.pollResult!==undefined)throw failure('INVALID_POLL');
  return result;
}

class MembershipClient {
  #attachmentDrafts = new WeakMap();
  #attachmentMessageReads = new WeakMap();
  #verifiedAttachmentMessages = new WeakMap();
  #importedMediaKeys = new WeakMap();
  #recentLiveKeys = new WeakMap();
  #attestationReads = new WeakMap();
  #recoveredDeviceKeys = new Map();
  #scopedChannelEdits = new WeakMap();
  #archiveResume = new ProtectedArchiveResume();
  #textStatusFailures = new Map();
  #textStatusChecks = new Map();
  #profileUnlinkRequests = new WeakMap();
  #roleRosterPreviews = new WeakMap();
  #protectedRateLimits = new Map();
  constructor({ credentials, fetcher, verify, trust, allowLoopback = false, protectedOnly = false, diagnostics }) {
    this.credentials = credentials; this.fetcher = fetcher; this.verify = verify; this.trust = trust;
    this.allowLoopback = allowLoopback; this.connections = new Map(); this.pendingIdentity = undefined;
    this.protectedOnly = protectedOnly;
    this.diagnostics = diagnostics;
    this.registryQueue = Promise.resolve();
    this.profileCache = new Map(); this.pendingMessages=new Map();
    this.protectedRotations = new Map();
    this.protectedInviteRedemptions = new Map();
  }
  policyCheckpoint() {
    this.protectedPolicyCheckpoint ??= new ProtectedPolicyCheckpoint(this.credentials, this.diagnostics);
    return this.protectedPolicyCheckpoint;
  }
  verifyProtectedPolicyPage(page, trust) {
    return this.policyCheckpoint().accept(page, trust);
  }
  epochCheckpoint() {
    this.protectedEpochCheckpoint ??= new ProtectedEpochCheckpoint(this.credentials);
    return this.protectedEpochCheckpoint;
  }
  async verifyEpochProof(epoch, policyTrust, fetchPolicyPage) {
    const signer = await this.policyCheckpoint().authorizeEpoch(epoch, policyTrust, fetchPolicyPage);
    return verifySignedEpoch(epoch, packageContext(policyTrust.serverId, epoch.Record), signer);
  }
  async openProtectedEpochPackage(delivery, context, privateKey, {
    policyTrust, fetchPolicyPage, fetchEpochProofs, textDisclosure, requireTextDisclosure, liveProfileId,
  }) {
    const identity = await this.identity();
    if (context.recipientId !== identity.deviceId) throw failure('UNVERIFIED_EPOCH_RECIPIENT');
    const checkpoint = this.policyCheckpoint();
    return this.epochCheckpoint().run(policyTrust, context.channelId, context.purpose, async continuity => {
      const authorize = async () => {
        const current = await checkpoint.authorizeRecipient(context, policyTrust, textDisclosure, requireTextDisclosure);
        if (liveProfileId && !Object.hasOwn(epochRecipients(current, context.channelId, 'archive'), context.recipientId)) {
          await checkpoint.verifyLiveAdmission(delivery, context, liveProfileId, policyTrust, fetchPolicyPage);
        }
      };
      await authorize();
      const signer = await checkpoint.authorizeEpoch(delivery.Epoch, policyTrust, fetchPolicyPage, context);
      const secret = openSignedEpochPackage(delivery, context, privateKey, signer);
      try {
        if (hash(secret) !== context.keyId) throw failure('EPOCH_KEY_MISMATCH');
        await continuity.accept(delivery.Epoch, epoch => this.verifyEpochProof(epoch, policyTrust, fetchPolicyPage), fetchEpochProofs);
        await authorize();
        return secret;
      } catch (error) {
        secret.fill(0);
        throw error;
      }
    });
  }
  async runProtectedRotation(purpose, options) {
    if (purpose !== 'live' && purpose !== 'archive') throw failure('INVALID_EPOCH_PURPOSE');
    const identity = await this.identity();
    const { policyTrust, fetchPolicyPage, fetchEpochProofs, channelId, profileId } = options;
    const checkpoint = this.policyCheckpoint();
    const rotate = purpose === 'archive' ? runArchiveRotation : runLiveRotation;
    const verify = epoch => this.verifyEpochProof(epoch, policyTrust, fetchPolicyPage);
    return this.epochCheckpoint().run(policyTrust, channelId, purpose, continuity => rotate({
      ...options, identity, serverId: policyTrust?.serverId,
      authorizeTask: async task => {
        await checkpoint.authorizeRotation(task, policyTrust, profileId, identity.deviceId);
        await continuity.prepare(task, verify, fetchEpochProofs);
      },
      authorizeEpoch: (epoch, context) => checkpoint.authorizeEpoch(epoch, policyTrust, fetchPolicyPage, context),
      commit: async (record, packages, links) => {
        await checkpoint.policyBasis(record, policyTrust, undefined, true);
        await options.commit(record, packages, links);
        const epoch = { Principal: { ProfileID: profileId, DeviceID: identity.deviceId }, Record: record };
        await continuity.accept(epoch, verify, fetchEpochProofs);
      },
    }));
  }
  async readProtectedArchiveKey(options) {
    const { policyTrust, fetchPolicyPage, fetchEpochProofs, textDisclosure, requireTextDisclosure } = options;
    const identity = await this.identity();
    const context = options.headContext;
    if (context?.recipientId !== identity.deviceId || context.channelId !== options.channelId || context.purpose !== 'archive') {
      throw failure('UNVERIFIED_EPOCH_RECIPIENT');
    }
    const checkpoint = this.policyCheckpoint();
    return this.epochCheckpoint().run(policyTrust, options.channelId, 'archive', async continuity => {
      await checkpoint.authorizeRecipient(context, policyTrust, textDisclosure, requireTextDisclosure);
      const result = await readArchiveKey({
        ...options, serverId: policyTrust?.serverId,
        authorizeEpoch: (epoch, context) => checkpoint.authorizeEpoch(epoch, policyTrust, fetchPolicyPage, context),
        acceptHead: epoch => continuity.accept(epoch, proof => this.verifyEpochProof(proof, policyTrust, fetchPolicyPage), fetchEpochProofs),
      });
      try {
        await checkpoint.authorizeRecipient(context, policyTrust, textDisclosure, requireTextDisclosure);
        return result;
      } catch (error) {
        result.secret?.fill(0);
        for (const key of result.keys ?? []) key.secret.fill(0);
        result.cursor?.secret.fill(0);
        throw error;
      }
    });
  }
  identity() {
    return this.pendingIdentity ??= (async () => {
      let saved = await this.credentials.load('pawtalk:identity:v2');
      if (!saved) {
        saved = JSON.stringify({ root: randomBytes(32).toString('hex'), device: randomBytes(32).toString('hex') });
        await this.credentials.save('pawtalk:identity:v2', saved);
      }
      const seeds = JSON.parse(saved);
      if (!hexID(seeds.root, 64) || !hexID(seeds.device, 64)) throw failure('INVALID_LOCAL_IDENTITY');
      const key = seed => ed25519SeedKey(Buffer.from(seed, 'hex'));
      const root = key(seeds.root), device = key(seeds.device);
      const profileKey = createPublicKey(root).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
      const deviceKey = createPublicKey(device).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
      return {
        profileKey, deviceKey, profileId: hash(Buffer.from(profileKey, 'base64url')), deviceId: hash(Buffer.from(deviceKey, 'base64url')),
        certificate: sign(null, signatureFrame('pawtalk-device-v2', profileKey, deviceKey), root).toString('base64url'), device,
        signProfile: frame => sign(null, frame, root),
      };
    })().catch(error => { this.pendingIdentity = undefined; throw error; });
  }
  async fetchJSON(base, path, options) {
    const request = () => this.#fetchJSON(base, path, options);
    return this.diagnostics ? this.diagnostics.request(path, options?.method ?? 'GET', request) : request();
  }
  #measure(stage, operation) {
    return this.diagnostics ? this.diagnostics.stage(stage, operation) : operation();
  }
  async #fetchJSON(base, path, { method = 'GET', body, headers = {}, fingerprint, proofResponse } = {}) {
    if (!path.startsWith('/api/') || path.includes('#') || path.includes('\\')) throw failure('INVALID_API_PATH');
    const protectedRequest = path.startsWith('/api/v3/');
    const authorization = headers.Authorization;
    const rateKey = protectedRequest && authorization
      ? base + ':' + createHash('sha256').update(authorization).digest('hex')
      : base;
    if (protectedRequest) {
      const retryAfter = Math.ceil(((this.#protectedRateLimits.get(rateKey) ?? 0) - Date.now()) / 1000);
      if (retryAfter > 0) throw Object.assign(failure('RATE_LIMIT'), { status: 429, retryAfter });
      this.#protectedRateLimits.delete(rateKey);
    }
    const attachmentBlock = path.startsWith('/api/v3/history/live-attachments/');
    const signal = AbortSignal.timeout(path.includes('/attachments/') ? 120000 : 10000);
    const request = extraHeaders => this.fetcher(base + path, {
      method, redirect: 'error', signal, pawtalkTLSFingerprint: fingerprint,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers, ...extraHeaders }, body,
    });
    const { response, result: proof } = proofResponse ? await readProtectedProofResponse(request, proofResponse === 'claim') :
      { response: await request() };
    if (proof !== undefined) return proof;
    const data = await readBoundedResponse(response, (attachmentBlock ? 2 : path.includes('/attachments/') ? 70 : 16) * 1024 * 1024);
    let result;
    try { result = JSON.parse(data.toString('utf8')); }
    catch { throw Object.assign(failure('INVALID_API_RESPONSE'), { status: response.status }); }
    if (!response.ok) {
      const code = result?.error?.code;
      const error=failure(typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'SERVER_ERROR');
      error.status = response.status;
      if (code === 'RATE_LIMIT' && response.status === 429) {
        const retryAfter = response.headers?.get?.('retry-after');
        if (/^[1-9]\d?$/.test(retryAfter ?? '') && Number(retryAfter) <= 60) error.retryAfter = Number(retryAfter);
        if (protectedRequest) {
          const now = Date.now();
          for (const [address, until] of this.#protectedRateLimits) if (until <= now) this.#protectedRateLimits.delete(address);
          this.#protectedRateLimits.set(rateKey, Math.max(this.#protectedRateLimits.get(rateKey) ?? 0, now + (error.retryAfter ?? 60) * 1000));
        }
      }
      const details=result?.error?.details;
      if(details&&typeof details==='object'&&!Array.isArray(details)){
        error.details={};
        if (code === 'PROTECTED_RECOVERY_REQUIRED' && Array.isArray(details.recoveryProfiles) &&
            details.recoveryProfiles.every(profile => hexID(profile, 64))) error.details.recoveryProfiles = details.recoveryProfiles;
        if(details.expiresAt===null||Number.isSafeInteger(details.expiresAt)&&details.expiresAt>0)error.details.expiresAt=details.expiresAt;
        if (code === 'PROTECTED_SLOWMODE' && Number.isSafeInteger(details.retryAt) && details.retryAt > 0) error.details.retryAt = details.retryAt;
        if(['kicked','left','linked'].includes(details.membershipState))error.details.membershipState=details.membershipState;
        const maxReasonLength = code === 'BANNED' && details.inherited === true ? 512 : 200;
        if (details.moderationScope === 'server' && typeof details.reason === 'string' &&
            [...details.reason].length <= maxReasonLength && !/[\p{Cc}\p{Cs}]/u.test(details.reason)) error.details.reason = details.reason;
      }
      throw error;
    }
    return result;
  }
  async discoverMembership(address, expectedServerId, expectedFingerprint, { trustAddress = true } = {}) {
    const clean = address.split('#')[0], base = serverURL(clean, this.allowLoopback);
    let fingerprint;
    try { fingerprint = await this.verify(clean); } // Pin before invitation or session credentials.
    catch(error) { if(error.code==='PAWTALK_CERTIFICATE_PIN')throw failure('SERVER_KEY_CHANGED');throw error; }
    if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) throw failure('SERVER_KEY_CHANGED');
    if (trustAddress) await this.trust(clean);
    const config = await this.fetchJSON(base, '/api/config', { fingerprint });
    if (![apiProtocolVersion, 3].includes(config?.apiProtocolVersion) || config.e2eeRequired !== true) throw failure('UNSUPPORTED_PROTOCOL');
    if (!hexID(config.serverId, 32) || (expectedServerId && config.serverId !== expectedServerId)) throw failure('SERVER_ID_CHANGED');
    const expectedTLS = hexID(fingerprint, 64) ? 'tls-sha256:' + fingerprint : '';
    if (config.apiProtocolVersion === 3) {
      if (!base.startsWith('https:') || !expectedTLS) throw failure('TLS_IDENTITY_MISSING');
      if (config.dataSchemaVersion !== 4 || ![config.binding, config.cutoverDigest, config.anchorDigest].every(value => hexID(value, 64)) ||
          typeof config.protectedVoice !== 'boolean' || typeof config.name !== 'string' || config.name.length > 128) {
        throw failure('INVALID_SERVER_IDENTITY');
      }
      const frame = signatureFrame('pawtalk-server-v3', config.serverId, '3', '4', config.name,
        config.binding, config.cutoverDigest, config.anchorDigest, 'true', String(config.protectedVoice));
      this.#verifyServerSignature(config, frame);
      return { base, address: clean, config, binding: config.binding, fingerprint };
    }
    const expectedOrigin = 'origin:' + base;
    if (!config.authBinding || (config.authBinding !== expectedTLS && config.authBinding !== expectedOrigin)) throw failure('SERVER_BINDING_MISMATCH');
    if (base.startsWith('https:') && !expectedTLS) throw failure('TLS_IDENTITY_MISSING');
    if (!Number.isSafeInteger(config.revision) || config.revision < 1 || typeof config.name !== 'string' || config.name.length > 128) throw failure('INVALID_SERVER_IDENTITY');
    const frame = signatureFrame('pawtalk-server-v2', config.serverId, config.authBinding, '2', config.name, config.initialized ? '1' : '0', String(config.revision));
    this.#verifyServerSignature(config, frame);
    return { base, address: clean, config, binding: config.authBinding, fingerprint };
  }
  #verifyServerSignature(config, frame) {
    if (typeof config.identityKey !== 'string' || !/^[\w-]{43}$/.test(config.identityKey) ||
        typeof config.identitySignature !== 'string' || !/^[\w-]{86}$/.test(config.identitySignature)) throw failure('INVALID_SERVER_IDENTITY');
    const rawKey = Buffer.from(config.identityKey, 'base64url');
    const signature = Buffer.from(config.identitySignature, 'base64url');
    if (rawKey.length !== 32 || rawKey.toString('base64url') !== config.identityKey || hash(rawKey).slice(0, 32) !== config.serverId ||
        signature.length !== 64 || signature.toString('base64url') !== config.identitySignature) throw failure('INVALID_SERVER_IDENTITY');
    const serverKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), type: 'spki', format: 'der' });
    if (!verify(null, frame, serverKey, signature)) throw failure('INVALID_SERVER_IDENTITY');
  }
  async verified(address, expectedServerId) {
    const connection = await this.discoverMembership(address, expectedServerId);
    if (connection.config.apiProtocolVersion === 3) throw failure('PROTECTED_PROTOCOL_REQUIRED');
    if (await this.loadProtectedRuntimeTrust(connection.config.serverId)) throw failure('PROTECTED_PROTOCOL_DOWNGRADE');
    return connection;
  }
  async signed(connection, path, input) {
    const identity = await this.identity(), body = JSON.stringify(input);
    const challenge = await this.fetchJSON(connection.base, '/api/v2/challenge', { fingerprint: connection.fingerprint });
    if (challenge.serverId !== connection.config.serverId || !hexID(challenge.challenge, 32) || typeof challenge.nonce !== 'string' || !/^[\w-]{43}$/.test(challenge.nonce)) throw failure('INVALID_CHALLENGE');
    const fields = signatureFrame('pawtalk-request-v2', connection.config.serverId, connection.binding, 'POST', path, challenge.challenge, challenge.nonce, hash(body));
    const proof = { binding: connection.binding, profileKey: identity.profileKey, deviceKey: identity.deviceKey, certificate: identity.certificate, challenge: challenge.challenge, signature: sign(null, fields, identity.device).toString('base64url') };
    return this.fetchJSON(connection.base, path, { method: 'POST', body, fingerprint: connection.fingerprint, headers: { 'X-PawTalk-Proof': Buffer.from(JSON.stringify(proof)).toString('base64url') } });
  }
  async readProtectedMigrationHistory(serverId, { kind, cursor = '', limit = 1, archiveSha256 = '' }) {
    const kinds = ['messages', 'attachments', 'polls', 'checklists', 'system_messages'];
    if (!hexID(serverId, 32) || !kinds.includes(kind) || typeof cursor !== 'string' || cursor.length > 32 ||
        !Number.isInteger(limit) || limit < 1 || limit > (kind === 'attachments' ? 1 : 64) ||
        (cursor !== '' || archiveSha256 !== '') && !hexID(archiveSha256, 64)) throw failure('INVALID_MIGRATION_PAGE');
    const result = await this.migrationHistoryRequest(serverId, kind, cursor, limit, archiveSha256);
    if (!Array.isArray(result.records) || result.records.length > limit ||
        result.records.some(row => !row || typeof row.id !== 'string' || !row.metadata || typeof row.metadata !== 'object') ||
        (result.next !== undefined && (result.records.length !== limit || result.next !== result.records.at(-1)?.id))) throw failure('INVALID_API_RESPONSE');
    return result;
  }
  async migrationHistoryRequest(serverId, kind, cursor, limit, archiveSha256) {
    const { base, fingerprint, nonce } = await this.migrationChallenge(serverId);
    const { deviceId, device } = await this.identity();
    const frame = signatureFrame('pawtalk-migration-history-v1', serverId, deviceId, nonce, archiveSha256, kind, cursor, String(limit));
    const body = JSON.stringify({ deviceId, nonce, archiveSha256, cursor, limit, signature: sign(null, frame, device).toString('base64url') });
    const directPaths = { progress: '/api/v3/migration/progress', policy: '/api/v3/migration/policy',
      checkpoint: '/api/v3/migration/checkpoint',
      'recovery-archive': '/api/v3/migration/recovery/archive/pending' };
    const path = directPaths[kind] ?? `/api/v3/migration/history/${kind}/page`;
    const result = await this.fetchJSON(base, path, { method: 'POST', body, fingerprint });
    if (result?.serverId !== serverId || !hexID(result.archiveSha256, 64) ||
        (archiveSha256 !== '' && result.archiveSha256 !== archiveSha256)) throw failure('MIGRATION_CHECKPOINT_CHANGED');
    return result;
  }
  async protectedMigrationProgress(serverId, archiveSha256) {
    if (!hexID(serverId, 32) || !hexID(archiveSha256, 64)) throw failure('INVALID_MIGRATION_PAGE');
    const { progress } = await this.migrationHistoryRequest(serverId, 'progress', '', 1, archiveSha256);
    if (typeof progress?.complete !== 'boolean' || !['messages', 'attachments', 'polls'].every(kind => {
      const count = progress.counts?.[kind];
      return Number.isSafeInteger(count?.source) && Number.isSafeInteger(count.imported) &&
        count.imported >= 0 && count.source >= count.imported && (!progress.complete || count.source === count.imported);
    })) throw failure('INVALID_API_RESPONSE');
    return progress;
  }
  async protectedStandaloneMigrationCheckpoint(serverId) {
    if (!hexID(serverId, 32)) throw failure('INVALID_MIGRATION_PAGE');
    const { archiveSha256 } = await this.migrationHistoryRequest(serverId, 'checkpoint', '', 1, '');
    return { archiveSha256 };
  }
  async protectedStandaloneMigrationPending(serverId) {
    const { base, fingerprint } = await this.pinnedMembershipTransport(serverId);
    const status = await this.fetchJSON(base, '/api/v3/migration/healthz', { fingerprint });
    return status?.status === 'maintenance';
  }
  async protectedStandaloneMigrationControl(serverId, archiveSha256, action, payload) {
    if (!hexID(serverId, 32) || !hexID(archiveSha256, 64) ||
        !['report', 'approve-import', 'stage-policy', 'approve-cutover'].includes(action) ||
        (action === 'report') !== (payload === undefined)) throw failure('INVALID_MIGRATION_PROOF');
    const { base, fingerprint, nonce } = await this.migrationChallenge(serverId);
    const { deviceId, device } = await this.identity();
    const frame = signatureFrame('pawtalk-migration-control-v1', serverId, deviceId, nonce, archiveSha256,
      action, hash(payload === undefined ? '' : JSON.stringify(payload)));
    const body = JSON.stringify({ deviceId, nonce, archiveSha256, payload, signature: sign(null, frame, device).toString('base64url') });
    const result = await this.fetchJSON(base, `/api/v3/migration/control/${action}`, { method: 'POST', body, fingerprint });
    if (action === 'report' && (result?.serverId !== serverId || result.archiveSha256 !== archiveSha256)) {
      throw failure('MIGRATION_CHECKPOINT_CHANGED');
    }
    return result;
  }
  async protectedMigrationPolicyDraft(serverId, archiveSha256) {
    if (!hexID(serverId, 32) || !hexID(archiveSha256, 64)) throw failure('INVALID_MIGRATION_PAGE');
    const { policy } = await this.migrationHistoryRequest(serverId, 'policy', '', 1, archiveSha256);
    const { stagedKeys, confirmedPackages } = policy?.ownerRecoveryArchive ?? {};
    const recovery = policy?.ownerRecovery;
    if (!hexID(policy?.ownerProfileId, 64) || policy.ownerRecoveryRequired !== true || !Array.isArray(policy.blockers) ||
        (policy.blockers.length ? policy.state !== undefined : policy.state?.Owner !== policy.ownerProfileId) ||
        !Array.isArray(policy.administratorPending) || policy.administratorPending.some(id => !hexID(id, 64)) ||
        !Number.isSafeInteger(stagedKeys) || !Number.isSafeInteger(confirmedPackages) || confirmedPackages < 0 || stagedKeys < confirmedPackages ||
        (recovery === undefined ? confirmedPackages !== 0 : ![recovery?.recoveryId, recovery?.signingKey, recovery?.agreementKey]
          .every(value => hexID(value, 64)))) throw failure('INVALID_API_RESPONSE');
    return policy;
  }
  async signProtectedMigrationImportReview(serverId, { report, confirmedReviewDigest }) {
    const { archiveSha256, ownerProfileId, history, messagePositionsDigest, policyDigest, policyBlockers, recoveryArchive, recoveryArchiveDigest } = report ?? {};
    const invalid = failure('INVALID_MIGRATION_IMPORT_REVIEW');
    if (!hexID(serverId, 32) || report?.serverId !== serverId ||
        ![archiveSha256, ownerProfileId, history?.digest, messagePositionsDigest, policyDigest, recoveryArchiveDigest].every(value => hexID(value, 64)) ||
        !Array.isArray(policyBlockers) || policyBlockers.length !== 0 || !Number.isSafeInteger(history.records) || history.records < 0 ||
        !Number.isSafeInteger(recoveryArchive?.stagedKeys) || recoveryArchive.stagedKeys < 0 ||
        recoveryArchive.stagedKeys !== recoveryArchive.confirmedPackages) throw invalid;
    const reviewDigest = hash(signatureFrame('pawtalk-migration-import-review-v1', serverId, archiveSha256, ownerProfileId,
      history.digest, String(history.records), messagePositionsDigest, policyDigest, recoveryArchiveDigest, String(recoveryArchive.stagedKeys)));
    if (reviewDigest !== report.reviewDigest || reviewDigest !== confirmedReviewDigest) throw invalid;
    const policy = await this.protectedMigrationPolicyDraft(serverId, archiveSha256);
    if (policy.ownerProfileId !== ownerProfileId || !policy.state || !policy.ownerRecovery || policy.blockers.length ||
        policy.ownerRecoveryArchive.stagedKeys !== recoveryArchive.stagedKeys ||
        policy.ownerRecoveryArchive.confirmedPackages !== recoveryArchive.confirmedPackages) throw invalid;
    const { deviceId, device } = await this.identity();
    const frame = signatureFrame('pawtalk-migration-import-approval-v1', serverId, archiveSha256, ownerProfileId, deviceId, reviewDigest);
    return { reviewDigest, deviceId, signature: sign(null, frame, device).toString('base64url') };
  }
  async enrollProtectedMigrationOwnerRecipient(serverId, { archiveSha256, reviewDigest, ownerProfileId }) {
    if (!hexID(serverId, 32) || ![archiveSha256, reviewDigest, ownerProfileId].every(value => hexID(value, 64))) {
      throw failure('INVALID_MIGRATION_RECIPIENT');
    }
    const identity = await this.identity();
    const keySlot = serverId + identity.deviceId;
    this.pendingAgreementKeys ??= new Map();
    if (!this.pendingAgreementKeys.has(keySlot)) {
      const load = loadDeviceAgreementKey(this.credentials, serverId, identity.deviceId)
        .finally(() => this.pendingAgreementKeys.delete(keySlot));
      this.pendingAgreementKeys.set(keySlot, load);
    }
    const privateKey = await this.pendingAgreementKeys.get(keySlot);
    const { base, fingerprint, nonce, agreementKey } = await this.migrationChallenge(serverId, true);
    const proposal = proposeMigrationRecipient({ serverId, archiveSha256, reviewDigest, ownerProfileId, nonce, agreementKey }, identity, privateKey);
    const receipt = await this.fetchJSON(base, '/api/v3/migration/recipient', {
      fingerprint, method: 'POST', body: JSON.stringify(proposal),
    });
    if (receipt?.reviewDigest !== reviewDigest || receipt.deviceId !== identity.deviceId || receipt.publicKey !== proposal.publicKey) {
      throw failure('INVALID_MIGRATION_RECIPIENT_RECEIPT');
    }
    return receipt;
  }
  async signProtectedMigrationInitialPolicy(serverId, { report, confirmedReviewDigest }) {
    const invalid = failure('INVALID_MIGRATION_POLICY_APPROVAL');
    const { archiveSha256, ownerProfileId, reviewDigest, ownerRecipient, initialPolicy } = report ?? {};
    if (!hexID(serverId, 32) || report?.serverId !== serverId || ![archiveSha256, ownerProfileId, reviewDigest, ownerRecipient?.publicKey]
      .every(value => hexID(value, 64)) || reviewDigest !== confirmedReviewDigest || ownerRecipient.reviewDigest !== reviewDigest) throw invalid;
    const { deviceId, device } = await this.identity();
    if (ownerRecipient.deviceId !== deviceId) throw invalid;
    const key = await loadDeviceAgreementKey(this.credentials, serverId, deviceId, false);
    if (createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') !== ownerRecipient.publicKey) throw invalid;
    const draft = initialPolicy?.draft;
    const operationId = hash(signatureFrame('pawtalk-migration-initial-policy-operation-v1', reviewDigest, deviceId, ownerRecipient.publicKey)).slice(0, 32);
    if (draft?.OperationID !== operationId || draft.Action !== 'policy.anchor' || draft.Revision !== 1 ||
        draft.PreviousDigest !== '' || draft.PublicKey !== '' || draft.RoleUpdate !== null || draft.Signature !== null ||
        draft.DeviceChange !== undefined || draft.ResourceChange !== undefined || !hexID(draft.ResultDigest, 64) ||
        typeof initialPolicy.snapshot !== 'string' || initialPolicy.snapshot.length > 12 * 1024 * 1024) throw invalid;
    const raw = Buffer.from(initialPolicy.snapshot, 'base64');
    if (raw.length > 8 * 1024 * 1024 || raw.toString('base64') !== initialPolicy.snapshot || hash(raw) !== draft.ResultDigest) throw invalid;
    const policy = await this.protectedMigrationPolicyDraft(serverId, archiveSha256);
    if (policy.ownerProfileId !== ownerProfileId || !policy.state || !policy.ownerRecovery || policy.blockers.length) throw invalid;
    const snapshot = JSON.parse(raw.toString('utf8'));
    if (initialPolicy.runtimeRecovery !== undefined && initialPolicy.runtimeRecovery !== true) throw invalid;
    verifyMigrationInitialSnapshot(policy, snapshot, deviceId, ownerRecipient.publicKey, initialPolicy.preserveChannelOrder, initialPolicy.runtimeRecovery);
    verifyPolicyTextProjection(draft, snapshot);
    const frame = protectedPolicySignatureFrame(serverId, { ProfileID: ownerProfileId, DeviceID: deviceId }, draft, 'null');
    const signature = sign(null, frame, device);
    const anchorDigest = hash(signature);
    const bound = signatureFrame('pawtalk-migration-initial-policy-binding-v1', serverId, archiveSha256, ownerProfileId, deviceId,
      reviewDigest, operationId, draft.ResultDigest, anchorDigest);
    const scopeAttestation = hasTextRecipientProjection(draft.TextProjectionVersion)
      ? signProtectedPolicyScope({ serverId, anchorDigest, ownerProfileId, ownerDeviceId: deviceId }, draft, anchorDigest, device)
      : undefined;
    return { reviewDigest, policySignature: signature.toString('base64url'), importBinding: sign(null, bound, device).toString('base64url'),
      ...(scopeAttestation && { scopeAttestation: scopeAttestation.toString('base64url') }) };
  }
  async signProtectedMigrationCutover(serverId, { report, policyApproval, confirmedCutoverDigest }) {
    const failureCode = 'INVALID_MIGRATION_CUTOVER_APPROVAL';
    const { archiveSha256, ownerProfileId, reviewDigest, policyAnchorDigest, currentRecovery, historyLinks, ownerRecipient } = report ?? {};
    if (!hexID(serverId, 32) || report?.serverId !== serverId ||
        ![archiveSha256, ownerProfileId, reviewDigest, policyAnchorDigest, ownerRecipient?.publicKey].every(value => hexID(value, 64)) ||
        reviewDigest !== policyApproval?.reviewDigest || ownerRecipient.reviewDigest !== reviewDigest ||
        !/^[A-Za-z0-9_-]{86}$/.test(policyApproval.policySignature ?? '') ||
        ![currentRecovery, historyLinks].every(coverage => hexID(coverage?.digest, 64) &&
          Number.isSafeInteger(coverage?.expected) && coverage.expected >= 0 && coverage.expected === coverage.confirmed)) throw failure(failureCode);
    const anchorSignature = Buffer.from(policyApproval.policySignature, 'base64url');
    if (anchorSignature.length !== 64 || anchorSignature.toString('base64url') !== policyApproval.policySignature ||
        hash(anchorSignature) !== policyAnchorDigest) throw failure(failureCode);
    const identity = await this.identity();
    if (identity.deviceId !== ownerRecipient.deviceId) throw failure(failureCode);
    const digest = hash(signatureFrame('pawtalk-migration-cutover-v1', serverId, archiveSha256, ownerProfileId,
      reviewDigest, policyAnchorDigest, currentRecovery.digest, historyLinks.digest, identity.deviceId, ownerRecipient.publicKey));
    if (digest !== report.cutoverDigest || digest !== confirmedCutoverDigest) throw failure(failureCode);
    const trust = { serverId, ownerProfileId, ownerDeviceId: identity.deviceId, anchorDigest: policyAnchorDigest };
    const saved = await this.policyCheckpoint().load(trust);
    const page = await this.migrationKeyRequest(trust, archiveSha256, identity, 'policy', { after: saved?.revision ?? 0 });
    await this.policyCheckpoint().accept(page, trust);
    const checkpoint = await this.policyCheckpoint().load(trust);
    if (checkpoint?.revision !== 1 || checkpoint.digest !== policyAnchorDigest || !checkpoint.complete) throw failure(failureCode);
    const genesis = JSON.parse(Buffer.from(checkpoint.snapshot, 'base64').toString('utf8'));
    const recovery = genesis.RecoveryIdentities?.[ownerProfileId];
    if ((recovery ? true : undefined) !== report.initialPolicy?.runtimeRecovery) throw failure(failureCode);
    const runtimeTrust = { ...trust, cutoverDigest: digest };
    let scopeAuthority;
    if (recovery) {
      const deviceKey = genesis.PolicyDevices[identity.deviceId].PublicKey;
      const operationId = hash(signatureFrame('pawtalk-migration-initial-policy-operation-v1', reviewDigest,
        identity.deviceId, ownerRecipient.publicKey)).slice(0, 32);
      scopeAuthority = signScopeAuthorityLink(runtimeTrust, scopeAuthorityGenesis(runtimeTrust, deviceKey), {
        action: 'recovery.authorize', revision: 1, policyHead: policyAnchorDigest, operationId,
        recoveryId: recovery.ID, recoveryKey: recovery.SigningKey, deviceKey,
      }, identity.device);
    }
    const frame = signatureFrame('pawtalk-migration-cutover-approval-v1', serverId, archiveSha256, ownerProfileId, identity.deviceId, digest);
    await this.#saveProtectedRuntimeTrust(runtimeTrust);
    this.connections.delete(serverId);
    return { cutoverDigest: digest, signature: sign(null, frame, identity.device).toString('base64url'), ...(scopeAuthority && { scopeAuthority }) };
  }
  async prepareProtectedMigrationRecoveryBundle(serverId, code) {
    const trust = await this.loadProtectedRuntimeTrust(serverId);
    const { deviceId } = await this.identity();
    if (!trust || trust.ownerDeviceId !== deviceId) throw failure('INVALID_MIGRATION_RECOVERY');
    const checkpoint = await this.policyCheckpoint().load(trust);
    if (checkpoint?.revision !== 1 || checkpoint.digest !== trust.anchorDigest || !checkpoint.complete) {
      throw failure('INVALID_MIGRATION_RECOVERY');
    }
    const { ownerProfileId: profileId } = trust;
    const genesis = JSON.parse(Buffer.from(checkpoint.snapshot, 'base64').toString('utf8'));
    const recovery = genesis.RecoveryIdentities?.[profileId];
    const expected = deriveRecoveryIdentity(code, serverId, profileId);
    if (!genesis.RecoveryReady?.[profileId] || recovery?.ID !== expected.recoveryId ||
        recovery.SigningKey !== expected.signingKey || recovery.AgreementKey !== expected.agreementKey) {
      throw failure('INVALID_MIGRATION_RECOVERY');
    }
    const { address, fingerprint } = await this.pinnedMembershipTransport(serverId);
    return createRecoveryBundle({ address, fingerprint, trust, profileId, code }, this.allowLoopback);
  }
  async prepareProtectedMigrationChannelKeys(serverId, { archiveSha256, ownerProfileId, policyApproval, channelId, code }) {
    if (!hexID(serverId, 32) || !hexID(archiveSha256, 64) || !hexID(ownerProfileId, 64) || !hexID(channelId, 32) ||
        !hexID(policyApproval?.reviewDigest, 64) || !/^[A-Za-z0-9_-]{86}$/.test(policyApproval.policySignature ?? '')) {
      throw failure('INVALID_MIGRATION_POLICY_APPROVAL');
    }
    const signature = Buffer.from(policyApproval.policySignature, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== policyApproval.policySignature) throw failure('INVALID_MIGRATION_POLICY_APPROVAL');
    const identity = await this.identity();
    const policyTrust = { serverId, ownerProfileId, ownerDeviceId: identity.deviceId, anchorDigest: hash(signature) };
    const policy = await this.protectedMigrationPolicyDraft(serverId, archiveSha256);
    if (policy.ownerProfileId !== ownerProfileId || !policy.ownerRecovery) throw failure('INVALID_MIGRATION_RECOVERY');
    const recovery = deriveRecoveryIdentity(code, serverId, ownerProfileId);
    const { recoveryId, signingKey, agreementKey } = recovery;
    if (Object.entries({ recoveryId, signingKey, agreementKey }).some(([key, value]) => policy.ownerRecovery[key] !== value)) {
      throw failure('INVALID_MIGRATION_RECOVERY');
    }
    const privateKey = await loadDeviceAgreementKey(this.credentials, serverId, identity.deviceId, false);
    const recipientKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const request = (action, fields) => this.migrationKeyRequest(policyTrust, archiveSha256, identity, action, fields);
    const fetchPolicyPage = after => request('policy', { after });
    const saved = await this.policyCheckpoint().load(policyTrust);
    await this.policyCheckpoint().accept(await fetchPolicyPage(saved?.revision ?? 0), policyTrust);

    const fetchEpochProofs = async (channel, purpose, after, through) => {
      if (after !== 0 || through !== 1) throw failure('EPOCH_CHAIN_GAP');
      const proofs = await request('proof', { channelId: channel, purpose });
      const record = proofs?.[0]?.Record;
      if (!Array.isArray(proofs) || proofs.length !== 1 || record?.ChannelID !== channel ||
          record.Purpose !== purpose || record.Generation !== 1) throw failure('INVALID_API_RESPONSE');
      return proofs;
    };
    const prepared = {};
    for (const purpose of ['live', 'archive']) {
      let proofs;
      try { proofs = await fetchEpochProofs(channelId, purpose, 0, 1); }
      catch (error) {
        if (error.code !== 'MIGRATION_EPOCH_PENDING') throw error;
        const rotation = this.runProtectedRotation(purpose, {
          channelId, profileId: ownerProfileId, policyTrust, privateKey, fetchPolicyPage, fetchEpochProofs,
          claim: (channelId, purpose) => request('claim', { channelId, purpose }),
          commit: (record, packages, links) => request('commit', { record, packages, links }),
          loadTarget: (task, target) => {
            const { ChannelID, Purpose, Generation, Revision, TaskID, LeaseID, ArchiveThrough } = task;
            return request('target', { record: { ChannelID, Purpose, Generation, Revision, TaskID, LeaseID, ArchiveThrough }, target });
          },
        });
        try { await rotation; }
        catch (rotationError) {
          if (!['MIGRATION_EPOCH_CONFLICT', 'MIGRATION_ROTATION_UNAVAILABLE'].includes(rotationError.code)) throw rotationError;
        }
        proofs = await fetchEpochProofs(channelId, purpose, 0, 1);
      }
      const { Record: record } = proofs[0];
      const delivery = await request('package', { channelId, purpose, keyId: record.KeyID });
      if (delivery?.Epoch?.Record?.Signature !== record.Signature) throw failure('EPOCH_FORK');
      const context = packageContext(serverId, record, identity.deviceId, recipientKey);
      const secret = await this.openProtectedEpochPackage(delivery, context, privateKey, { policyTrust, fetchPolicyPage, fetchEpochProofs });
      try {
        const epochDigest = hash(Buffer.from(record.Signature, 'base64'));
        const basis = await this.policyCheckpoint().policyBasis(record, policyTrust, fetchPolicyPage, false);
        const adopted = basis.RecoveryIdentities?.[ownerProfileId];
        if (adopted && (adopted.ID !== recoveryId || adopted.SigningKey !== signingKey || adopted.AgreementKey !== agreementKey ||
            basis.RecoveryReady?.[ownerProfileId] !== true)) throw failure('INVALID_MIGRATION_RECOVERY');
        const scope = { channelId, purpose, keyId: record.KeyID, epochDigest };
        let receipt;
        let runtimePackageSha256;
        try { receipt = await request('backup-status', scope); }
        catch (error) {
          if (error.code !== 'MIGRATION_EPOCH_RECOVERY_PENDING') throw error;
          const backupContext = { ...scope, serverId, archiveSha256, ownerProfileId, recoveryId, agreementKey,
            anchorDigest: policyTrust.anchorDigest, deviceId: identity.deviceId };
          const packet = sealMigrationRecoveryPackage(secret, backupContext, identity.device);
          const signerKey = createPublicKey(identity.device).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
          const confirmation = confirmMigrationRecoveryPackage(packet, backupContext, code, signerKey, signingKey);
          let runtimeOpeningProof;
          if (adopted) {
            const wrapped = await request('recovery-package', scope);
            if (wrapped?.Epoch?.Record?.Signature !== record.Signature) throw failure('EPOCH_FORK');
            const recoveryContext = packageContext(serverId, record, recoveryId, agreementKey);
            const signer = await this.policyCheckpoint().authorizeEpoch(wrapped.Epoch, policyTrust, fetchPolicyPage, recoveryContext);
            runtimeOpeningProof = proveMigrationRuntimeRecoveryOpening(wrapped, recoveryContext, recovery.agreement, signer, backupContext);
            runtimePackageSha256 = hash(Buffer.from(wrapped.Package.Ciphertext, 'base64'));
          }
          receipt = await request('backup', { ...scope, backup: { ...packet, recoveryId, confirmation, runtimeOpeningProof } });
        }
        const validRuntimeReceipt = adopted ? hexID(receipt?.runtimePackageSha256, 64) : receipt?.runtimePackageSha256 === undefined;
        if (Object.entries({ ...scope, recoveryId }).some(([key, value]) => receipt?.[key] !== value) ||
            !hexID(receipt?.ciphertextSha256, 64) || !validRuntimeReceipt ||
            (runtimePackageSha256 && receipt.runtimePackageSha256 !== runtimePackageSha256)) throw failure('INVALID_MIGRATION_RECOVERY_RECEIPT');
        if (purpose === 'archive') {
          await this.prepareMigrationHistoryLink(request, secret, {
            serverId, archiveSha256, anchorDigest: policyTrust.anchorDigest, channelId, archiveKeyId: record.KeyID, epochDigest,
          }, identity);
        }
      } finally {
        secret.fill(0);
      }
      prepared[purpose] = record.KeyID;
    }
    return prepared;
  }
  async prepareMigrationHistoryLink(request, archiveSecret, context, identity) {
    const scope = { channelId: context.channelId, keyId: context.archiveKeyId, epochDigest: context.epochDigest };
    const { serverId, ...expected } = context;
    const checkScope = delivery => {
      if (Object.entries({ ...expected, deviceId: identity.deviceId }).some(([key, value]) => delivery?.[key] !== value)) {
        throw failure('INVALID_MIGRATION_HISTORY_LINK');
      }
    };
    let delivery = await request('history-link-status', scope);
    checkScope(delivery);
    if (delivery.importedKeyId === '' && !delivery.link) return;
    if (!hexID(delivery.importedKeyId, 64)) throw failure('INVALID_MIGRATION_HISTORY_LINK');
    const linkContext = { ...context, importedKeyId: delivery.importedKeyId, deviceId: identity.deviceId };
    if (!delivery.link) {
      const imported = await loadMigrationArchiveKey(this.credentials, serverId, context.archiveSha256, context.channelId, delivery.importedKeyId);
      try {
        const historyLink = sealMigrationHistoryLink(archiveSecret, imported.secret, linkContext, identity.device);
        delivery = await request('history-link', { ...scope, historyLink });
        checkScope(delivery);
        if (delivery.importedKeyId !== linkContext.importedKeyId) throw failure('INVALID_MIGRATION_HISTORY_LINK');
      } finally {
        imported.secret.fill(0);
      }
    }
    const signerKey = createPublicKey(identity.device).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const reopened = openSignedMigrationHistoryLink(archiveSecret, linkContext, delivery.link, signerKey);
    reopened.fill(0);
  }
  async migrationKeyRequest(trust, archiveSha256, identity, action, fields) {
    const { base, fingerprint, nonce } = await this.migrationChallenge(trust.serverId);
    const body = JSON.stringify({ ...fields, archiveSha256, anchorDigest: trust.anchorDigest });
    const frame = signatureFrame('pawtalk-migration-keys-request-v1', trust.serverId, action, nonce, identity.deviceId, hash(body));
    return this.fetchJSON(base, `/api/v3/migration/keys/${action}`, {
      method: 'POST', body, fingerprint, headers: {
        'X-PawTalk-Migration-Nonce': nonce, 'X-PawTalk-Migration-Device': identity.deviceId,
        'X-PawTalk-Migration-Signature': sign(null, frame, identity.device).toString('base64url'),
      },
    });
  }
  async pendingProtectedMigrationRecoveryArchive(serverId, { archiveSha256, cursor = '', limit = 32 }) {
    if (!hexID(serverId, 32) || !hexID(archiveSha256, 64) || (cursor !== '' && !hexID(cursor, 32)) ||
        !Number.isInteger(limit) || limit < 1 || limit > 32) throw failure('INVALID_MIGRATION_PAGE');
    const { recoveryArchive: page } = await this.migrationHistoryRequest(serverId, 'recovery-archive', cursor, limit, archiveSha256);
    if (!hexID(page?.recoveryId, 64) || !Array.isArray(page.keys) || page.keys.length > limit ||
        page.keys.some((key, index) => !hexID(key?.channelId, 32) || !hexID(key.keyId, 64) ||
          key.channelId <= (index ? page.keys[index - 1].channelId : cursor)) ||
        (page.next !== undefined && (page.keys.length !== limit || page.next !== page.keys.at(-1)?.channelId))) {
      throw failure('INVALID_API_RESPONSE');
    }
    return page;
  }
  resumeProtectedMigrationRecoveryArchive(serverId, { archiveSha256, code }) {
    return runProtectedMigrationRecoveryArchive(this, serverId, archiveSha256, code);
  }
  resumeProtectedMigrationHistory(serverId, archiveSha256) {
    if (!hexID(serverId, 32) || !hexID(archiveSha256, 64)) return Promise.reject(failure('INVALID_MIGRATION_PAGE'));
    this.migrationRuns ??= new Map();
    const active = this.migrationRuns.get(serverId);
    if (active) return active.archiveSha256 === archiveSha256 ? active.promise : Promise.reject(failure('MIGRATION_CHECKPOINT_CHANGED'));
    const promise = runProtectedMigrationResume(this, serverId, archiveSha256).finally(() => this.migrationRuns.delete(serverId));
    this.migrationRuns.set(serverId, { archiveSha256, promise });
    return promise;
  }
  async pinnedMembershipTransport(serverId) {
    const record = (await this.registry()).find(item => item.serverId === serverId);
    if (!record) throw failure('NOT_A_MEMBER');
    const base = serverURL(record.address, this.allowLoopback);
    let fingerprint;
    try { fingerprint = await this.verify(record.address); }
    catch (error) { if (error.code === 'PAWTALK_CERTIFICATE_PIN') throw failure('SERVER_KEY_CHANGED'); throw error; }
    if (!base.startsWith('https:') || !hexID(fingerprint, 64)) throw failure('TLS_IDENTITY_MISSING');
    await this.trust(record.address);
    return { base, fingerprint, address: record.address };
  }
  async migrationChallenge(serverId, recovery = false) {
    const { base, fingerprint } = await this.pinnedMembershipTransport(serverId);
    const challenge = await this.fetchJSON(base, recovery ? '/api/v3/migration/recovery/challenge' : '/api/v3/migration/challenge', { fingerprint });
    if (challenge?.serverId !== serverId || !hexID(challenge.nonce, 64) || !Number.isSafeInteger(challenge.expiresAt)) throw failure('INVALID_CHALLENGE');
    return { base, fingerprint, nonce: challenge.nonce, agreementKey: challenge.agreementKey };
  }
  async openProtectedRuntimeSession(serverId, cutoverDigest) {
    if (!hexID(serverId, 32) || !hexID(cutoverDigest, 64)) throw failure('INVALID_PROTECTED_CUTOVER');
    return this.#openRuntimeSession(serverId, cutoverDigest, await this.pinnedMembershipTransport(serverId));
  }
  #protectedInviteRequest(connection, path, method = 'GET', input) {
    if (connection?.pendingInvite || !hexID(connection?.fingerprint, 64) || !connection.base?.startsWith('https:')) {
      throw failure('INVALID_PROTECTED_SESSION');
    }
    return this.fetchJSON(connection.base, '/api/v3/invites' + path, {
      method, ...(input !== undefined && { body: JSON.stringify(input) }), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
  }
  async listProtectedInvites(connection, before) {
    if (before !== undefined && !hexID(before, 32)) throw failure('INVALID_INVITE');
    const page = await this.#protectedInviteRequest(connection, before ? `?before=${before}` : '');
    if (!Array.isArray(page?.invites) || page.invites.length > 32 || typeof page.canCreate !== 'boolean' ||
        (page.canCreate ? !hexID(page.policyHead, 64) : page.policyHead !== undefined) ||
        page.next !== undefined && (page.invites.length !== 32 || page.next !== page.invites.at(-1)?.id)) {
      throw failure('INVALID_API_RESPONSE');
    }
    return { invites: page.invites.map(protectedInviteMetadata), next: page.next, canCreate: page.canCreate, policyHead: page.policyHead };
  }
  async createProtectedInvite(connection, { expiresAt = 0, maxUses = 1 } = {}) {
    const trust = connection?.policyTrust;
    if (!trust || !hexID(connection.serverId, 32) || trust.serverId !== connection.serverId ||
        ![trust.anchorDigest, trust.cutoverDigest, trust.ownerProfileId, trust.ownerDeviceId, connection.fingerprint].every(value => hexID(value, 64)) ||
        !Number.isSafeInteger(expiresAt) || expiresAt < 0 || expiresAt > 8_640_000_000_000_000 ||
        !Number.isSafeInteger(maxUses) || maxUses < 0) throw failure('INVALID_INVITE');
    const { deviceId, device } = await this.identity();
    if (deviceId !== connection.deviceId || !hexID(connection.profileId, 64)) throw failure('INVALID_PROTECTED_SESSION');
    const { canCreate, policyHead: policyDigest } = await this.listProtectedInvites(connection);
    if (!canCreate) throw failure('PROTECTED_ACCESS_DENIED');
    const address = new URL(connection.base);
    const dnsSuffix = isIP(address.hostname.replace(/^\[|\]$/g, '')) ? '' : '/v3';
    const link = new URL(`pawtalk://${address.hostname}:${address.port || '443'}/${connection.fingerprint}${dnsSuffix}`);
    const seed = randomBytes(32);
    const token = seed.toString('base64url');
    const capability = ed25519SeedKey(seed);
    const tokenHash = hash(createPublicKey(capability).export({ type: 'spki', format: 'der' }).subarray(-32));
    const id = requestID();
    link.hash = new URLSearchParams({ v: '3', server: trust.serverId, invite: id, token, cutover: trust.cutoverDigest,
      anchor: trust.anchorDigest, owner: trust.ownerProfileId, ownerDevice: trust.ownerDeviceId }).toString();
    invitation(link.href);
    const proof = signatureFrame('pawtalk-protected-invite-v1', trust.serverId, connection.profileId, deviceId,
      policyDigest, id, tokenHash, String(expiresAt), String(maxUses));
    const receipt = await this.#protectedInviteRequest(connection, '', 'POST', {
      id, tokenHash, policyDigest, expiresAt, maxUses, signature: sign(null, proof, device).toString('base64'),
    });
    const metadata = protectedInviteMetadata(receipt?.invite);
    if (typeof receipt.existing !== 'boolean' || metadata.id !== id || metadata.creator !== connection.profileId ||
        metadata.maxUses !== maxUses || metadata.expiresAt !== (expiresAt || metadata.createdAt + 86_400_000)) throw failure('INVALID_API_RESPONSE');
    return { invite: metadata, link: link.href };
  }
  async revokeProtectedInvite(connection, inviteId) {
    if (!hexID(inviteId, 32)) throw failure('INVALID_INVITE');
    const result = await this.#protectedInviteRequest(connection, `/${inviteId}`, 'DELETE');
    if (result?.ok !== true) throw failure('INVALID_API_RESPONSE');
  }
  async redeemProtectedInvite(address, nickname) {
    let room;
    try { room = invitation(address); } catch { throw failure('INVALID_INVITE'); }
    if (!room?.protectedInvite || typeof nickname !== 'string' || !nickname.trim() ||
        [...nickname.trim()].length > 32 || /[\p{Cc}\p{Cs}]/u.test(nickname)) throw failure('INVALID_INVITE');
    const { trust } = room.protectedInvite;
    const previous = this.protectedInviteRedemptions.get(trust.serverId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.#redeemProtectedInvite(address, room, nickname.trim()));
    this.protectedInviteRedemptions.set(trust.serverId, operation);
    try {
      return await operation;
    } finally {
      if (this.protectedInviteRedemptions.get(trust.serverId) === operation) this.protectedInviteRedemptions.delete(trust.serverId);
    }
  }
  async #redeemProtectedInvite(address, { protectedInvite, fingerprint }, nickname) {
    const { inviteId, seed, trust } = protectedInvite;
    const { serverId, cutoverDigest, anchorDigest } = trust;
    if ((await this.records()).some(record => record.serverId === serverId && record.pendingLeave)) throw failure('LEAVE_PENDING');
    const saved = await this.loadProtectedRuntimeTrust(serverId);
    if (saved && !isDeepStrictEqual(saved, trust)) throw failure('PROTECTED_CUTOVER_CHANGED');
    const connection = await this.discoverMembership(address.trim(), serverId, fingerprint);
    if (connection.config.apiProtocolVersion !== 3) throw failure('PROTECTED_PROTOCOL_DOWNGRADE');
    if (connection.config.cutoverDigest !== cutoverDigest || connection.config.anchorDigest !== anchorDigest) {
      throw failure('PROTECTED_CUTOVER_CHANGED');
    }
    const identity = await this.identity();
    const slot = `pawtalk:protected-invite:v1:${serverId}:${inviteId}:${identity.deviceId}`;
    const savedClaim = await this.credentials.load(slot, { required: true });
    let retry;
    if (savedClaim == null) {
      retry = { operationId: requestID(), nickname, agreementSeed: randomBytes(32).toString('hex') };
      await this.credentials.save(slot, JSON.stringify(retry));
    } else {
      try { retry = JSON.parse(savedClaim); } catch { throw failure('INVALID_LOCAL_INVITE'); }
      if (!hexID(retry?.operationId, 32) || typeof retry.nickname !== 'string' || !retry.nickname ||
          [...retry.nickname].length > 32 || retry.nickname !== retry.nickname.trim() || /[\p{Cc}\p{Cs}]/u.test(retry.nickname) ||
          (retry.agreementSeed !== undefined && !hexID(retry.agreementSeed, 64))) {
        throw failure('INVALID_LOCAL_INVITE');
      }
    }
    const agreement = retry.agreementSeed ? deviceAgreementPrivateKey(retry.agreementSeed)
      : await loadDeviceAgreementKey(this.credentials, serverId, identity.deviceId, false);
    const agreementKey = createPublicKey(agreement).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const capability = ed25519SeedKey(Buffer.from(seed, 'base64url'));
    const claim = {
      inviteId, operationId: retry.operationId, nickname: retry.nickname, agreementKey,
      invitePublicKey: createPublicKey(capability).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'),
      profilePublicKey: identity.profileKey, devicePublicKey: identity.deviceKey,
    };
    const frame = signatureFrame('pawtalk-protected-invite-redeem-v1', serverId, cutoverDigest, inviteId, retry.operationId,
      claim.invitePublicKey, claim.profilePublicKey, claim.devicePublicKey, agreementKey, retry.nickname);
    let receipt;
    try {
      receipt = await this.fetchJSON(connection.base, '/api/v3/invites/redeem', {
        method: 'POST', fingerprint, body: JSON.stringify({ ...claim,
          inviteSignature: sign(null, frame, capability).toString('base64url'),
          profileSignature: identity.signProfile(frame).toString('base64url'),
          deviceSignature: sign(null, frame, identity.device).toString('base64url'),
        }),
      });
    } catch (error) {
      if (error.code !== 'PROTECTED_INVITE_CONFLICT') throw error;
      const state = await this.#resumeMigratedMember(connection, trust, identity);
      if (!state) throw error;
      return state;
    }
    if (receipt?.inviteId !== inviteId || receipt.profileId !== identity.profileId || receipt.deviceId !== identity.deviceId ||
        !Number.isSafeInteger(receipt.acceptedAt) || receipt.acceptedAt < 1 ||
        typeof receipt.existing !== 'boolean' || receipt.keysPending !== true) throw failure('INVALID_API_RESPONSE');
    if (retry.agreementSeed) {
      await this.credentials.save(`pawtalk:agreement:v1:${serverId}:${identity.deviceId}`, retry.agreementSeed);
    }
    await this.#saveProtectedRuntimeTrust(trust);
    await this.remember(connection);
    return { serverId, inviteId, profileId: identity.profileId, deviceId: identity.deviceId,
      nickname: retry.nickname, acceptedAt: receipt.acceptedAt, existing: receipt.existing, keysPending: true };
  }
  async #resumeMigratedMember(connection, trust, identity) {
    const { serverId, cutoverDigest } = trust;
    let session;
    try {
      session = await this.#openRuntimeSession(serverId, cutoverDigest, connection, connection.binding);
    } catch (error) {
      if (['INVALID_PROTECTED_SESSION_PROOF', 'PROTECTED_ACCESS_DENIED', 'NOT_A_MEMBER'].includes(error.code)) return;
      throw error;
    }
    if (session.profileId !== identity.profileId || session.deviceId !== identity.deviceId) return;
    const request = input => this.fetchJSON(session.base, '/api/v3/migration/runtime-recipient', {
      ...(input !== undefined && { method: 'POST', body: JSON.stringify(input) }),
      fingerprint: session.fingerprint, headers: { Authorization: `Bearer ${session.token}` },
    });
    let status;
    try { status = await request(); }
    catch (error) {
      if (error.status === 404 || error.code === 'PROTECTED_ACCESS_DENIED') return;
      throw error;
    }
    if (status?.publicKey !== '' && !hexID(status?.publicKey, 64)) throw failure('INVALID_API_RESPONSE');
    const agreement = await loadDeviceAgreementKey(this.credentials, serverId, identity.deviceId, status.publicKey === '');
    const publicKey = createPublicKey(agreement).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    if (status.publicKey && status.publicKey !== publicKey) throw failure('INVALID_MIGRATION_RECIPIENT');
    if (!status.publicKey) {
      const intent = { Action: 'recipient.enroll', OperationID: requestID(), PublicKey: publicKey };
      const draft = await request(intent);
      if (draft?.Action !== intent.Action || draft.OperationID !== intent.OperationID || draft.PublicKey !== publicKey ||
          !Number.isSafeInteger(draft.Revision) || draft.Revision < 2 ||
          ![draft.PreviousDigest, draft.ResultDigest, draft.TextProjectionRoot].every(value => hexID(value, 64)) ||
          !hasTextRecipientProjection(draft.TextProjectionVersion) || draft.RoleUpdate !== null || draft.Signature !== null ||
          draft.TextProjectionSeed !== undefined || draft.DeviceChange !== undefined || draft.ResourceChange !== undefined) {
        throw failure('INVALID_POLICY_PREVIEW');
      }
      const actor = { ProfileID: session.profileId, DeviceID: session.deviceId };
      const frame = protectedPolicySignatureFrame(serverId, actor, draft, Buffer.from('null'));
      const signature = sign(null, frame, identity.device);
      const receipt = await request({ ...draft, Signature: signature.toString('base64') });
      if (receipt?.digest !== hash(signature)) throw failure('INVALID_API_RESPONSE');
    }
    const active = { ...connection, ...session, policyTrust: trust };
    const state = await this.readProtectedRuntimeState(active);
    await this.#saveProtectedRuntimeTrust(trust);
    await this.remember(connection);
    return state;
  }
  async openProtectedPendingInviteSession(serverId, cutoverDigest) {
    if (!hexID(serverId, 32) || !hexID(cutoverDigest, 64)) throw failure('INVALID_PROTECTED_CUTOVER');
    return this.#openRuntimeSession(serverId, cutoverDigest, await this.pinnedMembershipTransport(serverId), undefined, true);
  }
  async readProtectedPendingInviteState(connection) {
    if (connection?.pendingInvite !== true) throw failure('INVALID_PROTECTED_SESSION');
    const result = await this.fetchJSON(connection.base, '/api/v3/invites/session/state', {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (result?.profileId !== connection.profileId || result.deviceId !== connection.deviceId || !hexID(result.inviteId, 32) ||
        !Number.isSafeInteger(result.acceptedAt) || result.acceptedAt < 1 || result.keysPending !== true ||
        typeof result.nickname !== 'string' || !result.nickname.length || [...result.nickname].length > 32 ||
        /[\p{Cc}\p{Cs}]/u.test(result.nickname)) throw failure('INVALID_API_RESPONSE');
    return { inviteId: result.inviteId, profileId: result.profileId, deviceId: result.deviceId, acceptedAt: result.acceptedAt,
      nickname: result.nickname, keysPending: true };
  }
  async loadProtectedRuntimeTrust(serverId) {
    if (!hexID(serverId, 32)) throw failure('INVALID_PROTECTED_CUTOVER');
    const raw = await this.credentials.load(protectedRuntimeTrustSlot(serverId), { required: true });
    if (raw == null) return undefined;
    let trust;
    try { trust = JSON.parse(raw); } catch { throw failure('INVALID_PROTECTED_CUTOVER'); }
    if (trust?.serverId !== serverId || ![trust.cutoverDigest, trust.anchorDigest, trust.ownerProfileId, trust.ownerDeviceId]
      .every(value => hexID(value, 64))) throw failure('INVALID_PROTECTED_CUTOVER');
    return trust;
  }
  #bindingRequest(connection, action, input) {
    return this.fetchJSON(connection.base, `/api/v3/devices/bind/${action}`, {
      ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }),
      fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
  }
  #bindingStorage() {
    this.protectedDeviceBindingStorage ??= new ProtectedDeviceBindingStorage(this.credentials);
    return this.protectedDeviceBindingStorage;
  }
  #storedBindingProposal(challenge, deviceId, proposal, agreement) {
    const publicKey = createPublicKey(agreement).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const verified = checkProtectedDeviceBindingApplicant(challenge, challenge, proposal);
    if (verified.deviceId !== deviceId || proposal.agreementKey !== publicKey) throw failure('INVALID_LOCAL_DEVICE_BINDING');
    return proposal;
  }
  async #canonicalBindingProposal(challenge, { deviceId, device }, completed) {
    const agreement = await loadDeviceAgreementKey(this.credentials, challenge.serverId, deviceId, false);
    // Older replies used the canonical key. The receipt must still match
    // that deterministic historical transcript.
    return completed ? this.#storedBindingProposal(challenge, deviceId, completed, agreement) :
      prepareProtectedDeviceBindingApplicant(challenge, challenge, { device, agreement }).proposal;
  }
  async makeProtectedDeviceChallenge(connection) {
    const { serverId, cutoverDigest, profileId, deviceId, address, fingerprint, policyTrust: trust } = connection;
    const challenge = await this.#bindingRequest(connection, 'challenge', {});
    if (challenge?.serverId !== serverId || challenge.cutoverDigest !== cutoverDigest ||
        challenge.profileId !== profileId || challenge.approverDeviceId !== deviceId) throw failure('INVALID_DEVICE_BINDING_CARD');
    return deviceBindingCard('challenge', { address, fingerprint, trust, challenge });
  }
  async #deviceBindingTransport(card) {
    const { address, fingerprint, trust, challenge } = openDeviceBindingCard('challenge', card);
    const saved = await this.loadProtectedRuntimeTrust(trust.serverId);
    if (saved && !isDeepStrictEqual(saved, trust)) throw failure('PROTECTED_CUTOVER_CHANGED');
    if ((await this.records()).some(record => record.serverId === trust.serverId && record.pendingLeave)) throw failure('LEAVE_PENDING');
    const transport = await this.discoverMembership(address, trust.serverId, fingerprint);
    if (transport.config.apiProtocolVersion !== 3) throw failure('PROTECTED_PROTOCOL_DOWNGRADE');
    if (transport.config.cutoverDigest !== trust.cutoverDigest || transport.config.anchorDigest !== trust.anchorDigest) {
      throw failure('PROTECTED_CUTOVER_CHANGED');
    }
    return { transport, trust, challenge };
  }
  async makeProtectedDeviceRequest(card) {
    const { challenge } = await this.#deviceBindingTransport(card);
    const { deviceId, device } = await this.identity();
    const storage = this.#bindingStorage();
    const cardDigest = hash(card);
    return storage.serialize(challenge, deviceId, async () => {
      const pending = await storage.pending(challenge, deviceId, cardDigest);
      if (pending) {
        const agreement = deviceAgreementPrivateKey(pending.agreementSeed);
        const proposal = this.#storedBindingProposal(challenge, deviceId, pending.proposal, agreement);
        return deviceBindingCard('request', { challenge, proposal });
      }
      const completed = await storage.completed(challenge, deviceId, cardDigest);
      if (completed) {
        const agreement = await loadDeviceAgreementKey(this.credentials, challenge.serverId, deviceId, false);
        const proposal = this.#storedBindingProposal(challenge, deviceId, completed, agreement);
        return deviceBindingCard('request', { challenge, proposal });
      }
      const agreementSeed = randomBytes(32).toString('hex');
      const agreement = deviceAgreementPrivateKey(agreementSeed);
      const { proposal } = prepareProtectedDeviceBindingApplicant(challenge, challenge, { device, agreement });
      const request = deviceBindingCard('request', { challenge, proposal });
      await storage.savePending(challenge, deviceId, { cardDigest, agreementSeed, proposal });
      return request;
    });
  }
  previewProtectedDeviceRequest(connection, card) {
    const { challenge, proposal } = openDeviceBindingCard('request', card);
    const { serverId, cutoverDigest, profileId, deviceId } = connection;
    checkProtectedDeviceBindingApplicant({ serverId, cutoverDigest, profileId, approverDeviceId: deviceId }, challenge, proposal);
    return { deviceId: hash(Buffer.from(proposal.signingKey, 'hex')), expiresAt: challenge.expiresAt };
  }
  async approveProtectedDeviceRequest(connection, card) {
    const { challenge, proposal } = openDeviceBindingCard('request', card);
    const { serverId, cutoverDigest, profileId, deviceId: approverDeviceId } = connection;
    const identity = await this.identity();
    const { approverProof } = prepareProtectedDeviceBindingApproval({ serverId, cutoverDigest, profileId, approverDeviceId },
      challenge, proposal, identity.device);
    const { policyHead, nonce, expiresAt, serverAgreementKey } = challenge;
    const receipt = await this.#bindingRequest(connection, 'apply', { ...proposal, policyHead, nonce, expiresAt, serverAgreementKey, approverProof });
    const deviceId = hash(Buffer.from(proposal.signingKey, 'hex'));
    if (receipt?.operationId !== challenge.operationId || receipt.profileId !== profileId || receipt.deviceId !== deviceId ||
        !revisionNumber(receipt.revision) || !hexID(receipt.digest, 64)) throw failure('INVALID_API_RESPONSE');
    connection.profileAvatar = undefined;
    if (connection.config?.protectedProfileAvatar === true) {
      await this.syncProtectedPolicyAttestations(connection).catch(() => {});
      await this.readProtectedProfileAvatar(connection, true).catch(() => {});
    }
    return { deviceId };
  }
  async finishProtectedDeviceBinding(card) {
    const { transport, trust, challenge } = await this.#deviceBindingTransport(card);
    const identity = await this.identity();
    const { deviceId } = identity;
    const storage = this.#bindingStorage();
    const cardDigest = hash(card);
    return storage.serialize(challenge, deviceId, async () => {
      const pending = await storage.pending(challenge, deviceId, cardDigest);
      const completed = await storage.completed(challenge, deviceId, cardDigest);
      const proposed = pending && this.#storedBindingProposal(challenge, deviceId, pending.proposal, deviceAgreementPrivateKey(pending.agreementSeed));
      const session = await this.#openRuntimeSession(trust.serverId, trust.cutoverDigest, transport, transport.config.binding);
      if (session.deviceId !== deviceId) throw failure('INVALID_PROTECTED_SESSION');
      const connection = { ...transport, ...session, policyTrust: trust };
      const response = await this.#bindingRequest(connection, 'result/' + challenge.operationId);
      const usePending = proposed && proposed.agreementKey === response?.agreementKey;
      const proposal = usePending ? proposed : await this.#canonicalBindingProposal(challenge, identity, completed);
      const receipt = verifyProtectedDeviceBindingReceipt(challenge, proposal, response);
      if (session.profileId !== receipt.effectiveProfileId) throw failure('INVALID_PROTECTED_SESSION');
      await this.readProtectedRuntimeState(connection);
      await storage.promote(challenge, receipt, {
        cardDigest, proposal, agreementSeed: usePending ? pending.agreementSeed : undefined, clearPending: !!pending,
      });
      await this.#saveProtectedRuntimeTrust(trust);
      await this.remember(transport);
      return connection;
    });
  }
  #profileLinkRequest(connection, route, input) {
    return this.fetchJSON(connection.base, `/api/v3/profiles/${route}`, {
      ...(input !== undefined && { method: 'POST', body: JSON.stringify(input) }), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
  }
  async #profileLinkParticipant(connection) {
    const { serverId, cutoverDigest, profileId, deviceId } = connection;
    const identity = await this.identity();
    if (identity.deviceId !== deviceId) throw failure('INVALID_PROTECTED_SESSION');
    const expiresAt = Date.now() + 10 * 60_000;
    const frame = signatureFrame('pawtalk-protected-profile-link-participant-v1', serverId, cutoverDigest, profileId, deviceId, String(expiresAt));
    return { profileId, deviceId, expiresAt, proof: sign(null, frame, identity.device).toString('base64url') };
  }
  async makeProtectedProfileParticipant(connection) {
    return makeProfileLinkCard('participant', { serverId: connection.serverId, cutoverDigest: connection.cutoverDigest,
      participant: await this.#profileLinkParticipant(connection) });
  }
  async #profileLinkPreview(connection, counterpart, primary, secondary) {
    const preview = await this.#profileLinkRequest(connection, 'link/preview', { ...counterpart, primaryId: primary.profileId });
    const validRoles = roles => Array.isArray(roles) && roles.every(role => typeof role === 'string' && [...role].length <= 64);
    if (preview?.primaryProfileId !== primary.profileId || preview.secondaryProfileId !== secondary.profileId ||
        !hexID(preview.policyHead, 64) || !Number.isSafeInteger(preview.policyRevision) || preview.policyRevision < 1 ||
        !Number.isSafeInteger(preview.movedDevices) || preview.movedDevices < 1 ||
        !validRoles(preview.primaryRoles) || !validRoles(preview.secondaryRoles)) throw failure('INVALID_API_RESPONSE');
    return preview;
  }
  async prepareProtectedProfileLink(connection, participantCard, primaryIsLocal) {
    const { serverId, cutoverDigest, participant: counterpart } = openProfileLinkCard('participant', participantCard, connection);
    const local = await this.#profileLinkParticipant(connection);
    const [primary, secondary] = primaryIsLocal ? [local, counterpart] : [counterpart, local];
    const preview = await this.#profileLinkPreview(connection, counterpart, primary, secondary);
    const linkCard = makeProfileLinkCard('link', { serverId, cutoverDigest, primary, secondary, policyHead: preview.policyHead,
      operationId: requestID(), expiresAt: Math.min(primary.expiresAt, secondary.expiresAt) });
    return { linkCard, preview };
  }
  #localLinkParticipant(connection, value) {
    const matches = participant => participant.profileId === connection.profileId && participant.deviceId === connection.deviceId;
    if (matches(value.primary)) return { counterpart: value.secondary, primaryIsLocal: true };
    if (matches(value.secondary)) return { counterpart: value.primary, primaryIsLocal: false };
    throw failure('INVALID_PROFILE_LINK_CARD');
  }
  async reviewProtectedProfileLink(connection, linkCard) {
    const value = openProfileLinkCard('link', linkCard, connection);
    const { counterpart, primaryIsLocal } = this.#localLinkParticipant(connection, value);
    if (value.expiresAt <= Date.now()) throw failure('EXPIRED_CHALLENGE');
    const preview = await this.#profileLinkPreview(connection, counterpart, value.primary, value.secondary);
    if (preview.policyHead !== value.policyHead) throw failure('PROTECTED_POLICY_CHANGED');
    return { preview, primaryIsLocal, agreed: Boolean(primaryIsLocal ? value.primaryProof : value.secondaryProof),
      ready: Boolean(value.primaryProof && value.secondaryProof) };
  }
  async signProtectedProfileLink(connection, linkCard) {
    const value = openProfileLinkCard('link', linkCard, connection);
    const { primaryIsLocal } = await this.reviewProtectedProfileLink(connection, linkCard);
    const { device } = await this.identity();
    const proof = signProtectedProfileLinkConsent(connection.policyTrust, linkDraft(value),
      { ProfileID: connection.profileId, DeviceID: connection.deviceId }, device);
    return { linkCard: makeProfileLinkCard('link', { ...value, [primaryIsLocal ? 'primaryProof' : 'secondaryProof']: proof }),
      ready: Boolean(primaryIsLocal ? value.secondaryProof : value.primaryProof) };
  }
  async applyProtectedProfileLink(connection, linkCard) {
    const value = openProfileLinkCard('link', linkCard, connection);
    const { primaryIsLocal } = this.#localLinkParticipant(connection, value);
    if (!primaryIsLocal || !value.primaryProof || !value.secondaryProof) throw failure('INVALID_PROFILE_LINK_CARD');
    const { operationId, policyHead, expiresAt, primaryProof, secondaryProof } = value;
    const receipt = await this.#profileLinkRequest(connection, 'link/apply', { operationId, policyHead, expiresAt, primaryProof, secondaryProof,
      primaryProfileId: value.primary.profileId, primaryDeviceId: value.primary.deviceId,
      secondaryProfileId: value.secondary.profileId, secondaryDeviceId: value.secondary.deviceId });
    if (receipt?.operationId !== operationId || !revisionNumber(receipt.revision) || !hexID(receipt.digest, 64)) throw failure('INVALID_API_RESPONSE');
    return { primaryProfileId: value.primary.profileId };
  }
  async readProtectedProfileLinkStatus(connection) {
    const status = await this.#profileLinkRequest(connection, 'link/status');
    if (status?.profileId !== connection.profileId || !hexID(status.policyHead, 64) || !Array.isArray(status.sources) ||
        status.sources.some((profile, index) => !hexID(profile, 64) || profile === connection.profileId ||
          (index > 0 && profile <= status.sources[index - 1]))) throw failure('INVALID_API_RESPONSE');
    return status;
  }
  async unlinkProtectedProfile(connection, sourceProfileId, policyHead) {
    const { cutoverDigest, profileId, deviceId } = connection;
    const { device } = await this.identity();
    let request = this.#profileUnlinkRequests.get(connection);
    if (request?.sourceProfileId !== sourceProfileId || request.policyHead !== policyHead) {
      const operationId = requestID(), expiresAt = Date.now() + 10 * 60_000;
      const draft = { Action: 'profile.unlink', OperationID: operationId, PreviousDigest: policyHead,
        ResourceChange: { ID: sourceProfileId, ProfileUnlink: { CutoverDigest: cutoverDigest, ExpiresAt: expiresAt } } };
      const deviceProof = signProtectedProfileUnlinkConsent(connection.policyTrust, { ProfileID: profileId, DeviceID: deviceId }, draft, device);
      request = { sourceProfileId, policyHead, operationId, expiresAt, deviceProof };
      this.#profileUnlinkRequests.set(connection, request);
    }
    try {
      const receipt = await this.#profileLinkRequest(connection, 'unlink/apply', request);
      if (receipt?.operationId !== request.operationId || !revisionNumber(receipt.revision) || !hexID(receipt.digest, 64)) throw failure('INVALID_API_RESPONSE');
      return { sourceProfileId };
    } catch (error) {
      if (error?.code === 'EXPIRED_CHALLENGE' && this.#profileUnlinkRequests.get(connection) === request) {
        this.#profileUnlinkRequests.delete(connection);
      }
      throw error;
    }
  }
  prepareRecoveryBundle(connection, code = createMigrationRecoveryCode()) {
    const { address, fingerprint, policyTrust: trust, profileId } = connection;
    return createRecoveryBundle({ address, fingerprint, trust, profileId, code }, this.allowLoopback);
  }
  async exportRegisteredRecoveryBundle(connection, code) {
    const { serverId, profileId } = connection;
    const bundle = this.prepareRecoveryBundle(connection, code);
    const recovery = deriveRecoveryIdentity(code, serverId, profileId);
    const coverage = await this.readProtectedRecoveryCoverage(connection);
    if (coverage.recoveryId !== recovery.recoveryId) throw failure('INVALID_RECOVERY_BUNDLE');
    return bundle;
  }
  async confirmRecoveryBundle(connection, recoveryBundle, replace = false) {
    const { profileId, trust, code } = openRecoveryBundle(recoveryBundle, this.allowLoopback);
    if (!isDeepStrictEqual(trust, connection.policyTrust) || profileId !== connection.profileId) throw failure('RECOVERY_KIT_PROFILE_MISMATCH');
    const recovery = deriveRecoveryIdentity(code, trust.serverId, profileId);
    const coverage = await this.readProtectedRecoveryCoverage(connection);
    if (coverage.recoveryId !== recovery.recoveryId) {
      if (coverage.recoveryId && !replace) throw failure('RECOVERY_REPLACEMENT_CONFIRMATION_REQUIRED');
      await this.enrollProtectedRuntimeRecovery(connection, code, coverage.policyHead);
    }
    await this.serviceProtectedRuntimeRotations(connection);
    await this.confirmProtectedRuntimeRecovery(connection, code);
    this.#rememberRecoveryKey(connection, recovery);
    return { ready: true };
  }
  #rememberRecoveryKey(connection, recovery) {
    this.#recoveredDeviceKeys.set(connection.serverId, {
      cutoverDigest: connection.cutoverDigest, profileId: connection.profileId, deviceId: connection.deviceId,
      recoveryId: recovery.recoveryId, agreement: recovery.agreement, agreementKey: recovery.agreementKey,
    });
  }
  #recoveredDeviceKey(connection) {
    const recovery = this.#recoveredDeviceKeys.get(connection.serverId);
    return recovery && recovery.cutoverDigest === connection.cutoverDigest && recovery.profileId === connection.profileId &&
      recovery.deviceId === connection.deviceId ? recovery : undefined;
  }
  async #readScopeAuthority(connection, trust, through) {
    if (!Number.isSafeInteger(through) || through < 1) throw failure('INVALID_SCOPE_AUTHORITY');
    this.scopeAuthorityChecks ??= new Map();
    const pending = this.scopeAuthorityChecks;
    const key = [trust.serverId, trust.cutoverDigest, trust.anchorDigest, trust.ownerProfileId, trust.ownerDeviceId, through].join(':');
    if (pending.has(key)) return pending.get(key);
    const read = this.#fetchScopeAuthority(connection, trust, through).catch(error => {
      if (pending.get(key) === read) pending.delete(key);
      throw error;
    });
    pending.set(key, read);
    if (pending.size > 16) pending.delete(pending.keys().next().value);
    return read;
  }
  async #fetchScopeAuthority(connection, trust, through) {
    let state, head, genesisDeviceKey;
    const prefixes = new Map();
    const recordAuthority = ({ sequence, revision, digest, deviceId, deviceKey, ownerProfileId, ownershipTransferred, signerMoved }) => {
      prefixes.set(digest, { sequence, revision, digest, deviceId, deviceKey, ownerProfileId, ownershipTransferred, signerMoved });
    };
    for (;;) {
      const after = state?.sequence ?? 0;
      const response = await this.fetchJSON(connection.base, `/api/v3/policy/scope-authority?through=${through}&after=${after}`, {
        fingerprint: connection.fingerprint,
      });
      if (!hexID(response?.genesisDeviceKey, 64) || !hexID(response.headDigest, 64) ||
          !Number.isSafeInteger(response.headSequence) || response.headSequence < after || response.headSequence > through ||
          !Array.isArray(response.links) || response.links.length !== Math.min(32, response.headSequence - after)) {
        throw failure('INVALID_SCOPE_AUTHORITY');
      }
      if (!state) {
        genesisDeviceKey = response.genesisDeviceKey;
        state = scopeAuthorityGenesis(trust, genesisDeviceKey);
        recordAuthority(state);
        head = { sequence: response.headSequence, digest: response.headDigest };
      }
      if (response.genesisDeviceKey !== genesisDeviceKey || response.headSequence !== head.sequence || response.headDigest !== head.digest) {
        throw failure('POLICY_FORK');
      }
      for (const link of response.links) {
        state = advanceScopeAuthority(trust, state, link);
        if (state.revision > through) throw failure('INVALID_SCOPE_AUTHORITY');
        recordAuthority(state);
      }
      if (state.sequence === head.sequence) {
        if (state.digest !== head.digest) throw failure('POLICY_FORK');
        return { state, prefixes };
      }
    }
  }
  #ownershipRequest(connection, action, method = 'GET', input) {
    return this.fetchJSON(connection.base, `/api/v3/ownership/${action}`, {
      method, fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
      ...(input !== undefined && { body: JSON.stringify(input) }),
    });
  }
  async #loadOwnershipFloor(connection) {
    const trust = connection.policyTrust;
    if (!trust || connection.ownership || connection.ownershipFloorLoaded) return;
    const raw = await this.credentials.load(ownershipSlot(trust), { required: true });
    if (raw == null) {
      connection.ownershipFloorLoaded = true;
      return;
    }
    if (connection.ownership) return;
    let saved;
    try { saved = JSON.parse(raw); } catch { throw failure('INVALID_SCOPE_AUTHORITY'); }
    if (!(saved?.transferred === true || saved?.signerMoved === true) || !revisionNumber(saved.revision) ||
        ![saved.ownerProfileId, saved.signerDeviceId, saved.authorityHead].every(value => hexID(value, 64))) {
      throw failure('INVALID_SCOPE_AUTHORITY');
    }
    connection.ownership = saved;
  }
  async #verifyOwnershipStatus(connection, observed) {
    const trust = connection.policyTrust;
    const actual = observed ?? await this.#ownershipRequest(connection, 'status');
    if (trust?.serverId !== connection.serverId || !Number.isSafeInteger(actual?.revision) || actual.revision < 1 ||
        !hexID(actual.ownerProfileId, 64)) throw failure('INVALID_SCOPE_AUTHORITY');
    await this.#loadOwnershipFloor(connection);
    const { state, prefixes } = await this.#readScopeAuthority(connection, trust, actual.revision);
    const previous = connection.ownership;
    if (previous && actual.revision < previous.revision) throw failure('POLICY_ROLLBACK');
    const ownerProfileId = state.ownerProfileId ?? trust.ownerProfileId;
    if (actual.ownerProfileId !== ownerProfileId ||
        (actual.authorityHead !== undefined && actual.authorityHead !== state.digest) ||
        (actual.signerDeviceId !== undefined && actual.signerDeviceId !== hash(Buffer.from(state.deviceKey, 'hex'))) ||
        (previous && !prefixes.has(previous.authorityHead))) throw failure('POLICY_FORK');
    const verified = { revision: actual.revision, ownerProfileId, authorityHead: state.digest,
      signerDeviceId: hash(Buffer.from(state.deviceKey, 'hex')), transferred: state.ownershipTransferred === true,
      ...(state.signerMoved && { signerMoved: true }) };
    connection.ownership = verified;
    if ((verified.transferred || verified.signerMoved) && previous?.authorityHead !== verified.authorityHead) {
      await this.credentials.save(ownershipSlot(trust), JSON.stringify(verified));
    }
    return { ...verified, authority: state };
  }
  async readProtectedOwnershipOffer(connection) {
    const status = await this.#verifyOwnershipStatus(connection);
    const offer = await this.#ownershipRequest(connection, 'offer');
    if (offer === null) return { ...status, offer: null };
    if (!hexID(offer?.operationId, 32) || !hexID(offer.targetProfileId, 64) || offer.ownerProfileId !== status.ownerProfileId ||
        !Number.isSafeInteger(offer.expiresAt) || offer.headRevision < 1 ||
        (connection.profileId !== offer.targetProfileId && connection.profileId !== offer.ownerProfileId)) {
      throw failure('INVALID_SCOPE_AUTHORITY');
    }
    return { ...status, offer };
  }
  async offerProtectedOwnership(connection, targetProfileId) {
    if (!hexID(targetProfileId, 64)) throw failure('INVALID_INPUT');
    const trust = connection.policyTrust;
    const status = await this.#verifyOwnershipStatus(connection);
    const identity = await this.identity();
    if (identity.deviceId !== connection.deviceId || identity.deviceId !== status.signerDeviceId ||
        connection.profileId !== status.ownerProfileId) throw failure('PROTECTED_ACCESS_DENIED');
    const preview = await this.#ownershipRequest(connection, 'preview', 'POST', { targetProfileId });
    const verified = await this.readProtectedOwnerPolicy(connection);
    if (preview?.targetProfileId !== targetProfileId || verified.revision !== preview.headRevision ||
        verified.digest !== preview.policyHead) throw failure('PROTECTED_POLICY_CHANGED');
    const { state } = await this.#readScopeAuthority(connection, trust, verified.revision);
    const offer = buildScopeOwnerTransferOffer(trust, state, preview, verified.snapshot, identity.device);
    const receipt = await this.#ownershipRequest(connection, 'offer', 'POST', offer);
    if (!isDeepStrictEqual(receipt, offer)) throw failure('INVALID_API_RESPONSE');
    return receipt;
  }
  async acceptProtectedOwnership(connection, operationId) {
    if (!hexID(operationId, 32)) throw failure('INVALID_INPUT');
    const trust = connection.policyTrust;
    const identity = await this.identity();
    if (identity.deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
    this.ownershipAcceptances ??= new Map();
    const attempts = this.ownershipAcceptances;
    const key = [connection.serverId, connection.cutoverDigest, connection.profileId, connection.deviceId, operationId].join(':');
    let link = attempts.get(key);
    if (!link) {
      const { offer } = await this.readProtectedOwnershipOffer(connection);
      if (offer?.operationId !== operationId || offer.targetProfileId !== connection.profileId) throw failure('PROTECTED_POLICY_CHANGED');
      const { state } = await this.#readScopeAuthority(connection, trust, offer.headRevision);
      link = acceptScopeOwnerTransferOffer(trust, state, offer, identity.device);
      attempts.set(key, link);
      if (attempts.size > 16) attempts.delete(attempts.keys().next().value);
    }
    let receipt;
    try { receipt = await this.#ownershipRequest(connection, 'accept', 'POST', { operationId, deviceProof: link.deviceProof }); }
    catch (error) {
      if (['PROTECTED_POLICY_CHANGED', 'PROTECTED_OWNER_TRANSFER_UNAVAILABLE', 'INVALID_SCOPE_AUTHORITY'].includes(error.code)) {
        attempts.delete(key);
      }
      throw error;
    }
    if (receipt?.operationId !== operationId || receipt.ownerProfileId !== connection.profileId ||
        receipt.revision !== link.revision || !hexID(receipt.digest, 64)) throw failure('INVALID_API_RESPONSE');
    const status = await this.#verifyOwnershipStatus(connection);
    if (status.ownerProfileId !== connection.profileId || status.revision < receipt.revision) throw failure('POLICY_FORK');
    await this.refreshProtectedRuntimePolicy(connection, trust);
    attempts.delete(key);
    return receipt;
  }
  async cancelProtectedOwnership(connection, operationId) {
    if (!hexID(operationId, 32)) throw failure('INVALID_INPUT');
    const receipt = await this.#ownershipRequest(connection, 'cancel', 'POST', { operationId });
    if (receipt?.ok !== true) throw failure('INVALID_API_RESPONSE');
    return true;
  }
  async readProtectedScopeDeviceStatus(connection) {
    const status = await this.#verifyOwnershipStatus(connection);
    const { ownerProfileId, signerDeviceId } = status;
    const localDeviceId = connection.deviceId;
    const canOffer = connection.profileId === ownerProfileId && localDeviceId === signerDeviceId;
    let candidates = [];
    if (canOffer) {
      const policy = await this.readProtectedOwnerPolicy(connection);
      if (policy.revision !== status.revision) throw failure('PROTECTED_POLICY_CHANGED');
      candidates = Object.entries(policy.snapshot.PolicyDevices ?? {}).flatMap(([deviceId, entry]) => {
        if (entry.Revoked || entry.ProfileID !== ownerProfileId || deviceId === signerDeviceId) return [];
        const originProfileId = policy.snapshot.ProfileDeviceOrigins?.[deviceId];
        return [{ deviceId, ...(originProfileId && { originProfileId }) }];
      }).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    }
    return { ownerProfileId, signerDeviceId, localDeviceId, canOffer, candidates };
  }
  async offerProtectedScopeDevice(connection, targetDeviceId) {
    const { policyTrust: trust, deviceId, profileId } = connection;
    const status = await this.#verifyOwnershipStatus(connection);
    if (profileId !== status.ownerProfileId || deviceId !== status.signerDeviceId) throw failure('PROTECTED_ACCESS_DENIED');
    const policy = await this.readProtectedOwnerPolicy(connection);
    if (policy.revision !== status.revision) throw failure('PROTECTED_POLICY_CHANGED');
    const target = policy.snapshot.PolicyDevices?.[targetDeviceId];
    if (!hexID(targetDeviceId, 64) || targetDeviceId === deviceId || target?.ProfileID !== profileId || target.Revoked ||
        !hexID(target.PublicKey, 64) || hash(Buffer.from(target.PublicKey, 'hex')) !== targetDeviceId) throw failure('PROTECTED_ACCESS_DENIED');
    const { device } = await this.identity();
    const recovery = policy.snapshot.RecoveryIdentities?.[profileId];
    const expiresAt = Date.now() + 10 * 60_000;
    const offer = buildScopeDeviceHandoverOffer(trust, status.authority, { revision: policy.revision + 1, policyHead: policy.digest,
      operationId: requestID(), deviceKey: target.PublicKey, expiresAt,
      ...(recovery && { recoveryId: recovery.ID, recoveryKey: recovery.SigningKey }) }, device);
    return { offerCard: scopeDeviceCardPrefix + Buffer.from(JSON.stringify(offer)).toString('base64url'), expiresAt };
  }
  #scopeDeviceCard(card, connection) {
    if (typeof card !== 'string' || card.length > 4096 || !card.startsWith(scopeDeviceCardPrefix)) throw failure('INVALID_SCOPE_DEVICE_CARD');
    try {
      const raw = card.slice(scopeDeviceCardPrefix.length);
      const payload = Buffer.from(raw, 'base64url');
      if (payload.toString('base64url') !== raw) throw failure('INVALID_SCOPE_DEVICE_CARD');
      const offer = JSON.parse(payload.toString('utf8'));
      if (!revisionNumber(offer.revision) || !hexID(offer.deviceKey, 64) ||
          hash(Buffer.from(offer.deviceKey, 'hex')) !== connection.deviceId || offer.deviceProof !== undefined) throw failure('INVALID_SCOPE_DEVICE_CARD');
      return offer;
    } catch { throw failure('INVALID_SCOPE_DEVICE_CARD'); }
  }
  async #checkCurrentScopeDeviceOffer(connection, offer, status) {
    if (offer.expiresAt <= Date.now()) throw failure('EXPIRED_CHALLENGE');
    if (status.signerDeviceId !== offer.sourceDeviceId || status.revision + 1 !== offer.revision) throw failure('PROTECTED_POLICY_CHANGED');
    verifyScopeDeviceHandoverOffer(connection.policyTrust, status.authority, offer);
    const policy = await this.readProtectedOwnerPolicy(connection);
    const recovery = policy.snapshot.RecoveryIdentities?.[connection.profileId];
    if (policy.revision + 1 !== offer.revision || policy.digest !== offer.policyHead) throw failure('PROTECTED_POLICY_CHANGED');
    if ((offer.recoveryId ?? '') !== (recovery?.ID ?? '') || (offer.recoveryKey ?? '') !== (recovery?.SigningKey ?? '')) {
      throw failure('INVALID_SCOPE_AUTHORITY');
    }
  }
  async previewProtectedScopeDevice(connection, card) {
    const offer = this.#scopeDeviceCard(card, connection);
    const status = await this.#verifyOwnershipStatus(connection);
    if (connection.profileId !== status.ownerProfileId) throw failure('PROTECTED_ACCESS_DENIED');
    await this.#checkCurrentScopeDeviceOffer(connection, offer, status);
    return { signerDeviceId: offer.sourceDeviceId, targetDeviceId: connection.deviceId, expiresAt: offer.expiresAt };
  }
  async acceptProtectedScopeDevice(connection, card) {
    const offer = this.#scopeDeviceCard(card, connection);
    const { policyTrust: trust, profileId, deviceId } = connection;
    const status = await this.#verifyOwnershipStatus(connection);
    if (profileId !== status.ownerProfileId) throw failure('PROTECTED_ACCESS_DENIED');
    const { device } = await this.identity();
    let previous = status.authority;
    if (status.revision < offer.revision) {
      await this.#checkCurrentScopeDeviceOffer(connection, offer, status);
    } else {
      ({ state: previous } = await this.#readScopeAuthority(connection, trust, offer.revision - 1));
    }
    const link = acceptScopeDeviceHandoverOffer(trust, previous, offer, device);
    const next = advanceScopeAuthority(trust, previous, link);
    if (status.revision >= offer.revision) {
      const { state } = await this.#readScopeAuthority(connection, trust, offer.revision);
      if (state.digest !== next.digest) throw failure('PROTECTED_POLICY_CHANGED');
    }
    const receipt = await this.fetchJSON(connection.base, '/api/v3/policy/scope-authority/device', {
      method: 'POST', body: JSON.stringify(link), fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (receipt?.operationId !== offer.operationId || receipt.revision !== link.revision || !hexID(receipt.digest, 64)) {
      throw failure('INVALID_API_RESPONSE');
    }
    const verified = await this.#verifyOwnershipStatus(connection);
    if (verified.revision < receipt.revision || !verified.signerMoved) throw failure('POLICY_FORK');
    const { state } = await this.#readScopeAuthority(connection, trust, receipt.revision);
    if (state.digest !== next.digest || hash(Buffer.from(state.deviceKey, 'hex')) !== deviceId) throw failure('POLICY_FORK');
    await this.refreshProtectedRuntimePolicy(connection, trust);
    if (verified.signerDeviceId === deviceId) await this.syncProtectedPolicyAttestations(connection);
    return { signerDeviceId: verified.signerDeviceId };
  }
  recoverProtectedDeviceFromBundle(bundle) {
    const { code, ...context } = openRecoveryBundle(bundle, this.allowLoopback);
    return this.recoverProtectedDevice(context, code);
  }
  async recoverProtectedDevice({ address, fingerprint, trust, profileId }, code) {
    if (typeof address !== 'string' || address.length > 2048 || address.includes('#') || !hexID(fingerprint, 64) ||
        !hexID(profileId, 64) || !hexID(trust?.serverId, 32) ||
        ![trust.cutoverDigest, trust.anchorDigest, trust.ownerProfileId, trust.ownerDeviceId].every(value => hexID(value, 64))) {
      throw failure('INVALID_RECOVERY_DEVICE');
    }
    const { serverId, cutoverDigest, anchorDigest } = trust;
    const previousTrust = await this.loadProtectedRuntimeTrust(serverId);
    if (previousTrust && !isDeepStrictEqual(previousTrust, trust)) throw failure('PROTECTED_CUTOVER_CHANGED');
    if ((await this.records()).some(record => record.serverId === serverId && record.pendingLeave)) throw failure('LEAVE_PENDING');
    this.recoveryDeviceOperations ??= new Map();
    const running = this.recoveryDeviceOperations;
    if (running.has(serverId)) throw failure('RECOVERY_DEVICE_IN_PROGRESS');
    const operation = this.#recoverProtectedDevice({ address, fingerprint, trust, profileId, serverId, cutoverDigest, anchorDigest }, code);
    running.set(serverId, operation);
    try { return await operation; }
    finally { running.delete(serverId); }
  }
  async #recoverProtectedDevice(expected, code) {
    const { address, fingerprint, trust, profileId, serverId, cutoverDigest, anchorDigest } = expected;
    const transport = await this.discoverMembership(address.trim(), serverId, fingerprint);
    const { config } = transport;
    if (config.apiProtocolVersion !== 3) throw failure('PROTECTED_PROTOCOL_DOWNGRADE');
    if (config.cutoverDigest !== cutoverDigest || config.anchorDigest !== anchorDigest) throw failure('PROTECTED_CUTOVER_CHANGED');
    const recovery = deriveRecoveryIdentity(code, serverId, profileId);
    const { deviceId, device } = await this.identity();
    const agreement = await loadDeviceAgreementKey(this.credentials, serverId, deviceId);
    const post = (action, input) => this.fetchJSON(transport.base, `/api/v3/recovery/${action}`, {
      method: 'POST', body: JSON.stringify(input), fingerprint,
    });
    const slot = `pawtalk:recovery-device:v1:${serverId}:${cutoverDigest}:${profileId}:${deviceId}`;
    const saved = await this.credentials.load(slot, { required: true });
    let proposal;
    if (saved != null) {
      try { proposal = JSON.parse(saved); } catch { throw failure('INVALID_RECOVERY_DEVICE'); }
      const publicHex = key => createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
      if (proposal?.profileId !== profileId || proposal.signingKey !== publicHex(device) || proposal.agreementKey !== publicHex(agreement)) {
        throw failure('INVALID_RECOVERY_DEVICE');
      }
    }
    if (proposal?.recoveryId !== recovery.recoveryId) {
      const challenge = await post('device-challenge', { profileId, deviceId, recoveryId: recovery.recoveryId });
      ({ proposal } = prepareProtectedRecoveryDevice(expected, challenge, requestID(), recovery, { device, agreement }));
      if (challenge.policyRevision !== undefined) {
        const { state } = await this.#readScopeAuthority(transport, trust, challenge.policyRevision);
        if (state.sequence && profileId === (state.ownerProfileId ?? trust.ownerProfileId)) {
          proposal.scopeAuthority = signScopeAuthorityLink(trust, state, {
            action: 'recovery.device', revision: challenge.policyRevision + 1, policyHead: proposal.policyHead,
            operationId: proposal.operationId, recoveryId: recovery.recoveryId, recoveryKey: recovery.signingKey,
            deviceKey: proposal.signingKey,
          }, recovery.signing, device);
        }
      }
      // Store only the public proposal so a restart after a lost receipt uses
      // the same operation and cannot register a second replacement device.
      await this.credentials.save(slot, JSON.stringify(proposal));
    }
    let receipt;
    try {
      receipt = await post('device', proposal);
    } catch (error) {
      if (['RECOVERY_DEVICE_CHANGED', 'EXPIRED_CHALLENGE', 'INVALID_RECOVERY_DEVICE_PROOF'].includes(error.code)) {
        await this.credentials.save(slot, null);
      }
      throw error;
    }
    if (receipt?.operationId !== proposal.operationId || receipt.recoveryId !== recovery.recoveryId ||
        !revisionNumber(receipt.revision) || !hexID(receipt.digest, 64)) throw failure('INVALID_API_RESPONSE');
    const session = await this.#openRuntimeSession(serverId, cutoverDigest, transport, config.binding);
    if (session.profileId !== profileId || session.deviceId !== deviceId) throw failure('INVALID_PROTECTED_SESSION');
    const connection = { ...transport, ...session, policyTrust: trust };
    if (proposal.scopeAuthority || profileId === trust.ownerProfileId) await this.#verifyOwnershipStatus(connection);
    if (isProtectedOwner(connection)) await this.refreshProtectedRuntimePolicy(connection, trust);
    await this.#saveProtectedRuntimeTrust(trust);
    await this.remember(transport);
    await this.credentials.save(slot, null);
    this.#rememberRecoveryKey(connection, recovery);
    return connection;
  }
  async enrollProtectedRuntimeRecovery(connection, code, policyHead) {
    const trust = connection?.policyTrust;
    const identity = await this.identity();
    if (!trust || trust.serverId !== connection.serverId || trust.cutoverDigest !== connection.cutoverDigest ||
        identity.deviceId !== connection.deviceId || !hexID(connection.fingerprint, 64) || !connection.base?.startsWith('https:') ||
        typeof connection.token !== 'string') throw failure('INVALID_PROTECTED_SESSION');
    const slot = [connection.serverId, connection.cutoverDigest, connection.profileId, connection.deviceId].join(':');
    this.protectedRecoveryAttempts ??= new Map();
    const attempts = this.protectedRecoveryAttempts;
    const headers = { Authorization: `Bearer ${connection.token}` };
    const post = (action, input) => this.fetchJSON(connection.base, `/api/v3/recovery/${action}`, {
      method: 'POST', body: JSON.stringify(input), fingerprint: connection.fingerprint, headers,
    });
    let prepared = attempts.get(slot);
    if (prepared && prepared.claims.RecoveryID !== deriveRecoveryIdentity(code, connection.serverId, connection.profileId).recoveryId) {
      prepared = undefined;
    }
    if (!prepared) {
      const challenge = await post('challenge', {});
      if (policyHead !== undefined && challenge?.policyHead !== policyHead) throw failure('PROTECTED_POLICY_CHANGED');
      prepared = prepareProtectedRecoveryEnrollment(connection, challenge, requestID(), code, identity);
      if (isProtectedOwner(connection) && challenge.policyRevision !== undefined) {
        const { state } = await this.#readScopeAuthority(connection, trust, challenge.policyRevision);
        prepared.proposal.scopeAuthority = signScopeAuthorityLink(trust, state, {
          action: 'recovery.authorize', revision: challenge.policyRevision + 1, policyHead: prepared.proposal.policyHead,
          operationId: prepared.proposal.operationId, recoveryId: prepared.claims.RecoveryID,
          recoveryKey: prepared.claims.SigningKey, deviceKey: state.deviceKey,
        }, identity.device);
      }
      attempts.delete(slot);
      attempts.set(slot, prepared);
      if (attempts.size > 16) attempts.delete(attempts.keys().next().value);
    }
    const release = () => { if (attempts.get(slot) === prepared) attempts.delete(slot); };
    let receipt;
    try {
      receipt = await post('enroll', prepared.proposal);
    } catch (error) {
      // The accepted operation may have lost its response. Re-send the exact
      // public proposal on retry. The user's code is never retained here.
      if (!isConnectionFailure(error) && error.code !== 'INVALID_API_RESPONSE') release();
      throw error;
    }
    if (receipt?.operationId !== prepared.proposal.operationId || receipt.recoveryId !== prepared.claims.RecoveryID ||
        !revisionNumber(receipt.revision) || !hexID(receipt.digest, 64)) throw failure('INVALID_API_RESPONSE');
    release();
    return { recoveryId: receipt.recoveryId, revision: receipt.revision, digest: receipt.digest, ready: false };
  }
  async listProtectedOwnDevices(connection) {
    const result = await this.fetchJSON(connection.base, '/api/v3/devices/self', {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    const ids = result?.deviceIds;
    if (!Array.isArray(ids) || ids.length > 8192 || !ids.every(id => hexID(id, 64)) ||
        new Set(ids).size !== ids.length || !ids.includes(connection.deviceId)) throw failure('INVALID_API_RESPONSE');
    return ids;
  }
  async revokeProtectedOwnDevice(connection, deviceId) {
    if (connection.config?.protectedDeviceRevocation !== true) throw failure('UNSUPPORTED_FEATURE');
    if (!hexID(deviceId, 64) || deviceId === connection.deviceId) throw failure('INVALID_INPUT');
    const trust = connection.policyTrust;
    const policy = await this.readProtectedManagementPolicy(connection);
    const target = policy.snapshot.PolicyDevices?.[deviceId];
    if (!target || target.Revoked || target.ProfileID !== connection.profileId) throw failure('PROTECTED_ACCESS_DENIED');
    if (policy.snapshot.Owner === connection.profileId) {
      const { signerDeviceId } = await this.#verifyOwnershipStatus(connection);
      if (deviceId === signerDeviceId) throw failure('PROTECTED_REVOKE_SCOPE_SIGNER');
    }
    const intent = { Action: 'device.revoke', OperationID: requestID(), DeviceChange: { DeviceID: deviceId } };
    const preview = await this.previewProtectedRuntimePolicy(connection, intent, trust);
    await this.commitProtectedRuntimePolicy(connection, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, trust);
    return { deviceId };
  }
  async readProtectedRecoveryCoverage(connection) {
    const coverage = await this.fetchJSON(connection.base, '/api/v3/recovery/coverage', {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!hexID(coverage?.policyHead, 64) || !(coverage.recoveryId === '' || hexID(coverage.recoveryId, 64)) ||
        !Array.isArray(coverage.items) || coverage.items.length > 2048 ||
        (!coverage.recoveryId && coverage.items.length !== 0)) throw failure('INVALID_API_RESPONSE');
    const seen = new Set();
    for (const item of coverage.items) {
      if (!hexID(item?.channelId, 32) || !['live', 'archive'].includes(item.purpose) ||
          !Number.isSafeInteger(item.generation) || item.generation < 0 || typeof item.pending !== 'boolean' ||
          (item.pending ? item.epochDigest !== '' || item.packageDigest !== '' :
            !item.generation || !hexID(item.epochDigest, 64) || !hexID(item.packageDigest, 64))) {
        throw failure('INVALID_API_RESPONSE');
      }
      const key = item.channelId + item.purpose;
      if (seen.has(key)) throw failure('INVALID_API_RESPONSE');
      seen.add(key);
    }
    return coverage;
  }
  async proveProtectedRecoveryPackageOpening(connection, code, coverage, item, { nonce, expiresAt }) {
    if (!hexID(item?.channelId, 32) || !['live', 'archive'].includes(item.purpose) || item.pending !== false ||
        !Array.isArray(coverage?.items) || !coverage.items.some(entry => isDeepStrictEqual(entry, item))) {
      throw failure('INVALID_PROTECTED_RECOVERY');
    }
    const { deviceId } = await this.identity();
    const recovery = deriveRecoveryIdentity(code, connection.serverId, connection.profileId);
    const state = await this.#recoveryOpeningContext(connection, deviceId, recovery, coverage);
    return this.#proveProtectedRecoveryPackageOpening(connection, coverage, item, { nonce, expiresAt }, state);
  }
  async #recoveryOpeningContext(connection, deviceId, recovery, coverage, retry) {
    const trust = connection.policyTrust;
    if (deviceId !== connection.deviceId || trust?.serverId !== connection.serverId ||
        trust.cutoverDigest !== connection.cutoverDigest || recovery.recoveryId !== coverage?.recoveryId) {
      throw failure('INVALID_PROTECTED_RECOVERY');
    }
    const current = await this.readProtectedPolicyAttestation(connection);
    if (current.digest !== coverage.policyHead) throw failure('PROTECTED_POLICY_CHANGED');
    const scope = this.#scopedEpochVerifier(connection, current, retry);
    return { recovery, current, scope };
  }
  async #proveProtectedRecoveryPackageOpening(connection, coverage, item, { nonce, expiresAt }, { recovery, current, scope }) {
    if (!hexID(nonce, 64) || !Number.isSafeInteger(expiresAt)) throw failure('INVALID_PROTECTED_RECOVERY');
    const { deviceId, policyTrust: trust } = connection;
    const delivery = await this.fetchJSON(connection.base, `/api/v3/recovery/packages/${item.channelId}/${item.purpose}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    const epoch = delivery?.Epoch;
    const record = epoch?.Record;
    if (record?.ChannelID !== item.channelId || record.Purpose !== item.purpose || record.Generation !== item.generation ||
        typeof record.Signature !== 'string' || typeof delivery.Package?.Ciphertext !== 'string') {
      throw failure('INVALID_PROTECTED_RECOVERY');
    }
    const context = { ...packageContext(connection.serverId, record, recovery.recoveryId, recovery.agreementKey),
      cutoverDigest: connection.cutoverDigest, profileId: connection.profileId, deviceId, policyHead: coverage.policyHead };
    const recipient = { ...context, kind: 'recovery' };
    const admitted = verifyAttestedTextAdmission(current, item.channelId, delivery.textPolicy, recipient);
    if (item.purpose === 'live' && !admitted.archive && record.Revision !== current.revision) {
      const started = verifyAttestedTextAdmission(await scope.attest(record.Revision), item.channelId, delivery.admissionPolicy, recipient);
      if (started.firstPosition !== admitted.firstPosition) throw failure('UNVERIFIED_EPOCH_RECIPIENT');
    }
    if (hash(Buffer.from(record.Signature, 'base64')) !== item.epochDigest ||
        hash(Buffer.from(delivery.Package.Ciphertext, 'base64')) !== item.packageDigest) {
      throw failure('INVALID_PROTECTED_RECOVERY');
    }
    const signer = await scope.signer(epoch);
    await this.epochCheckpoint().run(trust, item.channelId, item.purpose,
      continuity => continuity.accept(epoch, scope.verify, scope.fetchProofs));
    const challenge = { serverId: connection.serverId, cutoverDigest: connection.cutoverDigest, profileId: connection.profileId,
      deviceId, recoveryId: recovery.recoveryId, policyHead: coverage.policyHead, channelId: item.channelId, purpose: item.purpose,
      generation: item.generation, epochDigest: item.epochDigest, packageDigest: item.packageDigest, nonce, expiresAt };
    return proveSignedRecoveryEpochOpening(delivery, context, recovery.agreement, signer, challenge, recovery.signing);
  }
  async confirmProtectedRuntimeRecovery(connection, code) {
    const identity = await this.identity();
    const { serverId, cutoverDigest, profileId, deviceId, policyTrust: trust } = connection;
    if (trust?.serverId !== serverId || trust.cutoverDigest !== cutoverDigest ||
        identity.deviceId !== deviceId || !hexID(connection.fingerprint, 64) || !connection.base?.startsWith('https:') ||
        typeof connection.token !== 'string') throw failure('INVALID_PROTECTED_SESSION');
    const recovery = deriveRecoveryIdentity(code, serverId, profileId);
    const slot = [serverId, cutoverDigest, profileId, deviceId, recovery.recoveryId].join(':');
    this.protectedRecoveryConfirmAttempts ??= new Map();
    const attempts = this.protectedRecoveryConfirmAttempts;
    const headers = { Authorization: `Bearer ${connection.token}` };
    const deadline = Date.now() + 3_600_000;
    const retry = async operation => {
      for (;;) {
        try { return await operation(); }
        catch (error) {
          if (error.code !== 'RATE_LIMIT') throw error;
          const wait = Number.isInteger(error.retryAfter) && error.retryAfter >= 1 && error.retryAfter <= 60 ? error.retryAfter : 60;
          if (Date.now() + wait * 1000 >= deadline) throw error;
          await delay(wait * 1000);
        }
      }
    };
    const post = (action, input) => retry(() => this.fetchJSON(connection.base, `/api/v3/recovery/${action}`, {
      method: 'POST', body: JSON.stringify(input), fingerprint: connection.fingerprint, headers,
    }));
    let prepared = attempts.get(slot);
    if (!prepared) {
      const coverage = await retry(() => this.readProtectedRecoveryCoverage(connection));
      if (coverage.items.some(item => item.pending)) throw failure('PROTECTED_RECOVERY_PENDING');
      if (coverage.items.length > 2000) throw failure('INVALID_API_RESPONSE');
      const state = await retry(() => this.#recoveryOpeningContext(connection, deviceId, recovery, coverage, retry));
      const challenge = await post('confirmation-challenge', {});
      if (challenge?.serverId !== serverId || challenge.cutoverDigest !== cutoverDigest || challenge.profileId !== profileId ||
          challenge.deviceId !== deviceId || challenge.recoveryId !== recovery.recoveryId ||
          challenge.policyHead !== coverage.policyHead || !hexID(challenge.nonce, 64) ||
          !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= 0 || challenge.expiresAt > 8_640_000_000_000_000 ||
          typeof challenge.challengeToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge.challengeToken) ||
          Buffer.from(challenge.challengeToken, 'base64url').toString('base64url') !== challenge.challengeToken) {
        throw failure('PROTECTED_POLICY_CHANGED');
      }
      const items = [];
      // Keep the requests sequential so a large room uses the ordinary
      // runtime request quota. The server checks the entire set atomically.
      const ordered = [...coverage.items].sort((a, b) => {
        const left = a.channelId + a.purpose, right = b.channelId + b.purpose;
        return left < right ? -1 : left > right ? 1 : 0;
      });
      for (const item of ordered) {
        const proof = await retry(() => this.#proveProtectedRecoveryPackageOpening(connection, coverage, item, challenge, state));
        const { channelId, purpose, generation, epochDigest, packageDigest } = item;
        items.push({ channelId, purpose, generation, epochDigest, packageDigest, ...proof });
      }
      prepared = prepareProtectedRecoveryConfirmation(connection, challenge, requestID(), recovery, identity, items);
      attempts.set(slot, prepared);
      if (attempts.size > 16) attempts.delete(attempts.keys().next().value);
    }
    const release = () => { if (attempts.get(slot) === prepared) attempts.delete(slot); };
    let receipt;
    try { receipt = await post('confirm', prepared); }
    catch (error) {
      if (!isConnectionFailure(error) && error.code !== 'INVALID_API_RESPONSE') release();
      throw error;
    }
    if (receipt?.operationId !== prepared.operationId || receipt.recoveryId !== prepared.recoveryId ||
        !revisionNumber(receipt.revision) || !hexID(receipt.digest, 64)) throw failure('INVALID_API_RESPONSE');
    release();
    return { operationId: receipt.operationId, recoveryId: receipt.recoveryId, revision: receipt.revision, digest: receipt.digest, ready: true };
  }
  async #saveProtectedRuntimeTrust(trust) {
    const operation = this.registryQueue.catch(() => {}).then(async () => {
      const saved = await this.loadProtectedRuntimeTrust(trust.serverId);
      if (saved === undefined) await this.credentials.save(protectedRuntimeTrustSlot(trust.serverId), JSON.stringify(trust));
      else if (!isDeepStrictEqual(saved, trust)) throw failure('PROTECTED_CUTOVER_CHANGED');
    });
    this.registryQueue = operation.catch(() => {});
    return operation;
  }
  async prepareProtectedSelfHost(nickname, deviceLabel) {
    const identity = await this.identity();
    return {
      ...prepareProtectedSelfHost(identity, nickname, deviceLabel),
      register: (address, bootstrap) => this.#registerProtectedSelfHost(address, bootstrap),
      unregister: serverId => this.forget(serverId),
    };
  }
  async #registerProtectedSelfHost(address, { trust, binding, fingerprint, agreementSeed }) {
    const connection = await this.discoverMembership(address, trust.serverId, fingerprint);
    const { config } = connection;
    if (config.apiProtocolVersion !== 3) throw failure('PROTECTED_PROTOCOL_DOWNGRADE');
    if (config.binding !== binding || config.cutoverDigest !== trust.cutoverDigest || config.anchorDigest !== trust.anchorDigest) {
      throw failure('PROTECTED_CUTOVER_CHANGED');
    }
    const session = await this.#openRuntimeSession(trust.serverId, trust.cutoverDigest, connection, binding);
    if (session.profileId !== trust.ownerProfileId || session.deviceId !== trust.ownerDeviceId) throw failure('INVALID_PROTECTED_SESSION');
    const ownerConnection = { ...connection, ...session, policyTrust: trust };
    await this.refreshProtectedRuntimePolicy(ownerConnection, trust);
    await this.readProtectedPolicyAttestation(ownerConnection, 1);
    await this.credentials.save(`pawtalk:agreement:v1:${trust.serverId}:${session.deviceId}`, agreementSeed);
    await this.#saveProtectedRuntimeTrust(trust);
    await this.remember(connection);
  }
  async #setupProtectedStandalone(address, fields, nickname, deviceLabel) {
    const serverId = fields.get('server'), token = fields.get('token');
    if (!hexID(serverId, 32) || !hexID(token, 64) || fields.size !== 4 ||
        new Set(fields.keys()).size !== 4) throw failure('INVALID_INVITE');
    const clean = address.split('#')[0], base = serverURL(clean, this.allowLoopback);
    const fingerprint = await this.verify(clean);
    if (!base.startsWith('https:') || !hexID(fingerprint, 64)) throw failure('TLS_IDENTITY_MISSING');
    await this.trust(clean);
    const slot = 'pawtalk:standalone-bootstrap:v1:' + serverId;
    const finish = async bootstrap => {
      await this.#registerProtectedSelfHost(clean, bootstrap);
      await this.credentials.save(slot, null);
      return this.readProtectedRuntimeState(await this.openStoredProtectedRuntime(serverId));
    };
    const saved = await this.credentials.load(slot, { required: true });
    if (saved) {
      const retry = JSON.parse(saved);
      if (retry.fingerprint !== fingerprint || retry.trust?.serverId !== serverId) throw failure('SERVER_KEY_CHANGED');
      try { return await finish(retry); }
      catch (error) {
        if (error.code !== 'PROTECTED_BOOTSTRAP_REQUIRED') throw error;
      }
    }
    const handshake = await this.prepareProtectedSelfHost(nickname, deviceLabel);
    try {
      const request = (operation, payload) => this.fetchJSON(base, '/api/v3/bootstrap/' + operation, {
        method: 'POST', fingerprint, body: JSON.stringify({ token, ...payload }),
      });
      const offer = await request('offer', { owner: handshake.input });
      if (offer?.fingerprint !== fingerprint || offer?.protected?.serverId !== serverId) throw failure('SERVER_ID_CHANGED');
      const approval = handshake.authorize(offer);
      const pending = handshake.pending();
      await this.credentials.save(slot, JSON.stringify(pending));
      const receipt = await request('approve', { binding: pending.binding, approval });
      const bootstrap = handshake.confirm(receipt);
      for (let attempt = 0; ; attempt++) {
        try { return await finish(bootstrap); }
        catch (error) {
          if (attempt >= 39 || !['PROTECTED_BOOTSTRAP_REQUIRED', 'ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error;
          await delay(250);
        }
      }
    } finally { handshake.clear(); }
  }
  async openStoredProtectedRuntime(serverId) {
    const record = (await this.registry()).find(item => item.serverId === serverId);
    if (!record) throw failure('NOT_A_MEMBER');
    const trust = await this.loadProtectedRuntimeTrust(serverId);
    if (!trust) throw failure('UNTRUSTED_POLICY_ANCHOR');
    return this.#openTrustedProtectedRuntime(record.address, trust);
  }
  async #openTrustedProtectedRuntime(address, trust, options) {
    const { serverId } = trust;
    const connection = await this.discoverMembership(address, serverId, undefined, options);
    const { config } = connection;
    if (config.apiProtocolVersion !== 3) throw failure('PROTECTED_PROTOCOL_DOWNGRADE');
    if (config.cutoverDigest !== trust.cutoverDigest || config.anchorDigest !== trust.anchorDigest) {
      throw failure('PROTECTED_CUTOVER_CHANGED');
    }
    const session = await this.#openRuntimeSession(serverId, trust.cutoverDigest, connection, config.binding);
    return { ...connection, ...session, policyTrust: trust };
  }
  async changeProtectedAddress(serverId, address) {
    const trust = await this.loadProtectedRuntimeTrust(serverId);
    if (!trust) return;
    const record = (await this.registry()).find(item => item.serverId === serverId);
    if (!record) throw failure('NOT_A_MEMBER');
    const clean = address.trim().split('#')[0];
    const oldPin = invitation(record.address)?.fingerprint;
    let target = clean;
    // A bare address can reuse the certificate of the saved server. Persist
    // that pin with the new endpoint so it also applies after restarting.
    if (oldPin && !invitation(clean)) {
      const endpoint = new URL(serverURL(clean));
      target = `pawtalk://${endpoint.hostname}:${endpoint.port || '443'}/${oldPin}/v3`;
    }
    const connection = await this.#openTrustedProtectedRuntime(target, trust, { trustAddress: false });
    const state = await this.readProtectedRuntimeState(connection);
    await this.remember({ ...connection, displayName: state.community?.name ?? record.name }, record.address);
    await this.trust(connection.address);
    return { connection, state };
  }
  async readProtectedRuntimeState(connection) {
    const knownPolicy = connection.policyTrust && await this.policyCheckpoint().load(connection.policyTrust);
    const result = await this.fetchJSON(connection.base, '/api/v3/state', {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!Array.isArray(result?.Channels) || result.Channels.length > 1000 || !Array.isArray(result.Events) || result.Events.length !== 0) {
      throw failure('INVALID_API_RESPONSE');
    }
    if (connection.policyTrust) {
      await this.#loadOwnershipFloor(connection);
      if ((connection.ownership?.transferred || connection.ownership?.signerMoved) && result.OwnerProfileID === undefined) {
        throw failure('PROTECTED_PROTOCOL_DOWNGRADE');
      }
      if (connection.ownership && result.PolicyRevision < connection.ownership.revision) throw failure('POLICY_ROLLBACK');
      if (knownPolicy && result.PolicyRevision < knownPolicy.revision) throw failure('POLICY_ROLLBACK');
    }
    if (result.OwnerProfileID !== undefined && connection.policyTrust) {
      if (!hexID(result.OwnerProfileID, 64) || !Number.isSafeInteger(result.PolicyRevision) || result.PolicyRevision < 1) {
        throw failure('INVALID_API_RESPONSE');
      }
      if (result.OwnerProfileID !== protectedOwner(connection)) {
        await this.#verifyOwnershipStatus(connection, { ownerProfileId: result.OwnerProfileID, revision: result.PolicyRevision });
      }
    }
    const seen = new Set();
    const channels = result.Channels.map(channel => {
      if (!hexID(channel?.ID, 32) || seen.has(channel.ID) || !['text', 'voice'].includes(channel.Kind) ||
          typeof channel.CategoryID !== 'string' || channel.CategoryID.length > 64 ||
          (channel.CanOrder !== undefined && typeof channel.CanOrder !== 'boolean') ||
          (channel.CanEditSettings !== undefined && typeof channel.CanEditSettings !== 'boolean') ||
          (channel.CanInspectACL !== undefined && typeof channel.CanInspectACL !== 'boolean') ||
          (channel.KeysPending !== undefined && typeof channel.KeysPending !== 'boolean')) throw failure('INVALID_API_RESPONSE');
      seen.add(channel.ID);
      let settings;
      if (channel.Settings !== undefined) {
        const { Name, Description, SlowmodeSeconds, VoiceCapacity } = channel.Settings ?? {};
        if (typeof Name !== 'string' || !Name.length || [...Name].length > 64 || /\p{Cc}/u.test(Name) ||
            typeof Description !== 'string' || !Number.isSafeInteger(SlowmodeSeconds) || SlowmodeSeconds < 0 || SlowmodeSeconds > 21600 ||
            !Number.isSafeInteger(VoiceCapacity) || VoiceCapacity < 0 || VoiceCapacity > 0xffffffff ||
            (channel.Kind === 'text' ? VoiceCapacity !== 0 : SlowmodeSeconds !== 0)) throw failure('INVALID_API_RESPONSE');
        settings = { name: Name, description: Description, slowmodeSeconds: SlowmodeSeconds, voiceCapacity: VoiceCapacity };
      }
      const importedName = channel.ImportedName;
      if (importedName !== undefined && (settings || typeof importedName !== 'string' || !importedName.length ||
          importedName.length > 256 || /\p{Cc}/u.test(importedName))) throw failure('INVALID_API_RESPONSE');
      const voiceParticipants = channel.voiceParticipants;
      if (voiceParticipants !== undefined && (channel.Kind !== 'voice' || !Array.isArray(voiceParticipants) ||
          voiceParticipants.length > 8192 || voiceParticipants.some((person, index) => !hexID(person?.profileId, 64) ||
            (person.sessionId !== undefined && !hexID(person.sessionId, 32)) ||
            ['muted', 'deafened', 'serverMuted', 'serverDeafened', 'selfMuted', 'selfDeafened'].some(key => person[key] !== undefined && typeof person[key] !== 'boolean') ||
            index > 0 && person.profileId <= voiceParticipants[index - 1].profileId ||
            person.name !== undefined && (typeof person.name !== 'string' || person.name.length > 256 || /[\p{Cc}\p{Cs}]/u.test(person.name))))) {
        throw failure('INVALID_API_RESPONSE');
      }
      return { id: channel.ID, kind: channel.Kind, categoryId: channel.CategoryID, name: settings?.name ?? importedName, settings,
        ...(voiceParticipants && { voiceParticipants: voiceParticipants.map(({ profileId, sessionId, name, muted, deafened, serverMuted, serverDeafened, selfMuted, selfDeafened }) => ({
          profileId, sessionId, name, muted, deafened, serverMuted, serverDeafened, selfMuted, selfDeafened,
        })) }),
        ...(channel.CanOrder === true && { canOrder: true }), ...(channel.CanEditSettings === true && { canEditSettings: true }),
        ...(channel.CanInspectACL === true && { canInspectACL: true }),
        ...(channel.KeysPending === true && { keysPending: true }) };
    });
    const categoryIds = new Set(channels.map(channel => channel.categoryId).filter(Boolean));
    const seenCategories = new Set();
    const categories = result.Categories ?? [];
    if (!Array.isArray(categories) || categories.length > categoryIds.size || categories.some(category => {
      if (!categoryIds.has(category?.ID) || seenCategories.has(category.ID) ||
          (category.Name !== undefined && (typeof category.Name !== 'string' || !category.Name ||
            [...category.Name].length > 64 || /[\p{Cc}\p{Cs}]/u.test(category.Name)))) return true;
      seenCategories.add(category.ID);
      return false;
    })) throw failure('INVALID_API_RESPONSE');
    if (result.CanListMembers !== undefined && typeof result.CanListMembers !== 'boolean') throw failure('INVALID_API_RESPONSE');
    if (result.CanManageTimeouts !== undefined && typeof result.CanManageTimeouts !== 'boolean') throw failure('INVALID_API_RESPONSE');
    if (result.CanViewAudit !== undefined && typeof result.CanViewAudit !== 'boolean') throw failure('INVALID_API_RESPONSE');
    if (result.CanListInvites !== undefined && typeof result.CanListInvites !== 'boolean') throw failure('INVALID_API_RESPONSE');
    if (result.CanManageBans !== undefined && typeof result.CanManageBans !== 'boolean') throw failure('INVALID_API_RESPONSE');
    if (result.CanInspectPolicy !== undefined && typeof result.CanInspectPolicy !== 'boolean') throw failure('INVALID_API_RESPONSE');
    const managedCategories = result.ManagedCategories;
    if (managedCategories !== undefined) {
      const managedIds = new Set();
      if (!Array.isArray(managedCategories) || managedCategories.length > 10_000 || managedCategories.some(category => {
            if (typeof category?.ID !== 'string' || !category.ID || category.ID.length > 64 || /[\p{Cc}\p{Cs}]/u.test(category.ID) ||
                managedIds.has(category.ID) || (category.Name !== undefined && (typeof category.Name !== 'string' ||
                  !category.Name || [...category.Name].length > 64 || /[\p{Cc}\p{Cs}]/u.test(category.Name)))) return true;
            managedIds.add(category.ID);
            return false;
          }) || [...seenCategories].some(id => !managedIds.has(id))) throw failure('INVALID_API_RESPONSE');
    }
    if ([result.CanEditRoles, result.CanAssignRoles, result.CanEditOwnNickname, result.CanEditCommunity, result.CanLiftOwnServerVoice]
      .some(value => value !== undefined && typeof value !== 'boolean')) throw failure('INVALID_API_RESPONSE');
    const community = result.community === undefined ? undefined : this.#communityName(result.community);
    const avatarRevision = result.communityAvatarRevision;
    const avatarPending = result.communityAvatarPending;
    let communityAvatar;
    if (avatarRevision !== undefined) {
      if (!Number.isSafeInteger(avatarRevision) || avatarRevision < 1 || avatarPending !== undefined && typeof avatarPending !== 'boolean') {
        throw failure('INVALID_API_RESPONSE');
      }
      if (avatarRevision === 1) {
        const migrated = connection.config?.protectedLegacyAvatar === true && isProtectedOwner(connection) && !connection.legacyAvatarAbsent
          ? await this.#migrateLegacyCommunityAvatar(connection).catch(() => undefined) : undefined;
        communityAvatar = migrated ?? { revision: avatarRevision };
      }
      else if (avatarPending) {
        connection.communityAvatar = undefined;
        const recovery = this.#recoveredDeviceKey(connection);
        const restored = recovery ? await this.#restoreCommunityAvatar(connection, avatarRevision, recovery).catch(() => undefined) : undefined;
        communityAvatar = restored ?? { revision: avatarRevision, pending: true };
        if (restored) connection.communityAvatar = restored;
      } else if (connection.communityAvatar?.revision === avatarRevision) communityAvatar = connection.communityAvatar;
      else {
        const avatar = await this.readProtectedCommunityAvatar(connection).catch(() => undefined);
        if (avatar?.revision === avatarRevision && !avatar.pending) connection.communityAvatar = avatar;
        communityAvatar = avatar?.revision === avatarRevision ? avatar : { revision: avatarRevision, pending: true };
      }
    }
    const rotationQueue = result.rotationQueue;
    if (rotationQueue !== undefined && (!rotationQueue || Object.keys(rotationQueue).length !== 2 ||
        ![rotationQueue.waiting, rotationQueue.processing].every(count => Number.isSafeInteger(count) && count >= 0) ||
        rotationQueue.waiting + rotationQueue.processing > 2 * channels.length)) throw failure('INVALID_API_RESPONSE');
    const timeout = result.Timeout === undefined ? undefined : this.#protectedTimeoutStatus(result.Timeout);
    const stillVisible = channelId => seen.has(channelId);
    this.#archiveResume.clear(connection.serverId, stillVisible);
    this.#clearTextStatus(connection.serverId, stillVisible);
    const owner = !!connection.policyTrust && isProtectedOwner(connection);
    connection.canInspectProtectedPolicy = result.CanInspectPolicy === true;
    const profileAvatar = connection.config?.protectedProfileAvatar === true && !connection.pendingInvite
      ? await this.readProtectedProfileAvatar(connection).catch(() => connection.profileAvatar?.value) : undefined;
    return { apiProtocolVersion: 3, serverId: connection.serverId, profileId: connection.profileId, channels,
      mediaVariants: connection.config?.protectedMediaVariants === true,
      canRevokeOwnDevices: connection.config?.protectedDeviceRevocation === true && (owner || result.CanInspectPolicy === true),
      profileAvatarSupported: connection.config?.protectedProfileAvatar === true,
      ...(profileAvatar && { profileAvatar }),
      ...(community && { community }),
      ...(communityAvatar && { communityAvatar }),
      canEditCommunity: !!community && result.CanEditCommunity === true,
      ...(rotationQueue !== undefined && { rotationQueue }),
      categories: ((connection.policyTrust && (owner || result.CanInspectPolicy === true) ? managedCategories : undefined) ?? categories)
        .map(category => ({ id: category.ID, name: category.Name })),
      canListMembers: result.CanListMembers === true,
      canViewAudit: result.CanViewAudit === true,
      canListInvites: result.CanListInvites === true,
      canManageBans: result.CanManageBans === true,
      canEditOwnNickname: result.CanEditOwnNickname === true,
      canManageTimeouts: result.CanManageTimeouts === true, timeout,
      canManageChannels: !!connection.policyTrust && (owner || result.CanInspectPolicy === true),
      canEditRoles: !!connection.policyTrust && result.CanEditRoles === true,
      canAssignRoles: !!connection.policyTrust && result.CanAssignRoles === true,
      canManageScopeAuthority: owner,
      canLiftOwnVoiceRestriction: owner && connection.config?.protectedVoiceChannelControls === true,
      canLiftOwnServerVoiceRestriction: result.CanLiftOwnServerVoice === true,
      composerEvents: connection.config?.protectedComposerEvents === true };
  }
  async publishProtectedComposerActivity(connection, channelId, activity) {
    if (connection.config?.protectedComposerEvents !== true) return;
    await this.fetchJSON(connection.base, `/api/v3/composer/${channelId}`, {
      method: 'PUT', body: JSON.stringify({ activity }), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
  }
  async readProtectedAudit(connection, before) {
    if (before !== undefined && !hexID(before, 32)) throw failure('INVALID_INPUT');
    const page = await this.fetchJSON(connection.base, '/api/v3/audit' + (before ? `?before=${before}` : ''), {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    const label = (value, max) => typeof value === 'string' && [...value].length <= max && !/[\p{Cc}\p{Cs}]/u.test(value);
    const safeNumber = value => Number.isSafeInteger(value) && value >= 0;
    if (!safeNumber(page?.retention) || !page.retention || !safeNumber(page.cutoff) || !hexID(page.scope, 64) ||
        typeof page.canChange !== 'boolean' || (page.next !== undefined && (!hexID(page.next, 32) || page.next === before)) ||
        !Array.isArray(page.entries) || page.entries.length > 32 || (page.next !== undefined && page.entries.length !== 32)) {
      throw failure('INVALID_API_RESPONSE');
    }
    const list = value => value === undefined || Array.isArray(value) && value.length <= 1024 && value.every(item => label(item, 128));
    const number = value => value === undefined || safeNumber(value);
    const entries = page.entries.map(entry => {
      if (!safeNumber(entry?.at) || entry.at < page.cutoff || !hexID(entry.actor, 64) ||
          (entry.actorName !== undefined && !label(entry.actorName, 256)) ||
          (entry.objectName !== undefined && !label(entry.objectName, 256)) ||
          (entry.channelName !== undefined && !label(entry.channelName, 256)) ||
          (entry.roleNames !== undefined && (!entry.roleNames || typeof entry.roleNames !== 'object' || Array.isArray(entry.roleNames) ||
            Object.keys(entry.roleNames).length > 2048 || Object.entries(entry.roleNames).some(([id, name]) =>
              !label(id, 128) || !label(name, 256)))) ||
          !label(entry.action, 64) || !/^[a-z][a-z.-]*$/.test(entry.action) ||
          !['server', 'role', 'member', 'device', 'category', 'channel', 'message', 'poll', 'invite'].includes(entry.kind) ||
          !label(entry.objectId, 128) || (entry.channelId !== undefined && !hexID(entry.channelId, 32)) ||
          (entry.position !== undefined && (!safeNumber(entry.position) || !entry.position || !entry.channelId)) ||
          (entry.reason !== undefined && !label(entry.reason, 200)) ||
          !entry.change || typeof entry.change !== 'object' || Array.isArray(entry.change) ||
          !number(entry.change.previous) || !number(entry.change.current) || !list(entry.change.added) || !list(entry.change.removed) ||
          (entry.change.layoutDigest !== undefined && (!hexID(entry.change.layoutDigest, 64) || entry.action !== 'channel.order' ||
            entry.kind !== 'channel' || !entry.channelId || entry.channelId !== entry.objectId))) {
        throw failure('INVALID_API_RESPONSE');
      }
      const { at, actor, actorName, action, kind, objectId, objectName, channelId, channelName, roleNames, position, reason, change } = entry;
      const { previous, current, added, removed, layoutDigest } = change;
      return { at, actor, actorName, action, kind, objectId, channelId, position, reason,
        ...(objectName && { objectName }), ...(channelName && { channelName }), ...(roleNames && { roleNames }),
        change: { previous, current, added, removed, ...(layoutDigest && { layoutDigest }) } };
    });
    return { entries, next: page.next, retention: page.retention, canChange: page.canChange, scope: page.scope, cutoff: page.cutoff };
  }
  async changeProtectedAuditRetention(connection, request) {
    const response = await this.fetchJSON(connection.base, '/api/v3/audit/retention', {
      method: 'PUT', body: JSON.stringify(request),
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (response?.ok !== true) throw failure('INVALID_API_RESPONSE');
    return true;
  }
  #protectedTimeoutStatus(status) {
    if (!Number.isSafeInteger(status?.deadline) || status.deadline < 0 || typeof status.canSet !== 'boolean' ||
        typeof status.canLift !== 'boolean' || status.reason !== undefined && (
          typeof status.reason !== 'string' || [...status.reason].length > 200 || /[\p{Cc}\p{Cs}]/u.test(status.reason))) {
      throw failure('INVALID_API_RESPONSE');
    }
    return { deadline: status.deadline, reason: status.reason, canSet: status.canSet, canLift: status.canLift };
  }
  async readProtectedTimeout(connection, profileId) {
    if (!hexID(profileId, 64)) throw failure('INVALID_INPUT');
    const status = await this.fetchJSON(connection.base, `/api/v3/moderation/timeout/${profileId}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    return this.#protectedTimeoutStatus(status);
  }
  async changeProtectedTimeout(connection, profileId, request) {
    if (!hexID(profileId, 64)) throw failure('INVALID_INPUT');
    const receipt = await this.fetchJSON(connection.base, `/api/v3/moderation/timeout/${profileId}`, {
      method: 'PUT', body: JSON.stringify(request),
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!Number.isSafeInteger(receipt?.deadline) || receipt.deadline < 0 || typeof receipt.existing !== 'boolean') {
      throw failure('INVALID_API_RESPONSE');
    }
    return { deadline: receipt.deadline, existing: receipt.existing };
  }
  #communityName(value) {
    if (!Number.isSafeInteger(value?.revision) || value.revision < 1 || typeof value.name !== 'string' ||
        !value.name || [...value.name].length > 64 || /[\p{Cc}\p{Cs}]/u.test(value.name)) throw failure('INVALID_API_RESPONSE');
    return { name: value.name, revision: value.revision };
  }
  async renameProtectedCommunity(connection, input) {
    const result = this.#communityName(await this.fetchJSON(connection.base, '/api/v3/community/name', {
      method: 'PUT', body: JSON.stringify(input), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    }));
    if (result.name !== input.name || ![input.revision, input.revision + 1].includes(result.revision)) throw failure('INVALID_API_RESPONSE');
    return result;
  }
  async #communityAvatarRequest(connection, suffix = '', options = {}) {
    return this.fetchJSON(connection.base, '/api/v3/community/avatar' + suffix, {
      ...options, fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
  }
  async #profileAvatarRequest(connection, suffix = '', options = {}) {
    const sharing = this.#profileAvatarSharing(connection);
    if (sharing) suffix += `${suffix.includes('?') ? '&' : '?'}shared=${sharing}`;
    return this.fetchJSON(connection.base, '/api/v3/profiles/self/avatar' + suffix, {
      ...options, fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
  }
  #profileAvatarSharing(connection) {
    if (connection.config?.protectedOwnerProfileAvatar === true && isProtectedOwner(connection)) return '1';
    return connection.config?.protectedMemberProfileAvatars === true ? 'members' : undefined;
  }
  async readProtectedProfileAvatar(connection, fresh = false) {
    if (connection.config?.protectedProfileAvatar !== true) throw failure('UNSUPPORTED_FEATURE');
    const cached = connection.profileAvatar;
    if (!fresh && cached && Date.now() - cached.at < 10_000) return cached.value;
    if (connection.profileAvatarRead) return connection.profileAvatarRead;
    const request = this.#readProtectedProfileAvatar(connection);
    connection.profileAvatarRead = request;
    try { return await request; }
    finally { if (connection.profileAvatarRead === request) connection.profileAvatarRead = undefined; }
  }
  async #readProtectedProfileAvatar(connection) {
    const view = await this.#profileAvatarRequest(connection);
    const { revision, content, package: wrapped, pending, publisher, needsDelivery } = view;
    if (!Number.isSafeInteger(revision) || revision < 1 || pending !== undefined && pending !== true ||
        needsDelivery !== undefined && needsDelivery !== true) throw failure('INVALID_API_RESPONSE');
    let value = { revision, pending: pending === true };
    if (content || wrapped || publisher) {
      if (content?.context?.profileId !== connection.profileId || content.context.scope !== 'profile') throw failure('INVALID_PROTECTED_AVATAR');
      const { privateKey, recipient, signer } = await this.#verifiedCommunityAvatar(connection, view, 'profile');
      const bytes = openCommunityAvatar(content.context, content.packet, wrapped, recipient, privateKey, signer);
      try {
        const avatar = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        this.validateAvatar(avatar);
        value = { revision, avatar, pending: false };
      } finally { bytes.fill(0); }
    }
    if (connection.profileAvatar?.value.revision > revision) return connection.profileAvatar.value;
    connection.profileAvatar = { at: Date.now(), value };
    if (needsDelivery && value.avatar) {
      return this.saveProtectedProfileAvatar(connection, value.avatar, revision).catch(() => connection.profileAvatar.value);
    }
    return value;
  }
  async saveProtectedProfileAvatar(connection, avatar, expectedRevision) {
    if (connection.config?.protectedProfileAvatar !== true) throw failure('UNSUPPORTED_FEATURE');
    const result = await this.saveProtectedCommunityAvatar(connection, avatar, expectedRevision, true);
    const value = { ...result, pending: false };
    if (!connection.profileAvatar || connection.profileAvatar.value.revision <= value.revision) {
      connection.profileAvatar = { at: Date.now(), value };
    }
    return value;
  }
  async #migrateLegacyCommunityAvatar(connection) {
    const { serverId } = connection;
    const saved = await this.credentials.load('pawtalk:server:v2:' + serverId);
    const secret = saved && JSON.parse(saved)?.secret;
    if (!hexID(secret, 64)) return;
    const { envelope, author } = await this.#communityAvatarRequest(connection, '/legacy');
    if (envelope === undefined && author === undefined) {
      connection.legacyAvatarAbsent = true;
      return;
    }
    if (typeof envelope !== 'string' || envelope.length > 24_000 || !hexID(author, 64)) throw failure('INVALID_AVATAR');
    const packet = JSON.parse(Buffer.from(envelope, 'base64').toString('utf8'));
    const bytes = await cryptoV2.openContent(secret, serverId, 'avatar', '', 'server-avatar', author, packet);
    try {
      const avatar = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const result = await this.saveProtectedCommunityAvatar(connection, avatar, 1);
      connection.communityAvatar = { ...result, pending: false };
      return connection.communityAvatar;
    } finally {
      bytes.fill(0);
    }
  }
  async readProtectedCommunityAvatar(connection) {
    const view = await this.#communityAvatarRequest(connection);
    const { revision, content, package: wrapped, pending, publisher } = view;
    if (!Number.isSafeInteger(revision) || revision < 1 || pending !== undefined && pending !== true) throw failure('INVALID_API_RESPONSE');
    if (!content && !wrapped && !publisher) return { revision, pending: pending === true };
    const { privateKey, recipient, signer } = await this.#verifiedCommunityAvatar(connection, view);
    const bytes = openCommunityAvatar(content.context, content.packet, wrapped, recipient, privateKey, signer);
    try {
      const avatar = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      this.validateAvatar(avatar);
      return { revision, avatar, pending: false };
    } finally {
      bytes.fill(0);
    }
  }
  async #communityAvatarSigner(connection, { revision, content, package: wrapped, pending, publisher }, recipientID, scope) {
    if (!content || !wrapped || !publisher || pending || content.context?.serverId !== connection.serverId || content.context.revision !== revision ||
        content.context.scope !== scope ||
        !Number.isSafeInteger(content.policyRevision) || content.policyRevision < 1 || wrapped.id !== recipientID) {
      throw failure('INVALID_PROTECTED_AVATAR');
    }
    const attestation = await this.readProtectedPolicyAttestation(connection, content.policyRevision);
    return verifyCommunityAvatarPublisher(attestation, content.context, publisher);
  }
  async #communityAvatarDevice(connection) {
    const privateKey = await loadDeviceAgreementKey(this.credentials, connection.serverId, connection.deviceId, false);
    const recipient = { id: connection.deviceId, publicKey: createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
    return { privateKey, recipient };
  }
  async #verifiedCommunityAvatar(connection, view, scope) {
    const signer = await this.#communityAvatarSigner(connection, view, connection.deviceId, scope);
    const { privateKey, recipient } = await this.#communityAvatarDevice(connection);
    return { signer, privateKey, recipient };
  }
  async #restoreCommunityAvatar(connection, revision, recovery) {
    const view = await this.#communityAvatarRequest(connection, '/recovery');
    if (view.revision !== revision || view.pending || !view.package) return;
    if (!hexID(view.policyHead, 64)) throw failure('INVALID_API_RESPONSE');
    const signer = await this.#communityAvatarSigner(connection, view, recovery.recoveryId);
    const { recipient } = await this.#communityAvatarDevice(connection);
    const holder = { id: recovery.recoveryId, publicKey: recovery.agreementKey, kind: 'recovery' };
    const { context, packet } = view.content;
    const wrapped = rewrapCommunityAvatar(context, packet, view.package, holder, recovery.agreement, signer, recipient);
    const receipt = await this.#communityAvatarRequest(connection, '/recovery', {
      method: 'PUT', body: JSON.stringify({ revision, policyHead: view.policyHead, packages: [wrapped] }),
    });
    if (receipt?.ok !== true) throw failure('INVALID_API_RESPONSE');
    return this.readProtectedCommunityAvatar(connection);
  }
  async #serviceCommunityAvatarDeliveries(connection) {
    const { revision, audience } = await this.#communityAvatarRequest(connection, '/delivery');
    if (!Number.isSafeInteger(revision) || revision < 1) throw failure('INVALID_API_RESPONSE');
    if (!audience) return;
    if (!Array.isArray(audience.recipients) || !audience.recipients.length || audience.recipients.length > 4 || audience.next !== undefined) {
      throw failure('INVALID_PROTECTED_AVATAR');
    }
    const attestation = await this.readProtectedPolicyAttestation(connection, undefined, { expectedCurrentHead: audience.policyHead });
    const targets = verifyCommunityAvatarAudience(attestation, audience);
    const view = await this.#communityAvatarRequest(connection);
    if (view.revision !== revision) return;
    const { privateKey, recipient, signer } = await this.#verifiedCommunityAvatar(connection, view);
    const { context, packet } = view.content;
    const packages = targets.map(target => rewrapCommunityAvatar(context, packet, view.package, recipient, privateKey, signer, target));
    const receipt = await this.#communityAvatarRequest(connection, '/delivery', {
      method: 'PUT', body: JSON.stringify({ revision, policyHead: attestation.digest, packages }),
    });
    if (receipt?.ok !== true) throw failure('INVALID_API_RESPONSE');
  }
  async saveProtectedCommunityAvatar(connection, avatar, expectedRevision, ownProfile = false) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw failure('INVALID_INPUT');
    const { deviceId, device } = await this.identity();
    if (deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
    const attestation = await this.readProtectedPolicyAttestation(connection);
    const context = { serverId: connection.serverId, revision: expectedRevision + 1, operationId: requestID(),
      policyHead: attestation.digest, profileId: connection.profileId, deviceId, ...(ownProfile && { scope: 'profile' }) };
    const request = (path, options) => ownProfile ? this.#profileAvatarRequest(connection, path, options) :
      this.#communityAvatarRequest(connection, path, options);
    let update = { context, packet: null };
    if (avatar !== null) {
      this.validateAvatar(avatar);
      const recipients = [];
      let after = '';
      do {
        const path = `/audience${after ? `?after=${after}` : ''}`;
        const page = await request(path);
        const shared = ownProfile && this.#profileAvatarSharing(connection);
        if (ownProfile && page?.recipients?.some(recipient => recipient?.kind !== 'device' ||
            !shared && recipient.profile?.profileId !== connection.profileId)) throw failure('INVALID_PROTECTED_AVATAR');
        recipients.push(...verifyCommunityAvatarAudience(attestation, page, after));
        if (recipients.length > 8192 || (page.next && recipients.length === 8192)) throw failure('INVALID_PROTECTED_AVATAR');
        after = page.next;
      } while (after);
      const bytes = Buffer.from(avatar, 'utf8');
      try { update = { context, ...sealCommunityAvatar(context, bytes, recipients, device) }; }
      finally { bytes.fill(0); }
    }
    const receipt = await request('', { method: 'PUT', body: JSON.stringify(update) });
    if (receipt?.revision !== context.revision) throw failure('INVALID_API_RESPONSE');
    return { revision: receipt.revision, avatar: avatar ?? undefined };
  }
  async protectedNickname(connection, profileId, channelId, update) {
    if (!hexID(profileId, 64) || channelId !== undefined && !hexID(channelId, 32)) throw failure('INVALID_INPUT');
    const resource = `/api/v3/profiles/${profileId}/nickname`;
    const path = !update && channelId ? `${resource}?channel=${channelId}` : resource;
    const current = await this.fetchJSON(connection.base, path, {
      ...(update && { method: 'PUT', body: JSON.stringify({ ...update, channelId }) }),
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!Number.isSafeInteger(current?.revision) || current.revision < 0 || typeof current.name !== 'string' ||
        [...current.name].length > (current.revision === 0 ? 256 : 32) || /[\p{Cc}\p{Cs}]/u.test(current.name) ||
        update && (current.name !== update.name || ![update.revision, update.revision + 1].includes(current.revision))) {
      throw failure('INVALID_API_RESPONSE');
    }
    return { name: current.name, revision: current.revision };
  }
  async reportProtectedActivity(connection, away) {
    if (connection.config?.protectedPresence !== true) return;
    await this.fetchJSON(connection.base, '/api/v3/activity', {
      method: 'POST', fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ away }),
    });
  }
  async readProtectedRuntimeRoster(connection, channelId, after, revision, forMentions = false, forVoice = false) {
    if ((channelId !== undefined && !hexID(channelId, 32)) ||
        (after !== undefined || revision !== undefined) && (!hexID(after, 64) || !Number.isSafeInteger(revision) || revision < 1)) {
      throw failure('INVALID_PROTECTED_ROSTER_PAGE');
    }
    if (forVoice && connection.config?.protectedVoiceControls !== true) {
      if (!channelId) return { revision: 1, members: [] };
      forVoice = false;
    }
    const scope = forVoice ? 'voice' : channelId === undefined ? 'members' : `text/${channelId}`;
    const query = new URLSearchParams();
    if (after !== undefined) {
      query.set('after', after);
      query.set('revision', revision);
    }
    if (forMentions) query.set('mentions', '1');
    if (!forMentions) {
      if (connection.config?.protectedMemberProfileAvatars === true) query.set('profileAvatars', 'all');
      else if (connection.config?.protectedOwnerProfileAvatar === true) query.set('profileAvatars', '1');
    }
    let avatarKey;
    if (!forMentions && connection.config?.protectedLegacyAvatar === true) {
      try {
        const saved = await this.credentials.load('pawtalk:server:v2:' + connection.serverId);
        const secret = saved && JSON.parse(saved)?.secret;
        if (hexID(secret, 64)) {
          avatarKey = secret;
          query.set('legacyAvatars', '1');
        }
      } catch { /* A missing or damaged legacy key does not block the roster. */ }
    }
    const page = await this.fetchJSON(connection.base, `/api/v3/roster/${scope}${query.size ? `?${query}` : ''}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    const label = (value, max) => value === undefined ||
      (typeof value === 'string' && [...value].length > 0 && [...value].length <= max && !/[\p{Cc}\p{Cs}]/u.test(value));
    if (!Number.isSafeInteger(page?.revision) || page.revision < 1 || revision !== undefined && page.revision !== revision ||
        page.nicknameDigest !== undefined && !hexID(page.nicknameDigest, 64) ||
        page.channelId !== (forVoice ? undefined : channelId) || !Array.isArray(page.members) || page.members.length > 64 ||
        page.next !== undefined && (page.members.length !== 64 || page.next !== page.members.at(-1)?.id)) {
      throw failure('INVALID_API_RESPONSE');
    }
    let previous = after ?? '';
    for (const member of page.members) {
      if (!hexID(member?.id, 64) || member.id <= previous || !label(member.name, 256) ||
          (member.owner !== undefined && typeof member.owner !== 'boolean') ||
          (member.canKick !== undefined && typeof member.canKick !== 'boolean') ||
          (member.canBan !== undefined && typeof member.canBan !== 'boolean') ||
          (member.canAssignRoles !== undefined && typeof member.canAssignRoles !== 'boolean') ||
          (member.canEditNickname !== undefined && typeof member.canEditNickname !== 'boolean') ||
          (member.color !== undefined && (typeof member.color !== 'string' || !/^#[0-9a-f]{6}$/.test(member.color))) ||
          !Array.isArray(member.roles) || member.roles.length === 0) throw failure('INVALID_API_RESPONSE');
      previous = member.id;
      const ids = new Set();
      for (const role of member.roles) {
        if (!role?.id || !label(role.id, 256) || ids.has(role.id) || !label(role.name, 256) || !label(role.icon, 32)) {
          throw failure('INVALID_API_RESPONSE');
        }
        ids.add(role.id);
      }
      if (!ids.has('@everyone') || (member.groupId === undefined ? member.groupRank !== undefined :
        !ids.has(member.groupId) || !Number.isSafeInteger(member.groupRank) || member.groupRank < 1)) throw failure('INVALID_API_RESPONSE');
    }
    let mentions;
    if (forMentions) {
      const options = page.mentions;
      const represented = new Set(page.members.flatMap(member => member.roles.map(role => role.id)));
      if (typeof options?.available !== 'boolean' || typeof options.mass !== 'boolean' || !Array.isArray(options.roles) ||
          new Set(options.roles).size !== options.roles.length || options.roles.some(role => role === '@everyone' || !represented.has(role)) ||
          !options.available && (options.mass || options.roles.length || page.members.length || page.next !== undefined)) {
        throw failure('INVALID_API_RESPONSE');
      }
      mentions = { available: options.available, mass: options.mass, roles: options.roles };
    }
    return { revision: page.revision, channelId: page.channelId, next: page.next,
      ...(page.nicknameDigest !== undefined && { nicknameDigest: page.nicknameDigest }),
      ...(mentions && { mentions }), members: await Promise.all(page.members.map(async member => {
        const avatar = forMentions ? undefined : await this.#readRosterAvatar(connection, member, avatarKey);
        return {
          id: member.id, name: member.name, owner: member.owner, color: member.color, groupId: member.groupId,
          ...(!forMentions && ['online', 'away', 'offline'].includes(member.presence) && { presence: member.presence }),
          ...(avatar && { avatar }),
          groupRank: member.groupRank, ...(member.canKick && { canKick: true }), ...(member.canBan && { canBan: true }),
          ...(member.canAssignRoles && { canAssignRoles: true }),
          ...(member.canEditNickname && { canEditNickname: true }),
          roles: member.roles.map(({ id, name, icon }) => ({ id, name, icon })),
        };
      })) };
  }
  async #readRosterAvatar(connection, member, legacyKey) {
    const view = member.profileAvatar;
    const supportsAvatar = connection.config?.protectedMemberProfileAvatars === true ||
      member.owner && connection.config?.protectedOwnerProfileAvatar === true;
    if (supportsAvatar && view?.content?.context?.profileId === member.id) {
      try {
        const { privateKey, recipient, signer } = await this.#verifiedCommunityAvatar(connection, view, 'profile');
        const bytes = openCommunityAvatar(view.content.context, view.content.packet, view.package, recipient, privateKey, signer);
        try {
          const avatar = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          this.validateAvatar(avatar);
          return avatar;
        } finally { bytes.fill(0); }
      } catch { return undefined; }
    }
    if (view?.revision > 1 && !view.pending) return undefined;
    if (!legacyKey || !member.legacyAvatar) return undefined;
    const avatar = await this.#openLegacyProfileAvatar(legacyKey, connection.serverId, member.legacyAvatar.envelope, member.legacyAvatar.author);
    if (avatar && member.id === connection.profileId && member.owner && connection.config?.protectedOwnerProfileAvatar === true &&
        !connection.legacyProfileAvatarChecked) {
      connection.legacyProfileAvatarChecked = true;
      void this.readProtectedProfileAvatar(connection).then(current => current.revision === 1
        ? this.saveProtectedProfileAvatar(connection, avatar, 1) : undefined).catch(() => { connection.legacyProfileAvatarChecked = false; });
    }
    return avatar;
  }
  async #openLegacyProfileAvatar(secret, serverId, envelope, owner) {
    if (typeof envelope !== 'string' || envelope.length > 24_000 || !hexID(owner, 64)) return;
    try {
      const packet = JSON.parse(Buffer.from(envelope, 'base64').toString('utf8'));
      const bytes = await cryptoV2.openContent(secret, serverId, 'avatar', '', owner, owner, packet);
      try {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        this.validateAvatar(value);
        return value;
      } finally { bytes.fill(0); }
    } catch { /* An unavailable avatar does not block the roster. */ }
  }
  async previewProtectedCleanup(connection, action, target, window) {
    if (!['kick', 'ban'].includes(action) || !hexID(target, 64) ||
        !['hour', 'day', 'week', 'all'].includes(window)) throw failure('INVALID_INPUT');
    const preview = await this.fetchJSON(connection.base, '/api/v3/moderation/cleanup/preview', {
      method: 'POST', fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ action, target, window }),
    });
    if (!hexID(preview?.id, 32) || !Number.isSafeInteger(preview.count) || preview.count < 0) throw failure('INVALID_API_RESPONSE');
    return { id: preview.id, count: preview.count };
  }
  async changeProtectedMembership(connection, action, target, { reason = '', expiresAt = 0, cleanupId } = {}) {
    if (!['kick', 'ban', 'unban'].includes(action) || !hexID(target, 64) || !hexID(connection?.cutoverDigest, 64) ||
        !hexID(connection.profileId, 64) || !hexID(connection.fingerprint, 64) ||
        typeof reason !== 'string' || reason !== reason.trim() || [...reason].length > 200 || /[\p{Cc}\p{Cs}]/u.test(reason) ||
        (action !== 'unban' && !reason) || !Number.isSafeInteger(expiresAt) || expiresAt < 0 || expiresAt > 8_640_000_000_000_000 ||
        (action !== 'ban' && expiresAt !== 0) ||
        (cleanupId !== undefined && (action === 'unban' || !hexID(cleanupId, 32)))) throw failure('INVALID_INPUT');
    const { device, deviceId } = await this.identity();
    if (deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
    const headers = { Authorization: `Bearer ${connection.token}` };
    const { policyHead } = await this.fetchJSON(connection.base, '/api/v3/member/leave/head', { fingerprint: connection.fingerprint, headers });
    if (!hexID(policyHead, 64)) throw failure('INVALID_API_RESPONSE');
    const operationId = requestID();
    const frame = signatureFrame('pawtalk-protected-member-moderation-v1', connection.serverId, connection.cutoverDigest,
      connection.profileId, deviceId, operationId, policyHead, 'member.' + action, target, reason, String(expiresAt));
    const body = { profileId: connection.profileId, deviceId, operationId, policyHead, target, reason, expiresAt,
      signature: sign(null, frame, device).toString('base64url') };
    const response = await this.fetchJSON(connection.base, `/api/v3/moderation/member/${action}`, {
      method: 'POST', fingerprint: connection.fingerprint, headers, body: JSON.stringify(body),
    });
    if (response?.operationId !== operationId) throw failure('INVALID_API_RESPONSE');
    if (cleanupId === undefined) return true;
    try {
      const result = await this.fetchJSON(connection.base, '/api/v3/moderation/cleanup/apply', {
        method: 'POST', fingerprint: connection.fingerprint, headers, body: JSON.stringify({ id: cleanupId, operationId }),
      });
      if (!Number.isSafeInteger(result?.removed) || result.removed < 0) throw failure('INVALID_API_RESPONSE');
      return { cleanup: 'done', removed: result.removed };
    } catch {
      return { cleanup: 'failed' };
    }
  }
  async listProtectedBans(connection, after) {
    if (after !== undefined && !hexID(after, 64)) throw failure('INVALID_INPUT');
    const page = await this.fetchJSON(connection.base, '/api/v3/moderation/bans' + (after ? `?after=${after}` : ''), {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!Array.isArray(page?.bans) || page.bans.length > 32 ||
        (page.next !== undefined && (page.bans.length !== 32 || page.next !== page.bans.at(-1)?.profileId))) throw failure('INVALID_API_RESPONSE');
    let previous = after ?? '';
    const bans = page.bans.map(entry => {
      const { profileId, reason, expiresAt, inherited } = entry ?? {};
      if (!hexID(profileId, 64) || profileId <= previous || (inherited !== undefined && inherited !== true) ||
          typeof reason !== 'string' || (!inherited && !reason) || [...reason].length > (inherited ? 512 : 200) ||
          /[\p{Cc}\p{Cs}]/u.test(reason) || !(inherited ? Number.isInteger(expiresAt) : Number.isSafeInteger(expiresAt)) || expiresAt < 0) {
        throw failure('INVALID_API_RESPONSE');
      }
      previous = profileId;
      return { profileId, reason, expiresAt, ...(inherited && { inherited }) };
    });
    return { bans, next: page.next };
  }
  async #openRuntimeSession(serverId, cutoverDigest, { base, fingerprint }, expectedBinding, pendingInvite = false) {
    const challenge = await this.fetchJSON(base, '/api/v3/session/challenge', { fingerprint });
    if (challenge?.apiProtocolVersion !== 3 || challenge.serverId !== serverId || challenge.cutoverDigest !== cutoverDigest ||
        expectedBinding !== undefined && challenge.binding !== expectedBinding ||
        !hexID(challenge.binding, 64) || !hexID(challenge.nonce, 64) || !Number.isSafeInteger(challenge.expiresAt)) {
      throw failure('INVALID_PROTECTED_CHALLENGE');
    }
    const { deviceId, profileId, device } = await this.identity();
    const fields = [serverId, cutoverDigest, challenge.binding, challenge.nonce];
    const frame = pendingInvite ? signatureFrame('pawtalk-protected-pending-session-v1', ...fields, profileId, deviceId) :
      signatureFrame('pawtalk-protected-session-v1', ...fields, deviceId);
    const proof = { deviceId, nonce: challenge.nonce, signature: sign(null, frame, device).toString('base64url') };
    const path = pendingInvite ? '/api/v3/invites/session/open' : '/api/v3/session/open';
    const result = await this.fetchJSON(base, path, { method: 'POST', body: JSON.stringify(proof), fingerprint });
    if (result?.deviceId !== deviceId || !hexID(result.profileId, 64) || !hexID(result.sessionId, 32) || !Number.isSafeInteger(result.expiresAt) ||
        typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.token) ||
        Buffer.from(result.token, 'base64url').toString('base64url') !== result.token ||
        pendingInvite && result.profileId !== profileId) throw failure('INVALID_API_RESPONSE');
    return { base, fingerprint, serverId, cutoverDigest, deviceId, profileId: result.profileId, sessionId: result.sessionId, binding: challenge.binding,
      token: result.token, expiresAt: result.expiresAt, ...(pendingInvite && { pendingInvite: true }) };
  }
  #protectedRuntimeVoiceRequest(connection, channelId, suffix, method, body) {
    if (!hexID(channelId, 32) || !hexID(connection.sessionId, 32)) throw failure('INVALID_PROTECTED_VOICE_REQUEST');
    return this.fetchJSON(connection.base, `/api/v3/voice/${channelId}/${suffix}`, {
      method, body, fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
  }
  prepareProtectedRuntimeVoice(connection, channelId) {
    return this.#protectedRuntimeVoiceRequest(connection, channelId, 'prepare', 'POST');
  }
  async exchangeProtectedRuntimeVoiceKey(connection, channelId, policyTrust) {
    const { deviceId, device } = await this.identity();
    if (deviceId !== connection.deviceId || policyTrust?.serverId !== connection.serverId) throw failure('INVALID_PROTECTED_SESSION');
    const checkpoint = this.policyCheckpoint();
    const owner = isProtectedOwner(connection, policyTrust);
    const privateKey = await loadDeviceAgreementKey(this.credentials, connection.serverId, deviceId, false);
    const recipientKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const expected = { serverId: connection.serverId, channelId, binding: connection.binding };
    const claim = await this.#protectedRuntimeVoiceRequest(connection, channelId, 'key/claim', 'POST');
    if (typeof claim?.published !== 'boolean') throw failure('INVALID_PROTECTED_VOICE_KEY');
    verifyVoiceKeyBasis(claim.basis, claim.roster, claim.serverTime, expected);
    const checkFullRoster = async (basis, roster) => {
      try {
        return await checkpoint.authorizeVoiceRoster(basis, policyTrust, connection.binding, roster);
      } catch (error) {
        if (error.code !== 'UNVERIFIED_EPOCH_POLICY' || !owner) throw error;
        await this.refreshProtectedRuntimePolicy(connection, policyTrust);
        return checkpoint.authorizeVoiceRoster(basis, policyTrust, connection.binding, roster);
      }
    };
    const checkRoster = async ({ basis, roster, policy }) => {
      const view = owner ? undefined : await this.readProtectedPolicyAttestation(connection);
      const scoped = view?.projectionVersion >= voiceRecipientProjectionVersion;
      if (!owner && !scoped && policy !== undefined) throw failure('UNVERIFIED_EPOCH_POLICY');
      const signers = scoped ? verifyAttestedVoiceRoster(view, basis, roster, policy) : await checkFullRoster(basis, roster);
      const self = roster.find(entry => entry.sessionId === connection.sessionId);
      if (self?.deviceId !== deviceId || self.profileId !== connection.profileId || self.publicKey !== recipientKey) {
        throw failure('UNVERIFIED_VOICE_ROSTER');
      }
      return signers;
    };
    await checkRoster(claim);
    if (claim.published === false) {
      const offer = createVoiceKeyOffer(claim.basis, claim.roster, connection.sessionId, device, claim.serverTime);
      try {
        await this.#protectedRuntimeVoiceRequest(connection, channelId, 'key', 'PUT', JSON.stringify(offer));
      } catch (error) {
        // A concurrent author may have won the same generation.
        if (error.code !== 'VOICE_GRANT_CHANGED') throw error;
      }
    }
    const requestedAt = Date.now();
    const delivery = await this.#protectedRuntimeVoiceRequest(connection, channelId, 'key', 'GET');
    verifyVoiceKeyBasis(delivery?.basis, delivery?.roster, delivery?.serverTime, expected);
    if (!isDeepStrictEqual(delivery.basis, claim.basis)) throw failure('VOICE_GRANT_CHANGED');
    const signers = await checkRoster(delivery);
    const signer = signers.get(delivery.authorSession);
    if (!signer) throw failure('UNVERIFIED_VOICE_ROSTER');
    const serverExpiresAt = delivery.basis.expiresAt;
    const expiresAt = requestedAt + serverExpiresAt - delivery.serverTime;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw failure('VOICE_GRANT_CHANGED');
    const secret = openVoiceKeyPackage(delivery, delivery.basis, delivery.roster, connection.sessionId, signer, privateKey, delivery.serverTime);
    return { epochId: delivery.basis.epochId, expiresAt, serverExpiresAt, secret };
  }
  async protectedRuntimeVoiceGrant(connection, channelId, mediaKey) {
    if (!hexID(channelId, 32) || !hexID(mediaKey?.epochId, 32) || !Number.isSafeInteger(mediaKey.serverExpiresAt) ||
        !Number.isSafeInteger(mediaKey.expiresAt) ||
        mediaKey.expiresAt <= Date.now()) throw failure('INVALID_PROTECTED_VOICE_REQUEST');
    const result = await this.fetchJSON(connection.base, '/api/v3/voice/join', {
      method: 'POST', body: JSON.stringify({ channelId, keyEpoch: mediaKey.epochId }), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (result?.keyEpoch !== mediaKey.epochId || result.serverDeafened !== undefined || result.identity !== connection.sessionId ||
        result.expiresAt > mediaKey.serverExpiresAt || mediaKey.expiresAt <= Date.now()) throw failure('INVALID_API_RESPONSE');
    return this.#validateProtectedVoiceGrant(result, connection, connection.serverId, channelId);
  }
  async #deafenedProtectedVoiceGrant(connection, channelId) {
    const result = await this.fetchJSON(connection.base, '/api/v3/voice/join', {
      method: 'POST', body: JSON.stringify({ channelId }), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (result?.serverDeafened !== true || result.identity !== connection.sessionId || result.keyEpoch !== undefined ||
        result.key !== undefined || result.epoch !== undefined) throw failure('INVALID_PROTECTED_VOICE_KEY');
    return this.#validateProtectedVoiceGrant(result, connection, connection.serverId, channelId);
  }
  async joinProtectedRuntimeVoice(connection, channelId, policyTrust) {
    const prepared = await this.prepareProtectedRuntimeVoice(connection, channelId);
    if (prepared?.ok !== true || prepared.deafened !== undefined && typeof prepared.deafened !== 'boolean') throw failure('INVALID_API_RESPONSE');
    if (prepared.deafened === true) {
      try { return await this.#deafenedProtectedVoiceGrant(connection, channelId); }
      catch (error) { if (error.code !== 'VOICE_GRANT_CHANGED') throw error; }
    }
    return this.reconnectProtectedRuntimeVoice(connection, channelId, policyTrust);
  }
  async reconnectProtectedRuntimeVoice(connection, channelId, policyTrust) {
    let mediaKey;
    try {
      mediaKey = await this.exchangeProtectedRuntimeVoiceKey(connection, channelId, policyTrust);
    } catch (error) {
      if (error.code !== 'PROTECTED_ACCESS_DENIED') throw error;
      const status = await this.#protectedRuntimeVoiceHeartbeat(connection, channelId, null).catch(probe => {
        if (probe.code === 'VOICE_SLOT_LOST') throw error;
        throw probe;
      });
      if (status.deafened !== true) throw error;
      return this.#deafenedProtectedVoiceGrant(connection, channelId);
    }
    const { secret, epochId, expiresAt, serverExpiresAt } = mediaKey;
    try {
      const grant = await this.protectedRuntimeVoiceGrant(connection, channelId, { epochId, expiresAt, serverExpiresAt });
      return { ...grant, key: secret.toString('hex'), epoch: { epochId, expiresAt } };
    } finally {
      secret.fill(0);
    }
  }
  async #protectedRuntimeVoiceHeartbeat(connection, channelId, epochId) {
    if (epochId !== null && !hexID(epochId, 32)) throw failure('INVALID_PROTECTED_VOICE_REQUEST');
    const hint = await this.#protectedRuntimeVoiceRequest(connection, channelId, 'key/heartbeat', 'POST',
      JSON.stringify(epochId === null ? {} : { epochId }));
    if (typeof hint?.refresh !== 'boolean' || hint.deafened !== undefined && typeof hint.deafened !== 'boolean' ||
        hint.deafened === true && hint.refresh) throw failure('INVALID_API_RESPONSE');
    return hint;
  }
  async refreshProtectedRuntimeVoiceKey(connection, channelId, policyTrust, currentEpoch) {
    const hint = await this.#protectedRuntimeVoiceHeartbeat(connection, channelId, currentEpoch);
    if (hint.deafened === true) return { serverDeafened: true };
    if (!hint.refresh) return null;
    const { secret, epochId, expiresAt } = await this.exchangeProtectedRuntimeVoiceKey(connection, channelId, policyTrust);
    try {
      return epochId === currentEpoch ? null : { epochId, expiresAt, key: secret.toString('hex') };
    } finally {
      secret.fill(0);
    }
  }
  async protectedRuntimeVoiceDestination(connection) {
    const result = await this.fetchJSON(connection.base, '/api/v3/voice/move', {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (result?.channelId !== '' && !hexID(result?.channelId, 32)) throw failure('INVALID_API_RESPONSE');
    return result.channelId;
  }
  async moveProtectedRuntimeVoice(connection, profileId, sourceChannelId, destinationChannelId) {
    if (!hexID(profileId, 64)) throw failure('INVALID_ACTION');
    return this.#requestProtectedRuntimeVoiceMove(connection, { profileId }, sourceChannelId, destinationChannelId);
  }
  async protectedRuntimeVoiceMoveChoices(connection, sourceChannelId, targetSessionId) {
    if (!hexID(sourceChannelId, 32) || !hexID(targetSessionId, 32)) throw failure('INVALID_ACTION');
    const result = await this.fetchJSON(connection.base, `/api/v3/voice/${sourceChannelId}/move-choices/${targetSessionId}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    const destinations = result?.destinations;
    if (!Array.isArray(destinations) || destinations.length > 1000 || new Set(destinations).size !== destinations.length ||
        destinations.some(channelId => !hexID(channelId, 32) || channelId === sourceChannelId)) throw failure('INVALID_API_RESPONSE');
    return destinations;
  }
  async protectedRuntimeVoiceRestrictionChoices(connection, sourceChannelId, targetSessionId) {
    if (!hexID(sourceChannelId, 32) || !hexID(targetSessionId, 32)) throw failure('INVALID_ACTION');
    const supportsServerWide = connection.config?.protectedVoiceControls === true;
    const query = supportsServerWide ? '?serverWide=1' : '';
    const result = await this.fetchJSON(connection.base, `/api/v3/voice/${sourceChannelId}/restriction-choices/${targetSessionId}${query}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    const { actions, profileId, canDisconnect } = result ?? {};
    if (!Array.isArray(actions) || actions.length > (supportsServerWide ? 4 : 2) ||
        actions.some(entry => !['voice.mute', 'voice.deafen'].includes(entry?.action) || typeof entry.lift !== 'boolean' ||
          (entry.serverWide !== undefined && (!supportsServerWide || entry.serverWide !== true))) ||
        new Set(actions.map(entry => `${entry.action}:${!!entry.serverWide}`)).size !== actions.length ||
        canDisconnect !== undefined && typeof canDisconnect !== 'boolean' ||
        (actions.length ? !hexID(profileId, 64) : profileId !== undefined)) throw failure('INVALID_API_RESPONSE');
    return { actions: actions.map(({ action, lift, serverWide }) => ({ action, lift, ...(serverWide && { serverWide }) })), profileId, ...(canDisconnect && { canDisconnect }) };
  }
  async disconnectProtectedRuntimeVoice(connection, sourceChannelId, targetSessionId) {
    if (!hexID(sourceChannelId, 32) || !hexID(targetSessionId, 32)) throw failure('INVALID_ACTION');
    const result = await this.fetchJSON(connection.base, `/api/v3/voice/${sourceChannelId}/disconnect/${targetSessionId}`, {
      method: 'POST', body: '{}', fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (result?.disconnected !== true) throw failure('INVALID_API_RESPONSE');
  }
  async protectedRuntimeVoiceTelemetry(connection, channelId, sample, collectCommands = false) {
    if (connection.config?.protectedVoiceControls !== true) return collectCommands ? { peers: [], commands: [] } : [];
    const enabled = collectCommands && connection.config?.protectedVoiceChannelControls === true;
    const { muted, ...network } = sample;
    const response = await this.fetchJSON(connection.base, `/api/v3/voice/${channelId}/telemetry${enabled ? '?channelControls=1' : ''}`, {
      method: 'POST', body: JSON.stringify({ ...network, ...(enabled && muted && { muted }) }), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    const peers = enabled ? response?.peers : response;
    const commands = enabled ? response?.commands : [];
    if (!Array.isArray(commands) || commands.length > 2 || commands.some(command => !hexID(command?.id, 32) ||
      !['voice.mute', 'voice.deafen'].includes(command.action))) throw failure('INVALID_API_RESPONSE');
    const valid = (value, max) => value === null || (Number.isFinite(value) && value >= 0 && value <= max);
    if (!Array.isArray(peers) || peers.length > 8192 || peers.some(peer =>
      !hexID(peer?.sessionId, 32) || !valid(peer.rtt, 60000) || !valid(peer.loss, 100) ||
      (peer.deafened !== undefined && typeof peer.deafened !== 'boolean'))) throw failure('INVALID_API_RESPONSE');
    const samples = peers.map(({ sessionId, rtt, loss, deafened }) => ({ sessionId, rtt, loss, ...(deafened && { deafened }) }));
    return collectCommands ? { peers: samples, commands: commands.map(({ id, action }) => ({ id, action })) } : samples;
  }
  async changeProtectedRuntimeVoiceRestriction(connection, sourceChannelId, targetSessionId, action, lift, serverWide = false) {
    if (!['voice.mute', 'voice.deafen'].includes(action) || typeof lift !== 'boolean' || typeof serverWide !== 'boolean') throw failure('INVALID_ACTION');
    const { actions, profileId } = await this.protectedRuntimeVoiceRestrictionChoices(connection, sourceChannelId, targetSessionId);
    if (!actions.some(option => option.action === action && option.lift === lift && !!option.serverWide === serverWide)) throw failure('PROTECTED_ACCESS_DENIED');
    if (!serverWide && !lift && connection.config?.protectedVoiceChannelControls === true) {
      const receipt = await this.fetchJSON(connection.base, `/api/v3/voice/${sourceChannelId}/channel-control/${targetSessionId}`, {
        method: 'POST', body: JSON.stringify({ action }), fingerprint: connection.fingerprint,
        headers: { Authorization: `Bearer ${connection.token}` },
      });
      if (receipt?.queued !== true) throw failure('INVALID_API_RESPONSE');
      return;
    }
    await this.readProtectedManagementPolicy(connection);
    const trust = connection.policyTrust;
    const intent = { Action: action, OperationID: requestID(), ResourceChange: {
      ID: sourceChannelId, TargetProfileID: profileId, VoiceTargetSessionID: targetSessionId, ...(lift && { Lift: true }),
      ...(serverWide && { Mode: action === 'voice.deafen' && connection.config?.protectedVoiceMediaDeafen === true ? 'server-media' : 'server' }),
    } };
    const preview = await this.previewProtectedRuntimePolicy(connection, intent, trust);
    await this.commitProtectedRuntimePolicy(connection, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, trust);
  }
  async moveProtectedRuntimeVoiceSession(connection, targetSessionId, sourceChannelId, destinationChannelId) {
    if (!hexID(targetSessionId, 32)) throw failure('INVALID_ACTION');
    return this.#requestProtectedRuntimeVoiceMove(connection, { targetSessionId }, sourceChannelId, destinationChannelId);
  }
  async #requestProtectedRuntimeVoiceMove(connection, target, sourceChannelId, destinationChannelId) {
    if (!hexID(sourceChannelId, 32) || !hexID(destinationChannelId, 32) || sourceChannelId === destinationChannelId) throw failure('INVALID_ACTION');
    const result = await this.fetchJSON(connection.base, '/api/v3/voice/move', {
      method: 'POST', body: JSON.stringify({ ...target, sourceChannelId, destinationChannelId }),
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (result?.pending !== true) throw failure('INVALID_API_RESPONSE');
  }
  async leaveProtectedRuntimeVoice(connection) {
    const receipt = await this.fetchJSON(connection.base, '/api/v3/voice/leave', {
      method: 'POST', body: '{}', fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (receipt?.ok !== true) throw failure('INVALID_API_RESPONSE');
  }
  async readProtectedImportedHistory(connection, channelId, { after = 0, limit = 32 } = {}) {
    if (!hexID(channelId, 32) || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
      throw failure('INVALID_MIGRATION_PAGE');
    }
    const page = await this.fetchJSON(connection.base, `/api/v3/history/imported/${channelId}?after=${after}&limit=${limit}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!Number.isSafeInteger(page?.first) || page.first < 1 || !Array.isArray(page.messages) || page.messages.length > limit || page.messages.some((entry, index) =>
      !Number.isSafeInteger(entry?.position) || entry.position <= (index === 0 ? after : page.messages[index - 1].position) ||
      entry.position < page.first ||
      !hexID(entry.effectiveAuthor, 64) || entry.dedicatedDeletion !== undefined && typeof entry.dedicatedDeletion !== 'boolean' ||
      entry.completedPoll !== undefined && typeof entry.completedPoll !== 'boolean' || entry.completedPoll && !entry.dedicatedDeletion ||
      entry.originalPollPosition !== undefined && (!Number.isSafeInteger(entry.originalPollPosition) ||
        entry.originalPollPosition < page.first || entry.originalPollPosition >= entry.position || !entry.dedicatedDeletion) ||
      entry.cannotEdit !== undefined && typeof entry.cannotEdit !== 'boolean' || entry.revision !== undefined && !revisionNumber(entry.revision) ||
      entry.packet?.kind !== 'messages' || entry.packet.metadata?.channelId !== channelId) ||
      page.next !== undefined && (page.messages.length !== limit || page.next !== page.messages.at(-1)?.position)) {
      throw failure('INVALID_API_RESPONSE');
    }
    return page;
  }
  async loadProtectedImportedHistoryLink(connection, channelId) {
    if (!hexID(channelId, 32)) throw failure('INVALID_MIGRATION_HISTORY_LINK');
    const link = await this.fetchJSON(connection.base, `/api/v3/history/imported/${channelId}/link`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (link?.channelId !== channelId || ![link?.archiveSha256, link?.anchorDigest, link?.archiveKeyId, link?.epochDigest,
      link?.importedKeyId, link?.deviceId].every(value => hexID(value, 64)) ||
      typeof link.link?.ciphertext !== 'string' || typeof link.link?.signature !== 'string') throw failure('INVALID_API_RESPONSE');
    return link;
  }
  async #loadProtectedRuntimeKeyDelivery(connection, channelId, purpose, policyTrust, keyId, scoped = false) {
    if (!hexID(channelId, 32) || !['live', 'archive'].includes(purpose) || policyTrust?.serverId !== connection.serverId ||
        (keyId !== undefined && (purpose !== 'live' || !hexID(keyId, 64)))) {
      throw failure('INVALID_PROTECTED_KEY_REQUEST');
    }
    const path = keyId === undefined ? `/api/v3/keys/current/${channelId}/${purpose}` : `/api/v3/keys/admitted/${channelId}/${keyId}`;
    const delivery = await this.fetchJSON(connection.base, path + (scoped ? '?scoped=1' : ''), {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` }, proofResponse: scoped,
    });
    const record = delivery?.Epoch?.Record;
    if (record?.ChannelID !== channelId || record.Purpose !== purpose ||
        (keyId !== undefined && record.KeyID !== keyId)) throw failure('INVALID_API_RESPONSE');
    const { deviceId } = await this.identity();
    if (deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
    const privateKey = await loadDeviceAgreementKey(this.credentials, connection.serverId, deviceId, false);
    const recipientKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const context = packageContext(connection.serverId, record, deviceId, recipientKey);
    return { delivery, context, privateKey };
  }
  async loadProtectedRuntimeKey(connection, channelId, purpose, trustOptions) {
    const scoped = await this.#usesScopedTextPolicy(connection);
    const { delivery, context, privateKey } =
      await this.#loadProtectedRuntimeKeyDelivery(connection, channelId, purpose, trustOptions.policyTrust, undefined, scoped);
    if (scoped) return this.#openScopedEpochPackage(connection, delivery, context, privateKey);
    const secret = await this.openProtectedEpochPackage(delivery, context, privateKey, {
      ...trustOptions, textDisclosure: delivery.textPolicy, requireTextDisclosure: true,
      liveProfileId: purpose === 'live' ? connection.profileId : undefined,
    });
    return { record: delivery.Epoch.Record, secret };
  }
  async #usesScopedTextPolicy(connection) {
    const trust = connection.policyTrust;
    return !!trust && !isProtectedOwner(connection) &&
      (connection.canInspectProtectedPolicy === false || connection.ownership?.transferred === true ||
        !(await this.policyCheckpoint().load(trust))?.complete);
  }
  #clearTextStatus(serverId, keep = () => false) {
    for (const map of [this.#textStatusFailures, this.#textStatusChecks]) {
      for (const [id, status] of map) {
        if (status.serverId === serverId && !keep(status.channelId)) map.delete(id);
      }
    }
  }
  async readProtectedTextStatus(serverId, channelId, connection, offline = false) {
    if (!hexID(serverId, 32) || !hexID(channelId, 32)) throw failure('INVALID_INPUT');
    const slot = `${serverId}:${channelId}`;
    const existingFailure = () => this.#textStatusFailures.get(slot);
    if (offline || connection?.serverId !== serverId || !connection.policyTrust) {
      this.#textStatusChecks.delete(slot);
      return classifyProtectedTextStatus({ serverId, channelId, online: false, knownFailure: existingFailure() });
    }
    const previous = this.#textStatusChecks.get(slot);
    if (previous?.connection === connection) return previous.operation;
    const check = { serverId, channelId, connection };
    check.operation = (async () => {
      let status;
      try {
        status = await this.#probeProtectedTextStatus(connection, channelId);
      } catch (error) {
        if (error.code === 'RATE_LIMIT') throw error;
        const reason = textProtectionFailures.get(error.code ?? error.message);
        if (reason) status = { state: 'red', reason, allowSend: false };
        else if (['POLICY_ATTESTATION_UNAVAILABLE', 'UNVERIFIED_EPOCH_POLICY'].includes(error.code)) {
          status = { state: 'grey', reason: 'POLICY_PROOF_PENDING', allowSend: false };
        }
        else status = classifyProtectedTextStatus({ serverId, channelId, online: !isConnectionFailure(error), knownFailure: existingFailure() });
      }
      if (this.#textStatusChecks.get(slot) !== check) {
        return classifyProtectedTextStatus({ serverId, channelId, online: false, knownFailure: existingFailure() });
      }
      if (status.state === 'red') {
        if (this.#textStatusFailures.size >= 256 && !this.#textStatusFailures.has(slot)) {
          this.#textStatusFailures.delete(this.#textStatusFailures.keys().next().value);
        }
        this.#textStatusFailures.set(slot, { serverId, channelId, reason: status.reason });
      } else if (status.state === 'green' || status.allowSend) {
        this.#textStatusFailures.delete(slot);
      } else if (existingFailure()) {
        return classifyProtectedTextStatus({ serverId, channelId, online: true, knownFailure: existingFailure() });
      }
      return status;
    })().finally(() => {
      if (this.#textStatusChecks.get(slot) === check) this.#textStatusChecks.delete(slot);
    });
    this.#textStatusChecks.set(slot, check);
    return check.operation;
  }
  async #probeProtectedTextStatus(connection, channelId) {
    const { serverId, fingerprint, policyTrust: trust, profileId, deviceId } = connection;
    const metadata = await this.fetchJSON(connection.base, `/api/v3/protection/${channelId}/window`, {
      fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    const receivedAt = performance.now();
    const window = validateProtectedTextWindow(metadata);
    const describe = evidence => {
      const status = classifyProtectedTextStatus({ serverId, channelId, online: true, window, receivedAt, now: performance.now(), ...evidence });
      if (metadata.deferredSend === true && status.state !== 'grey' && evidence.policy?.canSend === true) {
        status.deferredBasis = { revision: window.policyRevision, head: window.policyHead };
      }
      return status;
    };
    let policy;
    if (await this.#usesScopedTextPolicy(connection)) {
      const view = await this.readProtectedPolicyAttestation(connection).catch(error => {
        if (error.code !== 'POLICY_ATTESTATION_UNAVAILABLE') throw error;
      });
      if (view) {
        if (view.revision !== window.policyRevision || view.digest !== window.policyHead) return describe({});
        const privateKey = await loadDeviceAgreementKey(this.credentials, serverId, deviceId, false);
        const recipientKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
        const disclosure = await this.fetchProtectedRuntimeTextChannelProof(connection, channelId);
        if (disclosure?.revision !== view.revision || disclosure.policyDigest !== view.policyDigest) return describe({});
        const admitted = verifyAttestedTextAdmission(view, channelId, disclosure, { recipientId: deviceId, recipientKey, purpose: 'live', profileId });
        policy = { revision: view.revision, head: view.digest, canSend: admitted.canSend === true };
      }
    } else {
      const checkpoint = this.policyCheckpoint();
      let known = await checkpoint.load(trust);
      if ((!known?.complete || known.revision < window.policyRevision) && isProtectedOwner(connection)) {
        await this.refreshProtectedRuntimePolicy(connection, trust);
        known = await checkpoint.load(trust);
      }
      if (known && known.revision > window.policyRevision) await this.readProtectedPolicyAttestation(connection);
      if (!known?.complete || known.revision !== window.policyRevision || known.digest !== window.policyHead) return describe({});
      const snapshot = JSON.parse(Buffer.from(known.snapshot, 'base64'));
      const grants = channelGrantSummary(snapshot, profileId, channelId, 'message.send', window.serverNow);
      if (!grants.visible.includes(channelId)) return describe({});
      policy = { revision: known.revision, head: known.digest, canSend: grants.allowed === true };
    }
    if (!window.currentGeneration) return describe({ policy, keyState: 'pending' });
    try {
      const { record, secret, liveTransition } = await this.loadProtectedRuntimeKey(connection, channelId, 'live', {
        policyTrust: trust, fetchPolicyPage: after => this.fetchProtectedRuntimePolicyPage(connection, after),
        fetchEpochProofs: (channel, purpose, after, through) => this.fetchProtectedRuntimeEpochProofs(connection, channel, purpose, after, through),
      });
      try {
        if (record.Generation > window.currentGeneration) return describe({});
        if (!policy && liveTransition) {
          policy = { revision: liveTransition.policy?.revision ?? record.Revision, head: liveTransition.successorHead,
            canSend: liveTransition.admission.canSend === true };
        }
        return describe({ policy, key: { generation: record.Generation, keyId: record.KeyID } });
      } finally {
        secret.fill(0);
      }
    } catch (error) {
      if (error.code === 'PROTECTED_KEY_PENDING') return describe({ policy, keyState: 'pending' });
      throw error;
    }
  }
  #verifiedScopedSigner(record, author, disclosure, attestation) {
    if (!hexID(author?.ProfileID, 64) || !hexID(author?.DeviceID, 64) ||
        attestation?.revision !== record.Revision || attestation?.policyDigest !== record.PolicyDigest) {
      throw failure('UNVERIFIED_EPOCH_POLICY');
    }
    const statement = verifyAttestedTextAdmission(attestation, record.ChannelID, disclosure, {
      recipientId: author.DeviceID, recipientKey: disclosure?.recipient?.statement?.publicKey,
      purpose: record.Purpose, profileId: author.ProfileID,
    });
    return { profileId: author.ProfileID, deviceId: author.DeviceID, key: statement.signingKey };
  }
  async #scopedEpochPolicy(connection, delivery, context) {
    const current = await this.readProtectedPolicyAttestation(connection);
    const recipient = { ...context, profileId: connection.profileId };
    const admitted = verifyAttestedTextAdmission(current, context.channelId, delivery.textPolicy, recipient);
    return { current, admitted, recipient, ...this.#scopedEpochVerifier(connection, current) };
  }
  #scopedEpochVerifier(connection, current, read = operation => operation()) {
    const attestations = new Map();
    const attest = revision => {
      if (revision > current.revision) return Promise.reject(failure('UNVERIFIED_EPOCH_POLICY'));
      if (revision === current.revision) return Promise.resolve(current);
      if (attestations.has(revision)) {
        const cached = attestations.get(revision);
        attestations.delete(revision);
        attestations.set(revision, cached);
        return cached;
      }
      const pending = read(() => this.readProtectedPolicyAttestation(connection, revision)).catch(error => {
        if (attestations.get(revision) === pending) attestations.delete(revision);
        throw error;
      });
      if (attestations.size >= 32) attestations.delete(attestations.keys().next().value);
      attestations.set(revision, pending);
      return pending;
    };
    const inviteTransition = async proof => {
      const { ChannelID: channelId, Revision: revision, PolicyDigest: policyDigest, Generation: generation, KeyID: keyId } = proof.Record;
      const evidence = inviteEpochEvidence(proof);
      if (!transitionBaseMatches(evidence, revision) || evidence.previousRevision > current.revision) {
        throw failure('UNVERIFIED_EPOCH_POLICY');
      }
      const predecessor = await attest(evidence.previousRevision);
      const issuance = await this.#inviteIssuanceAttestations(predecessor, evidence, attest);
      const verifySigner = evidence.admissions ? verifyInviteAdmissionBatchEpochSigner : verifyInviteAdmissionEpochSigner;
      const verified = verifySigner(connection.policyTrust, predecessor, issuance, proof, evidence);
      return { ...verified, predecessor, channelId, revision, policyDigest, generation, keyId };
    };
    const roleAssignmentTransition = async proof => {
      epochTextTransition(proof, proof.Record.Purpose);
      const { previousRevision } = roleAssignmentBase(proof.roleAssignment, proof.Record.Revision);
      const predecessor = await attest(previousRevision);
      const verified = verifyRoleAssignmentEpochSigner(connection.policyTrust, predecessor, proof, proof.roleAssignment);
      return { ...verified, predecessor, assignment: proof.roleAssignment.record };
    };
    const signer = async proof => {
      const evidence = epochTextTransition(proof, proof.Record.Purpose);
      const basis = await attest(proof.Record.Revision).catch(error => {
        if (!['POLICY_ATTESTATION_UNAVAILABLE', 'UNVERIFIED_EPOCH_POLICY'].includes(error.code) || !evidence ||
            !(proof.roleAssignment || inviteEpochEvidence(proof))) throw error;
      });
      if (basis) return this.#verifiedScopedSigner(proof.Record, proof.Principal, proof.signingPolicy, basis);
      return (await (proof.roleAssignment ? roleAssignmentTransition(proof) : inviteTransition(proof))).signer;
    };
    const verify = async proof => verifySignedEpoch(proof, packageContext(connection.serverId, proof.Record), await signer(proof));
    const fetchProofs = (channel, purpose, after, through) =>
      read(() => this.fetchProtectedRuntimeEpochProofs(connection, channel, purpose, after, through, true));
    return { attest, signer, verify, fetchProofs, inviteTransition, roleAssignmentTransition };
  }
  async #openScopedEpochPackage(connection, delivery, context, privateKey, historical = false, verifiedTransition) {
    const trust = connection.policyTrust;
    if (historical && verifiedTransition && context.purpose === 'live' && context.kind !== 'recovery') {
      return this.#openEarlierLiveTransitionPackage(connection, delivery, context, privateKey, verifiedTransition);
    }
    const scope = historical ? await this.#scopedEpochPolicy(connection, delivery, context)
      : await this.#scopedCurrentEpochPolicy(connection, delivery, context);
    if (scope.transition) return this.#openTransitionPackage(connection, delivery, context, privateKey, scope);
    const { current, admitted, recipient, attest } = scope;
    const epoch = delivery.Epoch;
    if (context.kind === 'recovery' && (!historical || admitted.archive || context.purpose !== 'live')) {
      throw failure('UNVERIFIED_EPOCH_RECIPIENT');
    }
    const basis = await attest(epoch.Record.Revision).catch(error => {
      if (!historical || context.kind === 'recovery' || !(delivery.roleAssignment || inviteEpochEvidence(delivery, 'live')) ||
          error.code !== 'POLICY_ATTESTATION_UNAVAILABLE') throw error;
    });
    if (!basis) {
      const transition = await this.#verifiedHistoricalTransitionDelivery(connection, delivery, recipient, attest);
      if (transition.admission.firstPosition !== admitted.firstPosition) throw failure('UNVERIFIED_EPOCH_RECIPIENT');
      return this.#openTransitionPackage(connection, delivery, context, privateKey,
        { transition, signer: async () => transition.signer }, historical);
    }
    if (context.purpose === 'live' && (historical || !admitted.archive)) {
      const disclosure = basis.revision === current.revision ? delivery.textPolicy : delivery.admissionPolicy;
      const started = verifyAttestedTextAdmission(basis, context.channelId, disclosure, recipient);
      if (started.firstPosition !== admitted.firstPosition) throw failure('UNVERIFIED_EPOCH_RECIPIENT');
    }
    const signer = this.#verifiedScopedSigner(epoch.Record, epoch.Principal, epoch.signingPolicy, basis);
    const open = context.kind === 'recovery' ? openSignedRecoveryEpochPackage : openSignedEpochPackage;
    const secret = open(delivery, context, privateKey, signer);
    try {
      if (hash(secret) !== context.keyId) throw failure('EPOCH_KEY_MISMATCH');
      if (!historical) {
        const livePolicy = context.purpose === 'live' && current.projectionVersion === profileRoleAuthorityProjectionVersion
          ? current : undefined;
        await this.epochCheckpoint().run(trust, context.channelId, context.purpose,
          continuity => continuity.accept(epoch, scope.verify, scope.fetchProofs, undefined, livePolicy));
      }
      return { record: epoch.Record, secret, admission: admitted.archive ? 1 : admitted.firstPosition, scopedBasis: basis };
    } catch (error) {
      secret.fill(0);
      throw error;
    }
  }
  async #scopedCurrentEpochPolicy(connection, delivery, context) {
    const { Epoch: head } = delivery;
    const archive = context.purpose === 'archive';
    const roleProof = archive ? delivery.archiveRoleViewDeny : delivery.liveRoleViewDeny;
    const personalProof = archive ? delivery.archivePersonalDeny : delivery.livePersonalDeny;
    const denyProof = scopedDenyEvidence(roleProof, personalProof);
    const inviteProof = inviteEpochEvidence(delivery, context.purpose);
    const assignment = delivery.roleAssignment;
    const evidence = selectTextTransition(assignment, inviteProof, denyProof);
    const base = assignment ? roleAssignmentBase(assignment, head?.Record?.Revision) : evidence;
    const invalid = assignment ? 'INVALID_ROLE_ASSIGNMENT_TRANSITION' : inviteProof ? 'INVALID_PROTECTED_INVITE_PROOF' : undefined;
    const roleDeny = roleProof !== undefined;
    const digest = archive ? head?.Record?.ArchiveTransitionDigest : head?.Record?.LiveTransitionDigest;
    const canVerifyTransition = !!evidence && !!digest && context.kind !== 'recovery';
    const liveHistory = delivery.liveRoleHistory;
    if (liveHistory !== undefined && (archive || context.kind === 'recovery' || !liveHistory?.transition?.record)) {
      throw failure('INVALID_ROLE_ASSIGNMENT_TRANSITION');
    }
    const current = await this.#scopedEpochPolicy(connection, delivery, context).catch(error => {
      if (error.code !== 'POLICY_ATTESTATION_UNAVAILABLE' || !(canVerifyTransition || liveHistory)) throw error;
    });
    if (!current && liveHistory) return this.#scopedLiveRoleHistoryPolicy(connection, delivery, context);
    if (current && (!canVerifyTransition || head.Record.Revision >= current.current.revision)) return current;
    if (current) {
      try { await current.attest(head.Record.Revision); return current; }
      catch (error) { if (error.code !== 'POLICY_ATTESTATION_UNAVAILABLE') throw error; }
    }
    const predecessor = current ? await this.readProtectedPolicyAttestation(connection, base.previousRevision)
      : await this.#pinTransitionPredecessor(connection, base, head.Record, invalid);
    const recipient = { ...context, profileId: connection.profileId };
    const verifyDelivery = roleDeny ? verifyRoleViewDenyDelivery : verifyPersonalDenyDelivery;
    const prior = this.#scopedEpochVerifier(connection, predecessor);
    const verified = assignment ? verifyRoleAssignmentDelivery(connection.policyTrust, predecessor, delivery, recipient) :
      inviteProof ? await this.#verifiedInviteDelivery(connection, delivery, recipient, prior.attest) :
        verifyDelivery(connection.policyTrust, predecessor, delivery, recipient);
    const { admission: previousAdmission, signer: headSigner } = verified;
    const excludedProfiles = assignment
      ? new Set(verified.delta.newAccess.canSend ? [] : [verified.delta.profileId])
      : verified.excludedProfiles ?? new Set([evidence.targetProfileId]);
    if (current && current.admitted.firstPosition !== previousAdmission.firstPosition) throw failure('UNVERIFIED_EPOCH_RECIPIENT');
    verifySignedEpoch(head, context, headSigner);
    const archiveDenyField = roleDeny ? 'archiveRoleViewDeny' : 'archivePersonalDeny';
    const signer = async proof => {
      if (proof.Record.Revision <= predecessor.revision) return prior.signer(proof);
      if (isDeepStrictEqual(proof.Record, head.Record) && isDeepStrictEqual(proof.Principal, head.Principal)) return headSigner;
      if (assignment && proof.roleAssignment && proof.Record.Purpose === head.Record.Purpose &&
          proof.Record.Generation < head.Record.Generation && proof.Record.Revision === head.Record.Revision &&
          proof.Record[archive ? 'ArchiveTransitionDigest' : 'LiveTransitionDigest'] === digest) {
        return (await prior.roleAssignmentTransition(proof)).signer;
      }
      if (inviteProof !== undefined && proof.Record.Revision < head.Record.Revision && inviteEpochEvidence(proof)) {
        return (await prior.inviteTransition(proof)).signer;
      }
      if (archive && proof.Record.Purpose === 'archive' && proof.Record.Generation < head.Record.Generation &&
          proof.Record.Revision === head.Record.Revision && proof.Record.ArchiveTransitionDigest === digest) {
        if (inviteProof !== undefined && inviteEpochEvidence(proof)) return (await prior.inviteTransition(proof)).signer;
        if (!assignment && inviteProof === undefined && proof[archiveDenyField]) {
          return verifyDelivery(connection.policyTrust, predecessor, { Epoch: proof, [archiveDenyField]: proof[archiveDenyField] }, recipient).signer;
        }
      }
      if (current) return current.signer(proof);
      throw failure('UNVERIFIED_EPOCH_POLICY');
    };
    const verify = async proof => verifySignedEpoch(proof, packageContext(connection.serverId, proof.Record), await signer(proof));
    const admission = current?.admitted ?? previousAdmission;
    const firstAdmittedRevision = assignment && verified.delta.profileId === connection.profileId && !verified.delta.oldAccess.view
      ? head.Record.Revision : undefined;
    const transition = { ...verified, predecessor, admission, successorHead: base.successorHead, excludedProfiles, record: head.Record,
      ...(assignment && { assignment: assignment.record, firstAdmittedRevision, policy: current?.current ?? {
        revision: head.Record.Revision, digest: base.successorHead, previous: predecessor.digest, policyDigest: head.Record.PolicyDigest,
      } }) };
    return { ...(current ?? prior), verify, signer, transition };
  }
  async #scopedLiveRoleHistoryPolicy(connection, delivery, context) {
    const { Epoch: head, liveRoleHistory: { archive, transition: evidence } } = delivery;
    const revision = evidence.record.Draft?.Revision;
    const base = roleAssignmentBase(evidence, revision);
    const predecessor = await this.#pinTransitionPredecessor(connection, base, { Revision: revision }, 'INVALID_ROLE_ASSIGNMENT_TRANSITION');
    const prior = this.#scopedEpochVerifier(connection, predecessor);
    const recipient = { ...context, profileId: connection.profileId };
    const { admission, policy, signer: archiveSigner } = verifyLiveRoleHistory(connection.policyTrust, predecessor, delivery, recipient);
    if (archive) verifySignedEpoch(archive, packageContext(connection.serverId, archive.Record), archiveSigner);
    const scopedBasis = await prior.attest(head.Record.Revision).catch(error => {
      if (error.code !== 'POLICY_ATTESTATION_UNAVAILABLE' || !(delivery.roleAssignment || inviteEpochEvidence(delivery, 'live'))) throw error;
    });
    let epochAuthorTransition, headSigner;
    if (scopedBasis) {
      headSigner = this.#verifiedScopedSigner(head.Record, head.Principal, head.signingPolicy, scopedBasis);
      if (!admission.archive) {
        const original = head.Record.Revision === predecessor.revision ? evidence.previousViewerTextPolicy : delivery.admissionPolicy;
        const opened = verifyAttestedTextAdmission(scopedBasis, context.channelId, original, recipient);
        if (opened.firstPosition !== admission.firstPosition) throw failure('UNVERIFIED_EPOCH_RECIPIENT');
      }
    } else {
      epochAuthorTransition = await this.#verifiedHistoricalTransitionDelivery(connection, delivery, recipient, prior.attest);
      if (epochAuthorTransition.admission.firstPosition !== admission.firstPosition) throw failure('UNVERIFIED_EPOCH_RECIPIENT');
      headSigner = epochAuthorTransition.signer;
    }
    const signer = proof => proof === head ? headSigner : prior.signer(proof);
    const verify = async proof => verifySignedEpoch(proof, packageContext(connection.serverId, proof.Record), await signer(proof));
    return { ...prior, verify, signer, scopedBasis, epochAuthorTransition,
      transition: { predecessor, admission, policy, successorHead: policy.digest, record: head.Record } };
  }
  async #verifiedInviteDelivery(connection, delivery, recipient, attest) {
    const proof = inviteEpochEvidence(delivery, recipient.purpose);
    if (!transitionBaseMatches(proof, delivery.Epoch.Record.Revision)) throw failure('INVALID_PROTECTED_INVITE_PROOF');
    const predecessor = await attest(proof.previousRevision);
    const issuance = await this.#inviteIssuanceAttestations(predecessor, proof, attest);
    const verifyDelivery = proof.admissions ? verifyInviteAdmissionBatchDelivery : verifyInviteAdmissionDelivery;
    return verifyDelivery(connection.policyTrust, predecessor, issuance, delivery, recipient);
  }
  async #verifiedHistoricalTransitionDelivery(connection, delivery, recipient, attest) {
    const assignment = delivery.roleAssignment;
    epochTextTransition(delivery, recipient.purpose);
    if (!assignment) return this.#verifiedInviteDelivery(connection, delivery, recipient, attest);
    const { previousRevision } = roleAssignmentBase(assignment, delivery.Epoch.Record.Revision);
    const predecessor = await attest(previousRevision);
    const verified = verifyRoleAssignmentDelivery(connection.policyTrust, predecessor, delivery, recipient);
    return { ...verified, predecessor, assignment: assignment.record };
  }
  async #openTransitionPackage(connection, delivery, context, privateKey, scope, historical = false) {
    const { Epoch: epoch } = delivery;
    const { transition } = scope;
    const secret = openSignedEpochPackage(delivery, context, privateKey, await scope.signer(epoch));
    try {
      if (hash(secret) !== context.keyId) throw failure('EPOCH_KEY_MISMATCH');
      if (!historical) {
        const livePolicy = context.purpose === 'live' ? transition.policy : undefined;
        await this.epochCheckpoint().run(connection.policyTrust, context.channelId, context.purpose,
          continuity => continuity.accept(epoch, scope.verify, scope.fetchProofs, undefined, livePolicy));
      }
      return { record: epoch.Record, secret, admission: transition.admission.archive ? 1 : transition.admission.firstPosition,
        ...(context.purpose === 'live' && { liveTransition: transition, scopedBasis: scope.scopedBasis,
          epochAuthorTransition: scope.epochAuthorTransition }) };
    } catch (error) {
      secret.fill(0);
      throw error;
    }
  }
  async #openEarlierLiveTransitionPackage(connection, delivery, context, privateKey, transition) {
    const { Record: record, Principal: principal, signingPolicy } = delivery.Epoch;
    const applicant = inviteApplicant(transition, connection.profileId);
    if (record.Revision < (applicant?.revision ?? transition.firstAdmittedRevision ?? 1)) throw failure('PROTECTED_ACCESS_DENIED');
    const scope = this.#scopedEpochVerifier(connection, transition.predecessor);
    const basis = await scope.attest(record.Revision).catch(error => {
      if (!['POLICY_ATTESTATION_UNAVAILABLE', 'UNVERIFIED_EPOCH_POLICY'].includes(error.code) ||
          !(delivery.roleAssignment || inviteEpochEvidence(delivery, 'live'))) throw error;
    });
    if (!basis) {
      const earlier = await this.#verifiedHistoricalTransitionDelivery(connection, delivery,
        { ...context, profileId: connection.profileId }, scope.attest);
      if (earlier.admission.firstPosition !== transition.admission.firstPosition) throw failure('UNVERIFIED_EPOCH_RECIPIENT');
      await this.epochCheckpoint().run(connection.policyTrust, context.channelId, 'live', continuity =>
        continuity.verifyAncestor(delivery.Epoch, transition.record, proof => proof === delivery.Epoch
          ? verifySignedEpoch(proof, context, earlier.signer) : scope.verify(proof), scope.fetchProofs));
      return this.#openTransitionPackage(connection, delivery, context, privateKey, { transition: earlier, signer: async () => earlier.signer }, true);
    }
    const admitted = verifyAttestedTextAdmission(basis, context.channelId, delivery.admissionPolicy,
      { ...context, profileId: connection.profileId });
    if (admitted.firstPosition !== transition.admission.firstPosition) throw failure('UNVERIFIED_EPOCH_RECIPIENT');
    await this.epochCheckpoint().run(connection.policyTrust, context.channelId, 'live', continuity =>
      continuity.verifyAncestor(delivery.Epoch, transition.record, scope.verify, scope.fetchProofs));
    const signer = this.#verifiedScopedSigner(record, principal, signingPolicy, basis);
    const secret = openSignedEpochPackage(delivery, context, privateKey, signer);
    if (hash(secret) !== context.keyId) {
      secret.fill(0);
      throw failure('EPOCH_KEY_MISMATCH');
    }
    return { record, secret, admission: transition.admission.archive ? 1 : transition.admission.firstPosition, scopedBasis: basis };
  }
  async fetchProtectedRuntimeArchiveLinks(connection, channelId, keyId, scoped = false) {
    if (!hexID(channelId, 32) || !hexID(keyId, 64)) throw failure('INVALID_PROTECTED_KEY_REQUEST');
    const delivery = await this.fetchJSON(connection.base, `/api/v3/keys/archive/${channelId}/links/${keyId}${scoped ? '?scoped=1' : ''}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` }, proofResponse: scoped,
    });
    const record = delivery?.Epoch?.Record;
    if (record?.ChannelID !== channelId || record.Purpose !== 'archive' || record.KeyID !== keyId ||
        !Array.isArray(delivery.Links) || delivery.Links.length < 1 || delivery.Links.length > 129) {
      throw failure('INVALID_API_RESPONSE');
    }
    return delivery;
  }
  async #archiveReadSource(connection, channelId, trustOptions, scoped = false) {
    try {
      const head = await this.#loadProtectedRuntimeKeyDelivery(connection, channelId, 'archive', trustOptions.policyTrust, undefined, scoped);
      if (scoped) head.scope = await this.#scopedCurrentEpochPolicy(connection, head.delivery, head.context);
      return head;
    } catch (error) {
      if (['PROTECTED_ACCESS_DENIED', 'INVALID_PROTECTED_SESSION', 'UNVERIFIED_EPOCH_RECIPIENT', 'BANNED'].includes(error.code)) {
        this.#archiveResume.clear(connection.serverId, id => id !== channelId);
      }
      throw error;
    }
  }
  async #loadImportedHistoryArchiveKey(connection, channelId, link, head, trustOptions, scoped) {
    const [genesis] = await (head.scope?.fetchProofs ?? trustOptions.fetchEpochProofs)(channelId, 'archive', 0, 1);
    if (!genesis) throw failure('EPOCH_CHAIN_GAP');
    const digest = head.scope ? await head.scope.verify(genesis) :
      await this.verifyEpochProof(genesis, trustOptions.policyTrust, trustOptions.fetchPolicyPage);
    if (genesis.Record.Revision !== 1 || genesis.Record.KeyID !== link.archiveKeyId || digest !== link.epochDigest) {
      throw failure('INVALID_MIGRATION_HISTORY_LINK');
    }
    const ownerSigningKey = (await head.scope?.attest(1))?.signerKey;
    if (head.scope && (!hexID(ownerSigningKey, 64) ||
        hash(Buffer.from(ownerSigningKey, 'hex')) !== trustOptions.policyTrust.ownerDeviceId)) {
      throw failure('INVALID_MIGRATION_HISTORY_LINK');
    }
    const secret = await this.#loadRuntimeArchiveKey(connection, channelId, head, trustOptions, {
      targetGeneration: 1, targetPurpose: 'archive', targetKeyId: link.archiveKeyId, targetEpochDigest: digest,
      fetchLinks: (channel, keyId) => this.fetchProtectedRuntimeArchiveLinks(connection, channel, keyId, scoped),
    });
    return { secret, ownerSigningKey };
  }
  async #loadRuntimeArchiveKey(connection, channelId, { delivery: head, context: headContext, privateKey, scope }, trustOptions, target) {
    const options = {
      ...trustOptions, ...target, channelId, head, headContext, privateKey, textDisclosure: head.textPolicy, requireTextDisclosure: true,
    };
    const resume = scope?.transition ? undefined : await this.#startArchiveResume(connection, options, scope);
    if (!scope) return this.#walkRuntimeArchive(options, input => this.readProtectedArchiveKey(input), resume);
    const result = await this.epochCheckpoint().run(trustOptions.policyTrust, channelId, 'archive', continuity =>
      this.#walkRuntimeArchive({
        ...options, serverId: connection.serverId, authorizeEpoch: scope.signer,
        acceptHead: epoch => continuity.accept(epoch, scope.verify, scope.fetchProofs),
      }, readArchiveKey, resume)).finally(() => {
      resume?.cursor?.secret.fill(0);
      resume?.finish();
    });
    try {
      if (scope.transition) {
        const fresh = await this.#archiveReadSource(connection, channelId, trustOptions, true);
        if (!isDeepStrictEqual(fresh.delivery.Epoch.Record, head.Epoch.Record) ||
            !isDeepStrictEqual(fresh.delivery.Epoch.Principal, head.Epoch.Principal)) throw failure('UNVERIFIED_EPOCH_POLICY');
        return result;
      }
      const current = await this.fetchProtectedRuntimeTextChannelProof(connection, channelId);
      if (current?.revision !== scope.current.revision || current.policyDigest !== scope.current.policyDigest) {
        throw failure('UNVERIFIED_EPOCH_POLICY');
      }
      verifyAttestedTextAdmission(scope.current, channelId, current, scope.recipient);
      return result;
    } catch (failure) {
      if (Buffer.isBuffer(result)) result.fill(0);
      else for (const key of result.values()) key.fill(0);
      this.#archiveResume.clear(connection.serverId, id => id !== channelId);
      throw failure;
    }
  }
  async #startArchiveResume(connection, options, scope) {
    const { head, headContext, channelId, policyTrust, targets, targetGeneration, targetPurpose, targetKeyId, targetEpochDigest } = options;
    let policy = scope?.current;
    if (!policy) {
      if (!head.textPolicy) return undefined;
      const checkpoint = this.policyCheckpoint();
      const before = await checkpoint.load(policyTrust);
      await checkpoint.authorizeRecipient(headContext, policyTrust, head.textPolicy, true);
      policy = await checkpoint.load(policyTrust);
      if (!policy?.complete || policy.digest !== before?.digest) throw failure('UNVERIFIED_EPOCH_POLICY');
    }
    const request = targets ? targets.map(target => [target.generation, target.keyId, target.epochDigest]).sort((a, b) => a[0] - b[0]) :
      [targetPurpose ?? 'live', targetGeneration, targetKeyId, targetEpochDigest];
    const binding = hash(JSON.stringify([connection.fingerprint, hash(connection.token), connection.profileId, connection.deviceId,
      policyTrust.cutoverDigest, policyTrust.anchorDigest, Boolean(scope), policy.revision, policy.digest, headContext.recipientKey,
      headContext.generation, headContext.keyId, head.Epoch.Record.Signature, request]));
    return this.#archiveResume.begin(connection, channelId, binding);
  }
  async #walkRuntimeArchive(options, read, resume) {
    let cursor = resume?.cursor;
    let revalidateRecipient = Boolean(cursor);
    let remaining = options.targets;
    const recovered = new Map();
    let beforeFirstMatch, interrupted, delivered;
    const onInterrupted = resume && (checkpoint => { interrupted = checkpoint; });
    try {
      do {
        const previous = cursor;
        try {
          const result = await read({ ...options, targets: remaining, cursor: previous, onInterrupted, revalidateRecipient });
          revalidateRecipient = false;
          cursor = result.cursor;
          if (result.secret) return result.secret;
          if (result.keys?.length) {
            // A retry must also recover keys matched in earlier chunks of this page.
            if (!recovered.size && resume && cursor && previous) {
              beforeFirstMatch = { ...previous, secret: Buffer.from(previous.secret) };
            }
            for (const { keyId, secret } of result.keys) recovered.set(keyId, secret);
            remaining = remaining.filter(target => !recovered.has(target.keyId));
            if (!remaining.length) {
              delivered = true;
              return recovered;
            }
          }
        } finally {
          previous?.secret.fill(0);
        }
      } while (cursor);
      throw failure('ARCHIVE_KEY_UNAVAILABLE');
    } catch (error) {
      if (interrupted) {
        const checkpoint = recovered.size ? beforeFirstMatch : interrupted;
        if (checkpoint) resume.retain(checkpoint);
        if (checkpoint === beforeFirstMatch) beforeFirstMatch = undefined;
        if (checkpoint === interrupted) interrupted = undefined;
      }
      throw error;
    } finally {
      cursor?.secret.fill(0);
      interrupted?.secret.fill(0);
      beforeFirstMatch?.secret.fill(0);
      if (!delivered) for (const secret of recovered.values()) secret.fill(0);
      resume?.finish();
    }
  }
  async #loadAdmittedLiveKey(connection, channelId, keyId, generation, { policyTrust, fetchPolicyPage }, verifiedTransition) {
    const scoped = await this.#usesScopedTextPolicy(connection);
    let loaded;
    try { loaded = await this.#loadProtectedRuntimeKeyDelivery(connection, channelId, 'live', policyTrust, keyId, scoped); }
    catch (error) {
      const recovery = this.#recoveredDeviceKey(connection);
      if (!scoped || !recovery || !['PROTECTED_KEY_PENDING', 'PROTECTED_ACCESS_DENIED'].includes(error.code)) throw error;
      const delivery = await this.fetchJSON(connection.base, `/api/v3/recovery/packages/${channelId}/admitted/${keyId}`, {
        fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
      });
      const { Record: record } = delivery?.Epoch ?? {};
      if (record?.ChannelID !== channelId || record.Purpose !== 'live' || record.KeyID !== keyId || record.Generation !== generation) {
        throw failure('INVALID_API_RESPONSE');
      }
      const context = { ...packageContext(connection.serverId, record, recovery.recoveryId, recovery.agreementKey), kind: 'recovery' };
      return this.#openScopedEpochPackage(connection, delivery, context, recovery.agreement, true);
    }
    const { delivery, context, privateKey } = loaded;
    if (context.generation !== generation) throw failure('INVALID_API_RESPONSE');
    if (scoped) return this.#openScopedEpochPackage(connection, delivery, context, privateKey, true, verifiedTransition);
    const checkpoint = this.policyCheckpoint();
    const signer = await checkpoint.authorizeEpoch(delivery.Epoch, policyTrust, fetchPolicyPage, context);
    const record = delivery.Epoch.Record;
    const admission = await checkpoint.verifyLiveAdmission(delivery, context, connection.profileId, policyTrust, fetchPolicyPage);
    const secret = openSignedEpochPackage(delivery, context, privateKey, signer);
    if (hash(secret) !== keyId) {
      secret.fill(0);
      throw failure('EPOCH_KEY_MISMATCH');
    }
    return { record, secret, admission };
  }
  #draftAttachments(connection, channelId, operationId, create = false) {
    let drafts = this.#attachmentDrafts.get(connection);
    if (!drafts) this.#attachmentDrafts.set(connection, drafts = new Map());
    const now = Date.now();
    for (const [id, entry] of drafts) if (entry.expires <= now) drafts.delete(id);
    const id = `${channelId}:${operationId}`;
    if (!drafts.has(id) && create) {
      if (drafts.size >= 20) drafts.delete(drafts.keys().next().value);
      drafts.set(id, { expires: now + 29 * 60 * 1000, slots: new Map() });
    }
    return drafts.get(id)?.slots;
  }
  async stageProtectedAttachment(connection, channelId, operationId, slot, input) {
    if (!hexID(channelId, 32) || !hexID(operationId, 32) || !Number.isInteger(slot) || slot < 0 || slot >= 10 ||
        !(input?.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > attachmentMaxSize) {
      throw failure('INVALID_ATTACHMENT');
    }
    const bytes = byteView(input.bytes);
    const slots = this.#draftAttachments(connection, channelId, operationId, true);
    let draft = slots.get(slot);
    let poster, posterBytes;
    if (input.poster !== undefined) {
      if (!protectedImageMime(input.poster?.mime) || !(input.poster.bytes instanceof Uint8Array) ||
          input.poster.bytes.byteLength < 1 || input.poster.bytes.byteLength > 2 * attachmentBlockSize) throw failure('INVALID_IMAGE');
      posterBytes = byteView(input.poster.bytes);
      if (inspectImage(posterBytes)?.mime !== input.poster.mime) throw failure('INVALID_IMAGE');
      poster = { id: draft?.poster?.ref.id ?? requestID(), mime: input.poster.mime };
    }
    const variants = {};
    for (const kind of mediaVariantKinds) {
      const part = input[kind];
      if (part === undefined) continue;
      if (connection.config?.protectedMediaVariants !== true) throw failure('UNSUPPORTED_FEATURE');
      const maxSide = kind === 'preview' ? 480 : 2048;
      const limit = kind === 'preview' ? 80 * 1024 : bytes.length / 2;
      if (!(part?.bytes instanceof Uint8Array) || part.bytes.length < 1 || part.bytes.length > limit) throw failure('INVALID_IMAGE');
      const clear = byteView(part.bytes);
      const image = inspectImage(clear);
      if (image?.mime !== 'image/webp' || Math.max(image.width, image.height) > maxSide) throw failure('INVALID_IMAGE');
      variants[kind] = { clear, digest: hash(clear), descriptor: {
        id: draft?.[kind]?.ref.id ?? requestID(), mime: image.mime, size: clear.length,
      } };
    }
    const file = validatedAttachment({ id: draft?.ref.id ?? requestID(), name: input.name, mime: input.mime,
      size: bytes.length, voice: input.voice, duration: input.duration, poster,
      ...Object.fromEntries(Object.entries(variants).map(([kind, part]) => [kind, part.descriptor])) }, true);
    if (protectedImageMime(file.mime) && inspectImage(bytes)?.mime !== file.mime) {
      throw failure('INVALID_IMAGE');
    }
    const digest = hash(bytes);
    const posterDigest = posterBytes && hash(posterBytes);
    if (draft && (draft.digest !== digest || draft.poster?.digest !== posterDigest || !isDeepStrictEqual(draft.file, file) ||
        mediaVariantKinds.some(kind => draft[kind]?.digest !== variants[kind]?.digest))) {
      throw failure('ATTACHMENT_CONFLICT');
    }
    if (!draft) {
      draft = { file, digest, ref: { id: file.id, kind: file.voice ? 'voice' : 'file' }, secret: newAttachmentSecret() };
      if (poster) draft.poster = { digest: posterDigest, ref: { id: poster.id, kind: 'file' },
        secret: { ...newAttachmentSecret(), size: posterBytes.length } };
      for (const [kind, part] of Object.entries(variants)) {
        draft[kind] = { digest: part.digest, ref: { id: part.descriptor.id, kind: 'file' }, secret: newAttachmentSecret() };
      }
      slots.set(slot, draft);
    }
    await this.#uploadProtectedAttachment(connection, channelId, draft, bytes);
    if (draft.poster) await this.#uploadProtectedAttachment(connection, channelId, draft.poster, posterBytes);
    for (const [kind, part] of Object.entries(variants)) {
      await this.#uploadProtectedAttachment(connection, channelId, draft[kind], part.clear);
    }
    return file.id;
  }
  async #uploadProtectedAttachment(connection, channelId, draft, bytes) {
    if (draft.uploaded) return;
    const author = { ProfileID: connection.profileId, DeviceID: connection.deviceId };
    const encrypted = sealAttachment(connection.serverId, channelId, author, draft.ref, draft.secret, bytes);
    try {
      for (let offset = 0; offset < encrypted.length; offset += attachmentBlockSize) {
        const result = await this.fetchJSON(connection.base, `/api/v3/history/live-attachments/${channelId}/${draft.ref.id}`, {
          method: 'PUT', fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
          body: JSON.stringify({ kind: draft.ref.kind, offset, total: encrypted.length,
            bytes: encrypted.subarray(offset, offset + attachmentBlockSize).toString('base64') }),
        });
        if (result?.ok !== true) throw failure('INVALID_API_RESPONSE');
      }
      draft.uploaded = true;
    } finally {
      encrypted.fill(0);
    }
  }
  async sendProtectedRuntimeText(connection, channelId, text, operationId, trustOptions, replyTo, checklist, poll, fileIds, mentions, deferred) {
    if (!hexID(operationId, 32) || typeof text !== 'string' || (!text.length && fileIds === undefined) || Buffer.byteLength(text) > 12288) {
      throw failure('INVALID_PROTECTED_TEXT');
    }
    if (deferred) {
      const status = await this.readProtectedTextStatus(connection.serverId, channelId, connection);
      if (!status.allowSend || !status.deferredBasis) throw failure('PROTECTED_KEY_PENDING');
    }
    const authoredText = text;
    let attachment;
    if (fileIds !== undefined) {
      if (Buffer.byteLength(text) > 4096 || checklist !== undefined || poll !== undefined || !Array.isArray(fileIds) || !fileIds.length || fileIds.length > 10 ||
          new Set(fileIds).size !== fileIds.length || !fileIds.every(id => hexID(id, 32))) throw failure('INVALID_ATTACHMENT');
      const slots = this.#draftAttachments(connection, channelId, operationId);
      const drafts = fileIds.map((id, index) => {
        const draft = slots?.get(index);
        if (!draft || draft.ref.id !== id || mediaAttachmentParts(draft).some(part => !part.uploaded)) throw failure('ATTACHMENT_CONFLICT');
        return draft;
      });
      attachment = { Attachments: drafts.flatMap(draft => mediaAttachmentParts(draft).map(part => part.ref)) };
      if (attachment.Attachments.length > 20) throw failure('INVALID_ATTACHMENT');
      text = JSON.stringify({ text, files: drafts.map(draft => draft.file),
        secrets: drafts.map(draft => ({ ...draft.secret, ...Object.fromEntries(
          ['poster', ...mediaVariantKinds].filter(kind => draft[kind]).map(kind => [kind, draft[kind].secret])) })) });
    }
    if (checklist !== undefined) {
      const content = this.#encodeProtectedChecklist(text, checklist);
      attachment = { Checklist: content.descriptor };
      text = content.payload;
    }
    if (poll !== undefined) {
      if (checklist !== undefined || replyTo !== undefined) throw failure('INVALID_POLL');
      const content = this.#encodeProtectedPoll(text, poll);
      attachment = { Poll: content.descriptor };
      text = content.payload;
    }
    if (mentions !== undefined) {
      const mentioned = encodeProtectedMentions(authoredText, text, mentions);
      attachment = { ...attachment, ...mentioned.fields };
      text = mentioned.payload;
    }
    const { deviceId, device } = await this.identity();
    const { secret, record, liveTransition } = await this.loadProtectedRuntimeKey(connection, channelId, 'live', trustOptions);
    let packet;
    try {
      if (liveTransition && liveTransition.admission.canSend !== true) throw failure('PROTECTED_ACCESS_DENIED');
      packet = sealProtectedText(secret, connection.serverId, { ProfileID: connection.profileId, DeviceID: deviceId },
        { ChannelID: channelId, OperationID: operationId, KeyID: record.KeyID,
          ...(replyTo === undefined ? {} : protectedReplyFields(operationId, replyTo)), ...attachment }, text, device);
    } finally {
      secret.fill(0);
    }
    const receipt = await this.fetchJSON(connection.base, `/api/v3/history/live/${channelId}`, {
      method: 'POST', body: JSON.stringify(packet), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}`,
        ...(deferred && { 'X-PawTalk-Deferred-Policy': `${deferred.revision}:${deferred.head}` }) },
    });
    if (!Number.isSafeInteger(receipt?.Position) || receipt.Position < 1 || typeof receipt.Existing !== 'boolean') {
      throw failure('INVALID_API_RESPONSE');
    }
    return receipt;
  }
  async readProtectedRuntimeText(connection, channelId, { after = 0, limit = 32, scoped = false } = {}) {
    if (!hexID(channelId, 32) || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
      throw failure('INVALID_PROTECTED_HISTORY_PAGE');
    }
    const page = await this.fetchJSON(connection.base, `/api/v3/history/live/${channelId}?after=${after}&limit=${limit}${scoped ? '&scoped=1' : ''}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    return this.#validateProtectedRuntimeText(page, channelId, after, limit);
  }
  #validateProtectedRuntimeText(page, channelId, after, limit) {
    if (!Number.isSafeInteger(page?.first) || page.first < 1 || !Array.isArray(page.messages) || page.messages.length > limit || page.messages.some((entry, index) =>
      !Number.isSafeInteger(entry?.Position) || entry.Position <= (index === 0 ? after : page.messages[index - 1].Position) ||
      entry.Position < page.first || (entry.PollResult === undefined && (
      !Number.isSafeInteger(entry.Generation) || entry.Generation < 1 ||
      entry.Revision !== undefined && !revisionNumber(entry.Revision) ||
      entry.Packet?.ChannelID !== channelId || !hexID(entry.Author?.DeviceID, 64) || !hexID(entry.Author?.ProfileID, 64)))) ||
      page.next !== undefined && (page.messages.length !== limit || page.next !== page.messages.at(-1)?.Position)) {
      throw failure('INVALID_API_RESPONSE');
    }
    return page;
  }
  async withCurrentProtectedChatPolicy(connection, operation) {
    const policyTrust = connection.policyTrust;
    const fetchPolicyPage = after => this.fetchProtectedRuntimePolicyPage(connection, after);
    const fetchEpochProofs = (channel, purpose, after, through) =>
      this.fetchProtectedRuntimeEpochProofs(connection, channel, purpose, after, through);
    const options = { policyTrust, fetchPolicyPage, fetchEpochProofs };
    try {
      return await operation(options);
    } catch (error) {
      if (error.code !== 'UNVERIFIED_EPOCH_POLICY' || !policyTrust || await this.#usesScopedTextPolicy(connection)) throw error;
      await this.refreshProtectedRuntimePolicy(connection, policyTrust);
      return operation(options);
    }
  }
  #protectedRotationRequest(connection, path, method = 'GET', input, proofResponse) {
    return this.fetchJSON(connection.base, `/api/v3/keys/${path}`, {
      method, body: input === undefined ? undefined : JSON.stringify(input), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` }, proofResponse,
    });
  }
  async rotateProtectedRuntimeText(connection, channelId, purpose) {
    if (!hexID(channelId, 32) || !['live', 'archive'].includes(purpose)) throw failure('INVALID_PROTECTED_KEY_REQUEST');
    const { deviceId } = await this.identity();
    if (deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
    const scoped = await this.#usesScopedTextPolicy(connection);
    const current = scoped ? await this.readProtectedPolicyAttestation(connection).catch(error => {
      if (error.code !== 'POLICY_ATTESTATION_UNAVAILABLE') throw error;
    }) : undefined;
    if (current && (current.projectionVersion ?? 0) < textRotationAudienceVersion) throw failure('POLICY_ATTESTATION_UNAVAILABLE');
    const scope = current ? this.#scopedEpochVerifier(connection, current) : undefined;
    const privateKey = (purpose === 'archive' || scoped)
      ? await loadDeviceAgreementKey(this.credentials, connection.serverId, deviceId, false) : undefined;
    const recovery = purpose === 'archive' ? this.#recoveredDeviceKey(connection) : undefined;
    const scopeQuery = scoped ? '?scoped=1' : '';
    const claimScope = scoped && !current ? `${scopeQuery}&transition=1` : scopeQuery;
    const claimQuery = recovery ? `${claimScope}${scoped ? '&' : '?'}recovery=1` : claimScope;
    return this.withCurrentProtectedChatPolicy(connection, options => {
      let authorizedTask;
      const protocol = {
        ...options, channelId, profileId: connection.profileId, privateKey,
        ...(recovery && { recovery: { ...recovery, authorizeRecipient: async (expected, disclosure) => {
          if (scope) return verifyAttestedTextAdmission(current, channelId, disclosure, expected);
          const snapshot = await this.policyCheckpoint().policyBasis(authorizedTask, options.policyTrust, undefined, true);
          const recipient = epochRecipients(snapshot, channelId, 'archive')[recovery.recoveryId];
          if (recipient?.ProfileID !== connection.profileId || recipient.Kind !== 'recovery' || recipient.PublicKey !== recovery.agreementKey) {
            throw failure('UNVERIFIED_EPOCH_RECIPIENT');
          }
        } } }),
        claim: () => this.#protectedRotationRequest(connection, `rotate/${channelId}/${purpose}/claim${claimQuery}`, 'POST',
          undefined, scoped && 'claim'),
        loadTargets: async (record, targets) => {
          authorizedTask = record;
          const { ChannelID, Purpose, Generation, Revision, TaskID, LeaseID, ArchiveThrough } = record;
          const load = (endpoint, batch) => this.#protectedRotationRequest(connection,
            `rotate/${channelId}/${endpoint}${scopeQuery}`, 'POST', {
              Record: { ChannelID, Purpose, Generation, Revision, TaskID, LeaseID, ArchiveThrough }, Targets: batch,
            }, scoped && batch.length === 1);
          const loadBatch = async batch => {
            try {
              return await load('targets', batch).catch(error => {
                if (!recovery || error.code !== 'PROTECTED_KEY_PENDING') throw error;
                return load('recovery-targets', batch);
              });
            } catch (error) {
              if (!scoped || error.code !== 'PROTECTED_PROOF_RESPONSE_TOO_LARGE' || batch.length === 1) throw error;
              const midpoint = Math.floor(batch.length / 2);
              const first = await loadBatch(batch.slice(0, midpoint));
              const second = await loadBatch(batch.slice(midpoint));
              if (!Array.isArray(first) || first.length !== midpoint || !Array.isArray(second) ||
                  second.length !== batch.length - midpoint) throw failure('INVALID_ARCHIVE_TARGETS');
              return [...first, ...second];
            }
          };
          return loadBatch(targets);
        },
        commit: async (record, packages, links, retry = scope) => {
          const signatureDigest = hash(Buffer.from(record.Signature, 'base64'));
          try {
            const receipt = await this.#protectedRotationRequest(connection, `rotate/${channelId}/${purpose}/commit`, 'POST',
              { Record: record, Packages: packages, Links: links });
            if (receipt?.generation !== record.Generation || receipt.keyId !== record.KeyID || receipt.signatureDigest !== signatureDigest) {
              throw failure('INVALID_API_RESPONSE');
            }
          } catch (error) {
            // A lost response can follow a durable commit. Resolve that exact
            // signature before a subsequent scan may claim another task.
            const [proof] = await (retry?.fetchProofs ?? options.fetchEpochProofs)(channelId, purpose, record.Generation - 1, record.Generation)
              .catch(() => []);
            if (!isDeepStrictEqual(proof?.Record, record) || proof?.Principal?.DeviceID !== deviceId ||
                proof.Principal.ProfileID !== connection.profileId) throw error;
            if (retry) await retry.verify(proof);
            else await this.verifyEpochProof(proof, options.policyTrust, options.fetchPolicyPage);
          }
        },
      };
      if (scope) return this.#runScopedTextRotation(connection, purpose, current, scope, protocol);
      if (scoped) return this.#runOfflineTextRotation(connection, purpose, protocol);
      return this.runProtectedRotation(purpose, protocol);
    });
  }
  async #pinTransitionPredecessor(connection, proof, record, invalid = 'INVALID_LIVE_PERSONAL_DENY') {
    if (!transitionBaseMatches(proof, record.Revision) ||
        (invalid !== 'INVALID_PROTECTED_INVITE_PROOF' && proof.previousRevision !== record.Revision - 1)) {
      throw failure(invalid);
    }
    let inviteDescendants;
    if (proof.admissions) {
      inviteDescendants = new Map();
      for (const entry of proof.admissions) {
        const draft = entry?.draft;
        if (!Number.isSafeInteger(draft?.revision)) throw failure(invalid);
        inviteDescendants.set(draft.revision, draft);
      }
    }
    return this.readProtectedPolicyAttestation(connection, proof.previousRevision,
      { expectedCurrentHead: proof.previousHead, inviteDescendants });
  }
  async #inviteIssuanceAttestation(predecessor, proof, attest) {
    const issuerRevision = proof?.draft?.admission?.Issuance?.PolicyRevision;
    if (!Number.isSafeInteger(issuerRevision) || issuerRevision < 1 || issuerRevision > predecessor.revision) {
      throw failure('INVALID_PROTECTED_INVITE_PROOF');
    }
    return issuerRevision === predecessor.revision ? predecessor : attest(issuerRevision);
  }
  async #inviteIssuanceAttestations(predecessor, proof, attest) {
    if (!proof.admissions) return this.#inviteIssuanceAttestation(predecessor, proof, attest);
    const views = new Map();
    for (const entry of proof.admissions) {
      const revision = entry?.draft?.admission?.Issuance?.PolicyRevision;
      if (!views.has(revision)) views.set(revision, await this.#inviteIssuanceAttestation(predecessor, entry, attest));
    }
    return views;
  }
  async #verifyScopedInviteRotation(connection, predecessor, task, recipient) {
    const proof = selectInviteEvidence(task.inviteAdmission, task.inviteAdmissions);
    const issuance = await this.#inviteIssuanceAttestations(predecessor, proof,
      revision => this.readProtectedPolicyAttestation(connection, revision));
    const verifyRotation = proof.admissions ? verifyInviteAdmissionBatchRotation : verifyInviteAdmissionRotation;
    return verifyRotation(connection.policyTrust, predecessor, issuance, task, recipient);
  }
  async #roleAssignmentArchiveLiveHead(connection, task, predecessor, scope, transition) {
    const { ChannelID: channelId, Revision: revision } = task;
    const { policyTrust, serverId, profileId } = connection;
    const { delivery, context } = await this.#loadProtectedRuntimeKeyDelivery(connection, channelId, 'live', policyTrust, undefined, true);
    const { Epoch: epoch, roleAssignment } = delivery;
    const { Record: record } = epoch;
    if (record.Revision > revision) throw failure('UNVERIFIED_EPOCH_POLICY');
    const liveViewChanged = transition.oldAccess.view !== transition.newAccess.view;
    if (record.Revision < revision && liveViewChanged) throw failure('PROTECTED_KEY_PENDING');
    let proof = epoch, verify = scope.verify;
    if (record.Revision === revision) {
      epochTextTransition(delivery, 'live');
      if (!roleAssignment || record.LiveTransitionDigest !== roleAssignmentEpochDigest(record, task.roleAssignment.record)) {
        throw failure('UNVERIFIED_EPOCH_POLICY');
      }
      const { signer } = verifyRoleAssignmentDelivery(policyTrust, predecessor, delivery, { ...context, profileId });
      proof = { ...epoch, roleAssignment };
      verify = candidate => candidate === proof
        ? verifySignedEpoch(candidate, packageContext(serverId, candidate.Record), signer) : scope.verify(candidate);
    } else if (roleAssignment) {
      epochTextTransition(delivery, 'live');
      proof = { ...epoch, roleAssignment };
    }
    await this.epochCheckpoint().run(policyTrust, channelId, 'live',
      continuity => continuity.accept(proof, verify, scope.fetchProofs));
    return record;
  }
  async #runOfflineTextRotation(connection, purpose, protocol) {
    const { channelId, privateKey } = protocol;
    const { serverId, profileId, policyTrust } = connection;
    const identity = await this.identity();
    if (identity.deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
    const principal = { ProfileID: profileId, DeviceID: identity.deviceId };
    const recipient = { recipientId: identity.deviceId, recipientKey: createPublicKey(privateKey).export({ type: 'spki',
      format: 'der' }).subarray(-32).toString('hex'), purpose, profileId };
    const archive = purpose === 'archive';
    const rotate = archive ? runArchiveRotation : runLiveRotation;
    let predecessor, evidence, base, evidenceRevision, scope, signer, newestLive, archiveTransitionDigest, archiveThrough;
    let approvedRecovery, roleDeny, inviteAdmission, roleAssignment, invalid;
    const recovery = protocol.recovery;
    const rotationChainSigner = async proof => {
      if (proof.Record.Revision <= predecessor.revision) return scope.signer(proof);
      if (inviteAdmission && proof.Record.Purpose === purpose && proof.Record.Revision < evidenceRevision &&
          inviteEpochEvidence(proof)) return (await scope.inviteTransition(proof)).signer;
      if (!archive || proof.Record.Purpose !== 'archive' || proof.Record.ArchiveTransitionDigest !== archiveTransitionDigest) {
        throw failure('UNVERIFIED_EPOCH_POLICY');
      }
      if (inviteAdmission) return (await scope.inviteTransition(proof)).signer;
      if (roleAssignment) return (await scope.roleAssignmentTransition(proof)).signer;
      const verifyDelivery = roleDeny ? verifyRoleViewDenyDelivery : verifyPersonalDenyDelivery;
      const { archiveRoleViewDeny, archivePersonalDeny } = proof;
      scopedDenyEvidence(archiveRoleViewDeny, archivePersonalDeny);
      return verifyDelivery(policyTrust, predecessor, { Epoch: proof, archiveRoleViewDeny, archivePersonalDeny }, recipient).signer;
    };
    const verifyPredecessor = async proof => verifySignedEpoch(proof, packageContext(serverId, proof.Record), await rotationChainSigner(proof));
    return this.epochCheckpoint().run(policyTrust, channelId, purpose, continuity => rotate({
      ...protocol, serverId, identity,
      ...(recovery && { recovery: { ...recovery, authorizeRecipient: async (expected, _current, previous) => {
        if (!approvedRecovery || approvedRecovery.Kind !== 'recovery' || approvedRecovery.ProfileID !== profileId ||
            approvedRecovery.PublicKey !== recovery.agreementKey || expected.recipientId !== recovery.recoveryId ||
            expected.recipientKey !== recovery.agreementKey) throw failure('UNVERIFIED_EPOCH_RECIPIENT');
        verifyAttestedTextAdmission(predecessor, channelId, previous, expected);
      } } }),
      authorizeTask: async task => {
        roleDeny = task.roleViewDeny !== undefined;
        inviteAdmission = task.inviteAdmission !== undefined || task.inviteAdmissions !== undefined;
        roleAssignment = task.roleAssignment !== undefined;
        evidence = scopedRotationEvidence(task, purpose);
        if (!evidence) throw failure('POLICY_ATTESTATION_UNAVAILABLE');
        evidenceRevision = task.Revision;
        base = roleAssignment ? roleAssignmentBase(evidence, task.Revision) : evidence;
        invalid = roleAssignment ? 'INVALID_ROLE_ASSIGNMENT_TRANSITION' : inviteAdmission ? 'INVALID_PROTECTED_INVITE_PROOF' : undefined;
        predecessor = await this.#pinTransitionPredecessor(connection, base, task, invalid);
        const verifyTask = roleDeny ? verifyRoleViewDenyRotation : archive ? verifyArchivePersonalDeny : verifyLivePersonalDeny;
        const transition = roleAssignment ?
          verifyRoleAssignmentRotation(policyTrust, predecessor, task, evidence.record, evidence, { profileId, deviceId: identity.deviceId }) :
          inviteAdmission ?
          await this.#verifyScopedInviteRotation(connection, predecessor, task, recipient) :
          verifyTask(policyTrust, predecessor, task, recipient);
        if (roleAssignment && task.Recipients?.[identity.deviceId]?.PublicKey !== recipient.recipientKey) {
          throw failure('UNVERIFIED_EPOCH_RECIPIENT');
        }
        if (recovery) approvedRecovery = task.Recipients?.[recovery.recoveryId];
        scope = this.#scopedEpochVerifier(connection, predecessor);
        signer = { profileId, deviceId: identity.deviceId, key: transition.admission.signingKey };
        archiveTransitionDigest = transition.archiveTransitionDigest;
        await continuity.prepare(task, verifyPredecessor, scope.fetchProofs);
        if (archive) {
          if (roleAssignment) {
            newestLive = await this.#roleAssignmentArchiveLiveHead(connection, task, predecessor, scope, transition);
          } else {
            const live = await this.loadProtectedRuntimeKey(connection, channelId, 'live', protocol);
            live.secret.fill(0);
            newestLive = live.record;
            const transitionDigest = inviteAdmission ? (evidence.admissions ? inviteAdmissionBatchDigest : inviteAdmissionEpochDigest) :
              roleDeny ? roleViewDenyDigest : personalDenyDigest;
            if (newestLive.Revision !== task.Revision || newestLive.PolicyDigest !== task.PolicyDigest ||
                newestLive.LiveTransitionDigest !== transitionDigest(newestLive, evidence)) throw failure('INVALID_ARCHIVE_TARGETS');
          }
          archiveThrough = task.ArchiveThrough;
          const latestTarget = task.ArchiveTargets?.at(-1);
          const linkedLive = latestTarget?.Purpose === 'live' && latestTarget.Generation === archiveThrough &&
            (archiveThrough < newestLive.Generation || latestTarget.KeyID === newestLive.KeyID);
          const linkedArchive = roleAssignment && task.ArchiveTargets?.length === 1 &&
            latestTarget?.Purpose === 'archive' && latestTarget.Generation === task.Generation - 1 && task.Generation > 1;
          if (!Number.isSafeInteger(archiveThrough) || archiveThrough < 1 || archiveThrough > newestLive.Generation ||
              !(linkedLive || linkedArchive)) {
            throw failure('INVALID_ARCHIVE_TARGETS');
          }
        }
        return transition;
      },
      authorizeEpoch: async (epoch, context, delivery) => {
        if (recovery && context.recipientId === recovery.recoveryId && epoch.Record.Revision > predecessor.revision) {
          throw failure('UNVERIFIED_EPOCH_POLICY');
        }
        let signedEpoch = epoch;
        if (delivery?.roleAssignment !== undefined) {
          epochTextTransition(delivery, context.purpose);
          signedEpoch = { ...epoch, roleAssignment: delivery.roleAssignment };
        }
        if (epoch.Record.Purpose === 'archive') return rotationChainSigner(signedEpoch);
        if (epoch.Record.Revision <= predecessor.revision || (archive && inviteAdmission && epoch.Record.Revision < evidenceRevision)) {
          if (epoch.Record.Generation === archiveThrough) {
            if (archiveThrough === newestLive.Generation) {
              if (!isDeepStrictEqual(epoch.Record, newestLive)) throw failure('EPOCH_FORK');
            } else {
              await this.epochCheckpoint().run(policyTrust, channelId, 'live', chain =>
                chain.verifyAncestor(signedEpoch, newestLive, scope.verify, scope.fetchProofs));
            }
          }
          return scope.signer(signedEpoch);
        }
        if (inviteAdmission) {
          if (!archive || !isDeepStrictEqual(epoch.Record, newestLive)) throw failure('UNVERIFIED_EPOCH_POLICY');
          const proof = (delivery && inviteEpochEvidence(delivery, 'live')) ?? inviteEpochEvidence(epoch);
          const field = evidence.admissions ? 'liveInviteAdmissions' : 'liveInviteAdmission';
          return (await scope.inviteTransition({ ...epoch, [field]: proof })).signer;
        }
        if (roleAssignment) {
          if (!archive || !delivery?.roleAssignment || !isDeepStrictEqual(epoch.Record, newestLive)) {
            throw failure('UNVERIFIED_EPOCH_POLICY');
          }
          epochTextTransition(delivery, context.purpose);
          return verifyRoleAssignmentDelivery(policyTrust, predecessor, delivery, { ...context, profileId }).signer;
        }
        const liveEvidence = roleDeny ? delivery?.liveRoleViewDeny : delivery?.livePersonalDeny;
        if (!archive || !liveEvidence || !isDeepStrictEqual(epoch.Record, newestLive)) {
          throw failure('UNVERIFIED_EPOCH_POLICY');
        }
        scopedDenyEvidence(delivery.liveRoleViewDeny, delivery.livePersonalDeny);
        const verifyDelivery = roleDeny ? verifyRoleViewDenyDelivery : verifyPersonalDenyDelivery;
        return verifyDelivery(policyTrust, predecessor, delivery, { ...context, profileId }).signer;
      },
      commit: async (record, packages, links) => {
        const latest = await this.readProtectedPolicyAttestation(connection).catch(error => {
          if (error.code !== 'POLICY_ATTESTATION_UNAVAILABLE') throw error;
        });
        if (latest) {
          if (latest.revision !== record.Revision || latest.digest !== base.successorHead ||
              latest.policyDigest !== record.PolicyDigest ||
              (roleAssignment && latest.root !== base.successorRoot) ||
              latest.previous !== (inviteAdmission ? transitionPreviousHead(evidence) : predecessor.digest)) {
            throw failure('UNVERIFIED_EPOCH_POLICY');
          }
        } else await this.#pinTransitionPredecessor(connection, base, record, invalid);
        const verify = proof => verifySignedEpoch(proof, packageContext(serverId, record), signer);
        await protocol.commit(record, packages, links, { verify, fetchProofs: scope.fetchProofs });
        const published = { Principal: principal, Record: record };
        await continuity.accept(published, proof => proof === published ? verify(proof) : verifyPredecessor(proof), scope.fetchProofs);
      },
    }));
  }
  async #runScopedTextRotation(connection, purpose, current, scope, protocol) {
    const { channelId, privateKey } = protocol;
    const identity = await this.identity();
    const principal = { ProfileID: connection.profileId, DeviceID: identity.deviceId };
    if (principal.DeviceID !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
    const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const rotate = purpose === 'archive' ? runArchiveRotation : runLiveRotation;
    let signingPolicy;
    return this.epochCheckpoint().run(connection.policyTrust, channelId, purpose, continuity => rotate({
      ...protocol, serverId: connection.serverId, identity,
      authorizeTask: async task => {
        let transition;
        if (task.Revision !== current.revision || task.PolicyDigest !== current.policyDigest) throw failure('UNVERIFIED_EPOCH_POLICY');
        const proof = task.textPolicy;
        const recipient = {
          recipientId: identity.deviceId, recipientKey: publicKey, purpose, profileId: connection.profileId,
        };
        const admitted = verifyAttestedTextAdmission(current, channelId, proof, recipient);
        if (task.Recipients?.[identity.deviceId]?.PublicKey !== publicKey ||
            textRotationDigest(task.Recipients, task.recipientSalt) !== proof.rotation[purpose]) {
          throw failure('UNVERIFIED_EPOCH_RECIPIENTS');
        }
        if (purpose === 'archive' && current.projectionVersion >= textGroupedArchiveRotationProjectionVersion) {
          verifyRotationProfiles('archive', proof.rotation.archiveProfiles, task.Recipients, task.rotationProfileOpenings);
        }
        if (purpose === 'live' && current.projectionVersion >= textGroupedRotationProjectionVersion) {
          verifyRotationProfiles('live', proof.rotation.liveProfiles, task.Recipients, task.rotationProfileOpenings);
        }
        const roleDeny = task.roleViewDeny !== undefined;
        const evidence = scopedRotationEvidence(task, purpose);
        const inviteAdmission = task.inviteAdmission !== undefined || task.inviteAdmissions !== undefined;
        const roleAssignment = task.roleAssignment !== undefined;
        const invalidTransition = roleAssignment ? 'INVALID_ROLE_ASSIGNMENT_TRANSITION' : inviteAdmission ? 'INVALID_PROTECTED_INVITE_PROOF' :
          roleDeny ? 'INVALID_CHANNEL_POLICY_PROOF' : 'INVALID_LIVE_PERSONAL_DENY';
        if (evidence !== undefined) {
          if (inviteAdmission && !transitionBaseMatches(evidence, current.revision)) throw failure(invalidTransition);
          const base = roleAssignment ? roleAssignmentBase(evidence, current.revision) : evidence;
          const previous = await scope.attest(inviteAdmission ? base.previousRevision : current.revision - 1);
          if (current.previous !== (inviteAdmission ? transitionPreviousHead(evidence) : previous.digest) ||
              base?.successorHead !== current.digest || (roleAssignment && base.successorRoot !== current.root)) {
            throw failure(invalidTransition);
          }
          const verifyTask = roleDeny ? verifyRoleViewDenyRotation : purpose === 'archive' ? verifyArchivePersonalDeny : verifyLivePersonalDeny;
          transition = roleAssignment ? verifyRoleAssignmentRotation(connection.policyTrust, previous, task, evidence.record, evidence,
            { profileId: recipient.profileId, deviceId: recipient.recipientId }) :
            inviteAdmission ? await this.#verifyScopedInviteRotation(connection, previous, task, recipient) :
            verifyTask(connection.policyTrust, previous, task, recipient);
          const earlier = transition.admission;
          if (earlier.firstPosition !== admitted.firstPosition || earlier.canSend !== admitted.canSend || earlier.archive !== admitted.archive) {
            throw failure(invalidTransition);
          }
        }
        signingPolicy = proof;
        await continuity.prepare(task, scope.verify, scope.fetchProofs);
        return transition;
      },
      authorizeEpoch: (epoch, _context, delivery) =>
        scope.signer(delivery?.roleAssignment ? { ...epoch, roleAssignment: delivery.roleAssignment } : epoch),
      commit: async (record, packages, links) => {
        const latest = await this.readProtectedPolicyAttestation(connection);
        if (latest.digest !== current.digest) throw failure('UNVERIFIED_EPOCH_POLICY');
        await protocol.commit(record, packages, links);
        await continuity.accept({ Principal: principal, Record: record, signingPolicy }, scope.verify, scope.fetchProofs);
      },
    }));
  }
  serviceProtectedRuntimeRotations(connection) {
    const { serverId, policyTrust } = connection;
    if (this.protectedRotations.has(serverId)) return this.protectedRotations.get(serverId);
    const operation = (async () => {
      if (policyTrust?.serverId !== serverId) return;
      const checkpoint = this.policyCheckpoint();
      if (!(await checkpoint.load(policyTrust))?.complete) {
        if (isProtectedOwner(connection)) await this.refreshProtectedRuntimePolicy(connection, policyTrust);
      }
      await this.syncProtectedPolicyAttestations(connection).catch(error => {
        if (error.code === 'POLICY_ROLLBACK' || error.code === 'POLICY_FORK') throw error;
      });
      for (let pass = 0; pass < 2; pass++) {
        const tasks = await this.#protectedRotationRequest(connection,
          this.#recoveredDeviceKey(connection) ? 'rotations?recovery=1' : 'rotations');
        if (!Array.isArray(tasks) || tasks.length > 4 || tasks.some(task =>
          !hexID(task?.channelId, 32) || !['live', 'archive'].includes(task.purpose))) throw failure('INVALID_API_RESPONSE');
        let advanced = false;
        for (const { channelId, purpose } of tasks) {
          try {
            await this.rotateProtectedRuntimeText(connection, channelId, purpose);
            advanced = true;
          } catch (error) {
            if (!['PROTECTED_ROTATION_UNAVAILABLE', 'PROTECTED_KEY_PENDING', 'PROTECTED_ACCESS_DENIED', 'PROTECTED_PROOF_CHANGED', 'PROTECTED_PROOF_BUSY',
              'POLICY_ATTESTATION_UNAVAILABLE', 'UNVERIFIED_EPOCH_POLICY'].includes(error.code)) throw error;
          }
        }
        if (!advanced) break;
      }
      if (connection.config?.protectedPollResultTasks === true) await this.#serviceProtectedPollResults(connection);
      if (connection.communityAvatar?.avatar) await this.#serviceCommunityAvatarDeliveries(connection).catch(() => {});
      if (connection.config?.protectedOwnerProfileAvatar === true && isProtectedOwner(connection)) {
        await this.readProtectedProfileAvatar(connection).catch(() => {});
      }
    })().finally(() => this.protectedRotations.delete(serverId));
    this.protectedRotations.set(serverId, operation);
    return operation;
  }
  async #serviceProtectedPollResults(connection) {
    const headers = { Authorization: `Bearer ${connection.token}` };
    const fingerprint = connection.fingerprint;
    const tasks = await this.fetchJSON(connection.base, '/api/v3/history/poll-results/tasks', { fingerprint, headers });
    if (!Array.isArray(tasks) || tasks.length > 4) throw failure('INVALID_API_RESPONSE');
    const identity = await this.identity();
    if (identity.deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
    for (const task of tasks) {
      const { channelId, originalPosition, originalDigest, policyDigest, generation, keyId, closedAt, total, counts } = task ?? {};
      if (!hexID(channelId, 32) || ![originalDigest, policyDigest, keyId].every(value => hexID(value, 64)) ||
          ![originalPosition, generation, closedAt].every(value => Number.isSafeInteger(value) && value > 0) ||
          !Number.isSafeInteger(total) || total < 0 || !Array.isArray(counts) || counts.length < 2 || counts.length > 10 ||
          counts.some(count => !Number.isSafeInteger(count) || count < 0 || count > total)) {
        throw failure('INVALID_API_RESPONSE');
      }
      try {
        const history = await this.#readProtectedChatTimeline(connection, channelId, originalPosition - 1, 1, false);
        const [original] = history.messages;
        if (original?.position !== originalPosition || original.locked) continue;
        if (original.originalDigest !== originalDigest || original.poll?.options.length !== counts.length) {
          throw failure('INVALID_PROTECTED_POLL_RESULT');
        }
        const { record, secret } = await this.withCurrentProtectedChatPolicy(connection,
          options => this.loadProtectedRuntimeKey(connection, channelId, 'live', options));
        secret.fill(0);
        if (record.Generation !== generation || record.KeyID !== keyId) continue;
        const frame = signatureFrame('pawtalk-poll-result-publication-v1', connection.serverId, channelId, String(originalPosition),
          originalDigest, connection.profileId, identity.deviceId, policyDigest, String(generation), keyId, String(closedAt),
          String(total), ...counts.map(String));
        const receipt = await this.fetchJSON(connection.base, `/api/v3/history/poll-results/${channelId}/${originalPosition}`, {
          method: 'POST', headers, fingerprint,
          body: JSON.stringify({ originalDigest, policyDigest, generation, keyId, signature: sign(null, frame, identity.device).toString('base64') }),
        });
        if (receipt?.ok !== true) throw failure('INVALID_API_RESPONSE');
      } catch (error) {
        if (!['PROTECTED_STATE_UNAVAILABLE', 'PROTECTED_ROTATION_UNAVAILABLE', 'PROTECTED_KEY_PENDING', 'POLICY_ATTESTATION_UNAVAILABLE',
          'PROTECTED_ACCESS_DENIED', 'PROTECTED_PROOF_CHANGED', 'PROTECTED_PROOF_BUSY'].includes(error.code)) throw error;
      }
    }
  }
  async fetchProtectedRuntimeEpochProofs(connection, channel, purpose, after, through, scoped = false) {
    if (!hexID(channel, 32) || !['live', 'archive'].includes(purpose) || !Number.isSafeInteger(after) ||
        !Number.isSafeInteger(through) || after < 0 || through <= after) throw failure('INVALID_PROTECTED_KEY_REQUEST');
    let proofs;
    try {
      proofs = await this.fetchJSON(connection.base, `/api/v3/keys/proofs/${channel}/${purpose}?after=${after}&through=${through}${scoped ? '&scoped=1' : ''}`, {
        fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
        proofResponse: scoped && through - after === 1,
      });
    } catch (error) {
      const size = Math.min(32, through - after);
      if (!scoped || error.code !== 'PROTECTED_PROOF_RESPONSE_TOO_LARGE' || size === 1) throw error;
      return this.fetchProtectedRuntimeEpochProofs(connection, channel, purpose, after, after + Math.floor(size / 2), scoped);
    }
    if (!Array.isArray(proofs) || proofs.length !== Math.min(32, through - after) || proofs.some((proof, index) =>
      proof?.Record?.ChannelID !== channel || proof.Record.Purpose !== purpose || proof.Record.Generation !== after + index + 1)) {
      throw failure('INVALID_API_RESPONSE');
    }
    return proofs;
  }
  async readProtectedHistoryWindow(connection, channelId, deletionCursor) {
    if (!hexID(channelId, 32) || deletionCursor !== undefined && deletionCursor !== '' && !hexID(deletionCursor, 32)) {
      throw failure('INVALID_PROTECTED_HISTORY_PAGE');
    }
    const query = deletionCursor === undefined ? '' : `?after=${deletionCursor}`;
    const window = await this.fetchJSON(connection.base, `/api/v3/history/window/${channelId}${query}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    return this.#validateProtectedHistoryWindow(window);
  }
  #validateProtectedHistoryWindow(window) {
    if (!Number.isSafeInteger(window?.first) || window.first < 1 || window.cursor !== '' && !hexID(window.cursor, 32) ||
        window.last !== undefined && (!Number.isSafeInteger(window.last) || window.last !== 0 && window.last < window.first) ||
        typeof window.canDeleteOther !== 'boolean' || typeof window.canSend !== 'boolean' || window.more !== undefined && typeof window.more !== 'boolean' ||
        window.canDeletePoll !== undefined && typeof window.canDeletePoll !== 'boolean' ||
        window.canCreateList !== undefined && typeof window.canCreateList !== 'boolean' ||
        window.canCreatePoll !== undefined && typeof window.canCreatePoll !== 'boolean' ||
        window.canAttach !== undefined && typeof window.canAttach !== 'boolean' ||
        window.canSendVoice !== undefined && typeof window.canSendVoice !== 'boolean' ||
        !Array.isArray(window.removed) || window.removed.length > 64 || window.removed.some(position => !Number.isSafeInteger(position) || position < window.first) ||
        new Set(window.removed).size !== window.removed.length || !Array.isArray(window.edits) || window.edits.some(edit =>
          !Number.isSafeInteger(edit?.position) || edit.position < window.first || !revisionNumber(edit.revision)) ||
        window.removed.length + window.edits.length > 64 || window.more && window.removed.length + window.edits.length !== 64) {
      throw failure('INVALID_API_RESPONSE');
    }
    const pins = window.pins === undefined ? undefined : this.#validatedPins(window.pins, window.first);
    return { first: window.first, last: window.last, cursor: window.cursor, canDeleteOther: window.canDeleteOther, canSend: window.canSend,
      removed: window.removed, edits: window.edits.map(({ position, revision }) => ({ position, revision })), more: window.more,
      ...(pins && { pins }), ...(window.canDeletePoll && { canDeletePoll: true }),
      ...(window.canAttach && { canAttach: true }), ...(window.canSendVoice && { canSendVoice: true }),
      ...(window.canCreateList && { canCreateList: true }), ...(window.canCreatePoll && { canCreatePoll: true }) };
  }
  async pollProtectedMentions(connection, after) {
    if (after !== undefined && !hexID(after, 32)) throw failure('INVALID_PROTECTED_MENTIONS');
    const page = await this.fetchJSON(connection.base, '/api/v3/mentions/inbox', {
      method: 'POST', body: JSON.stringify(after === undefined ? {} : { after }), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!Array.isArray(page?.alerts) || page.alerts.length > 32 ||
        (page.alerts.length ? !hexID(page.cursor, 32) || page.cursor === after : page.cursor !== undefined) ||
        page.more !== undefined && (page.more !== true || page.alerts.length !== 32) ||
        page.alerts.some(alert => !hexID(alert?.channelId, 32) || !Number.isSafeInteger(alert.position) || alert.position < 1 ||
          !['direct', 'group'].includes(alert.kind))) throw failure('INVALID_API_RESPONSE');
    const alerts = page.alerts.map(({ channelId, position, kind }) => ({ channelId, position, kind }));
    if (new Set(alerts.map(alert => `${alert.channelId}:${alert.position}`)).size !== alerts.length) throw failure('INVALID_API_RESPONSE');
    return { alerts, cursor: page.cursor, more: page.more };
  }
  async verifyProtectedMention(connection, channelId, position) {
    if (!hexID(channelId, 32) || !Number.isSafeInteger(position) || position < 1) throw failure('INVALID_PROTECTED_MENTIONS');
    const result = await this.fetchJSON(connection.base, `/api/v3/mentions/inbox/${channelId}/${position}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!['direct', 'group'].includes(result?.kind) || !Number.isSafeInteger(result.remaining) ||
        result.remaining < 1 || result.remaining > 30000 || !Number.isSafeInteger(result.revision) || result.revision < 1) {
      throw failure('INVALID_API_RESPONSE');
    }
    return { kind: result.kind, remaining: result.remaining, revision: result.revision };
  }
  #validatedPins(page, first = 1, before = Number.MAX_SAFE_INTEGER) {
    if (typeof page?.canPin !== 'boolean' || !Array.isArray(page.items) || page.items.length > 32 ||
        page.items.some((item, index) => !Number.isSafeInteger(item?.position) || item.position < first ||
          item.position >= (index ? page.items[index - 1].position : before) || !(item.revision === 1 || revisionNumber(item.revision))) ||
        page.next !== undefined && (page.items.length !== 32 || page.next !== page.items.at(-1)?.position)) {
      throw failure('INVALID_API_RESPONSE');
    }
    return { canPin: page.canPin, items: page.items.map(({ position, revision }) => ({ position, revision })), next: page.next };
  }
  async readProtectedPins(connection, channelId, before) {
    if (!hexID(channelId, 32) || before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
      throw failure('INVALID_PROTECTED_HISTORY_PAGE');
    }
    const page = await this.fetchJSON(connection.base, `/api/v3/history/pins/${channelId}${before === undefined ? '' : `?before=${before}`}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    return this.#validatedPins(page, 1, before);
  }
  async setProtectedMessagePin(connection, channelId, position, pinned) {
    if (!hexID(channelId, 32) || !Number.isSafeInteger(position) || position < 1 || typeof pinned !== 'boolean') {
      throw failure('INVALID_PROTECTED_HISTORY_PAGE');
    }
    const receipt = await this.fetchJSON(connection.base, `/api/v3/history/pins/${channelId}/${position}`, {
      method: 'PUT', body: JSON.stringify({ pinned }), fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (receipt?.ok !== true) throw failure('INVALID_API_RESPONSE');
  }
  async deleteProtectedMessage(connection, channelId, position, completedPoll = false) {
    if (!hexID(channelId, 32) || !Number.isSafeInteger(position) || position < 1 || typeof completedPoll !== 'boolean') {
      throw failure('INVALID_PROTECTED_HISTORY_PAGE');
    }
    const kind = completedPoll ? 'poll' : 'message';
    const receipt = await this.fetchJSON(connection.base, `/api/v3/history/${kind}/${channelId}/${position}`, {
      method: 'DELETE', fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (receipt?.ok !== true) throw failure('INVALID_API_RESPONSE');
  }
  async protectedChecklist(connection, channelId, position, change) {
    if (!hexID(channelId, 32) || !Number.isSafeInteger(position) || position < 1 ||
        change !== undefined && (!hexID(change?.item, 32) || !hexID(change.operationId, 32) || typeof change.checked !== 'boolean')) {
      throw failure('INVALID_CHECKLIST');
    }
    const state = await this.fetchJSON(connection.base, `/api/v3/history/checklist/${channelId}/${position}`, {
      method: change ? 'PUT' : 'GET', body: change && JSON.stringify(change), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!Number.isSafeInteger(state?.revision) || state.revision < 0 || typeof state.canCheck !== 'boolean' ||
        !state.checked || typeof state.checked !== 'object' || Array.isArray(state.checked)) throw failure('INVALID_API_RESPONSE');
    const entries = Object.entries(state.checked);
    if (entries.length > 100 || entries.some(([id, value]) => !hexID(id, 32) || typeof value !== 'boolean')) {
      throw failure('INVALID_API_RESPONSE');
    }
    return { revision: state.revision, canCheck: state.canCheck, checked: Object.fromEntries(entries) };
  }
  async protectedPoll(connection, channelId, position, vote, close = false) {
    if (!hexID(channelId, 32) || !Number.isSafeInteger(position) || position < 1 ||
        typeof close !== 'boolean' || close && vote !== undefined ||
        vote !== undefined && (!hexID(vote?.operationId, 32) || !Array.isArray(vote.choices) || vote.choices.length > 10 ||
        vote.choices.some(index => !Number.isInteger(index) || index < 0 || index > 9) ||
        new Set(vote.choices).size !== vote.choices.length)) throw failure('INVALID_POLL');
    const value = await this.fetchJSON(connection.base, `/api/v3/history/poll/${channelId}/${position}${close ? '/close' : ''}`, {
      method: vote || close ? 'PUT' : 'GET', body: vote && JSON.stringify({ operationId: vote.operationId, choices: vote.choices }),
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (vote || close) {
      if (value?.ok !== true) throw failure('INVALID_API_RESPONSE');
      return true;
    }
    const { closesAt, closedAt, multiple, anonymous, intermediate, canVote, canClose, counts, total, own, voters } = value ?? {};
    const voterName = name => name === undefined || typeof name === 'string' && [...name].length <= 64 && !/[\p{Cc}\p{Cs}]/u.test(name);
    if (!Number.isSafeInteger(closesAt) || closesAt < 1 || closedAt !== null && (!Number.isSafeInteger(closedAt) || closedAt < 1) ||
        [multiple, anonymous, intermediate, canVote, canClose].some(flag => typeof flag !== 'boolean') ||
        closedAt !== null && (canVote || canClose) || !Number.isSafeInteger(total) || total < 0 ||
        !Array.isArray(counts) || counts.length > 10 || counts.some(number => !Number.isSafeInteger(number) || number < 0 || number > total) ||
        !Array.isArray(own) || own.length > 10 || own.some(index => !Number.isInteger(index) || index < 0 || index > 9) ||
        !multiple && own.length > 1 || new Set(own).size !== own.length ||
        closedAt === null && !intermediate && counts.length !== 0 ||
        voters !== undefined && (anonymous || !Array.isArray(voters) || voters.length !== counts.length ||
          voters.some((members, index) => !Array.isArray(members) || members.length > Math.min(counts[index], 10000) ||
            members.some(member => !hexID(member?.id, 64) || !voterName(member.name)) ||
            new Set(members.map(member => member.id)).size !== members.length))) {
      throw failure('INVALID_API_RESPONSE');
    }
    return { closesAt, closedAt, multiple, anonymous, intermediate, canVote, canClose, counts, total, own,
      ...(voters && { voters: voters.map(members => members.map(({ id, name }) => ({ id, name }))) }) };
  }
  #protectedRevisionRequest(connection, channelId, position, suffix = '', attempt, scoped = false) {
    if (!hexID(channelId, 32) || !Number.isSafeInteger(position) || position < 1) throw failure('INVALID_PROTECTED_HISTORY_PAGE');
    return this.fetchJSON(connection.base, `/api/v3/history/revision/${channelId}/${position}${suffix}${scoped ? '?scoped=1' : ''}`, {
      method: attempt ? 'PUT' : 'GET', body: attempt ? JSON.stringify(attempt) : undefined, fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
  }
  #protectedRevisionContext(connection, channelId, original, remote, operationId, author) {
    return { serverId: connection.serverId, channelId, position: original.position, originalDigest: original.originalDigest,
      revision: remote.revision, previousDigest: remote.previousDigest, operationId, authorProfileId: author.ProfileID,
      authorDeviceId: author.DeviceID, policyRevision: remote.policyRevision, policyDigest: remote.policyDigest,
      archive: remote.archive?.Record, archiveDigest: remote.archiveDigest };
  }
  #encodeProtectedChecklist(text, checklist) {
    if (!text.trim()) throw failure('INVALID_CHECKLIST');
    const { checklist: definition } = validatedContent({ text, checklist });
    const descriptor = { Everyone: definition.everyone, Items: definition.items.map(item => item.id) };
    const payload = JSON.stringify({ text, labels: definition.items.map(item => item.text) });
    if (Buffer.byteLength(payload) > 12288) throw failure('MESSAGE_TOO_LARGE');
    return { descriptor, payload };
  }
  #encodeProtectedPoll(text, poll) {
    if (!text.trim() || Array.from(text).length > 300) throw failure('INVALID_POLL');
    let definition;
    try {
      definition = validatePoll(poll);
    } catch {
      throw failure('INVALID_POLL');
    }
    const { options, duration, multiple, anonymous, intermediate } = definition;
    return {
      definition,
      descriptor: { OptionCount: options.length, Duration: duration, Multiple: multiple, Anonymous: anonymous, Intermediate: intermediate },
      payload: JSON.stringify({ text, options }),
    };
  }
  #decodeProtectedPoll(clear, descriptor) {
    let decoded;
    try {
      decoded = JSON.parse(clear);
    } catch {
      throw failure('INVALID_POLL');
    }
    if (typeof decoded?.text !== 'string' || !Array.isArray(decoded.options) ||
        decoded.options.length !== descriptor.OptionCount) throw failure('INVALID_POLL');
    const { text } = decoded;
    const { definition } = this.#encodeProtectedPoll(text, { options: decoded.options, duration: descriptor.Duration,
      multiple: descriptor.Multiple, anonymous: descriptor.Anonymous, intermediate: descriptor.Intermediate });
    return { text, poll: definition };
  }
  #decodeProtectedContent(clear, descriptor) {
    if (descriptor === undefined) return { text: clear };
    let decoded;
    try {
      decoded = JSON.parse(clear);
    } catch {
      throw failure('INVALID_CHECKLIST');
    }
    if (typeof decoded?.text !== 'string' || !decoded.text.trim() || !Array.isArray(decoded.labels) ||
        decoded.labels.length !== descriptor.Items.length) throw failure('INVALID_CHECKLIST');
    return validatedContent({ text: decoded.text, checklist: { everyone: descriptor.Everyone,
      items: descriptor.Items.map((id, index) => ({ id, text: decoded.labels[index] })) } });
  }
  #confirmedOriginalAuthor(original, snapshot, profileId) {
    if (original.originalAuthorProfileId === profileId) return true;
    const binding = snapshot.PolicyDevices?.[original.originalAuthorDeviceId];
    return original.imported === true && binding?.ProfileID === profileId && !binding.Revoked;
  }
  #validateRevisionBasis(channelId, original, remote) {
    const record = remote?.archive?.Record;
    if (remote?.originalDigest !== original.originalDigest || !revisionNumber(remote.revision) || !hexID(remote.previousDigest, 64) ||
        !Number.isSafeInteger(remote.policyRevision) || remote.policyRevision < 1 || !hexID(remote.policyDigest, 64) ||
        !hexID(remote.archiveDigest, 64) || !hexID(record?.ArchiveWrapKey, 64) || record.ChannelID !== channelId ||
        record.Purpose !== 'archive' || record.Revision > remote.policyRevision) throw failure('INVALID_PROTECTED_REVISION');
    return record;
  }
  async #verifiedRevisionBasis(connection, channelId, original, remote, options, current) {
    const record = this.#validateRevisionBasis(channelId, original, remote);
    const checkpoint = this.policyCheckpoint();
    const basis = await checkpoint.policyBasis({ Revision: remote.policyRevision, PolicyDigest: remote.policyDigest },
      options.policyTrust, options.fetchPolicyPage, current);
    const archiveBasis = await checkpoint.policyBasis(record, options.policyTrust, options.fetchPolicyPage, false);
    const { archive } = textRevisionAudience(basis, channelId, original.position);
    if (!isDeepStrictEqual(archive, epochRecipients(archiveBasis, channelId, 'archive')) ||
        await this.verifyEpochProof(remote.archive, options.policyTrust, options.fetchPolicyPage) !== remote.archiveDigest) {
      throw failure('INVALID_PROTECTED_REVISION');
    }
    return basis;
  }
  #verifyScopedRevisionArchive(serverId, remote, authorPolicy, archiveAttestation) {
    const archive = remote.archive.Record;
    const signer = this.#verifiedScopedSigner(archive, remote.archive.Principal, remote.archive.signingPolicy, archiveAttestation);
    if (authorPolicy.archiveAudience !== remote.archive.signingPolicy.archiveAudience ||
        verifySignedEpoch(remote.archive, packageContext(serverId, archive), signer) !== remote.archiveDigest) {
      throw failure('INVALID_PROTECTED_REVISION');
    }
  }
  #verifyOfflineRevisionArchive(connection, remote, predecessor, evidence, roleDeny) {
    const epoch = remote.archive;
    const record = epoch.Record;
    if (record.Revision !== remote.policyRevision || record.PolicyDigest !== remote.policyDigest) throw failure('INVALID_PROTECTED_REVISION');
    const { signer, excludedProfiles } = roleDeny ? verifyRoleViewDenyEpochSigner(connection.policyTrust, predecessor, epoch, evidence) : {
      signer: verifyRevisionPersonalDenyArchiveSigner(connection.policyTrust, predecessor, epoch, evidence),
      excludedProfiles: new Set([evidence.targetProfileId]),
    };
    if (verifySignedEpoch(epoch, packageContext(connection.serverId, record), signer) !== remote.archiveDigest) {
      throw failure('INVALID_PROTECTED_REVISION');
    }
    return excludedProfiles;
  }
  async #scopedRevisionRecipients(connection, channelId, original, remote, author, options) {
    const archive = this.#validateRevisionBasis(channelId, original, remote);
    const roleDeny = remote.roleViewDeny !== undefined;
    const offline = scopedDenyEvidence(remote.roleViewDeny, remote.personalDeny);
    const view = await this.readProtectedPolicyAttestation(connection).catch(error => {
      if (error.code !== 'POLICY_ATTESTATION_UNAVAILABLE' || !offline) throw error;
    });
    if (view && (view.revision !== remote.policyRevision || view.policyDigest !== remote.policyDigest ||
        (view.projectionVersion ?? 0) < textRevisionAudienceVersion)) throw failure('UNVERIFIED_EPOCH_POLICY');
    const evidence = view ? undefined : offline;
    const basis = view ?? await this.#pinTransitionPredecessor(connection, evidence, archive);
    const device = await loadDeviceAgreementKey(this.credentials, connection.serverId, author.DeviceID, false);
    const publicKey = createPublicKey(device).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const proof = evidence ? evidence.previousTextPolicy : remote.authorPolicy;
    const authorAdmission = verifyAttestedTextAdmission(basis, channelId, proof, {
      recipientId: author.DeviceID, recipientKey: publicKey, purpose: 'live', profileId: author.ProfileID,
    });
    if (original.originalAuthorProfileId !== author.ProfileID || !authorAdmission.canSend ||
        (!authorAdmission.archive && original.position < authorAdmission.firstPosition)) throw failure('PROTECTED_ACCESS_DENIED');
    if (evidence) {
      const excluded = this.#verifyOfflineRevisionArchive(connection, remote, basis, evidence, roleDeny);
      if (excluded.has(author.ProfileID)) throw failure('PROTECTED_ACCESS_DENIED');
      const live = await this.loadProtectedRuntimeKey(connection, channelId, 'live', options);
      live.secret.fill(0);
      const transitionDigest = roleDeny ? roleViewDenyDigest : personalDenyDigest;
      if (live.record.Revision !== remote.policyRevision || live.record.PolicyDigest !== remote.policyDigest ||
          live.record.LiveTransitionDigest !== transitionDigest(live.record, evidence) ||
          archive.ArchiveThrough !== live.record.Generation) throw failure('UNVERIFIED_EPOCH_POLICY');
      const removedGroups = roleDeny ? evidence.removedGroups :
        evidence.removedGroup === undefined ? {} : { [evidence.targetProfileId]: evidence.removedGroup };
      return verifyGroupedRevisionAudience(proof.rotation.limitedProfiles, original.position, remote.recipients,
        proof.groupedAudienceProof, evidence.groupedAudience, { excludedProfiles: [...excluded], removedGroups });
    }
    const archiveBasis = archive.Revision === view.revision ? view : await this.readProtectedPolicyAttestation(connection, archive.Revision);
    if ((archiveBasis.projectionVersion ?? 0) < textRevisionProjectionVersion) throw failure('POLICY_ATTESTATION_UNAVAILABLE');
    this.#verifyScopedRevisionArchive(connection.serverId, remote, proof, archiveBasis);
    if (view.projectionVersion >= textGroupedRevisionAudienceProjectionVersion) {
      return verifyGroupedRevisionAudience(proof.rotation.limitedProfiles, original.position, remote.recipients,
        proof.groupedAudienceProof, remote.groupedAudience);
    }
    return verifyRevisionAudience(proof.limitedAudience, original.position, remote.recipients, proof.audienceProof);
  }
  async #currentScopedRevisionAdmission(connection, channelId, options) {
    try { return await this.verifyProtectedRuntimeOwnAdmission(connection, channelId); }
    catch (error) {
      if (error.code !== 'POLICY_ATTESTATION_UNAVAILABLE') throw error;
      const { record, secret, liveTransition } = await this.loadProtectedRuntimeKey(connection, channelId, 'live', options);
      secret.fill(0);
      if (!liveTransition) throw error;
      return { revision: liveTransition.policy?.revision ?? record.Revision, policyDigest: liveTransition.policy?.policyDigest ?? record.PolicyDigest,
        firstPosition: liveTransition.admission.firstPosition,
        fullHistory: liveTransition.admission.archive };
    }
  }
  async #openScopedTimelineRevision(connection, channelId, original, options, delivery) {
    const remote = delivery.record;
    const archive = this.#validateRevisionBasis(channelId, original, remote);
    const roleDeny = delivery.roleViewDeny !== undefined;
    const offline = scopedDenyEvidence(delivery.roleViewDeny, delivery.personalDeny);
    const currentRevisionAttestation = await this.readProtectedPolicyAttestation(connection, remote.policyRevision).catch(error => {
      if (error.code !== 'POLICY_ATTESTATION_UNAVAILABLE' || !offline) throw error;
    });
    const evidence = currentRevisionAttestation ? undefined : offline;
    const attestation = currentRevisionAttestation ?? await this.readProtectedPolicyAttestation(connection, evidence.previousRevision);
    const archiveAttestation = evidence || archive.Revision === remote.policyRevision ? attestation :
      await this.readProtectedPolicyAttestation(connection, archive.Revision);
    if ((attestation.projectionVersion ?? 0) < textRevisionProjectionVersion ||
        (archiveAttestation.projectionVersion ?? 0) < textRevisionProjectionVersion ||
        (original.imported && remote.author?.ProfileID !== original.originalAuthorProfileId)) {
      return { position: original.position, revision: original.revision, locked: true };
    }
    const author = remote.author;
    const authorPolicy = evidence ? evidence.previousTextPolicy : delivery.authorPolicy;
    let signer, statement, excludedProfiles;
    if (evidence) {
      excludedProfiles = this.#verifyOfflineRevisionArchive(connection, remote, attestation, evidence, roleDeny);
      if (excludedProfiles.has(author?.ProfileID)) throw failure('INVALID_PROTECTED_REVISION');
      statement = verifyAttestedTextAdmission(attestation, channelId, authorPolicy, {
        recipientId: author?.DeviceID, profileId: author?.ProfileID, purpose: 'live',
        recipientKey: authorPolicy?.recipient?.statement?.publicKey,
      });
      signer = { profileId: author.ProfileID, deviceId: author.DeviceID, key: statement.signingKey };
    } else {
      signer = this.#verifiedScopedSigner({ ChannelID: channelId, Purpose: 'live', Revision: remote.policyRevision,
        PolicyDigest: remote.policyDigest }, author, authorPolicy, attestation);
      statement = authorPolicy.recipient.statement;
      this.#verifyScopedRevisionArchive(connection.serverId, remote, authorPolicy, archiveAttestation);
    }
    if (signer.profileId !== original.originalAuthorProfileId || !statement.canSend ||
        (!statement.archive && original.position < statement.firstPosition)) throw failure('INVALID_PROTECTED_REVISION');
    const context = this.#protectedRevisionContext(connection, channelId, original, remote, remote.operationId, author);
    const verifyCurrentBasis = current => {
      if (!Number.isSafeInteger(current?.revision) || current.revision < remote.policyRevision ||
          (current.revision === remote.policyRevision && current.policyDigest !== remote.policyDigest)) {
        throw failure('UNVERIFIED_EPOCH_POLICY');
      }
    };
    let text;
    if (delivery.package !== undefined) {
      const recipient = { id: connection.deviceId, publicKey: delivery.package.publicKey };
      if (excludedProfiles?.has(connection.profileId)) throw failure('UNVERIFIED_EPOCH_RECIPIENT');
      const recipientPolicy = evidence ? evidence.previousRecipientPolicy : delivery.recipientPolicy;
      const own = verifyAttestedTextAdmission(attestation, channelId, recipientPolicy, {
        recipientId: recipient.id, recipientKey: recipient.publicKey, purpose: 'live', profileId: connection.profileId,
      });
      const current = await this.#currentScopedRevisionAdmission(connection, channelId, options);
      verifyCurrentBasis(current);
      if (own.archive || original.position < own.firstPosition || (!current.fullHistory && original.position < current.firstPosition)) {
        throw failure('UNVERIFIED_EPOCH_RECIPIENT');
      }
      const privateKey = await loadDeviceAgreementKey(this.credentials, connection.serverId, recipient.id, false);
      text = openProtectedRevisionForDevice(context, remote.packet, { ...delivery.package, proof: delivery.proof }, recipient, privateKey, signer.key);
    } else {
      if (delivery.proof !== undefined || delivery.recipientPolicy !== undefined) throw failure('INVALID_PROTECTED_REVISION');
      const head = await this.#archiveReadSource(connection, channelId, options, true);
      const transitionRecord = head.scope.transition?.record;
      verifyCurrentBasis(head.scope.current ?? { revision: transitionRecord?.Revision, policyDigest: transitionRecord?.PolicyDigest });
      const secret = await this.#loadRuntimeArchiveKey(connection, channelId, head, options, {
        targetPurpose: 'archive', targetGeneration: archive.Generation, targetKeyId: archive.KeyID, targetEpochDigest: remote.archiveDigest,
        fetchLinks: (channel, keyId) => this.fetchProtectedRuntimeArchiveLinks(connection, channel, keyId, true),
      });
      try {
        text = openProtectedRevisionForArchive(context, remote.packet, secret, signer.key);
      } finally {
        secret.fill(0);
      }
    }
    const { mentions, ...originalContent } = original;
    return { ...originalContent, ...this.#decodeProtectedContent(text, remote.packet.checklist),
      revision: remote.revision, editedAt: remote.editedAt, revisionDigest: delivery.digest };
  }
  async #openTimelineRevision(connection, channelId, original, options) {
    const scoped = await this.#usesScopedTextPolicy(connection);
    let delivery;
    try {
      delivery = await this.#protectedRevisionRequest(connection, channelId, original.position, '', undefined, scoped);
    } catch (error) {
      if (error.code === 'PROTECTED_REVISION_UNAVAILABLE') return { position: original.position, revision: original.revision, locked: true };
      throw error;
    }
    const remote = delivery?.record;
    if (!revisionNumber(remote?.revision) || remote.revision < original.revision || !Number.isSafeInteger(remote.editedAt) ||
        remote.editedAt < 0 || !hexID(delivery.digest, 64) || typeof remote.packet?.signature !== 'string' ||
        hash(Buffer.from(remote.packet.signature, 'base64')) !== delivery.digest ||
        !!original.checklist !== (remote.packet.checklist !== undefined)) throw failure('INVALID_PROTECTED_REVISION');
    if (scoped) return this.#openScopedTimelineRevision(connection, channelId, original, options, delivery);
    const basis = await this.#verifiedRevisionBasis(connection, channelId, original, remote, options, false);
    const author = remote.author;
    const audience = textRevisionAudience(basis, channelId, original.position);
    const signer = epochSigner(basis, audience.live, author?.ProfileID, author?.DeviceID);
    if (!signer || !this.#confirmedOriginalAuthor(original, basis, signer.profileId) ||
        !canAuthorTextRevision(basis, channelId, signer.profileId)) throw failure('INVALID_PROTECTED_REVISION');
    const context = this.#protectedRevisionContext(connection, channelId, original, remote, remote.operationId, author);
    let text;
    if (delivery.package !== undefined) {
      const { deviceId } = await this.identity();
      const recipient = audience.limited.find(entry => entry.id === deviceId);
      if (!recipient || audience.live[deviceId].ProfileID !== connection.profileId || deviceId !== connection.deviceId) {
        throw failure('UNVERIFIED_EPOCH_RECIPIENT');
      }
      const checkpoint = this.policyCheckpoint();
      const latest = await checkpoint.load(options.policyTrust);
      const current = await checkpoint.policyBasis({ Revision: latest?.revision, PolicyDigest: latest?.resultDigest },
        options.policyTrust, options.fetchPolicyPage, true);
      const allowed = textRevisionAudience(current, channelId, original.position);
      if (allowed.live[deviceId]?.ProfileID !== connection.profileId || allowed.live[deviceId].PublicKey !== recipient.publicKey ||
          (!Object.hasOwn(allowed.archive, deviceId) && !allowed.limited.some(entry => entry.id === deviceId))) {
        throw failure('UNVERIFIED_EPOCH_RECIPIENT');
      }
      const privateKey = await loadDeviceAgreementKey(this.credentials, connection.serverId, deviceId, false);
      text = openProtectedRevisionForDevice(context, remote.packet, { ...delivery.package, proof: delivery.proof }, recipient, privateKey, signer.key);
    } else {
      if (delivery.proof !== undefined) throw failure('INVALID_PROTECTED_REVISION');
      const head = await this.#loadProtectedRuntimeKeyDelivery(connection, channelId, 'archive', options.policyTrust);
      const secret = await this.#loadRuntimeArchiveKey(connection, channelId, head, options, {
        targetPurpose: 'archive', targetGeneration: context.archive.Generation, targetKeyId: context.archive.KeyID,
        targetEpochDigest: context.archiveDigest,
        fetchLinks: (channel, keyId) => this.fetchProtectedRuntimeArchiveLinks(connection, channel, keyId),
      });
      try {
        text = openProtectedRevisionForArchive(context, remote.packet, secret, signer.key);
      } finally {
        secret.fill(0);
      }
    }
    const { mentions, ...originalContent } = original;
    return { ...originalContent, ...this.#decodeProtectedContent(text, remote.packet.checklist),
      revision: remote.revision, editedAt: remote.editedAt, revisionDigest: delivery.digest };
  }
  #displayProtectedMessage(message, window, removed) {
    const { originalDigest, originalAuthorProfileId, originalAuthorDeviceId, imported, revisionDigest, attachmentParts,
      importedAttachmentSource, ...visible } = message;
    if (!visible.locked && !visible.pollResult && originalAuthorProfileId) visible.authorProfileId = originalAuthorProfileId;
    if (visible.replyTo != null && (visible.replyTo < window.first || removed.has(visible.replyTo))) visible.replyTo = null;
    return visible;
  }
  async readProtectedChatEdition(connection, channelId, position) {
    return this.#readProtectedChatOriginal(connection, channelId, position, 'edition');
  }
  async readProtectedPinnedMessage(connection, channelId, position) {
    return this.#readProtectedChatOriginal(connection, channelId, position, 'pin');
  }
  async readProtectedChatReference(connection, channelId, position, initialWindow) {
    const message = await this.#readProtectedChatOriginal(connection, channelId, position, 'reference', initialWindow);
    return message?.locked ? undefined : message;
  }
  async #readProtectedChatOriginal(connection, channelId, position, mode, initialWindow) {
    if (!Number.isSafeInteger(position) || position < 1) throw failure('INVALID_PROTECTED_HISTORY_PAGE');
    const initial = initialWindow ?? await this.readProtectedHistoryWindow(connection, channelId);
    const read = await this.#readProtectedChatTimeline(connection, channelId, position - 1, 1);
    const [original] = read.messages;
    if (original?.position !== position || (mode === 'edition' && (original.locked || original.revision === undefined))) return;
    const selected = original.locked || original.revision === undefined ? original :
      await this.withCurrentProtectedChatPolicy(connection, options => this.#openTimelineRevision(connection, channelId, original, options));
    const window = await this.readProtectedHistoryWindow(connection, channelId, initial.cursor);
    if (position < window.first || window.removed.includes(position) || selected.originalPollPosition !== undefined &&
        (selected.originalPollPosition < window.first || window.removed.includes(selected.originalPollPosition))) return;
    if (window.more || window.edits.some(edit => edit.position === position && edit.revision > (selected.revision ?? 1))) {
      throw failure('PROTECTED_REVISION_CHANGED');
    }
    if (mode === 'pin') {
      const [reference] = (await this.readProtectedPins(connection, channelId, position + 1)).items;
      if (reference?.position !== position) return;
      if (reference.revision !== (selected.revision ?? 1)) throw failure('PROTECTED_REVISION_CHANGED');
    }
    return this.#displayProtectedMessage(selected, window, new Set(window.removed));
  }
  async editProtectedChatMessage(connection, channelId, position, expectedRevision, operationId, text, checklist) {
    if (!hexID(channelId, 32) || !Number.isSafeInteger(position) || position < 1 || !hexID(operationId, 32) ||
        !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
        typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 12288) throw failure('INVALID_PROTECTED_REVISION');
    this.protectedRevisionAttempts ??= new Map();
    const key = `${connection.serverId}:${connection.profileId}:${connection.deviceId}:${operationId}`;
    const encoded = checklist === undefined ? undefined : this.#encodeProtectedChecklist(text, checklist);
    const inputDigest = hash(JSON.stringify({ channelId, position, expectedRevision, text, encoded }));
    let attempt = this.protectedRevisionAttempts.get(key);
    if (attempt && attempt.inputDigest !== inputDigest) throw failure('PROTECTED_REVISION_CHANGED');
    if (!attempt) {
      const read = await this.#readProtectedChatTimeline(connection, channelId, position - 1, 1);
      const [original] = read.messages;
      if (original?.position !== position || original.locked || !original.canEdit) throw failure('PROTECTED_ACCESS_DENIED');
      if (!!original.checklist !== !!encoded) throw failure('INVALID_PROTECTED_REVISION');
      if ((original.revision ?? 1) !== expectedRevision) throw failure('PROTECTED_REVISION_CHANGED');
      const scoped = await this.#usesScopedTextPolicy(connection);
      const body = await this.withCurrentProtectedChatPolicy(connection, async options => {
        const remote = await this.#protectedRevisionRequest(connection, channelId, position, '/basis', undefined, scoped);
        if (remote?.position !== position || remote.revision !== expectedRevision + 1) throw failure('PROTECTED_REVISION_CHANGED');
        const previous = original.revision === undefined ? original.originalDigest :
          (await this.#openTimelineRevision(connection, channelId, original, options)).revisionDigest;
        if (!previous || previous !== remote.previousDigest) throw failure('PROTECTED_REVISION_CHANGED');
        const identity = await this.identity();
        const author = { ProfileID: connection.profileId, DeviceID: identity.deviceId };
        if (author.DeviceID !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
        let recipients;
        if (scoped) {
          recipients = await this.#scopedRevisionRecipients(connection, channelId, original, remote, author, options);
        } else {
          const basis = await this.#verifiedRevisionBasis(connection, channelId, original, remote, options, true);
          const { live, limited } = textRevisionAudience(basis, channelId, position);
          if (!epochSigner(basis, live, author.ProfileID, author.DeviceID) ||
              !this.#confirmedOriginalAuthor(original, basis, author.ProfileID) ||
              !canAuthorTextRevision(basis, channelId, author.ProfileID) || !isDeepStrictEqual(remote.recipients, limited)) {
            throw failure('UNVERIFIED_EPOCH_RECIPIENTS');
          }
          recipients = limited;
        }
        const context = this.#protectedRevisionContext(connection, channelId, original, remote, operationId, author);
        const { revision, previousDigest, policyRevision, policyDigest, archiveDigest } = remote;
        return { revision, previousDigest, policyRevision, policyDigest, archiveDigest, operationId,
          ...sealProtectedRevision(context, encoded?.payload ?? text, recipients, identity.device, encoded?.descriptor) };
      });
      // Concurrent retries share the first ciphertext associated with this operation.
      attempt = this.protectedRevisionAttempts.get(key);
      if (attempt && attempt.inputDigest !== inputDigest) throw failure('PROTECTED_REVISION_CHANGED');
      if (!attempt) {
        attempt = { inputDigest, body };
        this.protectedRevisionAttempts.set(key, attempt);
        if (this.protectedRevisionAttempts.size > 16) this.protectedRevisionAttempts.delete(this.protectedRevisionAttempts.keys().next().value);
      }
    }
    const receipt = await this.#protectedRevisionRequest(connection, channelId, position, '', attempt.body);
    if (receipt?.revision !== attempt.body.revision || typeof receipt.existing !== 'boolean' ||
        receipt.digest !== hash(Buffer.from(attempt.body.packet.signature, 'base64'))) throw failure('INVALID_API_RESPONSE');
    return receipt;
  }
  async readProtectedChatPage(connection, channelId, after, deletionCursor, limit = 32) {
    const cursor = deletionCursor ?? (await this.readProtectedHistoryWindow(connection, channelId)).cursor;
    const page = await this.#measure('history.verify', () => this.#readProtectedChatTimeline(connection, channelId, after, limit, true, true));
    const hasEdits = page.messages.some(message => !message.locked && message.revision !== undefined);
    const opened = !hasEdits ? page.messages : await this.#measure('history.edits', () => this.withCurrentProtectedChatPolicy(connection, options =>
      readHistoryBatches(page.messages, original => original.locked || original.revision === undefined ? original :
        this.#openTimelineRevision(connection, channelId, original, options))));
    // Decryption can involve several requests. Recheck history and removals
    // before plaintext crosses IPC, including when both stores contribute.
    const window = await this.readProtectedHistoryWindow(connection, channelId, cursor);
    if (window.first !== page.first || page.retry || window.more || window.edits.some(edit => opened.some(message =>
      message.position === edit.position && (message.revision ?? 0) < edit.revision))) {
      return { ...window, messages: [], retry: true };
    }
    const deleted = new Set(window.removed);
    for (const message of opened) {
      const original = message.originalPollPosition;
      if (original !== undefined && (original < window.first || deleted.has(original))) deleted.add(message.position);
    }
    const visible = opened.filter(message => !deleted.has(message.position));
    this.#rememberAttachmentMessages(connection, channelId, visible, window);
    return { ...window, messages: visible.map(message => this.#displayProtectedMessage(message, window, deleted)), next: page.next };
  }
  async readProtectedPushedChatPage(connection, channelId, after, cursor, first, deliveries, limit = 32) {
    if (cursor === undefined || !deliveries.length || deliveries.length > limit) return;
    const records = [];
    let window;
    for (const delivery of deliveries) {
      const next = after + records.length + 1;
      const page = this.#validateProtectedRuntimeText(delivery.page, channelId, next - 1, 1);
      const entry = page.messages[0];
      const scopedWindow = this.#validateProtectedHistoryWindow(delivery.window);
      if (page.first !== first || scopedWindow.first !== first || scopedWindow.cursor !== cursor ||
          scopedWindow.last !== next || page.next !== undefined || scopedWindow.more || scopedWindow.edits.length ||
          scopedWindow.removed.length || entry?.Position !== next || entry.PollResult !== undefined || entry.Revision !== undefined) return;
      records.push(entry);
      window = scopedWindow;
    }
    const page = await this.#readLiveChatPage(connection, channelId, after, records.length, true, 'all',
      { first, messages: records });
    if (page.messages.length !== records.length || page.messages.some(message => message.locked)) return;
    this.#rememberAttachmentMessages(connection, channelId, page.messages, window);
    return { ...window, messages: page.messages.map(message => this.#displayProtectedMessage(message, window, new Set())) };
  }
  clearProtectedPushedKeys(connection) {
    const entries = this.#recentLiveKeys.get(connection);
    for (const entry of entries?.values() ?? []) {
      clearTimeout(entry.timer);
      entry.key.secret.fill(0);
    }
    this.#recentLiveKeys.delete(connection);
  }
  #rememberProtectedPushedKey(connection, channelId, key) {
    let entries = this.#recentLiveKeys.get(connection);
    if (!entries) this.#recentLiveKeys.set(connection, entries = new Map());
    const remove = id => {
      const entry = entries.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      entry.key.secret.fill(0);
      entries.delete(id);
    };
    remove(channelId);
    if (entries.size >= 8) remove(entries.keys().next().value);
    const copy = { ...key, secret: Buffer.from(key.secret) };
    const timer = setTimeout(() => remove(channelId), 30_000).unref();
    entries.set(channelId, { key: copy, timer });
  }
  async browseProtectedChat(connection, channelId, { mode, query, after, checkpoint }) {
    if (!['search', 'gallery'].includes(mode) || !Number.isSafeInteger(after) || after < 0 ||
        checkpoint !== undefined && (!Number.isSafeInteger(checkpoint?.first) || checkpoint.first < 1 ||
          checkpoint.cursor !== '' && !hexID(checkpoint.cursor, 32)) ||
        (mode === 'gallery' ? query !== undefined : typeof query !== 'string' || !query.trim() || query.length > 256)) {
      throw failure('INVALID_PROTECTED_HISTORY_PAGE');
    }
    const needle = query?.trim().normalize('NFC').toLowerCase();
    const page = await this.readProtectedChatPage(connection, channelId, after, checkpoint?.cursor);
    if (page.retry || checkpoint && (page.first !== checkpoint.first || page.removed.length || page.edits.length)) return { retry: true };
    const matches = [];
    for (const message of page.messages) {
      if (message.locked) continue;
      const { position, sentAt, text } = message;
      const names = [...(message.image?.name ? [message.image.name] : []), ...(message.files ?? []).map(file => file.name)];
      if (mode === 'gallery' ? !message.image && names.length === 0 :
        ![text, ...names, ...(message.checklist?.items ?? []).map(item => item.text), ...(message.poll?.options ?? []),
          ...(message.pollResult?.winners ?? [])].some(value => value.normalize('NFC').toLowerCase().includes(needle))) continue;
      const start = needle === undefined ? 0 : Math.max(0, text.toLowerCase().indexOf(needle) - 40);
      matches.push({ position, sentAt, excerpt: text.slice(start, start + 240), names,
        ...(mode === 'gallery' && { files: message.files, image: message.image }) });
    }
    return { matches, next: page.next, checkpoint: { first: page.first, cursor: page.cursor } };
  }
  async #readProtectedChatTimeline(connection, channelId, after, limit = 32, includeResults = true, includeAttachmentParts = false) {
    const attachmentPosition = includeAttachmentParts ? 'all' : undefined;
    const imported = await this.readProtectedImportedHistory(connection, channelId, { after, limit });
    if (imported.messages.length) {
      const messages = await this.#openImportedChatPage(connection, channelId, imported, includeAttachmentParts);
      if (imported.next !== undefined || messages.length === limit) {
        return { first: imported.first, messages, next: messages.at(-1).position };
      }
      const live = await this.#readLiveChatPage(connection, channelId, messages.at(-1).position, limit - messages.length, includeResults, attachmentPosition);
      if (imported.first !== live.first) return { first: live.first, messages: [], retry: true };
      return { first: live.first, messages: [...messages, ...live.messages], next: live.next };
    }
    return this.#readLiveChatPage(connection, channelId, after, limit, includeResults, attachmentPosition);
  }
  async #resolveImportedReplyPositions(connection, channelId, first, originals, messages) {
    const ids = [...new Set(messages.map(message => message.legacyReplyId).filter(id => id && !originals.has(id)))];
    if (!ids.length) return;
    const delivery = await this.fetchJSON(connection.base, `/api/v3/history/imported/${channelId}/references`, {
      method: 'POST', body: JSON.stringify({ ids }), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!Array.isArray(delivery) || delivery.length > ids.length) throw failure('INVALID_API_RESPONSE');
    const pending = new Set(ids);
    const receivedPositions = new Set(originals.values());
    for (const entry of delivery) {
      if (!pending.delete(entry?.id) || !Number.isSafeInteger(entry.position) || entry.position < first ||
          receivedPositions.has(entry.position)) throw failure('INVALID_API_RESPONSE');
      originals.set(entry.id, entry.position);
      receivedPositions.add(entry.position);
    }
  }
  #rememberImportedMediaKey(connection, channelId, context) {
    let entries = this.#importedMediaKeys.get(connection);
    if (!entries) this.#importedMediaKeys.set(connection, entries = new Map());
    const remove = id => {
      const entry = entries.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      entry.context.archive.secret.fill(0);
      entries.delete(id);
    };
    remove(channelId);
    if (entries.size >= 8) remove(entries.keys().next().value);
    const copy = { ...context, archive: { ...context.archive, secret: Buffer.from(context.archive.secret) } };
    const timer = setTimeout(() => remove(channelId), 60_000).unref();
    entries.set(channelId, { context: copy, until: Date.now() + 60_000, timer });
  }
  async #withImportedArchive(connection, channelId, read, useMediaKey = false) {
    const cached = useMediaKey && this.#importedMediaKeys.get(connection)?.get(channelId);
    if (cached && cached.until > Date.now()) {
      const context = { ...cached.context, archive: { ...cached.context.archive, secret: Buffer.from(cached.context.archive.secret) } };
      try { return await read(context); }
      finally { context.archive.secret.fill(0); }
    }
    return this.withCurrentProtectedChatPolicy(connection, async options => {
      const scoped = await this.#usesScopedTextPolicy(connection);
      const [link, head] = await Promise.all([this.loadProtectedImportedHistoryLink(connection, channelId),
        this.#archiveReadSource(connection, channelId, options, scoped)]);
      if (link.anchorDigest !== options.policyTrust.anchorDigest || link.deviceId !== options.policyTrust.ownerDeviceId) {
        throw failure('INVALID_MIGRATION_HISTORY_LINK');
      }
      const { secret, ownerSigningKey } = await this.#loadImportedHistoryArchiveKey(connection, channelId, link, head, options, scoped);
      let importedKey;
      try {
        const signer = ownerSigningKey ?? await this.policyCheckpoint().anchorSigningKey(options.policyTrust, options.fetchPolicyPage);
        importedKey = openSignedMigrationHistoryLink(secret, { ...link, serverId: connection.serverId }, link.link, signer);
        const archive = { channelId, keyId: link.importedKeyId, purpose: 'archive', generation: 1, secret: importedKey };
        const migratorPublicKey = Buffer.from(signer, 'hex');
        return await read({ archive, archiveSha256: link.archiveSha256, migratorPublicKey, scoped });
      } finally {
        importedKey?.fill(0);
        secret.fill(0);
      }
    });
  }
  #rememberAttachmentMessages(connection, channelId, messages, window) {
    let cache = this.#verifiedAttachmentMessages.get(connection);
    for (const { position, originalDigest, originalAuthorProfileId, originalAuthorDeviceId, attachmentParts, importedAttachmentSource } of messages) {
      if (!attachmentParts?.length && !importedAttachmentSource) continue;
      if (!cache) this.#verifiedAttachmentMessages.set(connection, cache = new Map());
      const key = `${channelId}:${position}`;
      cache.delete(key);
      cache.set(key, { original: { position, originalDigest, originalAuthorProfileId, originalAuthorDeviceId, attachmentParts, importedAttachmentSource },
        cursor: window.cursor, until: Date.now() + 60_000 });
      if (cache.size > 128) cache.delete(cache.keys().next().value);
    }
  }
  #readAttachmentMessage(connection, channelId, position) {
    let reads = this.#attachmentMessageReads.get(connection);
    if (!reads) this.#attachmentMessageReads.set(connection, reads = new Map());
    const key = `${channelId}:${position}`;
    if (reads.has(key)) return reads.get(key);
    const read = (async () => {
      const imported = (await this.readProtectedImportedHistory(connection, channelId, { after: position - 1, limit: 1 })).messages[0];
      if (imported?.position === position) return { imported };
      const { messages: [live] } = await this.#readLiveChatPage(connection, channelId, position - 1, 1, false, position);
      return { live };
    })().finally(() => reads.delete(key));
    reads.set(key, read);
    return read;
  }
  async readProtectedImportedFile(connection, channelId, position, attachmentId) {
    if (!hexID(channelId, 32) || !hexID(attachmentId, 32) || !Number.isSafeInteger(position) || position < 1) {
      throw failure('INVALID_ATTACHMENT');
    }
    const { messages: [original] } = await this.readProtectedImportedHistory(connection, channelId, { after: position - 1, limit: 1 });
    if (original?.position !== position) throw failure('PROTECTED_ACCESS_DENIED');
    return this.#readProtectedImportedFile(connection, channelId, position, attachmentId, original);
  }
  async #readProtectedImportedFile(connection, channelId, position, attachmentId, original, useMediaKey = false, verifiedFiles) {
    return this.#withImportedArchive(connection, channelId, async context => {
      const files = verifiedFiles ?? this.#importedAttachments(this.#openImportedMessage(original.packet, connection, context).content);
      const descriptor = files.flatMap(mediaAttachmentParts).find(file => file.id === attachmentId);
      if (!descriptor) throw failure('PROTECTED_ACCESS_DENIED');
      const chunkSize = 1024 * 1024;
      let header, encrypted, clear;
      try {
        for (let offset = 0; !encrypted || offset < encrypted.length; offset += chunkSize) {
          const chunk = await this.fetchJSON(connection.base, `/api/v3/history/attachments/${channelId}/${position}/${attachmentId}?offset=${offset}`, {
            fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
          });
          const { packet, bytes, total } = chunk ?? {};
          if (chunk?.offset !== offset || !Number.isSafeInteger(total) || total < 17 || total > 50 * chunkSize + 16 ||
              descriptor.size !== undefined && descriptor.size + 16 !== total || typeof bytes !== 'string' ||
              bytes.length !== 4 * Math.ceil(Math.min(chunkSize, total - offset) / 3)) throw failure('INVALID_API_RESPONSE');
          if (!encrypted) {
            header = packet;
            const metadata = packet?.metadata;
            const source = original.packet.metadata;
            if (metadata?.channelId !== channelId || metadata.messageId !== original.packet.id || metadata.attachmentId !== attachmentId ||
                metadata.authorProfileId !== source.authorProfileId || metadata.ownerDeviceId !== source.authorDeviceId) {
              throw failure('INVALID_MIGRATION_PACKET');
            }
            encrypted = Buffer.alloc(total);
          } else if (encrypted.length !== total || !isDeepStrictEqual(packet, header)) {
            throw failure('INVALID_MIGRATION_PACKET');
          }
          const piece = Buffer.from(bytes, 'base64');
          if (piece.length !== Math.min(chunkSize, total - offset) || piece.toString('base64') !== bytes) throw failure('INVALID_API_RESPONSE');
          piece.copy(encrypted, offset);
        }
        clear = await this.#measure('attachment.imported.decrypt', () => openMigratedAttachment(header,
          { ...context, serverId: connection.serverId, kind: 'attachments', id: attachmentId }, encrypted));
        if (['image/png', 'image/jpeg', 'image/webp'].includes(descriptor.mime) &&
            (clear.length > 2 * chunkSize || inspectImage(clear)?.mime !== descriptor.mime)) throw failure('INVALID_IMAGE');
        const { messages: [latest] } = await this.readProtectedImportedHistory(connection, channelId, { after: position - 1, limit: 1 });
        if (latest?.position !== position || latest.packet.signature !== original.packet.signature) throw failure('PROTECTED_ACCESS_DENIED');
        return Uint8Array.from(clear);
      } finally {
        clear?.fill(0);
        encrypted?.fill(0);
      }
    }, useMediaKey);
  }
  async readProtectedFile(connection, channelId, position, attachmentId) {
    if (!hexID(channelId, 32) || !hexID(attachmentId, 32) || !Number.isSafeInteger(position) || position < 1) {
      throw failure('INVALID_ATTACHMENT');
    }
    const saved = this.#verifiedAttachmentMessages.get(connection)?.get(`${channelId}:${position}`);
    const cached = saved && saved.until > Date.now() ? saved : undefined;
    const importedSource = cached?.original.importedAttachmentSource;
    if (importedSource) return this.#readProtectedImportedFile(connection, channelId, position, attachmentId,
      importedSource, true, importedSource.files);
    const { imported, live: original } = cached ? { live: cached.original } : await this.#readAttachmentMessage(connection, channelId, position);
    if (imported) return this.#readProtectedImportedFile(connection, channelId, position, attachmentId, imported, true);
    const part = original?.attachmentParts?.find(entry => entry.ref.id === attachmentId);
    if (original?.position !== position || !part) throw failure('PROTECTED_ACCESS_DENIED');
    const { file, ref, secret } = part;
    const author = { ProfileID: original.originalAuthorProfileId, DeviceID: original.originalAuthorDeviceId };
    const encrypted = Buffer.alloc(file.size + 16);
    let clear;
    try {
      for (let offset = 0; offset < encrypted.length; offset += attachmentBlockSize) {
        const chunk = await this.fetchJSON(connection.base,
          `/api/v3/history/live-attachments/${channelId}/${position}/${attachmentId}?offset=${offset}`, {
            fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
          });
        const count = Math.min(attachmentBlockSize, encrypted.length - offset);
        if (chunk?.total !== encrypted.length || chunk.offset !== offset || typeof chunk.bytes !== 'string' ||
            chunk.bytes.length !== 4 * Math.ceil(count / 3)) throw failure('INVALID_API_RESPONSE');
        const bytes = Buffer.from(chunk.bytes, 'base64');
        if (bytes.length !== count || bytes.toString('base64') !== chunk.bytes) throw failure('INVALID_API_RESPONSE');
        bytes.copy(encrypted, offset);
      }
      clear = await this.#measure('attachment.decrypt', () => openAttachmentAsync(connection.serverId, channelId, author, ref, secret, encrypted));
      if (protectedImageMime(file.mime) && inspectImage(clear)?.mime !== file.mime) throw failure('INVALID_IMAGE');
      // The original's signature was checked with the page. Each block still checks
      // membership and the message position, and the final window catches deletion in flight.
      const window = cached && await this.readProtectedHistoryWindow(connection, channelId, cached.cursor);
      if (window && (position < window.first || window.removed.includes(position))) throw failure('PROTECTED_ACCESS_DENIED');
      if (!window || window.more) {
        const { messages: [latest] } = await this.#readLiveChatPage(connection, channelId, position - 1, 1, false);
        if (latest?.position !== position || latest.originalDigest !== original.originalDigest) throw failure('PROTECTED_ACCESS_DENIED');
      }
      return Uint8Array.from(clear);
    } finally {
      clear?.fill(0);
      encrypted.fill(0);
    }
  }
  #decodeProtectedAttachmentMessage(clear, refs, includeSecrets) {
    let body;
    try {
      body = JSON.parse(clear);
    } catch {
      throw failure('INVALID_ATTACHMENT');
    }
    const content = validatedContent({ text: body?.text, files: body?.files });
    if (!content.files || !Array.isArray(body.secrets) || body.secrets.length !== content.files.length) throw failure('INVALID_ATTACHMENT');
    const parts = [];
    for (const [i, file] of content.files.entries()) {
      const input = body.secrets[i];
      parts.push({ file, ref: { id: file.id, kind: file.voice ? 'voice' : 'file' }, secret: validateAttachmentSecret(input) });
      if (file.poster) {
        const size = input.poster?.size;
        if (!Number.isSafeInteger(size) || size < 1 || size > 2 * attachmentBlockSize) throw failure('INVALID_ATTACHMENT');
        parts.push({ file: { ...file.poster, size }, ref: { id: file.poster.id, kind: 'file' },
          secret: validateAttachmentSecret(input.poster) });
      } else if (input.poster !== undefined) {
        throw failure('INVALID_ATTACHMENT');
      }
      for (const kind of mediaVariantKinds) {
        const part = file[kind];
        if (part) parts.push({ file: part, ref: { id: part.id, kind: 'file' }, secret: validateAttachmentSecret(input[kind]) });
        else if (input[kind] !== undefined) throw failure('INVALID_ATTACHMENT');
      }
    }
    if (!isDeepStrictEqual(parts.map(part => part.ref), refs)) throw failure('INVALID_ATTACHMENT');
    return { ...content, ...(includeSecrets && { attachmentParts: parts }) };
  }
  #openImportedMessage(packet, connection, context) {
    const clear = openMigratedHistoryRecord(packet, { ...context, serverId: connection.serverId, kind: 'messages', id: packet.id });
    try {
      let decoded;
      try {
        decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear));
      } catch {
        throw failure('INVALID_MIGRATION_RECORD');
      }
      if (!decoded || typeof decoded !== 'object') throw failure('INVALID_MIGRATION_RECORD');
      const { reply, ...body } = decoded;
      return { reply, content: validatedContent(body) };
    } finally {
      clear.fill(0);
    }
  }
  #importedAttachments(content) {
    return [content.image, ...(content.files ?? (content.file ? [content.file] : []))].filter(Boolean);
  }
  async #openImportedChatPage(connection, channelId, { messages, first }, rememberMediaKey = false) {
    return this.#withImportedArchive(connection, channelId, async context => {
      const originals = new Map();
      const opened = messages.map(({ position, packet, effectiveAuthor, dedicatedDeletion, completedPoll, cannotEdit, revision, originalPollPosition }) => {
        const { reply, content } = this.#openImportedMessage(packet, connection, context);
        const files = rememberMediaKey ? this.#importedAttachments(content) : [];
        if (content.pollResult && originalPollPosition === undefined) throw failure('INVALID_MIGRATION_RECORD');
        const original = reply?.id;
        const legacyReplyId = reply === undefined ? undefined : Number.isSafeInteger(original) && original > 0 &&
          BigInt(original) < BigInt(packet.id) ? String(original) : null;
        originals.set(packet.id, position);
        return { position, sentAt: packet.metadata.sentAt, own: effectiveAuthor === connection.profileId,
          dedicatedDeletion: dedicatedDeletion === true, canEdit: cannotEdit !== true && effectiveAuthor === connection.profileId &&
            (!context.scoped || packet.metadata.authorProfileId === connection.profileId),
          imported: true, originalDigest: hash(Buffer.from(packet.signature, 'base64url')),
          originalAuthorProfileId: packet.metadata.authorProfileId, originalAuthorDeviceId: packet.metadata.authorDeviceId,
          revision, text: content.text, legacyReplyId, ...(completedPoll && { completedPoll: true }),
          ...(content.checklist && { checklist: content.checklist }),
          ...(content.poll && !content.pollResult && { poll: content.poll }),
          ...(content.image && { image: content.image }),
          ...(content.file || content.files ? { files: content.files ?? [content.file] } : {}),
          ...(files.length && { importedAttachmentSource: { position, packet, files } }),
          ...(originalPollPosition !== undefined && { originalPollPosition }) };
      });
      await this.#resolveImportedReplyPositions(connection, channelId, first, originals, opened);
      if (rememberMediaKey && opened.some(message => message.image || message.files?.length)) {
        this.#rememberImportedMediaKey(connection, channelId, context);
      }
      return opened.map(({ legacyReplyId, ...message }) => {
        if (legacyReplyId === undefined) return message;
        const original = originals.get(legacyReplyId);
        return { ...message, replyTo: original !== undefined && original < message.position ? original : null };
      });
    });
  }
  async #openProtectedPollResult(connection, channelId, position, first, result, source) {
    const { originalPosition, originalDigest, closedAt, total, counts, signature } = result ?? {};
    if (!Number.isSafeInteger(originalPosition) || originalPosition < first || originalPosition >= position ||
        !hexID(originalDigest, 64) || !Number.isSafeInteger(closedAt) || closedAt < 1 ||
        !Number.isSafeInteger(total) || total < 0 || !Array.isArray(counts) || counts.length < 2 || counts.length > 10 ||
        counts.some(count => !Number.isSafeInteger(count) || count < 0 || count > total)) throw failure('INVALID_API_RESPONSE');
    const frame = signatureFrame('pawtalk-poll-result-v1', connection.serverId, channelId, String(position),
      String(originalPosition), originalDigest, String(closedAt), String(total), ...counts.map(String));
    this.#verifyServerSignature({ serverId: connection.serverId, identityKey: connection.config?.identityKey, identitySignature: signature }, frame);
    if (!source) {
      const read = await this.#readProtectedChatTimeline(connection, channelId, originalPosition - 1, 1, false);
      if (read.first !== first) return { position, locked: true, originalPollPosition: originalPosition };
      [source] = read.messages;
    }
    if (source?.position !== originalPosition || source.locked) return { position, locked: true, originalPollPosition: originalPosition };
    if (!source.poll || source.originalDigest !== originalDigest || source.poll.options.length !== counts.length) {
      throw failure('INVALID_API_RESPONSE');
    }
    const most = Math.max(...counts);
    return { position, own: false, canEdit: false, dedicatedDeletion: true, sentAt: closedAt, text: source.text,
      originalPollPosition: originalPosition, pollResult: { winners: total ? source.poll.options.filter((_, index) => counts[index] === most) : [] } };
  }
  async #readLiveChatPage(connection, channelId, after, limit, includeResults, attachmentPosition, pushed) {
    const scoped = await this.#usesScopedTextPolicy(connection);
    const pageRequest = pushed ? Promise.resolve(pushed) : this.readProtectedRuntimeText(connection, channelId, { after, limit, scoped });
    return this.withCurrentProtectedChatPolicy(connection, async options => {
      const keys = new Map();
      let verifiedTransition;
      const links = new Map();
      const linkCacheByteLimit = 8 << 20;
      let cachedLinkBytes = 0;
      const fetchLinks = async (channel, keyId) => {
        const cached = links.get(keyId);
        if (cached) {
          links.delete(keyId);
          links.set(keyId, cached);
          return cached.delivery;
        }
        const delivery = await this.fetchProtectedRuntimeArchiveLinks(connection, channel, keyId, scoped);
        const bytes = Buffer.byteLength(JSON.stringify(delivery));
        if (bytes > linkCacheByteLimit) return delivery;
        while (links.size >= 32 || cachedLinkBytes + bytes > linkCacheByteLimit) {
          const oldest = links.keys().next().value;
          cachedLinkBytes -= links.get(oldest).bytes;
          links.delete(oldest);
        }
        links.set(keyId, { delivery, bytes });
        cachedLinkBytes += bytes;
        return delivery;
      };
      try {
        const loadCurrent = async () => {
          try {
            const cached = this.#recentLiveKeys.get(connection)?.get(channelId)?.key;
            const reuse = pushed && cached && pushed.messages.every(message => message.Packet.KeyID === cached.record.KeyID);
            const current = reuse ? { ...cached, secret: Buffer.from(cached.secret) } :
              await this.loadProtectedRuntimeKey(connection, channelId, 'live', options);
            if (!reuse && connection.config?.protectedMessageDelivery === true) {
              this.#rememberProtectedPushedKey(connection, channelId, current);
            }
            verifiedTransition = current.liveTransition;
            keys.set(current.record.KeyID, current);
          } catch (error) {
            if (error.code !== 'PROTECTED_KEY_PENDING') throw error;
          }
        };
        let page;
        if (attachmentPosition === 'all') {
          const [history, key] = await Promise.allSettled([pageRequest, loadCurrent()]);
          if (history.status === 'rejected') throw history.reason;
          page = history.value;
          if (key.status === 'rejected' && page.messages.some(message => message.PollResult === undefined)) throw key.reason;
        } else {
          page = await pageRequest;
          if (page.messages.some(message => message.PollResult === undefined)) await loadCurrent();
        }
        if (!page.messages.length) return { first: page.first, messages: [] };
        const historical = new Map();
        const entrantTransition = (inviteApplicant(verifiedTransition, connection.profileId) || verifiedTransition?.firstAdmittedRevision) &&
            !verifiedTransition.admission.archive
          ? verifiedTransition : undefined;
        const beforeInvite = position => entrantTransition && position < entrantTransition.admission.firstPosition;
        const generations = new Map(page.messages.filter(message => message.PollResult === undefined &&
          !keys.has(message.Packet.KeyID) && !beforeInvite(message.Position)).map(message => [message.Packet.KeyID, message.Generation]));
        await readHistoryBatches([...generations], async ([keyId, generation]) => {
          try {
            keys.set(keyId, await this.#loadAdmittedLiveKey(connection, channelId, keyId, generation, options, verifiedTransition));
          } catch (error) {
            if (!['PROTECTED_ACCESS_DENIED', 'PROTECTED_KEY_PENDING'].includes(error.code) &&
                !(verifiedTransition && error.code === 'POLICY_ATTESTATION_UNAVAILABLE')) throw error;
            keys.set(keyId, undefined);
            historical.set(keyId, generation);
          }
        });
        if (historical.size) {
          try {
            const head = await this.#archiveReadSource(connection, channelId, options, scoped);
            const candidates = [...historical].filter(([, generation]) => generation <= head.delivery.Epoch.Record.ArchiveThrough);
            const proofs = (await readHistoryBatches(candidates, async ([keyId, generation]) => {
              let proof;
              try {
                [proof] = await (head.scope?.fetchProofs ?? options.fetchEpochProofs)(channelId, 'live', generation - 1, generation);
              } catch (error) {
                if (!['PROTECTED_ACCESS_DENIED', 'PROTECTED_KEY_PENDING'].includes(error.code)) throw error;
                return undefined;
              }
              if (!proof) throw failure('EPOCH_CHAIN_GAP');
              if (proof.Record.KeyID !== keyId || proof.Record.Generation !== generation) throw failure('ARCHIVE_KEY_MISMATCH');
              let scopedBasis, liveTransition;
              if (head.scope) {
                scopedBasis = await head.scope.attest(proof.Record.Revision).catch(error => {
                  if (!['POLICY_ATTESTATION_UNAVAILABLE', 'UNVERIFIED_EPOCH_POLICY'].includes(error.code) ||
                      !(proof.roleAssignment || inviteEpochEvidence(proof))) throw error;
                });
                if (!scopedBasis) liveTransition = await (proof.roleAssignment
                  ? head.scope.roleAssignmentTransition(proof) : head.scope.inviteTransition(proof));
              }
              const epochDigest = await (liveTransition
                ? verifySignedEpoch(proof, packageContext(connection.serverId, proof.Record), liveTransition.signer)
                : head.scope ? head.scope.verify(proof) : this.verifyEpochProof(proof, options.policyTrust, options.fetchPolicyPage));
              return { target: { generation, keyId, epochDigest }, basis: { record: proof.Record, scopedBasis, liveTransition } };
            })).filter(Boolean);
            const targets = proofs.map(proof => proof.target);
            if (targets.length) {
              const archived = await this.#loadRuntimeArchiveKey(connection, channelId, head, options, { targets, fetchLinks });
              for (const { target: { keyId }, basis } of proofs) {
                if (archived.has(keyId)) keys.set(keyId, { ...basis, secret: archived.get(keyId) });
              }
            }
          } catch (error) {
            if (!['PROTECTED_ACCESS_DENIED', 'PROTECTED_KEY_PENDING'].includes(error.code) &&
                !(verifiedTransition && error.code === 'POLICY_ATTESTATION_UNAVAILABLE')) throw error;
          }
        }
        const messages = [];
        for (const { Position, Generation, SentAt, Author, Packet, Revision, AuthorPolicy, previousAuthorPolicy,
          roleAssignmentAuthorKey, PollClosed, PollResult } of page.messages) {
          if (beforeInvite(Position)) continue;
          if (PollResult !== undefined) {
            if (!includeResults) continue;
            const source = messages.find(message => message.position === PollResult?.originalPosition);
            messages.push(await this.#openProtectedPollResult(connection, channelId, Position, page.first, PollResult, source));
            continue;
          }
          if (!Number.isSafeInteger(SentAt) || SentAt < 0 || !hexID(Packet.KeyID, 64)) throw failure('INVALID_API_RESPONSE');
          const key = keys.get(Packet.KeyID);
          if (!key || Position < (key.admission ?? 1)) {
            messages.push({ position: Position, revision: Revision, locked: true });
            continue;
          }
          if (key.record.Generation !== Generation) throw failure('INVALID_API_RESPONSE');
          let signer;
          if (scoped) {
            const authorTransition = key.epochAuthorTransition ?? (key.scopedBasis ? undefined : key.liveTransition);
            if (authorTransition) {
              const verifyAuthor = authorTransition.assignment ? verifyRoleAssignmentAuthor :
                authorTransition.applicants ? verifyLiveInviteAdmissionBatchAuthor :
                authorTransition.applicant ? verifyLiveInviteAdmissionAuthor : verifyLiveDenyAuthor;
              signer = verifyAuthor(authorTransition, key.record, Author, previousAuthorPolicy, Position, AuthorPolicy, roleAssignmentAuthorKey);
            } else {
              signer = this.#verifiedScopedSigner(key.record, Author, AuthorPolicy, key.scopedBasis);
            }
          } else {
            if (!key.signers) {
              const snapshot = await this.policyCheckpoint().policyBasis(key.record, options.policyTrust, options.fetchPolicyPage, false);
              key.signers = { snapshot, recipients: epochRecipients(snapshot, channelId, 'live') };
            }
            signer = epochSigner(key.signers.snapshot, key.signers.recipients, Author.ProfileID, Author.DeviceID);
          }
          if (!signer) throw failure('UNTRUSTED_EPOCH_SIGNER');
          const clear = openProtectedText(key.secret, connection.serverId, Author, Packet, signer.key);
          const decodeContent = value => Packet.Attachments !== undefined ?
            this.#decodeProtectedAttachmentMessage(value, Packet.Attachments, attachmentPosition === 'all' || Position === attachmentPosition) :
            Packet.Poll === undefined ? this.#decodeProtectedContent(value, Packet.Checklist) : this.#decodeProtectedPoll(value, Packet.Poll);
          const content = Packet.MentionDigest === undefined ? decodeContent(clear) : decodeProtectedMentions(clear, Packet.MentionDigest, decodeContent);
          const own = Author.ProfileID === connection.profileId;
          messages.push({ position: Position, sentAt: SentAt, own, canEdit: own && !content.poll, ...content, revision: Revision,
            ...(content.poll && PollClosed === true && { completedPoll: true, dedicatedDeletion: true }),
            replyTo: openProtectedReply(Packet, Position, page.first),
            originalDigest: hash(Buffer.from(Packet.Signature, 'base64')),
            originalAuthorProfileId: Author.ProfileID, originalAuthorDeviceId: Author.DeviceID });
        }
        return { first: page.first, messages, next: page.next };
      } finally {
        for (const key of keys.values()) key?.secret.fill(0);
      }
    });
  }
  async fetchProtectedRuntimePolicyPage(connection, after) {
    if (!Number.isSafeInteger(after) || after < 0) throw failure('INVALID_POLICY_PAGE');
    return this.fetchJSON(connection.base, `/api/v3/policy/proofs?after=${after}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
  }
  fetchProtectedRuntimeTextChannelProof(connection, channelId) {
    if (!hexID(channelId, 32)) throw failure('INVALID_CHANNEL');
    return this.fetchJSON(connection.base, `/api/v3/policy/text-channel/${channelId}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
  }
  async publishProtectedPolicyAttestation(connection, revision) {
    const trust = connection.policyTrust;
    const identity = await this.identity();
    if (trust?.serverId !== connection.serverId || !isProtectedOwner(connection) ||
        trust.ownerDeviceId !== connection.deviceId || identity.deviceId !== connection.deviceId) throw failure('PROTECTED_ACCESS_DENIED');
    const claims = await this.policyCheckpoint().attestationClaims(trust, revision,
      after => this.fetchProtectedRuntimePolicyPage(connection, after));
    return this.#postProtectedPolicyAttestation(connection, claims, identity.device);
  }
  async #postProtectedPolicyAttestation(connection, claims, device) {
    const signature = sign(null, policyAttestationFrame(connection.policyTrust, claims), device).toString('base64');
    const receipt = await this.fetchJSON(connection.base, '/api/v3/policy/attestations', {
      method: 'POST', body: JSON.stringify({ revision: claims.revision, signature }), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (receipt?.ok !== true) throw failure('INVALID_API_RESPONSE');
  }
  readProtectedPolicyAttestation(connection, revision, options) {
    if (options !== undefined) return this.#readProtectedPolicyAttestation(connection, revision, options);
    let reads = this.#attestationReads.get(connection);
    if (!reads) this.#attestationReads.set(connection, reads = new Map());
    if (reads.has(revision)) return reads.get(revision);
    const read = this.#readProtectedPolicyAttestation(connection, revision).finally(() => reads.delete(revision));
    reads.set(revision, read);
    return read;
  }
  async #readProtectedPolicyAttestation(connection, revision, { expectedCurrentHead, inviteDescendants } = {}) {
    const trust = connection.policyTrust;
    const pinCurrent = revision === undefined || expectedCurrentHead !== undefined;
    if (trust?.serverId !== connection.serverId || revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
      throw failure('INVALID_POLICY_ATTESTATION');
    }
    const response = await this.fetchJSON(connection.base, `/api/v3/policy/attestations/${revision ?? 'current'}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    const authority = response?.authorityHead === undefined ? undefined :
      await this.#readScopeAuthority(connection, trust, Math.max(response.revision, response.authorityRevision));
    const view = verifyPolicyAttestation(trust, response, authority);
    if (revision !== undefined && view.revision !== revision) throw failure('INVALID_POLICY_ATTESTATION');
    if (expectedCurrentHead !== undefined && view.digest !== expectedCurrentHead) throw failure('POLICY_FORK');
    if (pinCurrent) {
      await this.#loadOwnershipFloor(connection);
      const floor = connection.ownership;
      if (floor?.signerMoved || floor?.transferred) {
        if (!authority || view.revision < floor.revision) throw failure('POLICY_ROLLBACK');
        if (!authority.prefixes.has(floor.authorityHead)) throw failure('POLICY_FORK');
      }
    }
    const full = await this.policyCheckpoint().load(trust);
    if (full && pinCurrent && view.revision < full.revision) {
      const receipt = inviteDescendants?.get(full.revision);
      if (!receipt || receipt.digest !== full.digest) throw failure('POLICY_ROLLBACK');
      if (receipt.previousDigest !== full.previousDigest || receipt.resultDigest !== full.resultDigest ||
          receipt.projectionRoot !== full.textProjectionRoot) throw failure('POLICY_FORK');
    }
    if (full && pinCurrent && (view.projectionVersion ?? 3) < (full.textProjectionVersion ?? 3)) throw failure('POLICY_ROLLBACK');
    if (pinCurrent && full?.scopeAuthority) {
      if (!authority && scopeAuthorityRequiresV2(trust, full.scopeAuthority)) {
        throw failure('POLICY_ROLLBACK');
      }
      if (authority && !authority.prefixes.has(full.scopeAuthority.digest)) throw failure('POLICY_FORK');
    }
    if (full?.revision === view.revision && (full.digest !== view.digest || full.textProjectionRoot !== view.root ||
        (full.textProjectionVersion ?? 3) !== (view.projectionVersion ?? 3))) throw failure('POLICY_FORK');
    if (!pinCurrent) return view;
    this.policyAttestationCheckpoint ??= new PolicyAttestationCheckpoint(this.credentials);
    return this.policyAttestationCheckpoint.acceptCurrent(trust, view, authority, inviteDescendants);
  }
  async verifyProtectedRuntimeOwnAdmission(connection, channelId, purpose = 'live') {
    if (!hexID(channelId, 32) || !['live', 'archive'].includes(purpose)) throw failure('INVALID_CHANNEL');
    const { deviceId } = await this.identity();
    if (deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
    const key = await loadDeviceAgreementKey(this.credentials, connection.serverId, deviceId, false);
    const recipientKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const view = await this.readProtectedPolicyAttestation(connection);
    const disclosure = await this.fetchProtectedRuntimeTextChannelProof(connection, channelId);
    const statement = verifyAttestedTextAdmission(view, channelId, disclosure,
      { recipientId: deviceId, recipientKey, purpose, profileId: connection.profileId });
    return { revision: view.revision, policyDigest: view.policyDigest, firstPosition: statement.firstPosition, fullHistory: statement.archive };
  }
  async verifyProtectedChannelOrderAuthority(connection, channelId) {
    const { scopes: [{ kind, categoryId, revision, policyDigest }] } = await this.#protectedChannelOrderEvidence(connection, [channelId]);
    return { channelId, kind, categoryId, revision, policyDigest };
  }
  async #verifiedProtectedChannelSettings(connection, channelId) {
    if (!hexID(channelId, 32) || connection.policyTrust?.serverId !== connection.serverId) throw failure('INVALID_PROTECTED_SESSION');
    const attestation = await this.readProtectedPolicyAttestation(connection);
    const headers = { Authorization: `Bearer ${connection.token}` };
    const options = { fingerprint: connection.fingerprint, headers };
    const [settingsProof, editorProof] = await Promise.all([
      this.fetchJSON(connection.base, `/api/v3/policy/channel-settings/${channelId}`, options),
      this.fetchJSON(connection.base, `/api/v3/policy/channel-order/${channelId}`, options),
    ]);
    if (settingsProof?.revision !== attestation.revision || editorProof?.revision !== attestation.revision) {
      throw failure('PROTECTED_POLICY_CHANGED');
    }
    const settings = verifyChannelSettings(attestation, channelId, settingsProof);
    const actor = { ProfileID: connection.profileId, DeviceID: connection.deviceId };
    const editor = verifyChannelOrderAuthority(attestation, channelId, editorProof, actor);
    if (editor.kind !== settings.kind || editor.categoryId !== settings.categoryId || editor.settingsDigest !== settings.settingsDigest) {
      throw failure('INVALID_CHANNEL_POLICY_PROOF');
    }
    return { ...settings, digest: attestation.digest, attestation };
  }
  async readProtectedChannelACL(connection, channelId) {
    const { attestation, ...basis } = await this.#verifiedProtectedChannelACL(connection, channelId);
    return basis;
  }
  async #verifiedProtectedChannelACL(connection, channelId) {
    if (!hexID(channelId, 32) || connection.policyTrust?.serverId !== connection.serverId) throw failure('INVALID_PROTECTED_SESSION');
    const { deviceId } = await this.identity();
    if (deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
    const attestation = await this.readProtectedPolicyAttestation(connection);
    if (!(attestation.projectionVersion >= channelACLProjectionVersion)) throw failure('POLICY_ATTESTATION_UNAVAILABLE');
    const disclosure = await this.fetchJSON(connection.base, `/api/v3/policy/channel-acl/${channelId}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (disclosure?.revision !== attestation.revision) throw failure('PROTECTED_POLICY_CHANGED');
    return { ...verifyChannelACLAuthority(attestation, channelId, disclosure, { ProfileID: connection.profileId, DeviceID: deviceId }),
      policyHead: attestation.digest, attestation };
  }
  async readProtectedChannelPersonalACL(connection, channelId, profileId) {
    if (!hexID(profileId, 64) || profileId === connection.profileId) throw failure('PROTECTED_ACCESS_DENIED');
    const basis = await this.#verifiedProtectedChannelACL(connection, channelId);
    const target = await this.fetchJSON(connection.base, `/api/v3/policy/channel-acl/${channelId}/personal/${profileId}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (target?.revision !== basis.revision || target.policyHead !== basis.policyHead) throw failure('PROTECTED_POLICY_CHANGED');
    const { rules } = target;
    const valid = list => list === null || Array.isArray(list) && list.every(permission => permissionFitsACL(permission, basis.kind));
    if (target.channelId !== channelId || target.profileId !== profileId || (rules !== null &&
        (!rules || Object.keys(rules).length !== 2 || !valid(rules.Allow) || !valid(rules.Deny) ||
          (rules.Allow ?? []).some(permission => rules.Deny?.includes(permission))))) throw failure('INVALID_API_RESPONSE');
    if (basis.attestation.projectionVersion >= profileRankProjectionVersion) {
      verifyPersonalACLTargetRank(basis.attestation, target.rankBasis, connection.profileId, profileId);
    }
    return { channelId, profileId, kind: basis.kind, categoryId: basis.categoryId, synchronized: basis.synchronized,
      revision: basis.revision, policyHead: basis.policyHead, rules };
  }
  async readProtectedChannelSettings(connection, channelId) {
    const basis = await this.#verifiedProtectedChannelSettings(connection, channelId);
    const settings = basis.settings === null ? null : { name: basis.settings.Name, description: basis.settings.Description,
      slowmodeSeconds: basis.settings.SlowmodeSeconds, voiceCapacity: basis.settings.VoiceCapacity };
    return { channelId, kind: basis.kind, settings, policyHead: basis.digest, policyRevision: basis.revision };
  }
  #prepareScopedChannelEdit(connection, retryKey, prepare) {
    let pending = this.#scopedChannelEdits.get(connection);
    if (!pending) {
      pending = new Map();
      this.#scopedChannelEdits.set(connection, pending);
    }
    let prepared = pending.get(retryKey);
    if (!prepared) {
      prepared = prepare().catch(error => {
        if (pending.get(retryKey) === prepared) pending.delete(retryKey);
        throw error;
      });
      if (pending.size >= 8) pending.delete(pending.keys().next().value);
      pending.set(retryKey, prepared);
    }
    return prepared;
  }
  async readScopedRoles(connection, profileId, channelId) {
    if ((profileId !== undefined && !hexID(profileId, 64)) ||
        (channelId !== undefined && (!profileId || !hexID(channelId, 32)))) throw failure('INVALID_INPUT');
    const query = new URLSearchParams();
    if (profileId) query.set('profile', profileId);
    if (channelId) query.set('channel', channelId);
    const value = await this.fetchJSON(connection.base, '/api/v3/roles/scoped' + (query.size ? `?${query}` : ''), {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    const entries = profileId ? value?.assignments : value?.definitions;
    const roleId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
    if (!Number.isSafeInteger(value?.revision) || value.revision < 1 || !hexID(value.policyHead, 64) ||
        value.targetProfileId !== profileId || value.rosterChannelId !== channelId || !Array.isArray(entries) ||
        entries.some(entry => !roleId(entry?.id)) || new Set(entries.map(entry => entry.id)).size !== entries.length) throw failure('INVALID_API_RESPONSE');
    if (profileId) {
      if (Object.keys(value).some(key => !['revision', 'policyHead', 'assignments', 'targetProfileId', 'rosterChannelId'].includes(key)) ||
          entries.some(role => role.id === '@everyone' || (role.name !== undefined && typeof role.name !== 'string') ||
            typeof role.assigned !== 'boolean' || typeof role.canAssign !== 'boolean')) throw failure('INVALID_API_RESPONSE');
    } else if (Object.keys(value).some(key => !['revision', 'policyHead', 'definitions', 'grantOptions'].includes(key)) ||
        (entries.length && entries[0].id !== '@everyone') || entries.some(role => !Array.isArray(role.grants) || role.grants.some(grant => typeof grant !== 'string') ||
          (role.presentation !== undefined && (typeof role.presentation?.Name !== 'string' ||
            ['Color', 'Icon'].some(key => role.presentation[key] !== undefined && typeof role.presentation[key] !== 'string') ||
            ['Hoist', 'Mentionable'].some(key => role.presentation[key] !== undefined && typeof role.presentation[key] !== 'boolean')))) ||
        (value.grantOptions !== undefined && (!Array.isArray(value.grantOptions) || value.grantOptions.some(grant => typeof grant !== 'string')))) {
      throw failure('INVALID_API_RESPONSE');
    }
    return value;
  }
  async previewScopedRoles(connection, change) {
    const value = await this.fetchJSON(connection.base, '/api/v3/roles/scoped/preview', {
      method: 'POST', fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` }, body: JSON.stringify(change),
    });
    if (value?.revision !== change.revision || value.policyHead !== change.policyHead || !Array.isArray(value.channels) ||
        value.channels.some(channel => !hexID(channel?.id, 32) || typeof channel.keyUpdate !== 'boolean' ||
          !['viewAdded', 'viewRemoved', 'fullHistoryAdded', 'fullHistoryRemoved'].every(key => Number.isSafeInteger(channel[key]) && channel[key] >= 0))) {
      throw failure('INVALID_API_RESPONSE');
    }
    if (value.rosterSalt !== undefined) {
      const alias = scopedRoleRosterAlias(change.rosterChannelId, value.rosterSalt);
      const scopes = this.#roleRosterPreviews.get(connection) ?? new Map();
      if (scopes.size >= 32) scopes.delete(scopes.keys().next().value);
      scopes.set(`${change.policyHead}:${change.rosterChannelId}`, alias);
      this.#roleRosterPreviews.set(connection, scopes);
    }
    return value.channels.map(({ id, keyUpdate, viewAdded, viewRemoved, fullHistoryAdded, fullHistoryRemoved }) =>
      ({ id, keyUpdate, viewAdded, viewRemoved, fullHistoryAdded, fullHistoryRemoved }));
  }
  async commitScopedRoles(connection, operationId, change) {
    const { device, deviceId } = await this.identity();
    if (deviceId !== connection.deviceId || !connection.policyTrust) throw failure('INVALID_PROTECTED_SESSION');
    const actor = { ProfileID: connection.profileId, DeviceID: deviceId };
    const rosterCommitment = this.#roleRosterPreviews.get(connection)?.get(`${change.policyHead}:${change.rosterChannelId}`);
    const reviewedChange = rosterCommitment ? { ...change, rosterCommitment } : change;
    const signature = signScopedRoleEdit(connection.policyTrust, actor, operationId, reviewedChange, device);
    const request = { operationId, change: reviewedChange, signature };
    const receipt = await this.fetchJSON(connection.base, '/api/v3/roles/scoped/commit', {
      method: 'POST', fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` }, body: JSON.stringify(request),
    });
    verifyScopedRoleReceipt(connection.policyTrust, actor, request, receipt);
  }
  async commitProtectedChannelACL(connection, channelId, kind, policyHead, rules) {
    if (!hexID(channelId, 32) || !hexID(policyHead, 64)) throw failure('INVALID_INPUT');
    const rulesJSON = channelACLRulesJSON(kind, rules);
    if (Buffer.byteLength(rulesJSON) >= 512 * 1024) throw failure('INVALID_INPUT');
    const retryKey = `acl:${channelId}:${policyHead}:${hash(rulesJSON)}`;
    const request = await this.#prepareScopedChannelEdit(connection, retryKey, async () => {
      const basis = await this.readProtectedChannelACL(connection, channelId);
      if (basis.policyHead !== policyHead || basis.kind !== kind) throw failure('PROTECTED_POLICY_CHANGED');
      const { device, deviceId } = await this.identity();
      if (deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
      const operationId = requestID();
      const actor = { ProfileID: connection.profileId, DeviceID: deviceId };
      const editorProof = signProtectedChannelACLRoleEdit(connection.policyTrust, actor, { ...basis, digest: policyHead }, rules, operationId, device);
      const fields = JSON.stringify({ operationId, policyHead, previousRulesDigest: channelACLRulesDigest(kind, basis.rules), editorProof });
      return { operationId, revision: basis.revision + 1, body: `${fields.slice(0, -1)},"rules":${rulesJSON}}` };
    });
    const receipt = await this.fetchJSON(connection.base, `/api/v3/policy/channel-acl/${channelId}`, {
      method: 'POST', fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` }, body: request.body,
    });
    if (receipt?.operationId !== request.operationId || receipt.revision !== request.revision || !hexID(receipt.digest, 64)) {
      throw failure('INVALID_API_RESPONSE');
    }
    return { channelId, revision: receipt.revision };
  }
  async commitProtectedChannelPersonalACL(connection, channelId, profileId, policyHead, permission, rule) {
    if (!hexID(channelId, 32) || !hexID(profileId, 64) || !hexID(policyHead, 64) ||
        typeof permission !== 'string' || !['allow', 'deny', 'inherit'].includes(rule)) throw failure('INVALID_INPUT');
    const retryKey = `personal-acl:${channelId}:${policyHead}:${profileId}:${permission}:${rule}`;
    const request = await this.#prepareScopedChannelEdit(connection, retryKey, async () => {
      const basis = await this.readProtectedChannelPersonalACL(connection, channelId, profileId);
      if (basis.policyHead !== policyHead) throw failure('PROTECTED_POLICY_CHANGED');
      if (!permissionFitsACL(permission, basis.kind)) throw failure('INVALID_INPUT');
      const { device, deviceId } = await this.identity();
      if (deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
      const operationId = requestID();
      const actor = { ProfileID: connection.profileId, DeviceID: deviceId };
      const editorProof = signProtectedChannelACLPersonalEdit(connection.policyTrust, actor, { ...basis, digest: policyHead },
        profileId, permission, rule, operationId, device);
      return { operationId, revision: basis.revision + 1,
        body: JSON.stringify({ operationId, policyHead, targetProfileId: profileId, permission, rule, editorProof }) };
    });
    const receipt = await this.fetchJSON(connection.base, `/api/v3/policy/channel-acl/${channelId}/personal`, {
      method: 'POST', fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` }, body: request.body,
    });
    if (receipt?.operationId !== request.operationId || receipt.revision !== request.revision || !hexID(receipt.digest, 64)) {
      throw failure('INVALID_API_RESPONSE');
    }
    return { channelId, profileId, revision: receipt.revision };
  }
  async commitProtectedChannelSettings(connection, channelId, policyHead, settings) {
    if (!hexID(channelId, 32) || !hexID(policyHead, 64)) throw failure('INVALID_INPUT');
    const retryKey = `settings:${channelId}:${policyHead}:${hash(JSON.stringify(settings))}`;
    const request = await this.#prepareScopedChannelEdit(connection, retryKey, async () => {
      const basis = await this.#verifiedProtectedChannelSettings(connection, channelId);
      if (basis.digest !== policyHead) throw failure('PROTECTED_POLICY_CHANGED');
      const { device, deviceId } = await this.identity();
      if (deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
      const operationId = requestID();
      const actor = { ProfileID: connection.profileId, DeviceID: deviceId };
      const editorProof = signProtectedChannelSettingsEdit(connection.policyTrust, actor, basis, settings, operationId, device);
      return { input: { operationId, policyHead, previousSettingsDigest: basis.settingsDigest, settings, editorProof },
        revision: basis.revision + 1, actor, attestation: basis.attestation };
    });
    const receipt = await this.fetchJSON(connection.base, `/api/v3/policy/channel-settings/${channelId}`, {
      method: 'POST', fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify(request.input),
    });
    if (receipt?.operationId !== request.input.operationId || receipt.revision !== request.revision || !hexID(receipt.digest, 64)) {
      throw failure('INVALID_API_RESPONSE');
    }
    const evidence = await this.fetchJSON(connection.base, `/api/v3/policy/channel-settings/${channelId}/edit?digest=${receipt.digest}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    }).catch(error => {
      // Older API 3 hosts still use the regular attested-settings check.
      if (error.status === 404) return null;
      throw error;
    });
    if (evidence !== null) verifyProtectedChannelSettingsReceipt(connection.policyTrust, request.actor, channelId,
      request.attestation, request.input, receipt, evidence);
    return { channelId, revision: receipt.revision, confirmed: evidence !== null };
  }
  async readVerifiedProtectedChannelOrder(connection, channelId, digest) {
    if (!hexID(channelId, 32) || !hexID(digest, 64)) throw failure('INVALID_CHANNEL');
    const evidence = await this.fetchJSON(connection.base, `/api/v3/policy/channel-order/${channelId}/proof?digest=${digest}`, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (evidence === null) return null;
    const revision = evidence?.change?.revision;
    if (!Number.isSafeInteger(revision) || revision < 1 || digest !== evidence.digest) {
      throw failure('INVALID_CHANNEL_ORDER_PROOF');
    }
    const attestation = await this.readProtectedPolicyAttestation(connection, revision);
    return verifyChannelLayoutEvidence(connection.serverId, channelId, evidence, attestation);
  }
  async #protectedChannelOrderEvidence(connection, channels, mixed = false) {
    if (channels.some(id => !hexID(id, 32))) throw failure('INVALID_CHANNEL');
    const { deviceId } = await this.identity();
    if (deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
    const view = await this.readProtectedPolicyAttestation(connection);
    const actor = { ProfileID: connection.profileId, DeviceID: deviceId };
    const scopes = await Promise.all(channels.map(async channelId => {
      const proof = await this.fetchJSON(connection.base, `/api/v3/policy/channel-order/${channelId}`, {
        fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
      });
      return verifyChannelOrderAuthority(view, channelId, proof, actor);
    }));
    const [source, anchor] = scopes;
    if (anchor && (source.channelId === anchor.channelId || source.categoryId !== anchor.categoryId ||
        (!mixed && !source.categoryId && source.kind !== anchor.kind))) throw failure('PROTECTED_ACCESS_DENIED');
    return { view, scopes, actor };
  }
  async syncProtectedPolicyAttestations(connection) {
    const trust = connection.policyTrust;
    if (trust?.serverId !== connection.serverId || !isProtectedOwner(connection)) return;
    const identity = await this.identity();
    if (identity.deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
    const pending = await this.fetchJSON(connection.base, '/api/v3/policy/attestations/pending', {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (!Number.isSafeInteger(pending?.headRevision) || pending.headRevision < 1 || !hexID(pending.headDigest, 64) ||
        !Array.isArray(pending.revisions) || pending.revisions.length > 4 || pending.revisions.some((revision, index) =>
          !Number.isSafeInteger(revision) || revision <= (pending.revisions[index - 1] ?? 0) || revision > pending.headRevision)) {
      throw failure('INVALID_API_RESPONSE');
    }
    const checkpoint = this.policyCheckpoint();
    let head = await checkpoint.load(trust);
    if (head?.revision > pending.headRevision) throw failure('POLICY_ROLLBACK');
    if (!head?.complete || head.revision < pending.headRevision) {
      await this.refreshProtectedRuntimePolicy(connection, trust);
      head = await checkpoint.load(trust);
    }
    if (!head?.complete || head.revision < pending.headRevision) throw failure('UNVERIFIED_EPOCH_POLICY');
    if (head.revision === pending.headRevision && head.digest !== pending.headDigest) throw failure('POLICY_FORK');
    let issuing = {};
    if (pending.authorityHead !== undefined) {
      const { state } = await this.#readScopeAuthority(connection, trust, pending.headRevision);
      const { authorityHead, authorityRevision, signerDeviceId, signerProfileId } = pending;
      if (state.digest !== authorityHead || state.revision !== authorityRevision || signerDeviceId !== connection.deviceId ||
          (signerProfileId ?? trust.ownerProfileId) !== connection.profileId ||
          hash(Buffer.from(state.deviceKey, 'hex')) !== signerDeviceId || head.scopeAuthority?.digest !== authorityHead) {
        throw failure('INVALID_SCOPE_AUTHORITY');
      }
      issuing = { authorityHead, authorityRevision, signerDeviceId, ...(signerProfileId !== undefined && { signerProfileId }) };
    } else if (connection.deviceId !== trust.ownerDeviceId || scopeAuthorityRequiresV2(trust, head.scopeAuthority)) {
      throw failure('INVALID_SCOPE_AUTHORITY');
    }
    if (pending.revisions.length === 0) return;
    const claims = await checkpoint.attestationClaimsForRevisions(trust, pending.revisions,
      after => this.fetchProtectedRuntimePolicyPage(connection, after));
    // Make current-channel access usable first when several revisions are missing.
    if (claims.length > 1 && claims.at(-1).revision === pending.headRevision) claims.unshift(claims.pop());
    for (const entry of claims) await this.#postProtectedPolicyAttestation(connection, { ...entry, ...issuing }, identity.device);
  }
  async refreshProtectedRuntimePolicy(connection, trust) {
    if (trust?.serverId !== connection.serverId) throw failure('UNTRUSTED_POLICY_ANCHOR');
    const checkpoint = this.policyCheckpoint();
    const fetchPage = after => this.fetchProtectedRuntimePolicyPage(connection, after);
    let saved = await checkpoint.load(trust);
    for (let page = 0; page < 32; page++) {
      const proofs = await fetchPage(saved?.revision ?? 0);
      saved = await checkpoint.accept(proofs, trust, fetchPage);
      if (saved.complete) return { ...saved, importedRoleNames: proofs.importedRoleNames, importedProfileNames: proofs.importedProfileNames };
    }
    throw failure('POLICY_CHAIN_GAP');
  }
  async previewProtectedRuntimePolicy(connection, intent, trust) {
    if (trust?.serverId !== connection.serverId || !hexID(intent?.OperationID, 32)) throw failure('INVALID_POLICY_PREVIEW');
    const previous = await this.policyCheckpoint().load(trust);
    const scoped = !isProtectedOwner(connection, trust) && (!previous?.complete || connection.ownership?.transferred) && intent.Action === 'channel.order'
      ? await this.#protectedChannelOrderEvidence(connection, [intent.ResourceChange?.ID, intent.ResourceChange?.AnchorID],
        intent.ResourceChange?.MixedOrder) : undefined;
    const preview = await this.fetchJSON(connection.base,
      `/api/v3/policy/preview?projection=${channelACLProjectionVersion}&maxProjection=${profileRoleAuthorityProjectionVersion}`, {
      method: 'POST', body: JSON.stringify(intent), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (scoped) validateScopedChannelOrderPreview(preview, intent, scoped.actor, scoped.view);
    else await this.#runtimePolicyPreviewFrame(connection, preview, intent, trust,
      { ProfileID: connection.profileId, DeviceID: connection.deviceId }, previous);
    return preview;
  }
  async readProtectedOwnerPolicy(connection) {
    if (!isProtectedOwner(connection)) throw failure('PROTECTED_ACCESS_DENIED');
    const policy = await this.readProtectedManagementPolicy(connection);
    if (policy.snapshot.Owner !== connection.profileId) throw failure('PROTECTED_ACCESS_DENIED');
    return policy;
  }
  async readProtectedManagementPolicy(connection) {
    const trust = connection.policyTrust;
    if (!trust || trust.serverId !== connection.serverId) {
      throw failure('PROTECTED_ACCESS_DENIED');
    }
    const { importedRoleNames, importedProfileNames } = await this.refreshProtectedRuntimePolicy(connection, trust);
    const head = await this.policyCheckpoint().load(trust);
    if (!head?.complete) throw failure('UNVERIFIED_EPOCH_POLICY');
    const snapshot = JSON.parse(Buffer.from(head.snapshot, 'base64'));
    if (!canInspectFullPolicy(snapshot, connection.profileId, connection.deviceId)) throw failure('PROTECTED_ACCESS_DENIED');
    const verifiedNames = (scope, imported) => Object.fromEntries(Object.keys(scope ?? {}).flatMap(id => {
      const name = imported && Object.hasOwn(imported, id) ? imported[id] : undefined;
      return typeof name === 'string' && name.length > 0 && name.length <= 256 && !/\p{Cc}/u.test(name) ? [[id, name]] : [];
    }));
    return { revision: head.revision, digest: head.digest, snapshot, importedRoleNames: verifiedNames(snapshot.Roles, importedRoleNames),
      importedProfileNames: verifiedNames(snapshot.Members, importedProfileNames) };
  }
  async verifyProtectedRuntimePolicyPreview(connection, preview, intent, trust) {
    const { deviceId } = await this.identity();
    if (deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
    const actor = { ProfileID: connection.profileId, DeviceID: deviceId };
    const previous = await this.policyCheckpoint().load(trust);
    if (!isProtectedOwner(connection, trust) && (!previous?.complete || connection.ownership?.transferred) && intent?.Action === 'channel.order') {
      const { view } = await this.#protectedChannelOrderEvidence(connection, [intent.ResourceChange?.ID, intent.ResourceChange?.AnchorID],
        intent.ResourceChange?.MixedOrder);
      return validateScopedChannelOrderPreview(preview, intent, actor, view);
    }
    await this.#runtimePolicyPreviewFrame(connection, preview, intent, trust, actor, previous);
  }
  #runtimePolicyPreviewFrame(connection, preview, intent, trust, actor, previous) {
    return runtimePolicyPreviewFrame(preview, intent, trust, actor, previous, (revision, digest) =>
      this.policyCheckpoint().inviteIssuanceBasis(trust, previous, revision, digest, after => this.fetchProtectedRuntimePolicyPage(connection, after)));
  }
  async commitProtectedRuntimePolicy(connection, { preview, intent, expectedResultDigest }, trust) {
    if (trust?.serverId !== connection.serverId || !hexID(expectedResultDigest, 64) ||
        preview?.draft?.ResultDigest !== expectedResultDigest) throw failure('INVALID_POLICY_PREVIEW');
    const { deviceId, device } = await this.identity();
    if (deviceId !== connection.deviceId) throw failure('INVALID_PROTECTED_SESSION');
    const actor = { ProfileID: connection.profileId, DeviceID: deviceId };
    const previous = await this.policyCheckpoint().load(trust);
    if (intent?.Action === 'channel.order' && preview.channelOrderBasis !== undefined) {
      const version = preview.channelOrderBasisVersion;
      const mixed = intent.ResourceChange?.MixedOrder === true;
      if (!hexID(preview.channelOrderBasis, 64) || (mixed ? version !== 3 : version !== undefined && version !== 2)) {
        throw failure('INVALID_POLICY_PREVIEW');
      }
      let basis = previous;
      if (previous?.complete) {
        await this.#runtimePolicyPreviewFrame(connection, preview, intent, trust, actor, previous);
      } else {
        const { view } = await this.#protectedChannelOrderEvidence(connection, [intent.ResourceChange?.ID, intent.ResourceChange?.AnchorID], mixed);
        validateScopedChannelOrderPreview(preview, intent, actor, view);
        basis = view;
      }
      const { OperationID: operationId, ResourceChange: { ID: source, AnchorID: anchor, After: after = false } } = intent;
      const input = { operationId, source, anchor, after, revision: basis.revision, policyHead: basis.digest, orderBasis: preview.channelOrderBasis,
        ...(version !== undefined && { basisVersion: version }) };
      const signature = sign(null, channelLayoutFrame(connection.serverId, actor, input), device);
      const receipt = await this.fetchJSON(connection.base, '/api/v3/policy/channel-order', {
        method: 'POST', body: JSON.stringify({ ...input, signature: signature.toString('base64') }), fingerprint: connection.fingerprint,
        headers: { Authorization: `Bearer ${connection.token}` },
      });
      if (receipt?.digest !== hash(signature) || typeof receipt.existing !== 'boolean') throw failure('INVALID_API_RESPONSE');
      return receipt;
    }
    const frame = await this.#runtimePolicyPreviewFrame(connection, preview, intent, trust, actor, previous);
    const signature = sign(null, frame, device);
    const draft = { ...preview.draft, Signature: signature.toString('base64') };
    const digest = hash(signature);
    let scopeAttestation;
    if (connection.policyTrust?.anchorDigest === trust.anchorDigest && isProtectedOwner(connection) && !connection.ownership?.transferred &&
        actor.ProfileID === trust.ownerProfileId &&
        actor.DeviceID === trust.ownerDeviceId && hasTextRecipientProjection(draft.TextProjectionVersion)) {
      scopeAttestation = signProtectedPolicyScope(trust, draft, digest, device).toString('base64');
    }
    const proof = await this.fetchJSON(connection.base, '/api/v3/policy/commit', {
      method: 'POST', body: JSON.stringify({ ...draft, ...(scopeAttestation && { scopeAttestation }) }), fingerprint: connection.fingerprint,
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    if (proof?.Digest !== digest || !isDeepStrictEqual(proof.Principal, actor) || !isDeepStrictEqual(proof.Draft, draft)) {
      throw failure('INVALID_POLICY_PROOF');
    }
    return proof;
  }
  async enrollProtectedMigrationRecovery(serverId, { archiveSha256, ownerProfileId, code }) {
    if (!hexID(serverId, 32) || !hexID(archiveSha256, 64) || !hexID(ownerProfileId, 64)) throw failure('INVALID_MIGRATION_RECOVERY');
    const { base, fingerprint, nonce, agreementKey } = await this.migrationChallenge(serverId, true);
    const identity = await this.identity();
    const { proposal, recoveryId } = proposeMigrationRecovery({ serverId, archiveSha256, ownerProfileId, nonce,
      serverAgreementKey: agreementKey, code, identity });
    const result = await this.fetchJSON(base, '/api/v3/migration/recovery', { method: 'POST', body: JSON.stringify(proposal), fingerprint });
    if (result?.recoveryId !== recoveryId || result.signingKey !== proposal.signingKey || result.agreementKey !== proposal.agreementKey) {
      throw failure('INVALID_MIGRATION_RECOVERY_RECEIPT');
    }
    return result;
  }
  async stageProtectedMigrationRecoveryArchive(serverId, { archiveSha256, ownerProfileId, code, recovery, archive }) {
    const { deviceId, device } = await this.identity();
    const { recoveryId, agreementKey, signingKey } = recovery;
    const { channelId, keyId, secret } = archive;
    if (archive.purpose !== 'archive' || archive.generation !== 1) throw failure('INVALID_MIGRATION_RECOVERY_PACKAGE');
    const context = { serverId, archiveSha256, ownerProfileId, recoveryId, agreementKey, channelId, keyId, deviceId };
    const packet = sealMigrationRecoveryPackage(secret, context, device);
    const deviceKey = createPublicKey(device).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    const confirmation = confirmMigrationRecoveryPackage(packet, context, code, deviceKey, signingKey);
    const { base, fingerprint, nonce } = await this.migrationChallenge(serverId);
    const frame = signatureFrame('pawtalk-migration-recovery-archive-request-v1', serverId, archiveSha256, recoveryId,
      channelId, keyId, deviceId, nonce, hash(Buffer.from(packet.ciphertext, 'base64url')), packet.signature, confirmation);
    const body = JSON.stringify({ archiveSha256, recoveryId, channelId, keyId, deviceId, nonce,
      ...packet, confirmation, deviceProof: sign(null, frame, device).toString('base64url') });
    const receipt = await this.fetchJSON(base, '/api/v3/migration/recovery/archive', { method: 'POST', body, fingerprint });
    if (receipt?.channelId !== channelId || receipt.keyId !== keyId || receipt.recoveryId !== recoveryId ||
        !hexID(receipt.ciphertextSha256, 64)) throw failure('INVALID_MIGRATION_RECOVERY_RECEIPT');
    return receipt;
  }
  async submitProtectedMigrationRecord(serverId, packet) {
    const { kind, id, migratorDeviceId } = packet ?? {};
    if (!hexID(serverId, 32) || !['messages', 'attachments', 'polls'].includes(kind) || typeof id !== 'string' || id.length > 32) throw failure('INVALID_MIGRATION_PACKET');
    const { deviceId, device } = await this.identity();
    if (migratorDeviceId !== deviceId) throw failure('INVALID_MIGRATION_SIGNER');
    const body = JSON.stringify(packet), digest = hash(body);
    const { base, fingerprint, nonce } = await this.migrationChallenge(serverId);
    const frame = signatureFrame('pawtalk-migration-import-request-v1', serverId, deviceId, nonce, kind, digest);
    const receipt = await this.fetchJSON(base, `/api/v3/migration/history/${kind}/import`, {
      method: 'POST', body, fingerprint, headers: {
        'X-PawTalk-Migration-Nonce': nonce, 'X-PawTalk-Migration-Device': deviceId,
        'X-PawTalk-Migration-Body-SHA256': digest, 'X-PawTalk-Migration-Signature': sign(null, frame, device).toString('base64url'),
      },
    });
    if (receipt?.kind !== kind || receipt.id !== id || !hexID(receipt.ciphertextSha256, 64)) throw failure('INVALID_API_RESPONSE');
    return receipt;
  }
  async reencryptProtectedMigrationRecord(serverId, { archiveSha256, archive, kind, record }) {
    if (!hexID(serverId, 32)) throw failure('INVALID_MIGRATION_RECORD');
    const saved = await this.credentials.load('pawtalk:server:v2:' + serverId);
    const legacySecret = saved ? JSON.parse(saved)?.secret : undefined;
    if (!hexID(legacySecret, 64)) throw failure('MIGRATION_LEGACY_KEY_UNAVAILABLE');
    const identity = await this.identity();
    return reencryptMigratedHistoryRecord({ serverId, archiveSha256, legacySecret, archive, kind, record, identity });
  }
  async records() {
    const raw = await this.credentials.load('pawtalk:memberships:v2');
    if (!raw) return [];
    const result = JSON.parse(raw);
    if (!Array.isArray(result) || result.length > 1000 || result.some(item => !item || !hexID(item.serverId, 32) || typeof item.address !== 'string' || item.address.includes('#') || typeof item.name !== 'string')) throw failure('INVALID_LOCAL_MEMBERSHIPS');
    if(result.some(item=>item.pendingLeave&&(!hexID(item.pendingLeave.requestId,32)||!Number.isSafeInteger(item.pendingLeave.nextAttempt))))throw failure('INVALID_LOCAL_MEMBERSHIPS');
    return result;
  }
  async registry() { return (await this.records()).filter(record=>!record.pendingLeave); }
  async remember(connection, expectedAddress) {
    const operation = this.registryQueue.catch(() => {}).then(async () => {
      const servers = await this.records();
      const item = { serverId: connection.config.serverId, address: connection.address, name: connection.displayName ?? connection.config.name };
      const index = servers.findIndex(server => server.serverId === item.serverId);
      if(servers[index]?.pendingLeave)throw failure('LEAVE_PENDING');
      if (expectedAddress !== undefined) {
        if (index < 0) throw failure('NOT_A_MEMBER');
        if (servers[index].address !== expectedAddress) throw failure('BUSY');
      }
      if (index < 0) servers.push(item); else servers[index] = item;
      await this.credentials.save('pawtalk:memberships:v2', JSON.stringify(servers));
    });
    this.registryQueue = operation.catch(() => {}); return operation;
  }
  async forget(serverId) {
    this.connections.delete(serverId);
    this.#recoveredDeviceKeys.delete(serverId);
    this.#archiveResume.clear(serverId);
    this.#clearTextStatus(serverId);
    const operation = this.registryQueue.catch(() => {}).then(async () => {
      const records = (await this.records()).filter(record => record.serverId !== serverId);
      await this.credentials.save('pawtalk:memberships:v2', JSON.stringify(records));
    });
    this.registryQueue = operation.catch(() => {}); return operation;
  }
  async join(address, nickname, deviceLabel) {
    if (typeof address !== 'string' || address.length > 14000) throw failure('INVALID_INVITE');
    const url = new URL(address), values = new URLSearchParams(url.hash.slice(1));
    if (values.get('v') === '3') return values.get('setup') === '1'
      ? this.#setupProtectedStandalone(address, values, nickname, deviceLabel)
      : this.redeemProtectedInvite(address, nickname);
    if (this.protectedOnly) throw failure('UNSUPPORTED_PROTOCOL');
    const serverId = values.get('server'), inviteId = values.get('invite'), token = values.get('token'), setup = values.get('setup') === '1';
    if (values.get('v') !== '2' || !hexID(serverId, 32) || !hexID(inviteId, 32) || !/^[\w-]{43}$/.test(token || '')) throw failure('INVALID_INVITE');
    if((await this.records()).some(record=>record.serverId===serverId&&record.pendingLeave))throw failure('LEAVE_PENDING');
    const opening = values.get('open'), digest = values.get('package');
    if (!setup && (!hexID(opening, 64) || !hexID(digest, 64))) throw failure('INVALID_INVITE');
    const connection = await this.verified(address, serverId);
    const slot = 'pawtalk:server:v2:' + serverId;
    const existing = await this.credentials.load(slot); let saved = existing ? JSON.parse(existing) : {};
    if (connection.config.initialized && hexID(saved.secret, 64)) {
      try {
        const session = await this.signed(connection, '/api/v2/session', {});
        connection.token = session.sessionToken; connection.secret = saved.secret;
        this.connections.set(serverId, connection);
        const state = await this.state(serverId);
        await this.remember(connection); await this.credentials.save(slot, JSON.stringify({ secret: saved.secret }));
        return state;
      } catch (error) { if (error.code !== 'NOT_A_MEMBER') throw error; }
    }
    if (setup && connection.config.initialized) throw failure('ALREADY_INITIALIZED');
    if (saved.pending?.inviteId !== inviteId) {
      saved = { ...saved, pending: { inviteId, requestId: requestID() } };
      await this.credentials.save(slot, JSON.stringify(saved));
    }
    const prepared = await this.signed(connection, '/api/v2/invites/prepare', { inviteId, token, requestId: saved.pending.requestId, nickname, deviceLabel });
    if ((prepared.kind === 'bootstrap') !== setup || !hexID(prepared.attemptId, 32)) throw failure('INVALID_INVITE_RESPONSE');
    let secret;
    if (prepared.state === 'confirmed') {
      if (!hexID(saved.secret, 64)) throw failure('LOCAL_KEY_MISSING');
      secret = saved.secret;
    } else if (setup) secret = saved.secret || cryptoV2.randomSecret();
    else {
      if (prepared.packageDigest !== digest) throw failure('INVITATION_PACKAGE_CHANGED');
      secret = await cryptoV2.openInvitation(prepared.keyPackage, digest, serverId, inviteId, opening);
    }
    const keyId = await cryptoV2.rootKeyID(secret);
    saved = { ...saved, secret, pending: { ...saved.pending, attemptId: prepared.attemptId, deadline: prepared.deadline } };
    // No confirm before OS-protected save succeeds. This write also supports a
    // crash between saving keys and sending/receiving confirmation.
    await this.credentials.save(slot, JSON.stringify(saved));
    const result = await this.signed(connection, '/api/v2/invites/confirm', { attemptId: prepared.attemptId, requestId: saved.pending.requestId, packageDigest: prepared.packageDigest, keyId });
    if (typeof result.sessionToken !== 'string' || !/^[\w-]{43}$/.test(result.sessionToken)) throw failure('INVALID_API_RESPONSE');
    if ((await this.records()).some(value=>value.serverId===serverId&&value.pendingLeave)) throw failure('LEAVE_PENDING');
    connection.token = result.sessionToken; connection.secret = secret;
    this.connections.set(serverId, connection);
    await this.credentials.save(slot, JSON.stringify({ secret }));
    await this.remember(connection);
    return this.state(serverId);
  }
  async connect(record) {
    if ((await this.records()).some(value=>value.serverId===record.serverId&&value.pendingLeave)) throw failure('LEAVE_PENDING');
    const connection = await this.verified(record.address, record.serverId);
    const saved = await this.credentials.load('pawtalk:server:v2:' + record.serverId);
    const secret = saved && JSON.parse(saved).secret;
    if (!hexID(secret, 64)) throw failure('LOCAL_KEY_MISSING');
    const result = await this.signed(connection, '/api/v2/session', {});
    if ((await this.records()).some(value=>value.serverId===record.serverId&&value.pendingLeave)) throw failure('LEAVE_PENDING');
    connection.token = result.sessionToken; connection.secret = secret;
    this.connections.set(record.serverId, connection);
    return this.state(record.serverId);
  }
  async changeAddress(serverId, address) {
    // A trusted new transport never changes the saved server signing identity.
    // It also cannot create membership or bypass the admission protocol.
    if (this.protectedOnly) throw failure('PROTECTED_REJOIN_REQUIRED');
    const record = (await this.registry()).find(record => record.serverId === serverId);
    if (!record) throw failure('NOT_A_MEMBER');
    const previous = this.connections.get(serverId);
    try {
      const state = await this.connect({ ...record, address });
      await this.remember(this.connections.get(serverId));
      return state;
    } catch (error) {
      if (previous) this.connections.set(serverId, previous); else this.connections.delete(serverId);
      throw error;
    }
  }
  async request(serverId, path, method = 'GET', input) {
    const connection = this.connections.get(serverId);
    if (!connection || !path.startsWith('/api/v2/')) throw failure('NOT_CONNECTED');
    const body = input === undefined ? undefined : JSON.stringify(input);
    try {
      try { return await this.fetchJSON(connection.base, path, { method, body, fingerprint: connection.fingerprint, headers: { Authorization: 'Bearer ' + connection.token } }); }
      catch (failure) {
        if (failure.code !== 'INVALID_SESSION') throw failure;
        const session = await this.signed(connection, '/api/v2/session', {});
        connection.token = session.sessionToken;
        return await this.fetchJSON(connection.base, path, { method, body, fingerprint: connection.fingerprint, headers: { Authorization: 'Bearer ' + connection.token } });
      }
    } catch (failure) {
      if (['NOT_A_MEMBER', 'BANNED'].includes(failure.code)) await this.forget(serverId);
      throw failure;
    }
  }
  async state(serverId) {
    const result = await this.request(serverId, '/api/v2/state');
    const connection = this.connections.get(serverId);
    const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
    const integer=value=>Number.isSafeInteger(value)&&value>=0;
    const role=value=>['member','moderator','admin'].includes(value);
    if(!object(result)||!object(result.self)||typeof result.name!=='string'||result.name.length>256||!integer(result.revision)||!integer(result.controlRevision)||!hexID(result.self.profileId,64)||!hexID(result.self.effectiveProfileId,64)||!hexID(result.self.deviceId,64)||!role(result.self.role)||!Array.isArray(result.self.permissions)||result.self.permissions.length>256||result.self.permissions.some(value=>typeof value!=='string'||value.length>64))throw failure('INVALID_API_RESPONSE');
    const identity=await this.identity();if(result.self.profileId!==identity.profileId||result.self.deviceId!==identity.deviceId)throw failure('INVALID_API_RESPONSE');
    for(const [key,limit] of [['profiles',10000],['channels',1000],['members',10000],['devices',10000],['bindings',10000],['voice',10000]])if(!Array.isArray(result[key])||result[key].length>limit)throw failure('INVALID_API_RESPONSE');
    if(result.channels.some(value=>!object(value)||!hexID(value.id,32)||!['voice','text'].includes(value.kind)||typeof value.name!=='string'||value.name.length>256||typeof value.protected!=='boolean'||!integer(value.revision)||!integer(value.messageRevision)||!integer(value.lastMessageId))||
      result.members.some(value=>!object(value)||!hexID(value.profileId,64)||typeof value.online!=='boolean'||!role(value.role))||
      result.devices.some(value=>!object(value)||!hexID(value.id,64)||!hexID(value.originalProfileId,64)||typeof value.label!=='string'||value.label.length>128||typeof value.primary!=='boolean')||
      result.bindings.some(value=>!object(value)||!hexID(value.source,64)||!hexID(value.target,64))||
      result.voice.some(value=>!object(value)||!hexID(value.profileId,64)||!hexID(value.deviceId,64)||!hexID(value.channelId,32)||!hexID(value.identity,32)))throw failure('INVALID_API_RESPONSE');
    if (result.serverId !== serverId || result.keyId !== await cryptoV2.rootKeyID(connection.secret)) throw failure('SERVER_KEY_CHANGED');
    if(result.capabilities!==undefined){if(!Array.isArray(result.capabilities)||result.capabilities.length>128||result.capabilities.some(c=>typeof c!=='string'||c.length>64))throw failure('INVALID_API_RESPONSE');connection.config={...connection.config,capabilities:[...result.capabilities]};}
    if (!Array.isArray(result.profiles) || result.profiles.length > 10000 || !Array.isArray(result.channels) || result.channels.length > 1000) throw failure('INVALID_API_RESPONSE');
    result.profiles = await Promise.all(result.profiles.map(async profile => {
      if (!object(profile)||!hexID(profile.id, 64) || typeof profile.nickname !== 'string' || profile.nickname.length > 128 || !Number.isSafeInteger(profile.revision)) throw failure('INVALID_API_RESPONSE');
      const cacheKey = `${serverId}:${profile.id}:${profile.revision}`;
      if (this.profileCache.has(cacheKey)) return this.profileCache.get(cacheKey);
      let avatar;
      if (profile.avatarEnvelope) {
        try {
          if (typeof profile.avatarEnvelope !== 'string' || profile.avatarEnvelope.length > 24000) throw failure('INVALID_AVATAR');
          const packet = JSON.parse(Buffer.from(profile.avatarEnvelope, 'base64').toString('utf8'));
          const owner = profile.avatarContextProfileId || profile.id;
          const bytes = await cryptoV2.openContent(connection.secret, serverId, 'avatar', '', owner, owner, packet);
          const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (value.length <= 12000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {const metadata=inspectImage(Buffer.from(value.slice(value.indexOf(',')+1),'base64'));if(metadata&&metadata.width<=512&&metadata.height<=512)avatar = value;}
        } catch { /* Invalid avatar never blocks readable messages or falls back to plaintext. */ }
      }
      const output = { id: profile.id, nickname: profile.nickname, revision: profile.revision, avatar };
      this.profileCache.set(cacheKey, output);
      if (this.profileCache.size > 1000) this.profileCache.delete(this.profileCache.keys().next().value);
      return output;
    }));
    if(result.avatarEnvelope){
      try{
        if(typeof result.avatarEnvelope!=='string'||result.avatarEnvelope.length>24000||!hexID(result.avatarAuthor,64))throw failure('INVALID_AVATAR');
        const packet=JSON.parse(Buffer.from(result.avatarEnvelope,'base64').toString('utf8'));
        const clear=await cryptoV2.openContent(connection.secret,serverId,'avatar','','server-avatar',result.avatarAuthor,packet);
        const value=new TextDecoder('utf-8',{fatal:true}).decode(clear);this.validateAvatar(value);result.avatar=value;
      }catch{/* Unreadable server artwork does not block membership. */}
    }
    if(connection && result.name !== (connection.displayName ?? connection.config.name)){
      await this.remember({...connection,displayName:result.name});connection.displayName=result.name;
    }
    return result;
  }
  validateAvatar(value){
    if(typeof value!=='string'||value.length>12000||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))throw failure('INVALID_AVATAR');
    const image=inspectImage(Buffer.from(value.slice(value.indexOf(',')+1),'base64'));if(!image||image.width!==image.height||image.width>512)throw failure('INVALID_AVATAR');
  }
  async serverAvatar(serverId,value,expectedRevision){
    const connection=this.connections.get(serverId);if(!connection?.config?.capabilities?.includes('server-avatar-v1'))throw failure('UNSUPPORTED_FEATURE');
    const state=await this.state(serverId);let envelope=null;
    if(value!==null){this.validateAvatar(value);envelope=await cryptoV2.sealContent(connection.secret,serverId,'avatar','','server-avatar',state.self.effectiveProfileId,new TextEncoder().encode(value));}
    await this.request(serverId,'/api/v2/server/avatar','PATCH',{envelope,expectedRevision,requestId:requestID()});return this.state(serverId);
  }
  async profile(serverId, nickname, avatar, expectedRevision) {
    const state = await this.state(serverId), owner = state.self.effectiveProfileId;
    const connection = this.connections.get(serverId), input = { nickname, expectedRevision, requestId: requestID() };
    if (avatar === null) input.avatarEnvelope = null;
    else if (avatar !== undefined) {
      if (typeof avatar !== 'string' || avatar.length > 12000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar)) throw failure('INVALID_AVATAR');
      input.avatarEnvelope = await cryptoV2.sealContent(connection.secret, serverId, 'avatar', '', owner, owner, new TextEncoder().encode(avatar));
    }
    await this.request(serverId, '/api/v2/profile', 'PATCH', input);
    return this.state(serverId);
  }
  async invite(serverId, kind) {
    if (!['single', 'reusable'].includes(kind)) throw failure('INVALID_INVITE');
    const connection = this.connections.get(serverId); if (!connection) throw failure('NOT_CONNECTED');
    const inviteId = requestID(), rawToken = randomBytes(32), opening = cryptoV2.randomSecret();
    const { packet, digest } = await cryptoV2.sealInvitation(connection.secret, serverId, inviteId, opening);
    await this.request(serverId, '/api/v2/invites', 'POST', { inviteId, tokenHash: hash(rawToken), kind, keyPackage: packet, packageDigest: digest, requestId: requestID() });
    const link = new URL(connection.address);
    link.hash = new URLSearchParams({ v: '2', server: serverId, invite: inviteId, token: rawToken.toString('base64url'), open: opening, package: digest }).toString();
    return link.toString();
  }
  async messages(serverId, channelId, options = {}) {
    if (!hexID(channelId, 32)) throw failure('INVALID_CHANNEL');
    const query = new URLSearchParams();
    for (const key of ['limit', 'before', 'after', 'readAfter','around']) if (options[key] !== undefined) {
      if (!Number.isSafeInteger(options[key]) || options[key] < 0) throw failure('INVALID_PAGE');
      query.set(key, String(options[key]));
    }
    if(options.ids!==undefined){if(!Array.isArray(options.ids)||!options.ids.length||options.ids.length>500||options.ids.some(id=>!Number.isSafeInteger(id)||id<1))throw failure('INVALID_PAGE');query.set('ids',[...new Set(options.ids)].join(','));}
    const page = await this.request(serverId, `/api/v2/channels/${channelId}/messages?${query}`);
    if (!Array.isArray(page.messages) || page.messages.length > 500) throw failure('INVALID_API_RESPONSE');
    page.messages=await this.decodeMessages(serverId,channelId,page.messages);
    return page;
  }
  async decodeMessages(serverId,channelId,messages){
    if(!Array.isArray(messages)||messages.length>500)throw failure('INVALID_API_RESPONSE');
    const connection = this.connections.get(serverId);
    return Promise.all(messages.map(async message => {
      if (!Number.isSafeInteger(message.id) || message.id <= 0 || message.channelId !== channelId || !hexID(message.authorProfileId, 64) || !hexID(message.requestId, 32)) throw failure('INVALID_API_RESPONSE');
      if((message.locked!==undefined&&typeof message.locked!=='boolean')||(message.systemKind!==undefined&&message.systemKind!==''&&message.systemKind!=='poll-result'))throw failure('INVALID_API_RESPONSE');
      try {
        const clear = await cryptoV2.openContent(connection.secret, serverId, 'chat', channelId, message.requestId, message.authorProfileId, { version: 2, keyId: message.keyId, nonce: message.nonce, ciphertext: message.ciphertext });
        const content = validatedContent(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear)));
        return { ...message, content };
      } catch { return { ...message, unreadable: true, content: { text: '' } }; }
    }));
  }
  async send(serverId, channelId, content, original, clientRequestId) {
    content = validatedContent(content);
    if (!hexID(channelId, 32) || !content || typeof content.text !== 'string' || Buffer.byteLength(content.text) > 4096) throw failure('INVALID_MESSAGE');
    if (!content.text.trim() && !content.image && !content.file && !content.files?.length) throw failure('EMPTY_MESSAGE');
    const connection = this.connections.get(serverId); if (!connection) throw failure('NOT_CONNECTED');
    if((content.files||content.file?.poster)&&!connection.config?.capabilities?.includes('media-gallery-v1'))throw failure('UNSUPPORTED_FEATURE');
    if ((content.image?.size !== undefined || [content.file, ...(content.files ?? [])].some(file => file?.preview || file?.view)) &&
        !connection.config?.capabilities?.includes('media-variants-v1')) throw failure('UNSUPPORTED_FEATURE');
    if(content.checklist&&!connection.config?.capabilities?.includes('checklists-v1'))throw failure('UNSUPPORTED_FEATURE');
    if(content.poll&&(!connection.config?.capabilities?.includes('polls-v1')||original||content.pollResult))throw failure('UNSUPPORTED_FEATURE');
    if(original?.content?.image&&!content.image&&!connection.config?.capabilities?.includes('attachment-removal-v1'))throw failure('UNSUPPORTED_FEATURE');
    if(clientRequestId!==undefined&&!hexID(clientRequestId,32))throw failure('INVALID_MESSAGE');
    const identity = await this.identity(), resourceId = original?.requestId || clientRequestId || requestID(), author = original?.authorProfileId || identity.profileId;
    if (!hexID(resourceId, 32) || !hexID(author, 64) || (original && (!Number.isSafeInteger(original.id) || original.id < 1))) throw failure('INVALID_MESSAGE');
    const clear = new TextEncoder().encode(JSON.stringify(content));
    if (clear.length > 12288) throw failure('MESSAGE_TOO_LARGE');
    const cacheKey=clientRequestId&&[serverId,channelId,clientRequestId].join(':'),signature=hash(clear);
    let cached=cacheKey&&this.pendingMessages.get(cacheKey);
    if(cached&&(cached.signature!==signature||cached.originalId!==original?.id))throw failure('REQUEST_CONFLICT');
    if(!cached){const packet=await cryptoV2.sealContent(connection.secret,serverId,'chat',channelId,resourceId,author,clear);cached={signature,originalId:original?.id,packet};if(cacheKey){this.pendingMessages.set(cacheKey,cached);if(this.pendingMessages.size>100)this.pendingMessages.delete(this.pendingMessages.keys().next().value);}}
    const packet=cached.packet,path=original?`/api/v2/messages/${original.id}`:`/api/v2/channels/${channelId}/messages`;
    if(content.poll&&!cached.poll){
      if(content.poll.id!==resourceId)throw failure('INVALID_POLL');
      const resultID=requestID(),resultPacket=await cryptoV2.sealContent(connection.secret,serverId,'chat',channelId,resultID,author,new TextEncoder().encode(JSON.stringify({...content,pollResult:true})));
      cached.poll={optionCount:content.poll.options.length,duration:content.poll.duration,multiple:content.poll.multiple,anonymous:content.poll.anonymous,intermediate:content.poll.intermediate,result:{requestId:resultID,keyId:resultPacket.keyId,nonce:resultPacket.nonce,ciphertext:resultPacket.ciphertext,attachmentIds:[]}};
    }
    const attachmentIds = [content.image, content.file, ...(content.files ?? [])].filter(Boolean)
      .flatMap(file => mediaAttachmentParts(file).map(part => part.id));
    const result=await this.request(serverId,path,original?'PATCH':'POST',{requestId:original?(clientRequestId||requestID()):resourceId,keyId:packet.keyId,nonce:packet.nonce,ciphertext:packet.ciphertext,attachmentIds:original?[]:attachmentIds,...(cached.poll?{poll:cached.poll}:{}),...(content.checklist?{checklist:{everyone:content.checklist.everyone,items:content.checklist.items.map(item=>item.id)}}:{}),...(original?.content?.image&&!content.image?{removeAttachment:true}:{})});
    if(cacheKey)this.pendingMessages.delete(cacheKey);return result;
  }

  async uploadFile(serverId,channelId,data,mime){
    if(data?.length>2*1024*1024&&!this.connections.get(serverId)?.config?.capabilities?.includes('media-files-v1'))throw failure('UNSUPPORTED_FEATURE');
    if(!hexID(channelId,32)||!['image/gif','video/mp4','video/webm','audio/webm','audio/ogg','application/octet-stream'].includes(mime)||!(data instanceof Uint8Array)||!data.length||data.length>50*1024*1024)throw failure('INVALID_ATTACHMENT');
    const connection=this.connections.get(serverId);if(!connection)throw failure('NOT_CONNECTED');
    const identity=await this.identity(),attachmentId=requestID();
    const packet=await cryptoV2.sealContent(connection.secret,serverId,'attachment',channelId,attachmentId,identity.profileId,data);
    await this.request(serverId,`/api/v2/channels/${channelId}/attachments/${attachmentId}`,'POST',packet);
    return {id:attachmentId,mime};
  }
  async file(serverId,channelId,attachmentId){
    if(!hexID(channelId,32)||!hexID(attachmentId,32))throw failure('INVALID_ATTACHMENT');
    const response=await this.request(serverId,`/api/v2/channels/${channelId}/attachments/${attachmentId}`);
    const connection=this.connections.get(serverId);if(!connection)throw failure('NOT_CONNECTED');
    return cryptoV2.openContent(connection.secret,serverId,'attachment',channelId,attachmentId,response.authorProfileId,response.packet);
  }
  async uploadImage(serverId, channelId, data, mime) {
    if (!hexID(channelId, 32) || !['image/png', 'image/jpeg', 'image/webp'].includes(mime) || !(data instanceof Uint8Array) || !data.length || data.length > 2 * 1024 * 1024) throw failure('INVALID_IMAGE');
    if(inspectImage(data)?.mime!==mime)throw failure('INVALID_IMAGE');
    const connection = this.connections.get(serverId); if (!connection) throw failure('NOT_CONNECTED');
    const identity = await this.identity(), attachmentId = requestID();
    const packet = await cryptoV2.sealContent(connection.secret, serverId, 'attachment', channelId, attachmentId, identity.profileId, data);
    await this.request(serverId, `/api/v2/channels/${channelId}/attachments/${attachmentId}`, 'POST', packet);
    return { id: attachmentId, mime };
  }
  async image(serverId, channelId, attachmentId, mime) {
    if (!hexID(channelId, 32) || !hexID(attachmentId, 32) || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw failure('INVALID_IMAGE');
    const response = await this.request(serverId, `/api/v2/channels/${channelId}/attachments/${attachmentId}`);
    const connection = this.connections.get(serverId);
    const bytes = await cryptoV2.openContent(connection.secret, serverId, 'attachment', channelId, attachmentId, response.authorProfileId, response.packet);
    if (bytes.length > 2 * 1024 * 1024) throw failure('IMAGE_TOO_LARGE');
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  }
  async voice(serverId, channelId) {
    if (!hexID(channelId, 32)) throw failure('INVALID_CHANNEL');
    const result = await this.request(serverId, '/api/v2/voice/join', 'POST', { channelId });
    const connection = this.connections.get(serverId);
    if (result.e2eeRequired !== true || result.channelId !== channelId) throw failure('INVALID_API_RESPONSE');
    result.url = mediaEndpoint(result.url, connection.base, this.allowLoopback).toString();
    result.key = cryptoV2.hex(await cryptoV2.deriveChannelBytes(connection.secret, serverId, 'voice', channelId));
    return result;
  }
  async #requestProtectedVoice(serverId, path, method, input) {
    const connection = this.connections.get(serverId);
    if (!connection) throw failure('NOT_CONNECTED');
    return this.fetchJSON(connection.base, `/api/v3/voice/${path}`, {
      method, body: input === undefined ? undefined : JSON.stringify(input), fingerprint: connection.fingerprint,
      headers: { Authorization: 'Bearer ' + connection.token },
    });
  }
  async protectedVoiceGrant(serverId, channelId) {
    if (!hexID(serverId, 32) || !hexID(channelId, 32)) throw failure('INVALID_CHANNEL');
    const connection = this.connections.get(serverId);
    const result = await this.#requestProtectedVoice(serverId, 'join', 'POST', { channelId });
    if (this.connections.get(serverId) !== connection) throw failure('NOT_CONNECTED');
    return this.#validateProtectedVoiceGrant(result, connection, serverId, channelId);
  }
  #validateProtectedVoiceGrant(result, connection, serverId, channelId) {
    if (result?.e2eeRequired !== true || result.channelId !== channelId ||
        !hexID(result.identity, 32) || result.room !== `ptp-${serverId}-${channelId}` ||
        typeof result.token !== 'string' || !result.token.length || result.token.length > 8192 ||
        !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= 0) {
      throw failure('INVALID_API_RESPONSE');
    }
    const gateway = new URL('/rtc', connection.base);
    gateway.protocol = gateway.protocol === 'https:' ? 'wss:' : 'ws:';
    if (mediaEndpoint(result.url, connection.base, this.allowLoopback).href !== gateway.href) {
      throw failure('PAWTALK_MEDIA_ADDRESS');
    }
    return { ...result, url: gateway.href };
  }
  async protectedVoiceHeartbeat(serverId) {
    const result = await this.#requestProtectedVoice(serverId, 'heartbeat', 'POST', {});
    if (result?.ok !== true) throw failure('INVALID_API_RESPONSE');
  }
  async leaveProtectedVoice(serverId) {
    const result = await this.#requestProtectedVoice(serverId, 'leave', 'POST', {});
    if (result?.ok !== true) throw failure('INVALID_API_RESPONSE');
  }
  async protectedVoiceDestination(serverId) {
    const result = await this.#requestProtectedVoice(serverId, 'move', 'GET');
    if (result?.channelId !== '' && !hexID(result?.channelId, 32)) throw failure('INVALID_API_RESPONSE');
    return result.channelId;
  }
  async moveProtectedVoice(serverId, profileId, sourceChannelId, destinationChannelId) {
    if (!hexID(profileId, 64) || !hexID(sourceChannelId, 32) ||
        (destinationChannelId !== '' && !hexID(destinationChannelId, 32))) throw failure('INVALID_ACTION');
    const result = await this.#requestProtectedVoice(serverId, 'move', 'POST', { profileId, sourceChannelId, destinationChannelId });
    if (result?.pending !== true) throw failure('INVALID_API_RESPONSE');
  }
  async #sendProtectedDeparture(record, intent, trust) {
    const connection = await this.discoverMembership(record.address, record.serverId);
    if (connection.config.apiProtocolVersion !== 3 || connection.config.cutoverDigest !== trust.cutoverDigest ||
        connection.config.anchorDigest !== trust.anchorDigest) throw failure('PROTECTED_CUTOVER_CHANGED');
    const receipt = await this.fetchJSON(connection.base, '/api/v3/member/leave', {
      method: 'POST', fingerprint: connection.fingerprint, body: JSON.stringify(intent),
    });
    if (receipt?.operationId !== intent.operationId) throw failure('INVALID_API_RESPONSE');
    await this.credentials.save(`pawtalk:agreement:v1:${record.serverId}:${intent.deviceId}`, null);
  }
  async #finishPendingDeparture(serverId, requestId, outcome, code, now) {
    const operation = this.registryQueue.catch(() => {}).then(async () => {
      let records = await this.records();
      const current = records.find(value => value.serverId === serverId);
      if (current?.pendingLeave?.requestId !== requestId) return;
      if (outcome === 'done') records = records.filter(value => value !== current);
      else if (outcome === 'blocked') {
        delete current.pendingLeave;
        current.leaveError = code;
      } else current.pendingLeave.nextAttempt = now + 60_000;
      await this.credentials.save('pawtalk:memberships:v2', JSON.stringify(records));
    });
    this.registryQueue = operation.catch(() => {});
    await operation;
  }
  async #leaveProtected(serverId, trust, connection) {
    const runtime = connection ?? await this.openStoredProtectedRuntime(serverId);
    const { device, deviceId } = await this.identity();
    if (runtime.pendingInvite || runtime.deviceId !== deviceId || runtime.cutoverDigest !== trust.cutoverDigest ||
        !hexID(runtime.profileId, 64)) throw failure('INVALID_PROTECTED_SESSION');
    const head = await this.fetchJSON(runtime.base, '/api/v3/member/leave/head', {
      fingerprint: runtime.fingerprint, headers: { Authorization: `Bearer ${runtime.token}` },
    });
    if (!hexID(head?.policyHead, 64)) throw failure('INVALID_API_RESPONSE');
    const operationId = requestID();
    const frame = signatureFrame('pawtalk-protected-member-departure-v1', serverId, trust.cutoverDigest,
      runtime.profileId, deviceId, operationId, head.policyHead);
    const proof = { profileId: runtime.profileId, deviceId, operationId, policyHead: head.policyHead,
      signature: sign(null, frame, device).toString('base64url') };
    const queue = this.registryQueue.catch(() => {}).then(async () => {
      const records = await this.records();
      const record = records.find(value => value.serverId === serverId);
      if (!record) throw failure('NOT_A_MEMBER');
      if (record.pendingLeave) throw failure('LEAVE_PENDING');
      record.pendingLeave = { requestId: operationId, nextAttempt: Date.now() + 60_000, protectedIntent: proof };
      delete record.leaveError;
      await this.credentials.save('pawtalk:memberships:v2', JSON.stringify(records));
      return record;
    });
    this.registryQueue = queue.catch(() => {});
    const record = await queue;
    this.#archiveResume.clear(serverId);
    this.#clearTextStatus(serverId);
    try {
      await this.#sendProtectedDeparture(record, proof, trust);
    } catch (error) {
      if (isConnectionFailure(error)) return;
      await this.#finishPendingDeparture(serverId, operationId, 'blocked', error.code, Date.now());
      throw error;
    }
    await this.#finishPendingDeparture(serverId, operationId, 'done', undefined, Date.now());
  }
  async leave(serverId,{defer=false,protectedConnection}={}) {
    const trust = await this.loadProtectedRuntimeTrust(serverId);
    if (trust) return this.#leaveProtected(serverId, trust, protectedConnection);
    if(!defer&&this.connections.has(serverId)){
      try { await this.request(serverId,'/api/v2/leave','POST',{requestId:requestID()});await this.forget(serverId);return; }
      catch(error){if(['NOT_A_MEMBER','BANNED'].includes(error.code)){await this.forget(serverId);return;}if(!isConnectionFailure(error))throw error;}
    }
    const operation=this.registryQueue.catch(()=>{}).then(async()=>{
      const records=await this.records(),record=records.find(value=>value.serverId===serverId);
      if(!record)throw failure('NOT_A_MEMBER');
      record.pendingLeave||={requestId:requestID(),nextAttempt:0};delete record.leaveError;
      await this.credentials.save('pawtalk:memberships:v2',JSON.stringify(records));
      this.connections.delete(serverId);
    });
    this.registryQueue=operation.catch(()=>{});await operation;
  }
  async pendingDepartures(now=Date.now()) {
    const pending=(await this.records()).filter(record=>record.pendingLeave&&record.pendingLeave.nextAttempt<=now).sort((a,b)=>a.pendingLeave.nextAttempt-b.pendingLeave.nextAttempt).slice(0,2);
    return Promise.all(pending.map(async record=>{
      let outcome='retry', code;
      try{
        // Only authenticate and leave. Do not expose this connection to renderer
        // requests, fetch history, or restore the hidden membership in the rail.
        if (record.pendingLeave.protectedIntent) {
          const trust = await this.loadProtectedRuntimeTrust(record.serverId);
          if (!trust) throw failure('UNTRUSTED_POLICY_ANCHOR');
          await this.#sendProtectedDeparture(record, record.pendingLeave.protectedIntent, trust);
        } else {
          const connection=await this.verified(record.address,record.serverId);
          const session=await this.signed(connection,'/api/v2/session',{});
          await this.fetchJSON(connection.base,'/api/v2/leave',{method:'POST',body:JSON.stringify({requestId:record.pendingLeave.requestId}),fingerprint:connection.fingerprint,headers:{Authorization:'Bearer '+session.sessionToken}});
        }
        outcome='done';
      }catch(error){
        if(!record.pendingLeave.protectedIntent && ['NOT_A_MEMBER','BANNED'].includes(error.code))outcome='done';
        else if(['LAST_ADMIN','PROTECTED_OWNER_LEAVE','PROTECTED_DEPARTURE_CHANGED'].includes(error.code)){outcome='blocked';code=error.code;}
      }
      await this.#finishPendingDeparture(record.serverId, record.pendingLeave.requestId, outcome, code, now);
      return {serverId:record.serverId,outcome,...(code && { code })};
    }));
  }
}
function isConnectionFailure(error){return !error.code||['CONNECTION_FAILED','NOT_CONNECTED','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EHOSTUNREACH','ENETUNREACH','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','ERR_NETWORK_CHANGED','ERR_INTERNET_DISCONNECTED','ERR_CONNECTION_REFUSED','ABORT_ERR'].includes(error.code)||error.name==='AbortError'||error.name==='TimeoutError';}
module.exports = { MembershipClient };
