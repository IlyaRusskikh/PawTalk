const { hkdfSync, createDecipheriv } = require('node:crypto');

function avatar(profile, key, feed, encrypted) {
  try {
    if (!profile || typeof profile.ciphertext !== 'string' || profile.ciphertext.length > 16024 || !/^[a-f0-9]{64}$/.test(profile.id)) return;
    let bytes = Buffer.from(profile.ciphertext, 'base64');
    if (encrypted) {
      if (!/^[a-f0-9]{64}$/.test(key || '')) return;
      const secret = hkdfSync('sha256', Buffer.from(key, 'hex'), Buffer.from(feed), Buffer.from('Voicecord chat profile v1'), 32);
      const iv = Buffer.from(profile.nonce || '', 'base64'); if (iv.length !== 12 || bytes.length < 17) return;
      const decipher = createDecipheriv('aes-256-gcm', secret, iv); decipher.setAAD(Buffer.from(profile.id)); decipher.setAuthTag(bytes.subarray(-16));
      bytes = Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
    }
    const value = bytes.toString('utf8');
    if (value.length <= 12000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)) return value;
  } catch {}
}
class RoomPreviews {
  constructor({ fetcher, login }) { this.fetcher = fetcher; this.login = login; this.access = new Map(); }
  forget(address) { this.access.delete(address); }
  async read(address, base, cursor = {}) {
    const request = async (url, options = {}) => this.fetcher(base + url, { ...options, redirect: 'error', signal: AbortSignal.timeout(6000) });
    try {
      let access = this.access.get(address);
      if (!access || access.expires < Date.now()) {
        access = await this.login(address, base) ?? {};
        access.expires = Date.now() + (access.token ? 11 * 60 : 5) * 60 * 1000;
        if (this.access.size >= 50) this.access.delete(this.access.keys().next().value);
        this.access.set(address, access);
      }
      if (access?.token) {
        const after = Number.isSafeInteger(cursor.after) && cursor.after >= 0 ? cursor.after : 0;
        const feed = /^[a-f0-9]{32}$/.test(cursor.feed || '') ? cursor.feed : '';
        const response = await request(`/api/preview?readAfter=${after}&readFeed=${feed}`, { headers: { Authorization: 'Bearer ' + access.token } });
        if (response.status === 401) this.access.delete(address);
        if (response.ok) {
          const raw = await response.text(); if (raw.length > 60000) throw Error('Preview too large');
          const body = JSON.parse(raw);
          if (!Number.isSafeInteger(body.participants) || body.participants < 0 || !Number.isSafeInteger(body.unread) || body.unread < 0 || !Array.isArray(body.people) || body.people.length > 3 || !/^[a-f0-9]{32}$/.test(body.feed)) throw Error('Invalid preview');
          return { status: 'online', participants: body.participants, unread: body.unread, feed: body.feed, ephemeral: access.ephemeral, details: true, people: body.people.map(person => ({ name: typeof person.name === 'string' ? person.name.slice(0, 64) : '', avatar: avatar(person.profile, access.key, body.feed, body.encrypted) })) };
        }
        await response.body?.cancel();
      }
      const response = await request('/api/presence');
      if (response.status === 404) {
        await response.body?.cancel();
        const health = await request('/healthz'); const online = health.ok; await health.body?.cancel();
        return online ? { status: 'online', people: [], details: false } : { status: 'offline' };
      }
      if (!response.ok) { await response.body?.cancel(); return { status: 'offline' }; }
      const raw = await response.text(); if (raw.length > 1024) throw Error('Invalid presence');
      const body = JSON.parse(raw);
      if (!Number.isSafeInteger(body.participants) || body.participants < 0) throw Error('Invalid presence');
      return { status: 'online', participants: body.participants, unread: 0, people: [], details: false };
    } catch { return { status: 'offline' }; }
  }
}
module.exports = { RoomPreviews, avatar };
