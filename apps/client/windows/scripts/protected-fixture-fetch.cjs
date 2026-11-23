const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { request } = require('node:https');
const { checkServerIdentity } = require('node:tls');

function createPinnedFixtureFetch(base, certificate) {
  return (url, { pawtalkTLSFingerprint, method, headers, signal, body }) => {
    assert.equal(new URL(url).origin, base);
    return new Promise((resolve, reject) => {
      const call = request(url, { ca: certificate, method, headers, signal, checkServerIdentity(host, peer) {
        const actual = createHash('sha256').update(peer.raw).digest('hex');
        return actual === pawtalkTLSFingerprint ? checkServerIdentity(host, peer) : Error('unexpected certificate pin');
      } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
        response.on('error', reject);
      });
      call.on('error', reject);
      call.end(body);
    });
  };
}

module.exports = { createPinnedFixtureFetch };
