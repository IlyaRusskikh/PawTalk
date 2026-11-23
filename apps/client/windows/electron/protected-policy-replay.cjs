const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { canSeeCategory, explainAction, explainGrant, explainGrantEvidence, permissionFitsACL, rank, verifyAccessTransition, verifyRoleTransition } =
  require('../../../../shared/protected-access.mjs');
const { textChannelKeyProjectionDigest, textRecipientCommitment, textRevisionProjectionVersion, textOrderAuthorityVersion,
  channelPolicyCombinedDigest, channelOrderCommitment, voiceRecipientProjectionVersion, voiceRecipientCommitment,
  channelACLProjectionVersion, channelACLCommitment, profileRankProjectionVersion, textRoleViewDenyProjectionVersion,
  textNewcomerAdmissionProjectionVersion, textNewcomerAdmissionDigest, textRecipientBlind, auxiliaryPolicyDigest } =
  require('./protected-channel-policy-commitments.cjs');
const { profileRankProjection, profileRankRoot, profileRoleAuthorityProjectionVersion } = require('./protected-policy-profile-ranks.cjs');
const { scopedChannelRuleDigest, scopedChannelRoleProjectionDigest } = require('./protected-role-channel-rules.cjs');
const { scopedRoleCatalogueRoot } = require('./protected-role-catalogue.cjs');
const { scopedRoleRosterRoot } = require('./protected-role-roster.cjs');
const { roleViewDenyCommitment } = require('./protected-role-view-deny.cjs');
const { inviteIssuerRoot, inviteCredentialRoot,
  inviteAdmissionDigest } = require('./protected-invite-admission-commitment.cjs');
const { validRecoveryEd25519Key } = require('./protected-runtime-recovery.cjs');
const { matchesOwnerTransferCandidates, validAuthorityKey } = require('./protected-scope-authority.cjs');
const { validRecipientKey } = require('./protected-recipient-key.cjs');
const { validCommittedProfileLinkTime } = require('./protected-profile-linking.cjs');
const { scopedACLRoleEditAction, scopedACLPersonalEditAction } = require('./protected-channel-acl-edit.cjs');
const { scopedRoleEditAction } = require('./protected-scoped-roles.cjs');

const entries = value => Object.entries(value ?? {});
const own = (value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined;
const arrays = value => value ?? [];
const map = (object, convert) => Object.fromEntries(entries(object).map(([key, value]) => [key, convert(value)]));
const hexKey = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const reject = () => { throw Object.assign(new Error('UNAUTHORIZED_POLICY_TRANSITION'), { code: 'UNAUTHORIZED_POLICY_TRANSITION' }); };

function asPolicy(snapshot) {
  return {
    owner: snapshot.Owner, order: arrays(snapshot.Order),
    roles: map(snapshot.Roles, role => ({ grants: arrays(role.Grants) })),
    rolePresentation: snapshot.RolePresentation,
    members: map(snapshot.Members, member => ({
      id: member.ID, active: member.Active === true, roles: arrays(member.Roles), timeoutUntil: member.TimeoutUntil,
    })),
  };
}

function canInspectFullPolicy(snapshot, profileId, deviceId) {
  const policy = asPolicy(snapshot);
  const member = own(policy.members, profileId);
  const device = own(snapshot.PolicyDevices, deviceId);
  return !!member && device?.ProfileID === profileId && !device.Revoked &&
    explainGrant(policy, member, {}, 'server.administrator', 0) === 'allowed';
}

function asACL(acl) {
  const overwrite = value => ({ allow: arrays(value.Allow), deny: arrays(value.Deny) });
  return { roles: map(acl?.Roles, overwrite), profiles: map(acl?.Profiles, overwrite) };
}

function channelScope(snapshot, channel) {
  return { kind: channel.Kind, synchronized: channel.Synchronized, local: asACL(channel.ACL),
    category: asACL(own(snapshot.Categories, channel.CategoryID)) };
}

function editableChannelACLProfiles(snapshot, channel, actorId, profileIds, explicitAdminView) {
  const policy = asPolicy(snapshot);
  const actor = own(policy.members, actorId);
  const editable = new Map();
  if (!actor) return editable;
  const scope = channelScope(snapshot, channel);
  const canListAdmins = explicitAdminView && explainGrant(policy, actor, {}, 'server.administrator', 0) === 'allowed';
  for (const id of profileIds) {
    const target = own(policy.members, id);
    if (target && explainAction(policy, actor, target, scope, 'channel.access.edit', false, 0) === 'allowed') {
      editable.set(id, 'full');
    } else if (canListAdmins && target && explainGrant(policy, target, {}, 'server.administrator', 0) === 'allowed' &&
      !own((scope.synchronized ? scope.category : scope.local).profiles, id)?.deny.includes('channel.view')) {
      editable.set(id, 'view');
    }
  }
  return editable;
}

function channelGrantSummary(snapshot, profileId, channelId, permission, now) {
  const policy = asPolicy(snapshot);
  const subject = own(policy.members, profileId);
  const result = { visible: [], fullHistory: [], allowed: permission === undefined ? undefined : false };
  if (!subject) return result;
  for (const [id, channel] of entries(snapshot.Channels)) {
    if (channelId !== undefined && channelId !== id) continue;
    const scope = channelScope(snapshot, channel);
    if (permission !== undefined) {
      result.evidence = explainGrantEvidence(policy, subject, scope, permission, now);
      result.allowed = result.evidence.decision === 'allowed';
    }
    if (explainGrant(policy, subject, scope, 'channel.view', now) !== 'allowed') continue;
    result.visible.push(id);
    if (channel.Kind === 'text' && explainGrant(policy, subject, scope, 'history.full', now) === 'allowed') result.fullHistory.push(id);
  }
  return result;
}

function roleViewProjection(snapshot, roles, names) {
  const policy = asPolicy(snapshot);
  const subject = { id: Symbol('role preview'), active: true, roles };
  const hasServerGrant = grant => explainGrant(policy, subject, { kind: '' }, grant, 0) === 'allowed';
  const canManageChannels = hasServerGrant('server.administrator');
  const channels = policyResourceOrder(snapshot.ChannelOrder, snapshot.Channels).flatMap(id => {
    const channel = snapshot.Channels[id];
    const scope = channelScope(snapshot, channel);
    const allowed = grant => explainGrant(policy, subject, scope, grant, 0) === 'allowed';
    if (!allowed('channel.view')) return [];
    return [{
      id, kind: channel.Kind, name: channel.Settings?.Name, categoryId: channel.CategoryID,
      canSend: channel.Kind === 'text' && allowed('message.send'),
      canAttach: channel.Kind === 'text' && allowed('message.attach'),
      canConnect: channel.Kind === 'voice' && allowed('voice.connect'),
      canEditSettings: allowed('channel.edit'),
      canInspectACL: allowed('channel.access.edit'),
      members: Object.entries(policy.members).filter(([, member]) =>
        member.active && explainGrant(policy, member, scope, 'channel.view', 0) === 'allowed').slice(0, 32)
        .map(([id]) => ({ id, name: names?.[id] })),
    }];
  });
  const visibleCategories = new Set(channels.map(channel => channel.categoryId));
  const categories = policyResourceOrder(snapshot.CategoryOrder, snapshot.Categories)
    .filter(id => canManageChannels || visibleCategories.has(id))
    .map(id => ({ id, name: snapshot.CategoryNames?.[id] }));
  return { channels, categories, canManageChannels,
    canListInvites: hasServerGrant('invite.create') || hasServerGrant('invite.view-all') };
}

function channelAccessDelta(before, after, channels, { detailLimit = 0, removedRole } = {}) {
  const previous = asPolicy(before), next = asPolicy(after);
  const actions = { gainedView: new Set(), lostView: new Set(), gainedHistory: new Set(), lostHistory: new Set() };
  const details = [];
  let changedChannels = 0;
  let keyChannels = 0;
  for (const id of channels) {
    const oldChannel = own(before.Channels, id), newChannel = own(after.Channels, id);
    const oldScope = oldChannel && channelScope(before, oldChannel), newScope = newChannel && channelScope(after, newChannel);
    const counts = detailLimit > 0 && details.length < detailLimit ? { beforeView: 0, afterView: 0, beforeHistory: 0, afterHistory: 0 } : undefined;
    let example;
    let changed = false;
    for (const [profile, member] of entries(previous.members)) {
      const can = (policy, subject, scope, grant) => !!scope && explainGrant(policy, subject, scope, grant, 0) === 'allowed';
      const oldView = can(previous, member, oldScope, 'channel.view');
      const newView = can(next, own(next.members, profile), newScope, 'channel.view');
      const oldHistory = can(previous, member, oldScope, 'history.full');
      const newHistory = can(next, own(next.members, profile), newScope, 'history.full');
      if (counts) {
        counts.beforeView += Number(oldView);
        counts.afterView += Number(newView);
        counts.beforeHistory += Number(oldHistory);
        counts.afterHistory += Number(newHistory);
      }
      if (oldView !== newView) {
        const action = newView ? 'gainedView' : 'lostView';
        actions[action].add(profile);
      }
      if (oldHistory !== newHistory) {
        const action = newHistory ? 'gainedHistory' : 'lostHistory';
        actions[action].add(profile);
      }
      if (counts && oldScope && newScope && (oldView !== newView || oldHistory !== newHistory)) {
        const permission = oldView !== newView ? 'channel.view' : 'history.full';
        const canPreferRemoval = removedRole && !example?.removedDeny && (newView && !oldView || newHistory && !oldHistory) && member.roles.includes(removedRole);
        if (!example || canPreferRemoval) {
          const previousEvidence = explainGrantEvidence(previous, member, oldScope, permission, 0);
          const removedDeny = !!removedRole && previousEvidence.sources.some(source => source.roleId === removedRole && source.effect === 'deny');
          if (!example || removedDeny) example = { profile, before: previousEvidence,
            after: explainGrantEvidence(next, own(next.members, profile), newScope, permission, 0), removedDeny };
        }
      }
      changed ||= oldView !== newView || oldHistory !== newHistory;
    }
    if (changed) {
      changedChannels++;
      if (newChannel?.Kind === 'text') keyChannels++;
      if (counts) details.push({ id, name: newChannel?.Settings?.Name ?? oldChannel?.Settings?.Name, ...counts, example });
    }
  }
  return { ...Object.fromEntries(Object.entries(actions).map(([action, ids]) => [action, [...ids]])), keyChannels,
    ...(detailLimit > 0 && { details, changedChannels }) };
}

function policyResourceOrder(order, resources) {
  const ids = Object.keys(resources ?? {}).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return [...new Set([...(order ?? []).filter(id => own(resources, id)), ...ids])];
}

function replayOrder(order, resources, id, anchor, after, editable) {
  const result = policyResourceOrder(order, resources);
  const positions = [];
  const moving = [];
  result.forEach((id, i) => {
    if (editable(id)) {
      positions.push(i);
      moving.push(id);
    }
  });
  if (id === anchor || !moving.includes(id) || !moving.includes(anchor)) reject();
  moving.splice(moving.indexOf(id), 1);
  moving.splice(moving.indexOf(anchor) + Number(after), 0, id);
  positions.forEach((position, i) => { result[position] = moving[i]; });
  return result;
}

function replayRoles(before, expected, actorId, update) {
  if (!update?.Roles || entries(update.Assignments).some(([id]) => !own(before.Members, id))) reject();
  expected.Roles = update.Roles;
  expected.Order = update.Order;
  const presentation = {
    ...Object.fromEntries(entries(before.RolePresentation).filter(([id]) => own(update.Roles, id))),
    ...update.Presentation,
  };
  if (Object.keys(presentation).length) expected.RolePresentation = presentation;
  else delete expected.RolePresentation;
  for (const [id, member] of entries(expected.Members)) {
    if (update.Assignments && Object.hasOwn(update.Assignments, id)) {
      member.Roles = update.Assignments[id];
    } else if (member.Roles !== null) {
      member.Roles = arrays(member.Roles).filter(role => own(update.Roles, role));
    }
  }
  const previous = asPolicy(before);
  const after = asPolicy(expected);
  const scopes = [
    ...entries(before.Categories).map(([, acl]) => ({ kind: 'category', local: asACL(acl) })),
    ...entries(before.Channels).map(([, channel]) => channelScope(before, channel)),
  ];
  if (!verifyRoleTransition(previous, after, actorId, scopes, before.RecoveryReady)) reject();
  const cleanRoles = acl => {
    for (const [id] of entries(acl.Roles)) {
      if (!own(expected.Roles, id)) delete acl.Roles[id];
    }
  };
  for (const [, acl] of entries(expected.Categories)) cleanRoles(acl);
  for (const [, channel] of entries(expected.Channels)) cleanRoles(channel.ACL);
}

function scopedRoleUpdate(before, actorId, change) {
  const policy = asPolicy(before);
  const actor = own(policy.members, actorId);
  const editsDefinitions = change.definitions !== undefined || change.order !== undefined || arrays(change.delete).length > 0;
  if (!editsDefinitions) {
    const target = own(policy.members, change.targetProfileId);
    if (!target?.active || !hexKey(change.targetProfileId) ||
        explainAction(policy, actor, target, {}, 'role.assign', false, 0) !== 'allowed') reject();
    if (change.rosterChannelId) {
      const channel = own(before.Channels, change.rosterChannelId);
      if (!channel || channel.Kind !== 'text' || [actor, target].some(member =>
        explainGrant(policy, member, channelScope(before, channel), 'channel.view', 0) !== 'allowed')) reject();
    } else if (explainGrant(policy, actor, {}, 'member.list', 0) !== 'allowed') reject();
    const remove = arrays(change.remove), add = arrays(change.add);
    if (!remove.length && !add.length) reject();
    const assigned = new Set(target.roles);
    for (const id of remove) if (!assigned.delete(id)) reject();
    for (const id of add) {
      if (assigned.has(id) || remove.includes(id) || id === '@everyone' || !own(before.Roles, id)) reject();
      assigned.add(id);
    }
    const ordered = [...assigned].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return { Roles: before.Roles, Order: before.Order, Assignments: { [target.id]: ordered.length ? ordered : null } };
  }
  if (change.targetProfileId || change.rosterChannelId || arrays(change.add).length || arrays(change.remove).length ||
      explainGrant(policy, actor, {}, 'role.edit', 0) !== 'allowed') reject();
  const rank = actorId === policy.owner ? policy.order.length + 1 : policy.order.findLastIndex(id => actor.roles.includes(id)) + 1;
  if (rank === 0) reject();
  let editable = policy.order.slice(0, rank - 1);
  const protectedOrder = policy.order.slice(rank - 1);
  const definitions = new Map(entries(before.Roles));
  const presentation = new Map();
  const deleted = arrays(change.delete);
  for (const id of deleted) {
    const index = editable.indexOf(id);
    if (index < 0) reject();
    editable.splice(index, 1);
    definitions.delete(id);
  }
  const seen = new Set();
  for (const definition of arrays(change.definitions)) {
    const id = definition.id;
    if (!id || seen.has(id) || deleted.includes(id) || protectedOrder.includes(id) ||
        new Set(arrays(definition.grants)).size !== arrays(definition.grants).length) reject();
    seen.add(id);
    if (!definitions.has(id)) editable.push(id);
    definitions.set(id, { Grants: definition.grants ?? null });
    if (definition.presentation) presentation.set(id, definition.presentation);
  }
  if (change.order !== undefined) {
    const ordered = new Set(change.order);
    if (change.order.length !== editable.length || ordered.size !== editable.length || editable.some(id => !ordered.has(id))) reject();
    editable = change.order;
  }
  return { Roles: Object.fromEntries(definitions), Order: [...editable, ...protectedOrder], Presentation: Object.fromEntries(presentation) };
}

function replayAdmissions(before, expected, next) {
  const after = asPolicy(expected);
  expected.Admissions = {};
  for (const [id, channel] of entries(expected.Channels)) {
    if (channel.Kind !== 'text') continue;
    const scope = channelScope(expected, channel);
    const admitted = [];
    for (const [memberId, member] of entries(after.members)) {
      if (explainAction(after, member, {}, scope, 'channel.view', false, 0) !== 'allowed') continue;
      // New positions are chosen by the server at commit and signed by the
      // actor. Existing continuous intervals may never move.
      const admission = own(own(before.Admissions, id), memberId) ?? own(own(next.Admissions, id), memberId);
      if (!Number.isSafeInteger(admission?.FirstPosition) || admission.FirstPosition < 1) reject();
      admitted.push([memberId, { FirstPosition: admission.FirstPosition }]);
    }
    Object.defineProperty(expected.Admissions, id, { value: Object.fromEntries(admitted), enumerable: true });
  }
}

function advanceAdmissionFloor(previous, next, floor) {
  const positions = new Map(entries(floor));
  // Older local checkpoints still carry the last verified snapshot.
  for (const [channel, admissions] of entries(previous?.Admissions)) {
    for (const [, admission] of entries(admissions)) {
      positions.set(channel, Math.max(positions.get(channel) ?? 0, admission.FirstPosition));
    }
  }
  for (const [channel, admissions] of entries(next.Admissions)) {
    let newPosition;
    const seen = positions.get(channel) ?? 0;
    for (const [profile, admission] of entries(admissions)) {
      const first = admission?.FirstPosition;
      if (!Number.isSafeInteger(first) || first < 1) reject();
      if (own(own(previous?.Admissions, channel), profile)) continue;
      if (first < seen || newPosition !== undefined && first !== newPosition ||
          previous && !own(previous.Channels, channel) && first !== 1) reject();
      newPosition = first;
    }
    if (newPosition !== undefined) positions.set(channel, newPosition);
  }
  return Object.fromEntries(positions);
}

function validACL(snapshot, acl, kind) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validRules = (rules, subjects) => rules === null || object(rules) && entries(rules).every(([id, rule]) =>
    own(subjects, id) && object(rule) && ['Allow', 'Deny'].every(key =>
      rule[key] === null || Array.isArray(rule[key]) && rule[key].every(permission => permissionFitsACL(permission, kind))) &&
    !arrays(rule.Allow).some(permission => arrays(rule.Deny).includes(permission)));
  return object(acl) && validRules(acl.Roles, snapshot.Roles) && validRules(acl.Profiles, snapshot.Members);
}

