const { createHash, createHmac } = require('node:crypto');
const { commitmentRoot, rootFromCommitmentProof } = require('./protected-epoch-packages.cjs');
const { revisionAudienceRoot, groupedRevisionAudienceRoot } = require('./protected-revision-audience.cjs');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { permissionFitsACL } = require('../../../../shared/protected-access.mjs');

const depth = 10;
const capacity = 1 << depth;
const domain = 'pawtalk-channel-policy-commitment-v1';
const leafPrefix = Buffer.from([0]);
const branchPrefix = Buffer.from([1]);
const textRecipientProjectionVersion = 3;
const textRevisionProjectionVersion = 4;
const textRevisionAudienceVersion = 5;
const textRotationAudienceVersion = 6;
const textOrderAuthorityVersion = 7;
const voiceRecipientProjectionVersion = 8;
const channelSettingsProjectionVersion = 9;
const channelACLProjectionVersion = 10;
const profileRankProjectionVersion = 11;
const profileACLBypassProjectionVersion = 12;
const textGroupedRotationProjectionVersion = 13;
const textGroupedArchiveRotationProjectionVersion = 14;
const textGroupedRevisionAudienceProjectionVersion = 15;
const textRoleViewDenyProjectionVersion = 16;
const textNewcomerAdmissionProjectionVersion = 17;
const profileRoleAuthorityProjectionVersion = 18;
const hasTextRecipientProjection = version => Number.isInteger(version) &&
  version >= textRecipientProjectionVersion && version <= profileRoleAuthorityProjectionVersion;
const hexDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const invalid = () => Object.assign(new Error('INVALID_CHANNEL_POLICY_PROOF'), { code: 'INVALID_CHANNEL_POLICY_PROOF' });

function hash(...fields) {
  const value = createHash('sha256');
  for (const field of fields) value.update(field);
  return value.digest();
}

function blind(seed, mode, value) {
  return createHmac('sha256', seed).update(domain).update(Buffer.from([mode])).update(value).digest();
}

function channelHash(channelId) {
  if (typeof channelId !== 'string') throw invalid();
  const bytes = Buffer.from(channelId);
  if (!bytes.length || bytes.length > 64 || bytes.toString('utf8') !== channelId) throw invalid();
  return hash(bytes);
}

function channelPolicyRoot(projections, seedHex) {
  if (!hexDigest(seedHex) || /^0+$/.test(seedHex) || !projections || typeof projections !== 'object' ||
      Array.isArray(projections)) throw invalid();
  const seed = Buffer.from(seedHex, 'hex');
  const entries = Object.entries(projections);
  if (entries.length > capacity) throw invalid();
  const nodes = entries.map(([channelId, projectionDigest]) => {
    if (!hexDigest(projectionDigest)) throw invalid();
    const id = channelHash(channelId);
    const salt = blind(seed, 0, id);
    return { rank: blind(seed, 1, id), node: hash(leafPrefix, id, salt, Buffer.from(projectionDigest, 'hex')) };
  });
  for (let index = 0; nodes.length < capacity; index += 1) {
    const position = Buffer.alloc(2);
    position.writeUInt16BE(index);
    nodes.push({ rank: blind(seed, 3, position), node: blind(seed, 2, position) });
  }
  nodes.sort((left, right) => Buffer.compare(left.rank, right.rank) || Buffer.compare(left.node, right.node));
  let level = nodes.map(({ node }) => node);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(hash(branchPrefix, level[i], level[i + 1]));
    level = next;
  }
  return level[0].toString('hex');
}

// root comes from a separately authenticated policy commitment.
function verifyChannelPolicyProof(root, channelId, projectionDigest, proof) {
  let { index, salt, siblings } = proof ?? {};
  if (!hexDigest(root) || !hexDigest(projectionDigest) || !hexDigest(salt) ||
      !Number.isSafeInteger(index) || index < 0 || index >= capacity || !Array.isArray(siblings) ||
      siblings.length !== depth || !siblings.every(hexDigest)) throw invalid();
  let node = hash(leafPrefix, channelHash(channelId), Buffer.from(salt, 'hex'), Buffer.from(projectionDigest, 'hex'));
  for (const sibling of siblings) {
    const side = Buffer.from(sibling, 'hex');
    node = index % 2 ? hash(branchPrefix, side, node) : hash(branchPrefix, node, side);
    index = Math.floor(index / 2);
  }
  if (node.toString('hex') !== root) throw invalid();
}

