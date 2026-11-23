const {
  createHash, createHmac, createPrivateKey, createPublicKey, createCipheriv, createDecipheriv,
  diffieHellman, generateKeyPairSync, hkdfSync, randomFillSync, sign, verify,
} = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');

// RFC 9180, base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM.
// Each encapsulation uses sequence number zero. Only runtime recovery packages
// wrap an extra seed, and they commit its public key in the package leaf.
const kemSuite = Buffer.from('4b454d0020', 'hex');
const hpkeSuite = Buffer.from('48504b45002000010001', 'hex');
const prefix = Buffer.from('HPKE-v1');
const empty = Buffer.alloc(0);
const spkiX25519 = Buffer.from('302a300506032b656e032100', 'hex');
const pkcs8X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const spkiEd25519 = Buffer.from('302a300506032b6570032100', 'hex');
const pkcs8Ed25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const deviceEpochPackageSize = 80;
const recoveryEpochCiphertextSize = 112;
const recoveryEpochPackageSize = recoveryEpochCiphertextSize + 32;
const hexID = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);

function hmac(key, parts) {
  const hash = createHmac('sha256', key);
  for (const part of parts) hash.update(part);
  return hash.digest();
}
function extract(suite, salt, label, input) {
  return hmac(salt, [prefix, suite, label, input]);
}
function expand(suite, prk, label, info, size) {
  // All expansions in this suite fit in the first SHA-256 block.
  const block = hmac(prk, [Buffer.from([0, size]), prefix, suite, label, info, Buffer.from([1])]);
  try { return Buffer.from(block.subarray(0, size)); }
  finally { block.fill(0); }
}
function publicKey(bytes) {
  return createPublicKey({ key: Buffer.concat([spkiX25519, bytes]), format: 'der', type: 'spki' });
}
function rawKey(key) {
  return key.export({ format: 'der', type: 'spki' }).subarray(-32);
}

// Writers can address an archive revision without receiving the epoch secret.
// Archive link encryption and device agreement use different key material.
function archiveRevisionPrivateKey(serverId, record, secret) {
  if (!hexID(serverId, 32) || typeof record?.ChannelID !== 'string' || !record.ChannelID.length || record.ChannelID.length > 64 ||
      record.Purpose !== 'archive' ||
      !Number.isSafeInteger(record.Generation) || record.Generation < 1 || !hexID(record.KeyID, 64) ||
      !Buffer.isBuffer(secret) || secret.length !== 32 || hash([secret]).toString('hex') !== record.KeyID) {
    throw new Error('INVALID_ARCHIVE_REVISION_KEY');
  }
  const info = signatureFrame('pawtalk-archive-revision-agreement-v1', serverId, record.ChannelID, String(record.Generation), record.KeyID);
  const seed = Buffer.from(hkdfSync('sha256', secret, empty, info, 32));
  const der = Buffer.concat([pkcs8X25519, seed]);
  try {
    return createPrivateKey({ key: der, type: 'pkcs8', format: 'der' });
  } finally {
    seed.fill(0);
    der.fill(0);
  }
}

function archiveRevisionPublicKey(serverId, record, secret) {
  return rawKey(createPublicKey(archiveRevisionPrivateKey(serverId, record, secret))).toString('hex');
}
function derive(privateKey, peer, encapsulated, recipient, info) {
  const dh = diffieHellman({ privateKey, publicKey: peer });
  let prk, shared, secret;
  try {
    prk = extract(kemSuite, empty, 'eae_prk', dh);
    shared = expand(kemSuite, prk, 'shared_secret', Buffer.concat([encapsulated, recipient]), 32);
    const context = Buffer.concat([Buffer.from([0]), extract(hpkeSuite, empty, 'psk_id_hash', empty),
      extract(hpkeSuite, empty, 'info_hash', info)]);
    secret = extract(hpkeSuite, shared, 'secret', empty);
    return {
      key: expand(hpkeSuite, secret, 'key', context, 16),
      nonce: expand(hpkeSuite, secret, 'base_nonce', context, 12),
    };
  } finally {
    dh.fill(0);
    prk?.fill(0);
    shared?.fill(0);
    secret?.fill(0);
  }
}