function localizeACL(acl, kind) {
  const applicable = grants => grants === null ? null : grants.filter(id => permissionFitsACL(id, kind));
  const rules = entries => Object.fromEntries(entries.map(([id, rule]) =>
    [id, { Allow: applicable(rule.Allow), Deny: applicable(rule.Deny) }])
    .filter(([, rule]) => arrays(rule.Allow).length + arrays(rule.Deny).length > 0));
  return { Roles: rules(entries(acl.Roles)), Profiles: rules(entries(acl.Profiles)) };
}

function sameRoleOverrides(before, after) {
  const sorted = rules => map(rules, rule => ({ Allow: [...arrays(rule.Allow)].sort(), Deny: [...arrays(rule.Deny)].sort() }));
  return isDeepStrictEqual(sorted(before), sorted(after));
}

function replayScopedPersonalACL(previous, expected, actor, draft) {
  const { ID, TargetProfileID, ACLPersonalEdit: edit } = draft.ResourceChange;
  const channel = own(previous.Channels, ID);
  const device = own(previous.PolicyDevices, actor.DeviceID);
  if (!channel || !edit || Object.keys(draft.ResourceChange).length !== 3 ||
      own(previous.ProfileBindings, actor.ProfileID) || device?.ProfileID !== actor.ProfileID || device.Revoked ||
      !permissionFitsACL(edit.Permission, channel.Kind) || !['allow', 'deny', 'inherit'].includes(edit.Rule)) reject();
  const scope = channelScope(previous, channel);
  const effective = channel.Synchronized ? own(previous.Categories, channel.CategoryID) : channel.ACL;
  const acl = localizeACL(effective ?? emptyACL(), channel.Kind);
  const old = own(acl.Profiles, TargetProfileID);
  const policy = asPolicy(previous);
  const editor = own(policy.members, actor.ProfileID);
  const target = own(policy.members, TargetProfileID);
  if (!editor || !target || explainAction(policy, editor, target, scope, 'channel.access.edit', false, 0) !== 'allowed' ||
      !old && explainGrant(policy, target, scope, 'channel.view', 0) !== 'allowed' &&
      explainGrant(policy, editor, {}, 'member.list', 0) !== 'allowed') reject();
  const permission = edit.Permission;
  const prior = arrays(old?.Allow).includes(permission) ? 'allow' : arrays(old?.Deny).includes(permission) ? 'deny' : 'inherit';
  if (prior === edit.Rule) reject();
  const withoutPermission = list => {
    if (!list?.length) return list ?? null;
    const remaining = list.filter(id => id !== permission);
    return remaining.length ? remaining : null;
  };
  const allow = withoutPermission(old?.Allow);
  const deny = withoutPermission(old?.Deny);
  const rule = { Allow: edit.Rule === 'allow' ? [...arrays(allow), permission] : allow,
    Deny: edit.Rule === 'deny' ? [...arrays(deny), permission] : deny };
  if (arrays(rule.Allow).length || arrays(rule.Deny).length) acl.Profiles[TargetProfileID] = rule;
  else delete acl.Profiles[TargetProfileID];
  replayResource(previous, expected, actor.ProfileID, { ...draft, Action: 'channel.acl.update', ResourceChange: { ID, ACL: acl } });
}

const emptyACL = () => ({ Roles: null, Profiles: null });

