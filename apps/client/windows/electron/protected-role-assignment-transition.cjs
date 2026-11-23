const { createHash, createPublicKey, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { verifyScopedRoleEdit, scopedRoleEditAction } = require('./protected-scoped-roles.cjs');
const { verifyAttestedProfileRoleAuthority, verifyProfileSigningKey } = require('./protected-policy-profile-ranks.cjs');
const { verifyScopedRoleDefinitions } = require('./protected-role-catalogue.cjs');
const { verifyScopedRoleRoster } = require('./protected-role-roster.cjs');
const { verifyScopedChannelKeyAccess } = require('./protected-role-channel-rules.cjs');
const { verifyAttestedTextAdmission } = require('./protected-policy-attestation.cjs');
const { profileRoleAuthorityProjectionVersion, verifyRotationProfileRemoval, verifyRotationProfiles, verifyTextRecipientDisclosure } =
  require('./protected-channel-policy-commitments.cjs');

const invalid = () => Object.assign(new Error('INVALID_ROLE_ASSIGNMENT_TRANSITION'), { code: 'INVALID_ROLE_ASSIGNMENT_TRANSITION' });
const administrator = 'server.administrator';
const serverKeyPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);

function verifyScopedRoleAssignment(trust, attestation, record, evidence, channelId, kind) {
  // Verify one target's contribution to the channel recipient sets. An epoch
  // verifier must also reconcile every other profile with the prior set.
  const { Principal: actor, Draft: draft } = record ?? {};
  const change = draft?.ResourceChange?.RolesEdit?.Change;
  if (draft?.Action !== scopedRoleEditAction || !attestation || !actor || !change || change.definitions !== undefined || change.order !== undefined ||
      change.delete?.length || draft.PreviousDigest !== attestation.digest || draft.Revision !== attestation.revision + 1 ||
      actor.ProfileID === change.targetProfileId || draft.RoleUpdate !== null || draft.PublicKey !== '') throw invalid();
  if (change.rosterChannelId !== undefined) throw invalid();
  const profile = (id, witness) => verifyAttestedProfileRoleAuthority(attestation,
    { ...evidence.auxiliary, profile: witness.proof }, id, witness.opening, witness.unopened);
  const authority = profile(actor.ProfileID, evidence.actor);
  const previous = profile(change.targetProfileId, evidence.target);
  if (!Array.isArray(authority.grants) || !Array.isArray(authority.roles) ||
      !Array.isArray(previous.roles) || !Array.isArray(previous.grants) ||
      authority.rank <= previous.rank || (!authority.bypassesACL && !authority.grants.includes('role.assign'))) throw invalid();
  if (change.rosterCommitment !== undefined) {
    verifyScopedRoleRoster(evidence.auxiliary.rosters, change.rosterCommitment, actor.ProfileID, change.targetProfileId, evidence.roster);
  } else if (evidence.roster !== undefined || (!authority.bypassesACL && !authority.grants.includes('member.list'))) {
    throw invalid();
  }
  const actorKey = verifyProfileSigningKey(authority.keyRoot, actor.DeviceID, evidence.actorKey);
  verifyScopedRoleEdit(trust, actor, draft, attestation, { ProfileID: actor.ProfileID, PublicKey: actorKey }, true);

  const add = change.add ?? [], remove = change.remove ?? [];
  const changed = [...add, ...remove];
  if (!changed.length || new Set(changed).size !== changed.length || changed.includes('@everyone') ||
      add.some(id => previous.roles.includes(id)) || remove.some(id => !previous.roles.includes(id))) throw invalid();
  const roleIds = [...new Set(['@everyone', ...previous.roles, ...add])];
  const definitions = verifyScopedRoleDefinitions(attestation, evidence.auxiliary, roleIds, evidence.definitions);
  const baseGrants = roles => new Set(['@everyone', ...roles].flatMap(id => definitions.get(id).grants));
  const oldGrants = baseGrants(previous.roles);
  if (oldGrants.size !== previous.grants.length || previous.grants.some(grant => !oldGrants.has(grant)) ||
      changed.some(id => definitions.get(id).rank >= authority.rank) ||
      (!authority.bypassesACL && add.some(id => definitions.get(id).grants.some(grant => !authority.grants.includes(grant))))) throw invalid();
  const nextRoles = [...previous.roles.filter(id => !remove.includes(id)), ...add];
  const nextGrants = baseGrants(nextRoles);
  const introducesAdministrator = nextGrants.has(administrator) && !oldGrants.has(administrator);
  if (introducesAdministrator && !previous.recoveryReady) throw invalid();
  const next = { roles: nextRoles, grants: [...nextGrants], bypassesACL: nextGrants.has(administrator) };
  const { basis, actor: actorRules, before, after } = evidence.channel;
  const access = (id, state, rules) => verifyScopedChannelKeyAccess(attestation, channelId, kind, id, state, basis, rules);
  const editorAccess = access(actor.ProfileID, authority, actorRules);
  const oldAccess = access(change.targetProfileId, previous, before);
  const newAccess = access(change.targetProfileId, next, after);
  if (!authority.bypassesACL && Object.keys(newAccess).some(permission => newAccess[permission] && !oldAccess[permission] && !editorAccess[permission])) throw invalid();

  const recipients = permissions => {
    const keys = kind === 'text' ? previous.keys?.filter(key => key.kind === 'device' || key.kind === 'recovery')
      : previous.keys?.filter(key => key.kind === 'device');
    return kind === 'text' ? { live: permissions.view ? keys : [], archive: permissions.fullHistory ? keys : [] }
      : { voice: permissions.connect ? keys : [] };
  };
  return { profileId: change.targetProfileId, before: recipients(oldAccess), after: recipients(newAccess),
    oldAccess, newAccess, targetKeyRoot: previous.keyRoot };
}

