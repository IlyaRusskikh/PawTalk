const { createHash, createPublicKey, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { verifyChannelOrderAuthority } = require('./protected-channel-policy-commitments.cjs');

const hexID = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const invalid = () => Object.assign(new Error('INVALID_CHANNEL_ORDER_PROOF'), { code: 'INVALID_CHANNEL_ORDER_PROOF' });
const signingKeyPrefix = Buffer.from('302a300506032b6570032100', 'hex');

function channelLayoutFrame(serverId, actor, change) {
  const domain = change.basisVersion === 3 ? 'pawtalk-channel-layout-v3' :
    change.basisVersion === 2 ? 'pawtalk-channel-layout-v2' : 'pawtalk-channel-layout-v1';
  return signatureFrame(domain, serverId, actor.ProfileID, actor.DeviceID,
    change.operationId, change.source, change.anchor, String(change.after), String(change.revision), change.policyHead, change.orderBasis);
}

function verifyChannelLayoutEvidence(serverId, sourceId, evidence, attestation) {
  const { change, author, sourceAuthority, anchorAuthority, digest } = evidence ?? {};
  if (!hexID(serverId, 32) || !hexID(sourceId, 32) || change?.source !== sourceId ||
      !hexID(change.anchor, 32) || change.anchor === sourceId || !hexID(change.operationId, 32) ||
      typeof change.after !== 'boolean' || ![2, 3].includes(change.basisVersion) || change.revision !== attestation?.revision || change.policyHead !== attestation?.digest ||
      !hexID(change.orderBasis, 64) || !hexID(author?.DeviceID, 64) || !hexID(author?.ProfileID, 64) ||
      typeof change.signature !== 'string' || change.signature.length !== 88 || !hexID(digest, 64)) throw invalid();
  const source = verifyChannelOrderAuthority(attestation, sourceId, sourceAuthority, author);
  const anchor = verifyChannelOrderAuthority(attestation, change.anchor, anchorAuthority, author);
  if (source.categoryId !== anchor.categoryId || (change.basisVersion !== 3 && source.categoryId === '' && source.kind !== anchor.kind) ||
      sourceAuthority.signingKey !== anchorAuthority.signingKey) throw invalid();
  const signature = Buffer.from(change.signature, 'base64');
  const key = createPublicKey({ key: Buffer.concat([signingKeyPrefix, Buffer.from(sourceAuthority.signingKey, 'hex')]),
    type: 'spki', format: 'der' });
  if (signature.length !== 64 || signature.toString('base64') !== change.signature ||
      createHash('sha256').update(signature).digest('hex') !== digest ||
      !verify(null, channelLayoutFrame(serverId, author, change), key, signature)) throw invalid();
  return { source: sourceId, anchor: change.anchor, after: change.after, revision: change.revision, authorProfileId: author.ProfileID, digest };
}

module.exports = { channelLayoutFrame, verifyChannelLayoutEvidence };
