const { createHash } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { textRecipientBlind } = require('./protected-channel-policy-commitments.cjs');
const { policyTrieRoot, openPolicyTrieRoot } = require('./protected-policy-profile-ranks.cjs');

const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const hash = value => createHash('sha256').update(value).digest();
const invalid = () => Object.assign(new Error('INVALID_SCOPED_ROLE_ROSTER'), { code: 'INVALID_SCOPED_ROLE_ROSTER' });
const empty = hash(signatureFrame('pawtalk-role-roster-empty-v1'));

function scopedRoleRosterAlias(channelId, salt) {
  if (!hex(channelId, 32) || !hex(salt, 64)) throw invalid();
  return hash(signatureFrame('pawtalk-role-roster-alias-v1', channelId, salt)).toString('hex');
}

function leaf(domain, id, ...fields) {
  return { position: hash(signatureFrame('pawtalk-role-roster-position-v1', domain, id)),
    digest: hash(signatureFrame(domain, id, ...fields)) };
}

function memberLeaf(alias, id, salt) {
  if (!hex(id, 64) || !hex(salt, 64)) throw invalid();
  const memberId = hash(signatureFrame(alias, id, salt)).toString('hex');
  return leaf('pawtalk-role-roster-member-v1', memberId, alias, id, salt);
}

function scopedRoleRosterRoot(seedHex, rosters) {
  if (!hex(seedHex, 64)) throw invalid();
  const seed = Buffer.from(seedHex, 'hex');
  const channels = rosters.map(([channelId, members]) => {
    const blind = (mode, id) => textRecipientBlind(seed, Buffer.from(channelId), mode, id).toString('hex');
    const alias = scopedRoleRosterAlias(channelId, blind(30, ''));
    const root = policyTrieRoot(members.map(id => memberLeaf(alias, id, blind(31, id))), empty);
    return leaf('pawtalk-role-roster-channel-v1', alias, root);
  });
  return policyTrieRoot(channels, empty);
}

function verifyScopedRoleRoster(root, alias, actorId, targetId, opening) {
  if (!hex(root, 64) || !hex(alias, 64) || !hex(opening?.root, 64) || actorId === targetId) throw invalid();
  const channel = leaf('pawtalk-role-roster-channel-v1', alias, opening.root);
  if (openPolicyTrieRoot(channel.position, channel.digest, opening.channelPath) !== root) throw invalid();
  for (const [id, member] of [[actorId, opening.actor], [targetId, opening.target]]) {
    const item = memberLeaf(alias, id, member?.salt);
    if (openPolicyTrieRoot(item.position, item.digest, member.path) !== opening.root) throw invalid();
  }
}

module.exports = { scopedRoleRosterAlias, scopedRoleRosterRoot, verifyScopedRoleRoster };