function textChannelKeyProjectionDigest(projection) {
  if (projection?.kind !== 'text' || Object.keys(projection).length !== 2 || !Array.isArray(projection.recipients) ||
      projection.recipients.length > 8192) throw invalid();
  let previous = '';
  const recipients = projection.recipients.map(recipient => {
    if (!recipient || Object.keys(recipient).length !== 6) throw invalid();
    const fields = recipientFields(recipient);
    if (fields.id <= previous) throw invalid();
    previous = fields.id;
    return fields;
  });
  return hash(JSON.stringify({ kind: 'text', recipients })).toString('hex');
}

function recipientFields({ id, profileId, kind, publicKey, signingKey, archive }) {
  if (!hexDigest(id) || !hexDigest(profileId) || !hexDigest(publicKey) || typeof archive !== 'boolean' ||
      (kind !== 'device' && kind !== 'recovery') ||
      (kind === 'device' ? !hexDigest(signingKey) || hash(Buffer.from(signingKey, 'hex')).toString('hex') !== id :
        signingKey !== '')) throw invalid();
  return { id, profileId, kind, publicKey, signingKey, archive };
}

function recipientLeaf(statement, salt, version) {
  const revision = version >= textRevisionProjectionVersion;
  if (!statement || Object.keys(statement).length !== (revision ? 8 : 7) ||
      (revision && typeof statement.canSend !== 'boolean') || !Number.isSafeInteger(statement.firstPosition) ||
      statement.firstPosition < 1) throw invalid();
  const fields = { ...recipientFields(statement), firstPosition: statement.firstPosition };
  if (revision) fields.canSend = statement.canSend;
  return hash('pawtalk-text-recipient-leaf-v1', salt, JSON.stringify(fields));
}

function textRevisionChannelDigest(root, archiveAudience, limitedAudience, rotation, version) {
  if (!hexDigest(archiveAudience)) throw invalid();
  if (version >= textRotationAudienceVersion) {
    if (!hexDigest(limitedAudience) || !hexDigest(rotation?.live) || !hexDigest(rotation.archive)) throw invalid();
    const fields = [root, archiveAudience, limitedAudience, rotation.live, rotation.archive];
    if (version >= textRoleViewDenyProjectionVersion) {
      if (![rotation.liveProfiles, rotation.archiveProfiles, rotation.limitedProfiles, rotation.roleViewDenies].every(hexDigest)) throw invalid();
      fields.push(rotation.liveProfiles, rotation.archiveProfiles, rotation.limitedProfiles, rotation.roleViewDenies);
      if (version >= textNewcomerAdmissionProjectionVersion) {
        if (!hexDigest(rotation.newcomer)) throw invalid();
        return hash('pawtalk-text-revision-policy-v8:', ...fields, rotation.newcomer).toString('hex');
      }
      if (rotation.newcomer !== undefined) throw invalid();
      return hash('pawtalk-text-revision-policy-v7:', ...fields).toString('hex');
    }
    if (rotation.roleViewDenies !== undefined || rotation.newcomer !== undefined) throw invalid();
    if (version >= textGroupedRevisionAudienceProjectionVersion) {
      if (!hexDigest(rotation.liveProfiles) || !hexDigest(rotation.archiveProfiles) || !hexDigest(rotation.limitedProfiles)) throw invalid();
      return hash('pawtalk-text-revision-policy-v6:', ...fields, rotation.liveProfiles, rotation.archiveProfiles,
        rotation.limitedProfiles).toString('hex');
    }
    if (rotation.limitedProfiles !== undefined) throw invalid();
    if (version >= textGroupedArchiveRotationProjectionVersion) {
      if (!hexDigest(rotation.liveProfiles) || !hexDigest(rotation.archiveProfiles)) throw invalid();
      return hash('pawtalk-text-revision-policy-v5:', ...fields, rotation.liveProfiles, rotation.archiveProfiles).toString('hex');
    }
    if (rotation.archiveProfiles !== undefined) throw invalid();
    if (version >= textGroupedRotationProjectionVersion) {
      if (!hexDigest(rotation.liveProfiles)) throw invalid();
      return hash('pawtalk-text-revision-policy-v4:', ...fields, rotation.liveProfiles).toString('hex');
    }
    if (rotation.liveProfiles !== undefined) throw invalid();
    return hash('pawtalk-text-revision-policy-v3:', ...fields).toString('hex');
  }
  if (rotation !== undefined) throw invalid();
  if (version === textRevisionAudienceVersion) {
    if (!hexDigest(limitedAudience)) throw invalid();
    return hash('pawtalk-text-revision-policy-v2:', root, archiveAudience, limitedAudience).toString('hex');
  }
  if (limitedAudience !== undefined) throw invalid();
  return hash('pawtalk-text-revision-policy-v1:', root, archiveAudience).toString('hex');
}

