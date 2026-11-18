const { createHash, X509Certificate } = require('node:crypto');
// Chromium's default verifier is keyed by hostname and has no port in its
// callback. Separate in-memory sessions keep each verified origin/certificate
// isolated, including two servers on the same IP with different ports.
function membershipTransport(electronSession, fallback) {
  const pools = new Map();
  const rejectedCertificates=new Set();
  return async (address, input = {}) => {
    const { pawtalkTLSFingerprint: fingerprint, ...options } = input;
    const url = new URL(address);
    if (url.protocol !== 'https:') return fallback(address, options);
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) throw Object.assign(Error('TLS identity required'), { code: 'TLS_IDENTITY_MISSING' });
    const key = createHash('sha256').update(url.origin + '\n' + fingerprint).digest('hex');
    let partition = pools.get(key);
    if (!partition) {
      partition = electronSession.fromPartition('pawtalk-server-' + key, { cache: false });
      partition.setCertificateVerifyProc((request, callback) => {
        try {
          const actual = new X509Certificate(request.certificate.data).fingerprint256.replaceAll(':', '').toLowerCase();
          if(actual===fingerprint){rejectedCertificates.delete(key);callback(0);}
          else{rejectedCertificates.add(key);callback(-2);}
        } catch { rejectedCertificates.add(key);callback(-2); }
      });
      pools.set(key, partition);
    }
    try { const response=await partition.fetch(address, options);rejectedCertificates.delete(key);return response; }
    catch(error) {
      if(rejectedCertificates.has(key)||/\bERR_CERT_[A-Z_]+\b/.test(error.message||''))throw Object.assign(Error('Server TLS identity changed'),{code:'SERVER_KEY_CHANGED'});
      throw error;
    }
  };
}
module.exports = { membershipTransport };
