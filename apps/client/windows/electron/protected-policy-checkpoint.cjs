const { createHash, createPublicKey, verify } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { setImmediate: yieldToEventLoop } = require('node:timers/promises');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { replayPolicyTransition, epochRecipients, epochSigner, voiceRosterSigners, channelPolicyProjectionDigest, channelPolicyProjectionDigests,
  inviteIssuanceSigningKey, canInspectFullPolicy } =
  require('./protected-policy-replay.cjs');
const { channelPolicyRoot, verifyChannelPolicyProof, verifyTextRecipientDisclosure, textRevisionProjectionVersion, hasTextRecipientProjection } =
  require('./protected-channel-policy-commitments.cjs');
const { voiceRosterDigest } = require('./protected-voice-keys.cjs');
const { verifyProtectedRecoveryEnrollment, verifyProtectedRecoveryConfirmation } = require('./protected-runtime-recovery.cjs');
const { verifyProtectedRecoveryDevice } = require('./protected-recovery-device.cjs');
const { verifyProtectedDeviceBinding } = require('./protected-device-binding.cjs');
const { verifyProtectedProfileLinking } = require('./protected-profile-linking.cjs');
const { verifyInviteApplicant, verifyInviteIssuanceTranscript } = require('./protected-invite-transcript.cjs');
const { verifyProtectedChannelSettingsEdit } = require('./protected-channel-settings-edit.cjs');
const { scopedRoleEditAction, scopedRoleEditServerProof, verifyScopedRoleEdit } = require('./protected-scoped-roles.cjs');
const { scopedACLRoleEditAction, scopedACLRoleEditServerProof, verifyProtectedChannelACLRoleEdit, scopedACLPersonalEditAction,
  scopedACLPersonalEditServerProof, verifyProtectedChannelACLPersonalEdit } = require('./protected-channel-acl-edit.cjs');
const { advanceScopeAuthority, scopeAuthorityGenesis, scopeAuthorityCheckpointWithHistory, validateScopeAuthorityCheckpoint } =
  require('./protected-scope-authority.cjs');
const { recoveryIdentityId } = require('./protected-migration-recovery.cjs');

const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const resourceOperations = new Set(['channel.acl.update', 'category.acl.update', 'channel.acl.sync', 'channel.move',
  scopedACLRoleEditAction, scopedACLPersonalEditAction, scopedRoleEditAction,
  'channel.create', 'channel.settings.update', 'channel.settings.scoped', 'channel.copy', 'channel.delete', 'category.create', 'category.settings.update', 'category.delete',
  'category.copy', 'category.order', 'channel.order',
  'voice.mute', 'voice.deafen', 'member.admit', 'member.redeem', 'member.leave', 'member.kick', 'member.ban', 'member.unban',
  'recovery.enroll', 'recovery.confirm', 'recovery.device', 'owner.transfer', 'scope.device', 'device.bind', 'profile.link', 'profile.unlink']);
const memberDepartureActions = new Set(['member.leave', 'member.kick', 'member.ban', 'member.unban']);
const recoveryActions = new Map([
  ['recovery.enroll', { resource: 'Recovery', purpose: 'pawtalk-protected-recovery-enrollment-proof-v1' }],
  ['recovery.confirm', { resource: 'RecoveryConfirmation', purpose: 'pawtalk-protected-recovery-confirmation-proof-v1' }],
  ['recovery.device', { resource: 'RecoveryDevice', purpose: 'pawtalk-protected-recovery-device-proof-v1' }],
]);
const profileLinkingActions = new Map([
  ['profile.link', { resource: 'ProfileLink', purpose: 'pawtalk-protected-profile-link-proof-v1' }],
  ['profile.unlink', { resource: 'ProfileUnlink', purpose: 'pawtalk-protected-profile-unlink-proof-v1' }],
]);
const policyProofLimit = 512 * 1024;
const recoveryConfirmationResourceLimit = 2 * 1024 * 1024;
const operations = new Set(['policy.anchor', 'recipient.enroll', 'recipient.revoke', 'roles.update', 'device.enroll', 'device.revoke',
  ...resourceOperations]);
const isID = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = code => Object.assign(new Error(code), { code });
const checkpointKey = ({ serverId }) => `pawtalk:protected-policy:v1:${serverId}`;
const historyIndexKey = (trust, head) => JSON.stringify([trust.serverId, trust.cutoverDigest, trust.anchorDigest,
  trust.ownerProfileId, trust.ownerDeviceId, head.revision, head.digest, head.resultDigest,
  head.genesisScopeAuthorityDigest, head.scopeAuthority?.digest]);
const historicalIndexLimit = 4096;

function historicalCommitment({ revision, digest, previousDigest, resultDigest, textProjectionRoot, textProjectionVersion }) {
  return { revision, digest, previousDigest, resultDigest, textProjectionRoot, textProjectionVersion };
}

function checkHistoricalPage(page, head) {
  if (!positive(page?.headRevision) || page.headRevision < head.revision ||
      (page.headRevision === head.revision && page.headDigest !== head.digest) ||
      !Array.isArray(page.proofs) || page.proofs.length < 1 || page.proofs.length > 32) {
    throw fail('UNVERIFIED_EPOCH_POLICY');
  }
}

function validateTrust(trust) {
  if (!isID(trust?.serverId, 32) || !isID(trust.anchorDigest, 64) ||
      !isID(trust.ownerProfileId, 64) || !isID(trust.ownerDeviceId, 64)) {
    throw fail('UNTRUSTED_POLICY_ANCHOR');
  }
}

function decode(value, limit) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(limit / 3)) {
    throw fail('INVALID_POLICY_ENCODING');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > limit || bytes.toString('base64') !== value) {
    throw fail('INVALID_POLICY_ENCODING');
  }
  return bytes;
}

function parse(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw fail('INVALID_POLICY_ENCODING');
  }
}

function signingKey(deviceId, rawKey) {
  if (!isID(rawKey, 64)) return undefined;
  const bytes = Buffer.from(rawKey, 'hex');
  if (digest(bytes) !== deviceId) return undefined;
  return createPublicKey({ key: Buffer.concat([spkiPrefix, bytes]), format: 'der', type: 'spki' });
}

function serverProofSigningKey(trust, encoded) {
  if (typeof encoded !== 'string' || encoded.length !== 43) throw fail('UNTRUSTED_POLICY_SIGNER');
  const raw = Buffer.from(encoded, 'base64url');
  const keyId = digest(raw);
  if (raw.length !== 32 || raw.toString('base64url') !== encoded || keyId.slice(0, 32) !== trust.serverId) {
    throw fail('UNTRUSTED_POLICY_SIGNER');
  }
  return signingKey(keyId, raw.toString('hex'));
}

