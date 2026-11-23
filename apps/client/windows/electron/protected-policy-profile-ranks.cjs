const { createHash } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { profileRankProjectionVersion, profileACLBypassProjectionVersion, profileRoleAuthorityProjectionVersion,
  textNewcomerAdmissionProjectionVersion, auxiliaryPolicyDigest, scopedAuxiliaryPolicyDigest, hasTextRecipientProjection, textRecipientBlind,
  verifyChannelPolicyProof } = require('./protected-channel-policy-commitments.cjs');
const { sparsePolicyRoot, openSparsePolicyRoot } = require('./protected-role-channel-rules.cjs');

const profileRankProjection = '@pawtalk-profile-ranks';
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const invalid = () => Object.assign(new Error('INVALID_PROFILE_RANK_PROOF'), { code: 'INVALID_PROFILE_RANK_PROOF' });
const hash = (...parts) => {
  const digest = createHash('sha256');
  for (const part of parts) digest.update(part);
  return digest.digest();
};
const empty = hash(signatureFrame('pawtalk-policy-profile-rank-empty-v1'));

function positionBit(position, bit) {
  return (position[bit >> 3] >> (7 - (bit & 7))) & 1;
}

function profileRankLeaf(profileId, rank, salt, bypassesACL, roleAuthority) {
  if (!hex(profileId) || !Number.isSafeInteger(rank) || rank < 0 || !hex(salt)) throw invalid();
  const leaf = roleAuthority !== undefined
    ? signatureFrame('pawtalk-policy-profile-rank-leaf-v3', profileId, String(rank), String(bypassesACL), salt, roleAuthority)
    : bypassesACL === undefined
    ? signatureFrame('pawtalk-policy-profile-rank-leaf-v1', profileId, String(rank), salt)
    : signatureFrame('pawtalk-policy-profile-rank-leaf-v2', profileId, String(rank), String(bypassesACL), salt);
  return {
    position: hash(signatureFrame('pawtalk-policy-profile-rank-position-v1', profileId, salt)),
    digest: hash(leaf),
  };
}

const sortedSet = list => Array.isArray(list) && list.every((value, index) => typeof value === 'string' && value.length > 0 &&
  (index === 0 || Buffer.compare(Buffer.from(list[index - 1]), Buffer.from(value)) < 0));

function authorityFieldsDigest(domain, salt, fields) {
  if (!hex(salt)) throw invalid();
  const digest = createHash('sha256');
  for (const field of [domain, salt, ...fields]) digest.update(signatureFrame(field));
  return digest.digest('hex');
}

function authorityKeysDigest(salt, keys) {
  if (!hex(salt) || !Array.isArray(keys) || keys.some(key => !hex(key?.id) || !hex(key.publicKey) || Object.keys(key).length !== 3 ||
      !['device', 'recovery', 'signing'].includes(key.kind)) ||
      new Set(keys.map(key => `${key.kind}:${key.id}`)).size !== keys.length) throw invalid();
  return sparsePolicyRoot(keys.map(key => profileRoleKeyLeaf(
    hash(signatureFrame('pawtalk-profile-role-key-salt-v1', salt, key.kind, key.id)).toString('hex'), key.kind, key.id, key.publicKey,
  ))).toString('hex');
}

function profileRoleKeyLeaf(salt, kind, id, publicKey) {
  return { position: hash(signatureFrame('pawtalk-profile-role-key-position-v1', salt, kind, id)),
    digest: hash(signatureFrame('pawtalk-profile-role-key-leaf-v1', salt, kind, id, publicKey)) };
}

function verifyProfileSigningKey(root, deviceId, opening) {
  return verifyProfileKey(root, 'signing', deviceId, opening);
}

function verifyProfileAgreementKey(root, recipientId, opening, kind = 'device') {
  if (kind !== 'device' && kind !== 'recovery') throw invalid();
  return verifyProfileKey(root, kind, recipientId, opening);
}

function verifyProfileKey(root, kind, deviceId, opening) {
  if (!hex(root) || !hex(deviceId) || !hex(opening?.publicKey) || !hex(opening.salt)) throw invalid();
  const { position, digest } = profileRoleKeyLeaf(opening.salt, kind, deviceId, opening.publicKey);
  if (openSparsePolicyRoot(position, digest, opening.path).toString('hex') !== root) throw invalid();
  return opening.publicKey;
}