function channelPolicyCombinedDigest(textDigest, orderDigest) {
  if (!hexDigest(textDigest) || !hexDigest(orderDigest)) throw invalid();
  return hash('pawtalk-channel-policy-with-order-v1:', textDigest, orderDigest).toString('hex');
}

function scopedChannelRoleProjectionDigest(channelDigest, rulesDigest) {
  if (!hexDigest(channelDigest) || !hexDigest(rulesDigest)) throw invalid();
  return hash(signatureFrame('pawtalk-channel-policy-with-key-rules-v1', channelDigest, rulesDigest)).toString('hex');
}

function auxiliaryPolicyDigest(ranks, invites, catalogue, rosters) {
  if (!hexDigest(ranks) || !hexDigest(invites)) throw invalid();
  if (catalogue !== undefined || rosters !== undefined) {
    if (!hexDigest(catalogue) || !hexDigest(rosters)) throw invalid();
    return hash(signatureFrame('pawtalk-policy-auxiliary-projection-v3', ranks, invites, catalogue, rosters)).toString('hex');
  }
  return hash(signatureFrame('pawtalk-policy-auxiliary-projection-v1', ranks, invites)).toString('hex');
}

function scopedAuxiliaryPolicyDigest(version, ranks, invites, catalogue, rosters) {
  if (version === profileRoleAuthorityProjectionVersion) {
    if (!hexDigest(catalogue) || !hexDigest(rosters)) throw invalid();
    return auxiliaryPolicyDigest(ranks, invites, catalogue, rosters);
  }
  if (catalogue !== undefined || rosters !== undefined) throw invalid();
  return auxiliaryPolicyDigest(ranks, invites);
}

function channelPolicyWithRoleRules(projection, roleRulesDigest, version) {
  if (version === profileRoleAuthorityProjectionVersion) return scopedChannelRoleProjectionDigest(projection, roleRulesDigest);
  if (roleRulesDigest !== undefined) throw invalid();
  return projection;
}

function textRecipientBlind(seed, channel, mode, id) {
  return createHmac('sha256', seed).update('pawtalk-text-recipient-commitment-v1')
    .update(Buffer.from([mode, channel.length])).update(channel).update(id).digest();
}

function editorLeaf(domain, id, profileId, key, salt) {
  if (![id, profileId, key, salt].every(hexDigest) || hash(Buffer.from(key, 'hex')).toString('hex') !== id) throw invalid();
  return hash(signatureFrame(domain, id, profileId, key, salt));
}

function channelSettingsDigest(kind, settings) {
  if (kind !== 'text' && kind !== 'voice') throw invalid();
  const frame = 'pawtalk-channel-settings-v1';
  if (settings === null) return hash(signatureFrame(frame)).toString('hex');
  if (!settings || Object.keys(settings).length !== 4) throw invalid();
  const { Name, Description, SlowmodeSeconds, VoiceCapacity } = settings;
  if (typeof Name !== 'string' || !Name || [...Name].length > 64 || /[\p{Cc}\p{Cs}]/u.test(Name) ||
      typeof Description !== 'string' || /\p{Cs}/u.test(Description) ||
      !Number.isInteger(SlowmodeSeconds) || SlowmodeSeconds < 0 || SlowmodeSeconds > 21600 ||
      !Number.isInteger(VoiceCapacity) || VoiceCapacity < 0 || VoiceCapacity > 0xffffffff ||
      (kind === 'text' ? VoiceCapacity !== 0 : SlowmodeSeconds !== 0)) throw invalid();
  // Preserve the framed transcript for descriptions larger than the signed-intent limit.
  const digest = createHash('sha256').update(signatureFrame(frame));
  for (const field of [Name, Description, String(SlowmodeSeconds), String(VoiceCapacity)]) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    digest.update(length).update(bytes);
  }
  return digest.digest('hex');
}

