import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { MembershipClient } from '../../apps/client/windows/electron/membership-client.cjs';
import { proofPartBytes } from '../../apps/client/windows/electron/protected-proof-response.cjs';

const base = 'https://example.test';
const path = `/api/v3/keys/rotate/${'a'.repeat(32)}/live/claim?scoped=1`;
const lease = 'b'.repeat(32);
const options = { fingerprint: 'test-pin', method: 'POST', body: '{"test":"body"}',
  headers: { Authorization: 'Bearer test-session' }, proofResponse: 'claim' };

function proofFixture() {
  const head = Buffer.from('{"proof":"');
  const prefix = Buffer.concat([head, Buffer.alloc(proofPartBytes - head.length - 1, 'x')]);
  const suffix = Buffer.from('ё"}');
  const bytes = Buffer.concat([prefix, suffix]);
  const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
  function part(offset, change = {}) {
    const end = Math.min(bytes.length, offset + proofPartBytes);
    return new Response(change.bytes ?? bytes.subarray(offset, end), { status: 206, headers: {
      'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${offset}-${end - 1}/${bytes.length}`,
      'ETag': etag, 'PawTalk-Proof-Lease': lease, ...change.headers,
    } });
  }
  return { bytes, etag, part };
}

test('large scoped claim keeps the TLS pin, session, body and lease and reconstructs split UTF-8', async () => {
  const fixture = proofFixture();
  const requests = [];
  const client = new MembershipClient({ fetcher: async (url, request) => {
    requests.push(request);
    assert.equal(url, base + path);
    assert.equal(request.method, options.method);
    assert.equal(request.body, options.body);
    assert.equal(request.pawtalkTLSFingerprint, options.fingerprint);
    assert.equal(request.headers.Authorization, options.headers.Authorization);
    return fixture.part(Number(request.headers['PawTalk-Proof-Offset']));
  } });
  const result = await client.fetchJSON(base, path, options);
  assert.equal(result.proof.length, proofPartBytes - '{"proof":"'.length);
  assert.equal(result.proof.at(-1), 'ё');
  assert.deepEqual(requests.map(request => [request.headers['PawTalk-Proof-Offset'],
    request.headers['If-Match'], request.headers['PawTalk-Proof-Lease']]),
  [['0', undefined, undefined], [String(proofPartBytes), fixture.etag, lease]]);
  assert.equal(requests[0].signal, requests[1].signal);
});

test('scoped proof assembly rejects changed bytes even when both responses carry the same validator', async () => {
  const fixture = proofFixture();
  const client = new MembershipClient({ fetcher: async (_url, request) => {
    const offset = Number(request.headers['PawTalk-Proof-Offset']);
    return offset === 0 ? fixture.part(0) : fixture.part(offset, { bytes: Buffer.from([0x90, 0x22, 0x7d]) });
  } });
  await assert.rejects(client.fetchJSON(base, path, options), { code: 'INVALID_PROTECTED_PROOF_RESPONSE' });
});

test('scoped proof assembly propagates an authorization or lease change before parsing', async () => {
  const fixture = proofFixture();
  for (const [status, code] of [[403, 'PROTECTED_ACCESS_DENIED'], [412, 'PROTECTED_PROOF_CHANGED']]) {
    const client = new MembershipClient({ fetcher: async (_url, { headers }) => headers['PawTalk-Proof-Offset'] === '0'
      ? fixture.part(0) : Response.json({ error: { code } }, { status }) });
    await assert.rejects(client.fetchJSON(base, path, options), { code, status });
  }
});

test('scoped proof requests accept an ordinary JSON response and reject an invalid partial range', async () => {
  const normal = new MembershipClient({ fetcher: async () => Response.json({ proof: 'legacy or small' }) });
  assert.deepEqual(await normal.fetchJSON(base, path, options), { proof: 'legacy or small' });
  for (const headers of [
    { 'Content-Range': `bytes 1-${proofPartBytes}/${proofPartBytes + 1}` },
    { 'ETag': `W/"${'c'.repeat(64)}"` },
    { 'PawTalk-Proof-Lease': 'other' },
  ]) {
    const invalid = new MembershipClient({ fetcher: async () => new Response('invalid', { status: 206,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 0-${proofPartBytes - 1}/${proofPartBytes + 1}`,
        'ETag': `"${'c'.repeat(64)}"`, 'PawTalk-Proof-Lease': lease, ...headers },
    }) });
    await assert.rejects(invalid.fetchJSON(base, path, options), { code: 'INVALID_PROTECTED_PROOF_RESPONSE' });
  }
});

test('partial proof assemblies reject an over-budget response and release their shared reservation', async () => {
  const maxSize = 8 * proofPartBytes;
  const response = (size, body) => new Response(body, { status: 206, headers: {
    'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 0-${proofPartBytes - 1}/${size}`,
    'ETag': `"${'c'.repeat(64)}"`, 'PawTalk-Proof-Lease': lease,
  } });
  const tooLarge = new MembershipClient({ fetcher: async () => response(maxSize + 1, '') });
  await assert.rejects(tooLarge.fetchJSON(base, path, options), { code: 'PROTECTED_PROOF_RESPONSE_TOO_LARGE' });

  let pending;
  const held = new MembershipClient({ fetcher: async () => response(maxSize, new ReadableStream({
    start(controller) { pending = controller; },
  })) });
  const incomplete = assert.rejects(held.fetchJSON(base, path, options), { code: 'INVALID_PROTECTED_PROOF_RESPONSE' });
  await new Promise(resolve => setImmediate(resolve));
  const busy = new MembershipClient({ fetcher: async () => response(maxSize, '') });
  try {
    await assert.rejects(busy.fetchJSON(base, path, options), { code: 'PROTECTED_PROOF_BUSY' });
  } finally {
    pending.close();
    await incomplete;
  }
  await assert.rejects(busy.fetchJSON(base, path, options), { code: 'INVALID_PROTECTED_PROOF_RESPONSE' });
});
