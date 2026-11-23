import { t } from './i18n';
import { Room, RoomEvent, Track, LocalAudioTrack, AudioPresets, ConnectionState, ExternalE2EEKeyProvider, isE2EESupported, type Participant, type RemoteAudioTrack, type RemoteTrackPublication } from 'livekit-client';
import E2EEWorker from 'livekit-client/e2ee-worker?worker';
import { mediaKeyBytes, validMediaKey } from '../../../../shared/encryption.mjs';
import { Microphone } from './audio';
import { playSound } from './sounds';
import type { Settings } from './settings';
import { ConnectionHistory } from '../../../../shared/connection-history.mjs';
import { RtcDiagnosticsMeter } from '../../../../shared/rtc-diagnostics.mjs';
import { RttMeter } from '../../../../shared/rtt.mjs';
import { PacketLossMeter } from '../../../../shared/packet-loss.mjs';
import { avatarPayloadLimit, validAvatar } from './avatarImage';
import { confirmProtectedVoiceWorkerKey } from './protectedVoiceWorker';

const avatarTopic = 'pawtalk.avatar.v1';
const nicknameTopic = 'pawtalk.nickname.v1';
const profileRequestTopic = 'pawtalk.profile-request.v1';

export interface Person { id: string; name: string; avatar?: string; speaking: boolean; muted: boolean; deafened?: boolean;
  serverMuted?: boolean; serverDeafened?: boolean; local: boolean; rtt?: number; packetLoss?: number; diagnostics?: ConnectionHistory; }
export interface Snapshot { state: string; people: Person[]; db: number; speaking: boolean; threshold?: number; rtt?: number; packetLoss?: number; e2ee?: boolean; voiceProtection?: ProtectedVoiceStatus; }
type ProtectedVoiceScope = { serverId: string; channelId: string };
export type ProtectedVoiceStatus = ProtectedVoiceScope & { state: 'green' | 'yellow' | 'red' | 'grey';
  reason: 'VOICE_VERIFIED' | 'VOICE_KEY_PENDING' | 'VOICE_SERVER_DEAFENED' | 'VOICE_OFFLINE' | 'VOICE_KEY_INVALID' | 'VOICE_KEY_EXPIRED' | 'VOICE_ENCRYPTION_LOST' };
export interface ProtectedVoiceEpoch { epochId: string; expiresAt: number; }
type ProtectedVoiceKey = ProtectedVoiceEpoch & { key: string };
type ProtectedVoiceAccess = { url: string; token: string; e2eeRequired: true; channelId?: string } &
  ({ key: string; epoch: ProtectedVoiceEpoch; serverDeafened?: never } | { serverDeafened: true; key?: never; epoch?: never });
type VoiceNetworkSample = { rtt: number | null; loss: number | null; deafened?: boolean; muted?: boolean };
type VoiceChannelAction = 'voice.mute' | 'voice.deafen';
type VoiceTelemetry = { peers: ({ sessionId: string } & VoiceNetworkSample)[];
  commands: { id: string; action: VoiceChannelAction }[] };
export interface ProtectedVoiceTransport {
  join(): Promise<ProtectedVoiceAccess>;
  refresh(epochId: string | null): Promise<ProtectedVoiceKey | { serverDeafened: true } | null>;
  reconnect(): Promise<ProtectedVoiceAccess>;
  leave(): Promise<void>;
  telemetry?(sample: VoiceNetworkSample): Promise<VoiceTelemetry>;
  onChannelControl?(action: VoiceChannelAction): void;
  onChannelChange?(channelId: string): void;
}
interface ProtectedVoiceLifecycle {
  transport: ProtectedVoiceTransport;
  scope?: ProtectedVoiceScope;
  pending?: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>;
  refreshDue?: number;
  refreshUrgent?: boolean;
  telemetryPending?: boolean;
  telemetryDirty?: boolean;
  appliedCommands?: Map<VoiceChannelAction, string>;
  connected: boolean;
  reconnecting: boolean;
  transportUnverified: boolean;
  keyPending: boolean;
  serverDeafened?: boolean;
  peerPendingUntil?: number;
  pendingStatusTimer?: ReturnType<typeof setTimeout>;
}

const voicePendingNoticeDelay = 1250;
const terminalVoiceErrors = new Set(['VOICE_ACCESS_DENIED', 'PROTECTED_ACCESS_DENIED', 'PROTECTED_TIMED_OUT',
  'INVALID_PROTECTED_SESSION', 'VOICE_SLOT_LOST', 'DEVICE_REVOKED', 'BANNED', 'NOT_A_MEMBER']);

function terminalVoiceError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && terminalVoiceErrors.has(String(error.code));
}

function protectedVoiceErrorCode(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message : '';
}

function invalidProtectedVoiceProof(error: unknown) {
  return ['INVALID_PROTECTED_VOICE_KEY', 'UNVERIFIED_VOICE_ROSTER', 'UNVERIFIED_PROTECTED_VOICE_WORKER_KEY',
    'INVALID_SCOPE_AUTHORITY', 'INVALID_POLICY_ATTESTATION', 'POLICY_FORK', 'POLICY_ROLLBACK'].includes(protectedVoiceErrorCode(error));
}