function deviceChangeFields(draft, trust, actor) {
  const change = draft.DeviceChange;
  if (draft.Action !== 'device.enroll' && draft.Action !== 'device.revoke') {
    if (Object.hasOwn(draft, 'DeviceChange')) throw fail('INVALID_POLICY_PROOF');
    return [];
  }
  if (!isID(change?.DeviceID, 64)) throw fail('INVALID_POLICY_PROOF');
  if (draft.Action === 'device.revoke') {
    if (change.PublicKey !== '' || (change.Consent !== null && change.Consent !== '')) throw fail('INVALID_POLICY_PROOF');
    return [change.DeviceID, '', ''];
  }
  const key = signingKey(change.DeviceID, change.PublicKey);
  const consent = decode(change.Consent, 64);
  const frame = signatureFrame('pawtalk-protected-device-consent-v1', trust.serverId, actor.ProfileID, actor.DeviceID,
    draft.OperationID, String(draft.Revision), draft.PreviousDigest, draft.ResultDigest, change.DeviceID, change.PublicKey);
  if (!key || consent.length !== 64 || !verify(null, frame, key, consent)) {
    throw fail('INVALID_DEVICE_CONSENT');
  }
  return [change.DeviceID, change.PublicKey, consent.toString('base64url')];
}

function resourceChangeFields(entry, draft) {
  if (!resourceOperations.has(draft.Action)) {
    if (Object.hasOwn(draft, 'ResourceChange') || Object.hasOwn(entry, 'resourceChange')) throw fail('INVALID_POLICY_PROOF');
    return [];
  }
  const resource = decode(entry.resourceChange, draft.Action === 'recovery.confirm' ? recoveryConfirmationResourceLimit : policyProofLimit);
  if (!draft.ResourceChange || !isDeepStrictEqual(draft.ResourceChange, parse(resource))) throw fail('INVALID_POLICY_PROOF');
  return [digest(resource)];
}

function verifyRecoveryScopeAuthority(trust, actor, draft, resource, prior, previous) {
  if (draft.Action === 'recovery.confirm') return previous?.scopeAuthority;
  const evidence = draft.ResourceChange[resource];
  const link = evidence.ScopeAuthority;
  const current = previous?.scopeAuthority;
  if (actor.ProfileID !== prior.Owner) {
    if (Object.hasOwn(evidence, 'ScopeAuthority')) throw fail('INVALID_SCOPE_AUTHORITY');
    return current;
  }
  if (!Object.hasOwn(evidence, 'ScopeAuthority') && !current) return;
  if ((current?.ownerProfileId ?? trust.ownerProfileId) !== prior.Owner) throw fail('INVALID_SCOPE_AUTHORITY');
  const enrolling = draft.Action === 'recovery.enroll';
  const recoveryKey = enrolling ? evidence.SigningKey : prior.RecoveryIdentities?.[actor.ProfileID]?.SigningKey;
  const deviceKey = enrolling ? prior.PolicyDevices?.[actor.DeviceID]?.PublicKey : evidence.SigningKey;
  if (link?.action !== (enrolling ? 'recovery.authorize' : 'recovery.device') || link.revision !== draft.Revision ||
      link.policyHead !== draft.PreviousDigest || link.operationId !== draft.OperationID ||
      link.recoveryId !== evidence.RecoveryID || link.recoveryKey !== recoveryKey || link.deviceKey !== deviceKey) {
    throw fail('INVALID_SCOPE_AUTHORITY');
  }
  const checkpoint = current ?? scopeAuthorityGenesis(trust, prior.PolicyDevices?.[trust.ownerDeviceId]?.PublicKey);
  return advanceScopeAuthority(trust, checkpoint, link);
}

function verifyOwnershipTransfer(trust, actor, draft, prior, previous) {
  const { ID, OwnershipTransfer: link } = draft.ResourceChange;
  const checkpoint = previous.scopeAuthority ?? scopeAuthorityGenesis(trust, prior.PolicyDevices?.[trust.ownerDeviceId]?.PublicKey);
  if (link?.action !== 'owner.transfer' || ID !== link.targetProfileId || link.revision !== draft.Revision ||
      link.operationId !== draft.OperationID || link.policyHead !== draft.PreviousDigest ||
      (checkpoint.ownerProfileId ?? trust.ownerProfileId) !== prior.Owner ||
      actor.ProfileID !== prior.Owner || actor.DeviceID !== checkpoint.deviceId) throw fail('INVALID_SCOPE_AUTHORITY');
  return advanceScopeAuthority(trust, checkpoint, link);
}

function verifyScopeDeviceHandover(trust, actor, draft, prior, previous) {
  const { ID, ScopeDeviceHandover: claim } = draft.ResourceChange;
  const link = claim?.Link;
  const checkpoint = previous.scopeAuthority ?? scopeAuthorityGenesis(trust, prior.PolicyDevices?.[trust.ownerDeviceId]?.PublicKey);
  if (link?.action !== 'scope.device' || ID !== actor.ProfileID || claim.CutoverDigest !== trust.cutoverDigest ||
      link.revision !== draft.Revision || link.operationId !== draft.OperationID || link.policyHead !== draft.PreviousDigest ||
      (checkpoint.ownerProfileId ?? trust.ownerProfileId) !== prior.Owner ||
      actor.ProfileID !== prior.Owner || actor.DeviceID !== checkpoint.deviceId) throw fail('INVALID_SCOPE_AUTHORITY');
  return advanceScopeAuthority(trust, checkpoint, link);
}

function detachedGenesisFromPage(page) {
  if (!Object.hasOwn(page, 'genesisScopeAuthority')) return;
  const link = page.genesisScopeAuthority;
  if (!link || typeof link !== 'object' || Array.isArray(link)) throw fail('INVALID_SCOPE_AUTHORITY');
  return link;
}

function detachedGenesisAuthority(trust, snapshot, operationId, link) {
  const owner = trust.ownerProfileId;
  const deviceKey = snapshot.PolicyDevices?.[trust.ownerDeviceId]?.PublicKey;
  const recovery = snapshot.RecoveryIdentities?.[owner];
  if (link?.revision !== 1 || link.operationId !== operationId || !recovery ||
      link.recoveryId !== recovery.ID || link.recoveryKey !== recovery.SigningKey ||
      !isID(recovery.AgreementKey, 64) ||
      recoveryIdentityId(trust.serverId, owner, recovery.SigningKey, recovery.AgreementKey) !== recovery.ID ||
      !isDeepStrictEqual(snapshot.KeyRecipients?.[recovery.ID], {
        ProfileID: owner, Kind: 'recovery', PublicKey: recovery.AgreementKey,
      })) throw fail('INVALID_SCOPE_AUTHORITY');
  const scopeAuthority = advanceScopeAuthority(trust, scopeAuthorityGenesis(trust, deviceKey), link);
  return { scopeAuthority, genesisScopeAuthorityDigest: scopeAuthority.digest };
}

