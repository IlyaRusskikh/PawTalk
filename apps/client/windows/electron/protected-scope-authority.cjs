const { createHash, createPublicKey, sign, verify } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { validRecoveryEd25519Key } = require('./protected-runtime-recovery.cjs');

const authorizeRecovery = 'recovery.authorize';
const transferDevice = 'recovery.device';
const transferOwner = 'owner.transfer';
const moveScopeDevice = 'scope.device';
const maxOwnerTransferCandidates = 8192;
const publicKeyHeader = Buffer.from('302a300506032b6570032100', 'hex');
const ed25519Field = (1n << 255n) - 19n;
const unsignedFields = ['sequence', 'previous', 'action', 'revision', 'policyHead', 'operationId', 'recoveryId', 'recoveryKey', 'deviceKey'];
const linkFields = new Set([...unsignedFields, 'authorization', 'deviceProof']);
const ownerTransferFields = new Set([...linkFields, 'targetProfileId', 'transfer']);
const deviceHandoverFields = new Set([...linkFields, 'sourceDeviceId', 'expiresAt']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const deviceIdFor = key => digest(Buffer.from(key, 'hex'));
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const invalid = (code = 'INVALID_SCOPE_AUTHORITY') => Object.assign(new Error(code), { code });

function validAuthorityKey(key) {
  if (!validRecoveryEd25519Key(key)) return false;
  const bytes = Buffer.from(key, 'hex').reverse();
  bytes[0] &= 0x7f;
  const y = BigInt(`0x${bytes.toString('hex')}`);
  const ySquared = y * y % ed25519Field;
  const numerator = (ySquared - 1n) * 121666n;
  const denominator = 121666n - 121665n * ySquared;
  // x² must be a nonzero quadratic residue. The denominator and its inverse
  // have the same quadratic character, so their product avoids an inversion.
  let base = ((numerator * denominator) % ed25519Field + ed25519Field) % ed25519Field;
  let power = (ed25519Field - 1n) / 2n;
  let residue = 1n;
  while (power > 0n) {
    if (power & 1n) residue = residue * base % ed25519Field;
    base = base * base % ed25519Field;
    power >>= 1n;
  }
  return residue === 1n;
}

function scopeAuthorityTrustFrame(trust) {
  const { serverId, cutoverDigest, anchorDigest, ownerProfileId, ownerDeviceId } = trust ?? {};
  if (!hex(serverId, 32) || ![cutoverDigest, anchorDigest, ownerProfileId, ownerDeviceId].every(value => hex(value, 64))) throw invalid();
  return [serverId, cutoverDigest, anchorDigest, ownerProfileId];
}

function scopeAuthorityGenesis(trust, genesisDeviceKey) {
  scopeAuthorityTrustFrame(trust);
  if (!validAuthorityKey(genesisDeviceKey) || deviceIdFor(genesisDeviceKey) !== trust.ownerDeviceId) throw invalid();
  return {
    sequence: 0, digest: trust.anchorDigest, revision: 1, ownerProfileId: trust.ownerProfileId,
    deviceId: trust.ownerDeviceId, deviceKey: genesisDeviceKey,
    recoveryId: '', recoveryKey: '', retiredKeys: [], retiredRecoveryIds: [], operationIds: [],
    usedKeys: [genesisDeviceKey], usedRecoveryIds: [],
  };
}

function scopeAuthorityCheckpointWithHistory(trust, checkpoint) {
  const { ownerProfileId = trust.ownerProfileId, deviceKey, recoveryKey, recoveryId, retiredKeys, retiredRecoveryIds,
    usedKeys = [...retiredKeys, deviceKey, recoveryKey].filter(Boolean).sort(),
    usedRecoveryIds = [...retiredRecoveryIds, recoveryId].filter(Boolean).sort() } = checkpoint;
  return { ...checkpoint, ownerProfileId, usedKeys, usedRecoveryIds };
}

function validateScopeAuthorityCheckpoint(trust, checkpoint) {
  scopeAuthorityTrustFrame(trust);
  const { sequence, revision, digest, ownerProfileId = trust.ownerProfileId, deviceId, deviceKey, recoveryId, recoveryKey, ownershipTransferred,
    signerMoved, operationIds, retiredKeys, retiredRecoveryIds } = checkpoint ?? {};
  if (!Number.isSafeInteger(sequence) || sequence < 0 ||
      !Number.isSafeInteger(revision) || revision < sequence || !hex(digest, 64) || !hex(ownerProfileId, 64) ||
      (ownershipTransferred !== undefined && ownershipTransferred !== true) || (signerMoved !== undefined && signerMoved !== true) ||
      ![operationIds, retiredKeys, retiredRecoveryIds].every(Array.isArray)) throw invalid();
  if ((ownershipTransferred || signerMoved) && (!Array.isArray(checkpoint.usedKeys) || !Array.isArray(checkpoint.usedRecoveryIds))) throw invalid();
  const normalized = scopeAuthorityCheckpointWithHistory(trust, checkpoint);
  const { usedKeys, usedRecoveryIds } = normalized;
  if (sequence === 0) {
    if (!isDeepStrictEqual(normalized, scopeAuthorityGenesis(trust, deviceKey))) throw invalid();
    return;
  }
  if (!Array.isArray(usedKeys) || !Array.isArray(usedRecoveryIds) ||
      usedKeys.length > 2 * sequence + 1 || usedRecoveryIds.length > sequence ||
      [usedKeys, usedRecoveryIds].some(values => values.some((key, index) => !hex(key, 64) || (index > 0 && values[index - 1] >= key)))) throw invalid();
  const keyHistory = new Set(usedKeys), recoveryIdHistory = new Set(usedRecoveryIds);
  const noRecovery = signerMoved === true && recoveryId === '' && recoveryKey === '' && recoveryIdHistory.size === 0;
  if (!hex(deviceKey, 64) || deviceIdFor(deviceKey) !== deviceId || (!noRecovery && (!hex(recoveryKey, 64) || !hex(recoveryId, 64))) ||
      recoveryKey === deviceKey || operationIds.length !== sequence || retiredKeys.length >= sequence ||
      retiredRecoveryIds.length > retiredKeys.length || operationIds.some(id => !hex(id, 32)) ||
      retiredKeys.some(key => !hex(key, 64) || key === deviceKey || key === recoveryKey) ||
      retiredRecoveryIds.some(id => !hex(id, 64) || id === recoveryId) ||
      [operationIds, retiredKeys, retiredRecoveryIds].some(values => new Set(values).size !== values.length) ||
      ![...retiredKeys, deviceKey, ...(noRecovery ? [] : [recoveryKey])].every(key => keyHistory.has(key)) ||
      ![...retiredRecoveryIds, ...(noRecovery ? [] : [recoveryId])].every(id => recoveryIdHistory.has(id))) throw invalid();
}

function scopeAuthorityRequiresV2(trust, state) {
  return !!state && (state.signerMoved === true || state.ownershipTransferred === true ||
    (state.ownerProfileId ?? trust.ownerProfileId) !== trust.ownerProfileId || state.deviceId !== trust.ownerDeviceId);
}

function scopeAuthorityLinkFrame(trust, link, ownerProfileId = trust.ownerProfileId) {
  const fields = scopeAuthorityTrustFrame(trust);
  const { sequence, previous, action, revision, policyHead, operationId, recoveryId, recoveryKey, deviceKey } = link ?? {};
  const detachedGenesis = sequence === 1 && action === authorizeRecovery && previous === trust.anchorDigest && policyHead === trust.anchorDigest;
  if (!Number.isSafeInteger(sequence) || sequence < 1 ||
      !Number.isSafeInteger(revision) || revision < (detachedGenesis ? 1 : 2) ||
      ![authorizeRecovery, transferDevice, transferOwner, moveScopeDevice].includes(action) ||
      ![previous, policyHead].every(value => hex(value, 64)) || !hex(operationId, 32)) throw invalid();
  if (action === moveScopeDevice) {
    const { sourceDeviceId, expiresAt } = link;
    const hasRecovery = recoveryId !== '' || recoveryKey !== '';
    if (Object.keys(link).some(key => !deviceHandoverFields.has(key)) ||
        !hex(ownerProfileId, 64) || !hex(sourceDeviceId, 64) || !validAuthorityKey(deviceKey) ||
        deviceIdFor(deviceKey) === sourceDeviceId || !Number.isSafeInteger(expiresAt) || expiresAt < 1 ||
        expiresAt > 8_640_000_000_000_000 ||
        (hasRecovery && (!hex(recoveryId, 64) || !validAuthorityKey(recoveryKey) || recoveryKey === deviceKey))) throw invalid();
    return signatureFrame('pawtalk-scope-device-handover-v1', ...fields.slice(0, 3), ownerProfileId,
      String(sequence), previous, String(revision), policyHead, operationId, sourceDeviceId, deviceIdFor(deviceKey),
      deviceKey, recoveryId, recoveryKey, String(expiresAt));
  }
  if (!hex(recoveryId, 64) || !validAuthorityKey(recoveryKey) ||
      Object.hasOwn(link, 'sourceDeviceId') || Object.hasOwn(link, 'expiresAt')) throw invalid();
  if (action === transferOwner) {
    const { targetProfileId, transfer } = link;
    const { expiresAt, cutoverDigest, candidatesRoot } = transfer ?? {};
    if (!hex(ownerProfileId, 64) || !hex(targetProfileId, 64) || targetProfileId === ownerProfileId ||
        cutoverDigest !== trust.cutoverDigest || !Number.isSafeInteger(expiresAt) || expiresAt < 1 || !hex(candidatesRoot, 64)) throw invalid();
    return signatureFrame('pawtalk-scope-owner-transfer-offer-v1', ...fields.slice(0, 3), ownerProfileId,
      String(sequence), previous, String(revision), policyHead, operationId, targetProfileId, recoveryId, recoveryKey,
      String(expiresAt), candidatesRoot);
  }
  if (!validAuthorityKey(deviceKey) || recoveryKey === deviceKey) throw invalid();
  return signatureFrame('pawtalk-scope-authority-link-v1', ...fields, String(sequence), previous, action,
    String(revision), policyHead, operationId, recoveryId, recoveryKey, deviceKey);
}

function deviceConsentFrame(frameDigest, authorization) {
  return signatureFrame('pawtalk-scope-authority-device-consent-v1', frameDigest, authorization);
}

function handoverConsentFrame(frameDigest, authorization) {
  return signatureFrame('pawtalk-scope-device-handover-accept-v1', frameDigest, authorization);
}

const candidateLeaf = key => digest(signatureFrame('pawtalk-owner-transfer-candidate-v1', key));
const candidateNode = (left, right) => digest(signatureFrame('pawtalk-owner-transfer-node-v1', left, right));
const candidateRoot = (count, root) => digest(signatureFrame('pawtalk-owner-transfer-root-v1', String(count), root));

function candidateTree(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > maxOwnerTransferCandidates || keys.some((key, index) =>
    !validAuthorityKey(key) || (index > 0 && keys[index - 1] >= key))) throw invalid();
  const levels = [keys.map(candidateLeaf)];
  while (levels.at(-1).length > 1) {
    const row = levels.at(-1), next = [];
    for (let i = 0; i < row.length; i += 2) next.push(candidateNode(row[i], row[i + 1] ?? row[i]));
    levels.push(next);
  }
  return levels;
}

