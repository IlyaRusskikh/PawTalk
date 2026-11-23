const { createCipheriv, createDecipheriv, createHash, createPublicKey, hkdfSync, randomBytes, sign, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { pollDurations } = require('../../../../shared/polls.mjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const id = (value, size) => typeof value === 'string' && value.length === size && /^[a-f0-9]+$/.test(value);
const invalid = () => Object.assign(new Error('INVALID_PROTECTED_TEXT'), { code: 'INVALID_PROTECTED_TEXT' });
const signingHeader = Buffer.from('302a300506032b6570032100', 'hex');

function protectedChecklistDigest(definition) {
  const { Items, Everyone } = definition ?? {};
  if (typeof Everyone !== 'boolean' || !Array.isArray(Items) || Items.length < 1 || Items.length > 100 ||
      Items.some(item => !id(item, 32)) || new Set(Items).size !== Items.length) throw invalid();
  return hash(`pawtalk-protected-checklist-v1:${Everyone}:${Items.join(':')}`);
}

function textContext(secret, serverId, author, packet) {
  if (!id(serverId, 32) || !id(packet?.ChannelID, 32) || !id(packet?.OperationID, 32) ||
      ![author?.ProfileID, author?.DeviceID, packet?.KeyID].every(value => id(value, 64)) ||
      !Buffer.isBuffer(secret) || secret.length !== 32 || hash(secret) !== packet.KeyID) throw invalid();
  const binding = [serverId, packet.ChannelID, author.ProfileID, author.DeviceID, packet.OperationID, packet.KeyID];
  if (packet.ReplyDigest !== undefined && !id(packet.ReplyDigest, 64)) throw invalid();
  let version = 'v1';
  let checklistDigest = '', pollDigest = '';
  if (packet.Poll !== undefined) {
    const { OptionCount, Duration, Multiple, Anonymous, Intermediate } = packet.Poll ?? {};
    if (packet.Checklist !== undefined || packet.ReplyDigest !== undefined ||
        !Number.isInteger(OptionCount) || OptionCount < 2 || OptionCount > 10 || !pollDurations.includes(Duration) ||
        [Multiple, Anonymous, Intermediate].some(flag => typeof flag !== 'boolean')) throw invalid();
    version = 'v4';
    pollDigest = hash(`pawtalk-protected-poll-v1:${OptionCount}:${Duration}:${Multiple}:${Anonymous}:${Intermediate}`);
  } else if (packet.Checklist !== undefined) {
    version = 'v3';
    checklistDigest = protectedChecklistDigest(packet.Checklist);
  } else if (packet.ReplyDigest !== undefined) {
    version = 'v2';
  }
  if (packet.Attachments !== undefined || packet.MentionDigest !== undefined) {
    const refs = packet.Attachments;
    if (refs !== undefined && (!Array.isArray(refs) || refs.length < 1 || refs.length > 20 ||
        refs.some(ref => !id(ref?.id, 32) || !['file', 'voice'].includes(ref.kind)) ||
        new Set(refs.map(ref => ref.id)).size !== refs.length)) throw invalid();
    version = 'v5';
    binding.push(packet.ReplyDigest ?? '', checklistDigest, pollDigest);
    if (packet.MentionDigest !== undefined) {
      if (!id(packet.MentionDigest, 64)) throw invalid();
      version = 'v6';
      binding.push(packet.MentionDigest);
    }
    for (const ref of refs ?? []) binding.push(ref.id, ref.kind);
  } else if (version === 'v4') {
    binding.push(pollDigest);
  } else if (version === 'v3') {
    binding.push(packet.ReplyDigest ?? '', checklistDigest);
  } else if (version === 'v2') {
    binding.push(packet.ReplyDigest);
  }
  const context = signatureFrame(`pawtalk-protected-text-${version}`, ...binding);
  const info = signatureFrame('pawtalk-protected-text-key-v1', serverId, packet.ChannelID, packet.KeyID);
  return { binding, context, version, key: Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32)) };
}

function messageSignature(version, binding, nonce, ciphertext) {
  return signatureFrame(`pawtalk-protected-message-${version}`, ...binding, nonce.toString('base64url'), hash(ciphertext));
}

function replyDigest(operationId, { Position, Salt }) {
  if (!id(operationId, 32) || !Number.isSafeInteger(Position) || Position < 1 || !id(Salt, 64)) throw invalid();
  return hash(`pawtalk-protected-reply-v1:${operationId}:${Position}:${Salt}`);
}

function protectedReplyFields(operationId, position) {
  const Reply = { Position: position, Salt: randomBytes(32).toString('hex') };
  return { ReplyDigest: replyDigest(operationId, Reply), Reply };
}

function openProtectedReply(packet, position, first) {
  if (packet.Reply === undefined) return packet.ReplyDigest === undefined ? undefined : null;
  const reply = packet.Reply;
  if (!reply || replyDigest(packet.OperationID, reply) !== packet.ReplyDigest ||
      reply.Position >= position || reply.Position < first) throw invalid();
  return reply.Position;
}

function decodeField(value, minimum, maximum = minimum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) throw invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < minimum || bytes.length > maximum || bytes.toString('base64') !== value) throw invalid();
  return bytes;
}

function sealProtectedText(secret, serverId, author, packet, text, device) {
  if (typeof text !== 'string' || text.length < 1 || Buffer.byteLength(text) > 12288) throw invalid();
  const { binding, context, version, key } = textContext(secret, serverId, author, packet);
  const clear = Buffer.from(text, 'utf8');
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(context);
    const ciphertext = Buffer.concat([cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
    return { ...packet, Nonce: nonce.toString('base64'), Ciphertext: ciphertext.toString('base64'),
      Signature: sign(null, messageSignature(version, binding, nonce, ciphertext), device).toString('base64') };
  } finally {
    key.fill(0);
    clear.fill(0);
  }
}

function openProtectedText(secret, serverId, author, packet, publicKey) {
  const { binding, context, version, key } = textContext(secret, serverId, author, packet);
  let clear, final;
  try {
    if (!id(publicKey, 64) || hash(Buffer.from(publicKey, 'hex')) !== author.DeviceID) throw invalid();
    const signer = createPublicKey({ key: Buffer.concat([signingHeader, Buffer.from(publicKey, 'hex')]), format: 'der', type: 'spki' });
    const nonce = decodeField(packet.Nonce, 12), ciphertext = decodeField(packet.Ciphertext, 17, 12304);
    if (!verify(null, messageSignature(version, binding, nonce, ciphertext), signer, decodeField(packet.Signature, 64))) throw invalid();
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(context);
    decipher.setAuthTag(ciphertext.subarray(-16));
    clear = decipher.update(ciphertext.subarray(0, -16));
    final = Buffer.concat([clear, decipher.final()]);
    return new TextDecoder('utf-8', { fatal: true }).decode(final);
  } finally {
    key.fill(0);
    clear?.fill(0);
    final?.fill(0);
  }
}

module.exports = { sealProtectedText, openProtectedText, protectedReplyFields, openProtectedReply, protectedChecklistDigest };