function channelOrderDigest(kind, categoryId, root, version, settingsDigest, aclRoot) {
  if (!['text', 'voice'].includes(kind) || typeof categoryId !== 'string' || !hexDigest(root)) throw invalid();
  if (version >= channelACLProjectionVersion) {
    if (!hexDigest(settingsDigest) || !hexDigest(aclRoot)) throw invalid();
    return hash(signatureFrame('pawtalk-channel-order-resource-v3', kind, categoryId, root, settingsDigest, aclRoot)).toString('hex');
  }
  if (aclRoot !== undefined) throw invalid();
  if (version >= channelSettingsProjectionVersion) {
    if (!hexDigest(settingsDigest)) throw invalid();
    return hash(signatureFrame('pawtalk-channel-order-resource-v2', kind, categoryId, root, settingsDigest)).toString('hex');
  }
  if (settingsDigest !== undefined) throw invalid();
  return hash(signatureFrame('pawtalk-channel-order-resource-v1', kind, categoryId, root)).toString('hex');
}

function channelEditorRoot(channelId, editors, seedHex, domain, saltMode, rankMode) {
  const channel = Buffer.from(channelId);
  const seed = Buffer.from(seedHex, 'hex');
  if (editors.length > 8192) throw invalid();
  const nodes = editors.map(({ id, profileId, key }) => ({
    rank: textRecipientBlind(seed, channel, rankMode, id),
    hash: editorLeaf(domain, id, profileId, key, textRecipientBlind(seed, channel, saltMode, id).toString('hex')),
  }));
  nodes.sort((left, right) => Buffer.compare(left.rank, right.rank) || Buffer.compare(left.hash, right.hash));
  return commitmentRoot(nodes.map(node => node.hash));
}

function channelOrderCommitment(channelId, kind, categoryId, editors, seedHex, version, settings, aclRoot) {
  const root = channelEditorRoot(channelId, editors, seedHex, 'pawtalk-channel-order-editor-v1', 5, 6);
  const settingsDigest = version >= channelSettingsProjectionVersion ? channelSettingsDigest(kind, settings) : undefined;
  return channelOrderDigest(kind, categoryId, root, version, settingsDigest, aclRoot);
}

function channelACLRoleRules(rules, kind) {
  if (!['text', 'voice'].includes(kind)) throw invalid();
  return Object.fromEntries(Object.entries(rules ?? {}).flatMap(([id, rule]) => {
    const allow = rule.Allow?.filter(permission => permissionFitsACL(permission, kind)) ?? null;
    const deny = rule.Deny?.filter(permission => permissionFitsACL(permission, kind)) ?? null;
    return (allow?.length || deny?.length) ? [[id, { Allow: allow, Deny: deny }]] : [];
  }));
}

function quotePolicyJSON(value) {
  // Go encoding/json escapes HTML-sensitive characters and Unicode separators.
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function channelACLRulesJSON(kind, rules) {
  if (!['text', 'voice'].includes(kind) || !rules || typeof rules !== 'object' || Array.isArray(rules)) throw invalid();
  const fields = Object.keys(rules).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).map(id => {
    const rule = rules[id];
    if (!id || /\p{Cs}/u.test(id) || !rule || Object.keys(rule).length !== 2) throw invalid();
    const { Allow, Deny } = rule;
    if (![Allow, Deny].every(list => list === null || Array.isArray(list) && list.every(permission => permissionFitsACL(permission, kind))) ||
        !(Allow?.length || Deny?.length)) throw invalid();
    return `${quotePolicyJSON(id)}:{"Allow":${JSON.stringify(Allow)},"Deny":${JSON.stringify(Deny)}}`;
  });
  return `{${fields.join(',')}}`;
}

function channelACLRulesDigest(kind, rules) {
  return hash(channelACLRulesJSON(kind, rules)).toString('hex');
}

function channelACLRulesWitness(kind, synchronized, rules, salt) {
  if (typeof synchronized !== 'boolean' || !hexDigest(salt)) throw invalid();
  return hash(signatureFrame('pawtalk-channel-acl-role-rules-v1', String(synchronized), channelACLRulesDigest(kind, rules), salt)).toString('hex');
}

function channelACLRoot(rulesDigest, editorsRoot) {
  if (!hexDigest(rulesDigest) || !hexDigest(editorsRoot)) throw invalid();
  return hash(signatureFrame('pawtalk-channel-acl-authority-v1', rulesDigest, editorsRoot)).toString('hex');
}

function channelACLCommitment(channelId, kind, synchronized, rules, editors, seedHex) {
  const editorsRoot = channelEditorRoot(channelId, editors, seedHex, 'pawtalk-channel-acl-editor-v1', 11, 12);
  const salt = textRecipientBlind(Buffer.from(seedHex, 'hex'), Buffer.from(channelId), 10, '').toString('hex');
  return channelACLRoot(channelACLRulesWitness(kind, synchronized, channelACLRoleRules(rules, kind), salt), editorsRoot);
}