function authorityParts({ roles, grants, keys, recoveryReady, rolesSalt, grantsSalt, keysSalt, recoverySalt }) {
  const parts = {};
  if (roles !== undefined || rolesSalt !== undefined) {
    if (!sortedSet(roles)) throw invalid();
    parts.roles = authorityFieldsDigest('pawtalk-profile-role-ids-v1', rolesSalt, roles);
  }
  if (grants !== undefined || grantsSalt !== undefined) {
    if (!sortedSet(grants)) throw invalid();
    parts.grants = authorityFieldsDigest('pawtalk-profile-base-grants-v1', grantsSalt, grants);
  }
  if (keys !== undefined || keysSalt !== undefined) parts.keys = authorityKeysDigest(keysSalt, keys);
  if (recoveryReady !== undefined || recoverySalt !== undefined) {
    if (typeof recoveryReady !== 'boolean') throw invalid();
    parts.recoveryReady = authorityFieldsDigest('pawtalk-profile-role-recovery-v1', recoverySalt, [String(recoveryReady)]);
  }
  return parts;
}

function authorityDigest({ roles, grants, keys, recoveryReady }) {
  if (![roles, grants, keys, recoveryReady].every(hex)) throw invalid();
  return hash(signatureFrame('pawtalk-profile-role-authority-v1', roles, grants, keys, recoveryReady)).toString('hex');
}

function profileRoleKeys(snapshot) {
  const keys = new Map();
  const add = (profileId, key) => {
    if (!keys.has(profileId)) keys.set(profileId, []);
    keys.get(profileId).push(key);
  };
  for (const [id, item] of Object.entries(snapshot.KeyRecipients ?? {})) {
    add(item.ProfileID, { id, kind: item.Kind, publicKey: item.PublicKey });
  }
  for (const [id, item] of Object.entries(snapshot.PolicyDevices ?? {})) {
    if (!item.Revoked) add(item.ProfileID, { id, kind: 'signing', publicKey: item.PublicKey });
  }
  return keys;
}

function profileRoleOpening(snapshot, seed, profileId, roles, keys) {
  const sorted = list => [...new Set(list)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const grants = ['@everyone', ...roles].flatMap(id => Object.hasOwn(snapshot.Roles ?? {}, id) ? snapshot.Roles[id].Grants ?? [] : []);
  const salt = kind => textRecipientBlind(seed, Buffer.from(profileRankProjection), kind, profileId).toString('hex');
  return { roles: sorted(roles), grants: sorted(grants), keys, recoveryReady: snapshot.RecoveryReady?.[profileId] === true,
    rolesSalt: salt(24), grantsSalt: salt(25), keysSalt: salt(26), recoverySalt: salt(29) };
}

function branch(bit, left, right) {
  return hash(Buffer.from([1, bit]), left, right);
}

function subtree(leaves, start, end, bit) {
  if (end - start === 1) return leaves[start].digest;
  const first = leaves[start].position, last = leaves[end - 1].position;
  while (bit < 256 && positionBit(first, bit) === positionBit(last, bit)) bit++;
  if (bit === 256) throw invalid();
  let low = start + 1, high = end - 1;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (positionBit(leaves[mid].position, bit) === 0) low = mid + 1;
    else high = mid;
  }
  return branch(bit, subtree(leaves, start, low, bit + 1), subtree(leaves, low, end, bit + 1));
}

function profileRankRoot(snapshot, seedHex, version) {
  if (!hex(seedHex)) throw invalid();
  const seed = Buffer.from(seedHex, 'hex');
  const scope = Buffer.from(profileRankProjection);
  const order = new Map((snapshot.Order ?? []).map((role, index) => [role, index + 1]));
  const administrator = role => snapshot.Roles?.[role]?.Grants?.includes('server.administrator') === true;
  const roleKeys = version >= profileRoleAuthorityProjectionVersion ? profileRoleKeys(snapshot) : undefined;
  const leaves = Object.entries(snapshot.Members ?? {}).flatMap(([id, member]) => {
    if (member.Active !== true || (Object.hasOwn(snapshot.ProfileBindings ?? {}, id) && snapshot.ProfileBindings[id])) return [];
    if (member.ID !== id) throw invalid();
    const roles = member.Roles ?? [];
    const owner = id === snapshot.Owner;
    const rank = owner ? order.size + 1 : roles.reduce((top, role) => Math.max(top, order.get(role) ?? 0), 0);
    const bypassesACL = version >= profileACLBypassProjectionVersion
      ? owner || administrator('@everyone') || roles.some(administrator)
      : undefined;
    const salt = textRecipientBlind(seed, scope, 13, id).toString('hex');
    const roleAuthority = roleKeys && authorityDigest(authorityParts(profileRoleOpening(snapshot, seed, id, roles, roleKeys.get(id) ?? [])));
    return [profileRankLeaf(id, rank, salt, bypassesACL, roleAuthority)];
  });
  return policyTrieRoot(leaves, empty);
}

