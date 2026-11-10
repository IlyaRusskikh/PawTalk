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
const local = { identity: 'self', name: 'Self', publishData: async () => {} };
session.room = { localParticipant: local, remoteParticipants: new Map() };
session.state = 'connected';
session.diagnostics.reset('connected');
session.localTrack = { getRTCStatsReport: async () => new Map([['rtt', { type: 'remote-inbound-rtp', kind: 'audio', id: 'audio', roundTripTime: .083, roundTripTimeMeasurements: count }]]) };
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
    render: () => session.emit(),
    fail: async () => { const track = session.localTrack; session.localTrack = { getRTCStatsReport: async () => { throw Error('synthetic failure'); } }; await session.collectStats(); session.localTrack = track; },
    race: async () => {
      const track = session.localTrack; let resolve;
      session.localTrack = { getRTCStatsReport: () => new Promise(r => resolve = r) };
      const pending = session.collectStats(); ++session.statsEpoch;
      session.diagnostics.setState('reconnecting'); session.state = 'reconnecting';
      resolve(new Map()); await pending; session.localTrack = track;
    },
    disconnect: async () => { session.room = undefined; session.localTrack = undefined; await session.disconnect(); },
  }
});
session.emit();