function validResourceName(name) {
  return typeof name === 'string' && [...name].length > 0 && [...name].length <= 64 && !/[\p{Cc}\p{Cs}]/u.test(name);
}

function validSettings(kind, settings) {
  if (!validResourceName(settings?.Name) || typeof settings.Description !== 'string' ||
      !Number.isInteger(settings.SlowmodeSeconds) || !Number.isInteger(settings.VoiceCapacity)) return false;
  return kind === 'text' && settings.VoiceCapacity === 0 && settings.SlowmodeSeconds >= 0 && settings.SlowmodeSeconds <= 21600 ||
    kind === 'voice' && settings.SlowmodeSeconds === 0 && settings.VoiceCapacity >= 0 && settings.VoiceCapacity <= 0xffffffff;
}

function removeChannel(expected, id) {
  delete expected.Channels[id];
  if (expected.ChannelOrder) {
    expected.ChannelOrder = expected.ChannelOrder.filter(ordered => ordered !== id);
    if (!expected.ChannelOrder.length) delete expected.ChannelOrder;
  }
  expected.RetiredChannels = { ...expected.RetiredChannels, [id]: true };
  if (expected.VoiceRestrictions) {
    delete expected.VoiceRestrictions[id];
    if (!Object.keys(expected.VoiceRestrictions).length) delete expected.VoiceRestrictions;
  }
}

function replayVoiceRestriction(before, expected, actor, policy, action, channelId, profileId, lift, serverWide, mediaOnly, exactSession) {
  const channel = own(before.Channels, channelId);
  const profile = own(policy.members, profileId);
  if (channel?.Kind !== 'voice' || !profile || typeof lift !== 'boolean') reject();
  const administrator = explainGrant(policy, actor, { kind: '' }, 'server.administrator', 0) === 'allowed';
  const ownerException = exactSession && profile.id === policy.owner && profile.active && administrator &&
    (actor.id !== profile.id || lift);
  const scope = channelScope(before, channel);
  if ((ownerException ? explainGrant(policy, actor, scope, action, 0) : explainAction(policy, actor, profile, scope, action, lift, 0)) !== 'allowed') reject();
  if (serverWide) {
    const selfLift = exactSession && lift && actor.id === profile.id;
    if (!profile.active || !administrator || (!ownerException && !selfLift && rank(policy, actor) <= rank(policy, profile))) reject();
    channelId = '*';
  }
  const subjects = { ...own(before.VoiceRestrictions, channelId) };
  const restriction = { Muted: false, Deafened: false, ...own(subjects, profileId) };
  if (action === 'voice.mute') {
    restriction.Muted = !lift;
  } else if (lift) {
    restriction.Deafened = false;
    delete restriction.MediaDeafened;
  } else if (mediaOnly) {
    restriction.MediaDeafened = true;
  } else {
    restriction.Deafened = true;
  }
  if (restriction.Muted || restriction.Deafened || restriction.MediaDeafened) subjects[profileId] = restriction;
  else delete subjects[profileId];
  const channels = { ...before.VoiceRestrictions };
  if (Object.keys(subjects).length) channels[channelId] = subjects;
  else delete channels[channelId];
  if (Object.keys(channels).length) expected.VoiceRestrictions = channels;
  else delete expected.VoiceRestrictions;
}

function replayLifecycle(before, expected, actorId, draft, { can, verify, categoryScope, visibleCategory }) {
  const { ID, ACL, CategoryID = '', Mode = '', Channel, Settings, SourceID = '', Name } = draft.ResourceChange;
  const action = draft.Action;
  if ((action === 'channel.create') !== (Channel !== undefined) ||
      (action === 'channel.settings.update') !== (Settings !== undefined) ||
      (action === 'channel.copy' || action === 'category.copy') !== Boolean(SourceID) ||
      (action !== 'channel.create' && (ACL !== undefined || CategoryID)) ||
      (action !== 'category.delete' && Mode) ||
      (Name !== undefined && (!['category.create', 'category.copy', 'category.settings.update'].includes(action) || !validResourceName(Name)))) reject();
  if (action === 'category.create' || action === 'category.copy') {
    if (own(before.Categories, ID) || !can({}, 'channel.create')) reject();
    let acl = emptyACL();
    if (action === 'category.copy') {
      const empty = { kind: 'category', local: asACL(acl) };
      if (!visibleCategory(SourceID) || !can(empty, 'channel.access.edit') || !validResourceName(Name)) reject();
      acl = structuredClone(before.Categories[SourceID]);
      verify(empty, { kind: 'category', local: asACL(acl) });
    }
    expected.Categories = { ...expected.Categories, [ID]: acl };
    expected.CategoryCreators = { ...expected.CategoryCreators, [ID]: actorId };
    if (Name !== undefined) expected.CategoryNames = { ...expected.CategoryNames, [ID]: Name };
    return;
  }
  if (action === 'category.settings.update') {
    if (!visibleCategory(ID) || !can(categoryScope(ID), 'channel.edit') || !validResourceName(Name)) reject();
    expected.CategoryNames = { ...expected.CategoryNames, [ID]: Name };
    return;
  }
  if (action === 'category.delete') {
    if (!['delete_children', 'keep_children'].includes(Mode) || !visibleCategory(ID) || !can(categoryScope(ID), 'channel.delete')) reject();
    for (const [id, channel] of entries(before.Channels)) {
      if (channel.CategoryID !== ID) continue;
      if (Mode === 'delete_children') {
        if (!can(channelScope(before, channel), 'channel.delete')) reject();
        removeChannel(expected, id);
      } else {
        expected.Channels[id] = { ...channel, CategoryID: '', Synchronized: false,
          ACL: channel.Synchronized ? localizeACL(before.Categories[ID], channel.Kind) : channel.ACL };
      }
    }
    delete expected.Categories[ID];
    if (expected.CategoryOrder) {
      expected.CategoryOrder = expected.CategoryOrder.filter(ordered => ordered !== ID);
      if (!expected.CategoryOrder.length) delete expected.CategoryOrder;
    }
    if (expected.CategoryCreators) {
      delete expected.CategoryCreators[ID];
      if (!Object.keys(expected.CategoryCreators).length) delete expected.CategoryCreators;
    }
    if (expected.CategoryNames) {
      delete expected.CategoryNames[ID];
      if (!Object.keys(expected.CategoryNames).length) delete expected.CategoryNames;
    }
    return;
  }
  if (action === 'channel.delete') {
    const channel = own(before.Channels, ID);
    if (!channel || !can(channelScope(before, channel), 'channel.delete')) reject();
    removeChannel(expected, ID);
    return;
  }
  if (action === 'channel.settings.update') {
    const channel = own(before.Channels, ID);
    if (!channel || !can(channelScope(before, channel), 'channel.edit') || !validSettings(channel.Kind, Settings)) reject();
    expected.Channels[ID].Settings = Settings;
    return;
  }
  if (!/^[a-f0-9]{32}$/.test(ID) || own(before.Channels, ID) || own(before.RetiredChannels, ID) ||
      entries(before.Channels).length >= 1000) reject();
  const canCreate = category => {
    if (!category) return can({}, 'channel.create');
    const canPopulate = visibleCategory(category) || own(before.CategoryCreators, category) === actorId &&
      !entries(before.Channels).some(([, channel]) => channel.CategoryID === category);
    return own(before.Categories, category) && canPopulate && can(categoryScope(category), 'channel.create');
  };
  let channel;
  if (action === 'channel.copy') {
    const source = own(before.Channels, SourceID);
    if (!source || !can(channelScope(before, source), 'channel.view') || !canCreate(source.CategoryID)) reject();
    channel = { ...source, NextPosition: 0 };
  } else {
    if (!canCreate(CategoryID) || !validSettings(Channel?.Kind, Channel?.Settings)) reject();
    channel = { Kind: Channel.Kind, CategoryID, Synchronized: Boolean(CategoryID), ACL: emptyACL(), Settings: Channel.Settings, NextPosition: 0 };
    if (ACL !== undefined) {
      const scope = channelScope(before, channel);
      if (!can(scope, 'channel.access.edit') || !validACL(before, ACL, channel.Kind)) reject();
      channel.Synchronized = false;
      channel.ACL = ACL;
      verify(scope, channelScope(before, channel));
    }
  }
  expected.Channels = { ...expected.Channels, [ID]: channel };
}

const lifecycleOperations = new Set(['channel.create', 'channel.settings.update', 'channel.copy', 'channel.delete',
  'category.create', 'category.copy', 'category.settings.update', 'category.delete']);