function verifyRoleAssignmentRotation(trust, predecessor, task, record, evidence, publisher) {
  const { Purpose: purpose, ChannelID: channelId, Revision: revision, PolicyDigest: policyDigest, Recipients: recipients } = task ?? {};
  if (!['live', 'archive'].includes(purpose) || predecessor?.projectionVersion !== profileRoleAuthorityProjectionVersion ||
      !hex(channelId, 32) || !hex(policyDigest, 64) || !hex(publisher?.profileId, 64) || !hex(publisher.deviceId, 64) ||
      revision !== record?.Draft?.Revision || policyDigest !== record?.Draft?.ResultDigest || !recipients ||
      typeof recipients !== 'object' || Array.isArray(recipients)) throw invalid();
  const delta = verifyScopedRoleAssignment(trust, predecessor, record, evidence.assignment, channelId, 'text');
  const { previousTextPolicy, previousOpenings, removedGroup } = evidence;
  if (previousTextPolicy?.channelId !== channelId || previousTextPolicy.revision !== predecessor.revision ||
      previousTextPolicy.policyDigest !== predecessor.policyDigest) throw invalid();
  const publisherKey = Object.hasOwn(recipients, publisher.deviceId) && recipients[publisher.deviceId];
  if (publisherKey?.ProfileID !== publisher.profileId || publisherKey?.Kind !== 'device') throw invalid();
  const admission = verifyTextRecipientDisclosure(predecessor.root, channelId, previousTextPolicy,
    { recipientId: publisher.deviceId, recipientKey: publisherKey.PublicKey, purpose }, predecessor.projectionVersion);
  if (admission.profileId !== publisher.profileId) throw invalid();
  const previousRoot = purpose === 'archive' ? previousTextPolicy.rotation?.archiveProfiles : previousTextPolicy.rotation?.liveProfiles;

  const expected = delta.after[purpose];
  if (!expected) throw invalid();
  const targetEntries = new Map(Object.entries(recipients).filter(([, key]) => key?.ProfileID === delta.profileId));
  if (targetEntries.size !== expected.length || expected.some(key => {
    const actual = targetEntries.get(key.id);
    return !actual || key.kind !== actual.Kind || key.publicKey !== actual.PublicKey;
  })) throw invalid();

  // The proposed set supplies the unchanged groups. Authenticate them against
  // the predecessor after reversing exactly the signed target's change.
  const previousRecipients = Object.fromEntries(Object.entries(recipients).filter(([id]) => !targetEntries.has(id)));
  const oldKeys = delta.before[purpose];
  if (removedGroup !== undefined) {
    // A revocation may use an opaque prior group. Its membership is checked
    // against the old root without revealing the former device keys.
    if (expected.length || oldKeys?.length === 0) throw invalid();
    verifyRotationProfileRemoval(purpose, previousRoot, previousRecipients, previousOpenings, delta.profileId, removedGroup);
  } else {
    // A previously eligible profile may have no registered recipient keys.
    // With a closed key opening the predecessor root also verifies absence.
    for (const key of oldKeys ?? []) {
      if (Object.hasOwn(previousRecipients, key.id)) throw invalid();
      previousRecipients[key.id] = { ProfileID: delta.profileId, Kind: key.kind, PublicKey: key.publicKey };
    }
    verifyRotationProfiles(purpose, previousRoot, previousRecipients, previousOpenings);
  }
  const digest = roleAssignmentEpochDigest(task, record);
  return { ...delta, admission, ...(purpose === 'archive' ? { archiveTransitionDigest: digest } : { liveTransitionDigest: digest }) };
}

