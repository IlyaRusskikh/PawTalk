const { createHash } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { explainGrant } = require('../../../../shared/protected-access.mjs');
const { commitmentRoot, rootFromCommitmentProof } = require('./protected-epoch-packages.cjs');
const { channelACLRoleRules, channelACLRulesDigest, textRecipientBlind, textRoleViewDenyProjectionVersion,
  verifyChannelACLEditor, verifyRotationProfileRemovals } = require('./protected-channel-policy-commitments.cjs');
const { verifyRoleACLIntentSignature } = require('./protected-channel-acl-edit.cjs');
const { verifyAttestedTextAdmission } = require('./protected-policy-attestation.cjs');

const invalid = () => Object.assign(new Error('INVALID_CHANNEL_POLICY_PROOF'), { code: 'INVALID_CHANNEL_POLICY_PROOF' });
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const view = 'channel.view';
const everyone = '@everyone';

function roleViewDenyLeaf({ roleId, salt, previousRulesDigest, nextRulesDigest, excludedProfiles }) {
  if (typeof roleId !== 'string' || !roleId || roleId === everyone || ![salt, previousRulesDigest, nextRulesDigest].every(digest) ||
      !Array.isArray(excludedProfiles) || !excludedProfiles.length) throw invalid();
  const profiles = createHash('sha256').update('pawtalk-role-view-deny-profiles-v1:');
  let previous = '';
  for (const profile of excludedProfiles) {
    if (!digest(profile) || profile <= previous) throw invalid();
    profiles.update(Buffer.from(profile, 'hex'));
    previous = profile;
  }
  return createHash('sha256').update(signatureFrame('pawtalk-role-view-deny-effect-v1', roleId, salt, previousRulesDigest,
    nextRulesDigest, profiles.digest('hex'))).digest();
}

function roleViewDenyCommitment(snapshot, channelId, seedHex, policy, scope) {
  const channel = snapshot.Channels[channelId];
  const rawACL = channel.Synchronized ? snapshot.Categories?.[channel.CategoryID] : channel.ACL;
  const activeACL = scope.synchronized ? scope.category : scope.local;
  const rules = channelACLRoleRules(rawACL?.Roles, channel.Kind);
  const denied = new Map();
  for (const [id, subject] of Object.entries(policy.members)) {
    if (snapshot.ProfileBindings?.[id] || explainGrant(policy, subject, scope, view, 0) !== 'allowed' ||
        explainGrant(policy, subject, {}, 'server.administrator', 0) === 'allowed' ||
        activeACL?.profiles?.[id]?.allow?.includes(view)) continue;
    const assigned = [...new Set(subject.roles)].filter(role => role !== everyone && Object.hasOwn(policy.roles, role));
    const namedAllows = assigned.filter(role => rules[role]?.Allow?.includes(view));
    const affected = namedAllows.length ? namedAllows.length === 1 ? namedAllows : [] : assigned;
    for (const roleId of affected) {
      if (rules[roleId]?.Deny?.includes(view)) continue;
      if (!denied.has(roleId)) denied.set(roleId, []);
      denied.get(roleId).push(id);
    }
  }
  const previousRulesDigest = channelACLRulesDigest(channel.Kind, rules);
  const seed = Buffer.from(seedHex, 'hex');
  const channelBytes = Buffer.from(channelId);
  const leaves = Array.from(denied, ([roleId, profiles]) => {
    const before = rules[roleId];
    const allow = (before?.Allow ?? []).filter(permission => permission !== view);
    const next = { ...rules, [roleId]: { Allow: allow.length ? allow : null, Deny: [...(before?.Deny ?? []), view] } };
    return roleViewDenyLeaf({ roleId, salt: textRecipientBlind(seed, channelBytes, 21, roleId).toString('hex'),
      previousRulesDigest, nextRulesDigest: channelACLRulesDigest(channel.Kind, next), excludedProfiles: profiles.sort() });
  }).sort(Buffer.compare);
  return commitmentRoot(leaves);
}

function verifyRoleViewDenyEffect(root, effect) {
  if (!digest(root) || !effect || effect.excludedProfiles?.length > 8192 ||
      rootFromCommitmentProof(roleViewDenyLeaf(effect), effect.proof, invalid) !== root) throw invalid();
  return effect;
}

