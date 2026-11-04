import { Room, RoomEvent, Track, LocalAudioTrack, AudioPresets, ConnectionState, ExternalE2EEKeyProvider, isE2EESupported, type RemoteAudioTrack, type RemoteTrackPublication } from 'livekit-client';
import E2EEWorker from 'livekit-client/e2ee-worker?worker';
import { mediaKeyBytes } from '../shared/encryption.mjs';
import { Microphone, playCue } from './audio';
import type { Settings } from './settings';
import { RttMeter } from '../shared/rtt.mjs';
import { PacketLossMeter } from '../shared/packet-loss.mjs';

export interface Person { id: string; name: string; speaking: boolean; muted: boolean; local: boolean; quality: string; rtt?: number; }
export interface Snapshot { state: string; people: Person[]; db: number; speaking: boolean; threshold?: number; rtt?: number; packetLoss?: number; e2ee?: boolean; }
export class VoiceSession {
  room?: Room; mic?: Microphone; localTrack?: LocalAudioTrack;
  muted = false; deafened = false; ptt = false;
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
  private peerRtt = new Map<string, { value: number; received: number }>();
  private collecting = false;
  private lossMeter = new PacketLossMeter();
  onUpdate: (snapshot: Snapshot) => void = () => {};
  onError: (message: string) => void = () => {};
  constructor(public settings: Settings, private transport: { sharedAudioContext?: boolean } = {}) {}
  private syncGate() { this.mic?.update(this.settings, this.muted || this.deafened || this.state !== 'connected', this.ptt); }
  private emit() {
    const room = this.room;
    const now = performance.now();
    this.rtt = this.state === 'connected' ? this.rttMeter.value(now) : undefined;
    const people = room ? [room.localParticipant, ...room.remoteParticipants.values()].map(p => ({
      id: p.identity, name: p.name || 'Участник', local: p === room.localParticipant,
      speaking: p === room.localParticipant ? this.speaking : this.speakers.has(p.identity),
      muted: p === room.localParticipant ? this.muted || this.deafened : p.getTrackPublication(Track.Source.Microphone)?.isMuted ?? true,
      quality: String(p.connectionQuality),
      rtt: p === room.localParticipant ? this.rtt : now - (this.peerRtt.get(p.identity)?.received ?? -Infinity) <= 15000 ? this.peerRtt.get(p.identity)?.value : undefined,
    })) : [];
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
    if (encryption.required && !isE2EESupported()) throw new Error('Этот клиент не поддерживает E2EE. Обновите Voicecord.');
    if (encryption.required) mediaKeyBytes(encryption.key);
    if (encryption.key && !encryption.required) throw new Error('Сервер не подтвердил обязательное E2EE.');
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
    this.room = room; this.state = 'connecting'; this.emit();
    const failEncryption = (message: string) => {
      if (generation !== this.generation || this.stopped) return;
      this.onError(message); void this.disconnect();
    };
    const subscribe = (publication: RemoteTrackPublication) => {
      if (this.encrypted && !publication.isEncrypted) { failEncryption('Комната E2EE получила незашифрованную дорожку. Подключение закрыто.'); return; }
      publication.setSubscribed(true);
    };
    if (worker) worker.addEventListener('error', () => failEncryption('Ошибка E2EE. Подключение закрыто без отключения шифрования.'));
    room.on(RoomEvent.EncryptionError, () => failEncryption('Не удалось расшифровать голос. Проверьте ключ E2EE в приглашении.'));
    room.on(RoomEvent.TrackPublished, publication => { if (this.encrypted) subscribe(publication); });
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (this.encrypted && !publication.isEncrypted) { failEncryption('Получена дорожка без E2EE. Подключение закрыто.'); return; }
      if (track.kind === Track.Kind.Audio) this.attach(track as RemoteAudioTrack, participant.identity);
    });
    room.on(RoomEvent.TrackUnsubscribed, track => {
      const id = track.sid || track.mediaStreamTrack.id;
      this.mic?.removeReference(id); this.mixers.delete(id);
      track.detach().forEach(el => el.remove()); this.elements.delete(id);
    });
    room.on(RoomEvent.ActiveSpeakersChanged, speakers => { this.speakers = new Set(speakers.map(p => p.identity)); this.emit(); });
    room.on(RoomEvent.ParticipantConnected, () => { if (this.settings.sounds) playCue(true); this.emit(); });
    room.on(RoomEvent.ParticipantDisconnected, p => { this.peerRtt.delete(p.identity); });
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic !== 'voicecord.rtt.v1' || !participant || payload.length > 100) return;
      try { const value = JSON.parse(new TextDecoder().decode(payload));
        if (value.rtt === null) this.peerRtt.delete(participant.identity);
        else if (typeof value.rtt === 'number' && Number.isFinite(value.rtt) && value.rtt >= 0 && value.rtt <= 60000) this.peerRtt.set(participant.identity, { value: value.rtt, received: performance.now() });
        this.emit();
      } catch { /* Ignore malformed peer telemetry. */ }
    });
    room.on(RoomEvent.ParticipantDisconnected, () => { if (this.settings.sounds) playCue(false); this.emit(); });
    room.on(RoomEvent.TrackMuted, () => this.emit()); room.on(RoomEvent.TrackUnmuted, () => this.emit());
    room.on(RoomEvent.ConnectionQualityChanged, () => this.emit());
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => { if (!room.canPlaybackAudio) this.onError('Не удалось включить воспроизведение. Переподключитесь к комнате.'); });
    room.on(RoomEvent.ConnectionStateChanged, state => { this.state = state; if (state !== 'connected') { this.rttMeter.reset(); this.peerRtt.clear(); } this.syncGate(); this.emit(); });
    room.on(RoomEvent.Disconnected, () => { if (!this.stopped) { this.onError('Соединение прервано. Подключитесь снова.'); void this.disconnect(); } });
    room.on(RoomEvent.MediaDevicesError, error => this.onError(`Ошибка аудиоустройства: ${error.message}`));
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
      if (this.settings.sounds) playCue(true);
      let tick = 0;
      this.timer = setInterval(() => {
        const others = [...this.speakers].some(id => id !== room.localParticipant.identity && !this.deafened && !this.peopleVolume.get(id)?.muted);
        const active = this.state === 'connected' && ((this.settings.duckOwn && this.speaking) || (this.settings.duckOthers && others));
        this.lastDuck = active;
        void window.desktop?.duck({ active, factor: 1 - this.settings.duckAmount / 100 }).catch(() => {});
        if (this.rtt !== undefined && this.rttMeter.value() === undefined) this.emit();
        if (++tick % 20 === 0) void this.collectStats();
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
    mic.onEnded = () => { this.onError('Микрофон отключён. Выберите доступное устройство.'); this.speaking = false; this.emit(); };
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
  setMute(muted: boolean, deafened: boolean) { this.muted = muted; this.deafened = deafened; this.syncGate(); this.applyVolumes(); void this.syncMute().catch(error => this.onError(String(error))); }
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
    }).catch(error => this.onError(`Не удалось применить устройство: ${error.message}`));
  }
  async collectStats() {
    if (this.collecting || this.state !== 'connected') return;
    this.collecting = true;
    const generation = this.generation;
    try {
      const report = await this.localTrack?.getRTCStatsReport();
      let rttStat: any;
      report?.forEach(stat => { if (stat.type === 'remote-inbound-rtp' && stat.kind === 'audio') rttStat = stat; });
      if (generation !== this.generation) return;
      const rtt = this.rttMeter.sample(rttStat);
      const streams: { id: string; received: number; lost: number }[] = [];
      for (const participant of this.room?.remoteParticipants.values() || []) {
        const track = participant.getTrackPublication(Track.Source.Microphone)?.track;
        const inbound = await track?.getRTCStatsReport();
        inbound?.forEach(stat => { if (stat.type === 'inbound-rtp' && stat.kind === 'audio') streams.push({ id: participant.identity + ':' + stat.id, received: stat.packetsReceived, lost: stat.packetsLost }); });
      }
      if (generation !== this.generation) return;
      this.rtt = rtt;
      if (this.state === 'connected') void this.room?.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ rtt: rtt ?? null })), { reliable: false, topic: 'voicecord.rtt.v1' }).catch(() => {});
      this.packetLoss = this.lossMeter.sample(streams); this.emit();
    } catch { this.emit(); /* Existing measurements still expire if polling fails. */ }
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
    void window.desktop?.duck({ active: false, factor: 1 }).catch(() => {});
    this.rtt = undefined; this.packetLoss = undefined; this.lossMeter.reset(); this.rttMeter.reset(); this.peerRtt.clear();
    if (wasConnected && this.settings.sounds) playCue(false);
    this.emit();
    await Promise.allSettled([room?.disconnect(), playback?.close()]);
    worker?.terminate();
  }
}
