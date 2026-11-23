const { VoiceSignal } = require('./voice-signal.cjs');

const eventTypes = new Set(['resync', 'state', 'chat', 'heartbeat', 'message', 'voice', 'composer']);
const heartbeatTimeout = 40_000;
const handshakeTimeout = 12_000;

function parseEvent(text, previous, deliveryEnabled, voiceEnabled, composerEnabled) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > (deliveryEnabled ? 60000 : 512)) throw Error('Invalid protected event');
  const event = JSON.parse(text);
  const message = event?.type === 'message';
  const voice = event?.type === 'voice';
  const composer = event?.type === 'composer';
  const hasChannel = message || voice || composer || event?.type === 'chat';
  if (!eventTypes.has(event?.type) || !Number.isSafeInteger(event.sequence) || event.sequence !== previous + 1 ||
      Object.keys(event).length !== (composer ? 5 : message ? 4 : hasChannel ? 3 : 2) ||
      (hasChannel && (typeof event.channelId !== 'string' || !/^[a-f0-9]{32}$/.test(event.channelId))) ||
      voice && !voiceEnabled ||
      composer && (!composerEnabled || typeof event.profileId !== 'string' || !/^[a-f0-9]{64}$/.test(event.profileId) ||
        !['typing', 'recording', 'idle'].includes(event.activity)) ||
      message && (!deliveryEnabled || !event.delivery?.window || !Array.isArray(event.delivery?.page?.messages) ||
        event.delivery.page.messages.length !== 1)) throw Error('Invalid protected event');
  return event;
}

// Raw deliveries stay in main until the membership client verifies them.
class ProtectedMembershipLive {
  constructor(send) {
    this.send = send;
    this.entries = new Map();
  }

  healthy(serverId) { return this.entries.get(serverId)?.online === true; }

  ensure(connection) {
    const { serverId, config } = connection;
    const previous = this.entries.get(serverId);
    if (previous?.connection === connection) return;
    if (previous) this.remove(serverId);
    if (config?.apiProtocolVersion !== 3 || config.protectedEvents !== true) return;
    const entry = { connection, serverId, sequence: 0, attempts: 0, online: false,
      channels: new Set(), invalidated: new Set(), deliveries: new Map() };
    this.entries.set(serverId, entry);
    entry.watchdog = setInterval(() => {
      const attempt = entry.attempt;
      if (attempt && Date.now() - attempt.lastFrame > (entry.online ? heartbeatTimeout : handshakeTimeout)) {
        this.#disconnect(entry, attempt);
      }
    }, 2_000);
    void this.#connect(entry);
  }

  #event(entry, event) { this.send({ serverId: entry.serverId, ...event }); }

  async #connect(entry) {
    if (this.entries.get(entry.serverId) !== entry) return;
    const { base, fingerprint, token } = entry.connection;
    if (entry.sequence === Number.MAX_SAFE_INTEGER) entry.sequence = 0;
    const deliveryEnabled = entry.connection.config.protectedMessageDelivery === true;
    const voiceEnabled = entry.connection.config.protectedVoiceEvents === true;
    const composerEnabled = entry.connection.config.protectedComposerEvents === true;
    const path = `/api/v3/events?after=${entry.sequence}${deliveryEnabled ? '&delivery=1' : ''}${voiceEnabled ? '&voice=1' : ''}${composerEnabled ? '&composer=1' : ''}`;
    const started = Date.now();
    const attempt = { bridge: new VoiceSignal(), started, lastFrame: started };
    entry.attempt = attempt;
    try {
      const remote = new URL(base);
      if (remote.protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw Error('Invalid protected event endpoint');
      remote.protocol = 'wss:';
      const local = await attempt.bridge.open(remote.href, fingerprint, { eventPath: path, eventToken: token });
      if (entry.attempt !== attempt) { attempt.bridge.close(); return; }
      const socket = new WebSocket(local + path);
      attempt.socket = socket;
      socket.addEventListener('message', message => {
        if (entry.attempt !== attempt) return;
        let event;
        try {
          event = parseEvent(message.data, entry.sequence, deliveryEnabled, voiceEnabled, composerEnabled);
          if (!entry.online && event.type !== 'resync') throw Error('Missing protected event resync');
        } catch {
          this.#disconnect(entry, attempt);
          return;
        }
        attempt.lastFrame = Date.now();
        entry.sequence = event.sequence;
        if (!entry.online) {
          entry.online = true;
          this.#event(entry, { type: 'status', live: true });
        }
        if (event.type === 'voice') this.#event(entry, { type: 'voice', channelId: event.channelId });
        else if (event.type === 'composer') this.#event(entry, {
          type: 'composer', channelId: event.channelId, profileId: event.profileId, activity: event.activity,
        });
        else if (event.type !== 'heartbeat') this.#schedule(entry, event);
      });
      socket.addEventListener('error', () => this.#disconnect(entry, attempt));
      socket.addEventListener('close', () => this.#disconnect(entry, attempt));
    } catch {
      this.#disconnect(entry, attempt);
    }
  }

