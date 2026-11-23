import catalog from '../apps/server/internal/access/catalog.json' with { type: 'json' };

const everyone = '@everyone';
const administrator = 'server.administrator';
const view = 'channel.view';
const permissions = new Map(catalog.permissions.map(entry => [entry.id, entry]));

function fitsScope(required, kind) {
  switch (required) {
    case 'server': return kind === '';
    case 'resource': return ['category', 'text', 'voice'].includes(kind);
    case 'category': return kind === '' || kind === 'category';
    case 'channel': return kind === 'text' || kind === 'voice';
    case 'text':
    case 'voice': return required === kind;
    default: return false;
  }
}

function ownEntry(entries, id) {
  return entries && Object.hasOwn(entries, id) ? entries[id] : undefined;
}

function baseGrant(policy, subject, permission) {
  return [everyone, ...(subject.roles ?? [])].some(role =>
    ownEntry(policy.roles, role)?.grants?.includes(permission));
}

function overwrite(entry, permission, granted) {
  return entry?.allow?.includes(permission) || (granted && !entry?.deny?.includes(permission));
}

function roleSources(policy, roleIds, permission, kind) {
  return [everyone, ...roleIds].filter(roleId => ownEntry(policy.roles, roleId)?.grants?.includes(permission))
    .map(roleId => ({ kind, roleId, effect: 'allow' }));
}

function grant(policy, subject, scope, permission, evidence) {
  const roleIds = subject.roles ?? [];
  if (policy.owner === subject.id) {
    if (evidence) evidence.sources = [{ kind: 'owner', effect: 'allow' }];
    return true;
  }
  if (baseGrant(policy, subject, administrator)) {
    if (evidence) evidence.sources = roleSources(policy, roleIds, administrator, 'administrator');
    return true;
  }
  const base = baseGrant(policy, subject, permission);
  const acl = scope.synchronized ? scope.category : scope.local;
  if (!acl) {
    if (evidence) evidence.sources = roleSources(policy, roleIds, permission, 'base');
    return base;
  }
  const commonOverride = ownEntry(acl.roles, everyone);
  const common = overwrite(commonOverride, permission, base);
  const overrides = roleIds.filter(role => role !== everyone);
  const roleOverrides = overrides.map(role => ownEntry(acl.roles, role));
  const deny = roleOverrides.some(entry => entry?.deny?.includes(permission));
  const allow = roleOverrides.some(entry => entry?.allow?.includes(permission));
  const personal = ownEntry(acl.profiles, subject.id);
  if (evidence) {
    const kind = scope.synchronized || scope.kind === 'category' ? 'category' : 'channel';
    const effectOf = entry => entry?.allow?.includes(permission) ? 'allow' : entry?.deny?.includes(permission) ? 'deny' : undefined;
    const personalEffect = effectOf(personal);
    const commonEffect = effectOf(commonOverride);
    if (personalEffect) evidence.sources = [{ kind, effect: personalEffect }];
    else if (allow || deny) {
      const effect = allow ? 'allow' : 'deny';
      evidence.sources = overrides.filter((_, index) => roleOverrides[index]?.[effect]?.includes(permission))
        .map(roleId => ({ kind, roleId, effect }));
    } else if (commonEffect) evidence.sources = [{ kind, roleId: everyone, effect: commonEffect }];
    else evidence.sources = roleSources(policy, roleIds, permission, 'base');
  }
  return overwrite(personal, permission, allow || (common && !deny));
}

function checkGrant(policy, subject, scope, permission, now, evidence) {
  if (!subject.active || !subject.id) return 'inactive';
  const entry = permissions.get(permission);
  if (!entry) return 'invalid_action';
  const kind = scope.kind ?? '';
  if (!fitsScope(entry.scope, kind)) return 'wrong_scope';
  if (!kind) scope = {};
  if ((kind === 'text' || kind === 'voice') && !grant(policy, subject, scope, view, evidence)) {
    if (evidence) evidence.permission = view;
    return 'channel_restricted';
  }
  if (!grant(policy, subject, scope, permission, evidence)) return 'missing_grant';
  if (entry.blockedByTimeout && subject.timeoutUntil > now) return 'timed_out';
  for (const dependency of entry.requires ?? []) {
    const basis = evidence && { permission: dependency, sources: [] };
    const result = checkGrant(policy, subject, scope, dependency, now, basis);
    if (result !== 'allowed') {
      if (evidence) Object.assign(evidence, basis);
      return result;
    }
  }
  return 'allowed';
}

export function explainGrant(policy, subject, scope, permission, now) {
  return checkGrant(policy, subject, scope, permission, now);
}

// Explain the rule that determined the result without changing authorization.
export function explainGrantEvidence(policy, subject, scope, permission, now) {
  const evidence = { permission, sources: [] };
  const decision = checkGrant(policy, subject, scope, permission, now, evidence);
  return { decision, ...evidence };
}

export function rank(policy, subject) {
  if (policy.owner === subject.id) return policy.order.length + 1;
  return Math.max(0, ...(subject.roles ?? []).map(role => policy.order.indexOf(role) + 1));
}

