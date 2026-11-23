const { createHash, randomBytes } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');

const invalid = () => Object.assign(Error('INVALID_PROTECTED_MENTIONS'), { code: 'INVALID_PROTECTED_MENTIONS' });
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validateProtectedMentions(text, spans) {
  if (typeof text !== 'string' || !Array.isArray(spans) || spans.length < 1 || spans.length > 64) throw invalid();
  let last = 0;
  const targets = new Map();
  const mentions = spans.map(span => {
    if (!span || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < last ||
        span.end <= span.start + 1 || span.end - span.start > 129 || span.end > text.length || text[span.start] !== '@') throw invalid();
    const { kind, id, start, end } = span;
    if (kind === 'profile' ? !hex64(id) : kind === 'role' ?
      typeof id !== 'string' || !id || id === '@everyone' || Buffer.byteLength(id) > 128 || /[\p{Cc}\p{Cs}]/u.test(id) :
      !['everyone', 'online'].includes(kind) || id !== undefined || text.slice(start, end) !== `@${kind}`) throw invalid();
    const target = { kind, ...(id && { id }) };
    targets.set(JSON.stringify(target), target);
    last = end;
    return { ...target, start, end };
  });
  return { mentions, targets: [...targets.values()] };
}

function mentionDigest(salt, targets) {
  if (!hex64(salt)) throw invalid();
  const fields = ['pawtalk-protected-mentions-v1', salt];
  for (const { kind, id } of targets) fields.push(kind, id ?? '');
  return createHash('sha256').update(signatureFrame(...fields)).digest('hex');
}

function encodeProtectedMentions(messageText, encodedContent, spans) {
  const { mentions, targets } = validateProtectedMentions(messageText, spans);
  const salt = randomBytes(32).toString('hex');
  return { payload: JSON.stringify({ content: encodedContent, mentions, salt }),
    fields: { MentionDigest: mentionDigest(salt, targets), MentionRouting: { salt, targets } } };
}

function decodeProtectedMentions(payload, digest, decodeContent) {
  let envelope;
  try {
    envelope = JSON.parse(payload);
  } catch {
    throw invalid();
  }
  if (typeof envelope?.content !== 'string' || !hex64(digest)) throw invalid();
  const content = decodeContent(envelope.content);
  const { mentions, targets } = validateProtectedMentions(content.text, envelope.mentions);
  if (mentionDigest(envelope.salt, targets) !== digest) throw invalid();
  return { ...content, mentions };
}

module.exports = { encodeProtectedMentions, decodeProtectedMentions };
