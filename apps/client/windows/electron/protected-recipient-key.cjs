const { createPrivateKey, createPublicKey, diffieHellman } = require('node:crypto');

const agreementHeader = Buffer.from('302a300506032b656e032100', 'hex');
const probePrivateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.alloc(32)]),
  type: 'pkcs8', format: 'der',
});

function recipientPublicKey(key) {
  return createPublicKey({ key: Buffer.concat([agreementHeader, Buffer.from(key, 'hex')]), type: 'spki', format: 'der' });
}

function validRecipientKey(key) {
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return false;
  const raw = Buffer.from(key, 'hex');
  if (raw[31] >= 0x80 || raw[31] === 0x7f && raw[0] >= 0xed && raw.subarray(1, 31).every(value => value === 0xff)) return false;
  try {
    const probe = diffieHellman({ publicKey: recipientPublicKey(key), privateKey: probePrivateKey });
    const valid = probe.length === 32;
    probe.fill(0);
    return valid;
  } catch {
    return false;
  }
}

module.exports = { recipientPublicKey, validRecipientKey };
