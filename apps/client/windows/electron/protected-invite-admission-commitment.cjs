const { createHash } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { commitmentRoot, rootFromCommitmentProof } = require('./protected-epoch-packages.cjs');
const { textRecipientBlind, textNewcomerAdmissionProjectionVersion, verifyChannelPolicyProof, scopedAuxiliaryPolicyDigest,
  hasTextRecipientProjection } =
  require('./protected-channel-policy-commitments.cjs');
const { profileRankProjection } = require('./protected-policy-profile-ranks.cjs');
const invalid = () => Object.assign(Error('INVALID_PROTECTED_INVITE_PROOF'), { code: 'INVALID_PROTECTED_INVITE_PROOF' });
const hexDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const hash = (...fields) => {
  const digest = createHash('sha256');
  for (const field of fields) digest.update(field);
  return digest.digest();
};

const present = hash('pawtalk-invite-credential-present-v1');
const branchPrefix = Buffer.from([1]);
const branch = (left, right) => hash(branchPrefix, left, right);
const empty = Array(257);
empty[256] = hash('pawtalk-invite-credential-empty-v1');
for (let depth = 255; depth >= 0; depth--) empty[depth] = branch(empty[depth + 1], empty[depth + 1]);

const keyBit = (position, depth) => Boolean(position[depth >> 3] & (0x80 >> (depth % 8)));
function credentialPosition(kind, id) {
  const valid = kind === 'invite-use' ? typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) :
    ['profile', 'device', 'agreement'].includes(kind) && hexDigest(id);
  if (!valid) throw invalid();
  return hash(signatureFrame('pawtalk-invite-credential-position-v1', kind, id));
}

function credentialTrie(leaves, start, end, depth) {
  if (start === end) return empty[depth];
  if (depth === 256) return leaves[start].digest;
  let left = start, right = end;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (keyBit(leaves[middle].position, depth)) right = middle;
    else left = middle + 1;
  }
  return branch(credentialTrie(leaves, start, left, depth + 1), credentialTrie(leaves, left, end, depth + 1));
}

function inviteUseLeaf(count, signature) {
  if (!Number.isSafeInteger(count) || count < 1 || typeof signature !== 'string' || !signature) throw invalid();
  return hash(signatureFrame('pawtalk-invite-use-leaf-v1', String(count), signature));
}

function inviteCredentialRoot(snapshot) {
  const keys = value => Object.keys(value ?? {});
  const bindings = Object.entries(snapshot.ProfileBindings ?? {});
  const recipients = Object.entries(snapshot.KeyRecipients ?? {});
  const profiles = new Set([...keys(snapshot.Members), ...keys(snapshot.MemberRemovals), ...bindings.flat()]);
  const devices = new Set([...keys(snapshot.PolicyDevices), ...keys(snapshot.DetachedPolicyDevices), ...keys(snapshot.ProfileDeviceOrigins)]);
  const agreements = new Set(Object.entries(snapshot.RetiredRecipientKeys ?? {}).filter(([, retired]) => retired).map(([id]) => id));
  for (const [id, entry] of recipients) {
    if (entry.Kind === 'device') devices.add(id);
    agreements.add(entry.PublicKey);
  }
  const leaves = [
    ...Array.from(profiles, id => credentialPosition('profile', id)),
    ...Array.from(devices, id => credentialPosition('device', id)),
    ...Array.from(agreements, id => credentialPosition('agreement', id)),
  ].map(position => ({ position, digest: present }));
  for (const [id, use] of Object.entries(snapshot.InvitationUses ?? {})) {
    leaves.push({ position: credentialPosition('invite-use', id), digest: inviteUseLeaf(use.Count, use.IssueSignature) });
  }
  leaves.sort((left, right) => Buffer.compare(left.position, right.position));
  return credentialTrie(leaves, 0, leaves.length, 0).toString('hex');
}

