const { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, sign, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { protectedChecklistDigest } = require('./protected-live-text.cjs');
const { sealKeyPackage, openKeyPackage, commitmentRoot, rootFromCommitmentProof,
  archiveRevisionPrivateKey } = require('./protected-epoch-packages.cjs');

const ed25519Header = Buffer.from('302a300506032b6570032100', 'hex');
const hex = (value, size) => typeof value === 'string' && value.length === size && /^[0-9a-f]+$/.test(value);
const counter = value => Number.isSafeInteger(value) && value > 0;
const hash = value => createHash('sha256').update(value).digest();
const rawPublicKey = key => createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
const invalid = () => Object.assign(new Error('INVALID_PROTECTED_REVISION'), { code: 'INVALID_PROTECTED_REVISION' });

// Callers supply the verified policy and archive checkpoint. The original
// digest and position are immutable even when the text's revision changes.
function revisionBinding(context, checklist) {
  const { serverId, channelId, position, revision, originalDigest, previousDigest, operationId,
    authorProfileId, authorDeviceId, policyRevision, policyDigest, archive, archiveDigest } = context;
  if (!hex(serverId, 32) || !hex(channelId, 32) || !hex(operationId, 32) ||
      ![position, revision, policyRevision, archive?.Generation, archive?.Revision].every(counter) ||
      ![originalDigest, previousDigest, authorProfileId, authorDeviceId, policyDigest,
        archive?.KeyID, archive?.ArchiveWrapKey, archiveDigest].every(value => hex(value, 64)) ||
      archive.ChannelID !== channelId || archive.Purpose !== 'archive' || archive.Revision > policyRevision ||
      archive.KeyID === archive.ArchiveWrapKey) throw invalid();
  const fields = [serverId, channelId, String(position), originalDigest, String(revision), previousDigest, operationId,
    authorProfileId, authorDeviceId, String(policyRevision), policyDigest, String(archive.Generation),
    archive.KeyID, archiveDigest, archive.ArchiveWrapKey];
  if (checklist !== undefined) fields.push(protectedChecklistDigest(checklist));
  return fields;
}

function decode(value, min, max = min) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(max / 3)) throw invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < min || bytes.length > max || bytes.toString('base64') !== value) throw invalid();
  return bytes;
}

const archiveInfo = binding => signatureFrame('pawtalk-text-revision-archive-v1', ...binding);
const deviceInfo = (binding, id, publicKey) => signatureFrame('pawtalk-text-revision-device-v1', ...binding, id, publicKey);
const contentInfo = binding => signatureFrame('pawtalk-text-revision-content-v1', ...binding);
const deviceLeaf = (id, publicKey, wrapped) =>
  hash(signatureFrame('pawtalk-text-revision-package-leaf-v1', id, publicKey, hash(wrapped).toString('hex')));
const signature = (binding, nonce, ciphertext, archivePackage, recipientDigest) =>
  signatureFrame('pawtalk-text-revision-signature-v1', ...binding,
    nonce.toString('base64url'), hash(ciphertext).toString('hex'), hash(archivePackage).toString('hex'), recipientDigest);

function sealProtectedRevision(context, text, recipients, authorKey, checklist) {
  const binding = revisionBinding(context, checklist);
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 12288 || !Array.isArray(recipients) ||
      recipients.length > 8192 || authorKey?.asymmetricKeyType !== 'ed25519' ||
      hash(rawPublicKey(authorKey)).toString('hex') !== context.authorDeviceId) throw invalid();
  if (recipients.some(recipient => !hex(recipient?.id, 64) || !hex(recipient?.publicKey, 64))) throw invalid();
  const ordered = [...recipients].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (ordered.some((recipient, index) => index > 0 && recipient.id === ordered[index - 1].id)) throw invalid();
  const secret = randomBytes(32);
  const clear = Buffer.from(text, 'utf8');
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(contentInfo(binding));
    const ciphertext = Buffer.concat([cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
    const archive = sealKeyPackage(secret, Buffer.from(context.archive.ArchiveWrapKey, 'hex'), archiveInfo(binding));
    const leaves = [];
    const packages = ordered.map(({ id, publicKey }) => {
      const wrapped = sealKeyPackage(secret, Buffer.from(publicKey, 'hex'), deviceInfo(binding, id, publicKey));
      leaves.push(deviceLeaf(id, publicKey, wrapped));
      return { id, publicKey, ciphertext: wrapped.toString('base64') };
    });
    const recipientDigest = commitmentRoot(leaves);
    return { packet: { nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'),
      archivePackage: archive.toString('base64'), recipientDigest,
      ...(checklist !== undefined && { checklist }),
      signature: sign(null, signature(binding, nonce, ciphertext, archive, recipientDigest), authorKey).toString('base64') }, packages };
  } finally {
    clear.fill(0);
    secret.fill(0);
  }
}