function verifyOwnerTransferCandidate(link) {
  const { deviceKey, transfer } = link;
  const { index, count, siblings, candidatesRoot } = transfer;
  if (!validAuthorityKey(deviceKey) || deviceKey === link.recoveryKey ||
      Object.keys(transfer).length !== 6 || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) ||
      index < 0 || index >= count || count > maxOwnerTransferCandidates || !Array.isArray(siblings) || siblings.length > 13) throw invalid();
  let position = index, width = count, node = candidateLeaf(deviceKey), offset = 0;
  while (width > 1) {
    const sibling = siblings[offset++];
    if (!hex(sibling, 64) || (position % 2 === 0 && position === width - 1 && sibling !== node)) throw invalid();
    node = position % 2 === 0 ? candidateNode(node, sibling) : candidateNode(sibling, node);
    position = Math.floor(position / 2);
    width = Math.ceil(width / 2);
  }
  if (offset !== siblings.length || candidateRoot(count, node) !== candidatesRoot) throw invalid();
}

function ownerTransferConsentFrame(frameDigest, authorization, targetProfileId, deviceKey) {
  return signatureFrame('pawtalk-scope-owner-transfer-accept-v1', frameDigest, authorization, targetProfileId, deviceKey);
}

function decodeSignature(value) {
  if (typeof value !== 'string' || value.length !== 86 || !/^[A-Za-z0-9_-]{86}$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== value) throw invalid();
  return bytes;
}

