function validChatAccess(body) {
  return body?.e2eeRequired === true && typeof body.chatFeed === 'string' && /^[a-f0-9]{32}$/.test(body.chatFeed)
    && typeof body.chatToken === 'string' && body.chatToken.length <= 1024 && /^[\w-]+\.[\w-]+$/.test(body.chatToken);
}

async function readJSON(response, limit) {
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
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
  let body, path = '/api/chat';
  if (Number.isSafeInteger(input?.after) && input.after >= 0) {
    path += `?after=${input.after}`;
    if (access.profileId && Number.isSafeInteger(input.profilesAfter) && input.profilesAfter >= 0) path += `&profilesAfter=${input.profilesAfter}`;
  } else if (access.profileId && input?.profile) {
    const { nickname, nonce, ciphertext } = input.profile;
    if (typeof nickname !== 'string' || nickname.length > 64
      || ((nonce !== undefined || ciphertext !== undefined) &&
        (typeof nonce !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(nonce) || typeof ciphertext !== 'string'
          || ciphertext.length > 16024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)))) throw new Error('Invalid chat profile');
    path += '/profile';
    body = JSON.stringify({ nickname, nonce, ciphertext });
  } else {
    const packet = input?.packet;
    if (typeof packet?.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(packet.requestId)
      || typeof packet.nonce !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(packet.nonce)
      || typeof packet.ciphertext !== 'string' || packet.ciphertext.length > 5484
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(packet.ciphertext)) throw new Error('Invalid chat request');
    body = JSON.stringify({ requestId: packet.requestId, nonce: packet.nonce, ciphertext: packet.ciphertext });
  }
  const request = () => fetch(access.base + path, {
    method: body ? 'POST' : 'GET', body, redirect: 'error',
    headers: { Authorization: `Bearer ${access.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(8000),
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
    throw new Error('Chat request failed');
  }
  return readJSON(response, body ? 1024 : (access.profileId ? 16 : 4) * 1024 * 1024);
}

module.exports = { requestChat, validChatAccess };
