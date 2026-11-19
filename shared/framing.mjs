// The same framing is implemented and cross-checked in apps/server/membership_protocol.go.
export function signatureFrame(...fields) {
  if (fields.some(value => typeof value !== 'string')) throw TypeError('Signature fields must be strings');
  const encoded = fields.map(value => new TextEncoder().encode(value));
  const size = encoded.reduce((sum, value) => sum + 4 + value.byteLength, 0);
  if (size > 65536) throw RangeError('Signature frame too large');
  const result = new Uint8Array(size), view = new DataView(result.buffer);
  let offset = 0;
  for (const value of encoded) { view.setUint32(offset, value.byteLength); offset += 4; result.set(value, offset); offset += value.byteLength; }
  return result;
}