function roleAssignmentEpochDigest(epoch, proof) {
  const { Principal: actor, Draft: draft, Digest: successorHead } = proof ?? {};
  const editorProof = draft?.ResourceChange?.RolesEdit?.EditorProof;
  if (!['live', 'archive'].includes(epoch?.Purpose) || draft?.Action !== scopedRoleEditAction || !editorProof ||
      epoch.Revision !== draft.Revision || epoch.PolicyDigest !== draft.ResultDigest ||
      !hex(successorHead, 64) || !hex(draft.PreviousDigest, 64) || !hex(draft.TextProjectionRoot, 64)) throw invalid();
  const frame = signatureFrame(`pawtalk-protected-${epoch.Purpose}-role-assignment-v1`, epoch.ChannelID, String(draft.Revision),
    draft.PreviousDigest, successorHead, draft.ResultDigest, draft.TextProjectionRoot, draft.OperationID, actor.ProfileID, actor.DeviceID, editorProof);
  return createHash('sha256').update(frame).digest('hex');
}

function verifyRoleAssignmentEpochSigner(trust, predecessor, epoch, evidence) {
  const { Record: record, Principal: publisher } = epoch ?? {};
  if (!record || !publisher || !evidence) throw invalid();
  const { Purpose: purpose, ChannelID: channel } = record;
  const marker = purpose === 'archive' ? record.ArchiveTransitionDigest : record.LiveTransitionDigest;
  if (marker !== roleAssignmentEpochDigest(record, evidence.record)) throw invalid();
  const delta = verifyScopedRoleAssignment(trust, predecessor, evidence.record, evidence.assignment, channel, 'text');
  const signerPolicy = evidence.previousSignerTextPolicy;
  const signerAdmission = verifyAttestedTextAdmission(predecessor, channel, signerPolicy, {
    recipientId: publisher.DeviceID, profileId: publisher.ProfileID, purpose,
    recipientKey: signerPolicy?.recipient?.statement?.publicKey,
  });
  if (publisher.ProfileID === delta.profileId && !(purpose === 'archive' ? delta.newAccess.fullHistory : delta.newAccess.view)) throw invalid();
  const signer = { profileId: publisher.ProfileID, deviceId: publisher.DeviceID, key: signerAdmission.signingKey };
  return { signer, delta };
}