function checkDetachedGenesisPage(trust, previous, link) {
  if (!previous?.genesisScopeAuthorityDigest) return;
  if (!link) throw fail('POLICY_ROLLBACK');
  const snapshot = parse(decode(previous.snapshot, 8 * 1024 * 1024));
  const checkpoint = scopeAuthorityGenesis(trust, snapshot.PolicyDevices?.[trust.ownerDeviceId]?.PublicKey);
  if (advanceScopeAuthority(trust, checkpoint, link).digest !== previous.genesisScopeAuthorityDigest) throw fail('POLICY_FORK');
}

async function verifyInviteAdmissionClaim(draft, trust, previous, readIssuance) {
  const automatic = draft.Action === 'member.redeem';
  if (draft.Action !== 'member.admit' && !automatic) return;
  const change = draft.ResourceChange;
  const applicant = verifyInviteApplicant(trust, change?.Admission);
  if (applicant.profileId !== change.ID) throw fail('INVALID_PROTECTED_INVITE_PROOF');
  if (automatic || change.Admission.Issuance !== undefined) {
    await verifyInviteIssuance(change.Admission.Issuance, change.Admission.Claim.inviteId, applicant.tokenHash, trust, previous, readIssuance);
  }
}

async function verifyInviteIssuance(evidence, inviteId, tokenHash, trust, previous, readIssuance) {
  const invalid = () => fail('INVALID_PROTECTED_INVITE_ISSUER');
  const { Issuer, PolicyDigest, PolicyRevision } = evidence ?? {};
  if (!previous || !isID(Issuer?.ProfileID, 64) || !isID(Issuer?.DeviceID, 64) || !isID(PolicyDigest, 64) ||
      !positive(PolicyRevision) || PolicyRevision > previous.revision) throw invalid();
  const basis = previous.revision === PolicyRevision ? previous : await readIssuance?.(PolicyRevision, PolicyDigest);
  if (basis?.revision !== PolicyRevision || basis.digest !== PolicyDigest) throw invalid();
  const snapshot = parse(decode(basis.snapshot, 8 * 1024 * 1024));
  const rawKey = inviteIssuanceSigningKey(snapshot, Issuer);
  verifyInviteIssuanceTranscript(trust, evidence, inviteId, tokenHash, rawKey);
}

function verifyPolicyTextProjection(draft, snapshot, previous) {
  const version = draft.TextProjectionVersion;
  if (version === undefined && draft.TextProjectionRoot === undefined && draft.TextProjectionSeed === undefined &&
      !previous?.textProjectionRoot) return;
  const recipientProjection = hasTextRecipientProjection(version);
  if ((version !== undefined && !recipientProjection) || (previous?.textProjectionVersion &&
      (!recipientProjection || version < previous.textProjectionVersion))) {
    throw fail('INVALID_CHANNEL_POLICY_PROOF');
  }
  if (!isID(draft.TextProjectionRoot, 64) || !isID(draft.TextProjectionSeed, 64) ||
      draft.TextProjectionSeed === previous?.textProjectionSeed ||
      channelPolicyRoot(channelPolicyProjectionDigests(snapshot, recipientProjection ? draft.TextProjectionSeed : undefined, version),
        draft.TextProjectionSeed) !== draft.TextProjectionRoot) {
    throw fail('INVALID_CHANNEL_POLICY_PROOF');
  }
}

function checkTextChannelDisclosure(head, snapshot, channelId, disclosure, context) {
  if (!head.complete || !isID(head.textProjectionRoot, 64) || disclosure?.channelId !== channelId ||
      disclosure.revision !== head.revision || disclosure.policyDigest !== head.resultDigest) {
    throw fail('UNVERIFIED_EPOCH_POLICY');
  }
  if (hasTextRecipientProjection(head.textProjectionVersion)) {
    if (context || disclosure.recipient !== undefined) {
      return verifyTextRecipientDisclosure(head.textProjectionRoot, channelId, disclosure, context, head.textProjectionVersion);
    }
  } else if (disclosure.recipient !== undefined) {
    throw fail('INVALID_CHANNEL_POLICY_PROOF');
  }
  const channelDigest = channelPolicyProjectionDigest(snapshot, channelId, head.textProjectionVersion ? head.textProjectionSeed : undefined,
    head.textProjectionVersion);
  verifyChannelPolicyProof(head.textProjectionRoot, channelId, channelDigest, disclosure.inclusion);
}

function protectedPolicySignatureFrame(serverId, actor, draft, roleUpdate, extra = []) {
  const scoped = draft.TextProjectionRoot !== undefined;
  const domain = hasTextRecipientProjection(draft.TextProjectionVersion) ? `pawtalk-protected-policy-v${draft.TextProjectionVersion}` :
    scoped ? 'pawtalk-protected-policy-v2' : 'pawtalk-protected-policy-v1';
  return signatureFrame(domain,
    serverId, actor.ProfileID, actor.DeviceID, draft.Action, draft.OperationID, String(draft.Revision),
    draft.PreviousDigest, draft.ResultDigest, draft.PublicKey, digest(roleUpdate),
    ...(scoped ? [draft.TextProjectionRoot] : []), ...extra);
}