function verifySignature(frame, key, proof) {
  if (!validRecoveryEd25519Key(key)) throw invalid();
  const publicKey = createPublicKey({
    key: Buffer.concat([publicKeyHeader, Buffer.from(key, 'hex')]), format: 'der', type: 'spki',
  });
  if (!verify(null, frame, publicKey, decodeSignature(proof))) throw invalid();
}

function verifyHandoverAuthorization(checkpoint, offer, { usedKeys, usedRecoveryIds }, frame) {
  if (offer.sourceDeviceId !== checkpoint.deviceId || offer.deviceKey === checkpoint.recoveryKey ||
      checkpoint.retiredKeys.includes(offer.deviceKey)) throw invalid();
  if (!checkpoint.recoveryId && offer.recoveryId) {
    if (usedKeys.includes(offer.recoveryKey) || usedRecoveryIds.includes(offer.recoveryId)) throw invalid();
  } else if (offer.recoveryId !== checkpoint.recoveryId || offer.recoveryKey !== checkpoint.recoveryKey) {
    throw invalid();
  }
  verifySignature(frame, checkpoint.deviceKey, offer.authorization);
}

function verifyScopeDeviceHandoverOffer(trust, checkpoint, offer) {
  validateScopeAuthorityCheckpoint(trust, checkpoint);
  const history = scopeAuthorityCheckpointWithHistory(trust, checkpoint);
  const frame = scopeAuthorityLinkFrame(trust, offer, history.ownerProfileId);
  if (offer.action !== moveScopeDevice || offer.sequence !== checkpoint.sequence + 1 || offer.previous !== checkpoint.digest ||
      offer.revision <= checkpoint.revision || checkpoint.operationIds.includes(offer.operationId)) throw invalid();
  verifyHandoverAuthorization(checkpoint, offer, history, frame);
  return frame;
}

