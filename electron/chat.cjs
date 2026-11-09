function validChatAccess(body) {
  return (body?.e2eeRequired === true || body?.chatProtocol === 2) && typeof body.chatFeed === 'string' && /^[a-f0-9]{32}$/.test(body.chatFeed)
    && typeof body.chatToken === 'string' && body.chatToken.length <= 1024 && /^[\w-]+\.[\w-]+$/.test(body.chatToken);
}

async function readBody(response, limit) {
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return Buffer.concat(chunks, length);
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error('Chat response too large');
    }
    chunks.push(value);
  }
}

async function renewChat(access) {
  if (!access.renewal) {
    if (access.renewAfter > Date.now()) throw new Error('Chat login is temporarily unavailable');
    access.renewAfter = Date.now() + 30_000;
    access.renewal = access.join().then(body => {
      if (!validChatAccess(body) || body.chatFeed !== access.feed || body.profileId !== access.profileId) throw new Error('Chat room changed');
      access.token = body.chatToken;
    }).finally(() => { access.renewal = undefined; });
  }
  await access.renewal;
}

async function requestChat(fetch, access, input) {
  let body, binary = false, path = '/api/chat';
  if (input?.mutation) {
    const { id, packet } = input.mutation;
    if (!access.profileId || !Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid message mutation');
    if (packet && (typeof packet.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(packet.requestId)
      || typeof packet.nonce !== 'string' || typeof packet.ciphertext !== 'string' || packet.ciphertext.length > 16408)) throw new Error('Invalid mutation packet');
    path += '/mutate'; body = JSON.stringify({ id, ...(packet ? { packet } : {}) });
  } else if (input?.attachment) {
    const { id, data } = input.attachment;
    if (access.protocol !== 2 || typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid attachment request');
    if (data !== undefined && (!(data instanceof Uint8Array) || data.byteLength < 1 || data.byteLength > 2 * 1024 * 1024 + 28)) throw new Error('Invalid attachment size');
    path += '/attachments/' + id;
    if (data !== undefined) body = data;
    binary = true;
  } else if (['after', 'before', 'around', 'limit'].some(key => Object.hasOwn(input ?? {}, key))) {
    const params = new URLSearchParams();
    for (const name of ['after', 'before', 'around', 'limit', 'readAfter']) {
      if (input[name] === undefined) continue;
      if (!Number.isSafeInteger(input[name]) || input[name] < 0 || (name === 'limit' && (input[name] < 1 || input[name] > 500))) throw new Error('Invalid chat cursor');
      params.set(name, input[name]);
    }
    if (!params.has('limit') && !params.has('after')) params.set('after', '0');
    if (input.ids !== undefined) {
      if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 500 || input.ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid message IDs');
      params.set('ids', input.ids.join(','));
      if (input.digest !== undefined) {
        if (typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest)) throw new Error('Invalid sync digest');
        params.set('digest', input.digest);
      }
    }
    path += '?' + params.toString();
    if (access.profileId && Number.isSafeInteger(input.profilesAfter) && input.profilesAfter >= 0) path += `&profilesAfter=${input.profilesAfter}`;
  } else if (access.profileId && input?.profile) {
    const { nickname, nonce, ciphertext } = input.profile;
    if (typeof nickname !== 'string' || nickname.length > 64
      || ((nonce !== undefined || ciphertext !== undefined) &&
        ((nonce !== undefined && !/^[A-Za-z0-9+/]{16}$/.test(nonce)) || typeof ciphertext !== 'string'
          || ciphertext.length > 16024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)))) throw new Error('Invalid chat profile');
    path += '/profile';
    body = JSON.stringify({ nickname, nonce, ciphertext });
  } else {
    const packet = input?.packet;
    if (typeof packet?.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(packet.requestId)
      || typeof packet.nonce !== 'string' || !(packet.nonce === '' && access.encrypted === false) && !/^[A-Za-z0-9+/]{16}$/.test(packet.nonce)
      || typeof packet.ciphertext !== 'string' || packet.ciphertext.length > (access.protocol === 2 ? 16408 : 5484)
      || (packet.attachmentId !== undefined && !/^[a-f0-9]{32}$/.test(packet.attachmentId))
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(packet.ciphertext)) throw new Error('Invalid chat request');
    body = JSON.stringify({ requestId: packet.requestId, nonce: packet.nonce, ciphertext: packet.ciphertext, ...(packet.attachmentId ? { attachmentId: packet.attachmentId } : {}) });
  }
  const request = () => fetch(access.base + path, {
    method: body ? 'POST' : 'GET', body, redirect: 'error',
    headers: { Authorization: `Bearer ${access.token}`, ...(body ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) },
    signal: AbortSignal.timeout(binary ? 30000 : 8000),
  });
  let response = await request();
  if (response.status === 401) {
    await response.body?.cancel();
    await renewChat(access);
    response = await request();
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429 && input?.packet) return { rateLimited: true };
    if (binary && response.status === 507) throw new Error('Attachment storage full');
    throw new Error('Chat request failed');
  }
  const bytes = await readBody(response, binary && !body ? 2 * 1024 * 1024 + 28 : body ? 1024 : (access.profileId ? 16 : 4) * 1024 * 1024);
  return binary && !body ? new Uint8Array(bytes) : JSON.parse(bytes.toString('utf8'));
}

module.exports = { requestChat, validChatAccess };
