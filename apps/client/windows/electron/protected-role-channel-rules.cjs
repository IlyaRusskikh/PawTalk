const { createHash } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { textRecipientBlind, verifyChannelPolicyProof, profileRoleAuthorityProjectionVersion,
  scopedChannelRoleProjectionDigest } = require('./protected-channel-policy-commitments.cjs');

const permissions = ['channel.view', 'history.full', 'voice.connect', 'voice.speak', 'message.send'];
const invalid = () => Object.assign(new Error('INVALID_CHANNEL_ROLE_RULE_PROOF'), { code: 'INVALID_CHANNEL_ROLE_RULE_PROOF' });
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const hash = (...parts) => {
  const digest = createHash('sha256');
  for (const part of parts) digest.update(part);
  return digest.digest();
};
const branch = (left, right) => hash(Buffer.from([1]), left, right);
const positionBit = (position, depth) => (position[depth >> 3] >> (7 - (depth & 7))) & 1;
const empty = new Array(257);
empty[256] = hash('pawtalk-channel-key-rule-empty-v1');
for (let depth = 255; depth >= 0; depth--) empty[depth] = branch(empty[depth + 1], empty[depth + 1]);

const positionFor = (channelId, subjectKind, id) => hash(signatureFrame('pawtalk-channel-key-rule-position-v1', channelId, subjectKind, id));
const maskFor = rule => permissions.reduce((mask, permission, index) => mask + 3 ** index *
  ((rule.Allow ?? []).includes(permission) ? 2 : (rule.Deny ?? []).includes(permission) ? 1 : 0), 0);
const leaf = (position, mask, salt) => hash(signatureFrame('pawtalk-channel-key-rule-leaf-v1', position.toString('hex'), String(mask), salt));
const ruleDigest = (channelId, kind, root) => hash(signatureFrame('pawtalk-channel-key-rules-v1', channelId, kind, root.toString('hex'))).toString('hex');


function subtree(leaves, start, end, depth) {
  if (start === end) return empty[depth];
  const first = leaves[start], last = leaves[end - 1];
  let fork = depth;
  while (fork < 256 && positionBit(first.position, fork) === positionBit(last.position, fork)) fork++;
  if (fork === 256 && end - start > 1) throw invalid();
  let digest = first.digest;
  if (fork < 256) {
    let low = start + 1, high = end - 1;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (positionBit(leaves[middle].position, fork)) high = middle;
      else low = middle + 1;
    }
    digest = branch(subtree(leaves, start, low, fork + 1), subtree(leaves, low, end, fork + 1));
  }
  for (let bit = fork - 1; bit >= depth; bit--) {
    digest = positionBit(first.position, bit) ? branch(empty[bit + 1], digest) : branch(digest, empty[bit + 1]);
  }
  return digest;
}

function scopedChannelRuleDigest(channelId, kind, acl, seedHex) {
  if (!hex(seedHex) || !['text', 'voice'].includes(kind)) throw invalid();
  const seed = Buffer.from(seedHex, 'hex'), channel = Buffer.from(channelId);
  const leaves = [['role', acl?.Roles], ['profile', acl?.Profiles]].flatMap(([subjectKind, rules]) =>
    Object.entries(rules ?? {}).flatMap(([id, rule]) => {
      const mask = maskFor(rule);
      if (mask === 0) return [];
      const position = positionFor(channelId, subjectKind, id);
      const salt = textRecipientBlind(seed, channel, 27, position.toString('hex')).toString('hex');
      return [{ position, digest: leaf(position, mask, salt) }];
    }));
  return ruleDigest(channelId, kind, sparsePolicyRoot(leaves));
}

function sparsePolicyRoot(leaves) {
  const sorted = [...leaves].sort((a, b) => Buffer.compare(a.position, b.position));
  return subtree(sorted, 0, sorted.length, 0);
}

function verifyRule(digest, channelId, kind, subjectKind, id, proof) {
  const { mask, salt, path } = proof ?? {};
  if (!hex(digest) || !Number.isInteger(mask) || mask < 0 || mask >= 3 ** permissions.length ||
      (mask === 0 ? salt !== undefined : !hex(salt)) || !Array.isArray(path) || path.length > 256) throw invalid();
  const position = positionFor(channelId, subjectKind, id);
  const computed = openSparsePolicyRoot(position, mask === 0 ? empty[256] : leaf(position, mask, salt), path);
  if (ruleDigest(channelId, kind, computed) !== digest) throw invalid();
  return mask;
}

function openSparsePolicyRoot(position, leafDigest, path) {
  if (!Array.isArray(path) || path.length > 256) throw invalid();
  let previous = -1;
  for (const entry of path) {
    const { bit, digest } = entry ?? {};
    if (!Number.isInteger(bit) || bit <= previous || bit >= 256 || !hex(digest) || digest === empty[bit + 1].toString('hex')) throw invalid();
    previous = bit;
  }
  let computed = leafDigest, index = path.length - 1;
  for (let bit = 255; bit >= 0; bit--) {
    const sibling = path[index]?.bit === bit ? Buffer.from(path[index--].digest, 'hex') : empty[bit + 1];
    computed = positionBit(position, bit) ? branch(sibling, computed) : branch(computed, sibling);
  }
  return computed;
}

// profile is the result of a profile-role authority opening. It binds the
// complete role set, so a proof cannot omit a role with an applicable deny.
function verifyScopedChannelKeyAccess(attestation, channelId, kind, profileId, profile, basis, evidence) {
  if (attestation?.projectionVersion !== profileRoleAuthorityProjectionVersion || !hex(profileId) ||
      !['text', 'voice'].includes(kind) || typeof profile?.bypassesACL !== 'boolean' ||
      !Array.isArray(profile.roles) || !Array.isArray(profile.grants) || !evidence?.roles ||
      Object.keys(evidence.roles).length !== profile.roles.length + 1) throw invalid();
  const digest = basis?.rulesDigest;
  verifyChannelPolicyProof(attestation.root, channelId, scopedChannelRoleProjectionDigest(basis?.channelDigest, digest), basis?.inclusion);
  const forRole = id => verifyRule(digest, channelId, kind, 'role', id,
    Object.hasOwn(evidence.roles, id) ? evidence.roles[id] : undefined);
  const everyone = forRole('@everyone');
  const roles = profile.roles.map(forRole);
  const personal = verifyRule(digest, channelId, kind, 'profile', profileId, evidence.personal);
  const effective = permission => {
    if (profile.bypassesACL) return true;
    const factor = 3 ** permissions.indexOf(permission);
    const rule = mask => Math.floor(mask / factor) % 3;
    const apply = (value, current) => value === 2 || value === 0 && current;
    const base = apply(rule(everyone), profile.grants.includes(permission));
    const allowedByRole = roles.some(mask => rule(mask) === 2) || base && !roles.some(mask => rule(mask) === 1);
    return apply(rule(personal), allowedByRole);
  };
  const view = effective('channel.view');
  const connect = kind === 'voice' && view && effective('voice.connect');
  return { view, fullHistory: kind === 'text' && view && effective('history.full'), connect, speak: connect && effective('voice.speak'),
    canSend: kind === 'text' && view && effective('message.send') };
}

module.exports = { scopedChannelRuleDigest, scopedChannelRoleProjectionDigest, verifyScopedChannelKeyAccess, sparsePolicyRoot, openSparsePolicyRoot };
