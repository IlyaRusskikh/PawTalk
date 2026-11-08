import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RoomChat } from '../src/RoomChat';
import { VoiceSession } from '../src/session';
import { defaults } from '../src/settings';
import { encryptChat, chatEncoder } from '../src/chat';
import { playSound } from '../src/sounds';
import '../src/style.css';
import '../src/interface.css';

const test = window as any;
const live = new URLSearchParams(location.search).has('live');
const access = { handle: 'test', feed: 'f'.repeat(32), ephemeral: true, encrypted: false, protocol: 2, profileId: 'a'.repeat(64) };
const room = { identity: 'local', nickname: 'Me', ...(!live ? { access } : {}) };
const session = new VoiceSession({ ...defaults });
test.notifications = 0;
session.notifyMessage = () => { test.notifications++; };
const records: any[] = [];
for (let id = 1; id <= 120; id++) records.push({ ...await encryptChat(undefined, `History ${id}: ${'text '.repeat(20)}`), id, author: 'Friend', authorId: 'b'.repeat(64), sent: Date.now() - 100000 });
let activeListener: (active: boolean) => void = () => {};
test.desktop = {
  windowActive: async () => true,
  onWindowActive: (listener: typeof activeListener) => { activeListener = listener; return () => { activeListener = () => {}; }; },
  chatRequest: async (_handle: string, query: any) => {
    if (query.profile) return { ok: true };
    let page = records.filter(record => (!query.after || record.id > query.after) && (!query.before || record.id < query.before));
    page = query.after ? page.slice(0, query.limit) : page.slice(-query.limit);
    return { first: 1, last: records.length, unread: records.filter(record => record.id > (query.readAfter ?? 0)).length, messages: page, profiles: [] };
  },
};
test.setWindowActive = (active: boolean) => activeListener(active);
test.addMessages = async (count = 1, own = false) => {
  for (let i = 0; i < count; i++) records.push({ ...await encryptChat(undefined, `New message ${records.length + 1}`), id: records.length + 1, author: own ? 'Me' : 'Friend', authorId: (own ? 'a' : 'b').repeat(64), sent: Date.now() });
  session.onChatRefresh?.();
};
test.refresh = () => session.onChatRefresh?.();
test.emitLive = async (own = false, repeat = false) => {
  if (!repeat || !test.lastLive) test.lastLive = await encryptChat(undefined, 'Live incoming');
  session.onChat?.(chatEncoder.encode(JSON.stringify(test.lastLive)), own ? 'Me' : 'Friend', own ? 'local' : 'friend');
};
test.audioPlays = [];
const start = AudioBufferSourceNode.prototype.start;
AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
  test.audioPlays.push({ seconds: this.buffer?.duration, channels: this.buffer?.numberOfChannels, sink: (this.context as AudioContext & { sinkId: string }).sinkId });
  return start.apply(this, args);
};
test.playSound = (event: 'join' | 'leave' | 'message', overrides = {}) => playSound(event, { ...defaults, ...overrides });

function Demo() {
  const [visible, setVisible] = useState(true);
  const [covered, setCovered] = useState(false);
  const [connected, setConnected] = useState(true);
  useEffect(() => { test.setChatVisible = setVisible; test.setCovered = setCovered; test.setConnected = setConnected; test.ready = true; }, []);
  return <div style={{ height: 500, display: 'flex', flexDirection: 'column' }}><RoomChat room={room} session={session} people={[]} profile={{ nickname: 'Me' }} visible={visible} covered={covered} connected={connected}/></div>;
}
createRoot(document.getElementById('root')!).render(<Demo/>);
