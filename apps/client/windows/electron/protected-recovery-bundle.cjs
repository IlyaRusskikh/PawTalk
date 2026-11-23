const { serverURL } = require('./address.cjs');

const prefix = 'pawtalk-recovery-v1.';
const invalid = () => Object.assign(Error('INVALID_RECOVERY_BUNDLE'), { code: 'INVALID_RECOVERY_BUNDLE' });
const hex = (value, size) => typeof value === 'string' && value.length === size && /^[a-f0-9]+$/.test(value);

function recoveryBundleFields(value, allowLoopback) {
  const { address, fingerprint, profileId, trust, code } = value ?? {};
  if (typeof address !== 'string' || !address || address.length > 2048 || address.includes('#') ||
      address !== address.trim() || !hex(fingerprint, 64) || !hex(profileId, 64) || !hex(trust?.serverId, 32) ||
      ![trust.cutoverDigest, trust.anchorDigest, trust.ownerProfileId, trust.ownerDeviceId].every(key => hex(key, 64)) ||
      typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw invalid();
  const seed = Buffer.from(code, 'base64url');
  try {
    if (seed.length !== 32 || seed.toString('base64url') !== code || !serverURL(address, allowLoopback).startsWith('https://')) throw invalid();
  } catch { throw invalid(); }
  finally { seed.fill(0); }
  const { serverId, cutoverDigest, anchorDigest, ownerProfileId, ownerDeviceId } = trust;
  return { address, fingerprint, profileId, trust: { serverId, cutoverDigest, anchorDigest, ownerProfileId, ownerDeviceId }, code };
}

function createRecoveryBundle(context, allowLoopback) {
  const fields = recoveryBundleFields(context, allowLoopback);
  const bytes = Buffer.from(JSON.stringify(fields), 'utf8');
  try {
    const bundle = prefix + bytes.toString('base64url');
    if (bundle.length > 4096) throw invalid();
    return bundle;
  } finally { bytes.fill(0); }
}

function openRecoveryBundle(bundle, allowLoopback) {
  if (typeof bundle !== 'string' || bundle.length > 4096 || !bundle.startsWith(prefix)) throw invalid();
  const encoded = bundle.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw invalid();
  const bytes = Buffer.from(encoded, 'base64url');
  try {
    if (bytes.toString('base64url') !== encoded) throw invalid();
    const fields = recoveryBundleFields(JSON.parse(bytes.toString('utf8')), allowLoopback);
    if (JSON.stringify(fields) !== bytes.toString('utf8')) throw invalid();
    return fields;
  } catch { throw invalid(); }
  finally { bytes.fill(0); }
}

module.exports = { createRecoveryBundle, openRecoveryBundle };