function replayResource(before, expected, actorId, draft) {
  const { ID, ACL, CategoryID = '', Mode = '', Channel, Settings, SourceID = '', TargetProfileID = '', VoiceTargetSessionID, Lift = false, Name,
    AnchorID, After = false, MixedOrder = false } = draft.ResourceChange;
  const policy = asPolicy(before);
  const actor = own(policy.members, actorId);
  const can = (scope, id) => explainAction(policy, actor, {}, scope, id, false, 0) === 'allowed';
  const verify = (previous, next, explicitAdminView = false) => {
    if (!verifyAccessTransition(policy, actor, previous, next, explicitAdminView)) reject();
  };
  const categoryScope = id => ({ kind: 'category', local: asACL(own(before.Categories, id)) });
  const visibleCategory = id => own(before.Categories, id) && canSeeCategory(policy, actor, entries(before.Channels)
    .filter(([, channel]) => channel.CategoryID === id).map(([, channel]) => channelScope(before, channel)));
  const accessEdit = 'channel.access.edit';
  const moving = draft.Action === 'channel.move';
  const ordering = draft.Action === 'category.order' || draft.Action === 'channel.order';
  if (typeof ID !== 'string' || !ID || typeof CategoryID !== 'string' || typeof SourceID !== 'string' || typeof Mode !== 'string') reject();
  if (ordering ? typeof AnchorID !== 'string' || !AnchorID || typeof After !== 'boolean'
    : AnchorID !== undefined || After !== false) reject();
  if (typeof MixedOrder !== 'boolean' || MixedOrder && draft.Action !== 'channel.order') reject();
  if (draft.Action === 'voice.mute' || draft.Action === 'voice.deafen') {
    const mediaOnly = draft.Action === 'voice.deafen' && Mode === 'server-media';
    if (ACL !== undefined || Channel !== undefined || Settings !== undefined || Name !== undefined || SourceID || CategoryID ||
        (Mode && ((!mediaOnly && Mode !== 'server') || VoiceTargetSessionID === undefined)) ||
        typeof TargetProfileID !== 'string' || !TargetProfileID ||
        VoiceTargetSessionID !== undefined && (typeof VoiceTargetSessionID !== 'string' || !/^[0-9a-f]{32}$/.test(VoiceTargetSessionID))) reject();
    replayVoiceRestriction(before, expected, actor, policy, draft.Action, ID, TargetProfileID, Lift, !!Mode, mediaOnly, VoiceTargetSessionID !== undefined);
    return;
  }
  if (TargetProfileID !== '' || VoiceTargetSessionID !== undefined || Lift !== false) reject();
  if (lifecycleOperations.has(draft.Action)) {
    replayLifecycle(before, expected, actorId, draft, { can, verify, categoryScope, visibleCategory });
    return;
  }
  if (Channel !== undefined || Settings !== undefined || Name !== undefined || SourceID || (!moving && (CategoryID || Mode))) reject();
  if (ordering) {
    if (ACL !== undefined) reject();
    if (draft.Action === 'category.order') {
      expected.CategoryOrder = replayOrder(before.CategoryOrder, before.Categories, ID, AnchorID, After,
        id => visibleCategory(id) && can(categoryScope(id), 'channel.edit'));
    } else {
      const source = own(before.Channels, ID);
      if (!source) reject();
      expected.ChannelOrder = replayOrder(before.ChannelOrder, before.Channels, ID, AnchorID, After, id => {
        const channel = before.Channels[id];
        return channel.CategoryID === source.CategoryID && (MixedOrder || source.CategoryID || channel.Kind === source.Kind) &&
          can(channelScope(before, channel), 'channel.edit');
      });
    }
    return;
  }
  if (draft.Action === 'category.acl.update') {
    const scope = categoryScope(ID);
    if (!visibleCategory(ID) || !can(scope, accessEdit) || !validACL(before, ACL, 'category')) reject();
    verify(scope, { ...scope, local: asACL(ACL) });
    expected.Categories[ID] = ACL;
    for (const [, channel] of entries(before.Channels)) {
      if (channel.Synchronized && channel.CategoryID === ID) verify(channelScope(before, channel), channelScope(expected, channel));
    }
    return;
  }
  const previous = own(before.Channels, ID);
  if (!previous) reject();
  const scope = channelScope(before, previous);
  const channel = own(expected.Channels, ID);
  if (moving) {
    if (ACL !== undefined || !can(scope, 'channel.edit') ||
        (CategoryID && (!visibleCategory(CategoryID) || !can(categoryScope(CategoryID), 'channel.edit')))) reject();
    channel.CategoryID = CategoryID;
    if (Mode === 'preserve') {
      const effective = previous.Synchronized ? own(before.Categories, previous.CategoryID) : previous.ACL;
      channel.Synchronized = false;
      channel.ACL = localizeACL(effective, channel.Kind);
      return;
    }
    if (Mode !== 'synchronize') reject();
  }
  if (!can(scope, accessEdit)) reject();
  if (draft.Action === 'channel.acl.update') {
    if (!validACL(before, ACL, channel.Kind)) reject();
    channel.Synchronized = false;
    channel.ACL = ACL;
  } else {
    if (ACL !== undefined || !channel.CategoryID || !own(before.Categories, channel.CategoryID)) reject();
    channel.Synchronized = true;
    channel.ACL = emptyACL();
  }
  verify(scope, channelScope(expected, channel), draft.Action === 'channel.acl.update');
}

function replayRecipient(expected, actor, draft) {
  const current = own(expected.KeyRecipients, actor.DeviceID);
  if (draft.Action === 'recipient.enroll') {
    if (current || !validRecipientKey(draft.PublicKey) ||
        own(expected.RetiredRecipientKeys, draft.PublicKey) ||
        entries(expected.KeyRecipients).some(([, item]) => item.PublicKey === draft.PublicKey)) reject();
    expected.KeyRecipients = { ...expected.KeyRecipients,
      [actor.DeviceID]: { ProfileID: actor.ProfileID, Kind: 'device', PublicKey: draft.PublicKey } };
  } else {
    if (draft.PublicKey !== '' || current?.ProfileID !== actor.ProfileID || current.Kind !== 'device') reject();
    delete expected.KeyRecipients[actor.DeviceID];
    expected.RetiredRecipientKeys = { ...expected.RetiredRecipientKeys, [current.PublicKey]: true };
  }
}

function replayDevice(expected, actor, draft) {
  const { DeviceID, PublicKey } = draft.DeviceChange;
  const device = own(expected.PolicyDevices, DeviceID);
  if (draft.Action === 'device.enroll') {
    if (device) reject();
    expected.PolicyDevices[DeviceID] = { ProfileID: actor.ProfileID, PublicKey };
    return;
  }
  if (device?.ProfileID !== actor.ProfileID || device.Revoked) reject();
  device.Revoked = true;
  if (own(expected.KeyRecipients, DeviceID)) {
    replayRecipient(expected, { ProfileID: actor.ProfileID, DeviceID }, { Action: 'recipient.revoke', PublicKey: '' });
  }
}

function replayDeviceBinding(expected, actor, change) {
  const { ID, DeviceBinding: binding } = change;
  const approver = own(expected.PolicyDevices, actor.DeviceID);
  const rebind = binding && Object.hasOwn(binding, 'RebindAt');
  if (ID !== actor.ProfileID || Object.keys(change).length !== 2 || !binding || Object.keys(binding).length !== (rebind ? 11 : 10) ||
      approver?.ProfileID !== ID || approver.Revoked || !own(expected.Members, ID)?.Active) reject();
  const { SigningKey, AgreementKey } = binding;
  if (!validAuthorityKey(SigningKey) || !validRecipientKey(AgreementKey) || SigningKey === AgreementKey) reject();
  const deviceId = createHash('sha256').update(Buffer.from(SigningKey, 'hex')).digest('hex');
  if (rebind) {
    const source = own(expected.DetachedPolicyDevices, deviceId);
    const device = own(expected.PolicyDevices, deviceId);
    const member = own(expected.Members, source);
    const existingPrimary = own(expected.ProfileBindings, source);
    if (!validCommittedProfileLinkTime(binding.RebindAt, binding.ExpiresAt) || !source || source === ID || source === expected.Owner ||
        device?.Revoked !== true || device.ProfileID !== source || device.PublicKey !== SigningKey || member?.ID !== source || member.Active ||
        (existingPrimary && existingPrimary !== ID) || profileGroupBanned(expected, source, binding.RebindAt) ||
        profileGroupBanned(expected, ID, binding.RebindAt)) reject();
    requireFreshPolicyDeviceKeys(expected, deviceId, SigningKey, AgreementKey, true);
    expected.ProfileBindings = { ...expected.ProfileBindings, [source]: ID };
    expected.ProfileDeviceOrigins = { ...expected.ProfileDeviceOrigins, [deviceId]: source };
    delete expected.DetachedPolicyDevices[deviceId];
    if (!Object.keys(expected.DetachedPolicyDevices).length) delete expected.DetachedPolicyDevices;
  } else {
    if (bannedAt(own(expected.MemberRemovals, ID), 0)) reject();
    requireFreshPolicyDeviceKeys(expected, deviceId, SigningKey, AgreementKey);
  }
  expected.PolicyDevices = { ...expected.PolicyDevices, [deviceId]: { ProfileID: ID, PublicKey: SigningKey } };
  expected.KeyRecipients = { ...expected.KeyRecipients, [deviceId]: { ProfileID: ID, Kind: 'device', PublicKey: AgreementKey } };
}

function requireFreshPolicyDeviceKeys(expected, deviceId, signingKey, agreementKey, detached = false) {
  if ((!detached && own(expected.PolicyDevices, deviceId)) || own(expected.KeyRecipients, deviceId) ||
      [signingKey, agreementKey].some(key => own(expected.RetiredRecipientKeys, key) === true ||
        own(expected.RetiredRecoverySigningKeys, key) === true)) reject();
  const used = key => key === signingKey || key === agreementKey;
  if (entries(expected.KeyRecipients).some(([, recipient]) => used(recipient.PublicKey)) ||
      entries(expected.PolicyDevices).some(([id, device]) => (!detached || id !== deviceId) && used(device.PublicKey)) ||
      entries(expected.RecoveryIdentities).some(([, recovery]) => used(recovery.SigningKey))) reject();
}

function replayInviteAdmission(before, expected, actor, change, automatic) {
  if (Object.keys(change).some(key => key !== 'ID' && key !== 'Admission')) reject();
  const { Admission, ID } = change;
  const claim = Admission?.Claim;
  const policy = asPolicy(before);
  if ((!automatic && (Admission?.ServerKey !== undefined ||
        explainGrant(policy, own(policy.members, actor.ProfileID), {}, 'invite.create', 0) !== 'allowed')) ||
      arrays(own(before.Roles, '@everyone')?.Grants).includes('server.administrator') ||
      !claim || !hexKey(Admission.CutoverDigest) || !hexKey(ID) || own(before.Members, ID)?.Active || own(before.ProfileBindings, ID)) reject();
  const profileKey = Buffer.from(claim.profilePublicKey, 'base64url');
  const deviceKey = Buffer.from(claim.devicePublicKey, 'base64url');
  const profileId = createHash('sha256').update(profileKey).digest('hex');
  const deviceId = createHash('sha256').update(deviceKey).digest('hex');
  const existing = own(before.PolicyDevices, deviceId);
  if (profileKey.length !== 32 || deviceKey.length !== 32 || profileId !== ID ||
      (existing && (!existing.Revoked || existing.ProfileID !== profileId))) reject();
  if (automatic) {
    if (!Admission.Issuance || actor.ProfileID !== profileId || actor.DeviceID !== deviceId) reject();
    const { Signature, MaxUses } = Admission.Issuance;
    const use = own(before.InvitationUses, claim.inviteId);
    const count = (use?.Count ?? 0) + 1;
    if (!Number.isSafeInteger(count) || (MaxUses !== 0 && count > MaxUses) || (use && use.IssueSignature !== Signature)) reject();
    expected.InvitationUses = { ...expected.InvitationUses, [claim.inviteId]: { IssueSignature: Signature, Count: count } };
  }
  if (bannedAt(own(before.MemberRemovals, ID), Admission.Issuance?.AcceptedAt ?? 0)) reject();
  if (expected.MemberRemovals) {
    delete expected.MemberRemovals[ID];
    if (!Object.keys(expected.MemberRemovals).length) delete expected.MemberRemovals;
  }
  retireMemberCredentials(expected, ID);
  for (const [detachedDeviceId, source] of entries(expected.DetachedPolicyDevices)) {
    if (source === ID) delete expected.DetachedPolicyDevices[detachedDeviceId];
  }
  if (expected.DetachedPolicyDevices && !Object.keys(expected.DetachedPolicyDevices).length) delete expected.DetachedPolicyDevices;
  expected.Members[ID] = { ID, Roles: null, Active: true, TimeoutUntil: 0 };
  expected.PolicyDevices[deviceId] = { ProfileID: ID, PublicKey: deviceKey.toString('hex') };
  replayRecipient(expected, { ProfileID: ID, DeviceID: deviceId }, { Action: 'recipient.enroll', PublicKey: claim.agreementKey });
}

