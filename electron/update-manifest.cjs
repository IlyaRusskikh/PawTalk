const { verify, createPublicKey } = require('node:crypto');
const trustedKeys = require('./update-keys.json');
const MAX_SIZE = 1024 * 1024 * 1024;
class UpdateSecurityError extends Error {
  constructor(source) { super('Update authenticity verification failed'); this.code = 'UPDATE_SECURITY'; this.source = source; }
}
function verifyManifest(raw, keys = trustedKeys, now = Date.now()) {
  try {
    if (Buffer.byteLength(raw) > 16384) throw Error();
    const envelope = JSON.parse(raw);
    if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string' || !Object.hasOwn(keys, envelope.keyId)) throw Error();
    const payload = Buffer.from(envelope.payload, 'base64');
    const signature = Buffer.from(envelope.signature, 'base64');
    const key = createPublicKey(keys[envelope.keyId]);
    if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, payload, key, signature)) throw Error();
    const value = JSON.parse(payload.toString('utf8'));
    if (value.schema !== 1 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value.version)
      || value.name !== `Voicecord.Setup.${value.version}.exe` || typeof value.prerelease !== 'boolean'
      || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_SIZE || !/^[a-f0-9]{64}$/.test(value.sha256)
      || !Number.isSafeInteger(value.publishedAt) || !Number.isSafeInteger(value.expiresAt)
      || value.publishedAt > now + 5 * 60 * 1000 || value.expiresAt <= now || value.expiresAt <= value.publishedAt
      || value.expiresAt - value.publishedAt > 366 * 86400000) throw Error();
    return value;
  } catch { throw new UpdateSecurityError(); }
}
module.exports = { verifyManifest, UpdateSecurityError };