  #schedule(entry, event) {
    if (event.type === 'resync' || entry.channels.size >= 32) {
      entry.pendingState = 'resync';
      entry.channels.clear();
      entry.invalidated.clear();
      entry.deliveries.clear();
    } else if (event.type === 'state' && !entry.pendingState) {
      entry.pendingState = 'state';
    } else if ((event.type === 'chat' || event.type === 'message') && entry.pendingState !== 'resync') {
      entry.channels.add(event.channelId);
      if (event.type === 'chat') {
        entry.invalidated.add(event.channelId);
        entry.deliveries.delete(event.channelId);
      } else if (!entry.invalidated.has(event.channelId) && entry.deliveries.size < 16) {
        const deliveries = entry.deliveries.get(event.channelId) ?? [];
        if (deliveries.length < 16) deliveries.push(event.delivery);
        entry.deliveries.set(event.channelId, deliveries);
      }
    }
    if (!entry.flush) entry.flush = setTimeout(() => {
      entry.flush = undefined;
      const state = entry.pendingState;
      const channels = [...entry.channels];
      const deliveries = new Map(entry.deliveries);
      entry.pendingState = undefined;
      entry.channels.clear();
      entry.invalidated.clear();
      entry.deliveries.clear();
      if (state) this.#event(entry, { type: state });
      for (const channelId of channels) {
        const records = deliveries.get(channelId);
        this.#event(entry, { type: 'chat', channelId, ...(records?.length && { deliveries: records }) });
      }
    }, event.type === 'message' ? 15 : 100);
  }

  #clearAttempt(entry) {
    const attempt = entry.attempt;
    entry.attempt = undefined;
    clearTimeout(entry.flush);
    entry.flush = undefined;
    entry.pendingState = undefined;
    entry.channels.clear();
    entry.invalidated.clear();
    entry.deliveries.clear();
    attempt?.bridge.close();
    if (attempt?.socket && attempt.socket.readyState === WebSocket.OPEN) attempt.socket.close();
    if (entry.online) {
      entry.online = false;
      this.#event(entry, { type: 'status', live: false });
    }
  }

  #disconnect(entry, attempt) {
    if (entry.attempt !== attempt) return;
    if (entry.online && attempt.lastFrame - attempt.started > 30_000) entry.attempts = 0;
    this.#clearAttempt(entry);
    const delay = Math.min(15_000, 500 * 2 ** Math.min(entry.attempts++, 5)) + Math.random() * 250;
    entry.retry = setTimeout(() => void this.#connect(entry), delay);
  }

  remove(serverId) {
    const entry = this.entries.get(serverId);
    if (!entry) return;
    this.entries.delete(serverId);
    clearInterval(entry.watchdog);
    clearTimeout(entry.retry);
    this.#clearAttempt(entry);
  }

  reconcile(records) {
    const current = new Set(records.map(record => record.serverId));
    for (const serverId of this.entries.keys()) if (!current.has(serverId)) this.remove(serverId);
  }

  stop() { for (const serverId of this.entries.keys()) this.remove(serverId); }
}

module.exports = { ProtectedMembershipLive };
