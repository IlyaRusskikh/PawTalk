const { createHash } = require('node:crypto');

const proofPartBytes = 16 * 1024 * 1024;
const proofAssemblyBytes = 8 * proofPartBytes;
const offsetHeader = 'PawTalk-Proof-Offset';
const leaseHeader = 'PawTalk-Proof-Lease';
let assemblyBytesInUse = 0;

const failure = code => Object.assign(Error(code), { code });

async function readBoundedResponse(response, limit) {
  const reader = response.body?.getReader();
  const buffers = [];
  let length = 0;
  if (reader) {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw failure('RESPONSE_TOO_LARGE');
      }
      buffers.push(next.value);
    }
  }
  return Buffer.concat(buffers, length);
}

async function readProtectedProofResponse(request, expectLease) {
  let response = await request({ [offsetHeader]: '0' });
  if (response.status !== 206) {
    if (response.ok && response.headers?.get('content-type') === 'application/octet-stream') {
      await response.body?.cancel();
      throw failure('INVALID_PROTECTED_PROOF_RESPONSE');
    }
    return { response };
  }

  const etag = response.headers.get('etag');
  const leaseId = response.headers.get(leaseHeader);
  const validLease = expectLease ? /^[0-9a-f]{32}$/.test(leaseId ?? '') : leaseId === null;
  if (!/^"[0-9a-f]{64}"$/.test(etag ?? '') || !validLease) {
    await response.body?.cancel();
    throw failure('INVALID_PROTECTED_PROOF_RESPONSE');
  }

  const digest = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let offset = 0, total = 0, json = '';
  try {
    while (true) {
      const range = /^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)\/([1-9][0-9]*)$/.exec(response.headers.get('content-range') ?? '');
      const [start, end, size] = range ? range.slice(1).map(Number) : [];
      if (response.headers.get('content-type') !== 'application/octet-stream' ||
          response.headers.get('etag') !== etag || response.headers.get(leaseHeader) !== leaseId ||
          start !== offset || !Number.isSafeInteger(size) || size <= proofPartBytes ||
          (total !== 0 && size !== total) || end !== Math.min(offset + proofPartBytes, size) - 1) {
        await response.body?.cancel();
        throw failure('INVALID_PROTECTED_PROOF_RESPONSE');
      }
      if (total === 0) {
        if (size > proofAssemblyBytes || assemblyBytesInUse + size > proofAssemblyBytes) {
          await response.body?.cancel();
          throw failure(size > proofAssemblyBytes ? 'PROTECTED_PROOF_RESPONSE_TOO_LARGE' : 'PROTECTED_PROOF_BUSY');
        }
        assemblyBytesInUse += size;
        total = size;
      }
      const bytes = await readBoundedResponse(response, end - start + 1);
      if (bytes.length !== end - start + 1) throw failure('INVALID_PROTECTED_PROOF_RESPONSE');
      digest.update(bytes);
      try { json += decoder.decode(bytes, { stream: true }); }
      catch { throw failure('INVALID_PROTECTED_PROOF_RESPONSE'); }
      offset = end + 1;
      if (offset === total) break;

      response = await request({ [offsetHeader]: String(offset), 'If-Match': etag, ...(leaseId && { [leaseHeader]: leaseId }) });
      if (!response.ok) return { response };
      if (response.status !== 206) {
        await response.body?.cancel();
        throw failure('INVALID_PROTECTED_PROOF_RESPONSE');
      }
    }
    if (`"${digest.digest('hex')}"` !== etag) throw failure('INVALID_PROTECTED_PROOF_RESPONSE');
    try { return { response, result: JSON.parse(json + decoder.decode()) }; }
    catch { throw failure('INVALID_PROTECTED_PROOF_RESPONSE'); }
  } finally {
    assemblyBytesInUse -= total;
  }
}

module.exports = { proofPartBytes, readBoundedResponse, readProtectedProofResponse };