function contextFrame(context) {
  const { serverId, channelId, generation, revision, policyDigest, previousDigest,
    taskId, leaseId, keyId, recipientId, recipientKey, purpose } = context;
  if (!hexID(serverId, 32) || typeof channelId !== 'string' || !channelId.length || channelId.length > 64 ||
      !Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(revision) || revision < 1 ||
      !hexID(policyDigest, 64) || (generation === 1 ? previousDigest !== '' : !hexID(previousDigest, 64)) ||
      !hexID(taskId, 32) || !hexID(leaseId, 32) || !hexID(keyId, 64) || !hexID(recipientId, 64) ||
      !hexID(recipientKey, 64) || !['live', 'archive'].includes(purpose)) throw new Error('INVALID_EPOCH_PACKAGE_CONTEXT');
  return signatureFrame('pawtalk-epoch-package-v1', serverId, channelId, String(generation), String(revision),
    policyDigest, previousDigest, taskId, leaseId, keyId, recipientId, recipientKey, purpose);
}

function sealEpochPackage(secret, context) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new Error('INVALID_EPOCH_SECRET');
  return sealKeyPackage(secret, Buffer.from(context.recipientKey, 'hex'), contextFrame(context));
}

function openingPrivateKey(seed) {
  const der = Buffer.concat([pkcs8Ed25519, seed]);
  try { return createPrivateKey({ key: der, type: 'pkcs8', format: 'der' }); }
  finally { der.fill(0); }
}

function sealRecoveryEpochPackage(secret, context) {
  const info = contextFrame(context);
  if (!Buffer.isBuffer(secret) || secret.length !== 32 || hash([secret]).toString('hex') !== context.keyId) {
    throw new Error('INVALID_EPOCH_SECRET');
  }
  const plaintext = Buffer.alloc(64);
  try {
    secret.copy(plaintext);
    randomFillSync(plaintext, 32);
    const openingKey = openingPrivateKey(plaintext.subarray(32));
    const ciphertext = sealKeyPackage(plaintext, Buffer.from(context.recipientKey, 'hex'), info);
    return Buffer.concat([ciphertext, rawKey(createPublicKey(openingKey))]);
  } finally {
    plaintext.fill(0);
  }
}