async function verifiedProof(entry, trust, previous, readIssuance, detachedGenesis) {
  const record = decode(entry?.record, recoveryConfirmationResourceLimit + 2048);
  const roles = decode(entry?.roleUpdate, policyProofLimit);
  const proof = parse(record);
  const actor = proof?.Principal;
  const draft = proof?.Draft;
  if (!isID(actor?.ProfileID, 64) || !isID(actor?.DeviceID, 64) || !operations.has(draft?.Action) ||
      (draft.Action !== 'recovery.confirm' && record.length > policyProofLimit) ||
      !positive(draft.Revision) || !isID(draft.OperationID, 32) || !isID(draft.ResultDigest, 64) ||
      (draft.Action !== 'owner.transfer' && draft.PublicKey !== '' && !isID(draft.PublicKey, 64)) ||
      !Object.hasOwn(draft, 'RoleUpdate') || !isDeepStrictEqual(draft.RoleUpdate, parse(roles))) {
    throw fail('INVALID_POLICY_PROOF');
  }
  const signature = decode(draft.Signature, 64);
  const next = { revision: draft.Revision, digest: digest(signature), previousDigest: draft.PreviousDigest,
    resultDigest: draft.ResultDigest, snapshot: entry.snapshot };
  if (draft.Revision !== (previous?.revision ?? 0) + 1 || draft.PreviousDigest !== (previous?.digest ?? '')) {
    throw fail('POLICY_CHAIN_GAP');
  }
  if (!previous) {
    if (draft.Action !== 'policy.anchor' || next.digest !== trust.anchorDigest ||
        actor.ProfileID !== trust.ownerProfileId || actor.DeviceID !== trust.ownerDeviceId) {
      throw fail('UNTRUSTED_POLICY_ANCHOR');
    }
  } else if (draft.Action === 'policy.anchor') {
    throw fail('INVALID_POLICY_PROOF');
  }
  const snapshot = decode(entry.snapshot, 8 * 1024 * 1024);
  if (digest(snapshot) !== next.resultDigest) throw fail('INVALID_POLICY_SNAPSHOT');
  const applied = parse(snapshot);
  const prior = previous ? parse(decode(previous.snapshot, 8 * 1024 * 1024)) : undefined;
  let frame = protectedPolicySignatureFrame(trust.serverId, actor, draft, roles,
    [...deviceChangeFields(draft, trust, actor), ...resourceChangeFields(entry, draft)]);
  let key;
  const recoveryAction = recoveryActions.get(draft.Action);
  const profileLinking = profileLinkingActions.get(draft.Action);
  if (draft.Action === 'owner.transfer') {
    key = serverProofSigningKey(trust, draft.PublicKey);
    frame = signatureFrame('pawtalk-protected-owner-transfer-proof-v1', digest(frame));
  } else if (draft.Action === 'scope.device') {
    key = serverProofSigningKey(trust, draft.ResourceChange.ScopeDeviceHandover?.ServerKey);
    frame = signatureFrame('pawtalk-protected-scope-device-handover-proof-v1', digest(frame));
  } else if (draft.Action === 'device.bind') {
    key = serverProofSigningKey(trust, draft.ResourceChange.DeviceBinding?.ServerKey);
    frame = signatureFrame('pawtalk-protected-device-bind-proof-v1', digest(frame));
  } else if (draft.Action === 'channel.settings.scoped') {
    key = serverProofSigningKey(trust, draft.ResourceChange.SettingsEdit?.ServerKey);
    frame = signatureFrame('pawtalk-protected-channel-settings-edit-proof-v1', digest(frame));
  } else if (draft.Action === scopedACLRoleEditAction) {
    key = serverProofSigningKey(trust, draft.ResourceChange.ACLRoleEdit?.ServerKey);
    frame = signatureFrame(scopedACLRoleEditServerProof, digest(frame));
  } else if (draft.Action === scopedACLPersonalEditAction) {
    key = serverProofSigningKey(trust, draft.ResourceChange.ACLPersonalEdit?.ServerKey);
    frame = signatureFrame(scopedACLPersonalEditServerProof, digest(frame));
  } else if (draft.Action === scopedRoleEditAction) {
    key = serverProofSigningKey(trust, draft.ResourceChange.RolesEdit?.ServerKey);
    frame = signatureFrame(scopedRoleEditServerProof, digest(frame));
  } else if (profileLinking) {
    key = serverProofSigningKey(trust, draft.ResourceChange[profileLinking.resource]?.ServerKey);
    frame = signatureFrame(profileLinking.purpose, digest(frame));
  } else if (draft.Action === 'member.redeem' || memberDepartureActions.has(draft.Action) || recoveryAction) {
    const invitation = draft.Action === 'member.redeem';
    const change = draft.ResourceChange;
    const encoded = recoveryAction ? change?.[recoveryAction.resource]?.ServerKey :
      invitation ? change?.Admission?.ServerKey : change?.Departure?.ServerKey;
    key = serverProofSigningKey(trust, encoded);
    const purpose = recoveryAction ? recoveryAction.purpose : invitation ? 'pawtalk-protected-invite-enrollment-v1'
      : draft.Action === 'member.leave' ? 'pawtalk-protected-member-departure-proof-v1' : 'pawtalk-protected-member-moderation-proof-v1';
    frame = signatureFrame(purpose, digest(frame));
  } else {
    const signer = (previous ? prior : applied)?.PolicyDevices?.[actor.DeviceID];
    if (!signer || signer.Revoked || signer.ProfileID !== actor.ProfileID) throw fail('UNTRUSTED_POLICY_SIGNER');
    key = signingKey(actor.DeviceID, signer.PublicKey);
  }
  if (!key || signature.length !== 64 || !verify(null, frame, key, signature)) {
    throw fail('INVALID_POLICY_SIGNATURE');
  }
  if (!previous) {
    next.genesisOperationId = draft.OperationID;
    if (detachedGenesis) Object.assign(next, detachedGenesisAuthority(trust, applied, draft.OperationID, detachedGenesis));
  }
  if (previous?.genesisScopeAuthorityDigest) next.genesisScopeAuthorityDigest = previous.genesisScopeAuthorityDigest;
  if (previous?.scopeAuthority) next.scopeAuthority = previous.scopeAuthority;
  if (draft.Action === 'owner.transfer') next.scopeAuthority = verifyOwnershipTransfer(trust, actor, draft, prior, previous);
  if (draft.Action === 'scope.device') next.scopeAuthority = verifyScopeDeviceHandover(trust, actor, draft, prior, previous);
  if (profileLinking) verifyProtectedProfileLinking(trust, actor, draft, prior);
  if (draft.Action === scopedRoleEditAction) verifyScopedRoleEdit(trust, actor, draft, previous,
    Object.hasOwn(prior?.PolicyDevices ?? {}, actor.DeviceID) && prior.PolicyDevices[actor.DeviceID]);
  if (draft.Action === 'channel.settings.scoped') {
    const device = Object.hasOwn(prior?.PolicyDevices ?? {}, actor.DeviceID) && prior.PolicyDevices[actor.DeviceID];
    const channelId = draft.ResourceChange.ID;
    const channel = Object.hasOwn(prior?.Channels ?? {}, channelId) && prior.Channels[channelId];
    if (!device || device.Revoked || device.ProfileID !== actor.ProfileID) throw fail('UNTRUSTED_POLICY_SIGNER');
    verifyProtectedChannelSettingsEdit(trust, actor, draft, previous, channel, device.PublicKey);
  }
  if (draft.Action === scopedACLRoleEditAction) {
    const device = Object.hasOwn(prior?.PolicyDevices ?? {}, actor.DeviceID) && prior.PolicyDevices[actor.DeviceID];
    if (!device || device.Revoked || device.ProfileID !== actor.ProfileID) throw fail('UNTRUSTED_POLICY_SIGNER');
    verifyProtectedChannelACLRoleEdit(trust, actor, draft, previous, prior, device.PublicKey);
  }
  if (draft.Action === scopedACLPersonalEditAction) {
    const device = Object.hasOwn(prior?.PolicyDevices ?? {}, actor.DeviceID) && prior.PolicyDevices[actor.DeviceID];
    if (!device || device.Revoked || device.ProfileID !== actor.ProfileID) throw fail('UNTRUSTED_POLICY_SIGNER');
    verifyProtectedChannelACLPersonalEdit(trust, actor, draft, previous, prior, device.PublicKey);
  }
  if (draft.Action === 'device.bind') {
    const approver = Object.hasOwn(prior?.PolicyDevices ?? {}, actor.DeviceID) && prior.PolicyDevices[actor.DeviceID];
    if (!approver || approver.Revoked || approver.ProfileID !== actor.ProfileID) throw fail('UNTRUSTED_POLICY_SIGNER');
    verifyProtectedDeviceBinding(trust, actor, draft, approver.PublicKey);
  }
  if (recoveryAction) {
    const device = Object.hasOwn(prior?.PolicyDevices ?? {}, actor.DeviceID) && prior.PolicyDevices[actor.DeviceID];
    const recovery = Object.hasOwn(prior?.RecoveryIdentities ?? {}, actor.ProfileID) && prior.RecoveryIdentities[actor.ProfileID];
    if (draft.Action === 'recovery.device') verifyProtectedRecoveryDevice(trust, actor, draft, recovery);
    else {
      if (!device || device.Revoked || device.ProfileID !== actor.ProfileID) throw fail('UNTRUSTED_POLICY_SIGNER');
      if (draft.Action === 'recovery.enroll') verifyProtectedRecoveryEnrollment(trust, actor, draft, device.PublicKey);
      else verifyProtectedRecoveryConfirmation(trust, actor, draft, device.PublicKey, recovery);
    }
    const authority = verifyRecoveryScopeAuthority(trust, actor, draft, recoveryAction.resource, prior, previous);
    if (authority) next.scopeAuthority = authority;
  }
  if (memberDepartureActions.has(draft.Action)) {
    const departure = draft.ResourceChange.Departure;
    const device = Object.hasOwn(prior?.PolicyDevices ?? {}, actor.DeviceID) && prior.PolicyDevices[actor.DeviceID];
    if (!device || device.Revoked || device.ProfileID !== actor.ProfileID || departure.CutoverDigest !== trust.cutoverDigest ||
        typeof departure.DeviceSignature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(departure.DeviceSignature)) {
      throw fail('INVALID_PROTECTED_DEPARTURE_PROOF');
    }
    const context = [trust.serverId, departure.CutoverDigest, actor.ProfileID, actor.DeviceID, draft.OperationID, draft.PreviousDigest];
    const intent = draft.Action === 'member.leave' ? signatureFrame('pawtalk-protected-member-departure-v1', ...context)
      : signatureFrame('pawtalk-protected-member-moderation-v1', ...context, draft.Action, draft.ResourceChange.ID,
        departure.Reason ?? '', String(departure.ExpiresAt ?? 0));
    const consent = Buffer.from(departure.DeviceSignature, 'base64url');
    if (consent.toString('base64url') !== departure.DeviceSignature ||
        !verify(null, intent, signingKey(actor.DeviceID, device.PublicKey), consent)) throw fail('INVALID_PROTECTED_DEPARTURE_PROOF');
  }
  await verifyInviteAdmissionClaim(draft, trust, previous, readIssuance);
  next.admissionFloor = replayPolicyTransition(prior, applied, actor, draft, trust.ownerProfileId, previous?.admissionFloor);
  verifyPolicyTextProjection(draft, applied, previous);
  if (draft.TextProjectionRoot !== undefined) {
    next.textProjectionRoot = draft.TextProjectionRoot;
    next.textProjectionSeed = draft.TextProjectionSeed;
    next.textProjectionVersion = draft.TextProjectionVersion;
  }
  return next;
}