function verifyChannelACLAuthority(attestation, channelId, proof, actor) {
  const { kind, synchronized, rules, rulesSalt } = proof ?? {};
  const rulesDigest = channelACLRulesWitness(kind, synchronized, rules, rulesSalt);
  const basis = verifyChannelACLEditor(attestation, channelId, { ...proof, rulesDigest }, actor);
  return { ...basis, synchronized, rules };
}

function verifyChannelACLEditor(attestation, channelId, proof, actor) {
  if (!hasTextRecipientProjection(attestation?.projectionVersion) || attestation.projectionVersion < channelACLProjectionVersion ||
      proof?.channelId !== channelId ||
      proof.revision !== attestation.revision || proof.policyDigest !== attestation.policyDigest ||
      proof.actor?.ProfileID !== actor.ProfileID || proof.actor?.DeviceID !== actor.DeviceID) throw invalid();
  const { kind, categoryId, rulesDigest, signingKey, salt, editors, settingsDigest, orderEditorsRoot, textDigest, inclusion } = proof;
  const leaf = editorLeaf('pawtalk-channel-acl-editor-v1', actor.DeviceID, actor.ProfileID, signingKey, salt);
  const aclRoot = channelACLRoot(rulesDigest, rootFromCommitmentProof(leaf, editors, invalid));
  const authority = channelOrderDigest(kind, categoryId, orderEditorsRoot, attestation.projectionVersion, settingsDigest, aclRoot);
  const projection = channelPolicyWithRoleRules(channelPolicyCombinedDigest(textDigest, authority), proof.roleRulesDigest, attestation.projectionVersion);
  verifyChannelPolicyProof(attestation.root, channelId, projection, inclusion);
  return { channelId, kind, categoryId, revision: proof.revision };
}

function verifyChannelOrderAuthority(attestation, channelId, proof, actor) {
  if (!hasTextRecipientProjection(attestation?.projectionVersion) || attestation.projectionVersion < textOrderAuthorityVersion ||
      proof?.channelId !== channelId ||
      proof.revision !== attestation.revision || proof.policyDigest !== attestation.policyDigest ||
      proof.actor?.ProfileID !== actor.ProfileID || proof.actor?.DeviceID !== actor.DeviceID ||
      typeof proof.categoryId !== 'string' ||
      (proof.kind === 'voice' && attestation.projectionVersion === textOrderAuthorityVersion &&
        proof.textDigest !== '0'.repeat(64))) throw invalid();
  const leaf = editorLeaf('pawtalk-channel-order-editor-v1', actor.DeviceID, actor.ProfileID, proof.signingKey, proof.salt);
  const root = rootFromCommitmentProof(leaf, proof.editors, invalid);
  const authority = channelOrderDigest(proof.kind, proof.categoryId, root, attestation.projectionVersion, proof.settingsDigest, proof.aclRoot);
  const projection = channelPolicyWithRoleRules(channelPolicyCombinedDigest(proof.textDigest, authority), proof.roleRulesDigest, attestation.projectionVersion);
  verifyChannelPolicyProof(attestation.root, channelId, projection, proof.inclusion);
  return { channelId, kind: proof.kind, categoryId: proof.categoryId, revision: proof.revision, policyDigest: proof.policyDigest,
    ...(proof.settingsDigest !== undefined && { settingsDigest: proof.settingsDigest }) };
}

function verifyChannelSettings(attestation, channelId, proof) {
  const version = attestation?.projectionVersion;
  if (!hasTextRecipientProjection(version) || version < channelSettingsProjectionVersion || proof?.channelId !== channelId ||
      proof.revision !== attestation.revision || proof.policyDigest !== attestation.policyDigest) throw invalid();
  const { kind, categoryId, settings, editorsRoot, textDigest, inclusion, revision, policyDigest } = proof;
  const settingsDigest = channelSettingsDigest(kind, settings);
  const authority = channelOrderDigest(kind, categoryId, editorsRoot, version, settingsDigest, proof.aclRoot);
  const projection = channelPolicyWithRoleRules(channelPolicyCombinedDigest(textDigest, authority), proof.roleRulesDigest, version);
  verifyChannelPolicyProof(attestation.root, channelId, projection, inclusion);
  return { channelId, kind, categoryId, settings, settingsDigest, revision, policyDigest };
}