function sealKeyPackage(secret, recipient, info) {
  const temporary = generateKeyPairSync('x25519');
  const encapsulated = rawKey(temporary.publicKey);
  const { key, nonce } = derive(temporary.privateKey, publicKey(recipient), encapsulated, recipient, info);
  try {
    const cipher = createCipheriv('aes-128-gcm', key, nonce);
    cipher.setAAD(info);
    return Buffer.concat([encapsulated, cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
  } finally {
    key.fill(0);
    nonce.fill(0);
  }
}

function openKeyPackage(ciphertext, privateKey, recipient, info) {
  return openSealedPackage(ciphertext, privateKey, recipient, info, deviceEpochPackageSize);
}

function openSealedPackage(ciphertext, privateKey, recipient, info, size) {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length !== size) throw new Error('INVALID_EPOCH_PACKAGE');
  const encapsulated = ciphertext.subarray(0, 32);
  const { key, nonce } = derive(privateKey, publicKey(encapsulated), encapsulated, recipient, info);
  let plaintext, final;
  try {
    const decipher = createDecipheriv('aes-128-gcm', key, nonce);
    decipher.setAAD(info);
    const tag = size - 16;
    decipher.setAuthTag(ciphertext.subarray(tag));
    plaintext = decipher.update(ciphertext.subarray(32, tag));
    final = decipher.final();
    return Buffer.concat([plaintext, final]);
  } finally {
    plaintext?.fill(0);
    final?.fill(0);
    key.fill(0);
    nonce.fill(0);
  }
}

function hash(parts) {
  const value = createHash('sha256');
  for (const part of parts) value.update(part);
  return value.digest();
}

function packageLeaf(recipient, purpose, ciphertext) {
  return hash([Buffer.from([0, purpose === 'archive' ? 0 : 1]), Buffer.from(recipient, 'hex'), ciphertext]);
}

function packagesDigest(packages) {
  if (!Array.isArray(packages) || packages.length < 1 || packages.length > 8192) throw new Error('INVALID_EPOCH_PACKAGES');
  const ordered = [...packages].sort((a, b) =>
    (a.RecipientID < b.RecipientID ? -1 : a.RecipientID > b.RecipientID ? 1 : 0) ||
    (a.Purpose < b.Purpose ? -1 : a.Purpose > b.Purpose ? 1 : 0));
  return commitmentRoot(ordered.map(item => packageLeaf(item.RecipientID, item.Purpose, Buffer.from(item.Ciphertext, 'base64'))));
}

function commitmentRoot(leaves) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(leaves.length);
  while (leaves.length > 1) {
    const next = [];
    for (let i = 0; i < leaves.length; i += 2) {
      next.push(i + 1 < leaves.length ? hash([Buffer.from([1]), leaves[i], leaves[i + 1]]) : leaves[i]);
    }
    leaves = next;
  }
  return hash([Buffer.from([2]), size, leaves[0] ?? Buffer.alloc(32)]).toString('hex');
}

// The commitment must come from an epoch record whose signer and policy basis
// were already verified. HPKE base mode by itself does not authenticate the sender.
function checkInclusion(ciphertext, context, commitment, proof) {
  const invalid = () => new Error('INVALID_EPOCH_PACKAGE_PROOF');
  if (!hexID(commitment, 64) || rootFromCommitmentProof(packageLeaf(context.recipientId, context.purpose, ciphertext), proof, invalid) !== commitment) {
    throw invalid();
  }
}

function rootFromCommitmentProof(leaf, proof, invalid) {
  let { index, count, siblings } = proof ?? {};
  if (!Number.isInteger(count) || count < 1 || count > 8192 ||
      !Number.isInteger(index) || index < 0 || index >= count || !Array.isArray(siblings) ||
      siblings.length > 13 || siblings.some(sibling => !hexID(sibling, 64))) {
    throw invalid();
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(count);
  let value = leaf;
  let used = 0;
  while (count > 1) {
    if ((index ^ 1) < count) {
      if (!Object.hasOwn(siblings, used)) throw invalid();
      const sibling = Buffer.from(siblings[used++], 'hex');
      value = hash(index % 2 ? [Buffer.from([1]), sibling, value] : [Buffer.from([1]), value, sibling]);
    }
    count = Math.ceil(count / 2);
    index = Math.floor(index / 2);
  }
  if (used !== siblings.length) throw invalid();
  return hash([Buffer.from([2]), size, value]).toString('hex');
}

function openEpochPackage(ciphertext, context, privateKey, commitment, proof) {
  const info = contextFrame(context);
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length !== deviceEpochPackageSize || privateKey?.asymmetricKeyType !== 'x25519' ||
      rawKey(createPublicKey(privateKey)).toString('hex') !== context.recipientKey) {
    throw new Error('INVALID_EPOCH_PACKAGE');
  }
  checkInclusion(ciphertext, context, commitment, proof);
  return openKeyPackage(ciphertext, privateKey, Buffer.from(context.recipientKey, 'hex'), info);
}

