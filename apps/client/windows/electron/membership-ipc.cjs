const { randomBytes, createHash } = require('node:crypto');
const { t } = require('../../../../shared/i18n.cjs');
const { messagePreview } = require('../../../../shared/chat-format.mjs');
const { permissionFitsACL } = require('../../../../shared/protected-access.mjs');
const { runStandaloneProtectedMigration, recoveryBundleSlot } = require('./protected-standalone-migration.cjs');
const { channelGrantSummary, roleViewProjection, channelAccessDelta, policyResourceOrder,
  editableChannelACLProfiles } = require('./protected-policy-replay.cjs');
const permissionIds = new Set(require('../../../server/internal/access/catalog.json').permissions.map(entry => entry.id));
const randomID = () => randomBytes(16).toString('hex');
// Local registry/validation failures are not authenticated server revocations.
function fail(code) { throw Object.assign(Error(code), { code, local: true }); }
function string(value, max = 14000) { if (typeof value !== 'string' || value.length > max) fail('INVALID_INPUT'); return value; }
function id(value, size = 32) { if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${size}}$`).test(value)) fail('INVALID_INPUT'); return value; }

function protectedResourceName(value) {
  const name = string(value, 128).trim();
  if (!name || [...name].length > 64 || /[\p{Cc}\p{Cs}]/u.test(name)) fail('INVALID_INPUT');
  return name;
}

function protectedChannelSettings(input, kind) {
  const name = protectedResourceName(input.name);
  const description = string(input.description, 128 << 10);
  const slowmode = kind === 'voice' ? 0 : input.slowmodeSeconds;
  const capacity = kind === 'text' ? 0 : input.voiceCapacity;
  if (!Number.isInteger(slowmode) || slowmode < 0 || slowmode > 21600 ||
      !Number.isInteger(capacity) || capacity < 0 || capacity > 0xffffffff) fail('INVALID_INPUT');
  return { Name: name, Description: description, SlowmodeSeconds: slowmode, VoiceCapacity: capacity };
}

function channelRules(snapshot, channel) {
  const acl = channel.Synchronized ? snapshot.Categories?.[channel.CategoryID] : channel.ACL;
  const rules = group => Object.fromEntries(Object.entries(group ?? {}).flatMap(([name, entry]) => {
    const Allow = (entry.Allow ?? []).filter(permission => permissionFitsACL(permission, channel.Kind));
    const Deny = (entry.Deny ?? []).filter(permission => permissionFitsACL(permission, channel.Kind));
    return Allow.length || Deny.length ? [[name, { Allow, Deny }]] : [];
  }));
  return { Roles: rules(acl?.Roles), Profiles: rules(acl?.Profiles) };
}

function makeProtectedChannelIntent(input, snapshot) {
  let ResourceChange;
  if (input.action === 'channel.create') {
    const kind = input.kind;
    if (kind !== 'text' && kind !== 'voice') fail('INVALID_INPUT');
    ResourceChange = { ID: randomID(), Channel: { Kind: kind, Settings: protectedChannelSettings(input, kind) } };
    if (input.categoryId) ResourceChange.CategoryID = knownCategory(snapshot, input.categoryId);
    if (input.privateAccess !== undefined) {
      const { roles, profiles } = input.privateAccess ?? {};
      if (!Array.isArray(roles) || !Array.isArray(profiles) || roles.length > 250 || profiles.length > 1000) fail('INVALID_INPUT');
      const acl = channelRules(snapshot, { Kind: kind, CategoryID: ResourceChange.CategoryID, Synchronized: !!ResourceChange.CategoryID });
      for (const group of ['Roles', 'Profiles']) {
        for (const target of Object.keys(acl[group])) acl[group] = updateRule(acl[group], target, 'channel.view', 'inherit');
      }
      acl.Roles = updateRule(acl.Roles, '@everyone', 'channel.view', 'deny');
      for (const role of new Set(roles)) {
        if (typeof role !== 'string' || role === '@everyone' || !Object.hasOwn(snapshot.Roles, role)) fail('INVALID_INPUT');
        acl.Roles = updateRule(acl.Roles, role, 'channel.view', 'allow');
      }
      for (const profile of new Set(profiles)) {
        requireEditableProfile(snapshot, id(profile, 64));
        acl.Profiles = updateRule(acl.Profiles, profile, 'channel.view', 'allow');
      }
      ResourceChange.ACL = acl;
    }
  } else {
    const channelId = id(input.channelId);
    const channel = snapshot.Channels?.[channelId];
    if (!channel) fail('PROTECTED_ACCESS_DENIED');
    ResourceChange = { ID: channelId };
    switch (input.action) {
      case 'channel.settings.update':
        ResourceChange.Settings = protectedChannelSettings(input, channel.Kind);
        break;
      case 'channel.copy':
        ResourceChange = { ID: randomID(), SourceID: channelId };
        break;
      case 'channel.move': {
        const { mode, categoryId } = input;
        if (!['preserve', 'synchronize'].includes(mode) || categoryId === '' && mode === 'synchronize') fail('INVALID_INPUT');
        ResourceChange.Mode = mode;
        if (categoryId !== '') ResourceChange.CategoryID = knownCategory(snapshot, categoryId);
        break;
      }
      case 'channel.order': {
        const anchor = id(input.anchorId);
        const neighbor = snapshot.Channels?.[anchor];
        if (!neighbor || anchor === channelId || (neighbor.CategoryID ?? '') !== (channel.CategoryID ?? '')) fail('INVALID_INPUT');
        Object.assign(ResourceChange, protectedOrder(anchor, input.after));
        if (!channel.CategoryID) ResourceChange.MixedOrder = true;
        break;
      }
      case 'channel.acl.sync':
        if (!channel.CategoryID || channel.Synchronized) fail('INVALID_INPUT');
        break;
      case 'channel.acl.update':
      case 'channel.acl.personal': {
        ResourceChange.ACL = applyACLChanges(snapshot, channelRules(snapshot, channel), channel.Kind, input.changes ?? [input]);
        break;
      }
      case 'channel.delete':
        break;
      default:
        fail('INVALID_INPUT');
    }
  }
  const action = input.action === 'channel.acl.personal' ? 'channel.acl.update' : input.action;
  return { Action: action, OperationID: randomID(), ResourceChange };
}

function updateRule(group, target, permission, rule) {
  const updated = { ...group };
  const entry = Object.hasOwn(updated, target) ? updated[target] : undefined;
  const Allow = (entry?.Allow ?? []).filter(value => value !== permission);
  const Deny = (entry?.Deny ?? []).filter(value => value !== permission);
  if (rule === 'allow') Allow.push(permission);
  if (rule === 'deny') Deny.push(permission);
  if (Allow.length || Deny.length) return { ...updated, [target]: { Allow, Deny } };
  delete updated[target];
  return updated;
}

function applyACLChanges(snapshot, basis, scope, changes) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 128) fail('INVALID_INPUT');
  const acl = { Roles: basis.Roles, Profiles: basis.Profiles };
  const seen = new Set();
  for (const change of changes) {
    if (!change || typeof change !== 'object' || Array.isArray(change) ||
        (change.role === undefined) === (change.profileId === undefined)) fail('INVALID_INPUT');
    const { permission, rule } = change;
    const personal = change.profileId !== undefined;
    const group = personal ? 'Profiles' : 'Roles';
    const target = personal ? id(change.profileId, 64) : string(change.role, 256);
    if (personal) requireEditableProfile(snapshot, target);
    else if (!Object.hasOwn(snapshot.Roles, target)) fail('INVALID_INPUT');
    if (!permissionFitsACL(permission, scope) || !['inherit', 'allow', 'deny'].includes(rule)) fail('INVALID_INPUT');
    const key = JSON.stringify([group, target, permission]);
    if (seen.has(key)) fail('INVALID_INPUT');
    seen.add(key);
    acl[group] = updateRule(acl[group], target, permission, rule);
  }
  return acl;
}

function knownCategory(snapshot, value) {
  const categoryId = string(value, 64);
  if (!categoryId || !Object.hasOwn(snapshot.Categories ?? {}, categoryId)) fail('INVALID_INPUT');
  return categoryId;
}

function protectedCategories(snapshot) {
  return policyResourceOrder(snapshot.CategoryOrder, snapshot.Categories).map(id => ({ id, name: snapshot.CategoryNames?.[id] }));
}

function protectedOrder(anchor, after) {
  if (typeof after !== 'boolean') fail('INVALID_INPUT');
  return { AnchorID: anchor, ...(after && { After: true }) };
}

function makeProtectedCategoryIntent(input, snapshot) {
  const action = input.action;
  const ID = action === 'category.create' ? randomID() : knownCategory(snapshot, input.categoryId);
  const ResourceChange = { ID };
  switch (action) {
    case 'category.create':
    case 'category.settings.update':
      ResourceChange.Name = protectedResourceName(input.name);
      break;
    case 'category.copy':
      ResourceChange.SourceID = ID;
      ResourceChange.ID = randomID();
      ResourceChange.Name = protectedResourceName(input.name);
      break;
    case 'category.order': {
      const anchor = knownCategory(snapshot, input.anchorId);
      if (anchor === ID) fail('INVALID_INPUT');
      Object.assign(ResourceChange, protectedOrder(anchor, input.after));
      break;
    }
    case 'category.delete':
      if (!['keep_children', 'delete_children'].includes(input.mode)) fail('INVALID_INPUT');
      ResourceChange.Mode = input.mode;
      break;
    case 'category.acl.update': {
      ResourceChange.ACL = applyACLChanges(snapshot, snapshot.Categories[ID], 'category', input.changes ?? [input]);
      break;
    }
    default: fail('INVALID_INPUT');
  }
  return { Action: action, OperationID: randomID(), ResourceChange };
}

function protectedRoleIntent(input, snapshot) {
  const existing = input.roleId !== undefined;
  const roleId = existing ? string(input.roleId, 256) : randomID();
  const Roles = { ...snapshot.Roles };
  if (existing && !Object.hasOwn(Roles, roleId)) fail('INVALID_INPUT');
  const Order = (snapshot.Order ?? []).filter(role => role !== roleId);
  const RoleUpdate = { Roles, Order, Assignments: null };
  if (input.action === 'delete') {
    if (!existing || roleId === '@everyone') fail('INVALID_INPUT');
    delete Roles[roleId];
  } else if (input.action === 'save') {
    const { grants, position, hoist, mentionable } = input;
    if (!Array.isArray(grants) || grants.length > permissionIds.size || new Set(grants).size !== grants.length ||
        !grants.every(grant => permissionIds.has(grant)) || typeof hoist !== 'boolean' || typeof mentionable !== 'boolean') fail('INVALID_INPUT');
    const Name = string(input.name, 128).trim();
    const Icon = string(input.icon, 64).trim();
    const Color = string(input.color, 7).toLowerCase();
    if (!Name || [...Name].length > 64 || [...Icon].length > 32 || /[\p{Cc}\p{Cs}]/u.test(Name + Icon) ||
        (Color && !/^#[a-f0-9]{6}$/.test(Color))) fail('INVALID_INPUT');
    if (roleId !== '@everyone') {
      if (!Number.isInteger(position) || position < 0 || position > Order.length) fail('INVALID_INPUT');
      Order.splice(position, 0, roleId);
    }
    RoleUpdate.Roles = { ...Roles, [roleId]: { Grants: grants } };
    RoleUpdate.Presentation = { [roleId]: {
      Name, ...(Color && { Color }), ...(Icon && { Icon }), ...(hoist && { Hoist: true }), ...(mentionable && { Mentionable: true }),
    } };
  } else fail('INVALID_INPUT');
  return { roleId, intent: { Action: 'roles.update', OperationID: randomID(), RoleUpdate } };
}

function protectedRoleName(snapshot, importedRoleNames, id) {
  return snapshot.RolePresentation?.[id]?.Name ??
    (importedRoleNames && Object.hasOwn(importedRoleNames, id) ? importedRoleNames[id] : undefined);
}

function requireEditableProfile(snapshot, profileId) {
  if (profileId === snapshot.Owner || !snapshot.Members?.[profileId]?.Active) fail('PROTECTED_ACCESS_DENIED');
}

function protectedEditableProfiles(snapshot, names) {
  return Object.entries(snapshot.Members ?? {}).flatMap(([id, profile]) => profile.Active && id !== snapshot.Owner
    ? [{ id, name: names?.[id], roles: profile.Roles ?? [] }] : []);
}

function registerMembershipIPC({ ipcMain, authorized, client, links, clipboard, send, getWindow, Notification, onNotificationCount = () => {}, getIdleSeconds = () => 0, getMemoryPressure=()=>{const os=require('node:os');return os.freemem()<Math.max(256*1024*1024,os.totalmem()*.05);}, getHost, stopHost, notificationAppearance=async()=>({}), setVoiceEndpoint = () => {} }) {
  const linkAlerts=new Set(),notified=new Map(),notificationBatches=new Map(),notificationReads=new Map(),shownNotifications=new Map();
  const notificationID=key=>createHash('sha256').update(key).digest('hex').slice(0,16);
  function updateNotificationCount() {
    onNotificationCount([...shownNotifications.values()].reduce((total, shown) => total + shown.count, 0));
  }
  function closeNotification(key, update = true) {
    const shown = shownNotifications.get(key);
    if (!shown) return;
    shownNotifications.delete(key);
    clearTimeout(shown.expiry);
    try { shown.notification?.close?.(); } catch {}
    if (update) updateNotificationCount();
  }
  function cancelNotificationBatch(key){const batch=notificationBatches.get(key);if(!batch)return;batch.cancelled=true;clearTimeout(batch.timer);batch.resolve(false);notificationBatches.delete(key);}
  function clearNotifications(serverId){for(const key of notificationBatches.keys())if(!serverId||key.startsWith(serverId+':'))cancelNotificationBatch(key);for(const key of shownNotifications.keys())if(!serverId||key.startsWith(serverId+':'))closeNotification(key);}
  const alreadyRead=(key,batch)=>{const read=notificationReads.get(key)||0;return read>0&&(!batch.last||read>=batch.last||batch.previewId>0&&read>=batch.previewId);};
  const snapshots=new Map(),versions=new Map(),activities=new Map(),linkChecks=new Map();
  const protectedConnections = new Map();
  const protectedPendingConnections = new Map();
  const protectedMentionInboxes = new WeakMap();
  const protectedNotificationPrefs = new WeakMap();
  const protectedNotificationChannels = new WeakMap();
  const notificationRef = (channelId, position) => `${channelId}:${position}`;

  function applyProtectedMute(connection, input) {
    if (typeof input.serverMuted !== 'boolean' || !Array.isArray(input.mutedChannels) || input.mutedChannels.length > 4096) fail('INVALID_INPUT');
    const channels = new Set(input.mutedChannels.map(channel => id(channel)));
    protectedNotificationPrefs.set(connection, { server: input.serverMuted, channels });
    for (const [key, shown] of shownNotifications) {
      if (shown.connection === connection && shown.kind !== 'direct' && (input.serverMuted || channels.has(shown.channelId))) closeNotification(key);
    }
  }

  function protectedGroupMuted(connection, channelId) {
    const prefs = protectedNotificationPrefs.get(connection);
    return !prefs || prefs.server || prefs.channels.has(channelId);
  }

  async function refreshProtectedMentionInbox(connection) {
    let inbox = protectedMentionInboxes.get(connection);
    if (!inbox) {
      inbox = { alerts: new Map(), delivered: new Map(), polled: 0 };
      protectedMentionInboxes.set(connection, inbox);
    }
    if (inbox.pending) await inbox.pending;
    if (!inbox.pending && (inbox.invalidated || Date.now() - inbox.polled >= 1500)) {
      inbox.invalidated = false;
      inbox.pending = (async () => {
        const page = await client.pollProtectedMentions(connection, inbox.cursor);
        if (protectedConnections.get(connection.serverId) !== connection) return;
        inbox.cursor = page.cursor ?? inbox.cursor;
        inbox.polled = Date.now();
        for (const alert of page.alerts) {
          const key = notificationRef(alert.channelId, alert.position);
          if (!inbox.alerts.has(key)) inbox.alerts.set(key, { ...alert, until: inbox.polled + 30_000 });
        }
        while (inbox.alerts.size > 128) inbox.alerts.delete(inbox.alerts.keys().next().value);
      })().finally(() => { inbox.pending = undefined; });
    }
    if (inbox.pending) await inbox.pending;
    const channels = protectedNotificationChannels.get(connection);
    for (const [key, alert] of inbox.alerts) {
      if (alert.until <= Date.now() || !channels?.has(alert.channelId)) inbox.alerts.delete(key);
    }
    return [...inbox.alerts.values()].map(({ channelId, position, kind }) => ({ channelId, position, kind }));
  }

  async function refreshShownProtectedNotifications(connection) {
    const visible = protectedNotificationChannels.get(connection);
    for (const [key, shown] of shownNotifications) {
      if (!key.startsWith(`${connection.serverId}:`) || !shown.connection) continue;
      try {
        if (shown.connection !== connection || !visible?.has(shown.channelId)) throw Error('PROTECTED_ACCESS_DENIED');
        if (shown.kind === 'message') {
          await shown.verify();
          continue;
        }
        const current = await client.verifyProtectedMention(connection, shown.channelId, shown.last);
        if (current.kind !== shown.kind || current.revision !== shown.revision) throw Error('PROTECTED_ACCESS_DENIED');
      } catch {
        if (shownNotifications.get(key) === shown) closeNotification(key);
      }
    }
  }

  async function protectedNotificationAuthor(connection, channelId, profileId) {
    if (typeof profileId !== 'string' || !/^[0-9a-f]{64}$/.test(profileId)) return;
    const page = await reuseProtectedRead(protectedRosterReads, connection, channelId, 10_000,
      () => client.readProtectedRuntimeRoster(connection, channelId)).catch(() => undefined);
    let member = page?.members.find(member => member.id === profileId);
    if (!member && page?.next && profileId > page.next) {
      const after = (BigInt('0x' + profileId) - 1n).toString(16).padStart(64, '0');
      const key = JSON.stringify(['notification-author', channelId, after, page.revision]);
      const target = await reuseProtectedRead(protectedRosterReads, connection, key, 10_000,
        () => client.readProtectedRuntimeRoster(connection, channelId, after, page.revision)).catch(() => undefined);
      member = target?.members[0]?.id === profileId ? target.members[0] : undefined;
    }
    if (member?.name) return member;
    const nickname = await client.protectedNickname?.(connection, profileId, channelId).catch(() => undefined);
    return { name: nickname?.name, avatar: member?.avatar };
  }

  async function showProtectedMention(input, ordinary, initialWindow, deliveredBatch) {
    const serverId = id(input.serverId), channelId = id(input.channelId), position = input.position;
    if (!Number.isSafeInteger(position) || position < 1) fail('INVALID_INPUT');
    const connection = protectedConnections.get(serverId);
    if (!connection) return false;
    const inbox = protectedMentionInboxes.get(connection);
    const mention = inbox?.alerts.get(notificationRef(channelId, position));
    if (ordinary && (mention || ordinary.mentions?.some(item => item.kind === 'profile' && item.id === connection.profileId))) return false;
    const alert = mention ?? (ordinary && { kind: 'message', until: ordinary.sentAt + 30_000 });
    const channel = protectedNotificationChannels.get(connection)?.get(channelId);
    const key = `${serverId}:${channelId}`;
    const hasPriorityNotice = () => {
      const active = shownNotifications.get(key);
      return active?.connection === connection && active.kind !== 'message';
    };
    const eligible = () => !stopped && !!alert && alert.until > Date.now() && protectedConnections.get(serverId) === connection &&
      !!protectedNotificationChannels.get(connection)?.has(channelId) && !intentionalDepartures.has(serverId) &&
      (!ordinary || !hasPriorityNotice()) &&
      (alert.kind === 'direct' || !protectedGroupMuted(connection, channelId)) &&
      ((ordinary ? notified.get(key) : inbox?.delivered.get(channelId)) || 0) < position && !alreadyRead(key, { last: position });
    if (!channel || !eligible()) return false;
    const message = ordinary ?? await client.readProtectedChatReference(connection, channelId, position);
    if (message?.position !== position || message.own || !ordinary && !message.mentions?.some(mention => alert.kind === 'direct'
      ? mention.kind === 'profile' && mention.id === connection.profileId : mention.kind !== 'profile')) return false;
    const cleanName = value => value?.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
    const channelTitle = `${cleanName(knownRecords.get(serverId)?.name) || 'PawTalk'} · #${cleanName(channel.name) || t('Сообщения')}`;
    const title = ordinary ? channelTitle : `${t('Упоминание')} · ${channelTitle}`;
    const preview = messagePreview(message.text, t('Спойлер')) || t('Вложения');
    const supported = Notification?.isSupported() && (!ordinary || !getWindow()?.isFocused?.());
    const author = supported ? await protectedNotificationAuthor(connection, channelId, message.authorProfileId) : undefined;
    if (!eligible()) return false;
    const authorName = cleanName(author?.name) || t('Участник');
    const body = Array.from(`${authorName}: ${preview}`).slice(0, 240).join('');
    const appearance = supported ? await notificationAppearance({ avatar: author?.avatar, authorName, title, body }).catch(() => ({})) : {};
    if (!eligible() || protectedNotificationChannels.get(connection)?.get(channelId)?.name !== channel.name) return false;
    const verify = async (allowSocket = false) => {
      if (!ordinary) return client.verifyProtectedMention(connection, channelId, position);
      const current = allowSocket && deliveredBatch && pushedProtectedHistory.get(connection)?.get(channelId) === deliveredBatch
        ? initialWindow : await client.readProtectedHistoryWindow(connection, channelId, initialWindow?.cursor);
      if (position < current.first || current.removed.includes(position) || current.more ||
          current.edits?.some(edit => edit.position === position && edit.revision > (message.revision ?? 1))) fail('PROTECTED_ACCESS_DENIED');
      return { kind: 'message', remaining: Math.max(1, alert.until - Date.now()), revision: message.revision ?? 1 };
    };
    const freshness = await verify(true);
    if (!eligible() || freshness.kind !== alert.kind || freshness.revision !== (message.revision ?? 1) ||
        protectedNotificationChannels.get(connection)?.get(channelId)?.name !== channel.name) return false;
    if (!ordinary) {
      inbox.delivered.set(channelId, position);
      if (inbox.delivered.size > 128) inbox.delivered.delete(inbox.delivered.keys().next().value);
    }
    notified.set(key, Math.max(notified.get(key) ?? 0, position));
    if (notified.size > 2048) notified.delete(notified.keys().next().value);
    const notification = supported ? new Notification({ id: notificationID(key), groupId: notificationID(serverId), silent: true, title, body, ...appearance }) : undefined;
    const count = (shownNotifications.get(key)?.count ?? 0) + 1;
    closeNotification(key, false);
    if (shownNotifications.size >= 128) closeNotification(shownNotifications.keys().next().value);
    const shown = { notification, count, connection, channelId, kind: alert.kind, revision: freshness.revision, last: position, previewId: position, verify,
      expiry: setTimeout(() => { if (shownNotifications.get(key) === shown) closeNotification(key); }, freshness.remaining) };
    shownNotifications.set(key, shown);
    updateNotificationCount();
    notification?.on('show', () => {
      if (shownNotifications.get(key) !== shown || stopped || protectedConnections.get(serverId) !== connection ||
          (alert.kind !== 'direct' && protectedGroupMuted(connection, channelId)) || alreadyRead(key, shown)) {
        if (shownNotifications.get(key) === shown) closeNotification(key);
        else notification.close?.();
      }
    });
    notification?.on('click', () => {
      if (shownNotifications.get(key) !== shown || protectedConnections.get(serverId) !== connection) return;
      void verify().then(() => {
        const win = getWindow();
        if (!win || win.isDestroyed() || protectedConnections.get(serverId) !== connection) return;
        win.show(); win.focus(); send('membership-open-channel', { serverId, channelId, protected: true });
      }).catch(() => { if (shownNotifications.get(key) === shown) closeNotification(key); });
    });
    notification?.show();
    return true;
  }
  const protectedPolicyPreviews = new Map();
  async function previewProtectedPolicy(serverId, connection, kind, targetId, intent, summarize) {
    const trust = connection.policyTrust;
    const preview = await client.previewProtectedRuntimePolicy(connection, intent, trust);
    await client.verifyProtectedRuntimePolicyPreview(connection, preview, intent, trust);
    if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
    const previewId = randomID();
    const impact = summarize?.(preview);
    protectedPolicyPreviews.set(serverId, { previewId, connection, kind, targetId, intent, preview, until: Date.now() + 60_000 });
    return impact ? { previewId, impact } : { previewId };
  }
  function impactSnapshot(basis, preview) {
    if (preview.draft.Revision !== basis.revision + 1 || preview.draft.PreviousDigest !== basis.digest) fail('PROTECTED_POLICY_CHANGED');
    return JSON.parse(Buffer.from(preview.snapshot, 'base64'));
  }
  function nameGrantSources(evidence, snapshot, importedRoleNames) {
    if (!evidence) return undefined;
    return { ...evidence, sources: evidence.sources.map(source => source.roleId === undefined ? source : {
      ...source, roleName: protectedRoleName(snapshot, importedRoleNames, source.roleId),
    }) };
  }
  function describeProfileAccess(basis, profile, channel, permission) {
    const { snapshot, importedRoleNames } = basis;
    const now = Date.now();
    const before = channelGrantSummary(snapshot, profile, channel, permission, now);
    const count = (value, policy) => ({ visible: value.visible.length, fullHistory: value.fullHistory.length, allowed: value.allowed,
      ...(value.evidence && { evidence: nameGrantSources(value.evidence, policy, importedRoleNames) }) });
    const difference = (from, other) => {
      const visible = new Set(other.visible), full = new Set(other.fullHistory);
      return { visible: from.visible.filter(id => !visible.has(id)).length,
        fullHistory: from.fullHistory.filter(id => !full.has(id)).length };
    };
    return preview => {
      const policy = impactSnapshot(basis, preview);
      const after = channelGrantSummary(policy, profile, channel, permission, now);
      return { before: count(before, snapshot), after: count(after, policy), gained: difference(after, before), lost: difference(before, after) };
    };
  }
  function describeRoleAccess(basis, roleId, deleting) {
    const { snapshot, importedRoleNames, importedProfileNames } = basis;
    const grantsAdmin = (policy, profileId) => {
      const member = policy.Members?.[profileId];
      return member?.Active && profileId !== policy.Owner && ['@everyone', ...(member.Roles ?? [])].some(id =>
        policy.Roles?.[id]?.Grants?.includes('server.administrator'));
    };
    return preview => {
      const after = impactSnapshot(basis, preview);
      const { keyChannels, changedChannels, details } = channelAccessDelta(snapshot, after, policyResourceOrder(snapshot.ChannelOrder, snapshot.Channels),
        { detailLimit: 32, removedRole: deleting ? roleId : undefined });
      const administrator = { added: 0, ready: 0, removed: 0 };
      for (const id of Object.keys(snapshot.Members ?? {})) {
        const priorGrant = grantsAdmin(snapshot, id), nextGrant = grantsAdmin(after, id);
        if (!priorGrant && nextGrant) {
          administrator.added++;
          if (after.RecoveryReady?.[id] === true) administrator.ready++;
        } else if (priorGrant && !nextGrant) administrator.removed++;
      }
      const channelDetails = details.map(({ example, ...channel }) => !example ? channel : { ...channel, example: {
        profile: { id: example.profile, name: importedProfileNames?.[example.profile] }, removedDeny: example.removedDeny,
        before: nameGrantSources(example.before, snapshot, importedRoleNames), after: nameGrantSources(example.after, after, importedRoleNames),
      } });
      return { keyChannels, changedChannels, details: channelDetails, administrator };
    };
  }
  function describeChannelAccess(snapshot, profiles, channels) {
    return preview => {
      const after = JSON.parse(Buffer.from(preview.snapshot, 'base64'));
      const { keyChannels, ...lists } = channelAccessDelta(snapshot, after, channels);
      return { keyChannels, ...Object.fromEntries(Object.entries(lists)
        .map(([action, ids]) => [action, ids.map(id => ({ id, name: profiles?.[id] }))])) };
    };
  }
  async function readProtectedPolicyForEdit(connection, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) fail('INVALID_INPUT');
    const current = await client.readProtectedManagementPolicy(connection);
    if (current.revision !== revision) fail('PROTECTED_POLICY_CHANGED');
    return current;
  }
  async function commitProtectedPolicy(input, kind) {
    const serverId = id(input.serverId), previewId = id(input.previewId);
    const ready = protectedPolicyPreviews.get(serverId);
    if (ready?.previewId !== previewId || ready.kind !== kind) fail('PROTECTED_PREVIEW_EXPIRED');
    protectedPolicyPreviews.delete(serverId);
    if (ready.until <= Date.now() || protectedConnections.get(serverId) !== ready.connection) fail('PROTECTED_PREVIEW_EXPIRED');
    await client.commitProtectedRuntimePolicy(ready.connection, {
      preview: ready.preview, intent: ready.intent, expectedResultDigest: ready.preview.draft.ResultDigest,
    }, ready.connection.policyTrust);
    send('membership-changed', { serverId });
    return ready.targetId;
  }
  const live=new (require('./membership-live.cjs').MembershipLive)(client,(kind,event)=>{
    if(kind==='membership-server-event'){
      if(event.type!=='chat')for(const [linkId,ctx] of links.pending)if(ctx.connection.config.serverId===event.serverId)linkChecks.delete(linkId);
      versions.set(event.serverId,(versions.get(event.serverId)||0)+1);const cached=snapshots.get(event.serverId);
      if(cached){if(event.type==='chat'){cached.value={...cached.value,channels:cached.value.channels.map(c=>c.id===event.channelId&&c.messageRevision<=event.revision?{...c,messageRevision:event.revision,lastMessageId:event.last}:c)};}else cached.at=0;}
    }
    send(kind,event);
  },(serverId,value)=>snapshots.set(serverId,{value,at:Date.now()}));
  const pushedProtectedHistory = new WeakMap();
  const protectedHistoryBaselines = new WeakMap();
  const protectedLive = new (require('./protected-membership-live.cjs').ProtectedMembershipLive)(({ deliveries, ...event }) => {
    const connection = protectedConnections.get(event.serverId);
    if (!connection || stopped || intentionalDepartures.has(event.serverId)) return;
    if (event.type === 'voice' || event.type === 'composer') {
      send('membership-protected-event', event);
      return;
    }
    if (event.type === 'chat' && !protectedNotificationChannels.get(connection)?.has(event.channelId)) return;
    if (event.type === 'chat') {
      const inbox = protectedMentionInboxes.get(connection);
      if (inbox) inbox.invalidated = true;
      let channels = pushedProtectedHistory.get(connection);
      if (!channels) pushedProtectedHistory.set(connection, channels = new Map());
      const previous = channels.get(event.channelId);
      channels.delete(event.channelId);
      if (deliveries?.length) {
        if (channels.size >= 8) channels.delete(channels.keys().next().value);
        const compatible = previous?.until > Date.now() ? previous.deliveries : [];
        channels.set(event.channelId, { until: Date.now() + 3000, deliveries: [...compatible, ...deliveries].slice(-16) });
      } else {
        protectedHistoryBaselines.get(connection)?.delete(event.channelId);
      }
    } else if (event.type !== 'status' || !event.live) {
      pushedProtectedHistory.delete(connection);
      protectedHistoryBaselines.delete(connection);
      client.clearProtectedPushedKeys?.(connection);
    }
    if (event.type === 'state' || event.type === 'resync') protectedNotificationChannels.delete(connection);
    if (event.type !== 'status' || !event.live) protectedHistoryReads.delete(connection);
    if (event.type !== 'chat' && (event.type !== 'status' || !event.live)) {
      protectedRosterReads.delete(connection);
      protectedStatusReads.delete(connection);
      protectedRoleViewBasis.delete(connection);
    }
    if (event.type === 'chat' && deliveries?.length) {
      const first = deliveries.at(-1).window.first;
      const removed = [...new Set(deliveries.flatMap(delivery => delivery.window.removed))];
      send('membership-protected-event', { ...event, pushed: true, first, removed });
    } else send('membership-protected-event', event);
  });
  const snapshotResult=(serverId,value)=>({...value,eventsLive:live.healthy(serverId)});
  const protectedRosterReads = new WeakMap();
  const protectedStatusReads = new WeakMap();
  const protectedHistoryReads = new WeakMap();
  const protectedRoleViewBasis = new WeakMap();
  const nextProtectedRotationWake = new WeakMap();
  async function reuseProtectedRead(cache, connection, key, duration, read) {
    let reads = cache.get(connection);
    if (!reads) cache.set(connection, reads = new Map());
    const previous = reads.get(key);
    if (previous?.until > Date.now()) return previous.result;
    const entry = { until: Infinity, result: read() };
    reads.delete(key);
    if (reads.size >= 8) reads.delete(reads.keys().next().value);
    reads.set(key, entry);
    try {
      const result = await entry.result;
      if (duration) entry.until = Date.now() + duration;
      else if (reads.get(key) === entry) reads.delete(key);
      return result;
    }
    catch (error) {
      if (reads.get(key) === entry) reads.delete(key);
      throw error;
    }
  }
 const statuses = new Map(), connecting = new Map(), knownRecords = new Map(), departed = new Set(), intentionalDepartures = new Set(); let activeVoice, preparedVoice, voiceEpoch=0,voiceBusy=false, stopped = false, timer, departureTask;
  const addressChanges = new Map();
  const locked=error=>['SERVER_KEY_CHANGED','SERVER_ID_CHANGED','INVALID_SERVER_IDENTITY','SERVER_BINDING_MISMATCH',
    'PROTECTED_CUTOVER_CHANGED','PROTECTED_PROTOCOL_DOWNGRADE','UNTRUSTED_POLICY_ANCHOR','POLICY_ROLLBACK','POLICY_FORK',
    'EPOCH_ROLLBACK','EPOCH_FORK','INVALID_CHANNEL_POLICY_PROOF','UNTRUSTED_EPOCH_SIGNER'].includes(error.code);
  const departureKinds = new Map([
    ['NOT_A_MEMBER', 'kick'], ['BANNED', 'ban'],
    ['PROTECTED_DEVICE_REVOKED', 'device-revoked'], ['PROTECTED_PROFILE_UNLINKED', 'profile-unlinked'],
  ]);
  async function reportDeparture(serverId,error,record=knownRecords.get(serverId)){
    const kind = departureKinds.get(error.code);
    if(error.local||intentionalDepartures.has(serverId)||!record||!kind||departed.has(serverId))return;
    departed.add(serverId);
    const departure={serverId,name:record.name,kind};
    if(error.code==='BANNED'&&(error.details?.expiresAt===null||Number.isSafeInteger(error.details?.expiresAt)))departure.expiresAt=error.details.expiresAt;
    if (typeof error.details?.reason === 'string') departure.reason = error.details.reason;
    clearNotifications(serverId);live.remove(serverId);protectedLive.remove(serverId);snapshots.delete(serverId);protectedConnections.delete(serverId);protectedPendingConnections.delete(serverId);
    try {
      await client.forget(serverId);
    } catch (failure) {
      departed.delete(serverId);
      throw failure;
    }
    if(activeVoice?.serverId===serverId||preparedVoice?.serverId===serverId){await voiceLeave();send('membership-voice-lost',{serverId});}
    send('membership-changed',{serverId,departure});
  }
  function useProtectedConnection(connection, state) {
    const { serverId } = state;
    if (!stopped && !intentionalDepartures.has(serverId)) {
      protectedConnections.set(serverId, connection);
      protectedNotificationChannels.set(connection, new Map((state.channels ?? []).filter(channel => channel.kind === 'text')
        .map(channel => [channel.id, channel])));
      protectedLive.ensure(connection);
      if (state.rotationQueue?.waiting > 0 && client.serviceProtectedRuntimeRotations &&
          (nextProtectedRotationWake.get(connection) ?? 0) <= Date.now()) {
        nextProtectedRotationWake.set(connection, Infinity);
        void client.serviceProtectedRuntimeRotations(connection).catch(async error => {
          if (!stopped && protectedConnections.get(serverId) === connection) {
            await reportDeparture(serverId, error).catch(() => {});
          }
        }).finally(() => nextProtectedRotationWake.set(connection, Date.now() + 3_000));
      }
    }
    return connection.config?.protectedEvents === true ? { ...state, eventsLive: protectedLive.healthy(serverId) } : state;
  }
  async function connectRecord(record,force=false) {
    const change = addressChanges.get(record.serverId);
    if (change) await change.catch(() => {});
    const latest = knownRecords.get(record.serverId);
    if (change || latest && latest.address !== record.address) {
      const current = (await client.registry()).find(item => item.serverId === record.serverId);
      if (!current) fail('NOT_A_MEMBER');
      record = current;
    }
    knownRecords.set(record.serverId,record);
    const cached=snapshots.get(record.serverId);
    if(!force&&cached&&live.healthy(record.serverId)&&cached.at>0)return snapshotResult(record.serverId,cached.value);
    if(connecting.has(record.serverId))return connecting.get(record.serverId);
    const version=versions.get(record.serverId)||0;
    const operation=(async () => {
      const trust = await client.loadProtectedRuntimeTrust?.(record.serverId);
      if (trust) {
        live.remove(record.serverId);
        snapshots.delete(record.serverId);
        client.connections.delete(record.serverId);
        let connection = force ? undefined : protectedConnections.get(record.serverId);
        if (connection?.address !== record.address) connection = undefined;
        if (!connection) {
          protectedLive.remove(record.serverId);
          try {
            connection = await client.openStoredProtectedRuntime(record.serverId);
          } catch (error) {
            if (error.code !== 'INVALID_PROTECTED_SESSION_PROOF') throw error;
            let cached = protectedPendingConnections.get(record.serverId);
            if (cached?.address !== record.address || cached.session.expiresAt <= Date.now()) {
              const session = await client.openProtectedPendingInviteSession(record.serverId, trust.cutoverDigest);
              cached = { address: record.address, session };
              protectedPendingConnections.set(record.serverId, cached);
            }
            let status;
            try { status = await client.readProtectedPendingInviteState(cached.session); }
            catch (error) { protectedPendingConnections.delete(record.serverId); throw error; }
            return { apiProtocolVersion: 3, serverId: record.serverId, profileId: status.profileId, channels: [], joinPending: true };
          }
        }
        protectedPendingConnections.delete(record.serverId);
        let value;
        try {
          value = await client.readProtectedRuntimeState(connection);
        } catch (error) {
          if (error.code === 'RATE_LIMIT') throw error;
          protectedLive.remove(record.serverId);
          protectedConnections.delete(record.serverId);
          clearNotifications(record.serverId);
          if (error.code !== 'INVALID_PROTECTED_SESSION') throw error;
          connection = await client.openStoredProtectedRuntime(record.serverId);
          value = await client.readProtectedRuntimeState(connection);
        }
        return useProtectedConnection(connection, value);
      }
      if (client.protectedOnly) {
        const connection = await client.discoverMembership(record.address, record.serverId);
        fail(connection.config.apiProtocolVersion === 3 ? 'PROTECTED_REJOIN_REQUIRED' : 'UNSUPPORTED_PROTOCOL');
      }
      return client.connections.has(record.serverId) ? client.state(record.serverId) : client.connect(record);
    })().then(value=>{
      if (value.apiProtocolVersion === 3) {
        statuses.set(record.serverId, 'online');
        departed.delete(record.serverId);
        return value;
      }
      const changed=(versions.get(record.serverId)||0)!==version,latest=snapshots.get(record.serverId)?.value;
      if(changed&&latest)value={...value,channels:value.channels.map(c=>{const newer=latest.channels.find(n=>n.id===c.id);return newer&&newer.messageRevision>c.messageRevision?newer:c;})};
      snapshots.set(record.serverId,{value,at:changed?0:Date.now()});statuses.set(record.serverId,'online');departed.delete(record.serverId);live.ensure(record.serverId,value);return snapshotResult(record.serverId,value);
    }).catch(async error=>{
      if (error.code === 'RATE_LIMIT' || addressChanges.has(record.serverId)) throw error;
      statuses.set(record.serverId,locked(error)?'locked':'offline');
      if (error.status === 404 && await client.protectedStandaloneMigrationPending?.(record.serverId).catch(() => false)) {
        fail('MIGRATION_MAINTENANCE');
      }
      await reportDeparture(record.serverId,error,record);
      throw error;
    }).finally(()=>connecting.delete(record.serverId));
    connecting.set(record.serverId,operation);return operation;
  }

  async function refreshProtectedBackground(connection) {
    await Promise.all([
      client.reportProtectedActivity?.(connection, getIdleSeconds() >= 300).catch(error => {
        if (error.code === 'PROTECTED_DEVICE_REVOKED' || error.code === 'PROTECTED_PROFILE_UNLINKED') throw error;
      }),
      client.serviceProtectedRuntimeRotations?.(connection),
      refreshProtectedMentionInbox(connection).catch(() => {}),
      refreshShownProtectedNotifications(connection),
    ]);
  }
  async function background() {
    if (stopped) return;
    const beforeStatuses=JSON.stringify([...statuses]);
    try {
      const records = await client.registry();live.reconcile(records);protectedLive.reconcile(records);for(const serverId of snapshots.keys())if(!records.some(r=>r.serverId===serverId))snapshots.delete(serverId); let index = 0;
      for (const serverId of protectedConnections.keys()) if (!records.some(record => record.serverId === serverId)) protectedConnections.delete(serverId);
      for (const serverId of protectedPendingConnections.keys()) if (!records.some(record => record.serverId === serverId)) protectedPendingConnections.delete(serverId);
      if(!departureTask&&client.pendingDepartures)departureTask=client.pendingDepartures().then(results=>{if(stopped)return;for(const result of results)if(result.outcome==='blocked'){intentionalDepartures.delete(result.serverId);send('membership-changed',{serverId:result.serverId,leaveError:result.code??'LAST_ADMIN'});}if(results.length)send('membership-changed',{});}).catch(()=>{}).finally(()=>{departureTask=undefined;});
      const connections=Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
        while (index < records.length && !stopped) {
          const record = records[index++];
          try {
            const current = protectedConnections.get(record.serverId);
            if (current?.address === record.address && protectedLive.healthy(record.serverId) &&
                protectedNotificationChannels.has(current)) {
              await refreshProtectedBackground(current);
              continue;
            }
            const state = await connectRecord(record);
            if (state.apiProtocolVersion === 3) {
              const connection = protectedConnections.get(record.serverId);
              if (connection) await refreshProtectedBackground(connection);
              continue;
            }
            if(live.healthy(record.serverId))await live.reconcileSequence(record.serverId);
            if(!live.healthy(record.serverId))await client.request(record.serverId, '/api/v2/heartbeat', 'POST', {});
            if(client.connections.get(record.serverId)?.config?.capabilities?.includes('activity-v1')){const away=getIdleSeconds()>=300,stamp=client.connections.get(record.serverId).token+':'+away;if(activities.get(record.serverId)!==stamp){await client.request(record.serverId,'/api/v2/activity','POST',{away});activities.set(record.serverId,stamp);}}
            statuses.set(record.serverId, 'online');
            if (activeVoice?.serverId === record.serverId) {
              try { await client.request(record.serverId, '/api/v2/voice/heartbeat', 'POST', {}); }
              catch(error) { if(['NOT_A_MEMBER','BANNED'].includes(error.code))await reportDeparture(record.serverId,error,record);else{await voiceLeave();send('membership-voice-lost',{serverId:record.serverId});} }
            }
          } catch(error) { if (error.code !== 'RATE_LIMIT' && !addressChanges.has(record.serverId)) { statuses.set(record.serverId, locked(error)?'locked':'offline');await reportDeparture(record.serverId,error,record); } }
        }
      }));
      await connections;
      if(beforeStatuses!==JSON.stringify([...statuses])||records.some(record=>!live.healthy(record.serverId)&&!protectedLive.healthy(record.serverId)))send('membership-changed', {});
    } catch { /* Protected storage unavailable: UI reports it, never downgrade storage. */ }
    finally { if (!stopped) timer = setTimeout(() => void background(), 15000); }
  }
  async function voiceLeave() {
    voiceEpoch++;
    const previous = activeVoice || preparedVoice; activeVoice = preparedVoice = undefined;
    await setVoiceEndpoint(null);
    if (previous) {
      try {
        if (previous.connection) await client.leaveProtectedRuntimeVoice(previous.connection);
        else await client.request(previous.serverId, '/api/v2/voice/leave', 'POST', {});
      } catch {}
    }
  }
  function activeProtectedVoice(input) {
    const serverId = id(input.serverId), channelId = id(input.channelId);
    if (!activeVoice?.connection || activeVoice.serverId !== serverId || activeVoice.channelId !== channelId) fail('VOICE_NOT_PREPARED');
    return activeVoice;
  }
  function protectedVoiceModerationScope(input) {
    const serverId = id(input.serverId), channelId = id(input.sourceChannelId);
    const connection = protectedConnections.get(serverId);
    if (!connection?.config.protectedVoice) fail('NOT_CONNECTED');
    return { serverId, channelId, connection };
  }
  async function pendingProtectedVoiceMove(voice) {
    if (voice.moveDestination) return voice.moveDestination;
    const destination = await client.protectedRuntimeVoiceDestination(voice.connection);
    if (activeVoice !== voice) fail('CANCELLED');
    if (destination && destination !== voice.channelId) voice.moveDestination = destination;
    return voice.moveDestination;
  }
  async function protectedVoiceAccess(access, connection) {
    const url = await setVoiceEndpoint(access.url, connection.fingerprint) || access.url;
    return protectedVoiceAccessReply(access, url);
  }
  function protectedVoiceAccessReply(access, url) {
    return { url, token: access.token, e2eeRequired: access.e2eeRequired,
      ...(access.serverDeafened === true ? { serverDeafened: true } : { key: access.key, epoch: access.epoch }) };
  }
  function shareInvite(origin, serverId) {
    const host = getHost?.();
    // Owners connect over loopback. Use the advertised origin with the same
    // pinned certificate when they share the link.
    if (!host?.running || host.serverId !== serverId || !host.invitations?.length) return origin;
    const output = new URL(host.invitations[0]);
    output.hash = new URL(origin).hash;
    return output.toString();
  }

  async function listOwnDevices(input) {
    const serverId = id(input.serverId), connection = protectedConnections.get(serverId);
    if (!connection) fail('NOT_CONNECTED');
    const ids = await client.listProtectedOwnDevices(connection);
    if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
    return { devices: ids.map(deviceId => ({ deviceId, current: deviceId === connection.deviceId })) };
  }
  const actions = {
    async servers() { const host=getHost?.();const records=await client.registry();live.reconcile(records);for(const record of records)knownRecords.set(record.serverId,record);return records.map(record => ({ ...record, ownedSelfhost:!!(host?.running&&host.serverId===record.serverId),source:host?.running&&host.serverId===record.serverId?'selfhost':'external',status: statuses.get(record.serverId) || 'offline' })); },
    async activity(){return {away:getIdleSeconds()>=300};},
    async identity() { const identity = await client.identity(); return { profileId: identity.profileId, deviceId: identity.deviceId }; },
    async join(input) {
      let result = await client.join(string(input.address), string(input.nickname, 64), string(input.deviceLabel || t('Компьютер'), 64));
      if (result.keysPending === true) {
        const record = (await client.registry()).find(entry => entry.serverId === result.serverId);
        if (!record) fail('NOT_A_MEMBER');
        result = await connectRecord(record);
      }
      intentionalDepartures.delete(result.serverId);departed.delete(result.serverId);
      statuses.set(result.serverId, 'online'); send('membership-changed', { serverId: result.serverId }); return result;
    },
    async prepareRecovery(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      const recoveryBundle = input.code === undefined ? client.prepareRecoveryBundle(connection) :
        await client.exportRegisteredRecoveryBundle(connection, string(input.code, 43));
      return { recoveryBundle };
    },
    'recovery.protected.devices': listOwnDevices,
    'device.protected.list': listOwnDevices,
    async confirmRecovery(input) {
      const serverId = id(input.serverId), connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      if (input.replace !== undefined && typeof input.replace !== 'boolean') fail('INVALID_INPUT');
      return client.confirmRecoveryBundle(connection, string(input.recoveryBundle, 4096).trim(), input.replace === true);
    },
    async recoverDevice(input) {
      const connection = await client.recoverProtectedDeviceFromBundle(string(input.recoveryBundle, 4096).trim());
      const { serverId } = connection;
      const record = (await client.registry()).find(entry => entry.serverId === serverId);
      if (!record) fail('NOT_A_MEMBER');
      protectedLive.remove(serverId);
      protectedConnections.set(serverId, connection);
      await connectRecord(record);
      intentionalDepartures.delete(serverId);
      send('membership-changed', { serverId });
      return { serverId };
    },
    async 'device.protected.challenge'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      return { challengeCard: await client.makeProtectedDeviceChallenge(connection) };
    },
    async 'device.protected.request'(input) {
      const requestCard = await client.makeProtectedDeviceRequest(string(input.challengeCard, 4096).trim());
      return { requestCard, deviceId: (await client.identity()).deviceId };
    },
    async 'device.protected.preview'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      return client.previewProtectedDeviceRequest(connection, string(input.requestCard, 4096).trim());
    },
    async 'device.protected.approve'(input) {
      const serverId = id(input.serverId), connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const result = await client.approveProtectedDeviceRequest(connection, string(input.requestCard, 4096).trim());
      send('membership-changed', { serverId });
      return result;
    },
    async 'device.protected.finish'(input) {
      const connection = await client.finishProtectedDeviceBinding(string(input.challengeCard, 4096).trim());
      const { serverId } = connection;
      protectedLive.remove(serverId);
      protectedConnections.set(serverId, connection);
      intentionalDepartures.delete(serverId);
      statuses.set(serverId, 'online');
      send('membership-changed', { serverId });
      return { serverId };
    },
    async 'device.protected.revoke'(input) {
      const serverId = id(input.serverId), deviceId = id(input.deviceId, 64);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const result = await client.revokeProtectedOwnDevice(connection, deviceId);
      send('membership-changed', { serverId });
      return result;
    },
    async 'profile.protected.avatar.save'(input) {
      const serverId = id(input.serverId), connection = protectedConnections.get(serverId);
      if (!connection || connection.profileId !== id(input.profileId, 64)) fail('NOT_CONNECTED');
      const revision = input.revision;
      if (!Number.isSafeInteger(revision) || revision < 1) fail('INVALID_INPUT');
      const avatar = input.avatar === null ? null : string(input.avatar, 12000);
      const value = await client.saveProtectedProfileAvatar(connection, avatar, revision);
      send('membership-changed', { serverId });
      return value;
    },
    async 'profile.protected.participant'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      return { participantCard: await client.makeProtectedProfileParticipant(connection) };
    },
    async 'profile.protected.prepare'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      if (typeof input.primaryIsLocal !== 'boolean') fail('INVALID_INPUT');
      return client.prepareProtectedProfileLink(connection, string(input.participantCard, 4096).trim(), input.primaryIsLocal);
    },
    async 'profile.protected.review'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      return client.reviewProtectedProfileLink(connection, string(input.linkCard, 4096).trim());
    },
    async 'profile.protected.sign'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      return client.signProtectedProfileLink(connection, string(input.linkCard, 4096).trim());
    },
    async 'profile.protected.apply'(input) {
      const serverId = id(input.serverId), connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const result = await client.applyProtectedProfileLink(connection, string(input.linkCard, 4096).trim());
      send('membership-changed', { serverId });
      return result;
    },
    async 'profile.protected.status'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      return client.readProtectedProfileLinkStatus(connection);
    },
    async 'profile.protected.unlink'(input) {
      const serverId = id(input.serverId), connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const result = await client.unlinkProtectedProfile(connection, id(input.sourceProfileId, 64), id(input.policyHead, 64));
      send('membership-changed', { serverId });
      return result;
    },
    async 'ownership.protected.read'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      const { ownerProfileId, signerDeviceId, offer } = await client.readProtectedOwnershipOffer(connection);
      const canOffer = ownerProfileId === connection.profileId && signerDeviceId === connection.deviceId;
      return { ownerProfileId, canOffer, ...(offer && { offer: {
        operationId: offer.operationId, ownerProfileId: offer.ownerProfileId, targetProfileId: offer.targetProfileId,
        expiresAt: offer.expiresAt, outgoing: offer.ownerProfileId === connection.profileId,
      } }) };
    },
    async 'ownership.protected.offer'(input) {
      const serverId = id(input.serverId), connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const offer = await client.offerProtectedOwnership(connection, id(input.targetProfileId, 64));
      return { operationId: offer.operationId };
    },
    async 'ownership.protected.accept'(input) {
      const serverId = id(input.serverId), connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const result = await client.acceptProtectedOwnership(connection, id(input.operationId));
      send('membership-changed', { serverId });
      return { ownerProfileId: result.ownerProfileId };
    },
    async 'ownership.protected.cancel'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      return client.cancelProtectedOwnership(connection, id(input.operationId));
    },
    async 'scope.protected.status'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      return client.readProtectedScopeDeviceStatus(connection);
    },
    async 'scope.protected.offer'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      return client.offerProtectedScopeDevice(connection, id(input.targetDeviceId, 64));
    },
    async 'scope.protected.preview'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      return client.previewProtectedScopeDevice(connection, string(input.offerCard, 4096).trim());
    },
    async 'scope.protected.accept'(input) {
      const serverId = id(input.serverId), connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const result = await client.acceptProtectedScopeDevice(connection, string(input.offerCard, 4096).trim());
      send('membership-changed', { serverId });
      return result;
    },
    async connect(input) {
      const serverId = id(input.serverId), record = (await client.registry()).find(record => record.serverId === serverId);
      if (!record) fail('NOT_A_MEMBER'); return connectRecord(record,input.force===true);
    },
    async state(input) {
      const serverId = id(input.serverId);
      if (await client.loadProtectedRuntimeTrust?.(serverId)) {
        const record = (await client.registry()).find(entry => entry.serverId === serverId);
        if (!record) fail('NOT_A_MEMBER');
        return connectRecord(record);
      }
      return client.state(serverId);
    },
    async 'server.avatar'(input){return client.serverAvatar(id(input.serverId),input.avatar,input.expectedRevision);},
    async 'migration.standalone.inspect'(input) {
      return client.protectedStandaloneMigrationCheckpoint(id(input.serverId));
    },
    async 'migration.standalone.confirm'(input) {
      const serverId = id(input.serverId);
      const archiveSha256 = id(input.archiveSha256, 64);
      client.standaloneMigrationRuns ??= new Map();
      if (client.standaloneMigrationRuns.has(serverId)) fail('MIGRATION_IMPORT_BUSY');
      const task = runStandaloneProtectedMigration(client, serverId, archiveSha256);
      client.standaloneMigrationRuns.set(serverId, task);
      try {
        const result = await task;
        send('membership-changed', { serverId });
        return result;
      } finally { client.standaloneMigrationRuns.delete(serverId); }
    },
    async 'migration.standalone.recovery'(input) {
      const serverId = id(input.serverId);
      const trust = await client.loadProtectedRuntimeTrust(serverId);
      const identity = await client.identity();
      if (!trust || trust.ownerDeviceId !== identity.deviceId) fail('MIGRATION_DEVICE_DENIED');
      await client.openStoredProtectedRuntime(serverId);
      return client.credentials.load(recoveryBundleSlot(serverId), { required: true });
    },
    async 'community.protected.avatar'(input) {
      const serverId = id(input.serverId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const result = await client.saveProtectedCommunityAvatar(connection, input.avatar, input.expectedRevision);
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      send('membership-changed', { serverId });
      return result;
    },
    async 'community.protected.rename'(input) {
      const serverId = id(input.serverId);
      const name = string(input.name, 128).trim(), revision = input.revision;
      if (!name || [...name].length > 64 || /[\p{Cc}\p{Cs}]/u.test(name) ||
          !Number.isSafeInteger(revision) || revision < 1 || revision === Number.MAX_SAFE_INTEGER) fail('INVALID_SERVER_NAME');
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const result = await client.renameProtectedCommunity(connection, { name, revision });
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      send('membership-changed', { serverId });
      return result;
    },
    async 'server.rename'(input) {
      const serverId=id(input.serverId);
      await client.request(serverId,'/api/v2/server','PATCH',{name:string(input.name,256),expectedName:string(input.expectedName,256),requestId:randomID()});
      const state=await client.state(serverId);send('membership-changed',{serverId});return state;
    },
    async 'server.address'(input) {
      const serverId = id(input.serverId);
      const address = string(input.address);
      if (voiceBusy || activeVoice?.serverId === serverId || preparedVoice?.serverId === serverId ||
          addressChanges.has(serverId)) fail('BUSY');
      const change = (async () => {
        await connecting.get(serverId)?.catch(() => {});
        const moved = await client.changeProtectedAddress?.(serverId, address);
        let result;
        if (moved) {
          const previous = protectedConnections.get(serverId);
          const prefs = previous && protectedNotificationPrefs.get(previous);
          if (prefs) protectedNotificationPrefs.set(moved.connection, prefs);
          clearNotifications(serverId);
          live.remove(serverId);
          snapshots.delete(serverId);
          protectedPendingConnections.delete(serverId);
          protectedLive.remove(serverId);
          knownRecords.set(serverId, { ...knownRecords.get(serverId), serverId, address: moved.connection.address,
            name: moved.state.community?.name ?? moved.connection.config.name });
          result = useProtectedConnection(moved.connection, moved.state);
        } else {
          result = await client.changeAddress(serverId, address);
          live.remove(serverId);
          snapshots.set(serverId, { value: result, at: Date.now() });
          live.ensure(serverId, result);
        }
        statuses.set(serverId, 'online');
        departed.delete(serverId);
        send('membership-changed', { serverId });
        return result;
      })();
      addressChanges.set(serverId, change);
      try { return await change; }
      finally { addressChanges.delete(serverId); }
    },
    async 'poll.create'(input){const pollId=id(input.requestId);return client.send(id(input.serverId),id(input.channelId),{text:string(input.question,600),poll:{...input.definition,id:pollId}},undefined,pollId);},
    async 'poll.state'(input){return client.request(id(input.serverId),'/api/v2/polls/'+id(input.pollId));},
    async 'poll.vote'(input){if(!Array.isArray(input.choices)||input.choices.length>10||input.choices.some(i=>!Number.isInteger(i)||i<0||i>9))fail('INVALID_INPUT');return client.request(id(input.serverId),'/api/v2/polls/'+id(input.pollId)+'/vote','PUT',{choices:input.choices,requestId:id(input.requestId)});},
    async 'poll.close'(input){return client.request(id(input.serverId),'/api/v2/polls/'+id(input.pollId)+'/close','POST',{requestId:id(input.requestId)});},
    async 'chat.watch'(input){return live.watch(id(input.serverId),id(input.channelId),id(input.subscriptionId));},
    async 'chat.protected.read'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      const after = input.after ?? 0;
      const limit = input.limit;
      const cursor = input.cursor === '' || input.cursor === undefined ? input.cursor : id(input.cursor);
      if (!Number.isSafeInteger(after) || after < 0 || limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 32)) fail('INVALID_INPUT');
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const key = JSON.stringify(['page', channelId, after, cursor, limit]);
      const page = await reuseProtectedRead(protectedHistoryReads, connection, key, 0,
        async () => {
          const channels = pushedProtectedHistory.get(connection);
          const batch = channels?.get(channelId);
          const baseline = protectedHistoryBaselines.get(connection)?.get(channelId);
          const records = batch?.until > Date.now() ? batch.deliveries.filter(record => record.window.last > after) : [];
          if (records.length && baseline?.cursor === cursor && cursor !== undefined &&
              (baseline.last === undefined || baseline.last <= after) && client.readProtectedPushedChatPage) {
            const pushed = await client.readProtectedPushedChatPage(connection, channelId, after, cursor,
              baseline.first, records, limit).catch(() => undefined);
            if (pushed && pushedProtectedHistory.get(connection)?.get(channelId) === batch &&
                protectedConnections.get(serverId) === connection) return pushed;
          }
          return client.readProtectedChatPage(connection, channelId, after, cursor, limit);
        });
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      if (!page.retry && page.cursor !== undefined && !page.more && page.next === undefined) {
        let baselines = protectedHistoryBaselines.get(connection);
        if (!baselines) protectedHistoryBaselines.set(connection, baselines = new Map());
        baselines.delete(channelId);
        if (baselines.size >= 64) baselines.delete(baselines.keys().next().value);
        baselines.set(channelId, { first: page.first, cursor: page.cursor, last: page.last });
      }
      return page;
    },
    async 'chat.protected.window'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      const cursor = input.cursor === '' || input.cursor === undefined ? input.cursor : id(input.cursor);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const key = JSON.stringify(['window', channelId, cursor]);
      const window = await reuseProtectedRead(protectedHistoryReads, connection, key, 0,
        () => client.readProtectedHistoryWindow(connection, channelId, cursor));
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      return window;
    },
    async 'chat.protected.composer'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      if (!['typing', 'recording', 'idle'].includes(input.activity)) fail('INVALID_INPUT');
      const connection = protectedConnections.get(serverId);
      if (connection) await client.publishProtectedComposerActivity(connection, channelId, input.activity);
    },
    async 'chat.protected.edition'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      if (!Number.isSafeInteger(input.position) || input.position < 1) fail('INVALID_INPUT');
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      return client.readProtectedChatEdition(connection, channelId, input.position);
    },
    async 'chat.protected.browse'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const page = await client.browseProtectedChat(connection, channelId, { mode: input.mode, query: input.query,
        after: input.after ?? 0, checkpoint: input.checkpoint });
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      return page;
    },
    async 'chat.protected.reference'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const message = await client.readProtectedChatReference(connection, channelId, input.position);
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      return message;
    },
    async 'chat.protected.mentions'(input) {
      const serverId = id(input.serverId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      applyProtectedMute(connection, input);
      const [page] = await Promise.all([refreshProtectedMentionInbox(connection), refreshShownProtectedNotifications(connection)]);
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      return page;
    },
    async 'chat.protected.muteNotifications'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (connection) applyProtectedMute(connection, input);
    },
    'chat.protected.notify': showProtectedMention,
    async 'chat.protected.activity'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      const after = input.after ?? 0;
      if (!Number.isSafeInteger(after) || after < 0) fail('INVALID_INPUT');
      const connection = protectedConnections.get(serverId);
      if (!connection || !protectedNotificationChannels.get(connection)?.has(channelId)) return;
      const inbox = input.notify === true && client.pollProtectedMentions && refreshProtectedMentionInbox(connection).catch(() => {});
      const batch = pushedProtectedHistory.get(connection)?.get(channelId);
      const latest = batch?.until > Date.now() ? batch.deliveries.at(-1) : undefined;
      let delivered, deliveredBatch;
      if (latest?.window.last > after && client.readProtectedPushedChatPage) {
        delivered = await client.readProtectedPushedChatPage(connection, channelId, latest.window.last - 1,
          latest.window.cursor, latest.window.first, [latest], 1).catch(() => undefined);
        if (pushedProtectedHistory.get(connection)?.get(channelId) === batch) deliveredBatch = batch;
        else delivered = undefined;
      }
      const window = delivered ?? await reuseProtectedRead(protectedHistoryReads, connection, JSON.stringify(['window', channelId, undefined]), 1000,
        () => client.readProtectedHistoryWindow(connection, channelId));
      const { last } = window;
      if (!last || last <= after || protectedConnections.get(serverId) !== connection ||
          alreadyRead(`${serverId}:${channelId}`, { last })) return;
      const [message] = await Promise.all([delivered?.messages[0] ?? client.readProtectedChatReference(connection, channelId, last, window), inbox]);
      if (protectedConnections.get(serverId) !== connection || !protectedNotificationChannels.get(connection)?.has(channelId)) return;
      if (!message || message.own) return { position: last, incoming: false };
      const recent = Number.isSafeInteger(message.sentAt) && message.sentAt <= Date.now() && Date.now() - message.sentAt < 30_000;
      const notified = input.notify === true && recent &&
        await showProtectedMention({ serverId, channelId, position: last }, message, window, delivered && deliveredBatch).catch(() => false);
      return { position: last, incoming: true, recent, notified };
    },
    async 'chat.protected.pins'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      return client.readProtectedPins(connection, channelId, input.before);
    },
    async 'chat.protected.pinnedMessage'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const message = await client.readProtectedPinnedMessage(connection, channelId, input.position);
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      return message;
    },
    async 'chat.protected.pin'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      await client.setProtectedMessagePin(connection, channelId, input.position, input.pinned);
      return true;
    },
    async 'chat.protected.edit'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId), operationId = id(input.operationId);
      const { position, expectedRevision } = input;
      const text = string(input.text, 12288);
      if (!Number.isSafeInteger(position) || position < 1 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
          Buffer.byteLength(text) > 12288) fail('INVALID_INPUT');
      const removeAttachments = input.removeAttachments ?? [];
      if (!Array.isArray(removeAttachments) || removeAttachments.length > 10 ||
          new Set(removeAttachments).size !== removeAttachments.length) fail('INVALID_INPUT');
      removeAttachments.forEach(attachmentId => id(attachmentId));
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      return client.editProtectedChatMessage(connection, channelId, position, expectedRevision, operationId, text, input.checklist, removeAttachments);
    },
    async 'chat.protected.delete'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      if (!Number.isSafeInteger(input.position) || input.position < 1 ||
          input.completedPoll !== undefined && typeof input.completedPoll !== 'boolean') fail('INVALID_INPUT');
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      await client.deleteProtectedMessage(connection, channelId, input.position, input.completedPoll);
      return true;
    },
    async 'chat.protected.checklist'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      if (!Number.isSafeInteger(input.position) || input.position < 1) fail('INVALID_INPUT');
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      return client.protectedChecklist(connection, channelId, input.position, input.change);
    },
    async 'chat.protected.poll'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      if (!Number.isSafeInteger(input.position) || input.position < 1) fail('INVALID_INPUT');
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      return client.protectedPoll(connection, channelId, input.position, input.vote, input.close);
    },
    async 'chat.protected.attachment'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId), attachmentId = id(input.attachmentId);
      if (!Number.isSafeInteger(input.position) || input.position < 1) fail('INVALID_INPUT');
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const bytes = await client.readProtectedFile(connection, channelId, input.position, attachmentId);
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      return bytes;
    },
    async 'chat.protected.stageAttachment'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId), operation = id(input.operationId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      return client.stageProtectedAttachment(connection, channelId, operation, input.slot, input.file);
    },
    async 'roster.protected.read'(input) {
      const serverId = id(input.serverId);
      if (input.voice !== undefined && typeof input.voice !== 'boolean') fail('INVALID_INPUT');
      const channelId = input.channelId === undefined ? undefined : id(input.channelId);
      const after = input.after === undefined ? undefined : id(input.after, 64);
      const revision = input.revision;
      if ((after !== undefined || revision !== undefined) &&
          (after === undefined || !Number.isSafeInteger(revision) || revision < 1)) fail('INVALID_INPUT');
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      if (input.voice === true) return client.readProtectedRuntimeRoster(connection, channelId, after, revision, false, true);
      if (!channelId || after) return client.readProtectedRuntimeRoster(connection, channelId, after, revision);
      return reuseProtectedRead(protectedRosterReads, connection, channelId, protectedLive.healthy(serverId) ? 10_000 : 0,
        () => client.readProtectedRuntimeRoster(connection, channelId));
    },
    async 'profile.protected.nickname.read'(input) {
      const serverId = id(input.serverId), profileId = id(input.profileId, 64);
      const channelId = input.channelId === undefined ? undefined : id(input.channelId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const value = await client.protectedNickname(connection, profileId, channelId);
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      return value;
    },
    async 'profile.protected.nickname.change'(input) {
      const serverId = id(input.serverId), profileId = id(input.profileId, 64);
      const channelId = input.channelId === undefined ? undefined : id(input.channelId);
      const name = string(input.name, 64).trim(), revision = input.revision;
      if (!name || [...name].length > 32 || /[\p{Cc}\p{Cs}]/u.test(name) ||
          !Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) fail('INVALID_INPUT');
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const value = await client.protectedNickname(connection, profileId, channelId, { name, revision });
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      protectedRosterReads.delete(connection);
      send('membership-changed', { serverId, nickname: { profileId, name: value.name } });
      return value;
    },
    async 'roster.protected.mentions'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const page = await client.readProtectedRuntimeRoster(connection, channelId, input.after, input.revision, true);
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      return page;
    },
    async 'moderation.protected.timeout.read'(input) {
      const serverId = id(input.serverId), profileId = id(input.profileId, 64);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      return client.readProtectedTimeout(connection, profileId);
    },
    async 'audit.protected.read'(input) {
      const serverId = id(input.serverId);
      const before = input.before === undefined ? undefined : id(input.before);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      return client.readProtectedAudit(connection, before);
    },
    async 'audit.protected.retention'(input) {
      const serverId = id(input.serverId);
      const { days, expected, confirmShorter } = input;
      if (!Number.isSafeInteger(days) || days < 1 || days > 106751991167 ||
          !Number.isSafeInteger(expected) || expected < 1 || typeof confirmShorter !== 'boolean') fail('INVALID_INPUT');
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      return client.changeProtectedAuditRetention(connection, { days, expected, confirmShorter });
    },
    async 'audit.protected.verifyOrder'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId), digest = id(input.digest, 64), actor = id(input.actor, 64);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const evidence = await client.readVerifiedProtectedChannelOrder(connection, channelId, digest);
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      if (evidence && evidence.authorProfileId !== actor) fail('INVALID_CHANNEL_ORDER_PROOF');
      return evidence !== null;
    },
    async 'moderation.protected.timeout.change'(input) {
      const serverId = id(input.serverId), profileId = id(input.profileId, 64);
      const operationId = id(input.operationId);
      const durationSeconds = input.durationSeconds;
      const reason = string(input.reason, 400).trim();
      if (!Number.isSafeInteger(durationSeconds) || durationSeconds !== 0 && (durationSeconds < 60 || durationSeconds > 2419200) ||
          !reason || [...reason].length > 200 || /[\p{Cc}\p{Cs}]/u.test(reason)) fail('INVALID_INPUT');
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const receipt = await client.changeProtectedTimeout(connection, profileId, { operationId, durationSeconds, reason });
      send('membership-changed', { serverId });
      return receipt;
    },
    async 'moderation.protected.cleanup.preview'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      return client.previewProtectedCleanup(connection, string(input.action, 5), id(input.profileId, 64), string(input.window, 4));
    },
    async 'moderation.protected.member.change'(input) {
      const serverId = id(input.serverId), profileId = id(input.profileId, 64);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const action = string(input.action, 5);
      const reason = string(input.reason ?? '', 400).trim();
      const cleanupId = input.cleanupId === undefined ? undefined : id(input.cleanupId);
      const result = await client.changeProtectedMembership(connection, action, profileId, { reason, expiresAt: input.expiresAt ?? 0, cleanupId });
      send('membership-changed', { serverId });
      return result;
    },
    async 'moderation.protected.bans'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      return client.listProtectedBans(connection, input.after === undefined ? undefined : id(input.after, 64));
    },
    async 'chat.protected.send'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId), operation = id(input.operationId);
      const text = string(input.text, 12288);
      const { replyTo, deferred } = input;
      if (replyTo !== undefined && (!Number.isSafeInteger(replyTo) || replyTo < 1)) fail('INVALID_INPUT');
      if (deferred !== undefined && (!Number.isSafeInteger(deferred?.revision) || deferred.revision < 1 ||
          deferred.revision >= Number.MAX_SAFE_INTEGER || id(deferred.head, 64) !== deferred.head)) fail('INVALID_INPUT');
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      return client.withCurrentProtectedChatPolicy(connection,
        options => client.sendProtectedRuntimeText(connection, channelId, text, operation, options, replyTo, input.checklist, input.poll, input.fileIds, input.mentions, deferred));
    },
    async 'protection.protected.read'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      if (input.offline !== undefined && typeof input.offline !== 'boolean') fail('INVALID_INPUT');
      const connection = protectedConnections.get(serverId);
      if (!connection || input.offline === true) {
        return client.readProtectedTextStatus(serverId, channelId, connection, input.offline === true);
      }
      return reuseProtectedRead(protectedStatusReads, connection, channelId, protectedLive.healthy(serverId) ? 8_000 : 0,
        () => client.readProtectedTextStatus(serverId, channelId, connection));
    },
    async 'channel.settings.protected.read'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      return client.readProtectedChannelSettings(connection, id(input.channelId));
    },
    async 'channel.acl.protected.read'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection?.policyTrust) fail('NOT_CONNECTED');
      return client.readProtectedChannelACL(connection, id(input.channelId));
    },
    async 'channel.acl.protected.commit'(input) {
      const serverId = id(input.serverId);
      const connection = protectedConnections.get(serverId);
      if (!connection?.policyTrust) fail('NOT_CONNECTED');
      if (!['text', 'voice'].includes(input.kind)) fail('INVALID_INPUT');
      const receipt = await client.commitProtectedChannelACL(connection, id(input.channelId), input.kind, id(input.policyHead, 64), input.rules);
      send('membership-changed', { serverId });
      return receipt;
    },
    async 'channel.acl.protected.personal.read'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection?.policyTrust) fail('NOT_CONNECTED');
      return client.readProtectedChannelPersonalACL(connection, id(input.channelId), id(input.profileId, 64));
    },
    async 'channel.acl.protected.personal.commit'(input) {
      const serverId = id(input.serverId);
      const connection = protectedConnections.get(serverId);
      if (!connection?.policyTrust) fail('NOT_CONNECTED');
      const receipt = await client.commitProtectedChannelPersonalACL(connection, id(input.channelId), id(input.profileId, 64),
        id(input.policyHead, 64), string(input.permission, 64), string(input.rule, 7));
      send('membership-changed', { serverId });
      return receipt;
    },
    async 'channel.settings.protected.commit'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      if (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings) ||
          Object.keys(input.settings).length !== 4) fail('INVALID_INPUT');
      return client.commitProtectedChannelSettings(connection, id(input.channelId), id(input.policyHead, 64), protectedChannelSettings(input.settings));
    },
    async 'channel.protected.manage'(input) {
      const serverId = id(input.serverId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      if (input.orderOnly === true) {
        const channelId = id(input.channelId);
        const { revision, categoryId, kind } = await client.verifyProtectedChannelOrderAuthority(connection, channelId);
        const { channels } = await client.readProtectedRuntimeState(connection);
        if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
        if (!channels.some(channel => channel.id === channelId && channel.canOrder && channel.categoryId === categoryId && channel.kind === kind)) {
          fail('PROTECTED_ACCESS_DENIED');
        }
        const siblings = channels.filter(channel => channel.id !== channelId && channel.canOrder && channel.categoryId === categoryId)
          .map(({ id, name }) => ({ id, name }));
        return { revision, siblings };
      }
      const { revision, snapshot, importedRoleNames, importedProfileNames } = await client.readProtectedManagementPolicy(connection);
      const categories = protectedCategories(snapshot);
      if (input.channelId === undefined) return { revision, categories,
        ...(input.creationAccess === true && {
          roles: (snapshot.Order ?? []).map(id => ({ id, name: protectedRoleName(snapshot, importedRoleNames, id) })),
          profiles: protectedEditableProfiles(snapshot, importedProfileNames).map(({ id, name }) => ({ id, name })),
        }) };
      const channel = snapshot.Channels?.[id(input.channelId)];
      if (!channel) fail('PROTECTED_ACCESS_DENIED');
      const acl = channelRules(snapshot, channel);
      const siblings = policyResourceOrder(snapshot.ChannelOrder, snapshot.Channels).filter(id => {
        const item = snapshot.Channels[id];
        return id !== input.channelId && (item.CategoryID ?? '') === (channel.CategoryID ?? '');
      }).map(id => ({ id, name: snapshot.Channels[id].Settings?.Name }));
      const candidates = input.personal === true ? protectedEditableProfiles(snapshot, importedProfileNames) : undefined;
      const editable = candidates && editableChannelACLProfiles(snapshot, channel, connection.profileId,
        candidates.map(profile => profile.id), connection.config?.protectedExplicitAdminView === true);
      const profiles = candidates?.filter(profile => editable.has(profile.id));
      return { revision, categories, siblings, totalChannels: Object.keys(snapshot.Channels).length, kind: channel.Kind, settings: channel.Settings, synchronized: channel.Synchronized,
        canSynchronize: !!channel.CategoryID && !channel.Synchronized,
        explicitAdminView: connection.config?.protectedExplicitAdminView === true,
        roles: ['@everyone', ...(snapshot.Order ?? []).slice().reverse()].map(id => ({
          id, name: protectedRoleName(snapshot, importedRoleNames, id), color: snapshot.RolePresentation?.[id]?.Color,
        })),
        rules: acl.Roles, ...(profiles && { profiles: profiles.map(({ id, name }) => ({
          id, name, ...(editable.get(id) === 'view' && { explicitViewOnly: true }),
        })),
          profileRules: Object.fromEntries(profiles.filter(profile => Object.hasOwn(acl.Profiles, profile.id))
            .map(profile => [profile.id, acl.Profiles[profile.id]])) }) };
    },
    async 'channel.protected.explain'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId), profileId = id(input.profileId, 64);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const { snapshot, importedRoleNames } = await readProtectedPolicyForEdit(connection, input.revision);
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      requireEditableProfile(snapshot, profileId);
      const channel = snapshot.Channels?.[channelId];
      if (!channel) fail('PROTECTED_ACCESS_DENIED');
      if (!permissionFitsACL(input.permission, channel.Kind)) fail('INVALID_INPUT');
      const { evidence } = channelGrantSummary(snapshot, profileId, channelId, input.permission, Date.now());
      return nameGrantSources(evidence, snapshot, importedRoleNames);
    },
    async 'channel.protected.preview'(input) {
      const serverId = id(input.serverId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      if (input.action === 'channel.order' && connection.policyTrust &&
          connection.profileId !== (connection.ownership?.ownerProfileId ?? connection.policyTrust.ownerProfileId)) {
        const channelId = id(input.channelId), anchorId = id(input.anchorId);
        if (channelId === anchorId || typeof input.after !== 'boolean' || !Number.isSafeInteger(input.revision) || input.revision < 1) fail('INVALID_INPUT');
        const intent = { Action: 'channel.order', OperationID: randomID(), ResourceChange: {
          ID: channelId, AnchorID: anchorId, ...(input.after && { After: true }), ...(input.mixedOrder === true && { MixedOrder: true }),
        } };
        return previewProtectedPolicy(serverId, connection, 'channel', channelId, intent, preview => {
          if (preview.draft.Revision !== input.revision + 1) fail('PROTECTED_POLICY_CHANGED');
        });
      }
      const basis = await readProtectedPolicyForEdit(connection, input.revision);
      const { snapshot, importedProfileNames } = basis;
      const intent = makeProtectedChannelIntent(input, snapshot);
      const channel = intent.ResourceChange.ID;
      const changes = input.changes ?? [input];
      const personal = input.action === 'channel.acl.personal' && changes.length === 1 ? changes[0] : undefined;
      const summary = personal?.profileId ? describeProfileAccess(basis, personal.profileId, channel, personal.permission) :
        ['channel.move', 'channel.acl.sync', 'channel.acl.update', 'channel.acl.personal'].includes(input.action)
          ? describeChannelAccess(snapshot, importedProfileNames, [channel]) : undefined;
      return previewProtectedPolicy(serverId, connection, 'channel', channel, intent, summary);
    },
    async 'channel.protected.commit'(input) {
      return { channelId: await commitProtectedPolicy(input, 'channel') };
    },
    async 'role.protected.manage'(input) {
      const serverId = id(input.serverId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const { revision, snapshot, importedRoleNames } = await client.readProtectedManagementPolicy(connection);
      const assignments = new Map();
      const ownRoles = snapshot.Members?.[connection.profileId]?.Roles ?? [];
      const highestOwnRole = (snapshot.Order ?? []).slice().reverse().find(role => ownRoles.includes(role));
      for (const member of Object.values(snapshot.Members ?? {})) {
        for (const role of member.Roles ?? []) assignments.set(role, (assignments.get(role) ?? 0) + 1);
      }
      const roles = ['@everyone', ...(snapshot.Order ?? [])].map(id => {
        const entry = snapshot.RolePresentation?.[id];
        return { id, name: protectedRoleName(snapshot, importedRoleNames, id), grants: snapshot.Roles[id].Grants ?? [],
          color: entry?.Color ?? '', icon: entry?.Icon ?? '', hoist: entry?.Hoist === true, mentionable: entry?.Mentionable === true,
          assigned: assignments.get(id) ?? 0,
          ...(snapshot.Owner !== connection.profileId && id === highestOwnRole && { ownHighestRole: true,
            ownRoleStyle: connection.config?.protectedOwnRoleStyle === true }),
        };
      });
      return { revision, roles };
    },
    async 'role.protected.preview'(input) {
      const serverId = id(input.serverId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const basis = await readProtectedPolicyForEdit(connection, input.revision);
      const { roleId, intent } = protectedRoleIntent(input, basis.snapshot);
      return previewProtectedPolicy(serverId, connection, 'role', roleId, intent, describeRoleAccess(basis, roleId, input.action === 'delete'));
    },
    async 'role.protected.order-preview'(input) {
      const serverId = id(input.serverId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const basis = await readProtectedPolicyForEdit(connection, input.revision);
      const original = basis.snapshot.Order ?? [];
      const order = input.order;
      if (!Array.isArray(order) || order.length !== original.length || new Set(order).size !== order.length ||
          order.some(role => !original.includes(role))) fail('INVALID_INPUT');
      const intent = { Action: 'roles.update', OperationID: randomID(), RoleUpdate: {
        Roles: basis.snapshot.Roles, Order: order, Assignments: null,
      } };
      return previewProtectedPolicy(serverId, connection, 'role', '@everyone', intent, describeRoleAccess(basis, undefined, false));
    },
    async 'role.protected.members-preview'(input) {
      const serverId = id(input.serverId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const basis = await readProtectedPolicyForEdit(connection, input.revision);
      const { snapshot } = basis;
      const role = input.roleId;
      if (typeof role !== 'string' || !(snapshot.Order ?? []).includes(role) ||
          typeof input.add !== 'boolean' || !Array.isArray(input.profiles) || !input.profiles.length ||
          input.profiles.length > 30 || new Set(input.profiles).size !== input.profiles.length) fail('INVALID_INPUT');
      const Assignments = Object.fromEntries(input.profiles.map(profile => {
        const profileId = id(profile, 64);
        requireEditableProfile(snapshot, profileId);
        const current = snapshot.Members[profileId].Roles ?? [];
        return [profileId, snapshot.Order.filter(candidate => candidate === role ? input.add : current.includes(candidate))];
      }));
      const intent = { Action: 'roles.update', OperationID: randomID(), RoleUpdate: {
        Roles: snapshot.Roles, Order: snapshot.Order, Assignments,
      } };
      return previewProtectedPolicy(serverId, connection, 'role', role, intent, describeRoleAccess(basis, role, false));
    },
    async 'role.protected.view'(input) {
      const serverId = id(input.serverId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const { snapshot, importedProfileNames } = await reuseProtectedRead(protectedRoleViewBasis, connection, input.revision,
        protectedLive.healthy(serverId) ? 5_000 : 0, () => readProtectedPolicyForEdit(connection, input.revision));
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      if (!Array.isArray(input.roles) || input.roles.length > (snapshot.Order ?? []).length ||
          new Set(input.roles).size !== input.roles.length || input.roles.some(role => !(snapshot.Order ?? []).includes(role)) ||
          typeof input.includeDraft !== 'boolean') fail('INVALID_INPUT');
      const { roleId, intent } = protectedRoleIntent({ ...input, action: 'save' }, snapshot);
      const roles = [...new Set([...input.roles, ...(input.includeDraft && roleId !== '@everyone' ? [roleId] : [])])];
      const policy = { ...snapshot, Roles: intent.RoleUpdate.Roles, Order: intent.RoleUpdate.Order };
      return roleViewProjection(policy, roles, importedProfileNames);
    },
    async 'role.protected.commit'(input) {
      return { roleId: await commitProtectedPolicy(input, 'role') };
    },
    async 'roles.scoped.basis'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection?.policyTrust) fail('NOT_CONNECTED');
      const { revision, policyHead, definitions, assignments, grantOptions } = await client.readScopedRoles(connection, input.profileId, input.channelId);
      if (assignments) return { revision, policyHead, roles: assignments };
      return { revision, policyHead, grantOptions: grantOptions ?? [], roles: definitions.map(({ id, grants, presentation }) => ({
        id, grants, name: presentation?.Name, color: presentation?.Color ?? '', icon: presentation?.Icon ?? '',
        hoist: presentation?.Hoist === true, mentionable: presentation?.Mentionable === true,
      })) };
    },
    async 'roles.scoped.preview'(input) {
      const serverId = id(input.serverId), connection = protectedConnections.get(serverId);
      if (!connection?.policyTrust) fail('NOT_CONNECTED');
      const basis = await client.readScopedRoles(connection, input.profileId, input.channelId);
      if (basis.revision !== input.revision || basis.policyHead !== input.policyHead) fail('PROTECTED_POLICY_CHANGED');
      const change = { revision: basis.revision, policyHead: basis.policyHead };
      if (basis.assignments) {
        const roles = input.roles;
        if (!Array.isArray(roles) || new Set(roles).size !== roles.length ||
            roles.some(id => !basis.assignments.some(role => role.id === id && (role.assigned || role.canAssign)))) fail('INVALID_INPUT');
        Object.assign(change, { targetProfileId: basis.targetProfileId, rosterChannelId: basis.rosterChannelId,
          add: basis.assignments.filter(role => !role.assigned && roles.includes(role.id)).map(role => role.id),
          remove: basis.assignments.filter(role => role.assigned && !roles.includes(role.id)).map(role => role.id) });
      } else {
        const { roleId, intent } = protectedRoleIntent(input, {
          Roles: Object.fromEntries(basis.definitions.map(role => [role.id, { Grants: role.grants }])),
          Order: basis.definitions.filter(role => role.id !== '@everyone').map(role => role.id),
        });
        if (input.action === 'delete') change.delete = [roleId];
        else {
          change.definitions = [{ id: roleId, grants: intent.RoleUpdate.Roles[roleId].Grants,
            presentation: intent.RoleUpdate.Presentation[roleId] }];
          change.order = intent.RoleUpdate.Order;
        }
      }
      const impact = await client.previewScopedRoles(connection, change);
      if (protectedConnections.get(serverId) !== connection) fail('NOT_CONNECTED');
      const previewId = randomID();
      protectedPolicyPreviews.set(serverId, { previewId, connection, kind: 'scoped-role', change, until: Date.now() + 60_000 });
      return { previewId, scopedImpact: impact };
    },
    async 'roles.scoped.commit'(input) {
      const serverId = id(input.serverId), previewId = id(input.previewId);
      const ready = protectedPolicyPreviews.get(serverId);
      if (ready?.previewId !== previewId || ready.kind !== 'scoped-role' || ready.until <= Date.now() ||
          protectedConnections.get(serverId) !== ready.connection) fail('PROTECTED_PREVIEW_EXPIRED');
      await client.commitScopedRoles(ready.connection, previewId, ready.change);
      if (protectedPolicyPreviews.get(serverId) === ready) protectedPolicyPreviews.delete(serverId);
      send('membership-changed', { serverId });
    },
    async 'member.protected.roles'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      const { revision, snapshot, importedProfileNames, importedRoleNames } = await client.readProtectedManagementPolicy(connection);
      const owner = snapshot.Members?.[snapshot.Owner];
      return { revision, profiles: protectedEditableProfiles(snapshot, importedProfileNames),
        ...(owner?.Active && { owner: { id: snapshot.Owner, name: importedProfileNames?.[snapshot.Owner] ?? (snapshot.Owner === connection.profileId ? t('Вы') : undefined), roles: owner.Roles ?? [], readOnly: true } }),
        roles: (snapshot.Order ?? []).map(id => ({ id, name: protectedRoleName(snapshot, importedRoleNames, id) })) };
    },
    async 'member.protected.roles.preview'(input) {
      const serverId = id(input.serverId), profileId = id(input.profileId, 64);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const basis = await readProtectedPolicyForEdit(connection, input.revision);
      const { snapshot } = basis;
      requireEditableProfile(snapshot, profileId);
      const { roles } = input;
      if (!Array.isArray(roles) || roles.length > (snapshot.Order ?? []).length ||
          new Set(roles).size !== roles.length || roles.some(role => typeof role !== 'string' ||
            role === '@everyone' || !Object.hasOwn(snapshot.Roles, role))) fail('INVALID_INPUT');
      const intent = { Action: 'roles.update', OperationID: randomID(), RoleUpdate: {
        Roles: snapshot.Roles, Order: snapshot.Order,
        Assignments: { [profileId]: (snapshot.Order ?? []).filter(role => roles.includes(role)) },
      } };
      return previewProtectedPolicy(serverId, connection, 'assignment', profileId, intent, describeProfileAccess(basis, profileId));
    },
    async 'member.protected.roles.commit'(input) {
      return { profileId: await commitProtectedPolicy(input, 'assignment') };
    },
    async 'category.protected.manage'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection) fail('NOT_CONNECTED');
      const { revision, snapshot, importedRoleNames, importedProfileNames } = await client.readProtectedManagementPolicy(connection);
      const categories = protectedCategories(snapshot).map(category => ({
        ...category, rules: snapshot.Categories[category.id],
        children: Object.values(snapshot.Channels ?? {}).filter(channel => channel.CategoryID === category.id).length,
      }));
      return { revision, categories, totalChannels: Object.keys(snapshot.Channels ?? {}).length,
        roles: ['@everyone', ...(snapshot.Order ?? []).slice().reverse()].map(id => ({
          id, name: protectedRoleName(snapshot, importedRoleNames, id), color: snapshot.RolePresentation?.[id]?.Color,
        })),
        profiles: protectedEditableProfiles(snapshot, importedProfileNames).map(({ id, name }) => ({ id, name })) };
    },
    async 'category.protected.preview'(input) {
      const serverId = id(input.serverId);
      const connection = protectedConnections.get(serverId);
      if (!connection) fail('NOT_CONNECTED');
      const { snapshot, importedProfileNames } = await readProtectedPolicyForEdit(connection, input.revision);
      const intent = makeProtectedCategoryIntent(input, snapshot);
      const category = intent.ResourceChange.ID;
      const channels = Object.keys(snapshot.Channels ?? {}).filter(id => snapshot.Channels[id].CategoryID === category);
      const summarize = ['category.acl.update', 'category.delete'].includes(input.action)
        ? describeChannelAccess(snapshot, importedProfileNames, channels) : undefined;
      return previewProtectedPolicy(serverId, connection, 'category', category, intent, summarize);
    },
    async 'category.protected.commit'(input) {
      return { categoryId: await commitProtectedPolicy(input, 'category') };
    },
    async 'chat.unwatch'(input){return live.unwatch(id(input.subscriptionId));},
    async messages(input) { return client.messages(id(input.serverId), id(input.channelId), input.options || {}); },
    async send(input) { return client.send(id(input.serverId), id(input.channelId), input.content, input.original, input.requestId===undefined?undefined:id(input.requestId)); },
    async upload(input) {
      if (!(input.bytes instanceof Uint8Array) || input.bytes.length > 2 * 1024 * 1024) fail('INVALID_IMAGE');
      return client.uploadImage(id(input.serverId), id(input.channelId), input.bytes, string(input.mime, 32));
    },
    async 'gif.resolve'(input){return require('./gif-link.cjs').resolveGifCached(string(input.url,2048));},
    async 'gif.load'(input){return require('./gif-link.cjs').loadGifMediaCached(string(input.url,2048));},
    async 'checklist.state'(input){if(!Number.isSafeInteger(input.messageId)||input.messageId<1)fail('INVALID_INPUT');return client.request(id(input.serverId),'/api/v2/messages/'+input.messageId+'/checklist');},
    async 'checklist.check'(input){if(!Number.isSafeInteger(input.messageId)||input.messageId<1||typeof input.checked!=='boolean')fail('INVALID_INPUT');return client.request(id(input.serverId),'/api/v2/messages/'+input.messageId+'/checklist','PUT',{item:id(input.item),checked:input.checked,requestId:id(input.requestId)});},
    async 'upload.file'(input){if(!(input.bytes instanceof Uint8Array)||input.bytes.length>50*1024*1024)fail('INVALID_INPUT');return client.uploadFile(id(input.serverId),id(input.channelId),input.bytes,string(input.mime,32));},
    async 'file'(input){return client.file(id(input.serverId),id(input.channelId),id(input.attachmentId));},
    async image(input) { return client.image(id(input.serverId), id(input.channelId), id(input.attachmentId), string(input.mime, 32)); },
    async profile(input) { return client.profile(id(input.serverId), string(input.nickname, 64), input.avatar, input.expectedRevision); },
    async invite(input) {
      const serverId = id(input.serverId), kind = string(input.kind, 16);
      const protectedConnection = protectedConnections.get(serverId);
      let link;
      if (protectedConnection) {
        if (!['single', 'reusable'].includes(kind)) fail('INVALID_INVITE');
        ({ link } = await client.createProtectedInvite(protectedConnection, kind === 'single'
          ? { maxUses: 1 } : { maxUses: 0, expiresAt: Date.now() + 3_600_000 }));
      } else {
        if (await client.loadProtectedRuntimeTrust?.(serverId)) fail('NOT_CONNECTED');
        link = await client.invite(serverId, kind);
      }
      return shareInvite(link, serverId);
    },
    async 'invite.protected.list'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      const before = input.before === undefined ? undefined : id(input.before);
      if (!connection) fail('NOT_CONNECTED');
      const { invites, canCreate, next } = await client.listProtectedInvites(connection, before);
      return { invites, canCreate, next };
    },
    async 'invite.protected.create'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      const { expiresAt, maxUses } = input;
      if (!Number.isSafeInteger(expiresAt) || expiresAt < 0 || expiresAt > 8_640_000_000_000_000 ||
          !Number.isSafeInteger(maxUses) || maxUses < 0) fail('INVALID_INPUT');
      if (!connection) fail('NOT_CONNECTED');
      const result = await client.createProtectedInvite(connection, { expiresAt, maxUses });
      return { ...result, link: shareInvite(result.link, connection.serverId) };
    },
    async 'invite.protected.revoke'(input) {
      const connection = protectedConnections.get(id(input.serverId));
      const inviteId = id(input.inviteId);
      if (!connection) fail('NOT_CONNECTED');
      await client.revokeProtectedInvite(connection, inviteId);
      return true;
    },
    async leave(input) {
      const serverId=id(input.serverId),host=getHost?.();
      // stopHost emits serverEnded synchronously; pending requests may finish later.
      intentionalDepartures.add(serverId);clearNotifications(serverId);live.remove(serverId);protectedLive.remove(serverId);snapshots.delete(serverId);
      try {
        if(activeVoice?.serverId===serverId||preparedVoice?.serverId===serverId)await voiceLeave();
        if(host?.running&&host.serverId===serverId){if(!stopHost)fail('HOST_UNAVAILABLE');await stopHost();await client.forget(serverId);}
        else {
          const protectedConnection = protectedConnections.get(serverId);
          await client.leave(serverId,{defer:statuses.get(serverId)!=='online', ...(protectedConnection && { protectedConnection })});
          protectedConnections.delete(serverId);
        }
        statuses.delete(serverId);send('membership-changed',{serverId});return true;
      } catch (error) {
        intentionalDepartures.delete(serverId);
        const record = knownRecords.get(serverId);
        if (error.code === 'INVALID_PROTECTED_SESSION' && record && protectedConnections.has(serverId)) {
          await connectRecord(record, true);
        }
        throw error;
      }
    },
    async voice(input) {
      const serverId=id(input.serverId),channelId=id(input.channelId);if(voiceBusy||addressChanges.has(serverId))fail('BUSY');voiceBusy=true;
      try{await voiceLeave();const epoch=voiceEpoch,access=await client.voice(serverId,channelId);
        if(epoch!==voiceEpoch){try{await client.request(serverId,'/api/v2/voice/leave','POST',{});}catch{}fail('CANCELLED');}
        preparedVoice={serverId,channelId};try{access.url=await setVoiceEndpoint(access.url,client.connections.get(serverId)?.fingerprint)||access.url;if(epoch!==voiceEpoch)fail('CANCELLED');return access;}catch(error){await voiceLeave();throw error;}
      }finally{voiceBusy=false;}
    },
    async voiceConnected(input) { const serverId=id(input.serverId),channelId=id(input.channelId);if(preparedVoice?.serverId!==serverId||preparedVoice.channelId!==channelId)fail('VOICE_NOT_PREPARED');activeVoice = preparedVoice;preparedVoice=undefined; return true; },
    async 'voice.protected.join'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      const connection = protectedConnections.get(serverId);
      if (!connection?.config.protectedVoice) fail('NOT_CONNECTED');
      if (voiceBusy || addressChanges.has(serverId)) fail('BUSY');
      voiceBusy = true;
      try {
        await voiceLeave();
        const epoch = voiceEpoch;
        const pending = { serverId, channelId, connection };
        preparedVoice = pending;
        try {
          const access = await client.joinProtectedRuntimeVoice(connection, channelId, connection.policyTrust);
          if (epoch !== voiceEpoch || preparedVoice !== pending) fail('CANCELLED');
          const result = await protectedVoiceAccess(access, connection);
          if (epoch !== voiceEpoch || preparedVoice !== pending) {
            await setVoiceEndpoint(null);
            fail('CANCELLED');
          }
          pending.gateway = access.url;
          pending.endpoint = result.url;
          activeVoice = pending; preparedVoice = undefined;
          return result;
        } catch (error) {
          if (preparedVoice === pending) await voiceLeave();
          else await client.leaveProtectedRuntimeVoice(connection).catch(() => {});
          throw error;
        }
      } finally { voiceBusy = false; }
    },
    async 'voice.protected.refresh'(input) {
      const epochId = input.epochId === null ? null : id(input.epochId);
      const voice = activeProtectedVoice(input), { connection } = voice;
      try {
        const result = await client.refreshProtectedRuntimeVoiceKey(connection, voice.channelId, connection.policyTrust, epochId);
        if (activeVoice !== voice) fail('CANCELLED');
        return result;
      } catch (error) {
        if (error.code === 'VOICE_SLOT_LOST' && await pendingProtectedVoiceMove(voice)) fail('VOICE_MOVE_READY');
        throw error;
      }
    },
    async 'voice.protected.reconnect'(input) {
      const voice = activeProtectedVoice(input), { connection } = voice;
      const destination = await pendingProtectedVoiceMove(voice);
      const channelId = destination || voice.channelId;
      const result = destination
        ? await client.joinProtectedRuntimeVoice(connection, channelId, connection.policyTrust)
        : await client.reconnectProtectedRuntimeVoice(connection, channelId, connection.policyTrust);
      if (activeVoice !== voice) fail('CANCELLED');
      if (result.url !== voice.gateway) fail('PAWTALK_MEDIA_ADDRESS');
      voice.channelId = channelId;
      voice.moveDestination = undefined;
      return { channelId, ...protectedVoiceAccessReply(result, voice.endpoint) };
    },
    async 'voice.protected.move-choices'(input) {
      const target = id(input.targetSessionId);
      const voice = protectedVoiceModerationScope(input);
      const choices = await client.protectedRuntimeVoiceMoveChoices(voice.connection, voice.channelId, target);
      if (protectedConnections.get(voice.serverId) !== voice.connection) fail('CANCELLED');
      return choices;
    },
    async 'voice.protected.restriction-choices'(input) {
      const target = id(input.targetSessionId);
      const voice = protectedVoiceModerationScope(input);
      const choices = await client.protectedRuntimeVoiceRestrictionChoices(voice.connection, voice.channelId, target);
      if (protectedConnections.get(voice.serverId) !== voice.connection) fail('CANCELLED');
      return choices.canDisconnect ? [...choices.actions, { action: 'voice.disconnect', lift: false }] : choices.actions;
    },
    async 'voice.protected.disconnect'(input) {
      const target = id(input.targetSessionId);
      const voice = protectedVoiceModerationScope(input);
      await client.disconnectProtectedRuntimeVoice(voice.connection, voice.channelId, target);
      return true;
    },
    async 'voice.protected.telemetry'(input) {
      const voice = activeProtectedVoice(input);
      const { rtt, loss, deafened, muted } = input;
      const valid = (value, max) => value === null || (Number.isFinite(value) && value >= 0 && value <= max);
      if (!valid(rtt, 60000) || !valid(loss, 100) || typeof deafened !== 'boolean' || typeof muted !== 'boolean') fail('INVALID_INPUT');
      const peers = await client.protectedRuntimeVoiceTelemetry(voice.connection, voice.channelId, { rtt, loss, deafened, muted }, true);
      if (activeVoice !== voice) fail('CANCELLED');
      return peers;
    },
    async 'voice.protected.restriction'(input) {
      if (!['voice.mute', 'voice.deafen'].includes(input.action) || typeof input.lift !== 'boolean' ||
          (input.serverWide !== undefined && typeof input.serverWide !== 'boolean')) fail('INVALID_INPUT');
      const target = id(input.targetSessionId);
      const voice = protectedVoiceModerationScope(input);
      await client.changeProtectedRuntimeVoiceRestriction(voice.connection, voice.channelId, target, input.action, input.lift, input.serverWide);
      return true;
    },
    async 'voice.protected.move'(input) {
      if (input.targetSessionId !== undefined) {
        if (input.profileId !== undefined) fail('INVALID_INPUT');
        const target = id(input.targetSessionId), destination = id(input.destinationChannelId);
        const voice = protectedVoiceModerationScope(input);
        await client.moveProtectedRuntimeVoiceSession(voice.connection, target, voice.channelId, destination);
        return true;
      }
      const connection = protectedConnections.get(id(input.serverId));
      if (!connection?.config.protectedVoice) fail('NOT_CONNECTED');
      await client.moveProtectedRuntimeVoice(connection, id(input.profileId, 64), id(input.sourceChannelId), id(input.destinationChannelId));
      return true;
    },
    async voiceLeave() { await voiceLeave(); return true; },
    async copyProfile(input) { const state = await client.state(id(input.serverId)); clipboard.writeText(state.self.effectiveProfileId); return true; },
    async copy(input) { clipboard.writeText(string(input.text)); return true; },
    async 'channel.order'(input) { if(!['text','voice'].includes(input.kind)||!Array.isArray(input.items)||input.items.length<1||input.items.length>1000)fail('INVALID_INPUT');const items=input.items.map(item=>{if(!item||!Number.isSafeInteger(item.revision)||item.revision<1)fail('INVALID_INPUT');return {id:id(item.id),revision:item.revision};});return client.request(id(input.serverId),'/api/v2/channel-order','POST',{kind:input.kind,items,requestId:randomID()}); },
    async 'channel.create'(input) { return client.request(id(input.serverId), '/api/v2/channels', 'POST', { kind: string(input.kind, 16), name: string(input.name, 128), requestId: randomID() }); },
    async 'channel.patch'(input) { return client.request(id(input.serverId), '/api/v2/channels/' + id(input.channelId), 'PATCH', { name: string(input.name, 128), position: input.position, expectedRevision: input.expectedRevision, requestId: randomID() }); },
    async 'channel.delete'(input) { return client.request(id(input.serverId), '/api/v2/channels/' + id(input.channelId), 'DELETE', { requestId: randomID() }); },
    async 'message.delete'(input) {
      if (!Number.isSafeInteger(input.messageId) || input.messageId <= 0) fail('INVALID_MESSAGE');
      return client.request(id(input.serverId), '/api/v2/messages/' + input.messageId, 'DELETE', { requestId: randomID() });
    },
    async 'role.set'(input) { return client.request(id(input.serverId), '/api/v2/members/' + id(input.profileId, 64) + '/role', 'PUT', { role: string(input.role, 16), requestId: randomID() }); },
    async 'member.kick'(input) { return client.request(id(input.serverId), '/api/v2/members/' + id(input.profileId, 64) + '/kick', 'POST', { requestId: randomID() }); },
    async 'member.ban'(input) { return client.request(id(input.serverId), '/api/v2/members/' + id(input.profileId, 64) + '/ban', 'POST', { expiresAt: input.expiresAt ?? null, reason: string(input.reason || '', 1024), requestId: randomID() }); },
    async 'invite.list'(input) { return client.request(id(input.serverId), '/api/v2/invites'); },
    async 'invite.revoke'(input) { return client.request(id(input.serverId), '/api/v2/invites/' + id(input.inviteId), 'DELETE', { requestId: randomID() }); },
    async 'ban.revoke'(input) { return client.request(id(input.serverId), '/api/v2/bans/' + id(input.banId), 'DELETE', { requestId: randomID() }); },
    async 'ban.list'(input) { return client.request(id(input.serverId), '/api/v2/bans'); },
    async 'link.start'(input) { return links.start(id(input.serverId)); },
    async 'link.propose'(input) { return links.propose(string(input.text), string(input.nickname, 64), string(input.deviceLabel || t('Компьютер'), 64), input.chosen || 'target'); },
    async 'link.pending'() {
      links.prune();for(const linkId of linkAlerts)if(!links.pending.has(linkId))linkAlerts.delete(linkId);const pending=[];
      for(const [linkId,ctx] of links.pending){
        if(ctx.side!=='target')continue;
        try{const check=linkChecks.get(linkId),serverId=ctx.connection.config.serverId;const status=live.healthy(serverId)&&check&&Date.now()-check.at<30000?check.status:await links.status(linkId);linkChecks.set(linkId,{at:check?.status===status?check.at:Date.now(),status});
          if(status.state==='proposed'){
            pending.push({linkId,serverId:ctx.connection.config.serverId});
            if(!linkAlerts.has(linkId)){linkAlerts.add(linkId);const win=getWindow();if(win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();}}
          }else if(['cancelled','expired','confirmed'].includes(status.state)){links.pending.delete(linkId);linkAlerts.delete(linkId);}
        }catch(error){if(['LINK_EXPIRED','LINK_NOT_FOUND'].includes(error.code)){links.pending.delete(linkId);linkAlerts.delete(linkId);}}
      }return pending;
    },
    async 'link.cancel'(input){return links.cancel(id(input.linkId));},
    async 'link.status'(input) { return links.status(id(input.linkId)); },
    async 'link.approve'(input) { return links.approve(id(input.linkId)); },
    async 'link.finish'(input) { const result = await links.finish(id(input.linkId)); intentionalDepartures.delete(result.serverId);departed.delete(result.serverId);send('membership-changed', {}); return result; },
    async 'device.unlink'(input) { return links.unlink(id(input.serverId), id(input.deviceId, 64), false); },
    async 'device.revoke'(input) { return links.unlink(id(input.serverId), id(input.deviceId, 64), true); },
    async 'control.create'(input) { return links.transferCreate(id(input.serverId), id(input.deviceId, 64)); },
    async 'control.accept'(input) { return links.transferAccept(id(input.serverId), string(input.text, 4096)); },
    async 'control.finish'(input) { const value=await links.transferFinish(id(input.serverId), string(input.text, 4096)); send('membership-changed', {}); return value; },
    async 'memory.status'(){return{low:!!getMemoryPressure()};},
    async 'notify.reconcile'(input) {
      const serverId = id(input.serverId), channelId = id(input.channelId);
      const key = serverId + ':' + channelId;
      const batch = notificationBatches.get(key), shown = shownNotifications.get(key);
      const entries = [batch, shown].filter(entry => entry && !entry.connection && entry.previewId > 0);
      if (!entries.length || !client.connections.has(serverId)) return;
      const { removed } = input;
      if (removed !== undefined && (!Array.isArray(removed) || removed.length > 4000 ||
          removed.some(position => !Number.isSafeInteger(position) || position < 1))) fail('INVALID_INPUT');
      const ids = [...new Set(entries.map(entry => entry.previewId))];
      const missing = removed ?? await client.messages(serverId, channelId, { ids })
        .then(page => ids.filter(id => !page.messages.some(message => message.id === id)));
      if (batch && notificationBatches.get(key) === batch && missing.includes(batch.previewId)) cancelNotificationBatch(key);
      if (shown && !shown.connection && shownNotifications.get(key) === shown && missing.includes(shown.previewId)) closeNotification(key);
    },
    async 'notify.read'(input){
      const serverId=id(input.serverId),channelId=id(input.channelId),read=input.messageId;if(!Number.isSafeInteger(read)||read<0)fail('INVALID_INPUT');
      const key=serverId+':'+channelId;notificationReads.set(key,Math.max(notificationReads.get(key)||0,read));if(notificationReads.size>2048)notificationReads.delete(notificationReads.keys().next().value);
      const batch=notificationBatches.get(key);if(batch&&alreadyRead(key,batch))cancelNotificationBatch(key);
      const shown=shownNotifications.get(key);if(shown&&alreadyRead(key,shown))closeNotification(key);
      return true;
    },
    async notify(input) {
      const serverId = id(input.serverId), channelId=id(input.channelId); if (!client.connections.has(serverId) || (!input.mention&&(getWindow()?.isFocused()))) return false;
      if(input.mention!==undefined&&typeof input.mention!=='boolean')fail('INVALID_INPUT');
      const notificationKey=serverId+':'+channelId;
      if(input.messageId!==undefined){if(!Number.isSafeInteger(input.messageId)||input.messageId<1)fail('INVALID_INPUT');}
      if(input.lastMessageId!==undefined&&(!Number.isSafeInteger(input.lastMessageId)||input.lastMessageId<(input.messageId||1)))fail('INVALID_INPUT');
      const last=input.lastMessageId||input.messageId||0;
      if(last&&((notified.get(notificationKey)||0)>=last||(notificationReads.get(notificationKey)||0)>=last))return false;
      const channelName=string(input.channelName,128).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').trim();
      const author=string(input.authorName||t('Участник'),128).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').trim();
      const avatar=input.authorAvatar===undefined?undefined:string(input.authorAvatar,12000);
      if(input.hasImage!==undefined&&typeof input.hasImage!=='boolean')fail('INVALID_INPUT');
      const text=messagePreview(string(input.text||'',4096),t('Спойлер'));
      if(input.batchCount!==undefined&&(!Number.isSafeInteger(input.batchCount)||input.batchCount<1||input.batchCount>1000000))fail('INVALID_INPUT');
      const content=[input.hasImage?t('Изображение'):'',text].filter(Boolean).join(' · ');
      if(!content)return false;
      const preview=Array.from(content).slice(0,240).join('')+(Array.from(content).length>240?'…':'');
      const existing=notificationBatches.get(notificationKey);
      if(existing&&last&&existing.last>=last)return false;
      const alertMention=!!input.mention||!!existing?.mention,alertAuthor=existing?.mention&&!input.mention?existing.author:author,alertPreview=existing?.mention&&!input.mention?existing.preview:preview;
      const alertAvatar=existing?.mention&&!input.mention?existing.avatar:avatar;
      const first=existing?.first||Date.now(),count=(existing?.count||0)+(input.batchCount||1);
      const previewId=existing?.mention&&!input.mention?existing.previewId:input.messageId||last;
      if(existing)cancelNotificationBatch(notificationKey);
      if(!existing&&notificationBatches.size>=128)cancelNotificationBatch(notificationBatches.keys().next().value);
      return new Promise(resolve=>{
        const batch={first,count,mention:alertMention,author:alertAuthor,avatar:alertAvatar,preview:alertPreview,previewId,last,cancelled:false,resolve,timer:undefined};
        const eligible=()=>!stopped&&!batch.cancelled&&notificationBatches.get(notificationKey)===batch&&Date.now()-first<30000&&client.connections.has(serverId)&&!intentionalDepartures.has(serverId)&&!alreadyRead(notificationKey,batch)&&(!last||(notified.get(notificationKey)||0)<last)&&!(!alertMention&&getWindow()?.isFocused());
        batch.timer=setTimeout(()=>{void(async()=>{
          if(!eligible())return false;
          const record=(await client.registry()).find(record=>record.serverId===serverId);
          // Reading, focus or leaving can change while registry I/O is pending.
          if(!eligible())return false;
          const title=`${record?.name||'PawTalk'} · #${channelName}`,body=(count>1?t('Новых сообщений: {0}',count)+' · ':'')+`${alertAuthor}: ${alertPreview}`;
          const appearance=Notification?.isSupported()
            ? await notificationAppearance({avatar:alertAvatar,authorName:alertAuthor,title,body}).catch(()=>({})) : {};
          if(!eligible())return false;
          if(last){notified.set(notificationKey,last);if(notified.size>2048)notified.delete(notified.keys().next().value);}
          const notification=Notification?.isSupported()
            ? new Notification({id:notificationID(notificationKey),groupId:notificationID(serverId),silent:true,title,body,...appearance}) : undefined;
          const activeCount = (shownNotifications.get(notificationKey)?.count ?? 0) + count;
          closeNotification(notificationKey, false);if(shownNotifications.size>=128)closeNotification(shownNotifications.keys().next().value);
          shownNotifications.set(notificationKey,{notification,last,previewId,count:activeCount});
          updateNotificationCount();
          // Windows prepares toasts asynchronously after show() returns. A read
          // can arrive before the shell displays it, so dismiss that late show too.
          notification?.on('show',()=>{if(stopped||shownNotifications.get(notificationKey)?.notification!==notification||alreadyRead(notificationKey,{last,previewId})||!client.connections.has(serverId)||intentionalDepartures.has(serverId)||!alertMention&&getWindow()?.isFocused()){if(shownNotifications.get(notificationKey)?.notification===notification)closeNotification(notificationKey);else try{notification.close?.();}catch{}}});
          // Keep the object after native timeout: it can still be in Action Center.
          notification?.on('click',()=>{const win=getWindow();if(win&&!win.isDestroyed()){win.show();win.focus();send('membership-open-channel',{serverId,channelId});}});notification?.show();return true;
        })().then(resolve,()=>resolve(false)).finally(()=>{if(notificationBatches.get(notificationKey)===batch)notificationBatches.delete(notificationKey);});},Math.max(0,Math.min(250,first+1000-Date.now())));
        notificationBatches.set(notificationKey,batch);
      });
    },
  };
  ipcMain.handle('membership', async (event, action, input = {}) => {
    authorized(event);
    try {
      if (typeof action !== 'string' || !Object.hasOwn(actions, action) || !input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_ACTION');
      const run = () => actions[action](input);
      return { value: await (client.diagnostics ? client.diagnostics.action(action, run) : run()) };
    } catch (failure) {
      if(typeof input?.serverId==='string')await reportDeparture(input.serverId,failure);
      const code = typeof failure.code === 'string' && /^[A-Z_]{1,64}$/.test(failure.code) ? failure.code : 'CONNECTION_FAILED';
      if (code === 'PROTECTED_RECOVERY_REQUIRED' && Array.isArray(failure.details?.recoveryProfiles) &&
          failure.details.recoveryProfiles.every(profile => typeof profile === 'string' && /^[a-f0-9]{64}$/.test(profile))) {
        return { error: { code, recoveryProfiles: failure.details.recoveryProfiles } };
      }
      if (code === 'RATE_LIMIT' && Number.isInteger(failure.retryAfter) && failure.retryAfter >= 1 && failure.retryAfter <= 60) {
        return { error: { code, retryAfter: failure.retryAfter } };
      }
      return { error: { code } };
    }
  });
  return { start() { void background(); }, stop() {
    stopped = true;
    for (const connection of protectedConnections.values()) client.clearProtectedPushedKeys?.(connection);
    protectedPolicyPreviews.clear();clearNotifications();live.stop();protectedLive.stop();clearTimeout(timer);void voiceLeave();
  }, suspend() { protectedLive.stop();void voiceLeave(); },
    async serverEnded(serverId) { clearNotifications(serverId);live.remove(serverId);protectedLive.remove(serverId);snapshots.delete(serverId);protectedConnections.delete(serverId);protectedPendingConnections.delete(serverId);intentionalDepartures.add(serverId);knownRecords.delete(serverId);if(activeVoice?.serverId===serverId||preparedVoice?.serverId===serverId){await voiceLeave();send('membership-voice-lost',{serverId});} await client.forget(serverId);statuses.delete(serverId);send('membership-changed',{serverId}); },statuses };
}
module.exports = { registerMembershipIPC };