function textRotationDigest(recipients, salt) {
  if (!recipients || typeof recipients !== 'object' || Array.isArray(recipients) || !hexDigest(salt)) throw invalid();
  const ids = Object.keys(recipients).sort();
  if (ids.length > 8192) throw invalid();
  const ordered = Object.fromEntries(ids.map(id => {
    const entry = recipients[id];
    const { ProfileID, Kind, PublicKey } = entry ?? {};
    if (!hexDigest(id) || !hexDigest(ProfileID) || !hexDigest(PublicKey) || !['device', 'recovery'].includes(Kind) ||
        Object.keys(entry).length !== 3) throw invalid();
    return [id, { ProfileID, Kind, PublicKey }];
  }));
  return hash('pawtalk-text-rotation-audience-v1:', salt, JSON.stringify(ordered)).toString('hex');
}

function rotationProfileGroups(recipients) {
  if (!recipients || typeof recipients !== 'object' || Array.isArray(recipients)) throw invalid();
  const entries = Object.entries(recipients);
  if (entries.length > 8192) throw invalid();
  const groups = new Map();
  for (const [id, recipient] of entries) {
    const profile = recipient?.ProfileID;
    if (!hexDigest(profile)) throw invalid();
    if (!groups.has(profile)) groups.set(profile, Object.create(null));
    groups.get(profile)[id] = recipient;
  }
  return groups;
}

function rotationProfileLeaf(purpose, profile, salt, digest) {
  if (![profile, salt, digest].every(hexDigest)) throw invalid();
  return hash(signatureFrame(`pawtalk-${purpose}-rotation-profile-v1`, profile, salt, digest));
}

function rotationProfileRoot(purpose, leaves) {
  return hash(`pawtalk-${purpose}-rotation-profiles-v1:`, ...leaves.sort(Buffer.compare)).toString('hex');
}

function rotationProfileLeaves(purpose, groups, openingFor) {
  return Array.from(groups, ([profile, group]) => {
    const { salt, contentSalt } = openingFor(profile) ?? {};
    return rotationProfileLeaf(purpose, profile, salt, textRotationDigest(group, contentSalt));
  });
}

function openRotationProfiles(purpose, groups, openings) {
  if (!openings || typeof openings !== 'object' || Array.isArray(openings) || Object.keys(openings).length !== groups.size) {
    throw invalid();
  }
  return rotationProfileLeaves(purpose, groups, profile => {
    const opening = Object.hasOwn(openings, profile) && openings[profile];
    if (!opening || Object.keys(opening).length !== 2) throw invalid();
    return opening;
  });
}

function verifyRotationProfiles(purpose, root, recipients, openings) {
  if (!['live', 'archive'].includes(purpose) || !hexDigest(root) ||
      rotationProfileRoot(purpose, openRotationProfiles(purpose, rotationProfileGroups(recipients), openings)) !== root) {
    throw invalid();
  }
}

// The authorized intent supplies targetProfileId. The previous attested root
// authenticates every survivor and the one opaque removed group.
function verifyRotationProfileRemoval(purpose, previousRoot, recipients, openings, targetProfileId, removedGroup) {
  if (!hexDigest(targetProfileId) || !removedGroup) throw invalid();
  return verifyRotationProfileRemovals(purpose, previousRoot, recipients, openings, [targetProfileId], { [targetProfileId]: removedGroup });
}

function verifyRotationProfileRemovals(purpose, previousRoot, recipients, openings, excludedProfiles, removedGroups) {
  if (!['live', 'archive'].includes(purpose) || !hexDigest(previousRoot) ||
      !Array.isArray(excludedProfiles) || excludedProfiles.length === 0 || excludedProfiles.length > 8192 ||
      !removedGroups || typeof removedGroups !== 'object' || Array.isArray(removedGroups)) throw invalid();
  const groups = rotationProfileGroups(recipients);
  const excluded = new Set();
  for (const profile of excludedProfiles) {
    if (!hexDigest(profile) || groups.has(profile) || excluded.has(profile)) throw invalid();
    excluded.add(profile);
  }
  const removed = [];
  for (const [profile, opening] of Object.entries(removedGroups)) {
    if (!excluded.has(profile) || !opening || typeof opening !== 'object' || Array.isArray(opening) ||
        Object.keys(opening).length !== 2) throw invalid();
    removed.push(rotationProfileLeaf(purpose, profile, opening.salt, opening.digest));
  }
  const survivors = openRotationProfiles(purpose, groups, openings);
  if (rotationProfileRoot(purpose, [...survivors, ...removed]) !== previousRoot) throw invalid();
  return rotationProfileRoot(purpose, survivors);
}