// The principal, signer and context are supplied by the verified policy
// and epoch chain, independently of the package delivery response.
function epochSignatureFrame(serverId, profileId, deviceId, record) {
  const hasWrapKey = record.ArchiveWrapKey !== undefined;
  const hasLiveTransition = record.LiveTransitionDigest !== undefined;
  const hasArchiveTransition = record.ArchiveTransitionDigest !== undefined;
  if (hasWrapKey && (record.Purpose !== 'archive' || !hexID(record.ArchiveWrapKey, 64) || record.ArchiveWrapKey === record.KeyID)) {
    throw new Error('INVALID_EPOCH_PACKAGE_CONTEXT');
  }
  if (hasLiveTransition && (record.Purpose !== 'live' || !hexID(record.LiveTransitionDigest, 64))) {
    throw new Error('INVALID_EPOCH_PACKAGE_CONTEXT');
  }
  if (hasArchiveTransition && (!hasWrapKey || !hexID(record.ArchiveTransitionDigest, 64) || hasLiveTransition)) {
    throw new Error('INVALID_EPOCH_PACKAGE_CONTEXT');
  }
  const domain = hasArchiveTransition ? 'pawtalk-protected-epoch-archive-transition-v1'
    : hasLiveTransition ? 'pawtalk-protected-epoch-live-transition-v1'
    : hasWrapKey ? 'pawtalk-protected-epoch-v2' : 'pawtalk-protected-epoch-v1';
  return signatureFrame(domain,
    serverId, record.ChannelID, record.Purpose, profileId, deviceId,
    record.TaskID, record.LeaseID, String(record.Revision), record.PolicyDigest, String(record.Generation),
    record.PreviousDigest, record.KeyID, record.PackagesDigest, String(record.ArchiveThrough), record.ArchiveLinksDigest,
    ...(hasWrapKey ? [record.ArchiveWrapKey] : []), ...(hasLiveTransition ? [record.LiveTransitionDigest] : []),
    ...(hasArchiveTransition ? [record.ArchiveTransitionDigest] : []));
}

function verifySignedEpoch(epoch, context, signer) {
  const { Principal: principal, Record: record } = epoch;
  if (!hexID(signer?.key, 64) || !hexID(signer.profileId, 64) || !hexID(signer.deviceId, 64) ||
      principal.ProfileID !== signer.profileId || principal.DeviceID !== signer.deviceId ||
      hash([Buffer.from(signer.key, 'hex')]).toString('hex') !== signer.deviceId ||
      record.ChannelID !== context.channelId || record.Purpose !== context.purpose ||
      record.Generation !== context.generation || record.Revision !== context.revision ||
      record.PolicyDigest !== context.policyDigest || record.PreviousDigest !== context.previousDigest ||
      record.TaskID !== context.taskId || record.LeaseID !== context.leaseId || record.KeyID !== context.keyId ||
      !hexID(record.PackagesDigest, 64) || !Number.isSafeInteger(record.ArchiveThrough) ||
      (context.purpose === 'live' ? record.ArchiveThrough !== 0 || record.ArchiveLinksDigest !== '' :
        record.ArchiveThrough < 1 || !hexID(record.ArchiveLinksDigest, 64))) throw new Error('INVALID_EPOCH_PACKAGE_CONTEXT');
  if (typeof record.Signature !== 'string' || record.Signature.length !== 88) throw new Error('INVALID_EPOCH_PACKAGE_ENCODING');
  const signature = Buffer.from(record.Signature, 'base64');
  const key = createPublicKey({ key: Buffer.concat([spkiEd25519, Buffer.from(signer.key, 'hex')]), format: 'der', type: 'spki' });
  const frame = epochSignatureFrame(context.serverId, signer.profileId, signer.deviceId, record);
  if (signature.length !== 64 || signature.toString('base64') !== record.Signature || !verify(null, frame, key, signature)) {
    throw new Error('INVALID_EPOCH_SIGNATURE');
  }
  return hash([signature]).toString('hex');
}

