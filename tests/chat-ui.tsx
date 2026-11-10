import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RoomChat } from '../src/RoomChat';
import { RoomSplit } from '../src/RoomSplit';
import { Participants } from '../src/Participants';
import { BookmarkRail } from '../src/BookmarkRail';
import { Icon } from '../src/Controls';
import { encryptChat, decryptChat } from '../src/chat';
import { changeLanguage } from '../src/i18n';
import { applyTheme, defaultTheme, themePresets } from '../src/theme';
applyTheme(defaultTheme);
import '../src/style.css';
import '../src/interface.css';

const test = window as any;
const blobs = new Map<string, Uint8Array>();
const records: any[] = [];
const requests: any[] = [];
const created = new Set<string>();
const originalCreate = URL.createObjectURL.bind(URL), originalRevoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = blob => { const url = originalCreate(blob); created.add(url); return url; };
URL.revokeObjectURL = url => { created.delete(url); originalRevoke(url); };
test.liveBlobCount = () => created.size;
test.chatRequests = requests;
test.makeImage = async (width = 480, height = 240, mime = 'image/png') => {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d')!; const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#526aa0'); gradient.addColorStop(1, '#b897c8'); context.fillStyle = gradient; context.fillRect(0, 0, width, height);
  context.fillStyle = '#f4d4a9'; context.beginPath(); context.arc(width * .73, height * .29, Math.min(width, height) * .12, 0, Math.PI * 2); context.fill();
  return new File([await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), mime))], mime === 'image/webp' ? 'evening.webp' : 'evening.png', { type: mime });
};
for (let id = 1; id <= 250; id++) {
  const author = id % 7 === 0 ? 'Мария' : 'Алексей';
  records.push({ ...await encryptChat(undefined, id === 250 ? 'Здесь можно обсудить планы, поделиться картинкой или ответить на сообщение.' : `Сообщение **${id}** *курсив* __линия__ ~~удалено~~ ||секрет|| · ${id % 7 === 0 ? 'Буду через несколько минут.' : 'Давайте соберёмся вечером.'}`), id, author, authorId: (id % 7 === 0 ? 'c' : 'b').repeat(64), sent: Date.now() - (251 - id) * 15000 });
}
const session: any = { publishChatRefresh() {}, publishTyping() {}, sendChat: async () => {} };
test.emitTyping = (active: boolean) => session.onTyping?.('1', active);
test.setRadius = (radius: number) => applyTheme({ ...defaultTheme, radius });
test.setLightTheme = (light: boolean) => applyTheme(light ? themePresets[5] : defaultTheme);
test.imageActions = [];
test.desktop = { copyChatText: async (text: string) => { test.copiedChatText = text; }, copyChatImage: async (input: any) => { test.imageActions.push({action:'copy', size:input.bytes.length}); }, saveChatImage: async (input: any) => { test.imageActions.push({action:'save', size:input.bytes.length}); return true; }, duck: async () => {}, chatRequest: async (_handle: string, request: any) => {
  requests.push(request);
  if (request.attachment) {
    if (request.attachment.data) { blobs.set(request.attachment.id, request.attachment.data); return { id: request.attachment.id }; }
    const bytes = blobs.get(request.attachment.id); if (!bytes) throw Error('Missing attachment'); return bytes;
  }
  if (request.packet) {
    const content = await decryptChat(undefined, request.packet); if (!content) throw Error('Invalid content');
    const id = records.length + 1; records.push({ ...request.packet, id, author: 'Илья', authorId: 'a'.repeat(64), sent: Date.now() }); test.lastSent = content;
    return { id };
  }
  if (request.profile) return { ok: true };
  if ((request.before || request.after) && request.limit && test.historyProbe) test.historyProbe(request);
  let page = records.filter(record => (!request.before || record.id < request.before) && (!request.after || record.id > request.after));
  if (request.around) page = [...page].sort((a, b) => Math.abs(a.id - request.around) - Math.abs(b.id - request.around)).slice(0, request.limit);
  else page = request.after ? page.slice(0, request.limit) : page.slice(-request.limit);
  return { first: 1, last: records.length, messages: page.sort((a, b) => a.id - b.id), profiles: [], unread: records.filter(record => record.id > (request.readAfter ?? 0)).length };
} };
const people = ['Илья', 'Алексей', 'Мария', 'Даниил', 'Алина'].map((name, index) => ({ id: String(index), name, speaking: index === 1, muted: index === 3, local: index === 0, rtt: 25 + index * 13 }));
function Demo() {
  const [bookmarks, setBookmarks] = useState([{ address: 'https://offline.invalid', name: 'Старый сервер' }, { address: 'https://demo.invalid', name: 'Вечерняя компания' }, { address: 'https://quiet.invalid', name: 'Музыкальная' }]);
  const [temporary, setTemporary] = useState(false);
  const [savedTemporary, setSavedTemporary] = useState(false);
  const temporaryRoom = { address: "https://temporary.invalid", name: "Temporary" };
  const [reachable, setReachable] = useState(false);
  const [size, setSize] = useState(100); const [unread, setUnread] = useState(12);
  useEffect(() => { test.setTemporary = setTemporary; test.resetTemporary = () => { setTemporary(false); setSavedTemporary(false); }; test.setChatWindow = setSize; test.setRoomReachable = setReachable; test.changeLanguage = changeLanguage; test.ready = true; }, []);
  return <div className="app"><aside className="rail"><button className="server-orb home-orb"><img src="/pawtalk-mark.svg" width="44" height="44" alt="PawTalk"/></button><div className="rail-line"/><BookmarkRail bookmarks={savedTemporary ? [temporaryRoom, ...bookmarks] : bookmarks} temporaryRoom={temporary && !savedTemporary ? temporaryRoom : undefined} onSaveTemporary={() => setSavedTemporary(true)} selected people={5} livePeople={people} activeAddress={temporary ? temporaryRoom.address : "https://demo.invalid"} unread={unread} presence={{ 'https://quiet.invalid': { status: 'online', participants: 0, unread: 3, details: true, people: [] }, 'https://offline.invalid': { status: reachable ? 'online' : 'offline', participants: reachable ? 2 : undefined } }} disabled={false} onOpen={item => { test.openedRoom = item.address; }} onMenu={() => {}} onReorder={setBookmarks}/><button className="rail-settings icon-button"><Icon name="settings"/></button></aside><main><div className="content room-content"><div className="page-title"><div className="room-title"><span className="room-heading-icon"><Icon name="headphones"/></span><div className="room-title-copy"><h1>Вечерняя компания</h1><small>В голосовом канале · Участников: 5</small></div></div><div className="room-presence"><span className="e2ee-badge">E2EE</span></div></div><RoomSplit visible participants={<><Participants people={people} prefs={{}} onChange={() => {}}/><div className="call-controls"><button className="icon-button"><Icon name="mic"/></button><button className="icon-button"><Icon name="headphones"/></button><button className="icon-button call-leave"><Icon name="exit"/></button></div></>} chat={<RoomChat room={{ identity: '0', nickname: 'Илья', access: { handle: 'demo', feed: 'b'.repeat(32), ephemeral: true, encrypted: false, protocol: 2, profileId: 'a'.repeat(64) } }} session={session} people={people} profile={{ nickname: 'Илья' }} visible connected covered={false} windowSize={size} onUnread={setUnread}/>}/></div></main></div>;
}
createRoot(document.getElementById('root')!).render(<Demo/>);