function textNewcomerAdmissionDigest({ salt, visible, archive, canSend } = {}) {
  if (!hexDigest(salt) || ![visible, archive, canSend].every(value => typeof value === 'boolean') ||
      (!visible && (archive || canSend))) throw invalid();
  return hash(signatureFrame('pawtalk-text-newcomer-admission-v1', salt,
    String(visible), String(archive), String(canSend))).toString('hex');
}

function textRecipientCommitment(channelId, statements, seedHex, version = textRecipientProjectionVersion, roleViewDenies, newcomer) {
  const channel = Buffer.from(channelId);
  if (!channel.length || channel.length > 64 || !hexDigest(seedHex) || !Array.isArray(statements) || statements.length > 8192) {
    throw invalid();
  }
  const seed = Buffer.from(seedHex, 'hex');
  const blind = (mode, id) => textRecipientBlind(seed, channel, mode, id);
  let previous = '';
  const nodes = statements.map(statement => {
    if (!hexDigest(statement?.id) || statement.id <= previous) throw invalid();
    previous = statement.id;
    return { rank: blind(1, statement.id), hash: recipientLeaf(statement, blind(0, statement.id), version) };
  });
  nodes.sort((left, right) => Buffer.compare(left.rank, right.rank) || Buffer.compare(left.hash, right.hash));
  const root = commitmentRoot(nodes.map(node => node.hash));
  if (version < textRevisionProjectionVersion) return root;
  const archived = statements.filter(statement => statement.archive).map(recipientFields);
  const limitedAudience = version >= textRevisionAudienceVersion
    ? revisionAudienceRoot(statements, set => blind(2, set.toString('hex'))) : undefined;
  let rotation;
  if (version >= textRotationAudienceVersion) {
    const recipients = entries => Object.fromEntries(entries.map(({ id, profileId, kind, publicKey }) =>
      [id, { ProfileID: profileId, Kind: kind, PublicKey: publicKey }]));
    const live = recipients(statements);
    const archive = recipients(archived);
    rotation = { live: textRotationDigest(live, blind(3, '').toString('hex')),
      archive: textRotationDigest(archive, blind(4, '').toString('hex')) };
    const grouped = (purpose, group, saltMode) => rotationProfileRoot(purpose, rotationProfileLeaves(purpose, rotationProfileGroups(group),
      profile => ({ salt: blind(saltMode, profile).toString('hex'), contentSalt: blind(saltMode + 1, profile).toString('hex') })));
    if (version >= textGroupedRotationProjectionVersion) {
      rotation.liveProfiles = grouped('live', live, 14);
    }
    if (version >= textGroupedArchiveRotationProjectionVersion) {
      rotation.archiveProfiles = grouped('archive', archive, 16);
    }
    if (version >= textGroupedRevisionAudienceProjectionVersion) {
      rotation.limitedProfiles = groupedRevisionAudienceRoot(statements,
        profile => ({ salt: blind(18, profile).toString('hex'), contentSalt: blind(19, profile).toString('hex') }),
        set => blind(20, set.toString('hex')));
    }
    if (version >= textRoleViewDenyProjectionVersion) rotation.roleViewDenies = roleViewDenies;
    if (version >= textNewcomerAdmissionProjectionVersion) rotation.newcomer = newcomer;
  }
  return textRevisionChannelDigest(root, hash(JSON.stringify(archived)).toString('hex'), limitedAudience, rotation, version);
}

function voiceRecipientLeaf({ deviceId, profileId, publicKey }, signingKey, salt) {
  if (![deviceId, profileId, publicKey, signingKey, salt].every(hexDigest) ||
      hash(Buffer.from(signingKey, 'hex')).toString('hex') !== deviceId) throw invalid();
  return hash(signatureFrame('pawtalk-voice-recipient-v1', deviceId, profileId, publicKey, signingKey, salt));
}

function voiceRecipientCommitment(channelId, recipients, seedHex) {
  const channel = Buffer.from(channelId);
  if (!channel.length || channel.length > 64 || !hexDigest(seedHex) || !Array.isArray(recipients) ||
      recipients.length > 8192) throw invalid();
  const seed = Buffer.from(seedHex, 'hex');
  const devices = new Set();
  const nodes = recipients.map(recipient => {
    const { deviceId, signingKey } = recipient;
    if (!hexDigest(deviceId) || devices.has(deviceId)) throw invalid();
    devices.add(deviceId);
    const salt = textRecipientBlind(seed, channel, 8, deviceId).toString('hex');
    return { rank: textRecipientBlind(seed, channel, 9, deviceId), hash: voiceRecipientLeaf(recipient, signingKey, salt) };
  });
  nodes.sort((left, right) => Buffer.compare(left.rank, right.rank) || Buffer.compare(left.hash, right.hash));
  return commitmentRoot(nodes.map(node => node.hash));
}