function verifyCredentialPath(root, kind, id, path, leaf) {
  if (!hexDigest(root) || !Array.isArray(path) || path.length > 256) throw invalid();
  const position = credentialPosition(kind, id);
  let digest = leaf, index = 0, previousDepth = 256;
  for (const opening of path) {
    const depth = opening?.depth;
    if (!Number.isInteger(depth) || depth < 0 || depth >= previousDepth || !hexDigest(opening.digest) ||
        opening.digest === empty[depth + 1].toString('hex')) throw invalid();
    previousDepth = depth;
  }
  for (let depth = 255; depth >= 0; depth--) {
    const sibling = path[index]?.depth === depth ? Buffer.from(path[index++].digest, 'hex') : empty[depth + 1];
    digest = keyBit(position, depth) ? branch(sibling, digest) : branch(digest, sibling);
  }
  if (digest.toString('hex') !== root) throw invalid();
}

function verifyFreshInviteCredential(root, kind, id, path) {
  if (kind === 'invite-use') throw invalid();
  verifyCredentialPath(root, kind, id, path, empty[256]);
}

function verifyInviteUse(root, id, opening, issueSignature, maxUses) {
  const { count, issueSignature: recordedSignature, path } = opening ?? {};
  if (!Number.isSafeInteger(maxUses) || maxUses < 0 || !Number.isSafeInteger(count) || count < 0 ||
      count >= Number.MAX_SAFE_INTEGER || (maxUses !== 0 && count >= maxUses) ||
      recordedSignature !== (count === 0 ? undefined : issueSignature)) throw invalid();
  const leaf = count === 0 ? empty[256] : inviteUseLeaf(count, recordedSignature);
  verifyCredentialPath(root, 'invite-use', id, path, leaf);
  return count;
}

function issuerLeaf(deviceId, profileId, signingKey, salt) {
  if (![deviceId, profileId, signingKey, salt].every(hexDigest) || hash(Buffer.from(signingKey, 'hex')).toString('hex') !== deviceId) throw invalid();
  return hash(signatureFrame('pawtalk-invite-issuer-v1', deviceId, profileId, signingKey, salt));
}

function inviteIssuerRoot(issuers, seedHex) {
  if (!hexDigest(seedHex)) throw invalid();
  const seed = Buffer.from(seedHex, 'hex');
  const leaves = issuers.map(({ deviceId, profileId, signingKey }) => issuerLeaf(deviceId, profileId, signingKey,
    textRecipientBlind(seed, Buffer.alloc(0), 23, deviceId).toString('hex')));
  return commitmentRoot(leaves.sort(Buffer.compare));
}

function inviteAdmissionDigest(issuers, credentials) {
  if (!hexDigest(issuers) || !hexDigest(credentials)) throw invalid();
  return hash(signatureFrame('pawtalk-invite-admission-projection-v1', issuers, credentials)).toString('hex');
}

function verifyInviteAdmissionProjection(attestation, evidence) {
  const version = attestation?.projectionVersion;
  if (!evidence || !hasTextRecipientProjection(version) || version < textNewcomerAdmissionProjectionVersion) throw invalid();
  const digest = inviteAdmissionDigest(evidence.issuers, evidence.credentials);
  const projection = scopedAuxiliaryPolicyDigest(version, evidence.ranks, digest, evidence.catalogue, evidence.rosters);
  verifyChannelPolicyProof(attestation.root, profileRankProjection, projection, evidence.inclusion);
}

function verifyInviteIssuer(root, actor, opening) {
  if (!opening || !hexDigest(root) || rootFromCommitmentProof(
    issuerLeaf(actor?.DeviceID, actor?.ProfileID, opening.signingKey, opening.salt), opening.proof, invalid) !== root) throw invalid();
  return opening.signingKey;
}

module.exports = { inviteCredentialRoot, verifyFreshInviteCredential, verifyInviteUse, inviteIssuerRoot, inviteAdmissionDigest,
  verifyInviteAdmissionProjection, verifyInviteIssuer };