function validateRuntimePolicyPreview(preview, intent, actor, previous) {
  const draft = preview?.draft;
  const invalid = () => fail('INVALID_POLICY_PREVIEW');
  const revokesDevice = draft?.Action === 'device.revoke';
  if (!draft || !intent || !previous || !isID(actor?.ProfileID, 64) || !isID(actor?.DeviceID, 64) ||
      draft?.Action !== intent?.Action || ['member.redeem', 'owner.transfer', 'scope.device', 'device.bind', 'channel.settings.scoped', scopedRoleEditAction,
        scopedACLRoleEditAction, scopedACLPersonalEditAction].includes(draft.Action) ||
      recoveryActions.has(draft.Action) || profileLinkingActions.has(draft.Action) ||
      memberDepartureActions.has(draft.Action) ||
      (!revokesDevice && draft.Action !== 'roles.update' && !resourceOperations.has(draft.Action)) ||
      !isID(draft.OperationID, 32) || draft.OperationID !== intent.OperationID || draft.Revision !== previous.revision + 1 ||
      draft.PreviousDigest !== previous.digest || !isID(draft.ResultDigest, 64) || draft.PublicKey !== '' ||
      draft.Signature !== null ||
      (revokesDevice ? draft.DeviceChange?.DeviceID !== intent.DeviceChange?.DeviceID ||
        draft.DeviceChange?.DeviceID === actor.DeviceID : draft.DeviceChange !== undefined) ||
      !isDeepStrictEqual(draft.RoleUpdate, intent.RoleUpdate ?? null) || !isDeepStrictEqual(draft.ResourceChange, intent.ResourceChange)) {
    throw invalid();
  }
  const roleUpdate = decode(preview.roleUpdate, 512 * 1024);
  if (!isDeepStrictEqual(parse(roleUpdate), draft.RoleUpdate)) throw invalid();
  const resource = resourceChangeFields(preview, draft);
  return { draft, roleUpdate, resource };
}

function validateScopedChannelOrderPreview(preview, intent, actor, attestation) {
  const { draft } = validateRuntimePolicyPreview(preview, intent, actor, attestation);
  if (draft.Action !== 'channel.order' || !isID(preview.channelOrderBasis, 64) || preview.snapshot !== undefined || draft.TextProjectionRoot !== undefined ||
      draft.TextProjectionSeed !== undefined || draft.TextProjectionVersion !== undefined ||
      (intent.ResourceChange?.MixedOrder === true ? preview.channelOrderBasisVersion !== 3 :
        preview.channelOrderBasisVersion !== undefined && preview.channelOrderBasisVersion !== 2)) throw fail('INVALID_POLICY_PREVIEW');
}

async function runtimePolicyPreviewFrame(preview, intent, trust, actor, previous, readIssuance) {
  const invalid = () => fail('INVALID_POLICY_PREVIEW');
  if (!previous?.complete) throw invalid();
  const { draft, roleUpdate, resource } = validateRuntimePolicyPreview(preview, intent, actor, previous);
  const prior = parse(decode(previous.snapshot, 8 * 1024 * 1024));
  const fullPolicy = canInspectFullPolicy(prior, actor.ProfileID, actor.DeviceID);
  await verifyInviteAdmissionClaim(draft, trust, previous, readIssuance);
  if (preview.snapshot !== undefined) {
    const result = decode(preview.snapshot, 8 * 1024 * 1024);
    if (!fullPolicy || digest(result) !== draft.ResultDigest) throw invalid();
    const after = parse(result);
    replayPolicyTransition(prior, after, actor, draft, prior.Owner, previous.admissionFloor);
    verifyPolicyTextProjection(draft, after, previous);
  } else if (fullPolicy || draft.TextProjectionRoot !== undefined) {
    throw invalid();
  }
  return protectedPolicySignatureFrame(trust.serverId, actor, draft, roleUpdate,
    [...deviceChangeFields(draft, trust, actor), ...resource]);
}