function validVoiceEpoch(epoch: ProtectedVoiceEpoch) {
  return typeof epoch?.epochId === 'string' && /^[0-9a-f]{32}$/.test(epoch.epochId) &&
    Number.isSafeInteger(epoch.expiresAt) && epoch.expiresAt > Date.now();
}

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
  private keyProvider?: ExternalE2EEKeyProvider;
  private protectedEpoch?: ProtectedVoiceEpoch;
  private protectedKeyUpdate = false;
  private protectedWorkerReady = false;
  private protectedProofAbort?: AbortController;
  private voiceProtection?: ProtectedVoiceStatus;
  private keyExpiryTimer?: ReturnType<typeof setTimeout>;
  private protectedVoice?: ProtectedVoiceLifecycle;
  private leavingProtectedVoice?: Promise<void>;
  private encrypted = false;
  private timer?: ReturnType<typeof setInterval>;
  private db = -100; private speaking = false; private state = 'disconnected';
  private threshold?: number;
  private queue = Promise.resolve(); private generation = 0; private stopped = false;
  private lastDuck = false; private rtt?: number; private packetLoss?: number;
  private rttMeter = new RttMeter();
  readonly diagnostics = new ConnectionHistory();
  private diagnosticsMeter = new RtcDiagnosticsMeter();
  private statsEpoch = 0;
  private peerNetwork = new Map<string, { rtt?: number; packetLoss?: number; deafened?: boolean; received: number }>();
  private peerAvatars = new Map<string, string>();
  private peerNicknames = new Map<string, string>();
  private avatar?: string;
  private nickname?: string;
  private collecting = false;
  private lossMeter = new PacketLossMeter();
  onUpdate: (snapshot: Snapshot) => void = () => {};
  onError: (message: string) => void = () => {};
  constructor(public settings: Settings, private transport: { sharedAudioContext?: boolean } = {}) {}
  private playRoomCue(connected: boolean) {
    if (!this.deafened) void playSound(connected ? 'join' : 'leave', this.settings);
  }
  notifyMessage() {
    if (!this.deafened && this.state === 'connected') void playSound('message', this.settings);
  }
  private syncGate() {
    this.mic?.update(this.settings,
      this.muted || this.deafened || this.state !== 'connected' || !this.protectedMediaReady() ||
      this.room?.localParticipant.permissions?.canPublish === false, this.ptt);
  }
  private protectedMediaReady() {
    const active = this.protectedVoice;
    return !active || (this.protectedWorkerReady && !active.transportUnverified && !active.keyPending && !active.serverDeafened &&
      this.room?.state === ConnectionState.Connected && this.room.isE2EEEnabled &&
      !!this.protectedEpoch && validVoiceEpoch(this.protectedEpoch));
  }
  private setProtectedVoiceStatus(active: ProtectedVoiceLifecycle, state: ProtectedVoiceStatus['state'],
    reason: ProtectedVoiceStatus['reason'], revealPending = false) {
    if (this.protectedVoice !== active || !active.scope) return;
    const previous = this.voiceProtection;
    const sameScope = previous?.serverId === active.scope.serverId && previous.channelId === active.scope.channelId;
    if (reason === 'VOICE_KEY_PENDING' && !revealPending && sameScope && previous.state === 'green' &&
        this.protectedEpoch && validVoiceEpoch(this.protectedEpoch)) {
      // Preserve the last verified indication through a short transition. The
      // audio gate and the worker still enforce the current key immediately.
      active.pendingStatusTimer ??= setTimeout(() => {
        active.pendingStatusTimer = undefined;
        this.updateProtectedVoiceStatus(active, true);
      }, voicePendingNoticeDelay);
      return;
    }
    clearTimeout(active.pendingStatusTimer);
    active.pendingStatusTimer = undefined;
    if (sameScope && (previous.state === state && previous.reason === reason || previous.state === 'red' && state !== 'green' && state !== 'red')) return;
    this.voiceProtection = { ...active.scope, state, reason };
    this.emit();
  }
  private updateProtectedVoiceStatus(active: ProtectedVoiceLifecycle, revealPending = false) {
    if (this.protectedVoice !== active) return;
    this.syncGate();
    this.applyVolumes();
    if (active.transportUnverified || active.reconnecting || active.connected && this.room?.state !== ConnectionState.Connected) {
      this.setProtectedVoiceStatus(active, 'grey', 'VOICE_OFFLINE');
    } else if (active.serverDeafened && !this.protectedKeyUpdate) {
      this.setProtectedVoiceStatus(active, 'grey', 'VOICE_SERVER_DEAFENED');
    } else if (this.protectedMediaReady() && (active.peerPendingUntil ?? 0) <= performance.now()) {
      this.setProtectedVoiceStatus(active, 'green', 'VOICE_VERIFIED');
    } else {
      this.setProtectedVoiceStatus(active, 'yellow', 'VOICE_KEY_PENDING', revealPending);
    }
  }
  private emit() {
    const room = this.room;
    const now = performance.now();
    this.rtt = this.state === 'connected' ? this.rttMeter.value(now) ?? this.protectedSignalRtt() : undefined;
    const people = room ? [room.localParticipant, ...room.remoteParticipants.values()].map(p => {
      const local = p === room.localParticipant;
      const peer = this.peerNetwork.get(p.identity);
      const fresh = peer && now - peer.received <= 15000 ? peer : undefined;
      const muted = local ? this.muted || this.deafened || p.permissions?.canPublish === false :
        p.getTrackPublication(Track.Source.Microphone)?.isMuted ?? true;
      return {
        id: p.identity, name: (local ? this.nickname : this.peerNicknames.get(p.identity)) || p.name || t("Участник"), local,
        avatar: local ? this.avatar : this.peerAvatars.get(p.identity),
        speaking: local ? this.speaking : this.speakers.has(p.identity),
        muted,
        deafened: local ? this.deafened : this.protectedVoice
          ? muted && fresh?.deafened === true : this.peerDeafened.get(p.identity) === true,
        rtt: local ? this.rtt : fresh?.rtt,
        packetLoss: local ? this.packetLoss : fresh?.packetLoss,
        diagnostics: local ? this.diagnostics : undefined,
      };
    }) : [];
    this.onUpdate({ state: this.state, people, db: this.db, speaking: this.speaking, threshold: this.threshold, rtt: this.rtt, packetLoss: this.packetLoss,
      e2ee: this.encrypted, ...(this.voiceProtection && { voiceProtection: this.voiceProtection }) });
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
    const receiving = this.room?.localParticipant.permissions?.canSubscribe !== false && this.protectedMediaReady();
    this.mixers.forEach(mixer => {
      const pref = this.peopleVolume.get(mixer.identity) || { volume: 1, muted: false };
      mixer.track.setVolume(!receiving || this.deafened || pref.muted ? 0 : pref.volume * this.settings.outputVolume);
    });
  }
  async connectProtected(transport: ProtectedVoiceTransport, scope?: ProtectedVoiceScope) {
    await this.leavingProtectedVoice;
    if (this.room || this.protectedVoice) throw new Error('VOICE_OCCUPIED');
    const active: ProtectedVoiceLifecycle = { transport, scope, connected: false, reconnecting: false, transportUnverified: false, keyPending: true };
    this.protectedVoice = active;
    if (!scope) this.voiceProtection = undefined;
    this.setProtectedVoiceStatus(active, 'yellow', 'VOICE_KEY_PENDING');
    const request = Promise.resolve().then(() => transport.join());
    active.pending = request;
    try {
      const access = await request;
      if (this.protectedVoice !== active) return;
      await this.connectProtectedMedia(access);
      if (this.protectedVoice !== active) return;
      active.connected = true;
      this.updateProtectedVoiceStatus(active);
      if (transport.telemetry) void this.collectStats();
    } catch (error) {
      if (this.protectedVoice === active) {
        if (invalidProtectedVoiceProof(error)) this.setProtectedVoiceStatus(active, 'red', 'VOICE_KEY_INVALID');
        await this.disconnect();
      }
      throw error;
    } finally {
      if (active.pending === request) active.pending = undefined;
      this.scheduleProtectedVoiceRefresh(active);
    }
  }
  private scheduleProtectedVoiceRefresh(active: ProtectedVoiceLifecycle, urgent = false) {
    if (this.protectedVoice !== active || !active.connected || active.reconnecting) return;
    if (active.pending) {
      if (urgent) active.refreshUrgent = true;
      return;
    }
    const delay = urgent || active.refreshUrgent || (!active.serverDeafened && active.keyPending) ? 1000 : 5000;
    active.refreshUrgent = false;
    const due = performance.now() + delay;
    if (active.refreshDue !== undefined && active.refreshDue <= due) return;
    clearTimeout(active.timer);
    active.refreshDue = due;
    active.timer = setTimeout(() => {
      active.refreshDue = undefined;
      void this.refreshProtectedVoice(active);
    }, delay);
  }
  private async refreshProtectedVoice(active: ProtectedVoiceLifecycle) {
    const epochId = this.protectedEpoch?.epochId ?? null;
    if (this.protectedVoice !== active || active.reconnecting || epochId === null && !active.serverDeafened) return;
    const request = Promise.resolve().then(() => active.transport.refresh(epochId));
    active.pending = request;
    try {
      const next = await request;
      if (this.protectedVoice !== active || active.reconnecting) return;
      active.transportUnverified = false;
      if (next && 'serverDeafened' in next) {
        active.serverDeafened = true;
        active.keyPending = true;
        this.protectedWorkerReady = false;
        if (this.localTrack) void this.replaceMicrophone(this.generation, false).catch(error => this.onError(String(error)));
      } else if (next) {
        await this.rotateProtectedVoiceKey(epochId, next);
      } else if (!active.serverDeafened) {
        active.keyPending = false;
      }
      this.updateProtectedVoiceStatus(active);
      if (this.protectedMediaReady() && !this.localTrack) {
        void this.replaceMicrophone(this.generation, false).catch(error => this.onError(String(error)));
      }
    } catch (error) {
      if (this.protectedVoice !== active || active.reconnecting) return;
      if (protectedVoiceErrorCode(error) === 'VOICE_MOVE_READY') {
        void this.reconnectProtectedVoice(active);
        return;
      }
      if (invalidProtectedVoiceProof(error) || terminalVoiceError(error)) {
        if (invalidProtectedVoiceProof(error)) this.setProtectedVoiceStatus(active, 'red', 'VOICE_KEY_INVALID');
        this.onError(invalidProtectedVoiceProof(error) ? t('Не удалось проверить защиту голосового соединения.') :
          t('Голосовое соединение завершено сервером.'));
        await this.disconnect();
      } else {
        const code = protectedVoiceErrorCode(error);
        active.keyPending = ['VOICE_GRANT_CHANGED', 'VOICE_KEY_PENDING', 'PROTECTED_KEY_PENDING', 'POLICY_ATTESTATION_UNAVAILABLE',
          'UNVERIFIED_EPOCH_POLICY'].includes(code);
        active.transportUnverified = !active.keyPending;
        this.updateProtectedVoiceStatus(active);
      }
    } finally {
      if (active.pending === request) active.pending = undefined;
      this.scheduleProtectedVoiceRefresh(active);
    }
  }
  private async reconnectProtectedVoice(active: ProtectedVoiceLifecycle) {
    if (this.protectedVoice !== active || active.reconnecting) return;
    active.reconnecting = true;
    active.connected = false;
    active.transportUnverified = true;
    this.updateProtectedVoiceStatus(active);
    clearTimeout(active.timer);
    active.refreshDue = undefined;
    await this.resetAudio(true);
    await active.pending?.catch(() => {});
    try {
      for (const delay of [0, 1000, 3000]) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (this.protectedVoice !== active) return;
        const request = Promise.resolve().then(() => active.transport.reconnect());
        active.pending = request;
        let access: ProtectedVoiceAccess;
        try { access = await request; }
        catch (error) { if (terminalVoiceError(error) || invalidProtectedVoiceProof(error) || delay === 3000) throw error; else continue; }
        finally { if (active.pending === request) active.pending = undefined; }
        if (this.protectedVoice !== active) return;
        const nextChannel = access?.channelId;
        if (nextChannel !== undefined && !/^[0-9a-f]{32}$/.test(nextChannel)) throw new Error('INVALID_PROTECTED_VOICE_KEY');
        const previousScope = active.scope;
        const moved = previousScope && nextChannel !== undefined && nextChannel !== previousScope.channelId;
        if (moved) active.scope = { ...previousScope, channelId: nextChannel };
        active.transportUnverified = false;
        active.keyPending = true;
        this.setProtectedVoiceStatus(active, 'yellow', 'VOICE_KEY_PENDING');
        await this.connectProtectedMedia(access);
        if (this.protectedVoice !== active) return;
        active.connected = true;
        active.reconnecting = false;
        this.updateProtectedVoiceStatus(active);
        if (moved) active.transport.onChannelChange?.(nextChannel);
        this.scheduleProtectedVoiceRefresh(active);
        if (active.transport.telemetry) void this.collectStats();
        return;
      }
    } catch (error) {
      if (this.protectedVoice === active) {
        if (invalidProtectedVoiceProof(error)) this.setProtectedVoiceStatus(active, 'red', 'VOICE_KEY_INVALID');
        this.onError(t("Соединение прервано. Подключитесь снова."));
        await this.disconnect();
      }
    }
  }
  private async connectProtectedMedia(access: ProtectedVoiceAccess) {
    const active = this.protectedVoice;
    if (!active || access?.e2eeRequired !== true) throw new Error('INVALID_PROTECTED_VOICE_KEY');
    const parked = access.serverDeafened === true;
    if (parked ? access.key !== undefined || access.epoch !== undefined : !validMediaKey(access.key) || !access.epoch || !validVoiceEpoch(access.epoch)) {
      throw new Error('INVALID_PROTECTED_VOICE_KEY');
    }
    active.serverDeafened = parked;
    if (!isE2EESupported()) this.setProtectedVoiceStatus(active, 'red', 'VOICE_ENCRYPTION_LOST');
    await this.connect(access.url, access.token, { required: access.e2eeRequired, key: access.key, epoch: access.epoch, parked });
    if (this.room?.state !== ConnectionState.Connected) throw new Error('VOICE_DISCONNECTED');
  }
  async connect(url: string, token: string, encryption: { required?: boolean; key?: string; epoch?: ProtectedVoiceEpoch; parked?: boolean } = {}) {
    if (encryption.required !== true) throw new Error(t('Сервер не подтвердил обязательное E2EE.'));
    if (encryption.required && !isE2EESupported()) throw new Error(t("Этот клиент не поддерживает E2EE. Обновите PawTalk."));
    if (encryption.parked ? !this.protectedVoice?.serverDeafened || encryption.key !== undefined || encryption.epoch !== undefined : !validMediaKey(encryption.key)) {
      throw new Error(t('Нужен ключ E2EE из приглашения: 64 шестнадцатеричных символа.'));
    }
    if (encryption.key && !encryption.required) throw new Error(t("Сервер не подтвердил обязательное E2EE."));
    if (encryption.epoch && !validVoiceEpoch(encryption.epoch)) throw new Error('INVALID_PROTECTED_VOICE_KEY');
    this.stopped = false;
    this.encrypted = encryption.required === true;
    const generation = ++this.generation;
    const keyProvider = this.encrypted ? new ExternalE2EEKeyProvider() : undefined;
    this.keyProvider = keyProvider;
    const lifecycle = encryption.epoch || encryption.parked ? this.protectedVoice : undefined;
    const worker = this.encrypted ? new E2EEWorker() : undefined;
    this.encryptionWorker = worker;
    this.playback = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    const room = new Room({ adaptiveStream: false, dynacast: false, webAudioMix: { audioContext: this.playback },
      audioOutput: { deviceId: this.settings.outputDevice === 'default' ? '' : this.settings.outputDevice },
      publishDefaults: { audioPreset: AudioPresets.speech, dtx: true, red: true, stopMicTrackOnMute: false },
      ...(lifecycle ? { reconnectPolicy: { nextRetryDelayInMs: () => null } } : {}),
      ...(keyProvider && worker ? { encryption: { keyProvider, worker } } : {}),
    });
    this.room = room; this.state = 'connecting'; this.diagnostics.reset('connecting'); this.emit();
    const failEncryption = (message: string) => {
      if (generation !== this.generation || this.stopped) return;
      if (lifecycle) {
        this.protectedWorkerReady = false;
        this.syncGate();
        this.applyVolumes();
        this.setProtectedVoiceStatus(lifecycle, 'red', 'VOICE_ENCRYPTION_LOST');
      }
      this.onError(message); void this.disconnect();
    };
    const subscribe = (publication: RemoteTrackPublication) => {
      if (lifecycle?.serverDeafened || room.localParticipant.permissions?.canSubscribe === false) return;
      if (this.encrypted && !publication.isEncrypted) { failEncryption(t("Комната E2EE получила незашифрованную дорожку. Подключение закрыто.")); return; }
      publication.setSubscribed(true);
    };
    if (worker) worker.addEventListener('error', () => failEncryption(t("Ошибка E2EE. Подключение закрыто без отключения шифрования.")));
    room.on(RoomEvent.EncryptionError, (error, participant) => {
      // Peers can receive the next verified key at different times. The SDK
      // drops unauthenticated frames during that interval.
      if ((this.protectedEpoch || lifecycle?.serverDeafened) && participant && participant !== room.localParticipant &&
          /^(InvalidKey|MissingKey):/.test(error.message)) {
        if (lifecycle) {
          lifecycle.peerPendingUntil = performance.now() + 1000;
          this.scheduleProtectedVoiceRefresh(lifecycle, true);
          this.updateProtectedVoiceStatus(lifecycle);
        }
        return;
      }
      failEncryption(t("Не удалось расшифровать голос. Проверьте ключ E2EE в приглашении."));
    });
    room.on(RoomEvent.ParticipantEncryptionStatusChanged, (enabled, participant) => {
      if (lifecycle && participant === room.localParticipant && !enabled && this.protectedWorkerReady) {
        failEncryption(t('Ошибка E2EE. Подключение закрыто без отключения шифрования.'));
      }
    });
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
    const peerProfileRequests = new Map<string, number>();
    room.on(RoomEvent.ParticipantDisconnected, p => {
      this.peerNetwork.delete(p.identity); this.peerDeafened.delete(p.identity); this.peerAvatars.delete(p.identity); this.peerNicknames.delete(p.identity);
      peerProfileRequests.delete(p.identity);
      if (lifecycle) this.scheduleProtectedVoiceRefresh(lifecycle, true);
    });
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (participant && payload.length === 0 && topic === profileRequestTopic) {
        const now = performance.now();
        if (now - (peerProfileRequests.get(participant.identity) ?? -Infinity) < 1000) return;
        peerProfileRequests.set(participant.identity, now);
        this.publishAvatar(participant.identity); this.publishNickname(participant.identity);
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
      if (lifecycle) return;
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
    room.on(RoomEvent.ConnectionStateChanged, state => {
      if (generation !== this.generation || this.stopped) return;
      this.state = lifecycle?.connected && state === ConnectionState.Disconnected ? ConnectionState.Reconnecting : state;
      ++this.statsEpoch;
      this.diagnostics.setState(state);
      if (state === 'connected' && !lifecycle) {
        this.publishAudioState();
        this.syncProfile();
      } else if (state !== 'connected') {
        this.rttMeter.reset(); this.lossMeter.reset(); this.diagnosticsMeter.reset();
        this.packetLoss = undefined; this.peerNetwork.clear(); this.peerDeafened.clear();
      }
      if (lifecycle) {
        this.updateProtectedVoiceStatus(lifecycle);
        this.scheduleProtectedVoiceRefresh(lifecycle, true);
      }
      else this.syncGate();
      this.emit();
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.stopped || generation !== this.generation) return;
      if (lifecycle) {
        if (lifecycle.connected && !lifecycle.reconnecting && this.protectedVoice === lifecycle) {
          void this.reconnectProtectedVoice(lifecycle);
        }
      } else {
        this.onError(t("Соединение прервано. Подключитесь снова."));
        void this.disconnect();
      }
    });
    room.on(RoomEvent.MediaDevicesError, error => this.onError(t("Ошибка аудиоустройства: {0}", error.message)));
    room.on(RoomEvent.ParticipantPermissionsChanged, (previous, participant) => {
      if (participant !== room.localParticipant || generation !== this.generation || this.stopped) return;
      if (lifecycle) this.updateProtectedVoiceStatus(lifecycle);
      else { this.syncGate(); this.applyVolumes(); }
      this.emit();
      if (this.encrypted && previous?.canSubscribe === false && participant.permissions?.canSubscribe === true) {
        room.remoteParticipants.forEach(peer => peer.trackPublications.forEach(subscribe));
      }
      if (room.state === ConnectionState.Connected && previous?.canPublish !== participant.permissions?.canPublish) {
        void this.replaceMicrophone(generation, false).catch(error => this.onError(String(error)));
      }
    });
    try {
      if (keyProvider) {
        if (encryption.epoch) this.setProtectedEpoch(encryption.epoch, generation);
        if (!encryption.parked) await this.installMediaKey(keyProvider, encryption.key);
        await room.setE2EEEnabled(true);
      }
      await this.playback.setSinkId(this.settings.outputDevice === 'default' ? '' : this.settings.outputDevice);
      await this.playback.resume();
      await room.connect(url, token, { autoSubscribe: !this.encrypted });
      if (generation !== this.generation) { await room.disconnect(); return; }
      if (encryption.parked && (room.localParticipant.permissions?.canPublish !== false || room.localParticipant.permissions?.canSubscribe !== false ||
          room.localParticipant.permissions?.canPublishData !== false)) throw new Error('INVALID_PROTECTED_VOICE_KEY');
      if (lifecycle && encryption.epoch) {
        await this.confirmProtectedMedia(room, lifecycle, generation, encryption.epoch);
        if (generation !== this.generation) return;
        this.protectedWorkerReady = true;
        lifecycle.keyPending = false;
        this.updateProtectedVoiceStatus(lifecycle);
      }
      if (this.encrypted) room.remoteParticipants.forEach(p => p.trackPublications.forEach(subscribe));
      if (generation !== this.generation) return;
      this.state = 'connected';
      await this.replaceMicrophone(generation, false);
      if (generation !== this.generation) return;
      await room.startAudio();
      if (generation !== this.generation) return;
      if (!encryption.parked) {
        if (lifecycle) this.publishAudioState();
        this.syncProfile();
      }
      if (!lifecycle?.reconnecting) this.playRoomCue(true);
      let tick = 0;
      this.timer = setInterval(() => {
        const others = [...this.speakers].some(id => id !== room.localParticipant.identity && !this.deafened && !this.peopleVolume.get(id)?.muted);
        const active = this.state === 'connected' && ((this.settings.duckOwn && this.speaking) || (this.settings.duckOthers && others));
        this.lastDuck = active;
        void window.desktop?.duck({ active, factor: 1 - this.settings.duckAmount / 100 }).catch(() => {});
        if (this.rtt !== undefined && this.rttMeter.value() === undefined && this.protectedSignalRtt() === undefined) this.emit();
        if (++tick % 20 === 0) { void this.collectStats(); this.publishAudioState(); }
      }, 250);
      this.emit();
    } catch (error) { if (generation === this.generation && !lifecycle) await this.disconnect(); throw error; }
  }
  private async installMediaKey(provider: ExternalE2EEKeyProvider, value: string | undefined) {
    const key = mediaKeyBytes(value);
    try {
      await provider.setKey(key.buffer as ArrayBuffer);
    } finally {
      key.fill(0);
    }
  }
  private async confirmProtectedMedia(room: Room, active: ProtectedVoiceLifecycle, generation: number, epoch: ProtectedVoiceEpoch) {
    const worker = this.encryptionWorker;
    const provider = this.keyProvider;
    const unverified = () => new Error('UNVERIFIED_PROTECTED_VOICE_WORKER_KEY');
    if (!worker || !provider) throw unverified();
    const controller = new AbortController();
    this.protectedProofAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      if (!room.isE2EEEnabled) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            room.off(RoomEvent.ParticipantEncryptionStatusChanged, onEncryption);
            controller.signal.removeEventListener('abort', onAbort);
          };
          const onAbort = () => { cleanup(); reject(unverified()); };
          const onEncryption = (enabled: boolean, participant?: Participant) => {
            if (!enabled || participant !== room.localParticipant) return;
            cleanup();
            resolve();
          };
          room.on(RoomEvent.ParticipantEncryptionStatusChanged, onEncryption);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      await confirmProtectedVoiceWorkerKey(worker, provider, room.localParticipant.identity, controller.signal);
      if (generation !== this.generation || this.protectedVoice !== active || this.room !== room ||
          room.state !== ConnectionState.Connected || !room.isE2EEEnabled || !validVoiceEpoch(epoch)) throw unverified();
    } catch (error) {
      if (room.state !== ConnectionState.Connected) throw new Error('VOICE_DISCONNECTED');
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.protectedProofAbort === controller) this.protectedProofAbort = undefined;
    }
  }
  private setProtectedEpoch(epoch: ProtectedVoiceEpoch, generation: number) {
    this.protectedEpoch = { ...epoch };
    clearTimeout(this.keyExpiryTimer);
    this.keyExpiryTimer = setTimeout(() => {
      if (generation !== this.generation || this.stopped) return;
      if (this.protectedVoice?.serverDeafened) return;
      if (this.protectedVoice) {
        this.protectedWorkerReady = false;
        this.syncGate();
        this.applyVolumes();
        this.setProtectedVoiceStatus(this.protectedVoice, 'red', 'VOICE_KEY_EXPIRED');
      }
      this.onError(t("Срок действия голосового ключа истёк. Подключение закрыто."));
      void this.disconnect();
    }, Math.max(0, epoch.expiresAt - Date.now()));
  }
  async rotateProtectedVoiceKey(previousEpoch: string | null, next: ProtectedVoiceKey) {
    const current = this.protectedEpoch;
    const provider = this.keyProvider;
    const active = this.protectedVoice;
    const room = this.room;
    const resumingDeafen = active?.serverDeafened === true;
    const generation = this.generation;
    if (!provider || this.stopped || this.protectedKeyUpdate || (current?.epochId ?? null) !== previousEpoch ||
        ((!current || current.expiresAt <= Date.now()) && !active?.serverDeafened) || !validVoiceEpoch(next) ||
        next.epochId === previousEpoch) throw new Error('INVALID_PROTECTED_VOICE_KEY');
    this.protectedKeyUpdate = true;
    if (active) {
      this.protectedWorkerReady = false;
      active.keyPending = true;
      this.updateProtectedVoiceStatus(active);
    }
    try {
      await this.installMediaKey(provider, next.key);
      if (this.stopped || generation !== this.generation || !validVoiceEpoch(next)) throw new Error('INVALID_PROTECTED_VOICE_KEY');
      if (active && room) await this.confirmProtectedMedia(room, active, generation, next);
      if (generation !== this.generation) return;
      this.setProtectedEpoch({ epochId: next.epochId, expiresAt: next.expiresAt }, generation);
      if (active) {
        if (resumingDeafen && room && room.localParticipant.permissions?.canSubscribe !== false) {
          for (const peer of room.remoteParticipants.values()) {
            for (const publication of peer.trackPublications.values()) {
              if (!publication.isEncrypted) throw new Error('INVALID_PROTECTED_VOICE_KEY');
              publication.setSubscribed(true);
            }
          }
        }
        this.protectedWorkerReady = true;
        active.keyPending = false;
        active.serverDeafened = false;
        active.peerPendingUntil = undefined;
        this.updateProtectedVoiceStatus(active);
        if (!current) { this.publishAudioState(); this.syncProfile(); }
      }
    } catch (error) {
      if (active && this.protectedVoice === active && generation === this.generation &&
          protectedVoiceErrorCode(error) !== 'VOICE_DISCONNECTED') {
        this.setProtectedVoiceStatus(active, 'red', 'VOICE_KEY_INVALID');
        this.onError(t('Не удалось проверить защиту голосового соединения.'));
        void this.disconnect();
      }
      throw error;
    } finally {
      if (generation === this.generation) this.protectedKeyUpdate = false;
    }
  }
  private replaceMicrophone(generation: number, force = true) {
    const work = this.queue.then(() => this.syncMicrophone(generation, force));
    this.queue = work.catch(() => {});
    return work;
  }
  private async syncMicrophone(generation: number, force: boolean) {
    if (!this.room || this.stopped || generation !== this.generation) return;
    const room = this.room;
    const canPublish = () => room.localParticipant.permissions?.canPublish !== false && this.protectedMediaReady();
    if (force || !canPublish()) {
      const track = this.localTrack;
      this.localTrack = undefined;
      this.mic?.stop(); this.mic = undefined;
      track?.stop();
      this.speaking = false;
      this.emit();
      if (track) await room.localParticipant.unpublishTrack(track, false);
    }
    if (this.localTrack || generation !== this.generation || !canPublish()) return;
    const mic = new Microphone(this.settings, this.transport.sharedAudioContext === false ? undefined : this.playback);
    mic.muted = this.muted || this.deafened; mic.ptt = this.ptt;
    mic.onMeter = (db, speaking, threshold) => { this.db = db; this.speaking = speaking; this.threshold = threshold; this.emit(); };
    mic.onEnded = () => { this.onError(t("Микрофон отключён. Выберите доступное устройство.")); this.speaking = false; this.emit(); };
    mic.onError = message => this.onError(message);
    try {
      await mic.start();
      if (generation !== this.generation || !canPublish()) { mic.stop(); return; }
      this.mic = mic; this.syncGate();
      this.mixers.forEach(({ track }, id) => mic.addReference(id, track.mediaStreamTrack));
      const track = new LocalAudioTrack(mic.track, undefined, true);
      track.stopOnMute = false;
      this.localTrack = track;
      await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, audioPreset: AudioPresets.speech, dtx: true, red: true });
      if (generation !== this.generation) { track.stop(); mic.stop(); return; }
      await this.syncMute();
    } catch (error) {
      mic.stop();
      if (this.mic === mic) {
        this.mic = undefined;
        this.localTrack?.stop();
        this.localTrack = undefined;
      }
      if (generation === this.generation && canPublish()) throw error;
    }
  }
  private async syncMute() {
    this.syncGate();
    if (this.localTrack) {
      if (this.muted || this.deafened) await this.localTrack.mute(); else await this.localTrack.unmute();
    }
    this.applyVolumes(); this.emit();
  }
  private publishAudioState() {
    if (!this.protectedVoice && this.room?.state === ConnectionState.Connected) void this.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ deafened: this.deafened })), { reliable: true, topic: 'pawtalk.audio-state.v1' }).catch(() => {});
  }
  private publishAvatar(identity?: string) {
    const room = this.room;
    if (this.protectedVoice?.serverDeafened || room?.state !== ConnectionState.Connected) return;
    const payload = new TextEncoder().encode(this.avatar ?? '-');
    void room.localParticipant.publishData(payload, { reliable: true, topic: avatarTopic, destinationIdentities: identity ? [identity] : undefined }).catch(() => {});
  }
  private syncProfile() {
    if (this.protectedVoice?.serverDeafened) return;
    this.publishAvatar(); this.publishNickname();
    const room = this.room;
    if (room?.state === ConnectionState.Connected) void room.localParticipant.publishData(new Uint8Array(), { reliable: true, topic: profileRequestTopic }).catch(() => {});
  }
  setAvatar(avatar?: string) {
    if (avatar === this.avatar || (avatar && !validAvatar(avatar))) return;
    this.avatar = avatar;
    this.publishAvatar();
    this.emit();
  }
  private publishNickname(identity?: string) {
    const room = this.room;
    if (this.protectedVoice?.serverDeafened || !this.nickname || room?.state !== ConnectionState.Connected) return;
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
  setMute(muted: boolean, deafened: boolean) {
    const changed = this.muted !== muted || this.deafened !== deafened;
    this.muted = muted;
    this.deafened = deafened;
    if (!this.protectedVoice) this.publishAudioState();
    else if (changed) this.sendProtectedTelemetry();
    this.emit();
    this.syncGate();
    this.applyVolumes();
    void this.syncMute().catch(error => this.onError(String(error)));
  }
  setPtt(down: boolean) { this.ptt = down; this.syncGate(); }
  refreshProtectedVoiceState(serverId: string, channelId: string) {
    const active = this.protectedVoice;
    if (!active || active.scope?.serverId !== serverId || active.scope.channelId !== channelId) return;
    this.sendProtectedTelemetry();
    this.scheduleProtectedVoiceRefresh(active, true);
  }
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
  private protectedSignalRtt() {
    const rtt = this.room?.engine?.client?.rtt;
    return this.protectedVoice && rtt !== undefined && rtt > 0 && rtt <= 60000 ? rtt : undefined;
  }

  private sendProtectedTelemetry() {
    const active = this.protectedVoice;
    const transport = active?.transport;
    if (!active || !transport?.telemetry || this.state !== 'connected') return;
    if (active.telemetryPending) {
      active.telemetryDirty = true;
      return;
    }
    active.telemetryPending = true;
    const generation = this.generation;
    const epoch = this.statsEpoch;
    const rtt = this.rttMeter.value() ?? this.protectedSignalRtt() ?? null;
    void transport.telemetry({ rtt, loss: this.packetLoss ?? null, deafened: this.deafened, muted: this.muted })
      .then(({ peers, commands }) => {
        if (generation !== this.generation || epoch !== this.statsEpoch || this.state !== 'connected') return;
        const applied = active.appliedCommands ??= new Map();
        for (const { id, action } of commands) {
          if (applied.get(action) === id) continue;
          applied.set(action, id);
          transport.onChannelControl?.(action);
        }
        const received = performance.now();
        this.peerNetwork = new Map(peers.map(({ sessionId, rtt, loss, deafened }) => [
          sessionId, { rtt: rtt ?? undefined, packetLoss: loss ?? undefined, deafened: deafened === true, received },
        ]));
        this.emit();
      }).catch(() => {}).finally(() => {
        active.telemetryPending = false;
        if (active.telemetryDirty && this.protectedVoice === active) {
          active.telemetryDirty = false;
          this.sendProtectedTelemetry();
        }
      });
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
      this.diagnostics.sample({ rtt, rttAt: this.rttMeter.measuredAt, loss: this.packetLoss, details: this.diagnosticsMeter.sample(report) });
      if (this.protectedVoice) {
        this.sendProtectedTelemetry();
      } else {
        const telemetry = { rtt: rtt ?? null, loss: this.packetLoss ?? null };
        void this.room?.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(telemetry)), { reliable: false, topic: 'pawtalk.rtt.v1' }).catch(() => {});
      }
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
    const active = this.protectedVoice;
    if (active) this.setProtectedVoiceStatus(active, 'grey', 'VOICE_OFFLINE');
    this.protectedVoice = undefined;
    clearTimeout(active?.timer);
    const leaving = active && (async () => {
      await active.pending?.catch(() => {});
      await active.transport.leave().catch(() => {});
    })();
    if (leaving) this.leavingProtectedVoice = leaving;
    await Promise.all([this.resetAudio(false), leaving]);
    if (leaving && this.leavingProtectedVoice === leaving) this.leavingProtectedVoice = undefined;
  }
  private async resetAudio(reconnecting: boolean) {
    const wasConnected = this.state === 'connected';
    this.stopped = true; ++this.generation;
    this.protectedProofAbort?.abort();
    this.protectedProofAbort = undefined;
    this.protectedWorkerReady = false;
    clearTimeout(this.keyExpiryTimer); this.keyExpiryTimer = undefined;
    this.keyProvider = undefined; this.protectedEpoch = undefined; this.protectedKeyUpdate = false;
    clearInterval(this.timer); this.timer = undefined;
    this.mic?.stop(); this.mic = undefined; this.localTrack?.stop(); this.localTrack = undefined;
    const room = this.room; this.room = undefined;
    room?.removeAllListeners();
    for (const elements of this.elements.values()) elements.forEach(el => el.remove()); this.elements.clear();
    this.mixers.clear();
    const playback = this.playback; this.playback = undefined;
    const worker = this.encryptionWorker; this.encryptionWorker = undefined; this.encrypted = false;
    if (!reconnecting) { this.peopleVolume.clear(); this.ptt = false; }
    this.speakers.clear(); this.speaking = false; this.db = -100; this.state = reconnecting ? 'reconnecting' : 'disconnected';
    ++this.statsEpoch; this.diagnostics.reset(); this.diagnosticsMeter.reset();
    void window.desktop?.duck({ active: false, factor: 1 }).catch(() => {});
    this.rtt = undefined; this.packetLoss = undefined; this.lossMeter.reset(); this.rttMeter.reset(); this.peerNetwork.clear(); this.peerDeafened.clear(); this.peerAvatars.clear(); this.peerNicknames.clear();
    if (wasConnected && !reconnecting) this.playRoomCue(false);
    this.emit();
    await Promise.allSettled([room?.disconnect(), playback?.close()]);
    worker?.terminate();
  }
}
