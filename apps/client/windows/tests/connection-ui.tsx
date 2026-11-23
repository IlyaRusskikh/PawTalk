import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionStatus } from '../src/ConnectionStatus';
import { VoiceSession } from '../src/session';
import { applyTheme, defaultTheme, themePresets } from '../src/theme';
import { changeLanguage } from '../src/i18n';
import '../src/style.css';
import '../src/interface.css';

// Synthetic RTC reports through the real session collector, without a media server.
applyTheme(defaultTheme);
const session: any = new VoiceSession({} as any);
let count = 0;
let feedback = false;
const local = { identity: 'self', name: 'Self', publishData: async () => {} };
session.room = { localParticipant: local, remoteParticipants: new Map() };
session.state = 'connected';
session.diagnostics.reset('connected');
session.localTrack = { getRTCStatsReport: async () => new Map([['rtt', { type: 'remote-inbound-rtp', kind: 'audio', id: 'audio', localId:'out', timestamp:count*5000, fractionLost:feedback ? .125 : undefined, roundTripTime: .083, roundTripTimeMeasurements: count }], ['out', {type:'outbound-rtp',kind:'audio',id:'out',codecId:'codec',mediaSourceId:'source',timestamp:count*5000,bytesSent:count*12000,packetsSent:count*100,ssrc:2154,targetBitrate:64000}], ['codec', {id:'codec',type:'codec',mimeType:'audio/opus',clockRate:48000}], ['source',{id:'source',type:'media-source',audioLevel:.02}]]) };
const root = createRoot(document.getElementById('root')!);
session.onUpdate = snapshot => {
  const self = snapshot.people[0];
  root.render(<div style={{ position: 'fixed', bottom: 8, right: 8 }}>
    <ConnectionStatus name="Self" delay={self?.rtt} loss={self?.packetLoss} diagnostics={session.diagnostics}/>
    <ConnectionStatus name="Peer" delay={222} loss={1.2}/>
  </div>);
};
Object.assign(window, {
  fixture: {
    session,
    sample: async (fresh = true) => { if (fresh) count++; await session.collectStats(); },
    state: state => { session.state = state; session.rttMeter.reset(); session.packetLoss = undefined; session.diagnostics.setState(state); session.emit(); },
    language: changeLanguage,
    theme: name => applyTheme(name === 'light' ? themePresets[5] : defaultTheme),
    snapshot: () => session.diagnostics.getSnapshot(),
    details: details => session.diagnostics.sample({ details, rtt: session.rtt, rttAt: session.rttMeter.measuredAt }),
    feedback: value => { feedback = value; },
    render: () => session.emit(),
    fail: async () => { const track = session.localTrack; session.localTrack = { getRTCStatsReport: async () => { throw Error('synthetic failure'); } }; await session.collectStats(); session.localTrack = track; },
    race: async () => {
      const track = session.localTrack; let resolve;
      session.localTrack = { getRTCStatsReport: () => new Promise(r => resolve = r) };
      const pending = session.collectStats(); ++session.statsEpoch;
      session.diagnostics.setState('reconnecting'); session.state = 'reconnecting';
      resolve(new Map()); await pending; session.localTrack = track;
    },
    protectedAudioState: async () => {
      const voice: any = new VoiceSession({} as any);
      const microphone = { isMuted: true };
      const peer = { identity: 'other', name: 'Other', getTrackPublication: () => microphone };
      voice.room = { localParticipant: local, remoteParticipants: new Map([[peer.identity, peer]]) };
      voice.state = 'connected';
      voice.peerDeafened.set(peer.identity, true);
      let remote: { deafened?: boolean } | undefined;
      voice.onUpdate = snapshot => { remote = snapshot.people.find(person => !person.local); };
      const requests: { sample: { deafened: boolean }; reply: (value: unknown) => void }[] = [];
      voice.protectedVoice = { transport: {
        telemetry: sample => new Promise(resolve => requests.push({ sample, reply: resolve })),
      } };
      const flush = () => new Promise(resolve => setTimeout(resolve, 0));
      voice.setMute(true, true);
      voice.setMute(false, false);
      requests[0].reply({ peers: [{ sessionId: peer.identity, deafened: true, rtt: null, loss: null }], commands: [] });
      await flush();
      const whileDeafened = remote?.deafened;
      microphone.isMuted = false;
      voice.emit();
      const afterMicResumes = remote?.deafened;
      microphone.isMuted = true;
      requests[1].reply({ peers: [{ sessionId: peer.identity, rtt: null, loss: null }], commands: [] });
      await flush();
      return { sent: requests.map(request => request.sample.deafened), whileDeafened, afterMicResumes, afterClearing: remote?.deafened };
    },
    protectedStatusTransitions: async () => {
      const voice: any = new VoiceSession({} as any);
      const active = { scope: { serverId: 'server', channelId: 'room' }, connected: true, keyPending: false, serverDeafened: false };
      voice.room = { state: 'connected', isE2EEEnabled: true, localParticipant: local, remoteParticipants: new Map() };
      voice.state = 'connected';
      voice.protectedVoice = active;
      voice.protectedWorkerReady = true;
      voice.protectedEpoch = { epochId: 'a'.repeat(32), expiresAt: Date.now() + 15000 };
      const states: string[] = [];
      voice.onUpdate = snapshot => {
        if (snapshot.voiceProtection) states.push(snapshot.voiceProtection.state + ':' + snapshot.voiceProtection.reason);
      };
      voice.updateProtectedVoiceStatus(active);
      let blockedVolume: number | undefined;
      voice.mixers.set('remote', { identity: 'remote', track: { setVolume: (value: number) => { blockedVolume = value; } } });
      voice.room.localParticipant = { ...local, permissions: { canSubscribe: false, canPublish: false } };
      voice.updateProtectedVoiceStatus(active);
      const mediaDeafen = { protection: voice.voiceProtection.state, volume: blockedVolume };
      voice.mixers.clear();
      voice.room.localParticipant = local;
      active.keyPending = true;
      voice.updateProtectedVoiceStatus(active);
      const mediaReadyDuringUpdate = voice.protectedMediaReady();
      active.keyPending = false;
      voice.updateProtectedVoiceStatus(active);
      active.keyPending = true;
      voice.updateProtectedVoiceStatus(active);
      await new Promise(resolve => setTimeout(resolve, 1400));
      active.keyPending = false;
      voice.updateProtectedVoiceStatus(active);
      active.serverDeafened = true;
      voice.updateProtectedVoiceStatus(active);
      voice.setProtectedVoiceStatus(active, 'red', 'VOICE_KEY_INVALID');
      return { states, mediaDeafen, mediaReadyDuringUpdate };
    },
    disconnect: async () => { session.room = undefined; session.localTrack = undefined; await session.disconnect(); },
  }
});
session.emit();