function verifiedPacket(context, packet, authorPublicKey) {
  const binding = revisionBinding(context, packet?.checklist);
  if (!hex(authorPublicKey, 64) || hash(Buffer.from(authorPublicKey, 'hex')).toString('hex') !== context.authorDeviceId ||
      !hex(packet?.recipientDigest, 64)) throw invalid();
  const publicKey = createPublicKey({ key: Buffer.concat([ed25519Header, Buffer.from(authorPublicKey, 'hex')]),
    type: 'spki', format: 'der' });
  const nonce = decode(packet.nonce, 12);
  const ciphertext = decode(packet.ciphertext, 17, 12304);
  const archive = decode(packet.archivePackage, 80);
  if (!verify(null, signature(binding, nonce, ciphertext, archive, packet.recipientDigest), publicKey, decode(packet.signature, 64))) {
    throw invalid();
  }
  return { binding, nonce, ciphertext, archive };
}

function openContent({ binding, nonce, ciphertext }, secret) {
  let clear, final;
  try {
    const decipher = createDecipheriv('aes-256-gcm', secret, nonce);
    decipher.setAAD(contentInfo(binding));
    decipher.setAuthTag(ciphertext.subarray(-16));
    clear = decipher.update(ciphertext.subarray(0, -16));
    final = Buffer.concat([clear, decipher.final()]);
    return new TextDecoder('utf-8', { fatal: true }).decode(final);
  } finally {
    secret.fill(0);
    clear?.fill(0);
    final?.fill(0);
  }
}

function openProtectedRevisionForArchive(context, packet, archiveSecret, authorPublicKey) {
  const verified = verifiedPacket(context, packet, authorPublicKey);
  const { archive, serverId } = context;
  const privateKey = archiveRevisionPrivateKey(serverId, archive, archiveSecret);
  if (rawPublicKey(privateKey).toString('hex') !== archive.ArchiveWrapKey) throw invalid();
  const secret = openKeyPackage(verified.archive, privateKey, Buffer.from(archive.ArchiveWrapKey, 'hex'), archiveInfo(verified.binding));
  return openContent(verified, secret);
}

function openProtectedRevisionForDevice(context, packet, delivery, recipient, privateKey, authorPublicKey) {
  const verified = verifiedPacket(context, packet, authorPublicKey);
  const { id, publicKey } = recipient;
  if (!hex(id, 64) || !hex(publicKey, 64) || delivery?.id !== id || delivery.publicKey !== publicKey ||
      privateKey?.asymmetricKeyType !== 'x25519' ||
      rawPublicKey(privateKey).toString('hex') !== publicKey) throw invalid();
  const wrapped = decode(delivery.ciphertext, 80);
  if (rootFromCommitmentProof(deviceLeaf(id, publicKey, wrapped), delivery.proof, invalid) !== packet.recipientDigest) throw invalid();
  const secret = openKeyPackage(wrapped, privateKey, Buffer.from(publicKey, 'hex'), deviceInfo(verified.binding, id, publicKey));
  return openContent(verified, secret);
}

module.exports = { sealProtectedRevision, openProtectedRevisionForArchive, openProtectedRevisionForDevice };