function policyTrieRoot(leaves, emptyDigest) {
  const sorted = [...leaves].sort((left, right) => Buffer.compare(left.position, right.position));
  return (sorted.length === 0 ? emptyDigest : subtree(sorted, 0, sorted.length, 0)).toString('hex');
}

function verifyRank(root, profileId, disclosure, version) {
  const { profileId: disclosed, rank, salt, path, bypassesACL, roleAuthority } = disclosure ?? {};
  if (disclosed !== profileId || !Array.isArray(path) || path.length > 256 ||
      (version >= profileACLBypassProjectionVersion ? typeof bypassesACL !== 'boolean' : bypassesACL !== undefined) ||
      (version >= profileRoleAuthorityProjectionVersion ? !hex(roleAuthority) : roleAuthority !== undefined)) throw invalid();
  const { position, digest } = profileRankLeaf(profileId, rank, salt, bypassesACL, roleAuthority);
  if (openPolicyTrieRoot(position, digest, path) !== root) throw invalid();
  return { rank, bypassesACL, roleAuthority };
}

function openPolicyTrieRoot(position, digest, path) {
  if (!Array.isArray(path) || path.length > 256) throw invalid();
  let previousBit = -1;
  for (const sibling of path) {
    if (!Number.isInteger(sibling?.bit) || sibling.bit <= previousBit || sibling.bit >= 256 || !hex(sibling.digest)) throw invalid();
    previousBit = sibling.bit;
  }
  let current = digest;
  for (let index = path.length - 1; index >= 0; index--) {
    const { bit, digest: sibling } = path[index];
    const other = Buffer.from(sibling, 'hex');
    current = positionBit(position, bit) === 0 ? branch(bit, current, other) : branch(bit, other, current);
  }
  return current.toString('hex');
}

function verifyProfileRoleAuthority(root, profileId, rankProof, opening, unopened = {}) {
  if (!opening || !unopened || Object.keys(opening).some(key => !['roles', 'grants', 'keys', 'recoveryReady', 'rolesSalt', 'grantsSalt', 'keysSalt', 'recoverySalt'].includes(key)) ||
      Object.keys(unopened).some(key => !['roles', 'grants', 'keys', 'recoveryReady'].includes(key))) throw invalid();
  const rank = verifyRank(root, profileId, rankProof, profileRoleAuthorityProjectionVersion);
  const opened = authorityParts(opening);
  if (Object.keys(opened).some(key => Object.hasOwn(unopened, key)) || rank.roleAuthority !== authorityDigest({ ...unopened, ...opened })) throw invalid();
  const verified = { rank: rank.rank, bypassesACL: rank.bypassesACL, keyRoot: opened.keys ?? unopened.keys };
  for (const key of Object.keys(opened)) verified[key] = opening[key];
  return verified;
}

function verifyAttestedProfileRoleAuthority(attestation, basis, profileId, opening, unopened) {
  if (attestation?.projectionVersion !== profileRoleAuthorityProjectionVersion || !hex(basis?.root) || !hex(basis.invites) || !hex(basis.catalogue)) throw invalid();
  const digest = auxiliaryPolicyDigest(basis.root, basis.invites, basis.catalogue, basis.rosters);
  verifyChannelPolicyProof(attestation.root, profileRankProjection, digest, basis.inclusion);
  return verifyProfileRoleAuthority(basis.root, profileId, basis.profile, opening, unopened);
}

function verifyPersonalACLTargetRank(attestation, evidence, actorId, targetId) {
  const version = attestation?.projectionVersion;
  if (!hasTextRecipientProjection(version) || version < profileRankProjectionVersion ||
      actorId === targetId || !hex(evidence?.root)) throw invalid();
  const digest = version >= textNewcomerAdmissionProjectionVersion
    ? scopedAuxiliaryPolicyDigest(version, evidence.root, evidence.invites, evidence.catalogue, evidence.rosters) : evidence.root;
  verifyChannelPolicyProof(attestation.root, profileRankProjection, digest, evidence.inclusion);
  const actor = verifyRank(evidence.root, actorId, evidence.actor, version);
  const target = verifyRank(evidence.root, targetId, evidence.target, version);
  if (actor.rank <= target.rank) throw invalid();
  return target.bypassesACL;
}

module.exports = { profileRankProjection, profileRankRoot, profileRoleAuthorityProjectionVersion, verifyPersonalACLTargetRank,
  verifyProfileRoleAuthority, verifyAttestedProfileRoleAuthority, verifyProfileSigningKey, verifyProfileAgreementKey, policyTrieRoot, openPolicyTrieRoot };