function attestationView(basis) {
  if (!hasTextRecipientProjection(basis.textProjectionVersion)) throw fail('POLICY_ATTESTATION_UNAVAILABLE');
  return { revision: basis.revision, digest: basis.digest, previous: basis.previousDigest, policyDigest: basis.resultDigest,
    root: basis.textProjectionRoot,
    ...(basis.textProjectionVersion >= textRevisionProjectionVersion && { projectionVersion: basis.textProjectionVersion }) };
}

// A pinned owner anchor authenticates the initial device directory.
// Each following proof is checked against the previously applied policy.
class ProtectedPolicyCheckpoint {
  constructor(credentials, diagnostics) {
    this.credentials = credentials;
    this.diagnostics = diagnostics;
    this.pending = new Map();
    this.history = new Map();
    this.historyIndexes = new Map();
    this.historyReplays = new Map();
  }

  async accept(page, trust, fetchPage) {
    validateTrust(trust);
    const id = trust.serverId;
    // Serialize verification and credential writes for each server.
    const running = (this.pending.get(id) ?? Promise.resolve()).catch(() => {})
      .then(() => this.acceptPage(page, trust, fetchPage));
    this.pending.set(id, running);
    return running.finally(() => {
      if (this.pending.get(id) === running) this.pending.delete(id);
    });
  }

  async load(trust) {
    const raw = await this.credentials.load(checkpointKey(trust), { required: true });
    if (raw === null || raw === undefined) return undefined;
    const saved = parse(Buffer.from(raw, 'utf8'));
    if (saved?.anchorDigest !== trust.anchorDigest ||
        saved.ownerProfileId !== trust.ownerProfileId || saved.ownerDeviceId !== trust.ownerDeviceId || !positive(saved.revision) ||
        !isID(saved.digest, 64) || !isID(saved.resultDigest, 64) ||
        digest(decode(saved.snapshot, 8 * 1024 * 1024)) !== saved.resultDigest) {
      throw fail('INVALID_LOCAL_POLICY_CHECKPOINT');
    }
    if (saved.admissionFloor !== undefined && (saved.admissionFloor === null || typeof saved.admissionFloor !== 'object' ||
        Array.isArray(saved.admissionFloor) || !Object.values(saved.admissionFloor).every(positive))) {
      throw fail('INVALID_LOCAL_POLICY_CHECKPOINT');
    }
    if (saved.scopeAuthority !== undefined) {
      try {
        validateScopeAuthorityCheckpoint(trust, saved.scopeAuthority);
        saved.scopeAuthority = scopeAuthorityCheckpointWithHistory(trust, saved.scopeAuthority);
        const applied = parse(decode(saved.snapshot, 8 * 1024 * 1024));
        if (saved.scopeAuthority.sequence < 1 || saved.scopeAuthority.revision > saved.revision ||
            saved.scopeAuthority.ownerProfileId !== applied.Owner) {
          throw fail('INVALID_SCOPE_AUTHORITY');
        }
      } catch { throw fail('INVALID_LOCAL_POLICY_CHECKPOINT'); }
    }
    if ((saved.genesisOperationId !== undefined && (saved.revision !== 1 || !isID(saved.genesisOperationId, 32))) ||
        (saved.genesisScopeAuthorityDigest !== undefined &&
          (!saved.scopeAuthority || !isID(saved.genesisScopeAuthorityDigest, 64) ||
            (saved.scopeAuthority.sequence === 1 && saved.scopeAuthority.digest !== saved.genesisScopeAuthorityDigest)))) {
      throw fail('INVALID_LOCAL_POLICY_CHECKPOINT');
    }
    return saved;
  }