function verifyRoleAssignmentDelivery(trust, predecessor, delivery, recipient) {
  const { Epoch: epoch, Package: addressed, roleAssignment: evidence } = delivery ?? {};
  const record = epoch?.Record;
  if (!record || !recipient || addressed?.RecipientID !== recipient.recipientId || addressed.Purpose !== recipient.purpose ||
      record.Purpose !== recipient.purpose) throw invalid();
  const { Purpose: purpose, ChannelID: channel } = record;
  const { signer, delta } = verifyRoleAssignmentEpochSigner(trust, predecessor, epoch, evidence);

  if (recipient.profileId !== delta.profileId) {
    if (evidence.successorViewerPolicy !== undefined) throw invalid();
    return { signer, delta, admission: verifyAttestedTextAdmission(predecessor, channel, evidence.previousViewerTextPolicy, recipient) };
  }
  if (!delta.after[purpose]?.some(key => key.kind === (recipient.kind ?? 'device') &&
      key.id === recipient.recipientId && key.publicKey === recipient.recipientKey)) throw invalid();
  // The epoch publisher signs the successor root for this transition only.
  // The caller still verifies the epoch signature with the preceding signer.
  const successor = { revision: record.Revision, policyDigest: record.PolicyDigest, projectionVersion: predecessor.projectionVersion,
    root: evidence.record.Draft.TextProjectionRoot };
  const admission = verifyAttestedTextAdmission(successor, channel, evidence.successorViewerPolicy, recipient);
  const canSend = (recipient.kind ?? 'device') === 'device' && delta.newAccess.canSend;
  if (admission.archive !== delta.newAccess.fullHistory || admission.canSend !== canSend) throw invalid();
  if (delta.oldAccess.view) {
    const previous = verifyAttestedTextAdmission(predecessor, channel, evidence.previousViewerTextPolicy, { ...recipient, purpose: 'live' });
    if (previous.firstPosition !== admission.firstPosition || previous.signingKey !== admission.signingKey) throw invalid();
  } else if (evidence.previousViewerTextPolicy !== undefined) throw invalid();
  return { signer, delta, admission };
}

function verifyLiveRoleHistory(trust, predecessor, delivery, recipient) {
  const { Epoch: live, liveRoleHistory: { archive, receipt, transition } = {}, Package: addressed } = delivery;
  if (recipient.purpose !== 'live' || (recipient.kind ?? 'device') !== 'device' || live.Record.Purpose !== 'live' ||
      addressed?.RecipientID !== recipient.recipientId || addressed.Purpose !== 'live' ||
      (archive === undefined) === (receipt === undefined) ||
      live.Record.Revision > predecessor.revision || transition?.successorViewerPolicy !== undefined) throw invalid();
  const channel = live.Record.ChannelID;
  let signer, delta;
  if (archive !== undefined) {
    if (archive?.Record?.Purpose !== 'archive' || archive.Record.ChannelID !== channel) throw invalid();
    ({ signer, delta } = verifyRoleAssignmentEpochSigner(trust, predecessor, archive, transition));
  } else {
    if (transition?.previousSignerTextPolicy != null) throw invalid();
    delta = verifyScopedRoleAssignment(trust, predecessor, transition?.record, transition?.assignment, channel, 'text');
    verifyLiveRoleHistoryReceipt(trust, live.Record, transition.record, receipt);
  }
  if (!delta.oldAccess.view || !delta.newAccess.view || delta.oldAccess.fullHistory === delta.newAccess.fullHistory) throw invalid();
  const previous = verifyAttestedTextAdmission(predecessor, channel, transition.previousViewerTextPolicy, recipient);
  const { Revision: revision, ResultDigest: policyDigest, TextProjectionRoot: root } = transition.record.Draft;
  const policy = { revision, digest: transition.record.Digest, previous: predecessor.digest, policyDigest, root,
    projectionVersion: predecessor.projectionVersion };
  const admission = verifyAttestedTextAdmission(policy, channel, delivery.textPolicy, recipient);
  const changesViewer = recipient.profileId === delta.profileId;
  if (admission.firstPosition !== previous.firstPosition || admission.signingKey !== previous.signingKey ||
      admission.archive !== (changesViewer ? delta.newAccess.fullHistory : previous.archive) ||
      admission.canSend !== (changesViewer ? delta.newAccess.canSend : previous.canSend)) throw invalid();
  return { signer, admission, policy };
}