// The predecessor comes from scopeAuthorityGenesis or a previously verified link.
function advanceScopeAuthority(trust, checkpoint, link) {
  validateScopeAuthorityCheckpoint(trust, checkpoint);
  const { ownerProfileId: priorOwner, usedKeys, usedRecoveryIds } = scopeAuthorityCheckpointWithHistory(trust, checkpoint);
  const frame = scopeAuthorityLinkFrame(trust, link, priorOwner);
  const fields = link.action === transferOwner ? ownerTransferFields : link.action === moveScopeDevice ? deviceHandoverFields : linkFields;
  if (Object.keys(link).some(key => !fields.has(key)) ||
      link.sequence !== checkpoint.sequence + 1 || link.previous !== checkpoint.digest ||
      (link.revision <= checkpoint.revision && !(checkpoint.sequence === 0 && link.revision === 1)) ||
      checkpoint.operationIds.includes(link.operationId)) throw invalid();
  const { action, revision, sequence, deviceKey, recoveryId, recoveryKey, operationId, authorization } = link;
  const deviceProof = link.deviceProof === undefined ? '' : link.deviceProof;
  const frameDigest = digest(frame);
  const retiredKeys = [...checkpoint.retiredKeys], retiredRecoveryIds = [...checkpoint.retiredRecoveryIds];
  if (action === authorizeRecovery) {
    if (deviceKey !== checkpoint.deviceKey || deviceProof !== '' || usedKeys.includes(recoveryKey) ||
        usedRecoveryIds.includes(recoveryId)) throw invalid();
    verifySignature(frame, checkpoint.deviceKey, authorization);
    if (checkpoint.recoveryKey) {
      retiredKeys.push(checkpoint.recoveryKey);
      retiredRecoveryIds.push(checkpoint.recoveryId);
    }
  } else if (action === transferDevice) {
    if (!checkpoint.recoveryId || recoveryId !== checkpoint.recoveryId || recoveryKey !== checkpoint.recoveryKey ||
        usedKeys.includes(deviceKey)) throw invalid();
    verifySignature(frame, checkpoint.recoveryKey, authorization);
    verifySignature(deviceConsentFrame(frameDigest, authorization), deviceKey, deviceProof);
    retiredKeys.push(checkpoint.deviceKey);
  } else if (action === transferOwner) {
    if (deviceKey === checkpoint.deviceKey || deviceKey === checkpoint.recoveryKey ||
        recoveryKey === checkpoint.deviceKey || recoveryKey === checkpoint.recoveryKey || recoveryId === checkpoint.recoveryId ||
        retiredKeys.includes(deviceKey) || retiredKeys.includes(recoveryKey) || retiredRecoveryIds.includes(recoveryId)) throw invalid();
    verifyOwnerTransferCandidate(link);
    verifySignature(frame, checkpoint.deviceKey, authorization);
    verifySignature(ownerTransferConsentFrame(frameDigest, authorization, link.targetProfileId, deviceKey), deviceKey, deviceProof);
  } else {
    verifyHandoverAuthorization(checkpoint, link, { usedKeys, usedRecoveryIds }, frame);
    verifySignature(handoverConsentFrame(frameDigest, authorization), deviceKey, deviceProof);
  }
  return {
    sequence, revision, digest: digest(signatureFrame('pawtalk-scope-authority-link-digest-v1', frameDigest, authorization, deviceProof)),
    ownerProfileId: action === transferOwner ? link.targetProfileId : priorOwner,
    ...((action === transferOwner || checkpoint.ownershipTransferred) && { ownershipTransferred: true }),
    ...((action === moveScopeDevice || checkpoint.signerMoved) && { signerMoved: true }),
    deviceId: deviceIdFor(deviceKey), deviceKey, recoveryId, recoveryKey, retiredKeys, retiredRecoveryIds,
    usedKeys: [...new Set([...usedKeys, deviceKey, recoveryKey].filter(Boolean))].sort(),
    usedRecoveryIds: [...new Set([...usedRecoveryIds, recoveryId].filter(Boolean))].sort(),
    operationIds: [...checkpoint.operationIds, operationId],
  };
}