function bannedAt(removal, now) {
  return removal?.Action === 'member.ban' && !removal.Lifted && (!removal.ExpiresAt || now < removal.ExpiresAt);
}

function profileGroupBanned(snapshot, profileId, at) {
  return bannedAt(own(snapshot.MemberRemovals, profileId), at) ||
    entries(snapshot.ProfileBindings).some(([source, primary]) =>
      primary === profileId && bannedAt(own(snapshot.MemberRemovals, source), at));
}

function validProfileBindings(snapshot) {
  if ([snapshot.ProfileBindings, snapshot.ProfileDeviceOrigins, snapshot.DetachedPolicyDevices].some(value =>
    value != null && (typeof value !== 'object' || Array.isArray(value)))) return false;
  for (const [source, primary] of entries(snapshot.ProfileBindings)) {
    const member = own(snapshot.Members, source);
    if (!hexKey(source) || !hexKey(primary) || source === primary || source === snapshot.Owner ||
        own(snapshot.ProfileBindings, primary) || own(snapshot.Members, primary)?.ID !== primary || member?.ID !== source ||
        member.Active || arrays(member.Roles).length) return false;
  }
  return entries(snapshot.ProfileDeviceOrigins).every(([deviceId, source]) => {
    const primary = own(snapshot.ProfileBindings, source);
    return hexKey(deviceId) && !!primary && own(snapshot.PolicyDevices, deviceId)?.ProfileID === primary;
  }) && entries(snapshot.DetachedPolicyDevices).every(([deviceId, origin]) => {
    const device = own(snapshot.PolicyDevices, deviceId);
    const member = own(snapshot.Members, origin);
    return hexKey(deviceId) && hexKey(origin) && device?.ProfileID === origin && device.Revoked === true && hexKey(device.PublicKey) &&
      createHash('sha256').update(Buffer.from(device.PublicKey, 'hex')).digest('hex') === deviceId &&
      !own(snapshot.ProfileDeviceOrigins, deviceId) && !own(snapshot.KeyRecipients, deviceId) && member?.ID === origin && !member.Active;
  });
}

function canApproveProfileLink(snapshot, actor, at) {
  const device = own(snapshot.PolicyDevices, actor.DeviceID);
  return own(snapshot.Members, actor.ProfileID)?.Active && device?.ProfileID === actor.ProfileID && !device.Revoked &&
    !own(snapshot.ProfileBindings, actor.ProfileID) && !profileGroupBanned(snapshot, actor.ProfileID, at);
}

function clearLinkedProfileGrants(snapshot, source) {
  const acls = [...Object.values(snapshot.Categories ?? {}), ...Object.values(snapshot.Channels ?? {}).map(channel => channel.ACL)];
  for (const acl of acls) {
    const overwrite = own(acl?.Profiles, source);
    if (!overwrite) continue;
    if (arrays(overwrite.Deny).length) overwrite.Allow = null;
    else delete acl.Profiles[source];
  }
  for (const [id, creator] of entries(snapshot.CategoryCreators)) {
    if (creator === source) delete snapshot.CategoryCreators[id];
  }
  if (snapshot.CategoryCreators && !Object.keys(snapshot.CategoryCreators).length) delete snapshot.CategoryCreators;
}

function replayProfileLink(snapshot, actor, change) {
  const { ID, ProfileLink: claim } = change;
  if (Object.keys(change).length !== 2 || ID !== actor.ProfileID || !claim || Object.keys(claim).length !== 9 ||
      actor.DeviceID !== claim.PrimaryDeviceID || !hexKey(claim.SecondaryProfileID) || !hexKey(claim.SecondaryDeviceID) ||
      !validCommittedProfileLinkTime(claim.At, claim.ExpiresAt)) reject();
  const secondary = { ProfileID: claim.SecondaryProfileID, DeviceID: claim.SecondaryDeviceID };
  const source = secondary.ProfileID;
  if (source === ID || source === snapshot.Owner || actor.DeviceID === secondary.DeviceID ||
      !canApproveProfileLink(snapshot, actor, claim.At) || !canApproveProfileLink(snapshot, secondary, claim.At)) reject();
  const bindings = { ...snapshot.ProfileBindings, [source]: ID };
  for (const [original, effective] of entries(snapshot.ProfileBindings)) {
    if (effective === source) bindings[original] = ID;
  }
  const origins = { ...snapshot.ProfileDeviceOrigins };
  for (const [deviceId, device] of entries(snapshot.PolicyDevices)) {
    if (device.ProfileID !== source) continue;
    origins[deviceId] ??= source;
    device.ProfileID = ID;
    const recipient = own(snapshot.KeyRecipients, deviceId);
    if (recipient?.Kind === 'device') recipient.ProfileID = ID;
  }
  snapshot.ProfileBindings = bindings;
  snapshot.ProfileDeviceOrigins = origins;
  retireRecoveryIdentity(snapshot, source);
  snapshot.Members[source] = { ID: source, Roles: null, Active: false, TimeoutUntil: snapshot.Members[source].TimeoutUntil };
  clearLinkedProfileGrants(snapshot, source);
}

function replayProfileUnlink(snapshot, actor, change) {
  const { ID, ProfileUnlink: claim } = change;
  const allowRebind = claim && Object.hasOwn(claim, 'GrantDeviceRebind');
  if (Object.keys(change).length !== 2 || !hexKey(ID) || ID === snapshot.Owner || !claim || Object.keys(claim).length !== (allowRebind ? 6 : 5) ||
      (allowRebind && claim.GrantDeviceRebind !== true) ||
      !validCommittedProfileLinkTime(claim.At, claim.ExpiresAt) || own(snapshot.ProfileBindings, ID) !== actor.ProfileID ||
      !canApproveProfileLink(snapshot, actor, claim.At)) reject();
  delete snapshot.ProfileBindings[ID];
  if (!Object.keys(snapshot.ProfileBindings).length) delete snapshot.ProfileBindings;
  for (const [deviceId, origin] of entries(snapshot.ProfileDeviceOrigins)) {
    if (origin !== ID) continue;
    const device = own(snapshot.PolicyDevices, deviceId);
    if (!device || device.ProfileID !== actor.ProfileID) reject();
    if (allowRebind && !device.Revoked) snapshot.DetachedPolicyDevices = { ...snapshot.DetachedPolicyDevices, [deviceId]: ID };
    device.ProfileID = ID;
    device.Revoked = true;
    delete snapshot.ProfileDeviceOrigins[deviceId];
    const recipient = own(snapshot.KeyRecipients, deviceId);
    if (recipient?.Kind === 'device') {
      delete snapshot.KeyRecipients[deviceId];
      snapshot.RetiredRecipientKeys = { ...snapshot.RetiredRecipientKeys, [recipient.PublicKey]: true };
    }
  }
  if (snapshot.ProfileDeviceOrigins && !Object.keys(snapshot.ProfileDeviceOrigins).length) delete snapshot.ProfileDeviceOrigins;
}

function replayMemberDeparture(before, expected, actor, draft, ownerId) {
  const { ID, Departure } = draft.ResourceChange;
  if (!hexKey(ID) || ID === ownerId || !Departure ||
      Object.keys(draft.ResourceChange).some(key => key !== 'ID' && key !== 'Departure')) reject();
  const { At = 0, ExpiresAt = 0, Reason = '', LiftInherited } = Departure;
  const action = draft.Action;
  if (LiftInherited !== undefined &&
      (LiftInherited !== true || action !== 'member.unban' || own(before.InheritedBanLifts, ID))) reject();
  if (action === 'member.leave') {
    if (ID !== actor.ProfileID || At !== 0 || ExpiresAt !== 0 || Reason !== '') reject();
  } else {
    const lift = action === 'member.unban';
    const policy = asPolicy(before);
    if (ID === actor.ProfileID || !Number.isSafeInteger(At) || At <= 0 || !Number.isSafeInteger(ExpiresAt) ||
        ExpiresAt !== 0 && (action !== 'member.ban' || ExpiresAt <= At || ExpiresAt > 8_640_000_000_000_000) ||
        typeof Reason !== 'string' || Reason !== Reason.trim() || /[\p{Cc}\p{Cs}]/u.test(Reason) ||
        [...Reason].length > 200 || !lift && !Reason ||
        explainAction(policy, own(policy.members, actor.ProfileID), own(policy.members, ID) ?? (LiftInherited ? { id: ID } : {}),
          {}, lift ? 'member.ban' : action, lift, At) !== 'allowed') reject();
    if (lift) {
      const ban = own(before.MemberRemovals, ID);
      if (!bannedAt(ban, At) && !LiftInherited) reject();
      if (bannedAt(ban, At)) expected.MemberRemovals[ID] = { ...ban, Lifted: true };
      if (LiftInherited) expected.InheritedBanLifts = { ...expected.InheritedBanLifts, [ID]: true };
      return;
    }
    expected.MemberRemovals = { ...expected.MemberRemovals, [ID]: {
      Action: action, Reason, ...(ExpiresAt && { ExpiresAt }),
    } };
  }
  retireMemberCredentials(expected, ID);
  expected.Members[ID] = { ID, Roles: null, Active: false, TimeoutUntil: 0 };
}

function retireRecoveryIdentity(expected, profileId) {
  const identity = own(expected.RecoveryIdentities, profileId);
  if (identity) {
    expected.RetiredRecoverySigningKeys = { ...expected.RetiredRecoverySigningKeys, [identity.SigningKey]: true };
    delete expected.RecoveryIdentities[profileId];
    if (!Object.keys(expected.RecoveryIdentities).length) delete expected.RecoveryIdentities;
  }
  for (const [id, recipient] of entries(expected.KeyRecipients)) {
    if (recipient.ProfileID !== profileId || recipient.Kind !== 'recovery') continue;
    expected.RetiredRecipientKeys = { ...expected.RetiredRecipientKeys, [recipient.PublicKey]: true };
    delete expected.KeyRecipients[id];
  }
  if (expected.RecoveryReady) delete expected.RecoveryReady[profileId];
}