function verifyLiveRoleHistoryReceipt(trust, live, proof, encoded) {
  const { Principal: actor, Draft: draft, Digest: successor } = proof;
  const { EditorProof: editorProof, ServerKey: serverKey } = draft.ResourceChange.RolesEdit;
  if (!Number.isSafeInteger(live.Generation) || live.Generation < 1 || !hex(live.KeyID, 64) ||
      typeof live.Signature !== 'string' || live.Signature.length !== 88 ||
      typeof serverKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(serverKey) ||
      typeof encoded !== 'string' || encoded.length !== 88) throw invalid();
  const rawKey = Buffer.from(serverKey, 'base64url'), signature = Buffer.from(encoded, 'base64');
  if (rawKey.toString('base64url') !== serverKey || signature.length !== 64 || signature.toString('base64') !== encoded ||
      createHash('sha256').update(rawKey).digest('hex').slice(0, 32) !== trust.serverId) throw invalid();
  const liveDigest = createHash('sha256').update(Buffer.from(live.Signature, 'base64')).digest('hex');
  const frame = signatureFrame('pawtalk-live-role-history-receipt-v1', trust.serverId, trust.cutoverDigest, live.ChannelID,
    String(live.Generation), live.KeyID, liveDigest, draft.OperationID, actor.ProfileID, actor.DeviceID, String(draft.Revision),
    draft.PreviousDigest, successor, draft.ResultDigest, draft.TextProjectionRoot, editorProof);
  const publicKey = createPublicKey({ key: Buffer.concat([serverKeyPrefix, rawKey]), format: 'der', type: 'spki' });
  if (!verify(null, frame, publicKey, signature)) throw invalid();
}

function verifyRoleAssignmentAuthor(transition, record, author, disclosure, position, successorDisclosure, keyOpening) {
  const { assignment, predecessor, delta } = transition;
  if (!author?.ProfileID || !Number.isSafeInteger(position) || position < 1 ||
      record.LiveTransitionDigest !== roleAssignmentEpochDigest(record, assignment)) throw invalid();
  const target = author.ProfileID === delta.profileId;
  const newcomer = target && !delta.oldAccess.view;
  if ((target && !(delta.newAccess.view && delta.newAccess.canSend)) ||
      (newcomer ? disclosure !== undefined || !keyOpening : keyOpening !== undefined)) throw invalid();
  const authorPolicy = newcomer ? successorDisclosure : disclosure;
  const basis = newcomer ? { revision: record.Revision, policyDigest: record.PolicyDigest, projectionVersion: predecessor.projectionVersion,
    root: assignment.Draft.TextProjectionRoot } : predecessor;
  const admission = verifyAttestedTextAdmission(basis, record.ChannelID, authorPolicy, {
    recipientId: author.DeviceID, profileId: author.ProfileID, purpose: 'live',
    recipientKey: authorPolicy?.recipient?.statement?.publicKey,
  });
  if (((!target || newcomer) && !admission.canSend) || admission.firstPosition > position) throw invalid();
  if (newcomer && verifyProfileSigningKey(delta.targetKeyRoot, author.DeviceID, keyOpening) !== admission.signingKey) throw invalid();
  return { profileId: author.ProfileID, deviceId: author.DeviceID, key: admission.signingKey };
}

module.exports = { verifyScopedRoleAssignment, verifyRoleAssignmentRotation, roleAssignmentEpochDigest, verifyRoleAssignmentEpochSigner,
  verifyRoleAssignmentDelivery, verifyRoleAssignmentAuthor, verifyLiveRoleHistory };
