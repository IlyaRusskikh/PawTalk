const { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, randomBytes, sign } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');

const seedHeader = Buffer.from('302e020100300506032b656e04220420', 'hex');
const publicHeader = Buffer.from('302a300506032b656e032100', 'hex');
const isKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = () => Object.assign(new Error('INVALID_MIGRATION_RECIPIENT'), { code: 'INVALID_MIGRATION_RECIPIENT' });
const deviceAgreementKeySlot = (serverId, deviceId) => `pawtalk:agreement:v1:${serverId}:${deviceId}`;

async function loadDeviceAgreementKey(credentials, serverId, deviceId, create = true) {
  const slot = deviceAgreementKeySlot(serverId, deviceId);
  const saved = await credentials.load(slot, { required: true });
  if (saved == null && !create) throw invalid();
  const seed = saved ?? randomBytes(32).toString('hex');
  const key = deviceAgreementPrivateKey(seed);
  if (saved == null) await credentials.save(slot, seed);
  return key;
}

function deviceAgreementPrivateKey(encoded) {
  if (!isKey(encoded)) throw invalid();
  const seed = Buffer.from(encoded, 'hex');
  const material = Buffer.concat([seedHeader, seed]);
  try {
    return createPrivateKey({ key: material, type: 'pkcs8', format: 'der' });
  } finally {
    material.fill(0);
    seed.fill(0);
  }
}

function proposeMigrationRecipient({ serverId, archiveSha256, reviewDigest, ownerProfileId, nonce, agreementKey }, identity, privateKey) {
  if (!/^[a-f0-9]{32}$/.test(serverId) || ![archiveSha256, reviewDigest, ownerProfileId, nonce, agreementKey, identity.deviceId].every(isKey)) throw invalid();
  const { deviceId, device } = identity;
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const serverKey = createPublicKey({ key: Buffer.concat([publicHeader, Buffer.from(agreementKey, 'hex')]), type: 'spki', format: 'der' });
  const frame = signatureFrame('pawtalk-migration-recipient-v1', serverId, archiveSha256, reviewDigest, ownerProfileId,
    deviceId, nonce, publicKey, agreementKey);
  const shared = diffieHellman({ privateKey, publicKey: serverKey });
  try {
    const agreementProof = createHmac('sha256', shared).update(frame).digest('base64url');
    const digest = createHash('sha256').update(frame).digest('hex');
    const deviceProof = sign(null, signatureFrame('pawtalk-migration-recipient-device-v1', digest, agreementProof), device).toString('base64url');
    return { archiveSha256, reviewDigest, ownerProfileId, deviceId, nonce, publicKey, agreementProof, deviceProof };
  } finally {
    shared.fill(0);
  }
}

module.exports = { loadDeviceAgreementKey, proposeMigrationRecipient, deviceAgreementPrivateKey, deviceAgreementKeySlot };