function replayRecoveryEnrollment(expected, actor, change) {
  const { ID, Recovery } = change;
  const linked = Recovery && Object.hasOwn(Recovery, 'ScopeAuthority');
  if (ID !== actor.ProfileID || !Recovery || Object.keys(change).length !== 2 ||
      (linked && ID !== expected.Owner) || Object.keys(Recovery).length !== (linked ? 12 : 11)) reject();
  const { RecoveryID, SigningKey, AgreementKey, ExpiresAt, CutoverDigest, Nonce, ServerAgreementKey } = Recovery;
  const device = own(expected.PolicyDevices, actor.DeviceID);
  if (device?.ProfileID !== ID || device.Revoked || !own(expected.Members, ID)?.Active ||
      ![RecoveryID, SigningKey, CutoverDigest, Nonce].every(hexKey) || SigningKey === '0'.repeat(64) ||
      !validRecipientKey(AgreementKey) || !validRecipientKey(ServerAgreementKey) || AgreementKey === SigningKey ||
      !Number.isSafeInteger(ExpiresAt) || ExpiresAt <= 0 || ExpiresAt > 8_640_000_000_000_000 ||
      bannedAt(own(expected.MemberRemovals, ID), ExpiresAt) ||
      own(expected.RetiredRecipientKeys, AgreementKey) === true || own(expected.RetiredRecoverySigningKeys, SigningKey) === true ||
      own(expected.KeyRecipients, RecoveryID) || own(expected.PolicyDevices, RecoveryID)) reject();
  const used = key => key === AgreementKey || key === SigningKey;
  if (entries(expected.KeyRecipients).some(([, recipient]) => used(recipient.PublicKey)) ||
      entries(expected.PolicyDevices).some(([, entry]) => used(entry.PublicKey)) ||
      entries(expected.RecoveryIdentities).some(([, identity]) => used(identity.SigningKey))) reject();
  retireRecoveryIdentity(expected, ID);
  expected.RecoveryIdentities = { ...expected.RecoveryIdentities, [ID]: { ID: RecoveryID, SigningKey, AgreementKey } };
  expected.KeyRecipients = { ...expected.KeyRecipients, [RecoveryID]: { ProfileID: ID, Kind: 'recovery', PublicKey: AgreementKey } };
}

function replayRecoveryConfirmation(expected, actor, change) {
  const { ID, RecoveryConfirmation } = change;
  if (ID !== actor.ProfileID || !RecoveryConfirmation || Object.keys(change).length !== 2) reject();
  const { RecoveryID, ExpiresAt, Items } = RecoveryConfirmation;
  const identity = own(expected.RecoveryIdentities, ID);
  const device = own(expected.PolicyDevices, actor.DeviceID);
  const recipient = own(expected.KeyRecipients, RecoveryID);
  const policy = asPolicy(expected);
  const member = own(policy.members, ID);
  if (device?.ProfileID !== ID || device.Revoked || !member?.active ||
      !identity || identity.ID !== RecoveryID ||
      !isDeepStrictEqual(recipient, { ProfileID: ID, Kind: 'recovery', PublicKey: identity.AgreementKey }) ||
      !Number.isSafeInteger(ExpiresAt) || ExpiresAt <= 0 || ExpiresAt > 8_640_000_000_000_000 ||
      bannedAt(own(expected.MemberRemovals, ID), 0) || !Array.isArray(Items) || Items.length > 2000) reject();
  const scope = [];
  for (const channelId of Object.keys(expected.Channels ?? {}).sort()) {
    const channel = own(expected.Channels, channelId);
    if (channel.Kind !== 'text' || !(own(own(expected.Admissions, channelId), ID)?.FirstPosition > 0)) continue;
    const effective = channelScope(expected, channel);
    if (explainGrant(policy, member, effective, 'channel.view', 0) !== 'allowed') continue;
    if (explainGrant(policy, member, effective, 'history.full', 0) === 'allowed') scope.push(channelId + ':archive');
    scope.push(channelId + ':live');
  }
  if (!isDeepStrictEqual(Items.map(item => `${item?.ChannelID}:${item?.Purpose}`), scope)) reject();
  expected.RecoveryReady = { ...expected.RecoveryReady, [ID]: true };
}

function replayRecoveryDevice(expected, actor, change) {
  const { ID, RecoveryDevice } = change;
  const linked = RecoveryDevice && Object.hasOwn(RecoveryDevice, 'ScopeAuthority');
  if (ID !== actor.ProfileID || !RecoveryDevice || Object.keys(change).length !== 2 ||
      (linked && ID !== expected.Owner) || Object.keys(RecoveryDevice).length !== (linked ? 11 : 10)) reject();
  const { RecoveryID, ExpiresAt, SigningKey, AgreementKey } = RecoveryDevice;
  const identity = own(expected.RecoveryIdentities, ID);
  const recovery = own(expected.KeyRecipients, RecoveryID);
  const removal = own(expected.MemberRemovals, ID);
  if (!own(expected.Members, ID)?.Active || (removal?.Action === 'member.ban' && !removal.Lifted) ||
      !identity || identity.ID !== RecoveryID ||
      !isDeepStrictEqual(recovery, { ProfileID: ID, Kind: 'recovery', PublicKey: identity.AgreementKey }) ||
      (ID === expected.Owner && own(expected.RecoveryReady, ID) !== true) ||
      !validRecoveryEd25519Key(SigningKey) || !validRecipientKey(AgreementKey) || SigningKey === AgreementKey ||
      !Number.isSafeInteger(ExpiresAt) || ExpiresAt <= 0 || ExpiresAt > 8_640_000_000_000_000 ||
      createHash('sha256').update(Buffer.from(SigningKey, 'hex')).digest('hex') !== actor.DeviceID) reject();
  requireFreshPolicyDeviceKeys(expected, actor.DeviceID, SigningKey, AgreementKey);
  for (const [, device] of entries(expected.PolicyDevices)) {
    if (device.ProfileID === ID) device.Revoked = true;
  }
  for (const [id, recipient] of entries(expected.KeyRecipients)) {
    if (recipient.ProfileID !== ID || recipient.Kind !== 'device') continue;
    expected.RetiredRecipientKeys = { ...expected.RetiredRecipientKeys, [recipient.PublicKey]: true };
    delete expected.KeyRecipients[id];
  }
  expected.PolicyDevices = { ...expected.PolicyDevices, [actor.DeviceID]: { ProfileID: ID, PublicKey: SigningKey } };
  expected.KeyRecipients = { ...expected.KeyRecipients, [actor.DeviceID]: { ProfileID: ID, Kind: 'device', PublicKey: AgreementKey } };
}

function replayOwnershipTransfer(expected, actor, change) {
  const { ID, OwnershipTransfer: link } = change;
  const previousOwner = own(expected.Members, expected.Owner);
  const nextOwner = own(expected.Members, ID);
  const recovery = own(expected.RecoveryIdentities, ID);
  const recipient = own(expected.KeyRecipients, recovery?.ID);
  const actingDevice = own(expected.PolicyDevices, actor.DeviceID);
  if (Object.keys(change).length !== 2 || !hexKey(ID) || link?.targetProfileId !== ID ||
      ID === expected.Owner || actor.ProfileID !== expected.Owner || !previousOwner?.Active || !nextOwner?.Active ||
      bannedAt(own(expected.MemberRemovals, actor.ProfileID), 0) || bannedAt(own(expected.MemberRemovals, ID), 0) ||
      actingDevice?.ProfileID !== actor.ProfileID || actingDevice.Revoked ||
      own(expected.RecoveryReady, ID) !== true || !recovery || recovery.ID !== link.recoveryId ||
      recovery.SigningKey !== link.recoveryKey ||
      !isDeepStrictEqual(recipient, { ProfileID: ID, Kind: 'recovery', PublicKey: recovery.AgreementKey }) ||
      !hexKey(link.deviceKey)) reject();
  const acceptingId = createHash('sha256').update(Buffer.from(link.deviceKey, 'hex')).digest('hex');
  const accepting = own(expected.PolicyDevices, acceptingId);
  if (accepting?.ProfileID !== ID || accepting.Revoked || accepting.PublicKey !== link.deviceKey ||
      !matchesOwnerTransferCandidates(expected, ID, link.transfer)) reject();
  expected.Owner = ID;
}

function replayScopeDeviceHandover(expected, actor, draft) {
  const change = draft.ResourceChange;
  const { ID, ScopeDeviceHandover: claim } = change;
  const link = claim?.Link;
  const current = own(expected.PolicyDevices, actor.DeviceID);
  const recovery = own(expected.RecoveryIdentities, actor.ProfileID);
  if (Object.keys(change).length !== 2 || !claim || Object.keys(claim).length !== 4 ||
      ID !== actor.ProfileID || ID !== expected.Owner || !own(expected.Members, ID)?.Active ||
      current?.ProfileID !== ID || current.Revoked || !hexKey(claim.CutoverDigest) ||
      link?.action !== 'scope.device' || link.sourceDeviceId !== actor.DeviceID ||
      link.policyHead !== draft.PreviousDigest || link.revision !== draft.Revision || link.operationId !== draft.OperationID ||
      !validCommittedProfileLinkTime(claim.At, link.expiresAt) || !validAuthorityKey(link.deviceKey) ||
      link.recoveryId !== (recovery?.ID ?? '') || link.recoveryKey !== (recovery?.SigningKey ?? '')) reject();
  const successorId = createHash('sha256').update(Buffer.from(link.deviceKey, 'hex')).digest('hex');
  const successor = own(expected.PolicyDevices, successorId);
  if (successorId === actor.DeviceID || successor?.ProfileID !== ID || successor.Revoked || successor.PublicKey !== link.deviceKey) reject();
}

function retireMemberCredentials(expected, profileId) {
  for (const [, entry] of entries(expected.PolicyDevices)) {
    if (entry.ProfileID === profileId) entry.Revoked = true;
  }
  for (const [id, entry] of entries(expected.KeyRecipients)) {
    if (entry.ProfileID !== profileId) continue;
    delete expected.KeyRecipients[id];
    expected.RetiredRecipientKeys = { ...expected.RetiredRecipientKeys, [entry.PublicKey]: true };
  }
  retireRecoveryIdentity(expected, profileId);
}

function inviteIssuanceSigningKey(snapshot, issuer) {
  const device = own(snapshot?.PolicyDevices, issuer.DeviceID);
  if (!device || device.Revoked || device.ProfileID !== issuer.ProfileID) return undefined;
  const policy = asPolicy(snapshot);
  const subject = own(policy.members, issuer.ProfileID);
  if (!subject || explainGrant(policy, subject, {}, 'invite.create', 0) !== 'allowed') return undefined;
  return device.PublicKey;
}