function openSignedEpochPackage(delivery, context, privateKey, signer) {
  const { Epoch: epoch, Package: item, Proof: proof } = delivery;
  contextFrame(context);
  verifySignedEpoch(epoch, context, signer);
  if (item.RecipientID !== context.recipientId || item.Purpose !== context.purpose) throw new Error('INVALID_EPOCH_PACKAGE_CONTEXT');
  if (typeof item.Ciphertext !== 'string' || item.Ciphertext.length !== 108) throw new Error('INVALID_EPOCH_PACKAGE_ENCODING');
  const ciphertext = Buffer.from(item.Ciphertext, 'base64');
  if (ciphertext.toString('base64') !== item.Ciphertext) throw new Error('INVALID_EPOCH_PACKAGE_ENCODING');
  const secret = openEpochPackage(ciphertext, context, privateKey, epoch.Record.PackagesDigest, proof);
  try {
    if (epoch.Record.ArchiveWrapKey !== undefined &&
        archiveRevisionPublicKey(context.serverId, epoch.Record, secret) !== epoch.Record.ArchiveWrapKey) {
      throw new Error('INVALID_ARCHIVE_REVISION_KEY');
    }
    return secret;
  } catch (error) {
    secret.fill(0);
    throw error;
  }
}

function useSignedRecoveryEpochPackage(delivery, context, privateKey, signer, use) {
  const { Epoch: epoch, Package: item, Proof: proof } = delivery;
  const info = contextFrame(context);
  const epochDigest = verifySignedEpoch(epoch, context, signer);
  if (item?.RecipientID !== context.recipientId || item.Purpose !== context.purpose ||
      privateKey?.type !== 'private' || privateKey.asymmetricKeyType !== 'x25519' ||
      rawKey(createPublicKey(privateKey)).toString('hex') !== context.recipientKey ||
      typeof item.Ciphertext !== 'string' || item.Ciphertext.length !== recoveryEpochPackageSize / 3 * 4) {
    throw new Error('INVALID_RECOVERY_EPOCH_PACKAGE');
  }
  const ciphertext = Buffer.from(item.Ciphertext, 'base64');
  if (ciphertext.length !== recoveryEpochPackageSize || ciphertext.toString('base64') !== item.Ciphertext) {
    throw new Error('INVALID_RECOVERY_EPOCH_PACKAGE');
  }
  checkInclusion(ciphertext, context, epoch.Record.PackagesDigest, proof);
  const plaintext = openSealedPackage(ciphertext.subarray(0, recoveryEpochCiphertextSize), privateKey,
    Buffer.from(context.recipientKey, 'hex'), info, recoveryEpochCiphertextSize);
  try {
    const secret = plaintext.subarray(0, 32);
    if (hash([secret]).toString('hex') !== context.keyId ||
        epoch.Record.ArchiveWrapKey !== undefined &&
        archiveRevisionPublicKey(context.serverId, epoch.Record, secret) !== epoch.Record.ArchiveWrapKey) {
      throw new Error('INVALID_RECOVERY_EPOCH_KEY');
    }
    const openingKey = openingPrivateKey(plaintext.subarray(32));
    const openingPublicKey = rawKey(createPublicKey(openingKey));
    if (!openingPublicKey.equals(ciphertext.subarray(recoveryEpochCiphertextSize))) {
      throw new Error('INVALID_RECOVERY_OPENING_KEY');
    }
    const packageDigest = hash([ciphertext]).toString('hex');
    return use({ secret, openingKey, openingPublicKey, epochDigest, packageDigest });
  } finally {
    plaintext.fill(0);
  }
}

function openSignedRecoveryEpochPackage(delivery, context, privateKey, signer) {
  return useSignedRecoveryEpochPackage(delivery, context, privateKey, signer, ({ secret }) => Buffer.from(secret));
}

