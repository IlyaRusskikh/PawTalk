const { createHmac, createPrivateKey, createPublicKey, sign, randomBytes } = require('node:crypto');
const seedSlot = 'pawtalk:device-profile:v1';
const ed25519SeedHeader = Buffer.from('302e020100300506032b657004220420', 'hex');

function profileSigner(credentials) {
  let pending;
  return async function profileProof(scope, challenge, nickname) {
    if (typeof challenge !== 'string' || !/^\d{1,12}\.[\w-]{22}\.[\w-]{43}$/.test(challenge)) return undefined;
    pending ??= (async () => {
      const existing = await credentials.load(seedSlot);
      if (existing && /^[a-f0-9]{64}$/.test(existing)) return Buffer.from(existing, 'hex');
      if (existing) throw new Error('Invalid profile seed');
      const seed = randomBytes(32);
      await credentials.save(seedSlot, seed.toString('hex'));
      return seed;
    })().catch(() => { pending = undefined; });
    const root = await pending;
    if (!root) return undefined;
    const seed = createHmac('sha256', root).update('pawtalk-profile-v1\n' + scope).digest();
    const privateKey = createPrivateKey({ key: Buffer.concat([ed25519SeedHeader, seed]), format: 'der', type: 'pkcs8' });
    const key = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
    const signature = sign(null, Buffer.from('pawtalk-profile-v1\n' + challenge + '\n' + nickname), privateKey);
    return { key: key.toString('base64url'), challenge, signature: signature.toString('base64url') };
  };
}

module.exports = { profileSigner };