  async acceptPage(page, trust, fetchPage) {
    const saved = await this.load(trust);
    if (!positive(page?.headRevision) || !isID(page.headDigest, 64) ||
        !Array.isArray(page.proofs) || page.proofs.length > 32) {
      throw fail('INVALID_POLICY_PAGE');
    }
    if (saved && page.headRevision < saved.revision) throw fail('POLICY_ROLLBACK');
    if (saved && page.headRevision === saved.revision && page.headDigest !== saved.digest) throw fail('POLICY_FORK');
    const detached = detachedGenesisFromPage(page);
    let candidate = saved;
    if (saved && detached && !saved.genesisScopeAuthorityDigest) {
      if (saved.scopeAuthority) throw fail('POLICY_FORK');
      if (saved.revision === 1 && saved.genesisOperationId) {
        const snapshot = parse(decode(saved.snapshot, 8 * 1024 * 1024));
        candidate = { ...saved, ...detachedGenesisAuthority(trust, snapshot, saved.genesisOperationId, detached) };
      } else {
        const bases = await this.verifyHistoricalBases(trust, saved, [saved.revision], fetchPage, true);
        candidate = bases.get(saved.revision);
      }
    }
    checkDetachedGenesisPage(trust, candidate, detached);
    const verified = new Map();
    if (candidate) verified.set(candidate.revision, candidate);
    const readIssuance = async (revision, issuanceDigest) => {
      const basis = verified.get(revision);
      if (basis) return basis;
      if (!saved || revision >= saved.revision || typeof fetchPage !== 'function') throw fail('UNVERIFIED_INVITE_HISTORY');
      const historical = await this.inviteIssuanceBasis(trust, saved, revision, issuanceDigest, fetchPage);
      verified.set(revision, historical);
      return historical;
    };
    for (const proof of page.proofs) {
      candidate = await verifiedProof(proof, trust, candidate, readIssuance, detached);
      verified.set(candidate.revision, candidate);
    }
    if (!candidate || candidate.revision > page.headRevision ||
        (candidate.revision < page.headRevision && page.proofs.length === 0)) {
      throw fail('POLICY_CHAIN_GAP');
    }
    const complete = candidate.revision === page.headRevision;
    if (complete) {
      if (candidate.digest !== page.headDigest) throw fail('POLICY_FORK');
      if (page.snapshot !== undefined && digest(decode(page.snapshot, 8 * 1024 * 1024)) !== candidate.resultDigest) {
        throw fail('INVALID_POLICY_SNAPSHOT');
      }
    } else if (page.snapshot !== undefined) {
      throw fail('INVALID_POLICY_PAGE');
    }
    if (candidate !== saved || saved?.complete !== complete) {
      await this.credentials.save(checkpointKey(trust), JSON.stringify({ ...candidate, anchorDigest: trust.anchorDigest,
        ownerProfileId: trust.ownerProfileId, ownerDeviceId: trust.ownerDeviceId, complete }));
      const inherited = saved && this.historyIndexes.get(historyIndexKey(trust, saved));
      // A verified extension inherits the commitments of the previous pinned head.
      this.#rememberHistoryIndex(trust, candidate, new Map([...(inherited ?? []),
        ...[...verified].map(([revision, basis]) => [revision, historicalCommitment(basis)])]));
    }
    return { revision: candidate.revision, digest: candidate.digest, complete };
  }

  async policyBasis(record, trust, fetchPage, requireCurrent) {
    const basis = await this.#policyBasisCheckpoint(record, trust, fetchPage, requireCurrent);
    return parse(decode(basis.snapshot, 8 * 1024 * 1024));
  }

  async attestationClaims(trust, revision, fetchPage) {
    const [claims] = await this.attestationClaimsForRevisions(trust, [revision], fetchPage);
    return claims;
  }

  async attestationClaimsForRevisions(trust, revisions, fetchPage) {
    validateTrust(trust);
    await this.pending.get(trust.serverId);
    const head = await this.load(trust);
    if (!head?.complete || revisions.some(revision => !positive(revision) || revision > head.revision)) throw fail('UNVERIFIED_EPOCH_POLICY');
    const historical = revisions.filter(revision => revision !== head.revision || head.previousDigest === undefined);
    const indexed = this.historyIndexes.get(historyIndexKey(trust, head));
    const bases = historical.every(revision => indexed?.has(revision)) ? indexed :
      await this.verifyHistoricalBases(trust, head, historical, fetchPage);
    return revisions.map(revision => attestationView(bases?.get(revision) ?? head));
  }

  async #policyBasisCheckpoint(record, trust, fetchPage, requireCurrent) {
    validateTrust(trust);
    await this.pending.get(trust.serverId);
    const head = await this.load(trust);
    const revision = record?.Revision;
    if (!head || !positive(revision) || !isID(record.PolicyDigest, 64) || revision > head.revision ||
        (requireCurrent && (!head.complete || revision !== head.revision))) {
      throw fail('UNVERIFIED_EPOCH_POLICY');
    }
    const basis = revision < head.revision ? await this.#historicalBasis(trust, head, revision, fetchPage) : head;
    if (record.PolicyDigest !== basis.resultDigest) throw fail('UNVERIFIED_EPOCH_POLICY');
    return basis;
  }

  async verifyLiveAdmission(delivery, context, profileId, trust, fetchPage) {
    const record = delivery.Epoch.Record;
    const basis = await this.#policyBasisCheckpoint(record, trust, fetchPage, false);
    const proof = delivery.admissionPolicy;
    let previous;
    if (hasTextRecipientProjection(basis.textProjectionVersion)) {
      const sameRevision = delivery.textPolicy?.revision === record.Revision;
      if (sameRevision && proof !== undefined) throw fail('INVALID_CHANNEL_POLICY_PROOF');
      const disclosure = sameRevision ? delivery.textPolicy : proof;
      if (disclosure?.channelId !== context.channelId || disclosure.revision !== basis.revision ||
          disclosure.policyDigest !== basis.resultDigest) throw fail('INVALID_CHANNEL_POLICY_PROOF');
      const entry = verifyTextRecipientDisclosure(basis.textProjectionRoot, context.channelId, disclosure, context, basis.textProjectionVersion);
      if (entry.profileId !== profileId) throw fail('UNVERIFIED_EPOCH_RECIPIENT');
      previous = entry.firstPosition;
    } else {
      if (proof !== undefined) throw fail('INVALID_CHANNEL_POLICY_PROOF');
      const snapshot = parse(decode(basis.snapshot, 8 * 1024 * 1024));
      previous = snapshot.Admissions?.[context.channelId]?.[profileId]?.FirstPosition;
    }
    const current = await this.authorizeRecipient(context, trust, delivery.textPolicy, true);
    const first = current.Admissions?.[context.channelId]?.[profileId]?.FirstPosition;
    if (!Number.isSafeInteger(first) || first < 1 || previous !== first) throw fail('UNVERIFIED_EPOCH_RECIPIENT');
    return first;
  }
  async anchorSigningKey(trust, fetchPage) {
    validateTrust(trust);
    await this.pending.get(trust.serverId);
    const head = await this.load(trust);
    if (!head?.complete) throw fail('UNVERIFIED_EPOCH_POLICY');
    let anchor = head;
    if (head.revision !== 1) {
      const page = await fetchPage(0);
      if (!Array.isArray(page?.proofs) || !page.proofs.length) throw fail('UNTRUSTED_POLICY_ANCHOR');
      anchor = await verifiedProof(page.proofs[0], trust, undefined, undefined, detachedGenesisFromPage(page));
      if (head.genesisScopeAuthorityDigest !== undefined && anchor.genesisScopeAuthorityDigest !== head.genesisScopeAuthorityDigest) {
        throw fail('POLICY_FORK');
      }
    }
    if (anchor.digest !== trust.anchorDigest) throw fail('UNTRUSTED_POLICY_ANCHOR');
    const snapshot = parse(decode(anchor.snapshot, 8 * 1024 * 1024));
    const signer = snapshot.PolicyDevices?.[trust.ownerDeviceId];
    if (!signingKey(trust.ownerDeviceId, signer?.PublicKey) || signer.ProfileID !== trust.ownerProfileId || signer.Revoked) {
      throw fail('UNTRUSTED_POLICY_ANCHOR');
    }
    return signer.PublicKey;
  }

  #rememberHistoryIndex(trust, head, commitments) {
    while (commitments.size > historicalIndexLimit) commitments.delete(commitments.keys().next().value);
    const key = historyIndexKey(trust, head);
    this.historyIndexes.delete(key);
    this.historyIndexes.set(key, commitments);
    if (this.historyIndexes.size > 4) this.historyIndexes.delete(this.historyIndexes.keys().next().value);
  }

  async verifyHistory(trust, head, revision, fetchPage) {
    return (await this.verifyHistoricalBases(trust, head, [revision], fetchPage)).get(revision);
  }

  #historicalBasis(trust, head, revision, fetchPage) {
    const headKey = historyIndexKey(trust, head);
    const key = `${headKey}:${revision}`;
    const cached = this.history.get(key);
    if (cached) return cached;
    const verified = this.#readHistoricalBasis(trust, head, headKey, revision, fetchPage);
    this.history.set(key, verified);
    if (this.history.size > 4) this.history.delete(this.history.keys().next().value);
    verified.catch(() => {
      if (this.history.get(key) === verified) this.history.delete(key);
    });
    return verified;
  }

  async #readHistoricalBasis(trust, head, key, revision, fetchPage) {
    if (typeof fetchPage !== 'function') throw fail('UNVERIFIED_EPOCH_POLICY');
    let commitment = this.historyIndexes.get(key)?.get(revision);
    if (!commitment && this.historyReplays.has(key)) {
      const bases = await this.historyReplays.get(key);
      if (bases.has(revision)) return bases.get(revision);
      commitment = this.historyIndexes.get(key)?.get(revision);
    }
    if (commitment) {
      const page = await fetchPage(revision - 1);
      checkHistoricalPage(page, head);
      const snapshot = page.proofs[0]?.snapshot;
      // Use only the snapshot bytes. The policy metadata came from the pinned chain.
      if (digest(decode(snapshot, 8 * 1024 * 1024)) !== commitment.resultDigest) throw fail('INVALID_POLICY_SNAPSHOT');
      return { ...commitment, snapshot };
    }
    const replay = this.verifyHistoricalBases(trust, head, [revision], fetchPage);
    this.historyReplays.set(key, replay);
    try { return (await replay).get(revision); }
    finally { if (this.historyReplays.get(key) === replay) this.historyReplays.delete(key); }
  }

  async inviteIssuanceBasis(trust, head, revision, issuanceDigest, fetchPage) {
    if (!head || !positive(revision) || revision >= head.revision || !isID(issuanceDigest, 64)) throw fail('UNVERIFIED_INVITE_HISTORY');
    const basis = await this.#historicalBasis(trust, head, revision, fetchPage);
    if (basis?.digest !== issuanceDigest) throw fail('INVALID_PROTECTED_INVITE_ISSUER');
    return basis;
  }

  async verifyHistoricalBases(trust, head, revisions, fetchPage, adoptDetachedGenesis = false) {
    const replay = () => this.#replayHistoricalBases(trust, head, revisions, fetchPage, adoptDetachedGenesis);
    return this.diagnostics ? this.diagnostics.stage('history.policy.replay', replay) : replay();
  }

  async #replayHistoricalBases(trust, head, revisions, fetchPage, adoptDetachedGenesis) {
    if (typeof fetchPage !== 'function') throw fail('UNVERIFIED_EPOCH_POLICY');
    const requested = new Set(revisions);
    const bases = new Map();
    const commitments = new Map();
    const readIssuance = async (revision, expectedDigest) => {
      const commitment = commitments.get(revision);
      if (commitment?.digest !== expectedDigest) throw fail('INVALID_PROTECTED_INVITE_ISSUER');
      const known = bases.get(revision);
      if (known) return known;
      // Only historical snapshot bytes are needed here. Bind them to the
      // already verified result digest instead of trusting a second proof page.
      const historical = await fetchPage(revision - 1);
      const snapshot = historical?.proofs?.[0]?.snapshot;
      if (digest(decode(snapshot, 8 * 1024 * 1024)) !== commitment.resultDigest) throw fail('INVALID_POLICY_SNAPSHOT');
      return { revision, digest: commitment.digest, snapshot };
    };
    let candidate;
    while ((candidate?.revision ?? 0) < head.revision) {
      const page = await fetchPage(candidate?.revision ?? 0);
      checkHistoricalPage(page, head);
      const detached = detachedGenesisFromPage(page);
      if (candidate && detached && !candidate.genesisScopeAuthorityDigest) throw fail('POLICY_FORK');
      checkDetachedGenesisPage(trust, candidate, detached);
      for (const entry of page.proofs) {
        candidate = await verifiedProof(entry, trust, candidate, readIssuance, detached);
        commitments.set(candidate.revision, historicalCommitment(candidate));
        if (requested.has(candidate.revision)) bases.set(candidate.revision, candidate);
        if (candidate.revision === head.revision) break;
        if (candidate.revision % 4 === 0) await yieldToEventLoop();
      }
    }
    if (candidate.digest !== head.digest || candidate.resultDigest !== head.resultDigest || bases.size !== requested.size) {
      throw fail('UNVERIFIED_EPOCH_POLICY');
    }
    if (adoptDetachedGenesis ? !candidate.genesisScopeAuthorityDigest :
      candidate.genesisScopeAuthorityDigest !== head.genesisScopeAuthorityDigest ||
      !isDeepStrictEqual(candidate.scopeAuthority, head.scopeAuthority)) throw fail('POLICY_FORK');
    this.#rememberHistoryIndex(trust, candidate, commitments);
    return bases;
  }

  async authorizeRotation(task, trust, profileId, deviceId) {
    const snapshot = await this.policyBasis(task, trust, undefined, true);
    const recipients = epochRecipients(snapshot, task.ChannelID, task.Purpose);
    if (!epochSigner(snapshot, recipients, profileId, deviceId) || !isDeepStrictEqual(task.Recipients, recipients)) {
      throw fail('UNVERIFIED_EPOCH_RECIPIENTS');
    }
  }

  async authorizeRecipient(context, trust, textDisclosure, requireDisclosure = false) {
    validateTrust(trust);
    await this.pending.get(trust.serverId);
    const head = await this.load(trust);
    if (!head?.complete || context.serverId !== trust.serverId) throw fail('UNVERIFIED_EPOCH_POLICY');
    const snapshot = parse(decode(head.snapshot, 8 * 1024 * 1024));
    if (textDisclosure !== undefined || requireDisclosure && head.textProjectionRoot) {
      checkTextChannelDisclosure(head, snapshot, context.channelId, textDisclosure, context);
    }
    const recipient = epochRecipients(snapshot, context.channelId, context.purpose)[context.recipientId];
    if (!recipient || recipient.PublicKey !== context.recipientKey ||
        !epochSigner(snapshot, { [context.recipientId]: recipient }, recipient.ProfileID, context.recipientId)) {
      throw fail('UNVERIFIED_EPOCH_RECIPIENT');
    }
    return snapshot;
  }

  async verifyTextChannelDisclosure(channelId, disclosure, trust) {
    validateTrust(trust);
    await this.pending.get(trust.serverId);
    const head = await this.load(trust);
    if (!head) throw fail('UNVERIFIED_EPOCH_POLICY');
    const snapshot = parse(decode(head.snapshot, 8 * 1024 * 1024));
    return checkTextChannelDisclosure(head, snapshot, channelId, disclosure);
  }

  async authorizeEpoch(epoch, trust, fetchPage, context) {
    const snapshot = await this.policyBasis(epoch?.Record, trust, fetchPage, false);
    const recipients = epochRecipients(snapshot, epoch.Record.ChannelID, epoch.Record.Purpose);
    const signer = epochSigner(snapshot, recipients, epoch.Principal?.ProfileID, epoch.Principal?.DeviceID);
    if (!signer) throw fail('UNTRUSTED_EPOCH_SIGNER');
    if (context && (context.serverId !== trust.serverId || recipients[context.recipientId]?.PublicKey !== context.recipientKey)) {
      throw fail('UNVERIFIED_EPOCH_RECIPIENT');
    }
    return signer;
  }

  async authorizeVoiceRoster(basis, trust, binding, roster) {
    if (basis.serverId !== trust.serverId || !isID(binding, 64) || basis.binding !== binding ||
        voiceRosterDigest(roster) !== basis.rosterDigest) throw fail('UNVERIFIED_VOICE_ROSTER');
    const snapshot = await this.policyBasis({ Revision: basis.revision, PolicyDigest: basis.policyDigest }, trust, undefined, true);
    return voiceRosterSigners(snapshot, basis.channelId, roster, Date.now());
  }
}

module.exports = { ProtectedPolicyCheckpoint, runtimePolicyPreviewFrame, verifyPolicyTextProjection, protectedPolicySignatureFrame,
  validateScopedChannelOrderPreview };