function proveMigrationRuntimeRecoveryOpening(delivery, context, privateKey, signer, { archiveSha256, anchorDigest, ownerProfileId, deviceId }) {
  if (![archiveSha256, anchorDigest, ownerProfileId, deviceId].every(value => hexID(value, 64)) ||
      context.generation !== 1 || delivery?.Epoch?.Principal?.ProfileID !== ownerProfileId ||
      delivery.Epoch.Principal.DeviceID !== deviceId) throw new Error('INVALID_MIGRATION_RUNTIME_RECOVERY_PROOF');
  return useSignedRecoveryEpochPackage(delivery, context, privateKey, signer, ({ openingKey, epochDigest, packageDigest }) => {
    const frame = signatureFrame('pawtalk-migration-runtime-recovery-opening-v1', context.serverId, archiveSha256,
      ownerProfileId, deviceId, context.recipientId, anchorDigest, context.channelId, context.purpose, '1', context.keyId,
      epochDigest, packageDigest);
    return sign(null, frame, openingKey).toString('base64url');
  });
}

function recoveryPackageOpeningFrame(challenge) {
  const { serverId, cutoverDigest, profileId, deviceId, recoveryId, policyHead, channelId, purpose, generation,
    epochDigest, packageDigest, nonce, expiresAt } = challenge ?? {};
  if (!hexID(serverId, 32) || !hexID(channelId, 32) ||
      ![cutoverDigest, profileId, deviceId, recoveryId, policyHead, epochDigest, packageDigest, nonce].every(value => hexID(value, 64)) ||
      !['live', 'archive'].includes(purpose) || !Number.isSafeInteger(generation) || generation < 1 ||
      !Number.isSafeInteger(expiresAt) || expiresAt < 1 || expiresAt > 8_640_000_000_000_000) {
    throw new Error('INVALID_RECOVERY_OPENING_CHALLENGE');
  }
  return signatureFrame('pawtalk-protected-recovery-package-open-v1', serverId, cutoverDigest, profileId, deviceId,
    recoveryId, policyHead, channelId, purpose, String(generation), epochDigest, packageDigest, nonce, String(expiresAt));
}

function proveSignedRecoveryEpochOpening(delivery, context, privateKey, signer, challenge, recoverySigningKey) {
  const frame = recoveryPackageOpeningFrame(challenge);
  const { serverId, cutoverDigest, profileId, deviceId, policyHead, channelId, purpose, generation, recipientId, recipientKey } = context;
  if (!Object.entries({ serverId, cutoverDigest, profileId, deviceId, policyHead, channelId, purpose, generation, recoveryId: recipientId })
    .every(([field, value]) => challenge[field] === value) ||
    recoverySigningKey?.type !== 'private' || recoverySigningKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('INVALID_RECOVERY_OPENING_CHALLENGE');
  }
  const signingKey = rawKey(createPublicKey(recoverySigningKey)).toString('hex');
  const identity = signatureFrame('pawtalk-recovery-identity-v1', serverId, profileId, signingKey, recipientKey);
  if (hash([identity]).toString('hex') !== recipientId) throw new Error('INVALID_RECOVERY_OPENING_CHALLENGE');
  return useSignedRecoveryEpochPackage(delivery, context, privateKey, signer, ({ openingKey, openingPublicKey, epochDigest, packageDigest }) => {
    if (challenge.epochDigest !== epochDigest || challenge.packageDigest !== packageDigest) {
      throw new Error('INVALID_RECOVERY_OPENING_CHALLENGE');
    }
    return {
      openingKey: openingPublicKey.toString('hex'),
      openingProof: sign(null, frame, openingKey).toString('base64url'),
      recoveryProof: sign(null, frame, recoverySigningKey).toString('base64url'),
    };
  });
}

module.exports = { sealEpochPackage, openSignedEpochPackage, sealRecoveryEpochPackage, openSignedRecoveryEpochPackage,
  recoveryPackageOpeningFrame, proveSignedRecoveryEpochOpening, proveMigrationRuntimeRecoveryOpening,
  packagesDigest, epochSignatureFrame, verifySignedEpoch,
  sealKeyPackage, openKeyPackage, commitmentRoot, rootFromCommitmentProof, archiveRevisionPrivateKey, archiveRevisionPublicKey };