function signScopeAuthorityLink(trust, checkpoint, fields, authorizerPrivate, newDevicePrivate) {
  const link = { ...fields, sequence: checkpoint.sequence + 1, previous: checkpoint.digest };
  const frame = scopeAuthorityLinkFrame(trust, link);
  if (authorizerPrivate?.type !== 'private' || authorizerPrivate.asymmetricKeyType !== 'ed25519' ||
      (link.action === transferDevice && (newDevicePrivate?.type !== 'private' || newDevicePrivate.asymmetricKeyType !== 'ed25519'))) throw invalid();
  link.authorization = sign(null, frame, authorizerPrivate).toString('base64url');
  link.deviceProof = link.action === transferDevice
    ? sign(null, deviceConsentFrame(digest(frame), link.authorization), newDevicePrivate).toString('base64url') : '';
  advanceScopeAuthority(trust, checkpoint, link);
  return link;
}

function buildScopeDeviceHandoverOffer(trust, checkpoint, fields, authorizerPrivate) {
  if (authorizerPrivate?.type !== 'private' || authorizerPrivate.asymmetricKeyType !== 'ed25519') throw invalid();
  const { revision, policyHead, operationId, deviceKey, expiresAt, recoveryId = checkpoint.recoveryId, recoveryKey = checkpoint.recoveryKey } = fields;
  const link = {
    action: moveScopeDevice, revision, sequence: checkpoint.sequence + 1, previous: checkpoint.digest,
    policyHead, operationId, sourceDeviceId: checkpoint.deviceId, deviceKey, expiresAt, recoveryId, recoveryKey,
  };
  const frame = scopeAuthorityLinkFrame(trust, link, checkpoint.ownerProfileId ?? trust.ownerProfileId);
  const offer = { ...link, authorization: sign(null, frame, authorizerPrivate).toString('base64url') };
  verifyScopeDeviceHandoverOffer(trust, checkpoint, offer);
  return offer;
}

