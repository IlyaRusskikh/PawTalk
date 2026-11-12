import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RoomChat } from '../src/RoomChat';
import { VoiceSession } from '../src/session';
import { defaults } from '../src/settings';
import { encryptChat, chatEncoder } from '../src/chat';
import { playSound } from '../src/sounds';
import { changeLanguage } from '../src/i18n';
import { applyTheme, defaultTheme } from '../src/theme';
applyTheme(defaultTheme);
await changeLanguage(new URLSearchParams(location.search).get('language') === 'en' ? 'en' : 'ru');
import '../src/style.css';
import '../src/interface.css';

const test = window as any;
const live = new URLSearchParams(location.search).has('live');
const access = { handle: 'test', feed: 'f'.repeat(32), ephemeral: true, encrypted: false, protocol: 2, profileId: 'a'.repeat(64), mutations: new URLSearchParams(location.search).has('features') };
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
    if (query.mutation) {
      if (test.failMutation) throw Error('Synthetic mutation failure');
      const index = records.findIndex(record => record.id === query.mutation.id);
      if (index < 0 || records[index].authorId !== access.profileId) throw Error('Not owned');
      if (query.mutation.packet) records[index] = { ...records[index], ...query.mutation.packet };
      else records.splice(index, 1);
      return { id: query.mutation.id };
    }
    if (query.ids) return { first: records[0]?.id ?? 0, messages: records.filter(record => query.ids.includes(record.id)) };
    let page = records.filter(record => (!query.after || record.id > query.after) && (!query.before || record.id < query.before));
    page = query.after ? page.slice(0, query.limit) : page.slice(-query.limit);
    return { first: records[0]?.id ?? 0, last: records.at(-1)?.id ?? 0, unread: records.filter(record => record.id > (query.readAfter ?? 0)).length, messages: page, profiles: [] };
  },
};
test.setWindowActive = (active: boolean) => activeListener(active);
test.addMessages = async (count = 1, own = false) => {
  for (let i = 0; i < count; i++) records.push({ ...await encryptChat(undefined, `New message ${records.length + 1}`), id: records.length + 1, author: own ? 'Me' : 'Friend', authorId: (own ? 'a' : 'b').repeat(64), sent: Date.now() });
  session.onChatRefresh?.();
};
test.refresh = () => session.onChatRefresh?.();
test.remoteEdit = async (id: number, text?: string) => {
  const index = records.findIndex(record => record.id === id);
  if (text === undefined) records.splice(index, 1);
  else records[index] = { ...records[index], ...await encryptChat(undefined, text, { edited: true }, records[index].requestId) };
  test.refresh();
};
test.emitLive = async (own = false, repeat = false) => {
  if (!repeat || !test.lastLive) test.lastLive = await encryptChat(undefined, 'Live incoming');
  session.onChat?.(chatEncoder.encode(JSON.stringify(test.lastLive)), own ? 'Me' : 'Friend', own ? 'local' : 'friend');
};
test.audioPlays = [];
const audioNodes: {source:AudioBufferSourceNode;gain?:GainNode;ended:boolean}[] = [];
test.soundState = (index:number) => ({ended:audioNodes[index].ended,gain:audioNodes[index].gain?.gain.value});
const soundGains = new WeakMap<AudioNode, GainNode>();
const connect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (...args: any[]) {
  if (this instanceof AudioBufferSourceNode && args[0] instanceof GainNode) soundGains.set(this, args[0]);
  return (connect as any).apply(this, args);
} as typeof connect;
const start = AudioBufferSourceNode.prototype.start;
AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
  const node={source:this,gain:soundGains.get(this),ended:false};
  audioNodes.push(node);
  this.addEventListener('ended',()=>{node.ended=true;});
  test.audioPlays.push({ offset:args[1]??0, seconds: this.buffer?.duration, channels: this.buffer?.numberOfChannels, sink: (this.context as AudioContext & { sinkId: string }).sinkId, gain: soundGains.get(this)?.gain.value });
  return start.apply(this, args);
};
test.playSound = (event: 'join' | 'leave' | 'message', overrides = {}) => playSound(event, { ...defaults, ...overrides });

function Demo() {
  const [visible, setVisible] = useState(true);
  const [covered, setCovered] = useState(false);
  const [connected, setConnected] = useState(true);
  useEffect(() => { test.setChatVisible = setVisible; test.setCovered = setCovered; test.setConnected = setConnected; test.ready = true; }, []);
  return <div style={{ height: 700, display: 'grid', gridTemplateRows: 'minmax(0, 1fr)' }}><RoomChat room={room} session={session} people={[]} profile={{ nickname: 'Me' }} visible={visible} covered={covered} connected={connected}/></div>;
}
createRoot(document.getElementById('root')!).render(<Demo/>);
