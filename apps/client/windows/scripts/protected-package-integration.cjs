const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createPrivateKey, generateKeyPairSync } = require('node:crypto');
const { openSignedEpochPackage, sealEpochPackage } = require('../electron/protected-epoch-packages.cjs');

const { delivery, context, secret, signer, testPrivateKey } = JSON.parse(readFileSync(0, 'utf8'));
const prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
const privateKey = createPrivateKey({
  key: Buffer.concat([prefix, Buffer.from(testPrivateKey, 'hex')]),
  type: 'pkcs8',
  format: 'der',
});
const expected = Buffer.from(secret, 'hex');
const open = (bundle, expectedContext = context) => openSignedEpochPackage(bundle, expectedContext, privateKey, signer);
assert.deepEqual(open(delivery), expected);
assert.throws(() => openSignedEpochPackage(delivery, context, generateKeyPairSync('x25519').privateKey, signer), /INVALID_EPOCH_PACKAGE/);
assert.throws(() => open(delivery, { ...context, purpose: 'archive' }), /INVALID_EPOCH_PACKAGE_CONTEXT/);
assert.throws(() => open(delivery, { ...context, serverId: '0'.repeat(32) }), /INVALID_EPOCH_SIGNATURE/);
const invalid = structuredClone(delivery);
invalid.Package.Ciphertext = sealEpochPackage(expected, context).toString('base64');
assert.throws(() => open(invalid), /INVALID_EPOCH_PACKAGE_PROOF/);
const invalidProof = structuredClone(delivery);
invalidProof.Proof.siblings.push('0'.repeat(64));
assert.throws(() => open(invalidProof), /INVALID_EPOCH_PACKAGE_PROOF/);
process.stdout.write(sealEpochPackage(expected, context).toString('base64'));