function acceptScopeDeviceHandoverOffer(trust, checkpoint, offer, successorPrivate) {
  const frame = verifyScopeDeviceHandoverOffer(trust, checkpoint, offer);
  if (successorPrivate?.type !== 'private' || successorPrivate.asymmetricKeyType !== 'ed25519') throw invalid();
  const consent = handoverConsentFrame(digest(frame), offer.authorization);
  const deviceProof = sign(null, consent, successorPrivate).toString('base64url');
  verifySignature(consent, offer.deviceKey, deviceProof);
  return { ...offer, deviceProof };
}

function ownerTransferCandidates(snapshot, profileId) {
  const candidates = Object.entries(snapshot?.PolicyDevices ?? {}).filter(([, device]) =>
    device.ProfileID === profileId && device.Revoked !== true).map(([deviceId, device]) => ({ deviceId, signingKey: device.PublicKey }));
  return candidates.sort((left, right) => left.deviceId < right.deviceId ? -1 : Number(left.deviceId !== right.deviceId));
}

function ownerTransferCandidateCommitment(candidates) {
  const keys = candidates.map(candidate => candidate.signingKey).sort();
  const levels = candidateTree(keys);
  return { keys, levels, root: candidateRoot(keys.length, levels.at(-1)[0]) };
}

function matchesOwnerTransferCandidates(snapshot, profileId, transfer) {
  const candidates = ownerTransferCandidates(snapshot, profileId);
  return transfer?.count === candidates.length && transfer.candidatesRoot === ownerTransferCandidateCommitment(candidates).root;
}

function ownerTransferOfferParts(trust, checkpoint, offer) {
  validateScopeAuthorityCheckpoint(trust, checkpoint);
  const { operationId, ownerProfileId, ownerDeviceId, targetProfileId, policyHead, headRevision, expiresAt,
    candidates, candidatesRoot, sequence, previous, recoveryId, recoveryKey } = offer ?? {};
  if (ownerProfileId !== (checkpoint.ownerProfileId ?? trust.ownerProfileId) || ownerDeviceId !== checkpoint.deviceId ||
      sequence !== checkpoint.sequence + 1 || previous !== checkpoint.digest || !Number.isSafeInteger(headRevision) ||
      headRevision < checkpoint.revision || checkpoint.operationIds.includes(operationId) || !Array.isArray(candidates) ||
      candidates.length > maxOwnerTransferCandidates || candidates.some((candidate, index) =>
        !hex(candidate?.signingKey, 64) || candidate.deviceId !== deviceIdFor(candidate.signingKey) ||
        Object.keys(candidate).length !== 2 || (index > 0 && candidates[index - 1].deviceId >= candidate.deviceId))) throw invalid();
  const { keys, levels, root } = ownerTransferCandidateCommitment(candidates);
  if (candidatesRoot !== root) throw invalid();
  const link = { action: transferOwner, operationId, sequence, previous, revision: headRevision + 1, policyHead, targetProfileId,
    recoveryId, recoveryKey, transfer: { expiresAt, candidatesRoot, cutoverDigest: trust.cutoverDigest } };
  const frame = scopeAuthorityLinkFrame(trust, link, ownerProfileId);
  return { frame, link, keys, levels };
}