function replayPolicyTransition(previous, next, actor, draft, ownerId, admissionFloor) {
  if (!next || !own(next.Members, next.Owner)?.Active || !validProfileBindings(next)) reject();
  if (!previous) {
    const hasImportedBindings = next.ImportedProfileBindings === true;
    if (next.Owner !== ownerId || draft.Action !== 'policy.anchor' || draft.PublicKey !== '' || draft.RoleUpdate !== null ||
        entries(next.InvitationUses).length || entries(next.MemberRemovals).length || entries(next.InheritedBanLifts).length ||
        entries(next.DetachedPolicyDevices).length ||
        (Object.hasOwn(next, 'ImportedProfileBindings') && !hasImportedBindings) ||
        (!hasImportedBindings && (entries(next.ProfileBindings).length || entries(next.ProfileDeviceOrigins).length))) reject();
    for (const [id, device] of entries(next.PolicyDevices)) {
      if (!hexKey(device?.PublicKey) || device.Revoked ||
          createHash('sha256').update(Buffer.from(device.PublicKey, 'hex')).digest('hex') !== id ||
          own(next.Members, device.ProfileID)?.Active !== true) reject();
    }
    for (const [id, recipient] of entries(next.KeyRecipients)) {
      if (recipient?.Kind === 'device' && own(next.PolicyDevices, id)?.ProfileID !== recipient.ProfileID) reject();
    }
    const expected = { ...next };
    replayAdmissions({}, expected, next);
    if (!isDeepStrictEqual(expected.Admissions, next.Admissions)) reject();
    return advanceAdmissionFloor(undefined, next, admissionFloor);
  }
  if (draft.Action !== 'member.redeem' && own(previous.Members, actor.ProfileID)?.Active !== true) reject();
  const expected = structuredClone(previous);
  if (draft.Action === 'roles.update') {
    if (draft.PublicKey !== '') reject();
    replayRoles(previous, expected, actor.ProfileID, draft.RoleUpdate);
    replayAdmissions(previous, expected, next);
  } else if (draft.Action === scopedRoleEditAction && draft.ResourceChange?.RolesEdit && draft.RoleUpdate === null && draft.PublicKey === '') {
    replayRoles(previous, expected, actor.ProfileID, scopedRoleUpdate(previous, actor.ProfileID, draft.ResourceChange.RolesEdit.Change));
    replayAdmissions(previous, expected, next);
  } else if (['recipient.enroll', 'recipient.revoke'].includes(draft.Action) && draft.RoleUpdate === null) {
    replayRecipient(expected, actor, draft);
  } else if (['device.enroll', 'device.revoke'].includes(draft.Action) && draft.RoleUpdate === null && draft.PublicKey === '') {
    replayDevice(expected, actor, draft);
  } else if (draft.Action === 'device.bind' && draft.ResourceChange && draft.RoleUpdate === null && draft.PublicKey === '') {
    replayDeviceBinding(expected, actor, draft.ResourceChange);
  } else if (['profile.link', 'profile.unlink'].includes(draft.Action) && draft.ResourceChange && draft.RoleUpdate === null && draft.PublicKey === '') {
    if (draft.Action === 'profile.link') replayProfileLink(expected, actor, draft.ResourceChange);
    else replayProfileUnlink(expected, actor, draft.ResourceChange);
    replayAdmissions(previous, expected, next);
  } else if (draft.Action === 'recovery.enroll' && draft.ResourceChange && draft.RoleUpdate === null && draft.PublicKey === '') {
    replayRecoveryEnrollment(expected, actor, draft.ResourceChange);
  } else if (draft.Action === 'recovery.confirm' && draft.ResourceChange && draft.RoleUpdate === null && draft.PublicKey === '') {
    replayRecoveryConfirmation(expected, actor, draft.ResourceChange);
  } else if (draft.Action === 'recovery.device' && draft.ResourceChange && draft.RoleUpdate === null && draft.PublicKey === '') {
    replayRecoveryDevice(expected, actor, draft.ResourceChange);
  } else if (draft.Action === 'owner.transfer' && draft.ResourceChange && draft.RoleUpdate === null) {
    replayOwnershipTransfer(expected, actor, draft.ResourceChange);
    replayAdmissions(previous, expected, next);
  } else if (draft.Action === 'scope.device' && draft.ResourceChange && draft.RoleUpdate === null && draft.PublicKey === '') {
    replayScopeDeviceHandover(expected, actor, draft);
  } else if (draft.Action === 'channel.settings.scoped' && draft.ResourceChange && draft.RoleUpdate === null && draft.PublicKey === '') {
    const { ID, Settings, SettingsEdit } = draft.ResourceChange;
    const channel = own(previous.Channels, ID);
    const device = own(previous.PolicyDevices, actor.DeviceID);
    if (!SettingsEdit || Object.keys(draft.ResourceChange).length !== 3 || !channel || !validSettings(channel.Kind, Settings) ||
        own(previous.ProfileBindings, actor.ProfileID) || device?.ProfileID !== actor.ProfileID || device.Revoked) reject();
    const policy = asPolicy(previous);
    const member = own(policy.members, actor.ProfileID);
    const scope = channelScope(previous, channel);
    if (!['channel.view', 'channel.edit'].every(permission => explainGrant(policy, member, scope, permission, 0) === 'allowed')) reject();
    expected.Channels[ID].Settings = Settings;
  } else if (draft.Action === scopedACLRoleEditAction && draft.ResourceChange && draft.RoleUpdate === null && draft.PublicKey === '') {
    const { ID, ACL, ACLRoleEdit } = draft.ResourceChange;
    const channel = own(previous.Channels, ID);
    const device = own(previous.PolicyDevices, actor.DeviceID);
    if (!ACLRoleEdit || Object.keys(draft.ResourceChange).length !== 3 || !channel || !ACL ||
        Object.keys(ACL).length !== 2 || !ACL.Roles || ACL.Profiles !== null ||
        own(previous.ProfileBindings, actor.ProfileID) || device?.ProfileID !== actor.ProfileID || device.Revoked ||
        !validACL(previous, ACL, channel.Kind)) reject();
    for (const rule of Object.values(ACL.Roles)) {
      const allow = arrays(rule.Allow), deny = arrays(rule.Deny);
      if (allow.length + deny.length === 0 || new Set(allow).size !== allow.length || new Set(deny).size !== deny.length) reject();
    }
    const effective = channel.Synchronized ? own(previous.Categories, channel.CategoryID) : channel.ACL;
    const localized = localizeACL(effective ?? emptyACL(), channel.Kind);
    if (sameRoleOverrides(localized.Roles, ACL.Roles)) reject();
    replayResource(previous, expected, actor.ProfileID, { ...draft, Action: 'channel.acl.update',
      ResourceChange: { ID, ACL: { Roles: ACL.Roles, Profiles: localized.Profiles } } });
    replayAdmissions(previous, expected, next);
  } else if (draft.Action === scopedACLPersonalEditAction && draft.ResourceChange && draft.RoleUpdate === null && draft.PublicKey === '') {
    replayScopedPersonalACL(previous, expected, actor, draft);
    replayAdmissions(previous, expected, next);
  } else if (['member.admit', 'member.redeem'].includes(draft.Action) && draft.ResourceChange && draft.RoleUpdate === null && draft.PublicKey === '') {
    replayInviteAdmission(previous, expected, actor, draft.ResourceChange, draft.Action === 'member.redeem');
    replayAdmissions(previous, expected, next);
  } else if (['member.leave', 'member.kick', 'member.ban', 'member.unban'].includes(draft.Action) &&
      draft.ResourceChange && draft.RoleUpdate === null && draft.PublicKey === '') {
    replayMemberDeparture(previous, expected, actor, draft, previous.Owner);
    replayAdmissions(previous, expected, next);
  } else if (draft.ResourceChange && draft.RoleUpdate === null && draft.PublicKey === '') {
    if (draft.ResourceChange.Admission !== undefined || draft.ResourceChange.Departure !== undefined ||
        draft.ResourceChange.Recovery !== undefined || draft.ResourceChange.RecoveryConfirmation !== undefined ||
        draft.ResourceChange.RecoveryDevice !== undefined || draft.ResourceChange.OwnershipTransfer !== undefined ||
        draft.ResourceChange.DeviceBinding !== undefined || draft.ResourceChange.ProfileLink !== undefined ||
        draft.ResourceChange.ProfileUnlink !== undefined || draft.ResourceChange.ScopeDeviceHandover !== undefined ||
        draft.ResourceChange.SettingsEdit !== undefined || draft.ResourceChange.ACLRoleEdit !== undefined ||
        draft.ResourceChange.ACLPersonalEdit !== undefined) reject();
    replayResource(previous, expected, actor.ProfileID, draft);
    replayAdmissions(previous, expected, next);
  } else {
    reject();
  }
  if (!isDeepStrictEqual(expected, next)) reject();
  return advanceAdmissionFloor(previous, next, admissionFloor);
}

function epochRecipients(snapshot, channelId, purpose) {
  const channel = own(snapshot.Channels, channelId);
  if (channel?.Kind !== 'text' || !['live', 'archive'].includes(purpose)) return {};
  const policy = asPolicy(snapshot);
  const scope = channelScope(snapshot, channel);
  const profiles = new Set(Object.entries(policy.members)
    .filter(([, member]) => explainAction(policy, member, {}, scope, 'channel.view', false, 0) === 'allowed' &&
      (purpose === 'live' || explainAction(policy, member, {}, scope, 'history.full', false, 0) === 'allowed'))
    .map(([id]) => id));
  return Object.fromEntries(entries(snapshot.KeyRecipients).filter(([, recipient]) => profiles.has(recipient.ProfileID)));
}

function epochSigner(snapshot, recipients, profileId, deviceId) {
  const device = own(snapshot.PolicyDevices, deviceId);
  const recipient = own(recipients, deviceId);
  if (!device || device.Revoked || device.ProfileID !== profileId ||
      recipient?.Kind !== 'device' || recipient.ProfileID !== profileId) return undefined;
  return { profileId, deviceId, key: device.PublicKey };
}

function textRevisionAudience(snapshot, channelId, position) {
  const live = epochRecipients(snapshot, channelId, 'live');
  const archive = epochRecipients(snapshot, channelId, 'archive');
  const limited = Object.keys(live).sort().filter(id => {
    const first = own(own(snapshot.Admissions, channelId), live[id].ProfileID)?.FirstPosition;
    return !Object.hasOwn(archive, id) && Number.isSafeInteger(first) && first > 0 && first <= position;
  }).map(id => ({ id, publicKey: live[id].PublicKey }));
  return { live, archive, limited };
}

function canAuthorTextRevision(snapshot, channelId, profileId) {
  const channel = own(snapshot.Channels, channelId);
  return channel?.Kind === 'text' && canSendText(asPolicy(snapshot), channelScope(snapshot, channel), profileId);
}

function canSendText(policy, scope, profileId) {
  const author = own(policy.members, profileId);
  return author !== undefined && explainAction(policy, { ...author, timeoutUntil: 0 }, {}, scope, 'message.send', false, 0) === 'allowed';
}

function textChannelKeyProjection(snapshot, channelId) {
  if (own(snapshot.Channels, channelId)?.Kind !== 'text') reject();
  const live = epochRecipients(snapshot, channelId, 'live');
  const archive = epochRecipients(snapshot, channelId, 'archive');
  const recipients = Object.keys(live).sort().map(id => {
    const { ProfileID: profileId, Kind: kind, PublicKey: publicKey } = live[id];
    const signer = kind === 'device' ? epochSigner(snapshot, live, profileId, id) : undefined;
    if (kind === 'device' && !signer) reject();
    return { id, profileId, kind, publicKey, signingKey: signer?.key ?? '', archive: Object.hasOwn(archive, id) };
  });
  return { kind: 'text', recipients };
}

