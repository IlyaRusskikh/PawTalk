const { createHash } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { auxiliaryPolicyDigest, textRecipientBlind, verifyChannelPolicyProof } = require('./protected-channel-policy-commitments.cjs');
const { profileRankProjection, profileRoleAuthorityProjectionVersion } = require('./protected-policy-profile-ranks.cjs');
const { sparsePolicyRoot, openSparsePolicyRoot } = require('./protected-role-channel-rules.cjs');

const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const invalid = () => Object.assign(new Error('INVALID_SCOPED_ROLE_DEFINITION'), { code: 'INVALID_SCOPED_ROLE_DEFINITION' });
const hash = value => createHash('sha256').update(value).digest();
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const position = id => hash(signatureFrame('pawtalk-role-catalogue-position-v1', id));

function leaf(id, rank, grants, salt) {
  if (!Number.isSafeInteger(rank) || (id === '@everyone' ? rank !== 0 : rank < 1) || !hex(salt) || !Array.isArray(grants) ||
      grants.some((grant, index) => typeof grant !== 'string' || !grant || (index > 0 && compare(grants[index - 1], grant) >= 0))) throw invalid();
  const digest = createHash('sha256');
  for (const field of ['pawtalk-role-catalogue-grants-v1', salt, ...grants]) digest.update(signatureFrame(field));
  return hash(signatureFrame('pawtalk-role-catalogue-leaf-v1', id, String(rank), digest.digest('hex')));
}

function scopedRoleCatalogueRoot(snapshot, seedHex) {
  if (!hex(seedHex)) throw invalid();
  const rank = new Map((snapshot.Order ?? []).map((id, index) => [id, index + 1]));
  const seed = Buffer.from(seedHex, 'hex');
  const entries = Object.entries(snapshot.Roles ?? {}).map(([id, role]) => ({ position: position(id),
    digest: leaf(id, rank.get(id) ?? 0, [...new Set(role.Grants ?? [])].sort(compare), textRecipientBlind(seed, Buffer.alloc(0), 28, id).toString('hex')) }));
  return sparsePolicyRoot(entries).toString('hex');
}

function verifyScopedRoleDefinitions(attestation, auxiliary, roleIds, proofs) {
  if (attestation?.projectionVersion !== profileRoleAuthorityProjectionVersion || !hex(auxiliary?.catalogue) || !proofs ||
      Object.keys(proofs).length !== roleIds.length || new Set(roleIds).size !== roleIds.length) throw invalid();
  verifyChannelPolicyProof(attestation.root, profileRankProjection,
    auxiliaryPolicyDigest(auxiliary.root, auxiliary.invites, auxiliary.catalogue, auxiliary.rosters), auxiliary.inclusion);
  return new Map(roleIds.map(id => {
    const proof = Object.hasOwn(proofs, id) && proofs[id];
    if (!proof || Object.keys(proof).length !== 4) throw invalid();
    const digest = leaf(id, proof.rank, proof.grants, proof.salt);
    if (openSparsePolicyRoot(position(id), digest, proof.path).toString('hex') !== auxiliary.catalogue) throw invalid();
    return [id, { rank: proof.rank, grants: proof.grants }];
  }));
}

module.exports = { scopedRoleCatalogueRoot, verifyScopedRoleDefinitions };