function buildScopeOwnerTransferOffer(trust, checkpoint, preview, snapshot, ownerPrivate) {
  const { ownerProfileId, ownerDeviceId, targetProfileId, recoveryId, recoveryKey, candidates } = preview;
  const identity = snapshot.RecoveryIdentities?.[targetProfileId];
  const ownerDevice = snapshot.PolicyDevices?.[ownerDeviceId];
  if (snapshot.Owner !== ownerProfileId || !snapshot.Members?.[targetProfileId]?.Active ||
      snapshot.RecoveryReady?.[targetProfileId] !== true || ownerDevice?.ProfileID !== ownerProfileId || ownerDevice.Revoked ||
      ownerDevice.PublicKey !== checkpoint.deviceKey ||
      identity?.ID !== recoveryId || identity?.SigningKey !== recoveryKey ||
      !isDeepStrictEqual(snapshot.KeyRecipients?.[recoveryId], { ProfileID: targetProfileId, Kind: 'recovery', PublicKey: identity?.AgreementKey }) ||
      !isDeepStrictEqual(ownerTransferCandidates(snapshot, targetProfileId), candidates) ||
      ownerPrivate?.type !== 'private' || ownerPrivate.asymmetricKeyType !== 'ed25519') throw invalid();
  const { frame } = ownerTransferOfferParts(trust, checkpoint, preview);
  const authorization = sign(null, frame, ownerPrivate).toString('base64url');
  verifySignature(frame, checkpoint.deviceKey, authorization);
  return { ...preview, authorization };
}

function acceptScopeOwnerTransferOffer(trust, checkpoint, offer, newDevicePrivate) {
  const { frame, link, keys, levels } = ownerTransferOfferParts(trust, checkpoint, offer);
  if (newDevicePrivate?.type !== 'private' || newDevicePrivate.asymmetricKeyType !== 'ed25519') throw invalid();
  const deviceKey = createPublicKey(newDevicePrivate).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const index = keys.indexOf(deviceKey);
  if (index < 0) throw invalid();
  const siblings = [];
  let position = index;
  for (const row of levels.slice(0, -1)) {
    siblings.push(row[position ^ 1] ?? row[position]);
    position = Math.floor(position / 2);
  }
  const { authorization, targetProfileId } = offer;
  const deviceProof = sign(null, ownerTransferConsentFrame(digest(frame), authorization, targetProfileId, deviceKey),
    newDevicePrivate).toString('base64url');
  const accepted = { ...link, authorization, deviceKey, deviceProof, transfer: { ...link.transfer, index, count: keys.length, siblings } };
  advanceScopeAuthority(trust, checkpoint, accepted);
  return accepted;
}

// The caller persists the last accepted checkpoint. Replaying from genesis proves its exact prefix.
function verifyScopeAuthorityChain(trust, genesisDeviceKey, links, knownCheckpoint) {
  if (!Array.isArray(links)) throw invalid();
  if (knownCheckpoint !== undefined) validateScopeAuthorityCheckpoint(trust, knownCheckpoint);
  if (knownCheckpoint && knownCheckpoint.sequence > links.length) throw invalid('SCOPE_AUTHORITY_ROLLBACK');
  let checkpoint = scopeAuthorityGenesis(trust, genesisDeviceKey);
  for (let index = 0; index <= links.length; index += 1) {
    if (index > 0) checkpoint = advanceScopeAuthority(trust, checkpoint, links[index - 1]);
    if (index === knownCheckpoint?.sequence &&
        !isDeepStrictEqual(checkpoint, scopeAuthorityCheckpointWithHistory(trust, knownCheckpoint))) throw invalid('SCOPE_AUTHORITY_FORK');
  }
  return checkpoint;
}

module.exports = {
  scopeAuthorityGenesis, scopeAuthorityLinkFrame, validateScopeAuthorityCheckpoint, advanceScopeAuthority,
  scopeAuthorityCheckpointWithHistory,
  scopeAuthorityRequiresV2, buildScopeDeviceHandoverOffer, verifyScopeDeviceHandoverOffer, acceptScopeDeviceHandoverOffer,
  signScopeAuthorityLink, verifyScopeAuthorityChain,
  buildScopeOwnerTransferOffer, acceptScopeOwnerTransferOffer, ownerTransferCandidates, matchesOwnerTransferCandidates,
  validAuthorityKey,
};