function textChannelKeyDigest(snapshot, channelId, seed, version) {
  const projection = textChannelKeyProjection(snapshot, channelId);
  if (seed === undefined) return textChannelKeyProjectionDigest(projection);
  const revisions = version >= textRevisionProjectionVersion;
  const policy = revisions ? asPolicy(snapshot) : undefined;
  const scope = revisions ? channelScope(snapshot, own(snapshot.Channels, channelId)) : undefined;
  const statements = projection.recipients.map(recipient => ({
    ...recipient, firstPosition: own(own(snapshot.Admissions, channelId), recipient.profileId)?.FirstPosition,
    ...(revisions && { canSend: recipient.kind === 'device' && canSendText(policy, scope, recipient.profileId) }),
  }));
  const roleViewDenies = version >= textRoleViewDenyProjectionVersion
    ? roleViewDenyCommitment(snapshot, channelId, seed, policy, scope) : undefined;
  const newcomer = version >= textNewcomerAdmissionProjectionVersion ? textNewcomerDigest(policy, scope, channelId, seed) : undefined;
  return textRecipientCommitment(channelId, statements, seed, version, roleViewDenies, newcomer);
}

function textNewcomerDigest(policy, scope, channelId, seed) {
  const subject = { id: 'newcomer', roles: [], active: true };
  const effective = scope.synchronized ? scope.category : scope.local;
  const newcomerScope = { kind: scope.kind, local: { roles: effective.roles, profiles: {} } };
  const newcomerPolicy = { ...policy, owner: '' };
  const allowed = permission => explainGrant(newcomerPolicy, subject, newcomerScope, permission, 0) === 'allowed';
  const visible = allowed('channel.view');
  return textNewcomerAdmissionDigest({ salt: textRecipientBlind(Buffer.from(seed, 'hex'), Buffer.from(channelId), 22, '').toString('hex'),
    visible, archive: visible && allowed('history.full'), canSend: visible && allowed('message.send') });
}

function textChannelKeyDigests(snapshot, seed, version) {
  return Object.fromEntries(entries(snapshot.Channels)
    .filter(([, channel]) => channel.Kind === 'text')
    .map(([id]) => [id, textChannelKeyDigest(snapshot, id, seed, version)]));
}

function channelPolicyProjectionDigest(snapshot, channelId, seed, version, normalizedPolicy) {
  const channel = own(snapshot.Channels, channelId);
  let recipients = channel.Kind === 'text' ? textChannelKeyDigest(snapshot, channelId, seed, version) : '0'.repeat(64);
  if (!(version >= textOrderAuthorityVersion)) return recipients;
  const policy = normalizedPolicy ?? asPolicy(snapshot);
  const scope = channelScope(snapshot, channel);
  const editorsFor = permission => entries(snapshot.PolicyDevices).flatMap(([id, device]) => {
    const member = own(policy.members, device.ProfileID);
    return !device.Revoked && member && explainGrant(policy, member, scope, permission, 0) === 'allowed'
      ? [{ id, profileId: device.ProfileID, key: device.PublicKey }] : [];
  });
  if (channel.Kind === 'voice' && version >= voiceRecipientProjectionVersion) {
    const devices = entries(snapshot.KeyRecipients).flatMap(([deviceId, recipient]) => {
      if (recipient.Kind !== 'device') return [];
      const profileId = recipient.ProfileID;
      const member = own(policy.members, profileId);
      const restriction = own(own(snapshot.VoiceRestrictions, channelId), profileId);
      const signer = epochSigner(snapshot, snapshot.KeyRecipients, profileId, deviceId);
      return signer && member && !restriction?.Deafened && !own(own(snapshot.VoiceRestrictions, '*'), profileId)?.Deafened &&
        explainGrant(policy, { ...member, timeoutUntil: 0 }, scope, 'voice.connect', 0) === 'allowed'
        ? [{ deviceId, profileId, publicKey: recipient.PublicKey, signingKey: signer.key }] : [];
    });
    recipients = voiceRecipientCommitment(channelId, devices, seed);
  }
  let aclRoot;
  const acl = channel.Synchronized ? own(snapshot.Categories, channel.CategoryID) : channel.ACL;
  if (version >= channelACLProjectionVersion) {
    aclRoot = channelACLCommitment(channelId, channel.Kind, channel.Synchronized === true, acl?.Roles,
      editorsFor('channel.access.edit'), seed);
  }
  const authority = channelOrderCommitment(channelId, channel.Kind, channel.CategoryID ?? '', editorsFor('channel.edit'), seed, version,
    channel.Settings ?? null, aclRoot);
  const channelDigest = channelPolicyCombinedDigest(recipients, authority);
  if (version < profileRoleAuthorityProjectionVersion) return channelDigest;
  return scopedChannelRoleProjectionDigest(channelDigest, scopedChannelRuleDigest(channelId, channel.Kind, acl, seed));
}

function channelPolicyProjectionDigests(snapshot, seed, version) {
  if (!(version >= textOrderAuthorityVersion)) return textChannelKeyDigests(snapshot, seed, version);
  const policy = asPolicy(snapshot);
  const channels = Object.fromEntries(entries(snapshot.Channels).map(([id]) => [id, channelPolicyProjectionDigest(snapshot, id, seed, version, policy)]));
  if (version >= profileRankProjectionVersion) channels[profileRankProjection] = profileRankRoot(snapshot, seed, version);
  if (version >= textNewcomerAdmissionProjectionVersion) {
    const issuers = [];
    for (const [deviceId, device] of entries(snapshot.PolicyDevices)) {
      const subject = own(policy.members, device.ProfileID);
      if (!device.Revoked && !own(snapshot.ProfileBindings, device.ProfileID) && subject &&
          explainGrant(policy, subject, {}, 'invite.create', 0) === 'allowed') {
        issuers.push({ deviceId, profileId: device.ProfileID, signingKey: device.PublicKey });
      }
    }
    const inviteDigest = inviteAdmissionDigest(inviteIssuerRoot(issuers, seed), inviteCredentialRoot(snapshot));
    const catalogue = version >= profileRoleAuthorityProjectionVersion ? scopedRoleCatalogueRoot(snapshot, seed) : undefined;
    const rosters = catalogue && scopedRoleRosterRoot(seed, entries(snapshot.Channels)
      .filter(([, channel]) => channel.Kind === 'text').map(([id, channel]) => {
        const scope = channelScope(snapshot, channel);
        return [id, entries(policy.members).filter(([profileId, member]) => !own(snapshot.ProfileBindings, profileId) &&
          explainGrant(policy, member, scope, 'channel.view', 0) === 'allowed').map(([profileId]) => profileId)];
      }));
    channels[profileRankProjection] = auxiliaryPolicyDigest(channels[profileRankProjection], inviteDigest, catalogue, rosters);
  }
  return channels;
}

function voiceRosterSigners(snapshot, channelId, roster, now) {
  const channel = own(snapshot.Channels, channelId);
  // The checkpoint verifies the anchor. The signed snapshot excludes the
  // server's mutable PolicyAnchored flag.
  if (channel?.Kind !== 'voice') reject();
  const policy = asPolicy(snapshot);
  const scope = channelScope(snapshot, channel);
  return new Map(roster.map(({ sessionId, profileId, deviceId, publicKey }) => {
    const recipient = own(snapshot.KeyRecipients, deviceId);
    const signer = epochSigner(snapshot, { [deviceId]: recipient }, profileId, deviceId);
    const restriction = own(own(snapshot.VoiceRestrictions, channelId), profileId);
    if (!signer || recipient.PublicKey !== publicKey || restriction?.Deafened || own(own(snapshot.VoiceRestrictions, '*'), profileId)?.Deafened ||
        explainAction(policy, own(policy.members, profileId) ?? {}, {}, scope, 'voice.connect', false, now) !== 'allowed') reject();
    return [sessionId, { ...signer, sessionId }];
  }));
}

function verifyMigrationInitialSnapshot(policyDraft, snapshot, deviceId, publicKey, preserveChannelOrder, runtimeRecovery = false) {
  if (preserveChannelOrder !== undefined && preserveChannelOrder !== true) reject();
  const source = policyDraft.state;
  if (!validProfileBindings(source) || (source.ImportedProfileBindings !== true &&
      (source.ImportedProfileBindings !== undefined || entries(source.ProfileBindings).length || entries(source.ProfileDeviceOrigins).length))) reject();
  const expected = structuredClone(source);
  if (preserveChannelOrder) {
    const ids = policyResourceOrder(undefined, source.Channels);
    const positions = new Map(ids.map(id => [id, own(policyDraft.channelMetadata, id)?.position]));
    if (![...positions.values()].every(Number.isSafeInteger)) reject();
    ids.sort((left, right) => {
      const first = positions.get(left), second = positions.get(right);
      return first < second ? -1 : first > second ? 1 : 0;
    });
    if (ids.length) expected.ChannelOrder = ids;
  }
  const policy = asPolicy(expected);
  expected.KeyRecipients = { [deviceId]: { ProfileID: source.Owner, Kind: 'device', PublicKey: publicKey } };
  if (runtimeRecovery) {
    const { recoveryId, signingKey, agreementKey } = policyDraft.ownerRecovery ?? {};
    if (!hexKey(recoveryId) || !validRecoveryEd25519Key(signingKey) || !hexKey(agreementKey) ||
        recoveryId === deviceId || agreementKey === publicKey) reject();
    expected.KeyRecipients[recoveryId] = { ProfileID: source.Owner, Kind: 'recovery', PublicKey: agreementKey };
    expected.RecoveryIdentities = { [source.Owner]: { ID: recoveryId, SigningKey: signingKey, AgreementKey: agreementKey } };
    expected.RecoveryReady = { [source.Owner]: true };
  }
  expected.Admissions = Object.fromEntries(entries(expected.Channels).filter(([, channel]) => channel.Kind === 'text').map(([id, channel]) => {
    const scope = channelScope(expected, channel);
    return [id, Object.fromEntries(entries(policy.members)
      .filter(([, member]) => explainAction(policy, member, {}, scope, 'channel.view', false, 0) === 'allowed')
      .map(([profile]) => [profile, { FirstPosition: channel.NextPosition }]))];
  }));
  for (const channel of Object.values(expected.Channels)) channel.NextPosition = 0;
  if (!isDeepStrictEqual(expected, snapshot)) reject();
}

module.exports = {
  canInspectFullPolicy,
  replayPolicyTransition, epochRecipients, epochSigner, textChannelKeyProjection, textChannelKeyDigest, textChannelKeyDigests,
  channelPolicyProjectionDigest, channelPolicyProjectionDigests,
  inviteIssuanceSigningKey, editableChannelACLProfiles,
  voiceRosterSigners, verifyMigrationInitialSnapshot, channelGrantSummary, roleViewProjection, channelAccessDelta, policyResourceOrder, textRevisionAudience, canAuthorTextRevision,
};
