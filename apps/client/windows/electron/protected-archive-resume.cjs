// Archive cursors contain an epoch key. Keep only short-lived, single-use
// continuations in the main process, tied to the verified request and session.
class ProtectedArchiveResume {
  #entries = new Map();
  #walks = new Map();

  constructor({ capacity = 8, lifetime = 120_000 } = {}) {
    this.capacity = capacity;
    this.lifetime = lifetime;
  }

  #remove(slot, entry, wipe = true) {
    clearTimeout(entry.timer);
    if (wipe) entry.cursor.secret.fill(0);
    if (this.#entries.get(slot) === entry) this.#entries.delete(slot);
  }

  begin(connection, channelId, binding) {
    const { serverId } = connection;
    const slot = `${serverId}:${channelId}`;
    const walk = { serverId, channelId };
    this.#walks.set(slot, walk);
    const entry = this.#entries.get(slot);
    const resume = entry?.connection === connection && entry.binding === binding && entry.expiresAt > performance.now();
    if (entry) this.#remove(slot, entry, !resume);
    return {
      cursor: resume ? entry.cursor : undefined,
      retain: cursor => {
        if (this.#walks.get(slot) !== walk) {
          cursor.secret.fill(0);
          return;
        }
        const old = this.#entries.get(slot);
        if (old) this.#remove(slot, old);
        if (this.#entries.size >= this.capacity) {
          const [oldest, cached] = this.#entries.entries().next().value;
          this.#remove(oldest, cached);
        }
        const retained = { connection, binding, cursor, serverId, channelId, expiresAt: performance.now() + this.lifetime };
        retained.timer = setTimeout(() => this.#remove(slot, retained), this.lifetime).unref();
        this.#entries.set(slot, retained);
      },
      finish: () => {
        if (this.#walks.get(slot) === walk) this.#walks.delete(slot);
      },
    };
  }

  clear(serverId, keep = () => false) {
    for (const [slot, walk] of this.#walks) {
      if (walk.serverId === serverId && !keep(walk.channelId)) this.#walks.delete(slot);
    }
    for (const [slot, entry] of this.#entries) {
      if (entry.serverId === serverId && !keep(entry.channelId)) this.#remove(slot, entry);
    }
  }
}

module.exports = { ProtectedArchiveResume };