// Client-side explanation for verified policy snapshots. The server authorizes every operation.
export function explainAction(policy, actor, target, scope, permission, lifting, now) {
  const result = checkGrant(policy, actor, scope, permission, now);
  if (result !== 'allowed') return result;
  const entry = permissions.get(permission);
  if (lifting) return entry.lift && target.id ? 'allowed' : 'invalid_action';
  const actionRank = permission === 'channel.access.edit' && target.id ? 'critical' : entry.rank;
  if (actionRank === 'critical' || actionRank === 'important') {
    if (!target.active || !target.id) return 'inactive';
    const actorRank = rank(policy, actor);
    const targetRank = rank(policy, target);
    if (actorRank < targetRank || (actionRank === 'critical' && actorRank === targetRank)) {
      return 'hierarchy_denied';
    }
  }
  return 'allowed';
}

function sameOrder(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function sameSet(a, b) {
  return a.size === b.size && [...a].every(value => b.has(value));
}
function highestRole(policy, member) {
  return policy.order.findLast(role => member.roles.includes(role)) ?? everyone;
}

function validRolePresentation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const text = (input, limit) => typeof input === 'string' && [...input].length <= limit &&
    !/^(?:\p{White_Space})|(?:\p{White_Space})$/u.test(input) && !/\p{Cc}|\p{Cs}/u.test(input);
  return Object.keys(value).every(key => ['Name', 'Color', 'Icon', 'Hoist', 'Mentionable'].includes(key)) &&
    text(value.Name, 64) && value.Name.length > 0 &&
    (value.Color === undefined || value.Color === '' || /^#[a-f0-9]{6}$/.test(value.Color)) &&
    (value.Icon === undefined || text(value.Icon, 32)) &&
    (value.Hoist === undefined || typeof value.Hoist === 'boolean') &&
    (value.Mentionable === undefined || typeof value.Mentionable === 'boolean');
}

function sameRolePresentation(left, right) {
  return left?.Name === right?.Name && (left?.Color ?? '') === (right?.Color ?? '') &&
    (left?.Icon ?? '') === (right?.Icon ?? '') && !!left?.Hoist === !!right?.Hoist &&
    !!left?.Mentionable === !!right?.Mentionable;
}
function validRoleSnapshot(policy) {
  if (!ownEntry(policy.members, policy.owner)?.active || Object.keys(policy.roles).length !== policy.order.length + 1) return false;
  const ordered = new Set([everyone, ...policy.order]);
  if (ordered.size !== policy.order.length + 1 || ordered.has('')) return false;
  if (!Object.entries(policy.roles).every(([id, role]) => ordered.has(id) &&
      role.grants.every(permission => permissions.has(permission)))) return false;
  if (!Object.entries(policy.rolePresentation ?? {}).every(([id, value]) =>
    ordered.has(id) && validRolePresentation(value))) return false;
  return Object.entries(policy.members).every(([id, subject]) => id === subject.id &&
    subject.roles.every(role => role !== everyone && Boolean(ownEntry(policy.roles, role))));
}

function mayEditDefinitions(before, after, actor, admin) {
  const owner = before.owner === actor.id;
  if (!owner) {
    const anchor = highestRole(before, actor);
    if (anchor !== everyone && !after.order.includes(anchor)) return false;
    const suffix = policy => anchor === everyone ? policy.order : policy.order.slice(policy.order.indexOf(anchor));
    if (!sameOrder(suffix(before), suffix(after))) return false;
  }
  let changed = !sameOrder(before.order, after.order);
  for (const id of new Set([...Object.keys(before.roles), ...Object.keys(after.roles)])) {
    const oldRole = ownEntry(before.roles, id);
    const newRole = ownEntry(after.roles, id);
    const oldGrants = new Set(oldRole?.grants);
    const newGrants = new Set(newRole?.grants);
    if (Boolean(oldRole) === Boolean(newRole) && sameSet(oldGrants, newGrants) &&
        sameRolePresentation(ownEntry(before.rolePresentation, id), ownEntry(after.rolePresentation, id))) continue;
    changed = true;
    const oldPresentation = ownEntry(before.rolePresentation, id);
    const newPresentation = ownEntry(after.rolePresentation, id);
    const ownPresentation = oldRole && newRole && sameSet(oldGrants, newGrants) && actor.roles.includes(id) && admin &&
      Boolean(oldPresentation?.Hoist) === Boolean(newPresentation?.Hoist) &&
      Boolean(oldPresentation?.Mentionable) === Boolean(newPresentation?.Mentionable);
    if (!owner && before.order.indexOf(id) + 1 >= rank(before, actor) && !ownPresentation) return false;
    if (!admin && [...newGrants].some(id => !oldGrants.has(id) && !baseGrant(before, actor, id))) return false;
  }
  return !changed || checkGrant(before, actor, {}, 'role.edit', 0) === 'allowed';
}

function mayAssignRoles(before, after, actor, previous, next, admin) {
  const oldRoles = new Set(previous.roles.filter(role => ownEntry(after.roles, role)));
  const nextRoles = new Set(next.roles);
  if (sameSet(oldRoles, nextRoles)) return true;
  if (explainAction(before, actor, previous, {}, 'role.assign', false, 0) !== 'allowed') return false;
  if (actor.id === before.owner) return true;
  for (const role of oldRoles) {
    if (!nextRoles.has(role) && before.order.indexOf(role) + 1 >= rank(before, actor)) return false;
  }
  const actorRole = after.order.indexOf(highestRole(before, actor));
  for (const role of nextRoles) {
    if (oldRoles.has(role)) continue;
    if (after.order.indexOf(role) >= actorRole ||
        !admin && after.roles[role].grants.some(permission => !baseGrant(before, actor, permission))) return false;
  }
  return true;
}

function delegable(policy, subject, scope, id) {
  if (!scope.kind) return Boolean(grant(policy, subject, scope, id));
  return checkGrant(policy, { ...subject, timeoutUntil: 0 }, scope, id, 0) === 'allowed';
}

export function permissionFitsACL(id, kind) {
  const permission = permissions.get(id);
  return Boolean(permission && permission.scope !== 'server' && (kind === 'category' || fitsScope(permission.scope, kind)));
}

export function canSeeCategory(policy, actor, childScopes) {
  return actor.active && (policy.owner === actor.id || baseGrant(policy, actor, administrator) ||
    childScopes.some(scope => checkGrant(policy, actor, scope, view, 0) === 'allowed'));
}

export function verifyAccessTransition(policy, actor, before, after, explicitAdminView = false) {
  const rules = scope => (scope.synchronized ? scope.category : scope.local) ?? {};
  const oldACL = rules(before);
  const newACL = rules(after);
  const grants = (rule, side) => new Set((rule?.[side] ?? []).filter(id => permissionFitsACL(id, before.kind)));
  const members = Object.values(policy.members);
  for (const target of members) {
    const previous = ownEntry(oldACL.profiles, target.id);
    const next = ownEntry(newACL.profiles, target.id);
    const previousAllow = grants(previous, 'allow'), nextAllow = grants(next, 'allow');
    const sameDenials = sameSet(grants(previous, 'deny'), grants(next, 'deny'));
    if (sameDenials && sameSet(previousAllow, nextAllow)) continue;
    if (explicitAdminView && target.active && target.id !== policy.owner && baseGrant(policy, target, administrator) &&
        (actor.id === policy.owner || baseGrant(policy, actor, administrator)) && sameDenials) {
      previousAllow.delete(view);
      nextAllow.delete(view);
      if (sameSet(previousAllow, nextAllow)) continue;
    }
    if (explainAction(policy, actor, target, before, 'channel.access.edit', false, 0) !== 'allowed') return false;
  }
  for (const [id, next] of Object.entries(newACL.roles ?? {})) {
    const existing = grants(ownEntry(oldACL.roles, id), 'allow');
    if ([...grants(next, 'allow')].some(permission => !existing.has(permission) && !grant(policy, actor, before, permission))) return false;
  }
  for (const member of members) {
    for (const id of permissions.keys()) {
      if (!delegable(policy, member, before, id) && delegable(policy, member, after, id) &&
          ((policy.owner !== actor.id && member.id === actor.id) || !delegable(policy, actor, before, id))) return false;
    }
  }
  return true;
}

// Replays the same before/after checks as Go at the client trust boundary.
// Scopes contain the effective ACL inputs from the previous signed snapshot.
export function verifyRoleTransition(before, after, actorId, scopes, recoveryReady = {}) {
  if (!validRoleSnapshot(before) || !validRoleSnapshot(after) || before.owner !== after.owner ||
      Object.keys(before.members).length !== Object.keys(after.members).length) return false;
  const actor = ownEntry(before.members, actorId);
  if (!actor?.active) return false;
  const owner = before.owner === actor.id;
  const admin = owner || baseGrant(before, actor, administrator);
  if (!mayEditDefinitions(before, after, actor, admin)) return false;
  const actorRank = rank(before, actor);
  for (const [id, previous] of Object.entries(before.members)) {
    const next = ownEntry(after.members, id);
    if (!next || previous.active !== next.active || previous.timeoutUntil !== next.timeoutUntil ||
        !mayAssignRoles(before, after, actor, previous, next, admin)) return false;
    if (!next.active) continue;
    if (id !== before.owner && !baseGrant(before, previous, administrator) &&
        baseGrant(after, next, administrator) && ownEntry(recoveryReady, id) !== true) return false;
    if (owner || id === before.owner) continue;
    const atOrAboveActor = rank(before, previous) >= actorRank;
    if (atOrAboveActor && highestRole(before, previous) !== highestRole(after, next)) return false;
    for (const [permission, entry] of permissions) {
      for (const scope of [{}, ...scopes]) {
        if (scope.kind && !fitsScope(entry.scope, scope.kind)) continue;
        const had = delegable(before, previous, scope, permission);
        const gets = delegable(after, next, scope, permission);
        if (had === gets) continue;
        if (gets && (id === actor.id || !admin && !delegable(before, actor, scope, permission))) return false;
        if (id !== actor.id && atOrAboveActor) return false;
      }
    }
  }
  return true;
}