function roleViewDenyDigest(record, proof) {
  if (!['live', 'archive'].includes(record.Purpose)) throw invalid();
  const { actor, effect } = proof;
  return createHash('sha256').update(signatureFrame(`pawtalk-protected-${record.Purpose}-role-view-deny-v1`,
    record.ChannelID, String(proof.previousRevision), proof.previousHead, String(record.Revision), proof.successorHead, record.PolicyDigest,
    proof.operationId, actor.ProfileID, actor.DeviceID, effect.roleId, effect.previousRulesDigest, effect.nextRulesDigest, proof.editorProof)).digest('hex');
}

function verifyRoleViewDenyAdmission(trust, predecessor, record, proof, recipient, disclosure = proof?.previousTextPolicy) {
  if (!proof?.actor || !['live', 'archive'].includes(record.Purpose) || recipient.purpose !== record.Purpose ||
      !(predecessor.projectionVersion >= textRoleViewDenyProjectionVersion) ||
      proof.previousRevision !== predecessor.revision || proof.previousHead !== predecessor.digest ||
      record.Revision !== predecessor.revision + 1 || !digest(proof.successorHead) || !digest(record.PolicyDigest)) throw invalid();
  const authority = verifyChannelACLEditor(predecessor, record.ChannelID, proof.authority, proof.actor);
  if (authority.kind !== 'text') throw invalid();
  const admission = verifyAttestedTextAdmission(predecessor, record.ChannelID, disclosure, recipient);
  const effect = verifyRoleViewDenyEffect(disclosure.rotation.roleViewDenies, proof.effect);
  verifyRoleACLIntentSignature(trust, proof.actor, { ...authority, digest: predecessor.digest }, proof.operationId,
    effect.previousRulesDigest, effect.nextRulesDigest, proof.editorProof, proof.authority.signingKey);
  const excludedProfiles = new Set(effect.excludedProfiles);
  if (excludedProfiles.has(recipient.profileId)) throw invalid();
  return { admission, excludedProfiles };
}

function verifyRoleViewDenyRotation(trust, predecessor, task, recipient) {
  const proof = task.roleViewDeny;
  const { admission } = verifyRoleViewDenyAdmission(trust, predecessor, task, proof, recipient);
  const archive = task.Purpose === 'archive';
  const previousRoot = archive ? proof.previousTextPolicy.rotation.archiveProfiles : proof.previousTextPolicy.rotation.liveProfiles;
  verifyRotationProfileRemovals(task.Purpose, previousRoot, task.Recipients,
    proof.survivorOpenings, proof.effect.excludedProfiles, proof.removedGroups);
  const digest = roleViewDenyDigest(task, proof);
  return archive ? { admission, archiveTransitionDigest: digest } : { admission, liveTransitionDigest: digest };
}

function verifyRoleViewDenyEpochSigner(trust, predecessor, { Record: record, Principal: principal }, proof) {
  if (!principal || !proof) throw invalid();
  const disclosure = proof.previousSignerTextPolicy;
  if (!disclosure) throw invalid();
  const { admission, excludedProfiles } = verifyRoleViewDenyAdmission(trust, predecessor, record, proof, {
    recipientId: principal.DeviceID, profileId: principal.ProfileID, purpose: record.Purpose,
    recipientKey: disclosure?.recipient?.statement?.publicKey,
  }, disclosure);
  const signedDigest = record.Purpose === 'archive' ? record.ArchiveTransitionDigest : record.LiveTransitionDigest;
  if (signedDigest !== roleViewDenyDigest(record, proof)) throw invalid();
  return { excludedProfiles, signer: { profileId: principal.ProfileID, deviceId: principal.DeviceID, key: admission.signingKey } };
}

function verifyRoleViewDenyDelivery(trust, predecessor, delivery, recipient) {
  const { Epoch: epoch } = delivery;
  const { Purpose: purpose, ChannelID: channelId } = epoch.Record;
  const proof = purpose === 'archive' ? delivery.archiveRoleViewDeny : delivery.liveRoleViewDeny;
  const verified = verifyRoleViewDenyEpochSigner(trust, predecessor, epoch, proof);
  if (purpose !== recipient.purpose || verified.excludedProfiles.has(recipient.profileId)) throw invalid();
  const admission = verifyAttestedTextAdmission(predecessor, channelId, proof.previousTextPolicy, recipient);
  return { ...verified, admission };
}

module.exports = { roleViewDenyCommitment, roleViewDenyDigest, verifyRoleViewDenyRotation, verifyRoleViewDenyDelivery,
  verifyRoleViewDenyEpochSigner };