function verifyVoiceRecipientDisclosure(root, channelId, roster, disclosure, version) {
  const { recipients, inclusion, orderDigest, roleRulesDigest } = disclosure ?? {};
  if ((version !== undefined && !hasTextRecipientProjection(version)) ||
      !Array.isArray(roster) || !Array.isArray(recipients) || !roster.length ||
      recipients.length !== roster.length || roster.length > 8192) throw invalid();
  let recipientRoot;
  const signers = new Map(roster.map((recipient, index) => {
    const { sessionId, profileId, deviceId } = recipient;
    const authority = recipients[index];
    if (authority?.deviceId !== deviceId) throw invalid();
    const { signingKey, salt, proof } = authority;
    const statement = voiceRecipientLeaf(recipient, signingKey, salt);
    const candidate = rootFromCommitmentProof(statement, proof, invalid);
    recipientRoot ??= candidate;
    if (candidate !== recipientRoot) throw invalid();
    return [sessionId, { sessionId, profileId, deviceId, key: signingKey }];
  }));
  const projection = channelPolicyWithRoleRules(channelPolicyCombinedDigest(recipientRoot, orderDigest), roleRulesDigest, version);
  verifyChannelPolicyProof(root, channelId, projection, inclusion);
  return signers;
}

// root must already have been authenticated as part of an authorized policy.
function verifyTextRecipientDisclosure(root, channelId, disclosure, expected, version = textRecipientProjectionVersion) {
  const { recipient, inclusion, archiveAudience, limitedAudience, rotation, orderAuthority, roleRulesDigest } = disclosure ?? {};
  const { statement, salt } = recipient ?? {};
  if (!hasTextRecipientProjection(version) || !hexDigest(salt) || statement?.kind !== (expected?.kind ?? 'device') || expected &&
      (statement.id !== expected.recipientId || statement.publicKey !== expected.recipientKey ||
       (expected.purpose === 'archive' && !statement.archive))) throw invalid();
  const leaf = recipientLeaf(statement, Buffer.from(salt, 'hex'), version);
  const recipientRoot = rootFromCommitmentProof(leaf, recipient, invalid);
  if (version < textRevisionProjectionVersion && (archiveAudience !== undefined || limitedAudience !== undefined || rotation !== undefined)) throw invalid();
  const channelDigest = version >= textRevisionProjectionVersion
    ? textRevisionChannelDigest(recipientRoot, archiveAudience, limitedAudience, rotation, version) : recipientRoot;
  if (version < textOrderAuthorityVersion && orderAuthority !== undefined) throw invalid();
  const projection = version >= textOrderAuthorityVersion ? channelPolicyCombinedDigest(channelDigest, orderAuthority) : channelDigest;
  verifyChannelPolicyProof(root, channelId, channelPolicyWithRoleRules(projection, roleRulesDigest, version), inclusion);
  return statement;
}

module.exports = { channelPolicyRoot, verifyChannelPolicyProof, textChannelKeyProjectionDigest, textRecipientCommitment,
  auxiliaryPolicyDigest, scopedAuxiliaryPolicyDigest, profileRoleAuthorityProjectionVersion, scopedChannelRoleProjectionDigest,
  verifyTextRecipientDisclosure, textRevisionProjectionVersion, textRevisionAudienceVersion, textRotationAudienceVersion,
  textOrderAuthorityVersion, hasTextRecipientProjection, textRotationDigest, channelPolicyCombinedDigest, channelOrderCommitment,
  verifyChannelOrderAuthority, voiceRecipientProjectionVersion, voiceRecipientCommitment, verifyVoiceRecipientDisclosure,
  channelSettingsProjectionVersion, channelSettingsDigest, verifyChannelSettings,
  channelACLProjectionVersion, channelACLCommitment, verifyChannelACLAuthority, verifyChannelACLEditor,
  channelACLRoleRules, channelACLRulesJSON, channelACLRulesDigest,
  profileRankProjectionVersion, profileACLBypassProjectionVersion, textGroupedRotationProjectionVersion, textGroupedArchiveRotationProjectionVersion,
  textGroupedRevisionAudienceProjectionVersion, textRoleViewDenyProjectionVersion, textNewcomerAdmissionProjectionVersion, textNewcomerAdmissionDigest,
  textRecipientBlind, verifyRotationProfiles, verifyRotationProfileRemoval, verifyRotationProfileRemovals };
