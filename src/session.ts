import { t } from './i18n';
import { Room, RoomEvent, Track, LocalAudioTrack, AudioPresets, ConnectionState, ExternalE2EEKeyProvider, isE2EESupported, type RemoteAudioTrack, type RemoteTrackPublication } from 'livekit-client';
import E2EEWorker from 'livekit-client/e2ee-worker?worker';
import { mediaKeyBytes } from '../shared/encryption.mjs';
import { Microphone } from './audio';
import { playSound } from './sounds';
import type { Settings } from './settings';
import { ConnectionHistory } from '../shared/connection-history.mjs';
import { RttMeter } from '../shared/rtt.mjs';
import { PacketLossMeter } from '../shared/packet-loss.mjs';
import { avatarPayloadLimit, validAvatar } from './avatarImage';
import { chatSendsPerSecond } from './chat';

const chatTopic = 'pawtalk.chat.v1';
const typingTopic = 'pawtalk.typing.v1';
const avatarTopic = 'pawtalk.avatar.v1';
const nicknameTopic = 'pawtalk.nickname.v1';
const profileRequestTopic = 'pawtalk.profile-request.v1';
const chatRefreshTopic = 'pawtalk.chat-refresh.v1';

export interface Person { id: string; name: string; avatar?: string; speaking: boolean; muted: boolean; deafened?: boolean; local: boolean; rtt?: number; packetLoss?: number; diagnostics?: ConnectionHistory; }
export interface Snapshot { state: string; people: Person[]; db: number; speaking: boolean; threshold?: number; rtt?: number; packetLoss?: number; e2ee?: boolean; }
export class VoiceSession {
  room?: Room; mic?: Microphone; localTrack?: LocalAudioTrack;
  muted = false; deafened = false; ptt = false;
  private peerDeafened = new Map<string, boolean>();
  private peopleVolume = new Map<string, { volume: number; muted: boolean }>();
  private speakers = new Set<string>();
  private elements = new Map<string, HTMLMediaElement[]>();
  private mixers = new Map<string, { track: RemoteAudioTrack; identity: string }>();
  private playback?: AudioContext;
  private encryptionWorker?: Worker;
  private encrypted = false;
  private timer?: ReturnType<typeof setInterval>;
  private db = -100; private speaking = false; private state = 'disconnected';
  private threshold?: number;
  private queue = Promise.resolve(); private generation = 0; private stopped = false;
  private lastDuck = false; private rtt?: number; private packetLoss?: number;
  private rttMeter = new RttMeter();
  readonly diagnostics = new ConnectionHistory();
  private statsEpoch = 0;
  private peerNetwork = new Map<string, { rtt?: number; packetLoss?: number; received: number }>();
  private peerAvatars = new Map<string, string>();
  private peerNicknames = new Map<string, string>();
  private avatar?: string;
  private nickname?: string;
  private collecting = false;
  private lossMeter = new PacketLossMeter();
  onUpdate: (snapshot: Snapshot) => void = () => {};
  onError: (message: string) => void = () => {};
  onChat?: (payload: Uint8Array, author: string, authorIdentity: string) => void;
  onTyping?: (identity: string, typing: boolean) => void;
  onChatRefresh?: () => void;
  constructor(public settings: Settings, private transport: { sharedAudioContext?: boolean } = {}) {}
  private playRoomCue(connected: boolean) {
    if (!this.deafened) void playSound(connected ? 'join' : 'leave', this.settings);
  }
  notifyMessage() {
    if (!this.deafened && this.state === 'connected') void playSound('message', this.settings);
  }
  private syncGate() { this.mic?.update(this.settings, this.muted || this.deafened || this.state !== 'connected', this.ptt); }
  private emit() {
    const room = this.room;
    const now = performance.now();
    this.rtt = this.state === 'connected' ? this.rttMeter.value(now) : undefined;
    const people = room ? [room.localParticipant, ...room.remoteParticipants.values()].map(p => {
      const local = p === room.localParticipant;
      const peer = this.peerNetwork.get(p.identity);
      const fresh = peer && now - peer.received <= 15000 ? peer : undefined;
      return {
        id: p.identity, name: (local ? this.nickname : this.peerNicknames.get(p.identity)) || p.name || t("Участник"), local,
        avatar: local ? this.avatar : this.peerAvatars.get(p.identity),
        speaking: local ? this.speaking : this.speakers.has(p.identity),
        muted: local ? this.muted || this.deafened : p.getTrackPublication(Track.Source.Microphone)?.isMuted ?? true,
        deafened: local ? this.deafened : this.peerDeafened.get(p.identity) === true,
        rtt: local ? this.rtt : fresh?.rtt,
        packetLoss: local ? this.packetLoss : fresh?.packetLoss,
        diagnostics: local ? this.diagnostics : undefined,
      };
    }) : [];
    this.onUpdate({ state: this.state, people, db: this.db, speaking: this.speaking, threshold: this.threshold, rtt: this.rtt, packetLoss: this.packetLoss, e2ee: this.encrypted });
  }
  private attach(track: RemoteAudioTrack, identity: string) {
    // A MediaElementAudioSourceNode permanently owns its HTMLMediaElement.
    // Never reuse SDK-recycled elements when a participant reconnects.
    const elements = track.attach(document.createElement('audio'));
    elements.style.display = 'none'; document.body.appendChild(elements);
    const id = track.sid || track.mediaStreamTrack.id;
    this.elements.set(id, [elements]);
    this.mixers.set(id, { track, identity });
    this.mic?.addReference(id, track.mediaStreamTrack);
    this.applyVolumes();
  }
  private applyVolumes() {
    this.mixers.forEach(mixer => {
      const pref = this.peopleVolume.get(mixer.identity) || { volume: 1, muted: false };
      mixer.track.setVolume(this.deafened || pref.muted ? 0 : pref.volume * this.settings.outputVolume);
    });
  }
  async connect(url: string, token: string, encryption: { required?: boolean; key?: string } = {}) {
    if (encryption.required && !isE2EESupported()) throw new Error(t("Этот клиент не поддерживает E2EE. Обновите PawTalk."));
    if (encryption.required) { try { mediaKeyBytes(encryption.key); } catch { throw new Error(t('Нужен ключ E2EE из приглашения: 64 шестнадцатеричных символа.')); } }
    if (encryption.key && !encryption.required) throw new Error(t("Сервер не подтвердил обязательное E2EE."));
    this.stopped = false;
    this.encrypted = encryption.required === true;
    const generation = ++this.generation;
    const keyProvider = this.encrypted ? new ExternalE2EEKeyProvider() : undefined;
    const worker = this.encrypted ? new E2EEWorker() : undefined;
    this.encryptionWorker = worker;
    this.playback = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    const room = new Room({ adaptiveStream: false, dynacast: false, webAudioMix: { audioContext: this.playback },
      audioOutput: { deviceId: this.settings.outputDevice === 'default' ? '' : this.settings.outputDevice },
      publishDefaults: { audioPreset: AudioPresets.speech, dtx: true, red: true, stopMicTrackOnMute: false },
      ...(keyProvider && worker ? { encryption: { keyProvider, worker } } : {}),
    });
    this.room = room; this.state = 'connecting'; this.diagnostics.reset('connecting'); this.emit();
    const failEncryption = (message: string) => {
      if (generation !== this.generation || this.stopped) return;
      this.onError(message); void this.disconnect();
    };
    const subscribe = (publication: RemoteTrackPublication) => {
      if (this.encrypted && !publication.isEncrypted) { failEncryption(t("Комната E2EE получила незашифрованную дорожку. Подключение закрыто.")); return; }
      publication.setSubscribed(true);
    };
    if (worker) worker.addEventListener('error', () => failEncryption(t("Ошибка E2EE. Подключение закрыто без отключения шифрования.")));
    room.on(RoomEvent.EncryptionError, () => failEncryption(t("Не удалось расшифровать голос. Проверьте ключ E2EE в приглашении.")));
    room.on(RoomEvent.TrackPublished, publication => { if (this.encrypted) subscribe(publication); });
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (this.encrypted && !publication.isEncrypted) { failEncryption(t("Получена дорожка без E2EE. Подключение закрыто.")); return; }
      if (track.kind === Track.Kind.Audio) this.attach(track as RemoteAudioTrack, participant.identity);
    });
    room.on(RoomEvent.TrackUnsubscribed, track => {
      const id = track.sid || track.mediaStreamTrack.id;
      this.mic?.removeReference(id); this.mixers.delete(id);
      track.detach().forEach(el => el.remove()); this.elements.delete(id);
    });
    room.on(RoomEvent.ActiveSpeakersChanged, speakers => { this.speakers = new Set(speakers.map(p => p.identity)); this.emit(); });
    room.on(RoomEvent.ParticipantConnected, p => { this.publishAudioState(); if (this.avatar) this.publishAvatar(p.identity); this.publishNickname(p.identity); this.playRoomCue(true); this.emit(); });
    const peerChatTimes = new Map<string, number[]>();
    const peerProfileRequests = new Map<string, number>();
    room.on(RoomEvent.ParticipantDisconnected, p => {
      this.peerNetwork.delete(p.identity); this.peerDeafened.delete(p.identity); this.peerAvatars.delete(p.identity); this.peerNicknames.delete(p.identity);
      peerChatTimes.delete(p.identity);
      peerProfileRequests.delete(p.identity);
    });
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (participant && payload.length === 0 && (topic === profileRequestTopic || topic === chatRefreshTopic)) {
        if (topic === chatRefreshTopic) { this.onChatRefresh?.(); return; }
        const now = performance.now();
        if (now - (peerProfileRequests.get(participant.identity) ?? -Infinity) < 1000) return;
        peerProfileRequests.set(participant.identity, now);
        this.publishAvatar(participant.identity); this.publishNickname(participant.identity);
        return;
      }
      if (topic === typingTopic && participant && payload.length === 1 && (payload[0] === 0 || payload[0] === 1)) {
        this.onTyping?.(participant.identity, payload[0] === 1);
        return;
      }
      if (topic === chatTopic && participant && payload.length <= 18432) {
        const { identity } = participant;
        const now = performance.now();
        const recent = (peerChatTimes.get(identity) ?? []).filter(time => now - time < 1000);
        if (recent.length >= chatSendsPerSecond) return;
        peerChatTimes.set(identity, [...recent, now]);
        this.onChat?.(payload, this.peerNicknames.get(identity) || participant.name || t("Участник"), identity);
        return;
      }
      if (topic === nicknameTopic && participant && payload.length <= 128) {
        try {
          const name = new TextDecoder('utf-8', { fatal: true }).decode(payload).trim();
          if (!name || Array.from(name).length > 32 || /\p{Cc}/u.test(name)) return;
          this.peerNicknames.set(participant.identity, name);
          this.emit();
        } catch { /* Ignore malformed nicknames. */ }
        return;
      }
      if (topic === avatarTopic && participant && payload.length <= avatarPayloadLimit) {
        const avatar = new TextDecoder().decode(payload);
        if (avatar === '-') this.peerAvatars.delete(participant.identity);
        else if (validAvatar(avatar)) this.peerAvatars.set(participant.identity, avatar);
        else return;
        this.emit();
        return;
      }
      if (topic === 'pawtalk.audio-state.v1' && participant && payload.length <= 100) {
        try { const state = JSON.parse(new TextDecoder().decode(payload)); if (typeof state.deafened === 'boolean') { this.peerDeafened.set(participant.identity, state.deafened); this.emit(); } } catch {}
        return;
      }
      if (topic !== 'pawtalk.rtt.v1' || !participant || payload.length > 100) return;
      try { const value = JSON.parse(new TextDecoder().decode(payload));
        const rtt = typeof value.rtt === 'number' && value.rtt >= 0 && value.rtt <= 60000 ? value.rtt : undefined;
        const packetLoss = typeof value.loss === 'number' && value.loss >= 0 && value.loss <= 100 ? value.loss : undefined;
        this.peerNetwork.set(participant.identity, { rtt, packetLoss, received: performance.now() });
        this.emit();
      } catch { /* Ignore malformed peer telemetry. */ }
    });
    room.on(RoomEvent.ParticipantDisconnected, () => { this.playRoomCue(false); this.emit(); });
    room.on(RoomEvent.TrackMuted, () => this.emit()); room.on(RoomEvent.TrackUnmuted, () => this.emit());
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => { if (!room.canPlaybackAudio) this.onError(t("Не удалось включить воспроизведение. Переподключитесь к комнате.")); });
    room.on(RoomEvent.ConnectionStateChanged, state => { this.state = state; ++this.statsEpoch; this.diagnostics.setState(state); if (state === 'connected') { this.publishAudioState(); this.syncProfile(); } else { this.rttMeter.reset(); this.lossMeter.reset(); this.packetLoss = undefined; this.peerNetwork.clear(); this.peerDeafened.clear(); } this.syncGate(); this.emit(); });
    room.on(RoomEvent.Disconnected, () => { if (!this.stopped) { this.onError(t("Соединение прервано. Подключитесь снова.")); void this.disconnect(); } });
    room.on(RoomEvent.MediaDevicesError, error => this.onError(t("Ошибка аудиоустройства: {0}", error.message)));
    try {
      if (keyProvider) {
        await keyProvider.setKey(mediaKeyBytes(encryption.key).buffer as ArrayBuffer);
        await room.setE2EEEnabled(true);
      }
      await this.playback.setSinkId(this.settings.outputDevice === 'default' ? '' : this.settings.outputDevice);
      await this.playback.resume();
      await room.connect(url, token, { autoSubscribe: !this.encrypted });
      if (generation !== this.generation) { await room.disconnect(); return; }
      if (this.encrypted) room.remoteParticipants.forEach(p => p.trackPublications.forEach(subscribe));
      if (generation !== this.generation) return;
      this.state = 'connected';
      await this.replaceMicrophone(generation);
      if (generation !== this.generation) return;
      await room.startAudio();
      if (generation !== this.generation) return;
      this.syncProfile();
      this.playRoomCue(true);
      let tick = 0;
      this.timer = setInterval(() => {
        const others = [...this.speakers].some(id => id !== room.localParticipant.identity && !this.deafened && !this.peopleVolume.get(id)?.muted);
        const active = this.state === 'connected' && ((this.settings.duckOwn && this.speaking) || (this.settings.duckOthers && others));
        this.lastDuck = active;
        void window.desktop?.duck({ active, factor: 1 - this.settings.duckAmount / 100 }).catch(() => {});
        if (this.rtt !== undefined && this.rttMeter.value() === undefined) this.emit();
        if (++tick % 20 === 0) { void this.collectStats(); this.publishAudioState(); }
      }, 250);
      this.emit();
    } catch (error) { if (generation === this.generation) await this.disconnect(); throw error; }
  }
  private async replaceMicrophone(generation: number) {
    if (!this.room || this.stopped) return;
    const room = this.room;
    if (this.localTrack) await room.localParticipant.unpublishTrack(this.localTrack, false);
    if (generation !== this.generation) return;
    this.localTrack?.stop(); this.localTrack = undefined;
    this.mic?.stop(); this.mic = undefined;
    if (generation !== this.generation) return;
    const mic = new Microphone(this.settings, this.transport.sharedAudioContext === false ? undefined : this.playback);
    mic.muted = this.muted || this.deafened; mic.ptt = this.ptt;
    mic.onMeter = (db, speaking, threshold) => { this.db = db; this.speaking = speaking; this.threshold = threshold; this.emit(); };
    mic.onEnded = () => { this.onError(t("Микрофон отключён. Выберите доступное устройство.")); this.speaking = false; this.emit(); };
    mic.onError = message => this.onError(message);
    try {
      await mic.start();
      if (generation !== this.generation) { mic.stop(); return; }
      this.mic = mic; this.syncGate();
      this.mixers.forEach(({ track }, id) => mic.addReference(id, track.mediaStreamTrack));
      const track = new LocalAudioTrack(mic.track, undefined, true);
      track.stopOnMute = false;
      this.localTrack = track;
      await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, audioPreset: AudioPresets.speech, dtx: true, red: true });
      if (generation !== this.generation) { track.stop(); mic.stop(); return; }
      await this.syncMute();
    } catch (error) { mic.stop(); throw error; }
  }
  private async syncMute() {
    this.syncGate();
    if (this.localTrack) {
      if (this.muted || this.deafened) await this.localTrack.mute(); else await this.localTrack.unmute();
    }
    this.applyVolumes(); this.emit();
  }
  private publishAudioState() {
    if (this.room?.state === ConnectionState.Connected) void this.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ deafened: this.deafened })), { reliable: true, topic: 'pawtalk.audio-state.v1' }).catch(() => {});
  }
  private publishAvatar(identity?: string) {
    const room = this.room;
    if (room?.state !== ConnectionState.Connected) return;
    const payload = new TextEncoder().encode(this.avatar ?? '-');
    void room.localParticipant.publishData(payload, { reliable: true, topic: avatarTopic, destinationIdentities: identity ? [identity] : undefined }).catch(() => {});
  }
  private syncProfile() {
    this.publishAvatar(); this.publishNickname();
    const room = this.room;
    if (room?.state === ConnectionState.Connected) void room.localParticipant.publishData(new Uint8Array(), { reliable: true, topic: profileRequestTopic }).catch(() => {});
  }
  publishChatRefresh() {
    const room = this.room;
    if (room?.state === ConnectionState.Connected) void room.localParticipant.publishData(new Uint8Array(), { reliable: true, topic: chatRefreshTopic }).catch(() => {});
  }
  setAvatar(avatar?: string) {
    if (avatar === this.avatar || (avatar && !validAvatar(avatar))) return;
    this.avatar = avatar;
    this.publishAvatar();
    this.emit();
  }
  private publishNickname(identity?: string) {
    const room = this.room;
    if (!this.nickname || room?.state !== ConnectionState.Connected) return;
    const payload = new TextEncoder().encode(this.nickname);
    void room.localParticipant.publishData(payload, { reliable: true, topic: nicknameTopic, destinationIdentities: identity ? [identity] : undefined }).catch(() => {});
  }
  setNickname(value: string) {
    const nickname = value.trim();
    if (!nickname || nickname === this.nickname || Array.from(nickname).length > 32 || /\p{Cc}/u.test(nickname)) return;
    this.nickname = nickname;
    this.publishNickname();
    this.emit();
  }
  async sendChat(payload: Uint8Array<ArrayBuffer>, identity: string) {
    if (this.room?.state !== ConnectionState.Connected || this.room.localParticipant.identity !== identity) throw new Error('Chat is disconnected');
    await this.room.localParticipant.publishData(payload, { reliable: true, topic: chatTopic });
  }
  publishTyping(identity: string, typing: boolean) {
    const room = this.room;
    if (room?.state !== ConnectionState.Connected || room.localParticipant.identity !== identity) return;
    void room.localParticipant.publishData(Uint8Array.of(typing ? 1 : 0), { reliable: false, topic: typingTopic }).catch(() => {});
  }
  setMute(muted: boolean, deafened: boolean) { this.muted = muted; this.deafened = deafened; this.publishAudioState(); this.emit(); this.syncGate(); this.applyVolumes(); void this.syncMute().catch(error => this.onError(String(error))); }
  setPtt(down: boolean) { this.ptt = down; this.syncGate(); }
  setPerson(id: string, volume: number, muted: boolean) { this.peopleVolume.set(id, { volume, muted }); this.applyVolumes(); }
  updateSettings(settings: Settings) {
    const previous = this.settings; this.settings = settings; this.syncGate(); this.applyVolumes();
    if ((!settings.duckOwn && !settings.duckOthers) && this.lastDuck) void window.desktop?.duck({ active: false, factor: 1 });
    const generation = this.generation;
    this.queue = this.queue.then(async () => {
      if (generation !== this.generation || this.stopped) return;
      if (this.state === 'connected') await this.mic?.configure(settings);
      if (previous.outputDevice !== settings.outputDevice && this.playback) await this.playback.setSinkId(settings.outputDevice === 'default' ? '' : settings.outputDevice);
    }).catch(error => this.onError(t("Не удалось применить устройство: {0}", error.message)));
  }
  async collectStats() {
    if (this.collecting || this.state !== 'connected') return;
    this.collecting = true;
    const generation = this.generation;
    const epoch = this.statsEpoch;
    try {
      const report = await this.localTrack?.getRTCStatsReport();
      let rttStat: any;
      report?.forEach(stat => { if (stat.type === 'remote-inbound-rtp' && stat.kind === 'audio') rttStat = stat; });
      if (generation !== this.generation || epoch !== this.statsEpoch || this.state !== 'connected') return;
      const rtt = this.rttMeter.sample(rttStat);
      const streams: { id: string; received: number; lost: number }[] = [];
      for (const participant of this.room?.remoteParticipants.values() || []) {
        const track = participant.getTrackPublication(Track.Source.Microphone)?.track;
        const inbound = await track?.getRTCStatsReport();
        inbound?.forEach(stat => { if (stat.type === 'inbound-rtp' && stat.kind === 'audio') streams.push({ id: participant.identity + ':' + stat.id, received: stat.packetsReceived, lost: stat.packetsLost }); });
      }
      if (generation !== this.generation || epoch !== this.statsEpoch || this.state !== 'connected') return;
      this.rtt = rtt;
      const loss = this.lossMeter.sample(streams);
      this.packetLoss = streams.length ? loss : undefined;
      this.diagnostics.sample({ rtt, rttAt: this.rttMeter.measuredAt, loss: this.packetLoss });
      const telemetry = { rtt: rtt ?? null, loss: this.packetLoss ?? null };
      void this.room?.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(telemetry)), { reliable: false, topic: 'pawtalk.rtt.v1' }).catch(() => {});
      this.emit();
    } catch {
      if (generation === this.generation && epoch === this.statsEpoch && this.state === 'connected') {
        this.packetLoss = undefined;
        this.diagnostics.sample();
        this.emit();
      }
    }
    finally { this.collecting = false; }
  }
  async disconnect() {
    const wasConnected = this.state === 'connected';
    this.stopped = true; ++this.generation;
    clearInterval(this.timer); this.timer = undefined;
    this.mic?.stop(); this.mic = undefined; this.localTrack?.stop(); this.localTrack = undefined;
    const room = this.room; this.room = undefined;
    room?.removeAllListeners();
    for (const elements of this.elements.values()) elements.forEach(el => el.remove()); this.elements.clear();
    this.mixers.clear();
    const playback = this.playback; this.playback = undefined;
    const worker = this.encryptionWorker; this.encryptionWorker = undefined; this.encrypted = false;
    this.peopleVolume.clear(); this.speakers.clear(); this.speaking = false; this.db = -100; this.ptt = false; this.state = 'disconnected';
    ++this.statsEpoch; this.diagnostics.reset();
    void window.desktop?.duck({ active: false, factor: 1 }).catch(() => {});
    this.rtt = undefined; this.packetLoss = undefined; this.lossMeter.reset(); this.rttMeter.reset(); this.peerNetwork.clear(); this.peerDeafened.clear(); this.peerAvatars.clear(); this.peerNicknames.clear();
    if (wasConnected) this.playRoomCue(false);
    this.emit();
    await Promise.allSettled([room?.disconnect(), playback?.close()]);
    worker?.terminate();
  }
}
