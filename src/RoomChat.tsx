import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { chatDecoder, chatEncoder, chatKey, chatMessageLimit, chatWindowLimit, chatSendsPerSecond, chatTextLimit, continuesMessageGroup, decodeHistory, decryptChat, encryptChat, readChatCursor, readChatPosition, writeChatCursor, writeChatPosition, type ChatAccess, type ChatContent, type ChatHistoryRequest, type ChatMessage, type ChatPacket, type ChatProfile, type ChatReply } from './chat';
import { decodeChatProfiles, encodeChatProfile } from './chatProfiles';
import { prepareChatImage, encodeImage } from './chatImages';
import { ChatImage } from './ChatImage';
import { Icon } from './Controls';
import { Avatar } from './Avatar';
import { MessageTime } from './MessageTime';
import { t } from './i18n';
import type { Person, VoiceSession } from './session';

export type ChatRoom = { identity: string; nickname: string; access?: ChatAccess; key?: string };
type LocalProfile = { nickname: string; avatar?: string };
type ImageDraft = Awaited<ReturnType<typeof prepareChatImage>>;
type LoadKind = 'initial' | 'poll' | 'older' | 'newer' | 'latest' | 'around';
type Anchor = { id: number; offset: number; part?: 'text' | 'image' };
const merge = (a: ChatMessage[], b: ChatMessage[]) => [...new Map([...a, ...b].map(message => [message.id, message])).values()].sort((x, y) => x.id - y.id);

export function RoomChat({ room, session, people, profile, visible, connected, covered, windowSize = chatWindowLimit, onUnread }: {
  room: ChatRoom; session: VoiceSession; people: Person[]; profile: LocalProfile; visible: boolean; connected: boolean; covered: boolean; windowSize?: number; onUnread?(count: number): void;
}) {
  const { access, key, identity, nickname } = room;
  const paged = access?.protocol === 2;
  const limit = Math.max(25, Math.min(500, Math.trunc(windowSize)));
  const windowLimit = useRef(limit); windowLimit.current = limit;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const rows = useRef(messages);
  const groupBefore = useRef<ChatMessage | undefined>(undefined);
  const [profiles, setProfiles] = useState(new Map<string, ChatProfile>());
  const profilesRef = useRef(profiles);
  const profileCursor = useRef(0);
  const currentProfile = useRef(profile); currentProfile.current = profile;
  const sentProfile = useRef<LocalProfile | undefined>(undefined);
  const encryption = useRef<Promise<CryptoKey> | undefined>(undefined);
  const profileEncryption = useRef<Promise<CryptoKey> | undefined>(undefined);
  const [ready, setReady] = useState(!access);
  const [historyError, setHistoryError] = useState(false);
  const [sendError, setSendError] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState<ChatReply>();
  const [imageDraft, setImageDraft] = useState<ImageDraft>();
  const picker = useRef<HTMLInputElement>(null);
  const attachmentControl = useRef<HTMLDivElement>(null);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const selection = useRef(0);
  const uploaded = useRef<{ id: string; payload: Uint8Array; confirmed: boolean } | undefined>(undefined);
  const pending = useRef<{ signature: string; packet: ChatPacket } | undefined>(undefined);
  const sendTimes = useRef<number[]>([]);
  const [typing, setTyping] = useState(new Map<string, number>());
  const typingSent = useRef(0);
  const [read, setRead] = useState(() => readChatCursor(access));
  const [totalUnread, setTotalUnread] = useState(0);
  const readRef = useRef(read);
  const [divider] = useState(read);
  const [entryLast, setEntryLast] = useState<number>();
  const [hasSent, setHasSent] = useState(false);
  const [bounds, setBounds] = useState({ first: 0, last: 0 });
  const boundsRef = useRef(bounds);
  const newest = useRef(0);
  const stream = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const arrival = useRef<{ key: string; x: number; y: number } | undefined>(undefined);
  const follow = useRef(true);
  const scrollTop = useRef(0);
  const [away, setAway] = useState(false);
  const anchor = useRef<Anchor | undefined>(undefined);
  const targetKey = useRef<string | undefined>(undefined);
  const initialPosition = useRef(readChatPosition(access));
  const restore = useRef(true);
  const queue = useRef(Promise.resolve());
  const epoch = useRef(0);
  const navigation = useRef(false);
  const refresh = useRef<(() => void) | undefined>(undefined);
  const [menu, setMenu] = useState<{ message: ChatMessage; x: number; y: number }>();

  async function getKey() {
    if (!key) {
      if (access?.encrypted !== false && access) throw new Error('Chat key missing');
      return undefined;
    }
    encryption.current ??= chatKey(key, access?.feed ?? 'live'); return encryption.current;
  }
  async function getProfileKey() {
    if (!key) return undefined;
    profileEncryption.current ??= chatKey(key, access!.feed, 'Voicecord chat profile v1'); return profileEncryption.current;
  }
  function commit(next: ChatMessage[], context = rows.current) {
    groupBefore.current = next.length ? merge(groupBefore.current ? [groupBefore.current] : [], context).filter(message => message.id < next[0].id).at(-1) : undefined;
    rows.current = next; setMessages(next);
  }
  function viewportAnchor(content = false): Anchor | undefined {
    const list = stream.current;
    if (list && content) {
      const box = list.getBoundingClientRect();
      const visible = Array.from(list.querySelectorAll<HTMLElement>('[data-message-row]')).filter(row => { const rect = row.getBoundingClientRect(); return rect.bottom > box.top && rect.top < box.bottom; });
      // A partially clipped first row can gain/lose its author header when pages
      // merge. Anchor a complete visible message's content instead of that shell.
      const row = visible.find(row => row.getBoundingClientRect().top >= box.top) ?? visible[0];
      if (!row) return;
      const text = row.querySelector<HTMLElement>('.chat-message-body > p');
      const image = row.querySelector<HTMLElement>('.chat-image');
      const target = text ?? image ?? row;
      return { id: Number(row.dataset.messageRow), offset: box.top - target.getBoundingClientRect().top, ...(text ? { part: 'text' as const } : image ? { part: 'image' as const } : {}) };
    }
    const row = list && Array.from(list.querySelectorAll<HTMLElement>('[data-message-row]')).find(row => row.offsetTop + row.offsetHeight > list.scrollTop);
    return row && list ? { id: Number(row.dataset.messageRow), offset: list.scrollTop - row.offsetTop } : undefined;
  }
  function rememberViewport() {
    const list = stream.current;
    if (list) { list.toggleAttribute('data-more-above', list.scrollTop > 1); list.toggleAttribute('data-more-below', list.scrollHeight - list.scrollTop - list.clientHeight > 1); }
    const position = viewportAnchor(); if (position && access) writeChatPosition(access, position);
  }
  function atLatest() { return !rows.current.length || rows.current.at(-1)!.id >= boundsRef.current.last; }

  function loadHistory(kind: LoadKind, query: ChatHistoryRequest = {}): Promise<void> {
    const generation = epoch.current;
    const job = queue.current.then(async () => {
      if (!access || generation !== epoch.current) return;
      setLoading(true);
      try {
        const nowProfile = currentProfile.current;
        const name = nowProfile.nickname.trim();
        const profileKey = access.profileId ? await getProfileKey() : undefined;
        if (access.profileId && name && !/\p{Cc}/u.test(name)
          && (nowProfile.nickname !== sentProfile.current?.nickname || nowProfile.avatar !== sentProfile.current?.avatar)) {
          try {
            await window.desktop!.chatRequest(access.handle, { profile: await encodeChatProfile(profileKey, access.profileId, name, nowProfile.avatar) });
            sentProfile.current = nowProfile; session.publishChatRefresh();
          } catch { /* Retry next time; profile errors must not block messages. */ }
        }
        const after = kind === 'poll' ? newest.current : query.after ?? 0;
        const profileAfter = kind === 'poll' ? profileCursor.current : 0;
        const pageSize = kind === 'older' || kind === 'newer' ? Math.min(50, Math.floor(limit / 2)) : limit;
        const needsContext = ['initial', 'latest', 'around', 'older'].includes(kind);
        const request: ChatHistoryRequest = paged
          ? { limit: Math.min(chatMessageLimit, pageSize + (needsContext ? 1 : 0)), ...(kind === 'poll' ? { after } : query), readAfter: readRef.current, ...(access.profileId ? { profilesAfter: profileAfter } : {}) }
          : { after: kind === 'poll' ? after : 0, ...(access.profileId ? { profilesAfter: profileAfter } : {}) };
        const raw = await window.desktop!.chatRequest(access.handle, request);
        const page = await decodeHistory(raw, paged || kind === 'poll' ? after : 0, await getKey());
        let context = merge(rows.current, page.messages);
        // Retain one predecessor as grouping metadata, without rendering or
        // downloading its image. Window edges must not invent author headers.
        if (paged && needsContext && pageSize === chatMessageLimit && page.messages[0]?.id > page.first) {
          const previous = await window.desktop!.chatRequest(access.handle, { before: page.messages[0].id, limit: 1 });
          context = merge(context, (await decodeHistory(previous, 0, await getKey())).messages);
        }
        const changes = access.profileId ? await decodeChatProfiles(raw, profileAfter, profileKey) : undefined;
        if (generation !== epoch.current) return;
        const metadata = raw as { last?: number; unread?: number };
        if (Number.isSafeInteger(metadata.unread) && metadata.unread! >= 0) setTotalUnread(metadata.unread!);
        const last = paged ? metadata.last : Math.max(boundsRef.current.last, page.cursor);
        if (!Number.isSafeInteger(last) || last! < page.first || page.messages.some(message => message.id > last!)) throw new Error('Invalid chat bounds');
        const wasLatest = atLatest();
        boundsRef.current = { first: page.first, last: last! }; setBounds(boundsRef.current);
        if (kind === 'initial') { newest.current = last!; setEntryLast(last!); }
        else if (kind === 'poll') newest.current = Math.max(newest.current, page.cursor);
        let next = page.messages;
        if (paged && needsContext && next.length > pageSize) next = kind === 'around' && query.around === next[0].id ? next.slice(0, pageSize) : next.slice(-pageSize);
        if (!paged && kind === 'older') next = next.filter(message => message.id < query.before!).slice(-50);
        if (!paged && kind === 'newer') next = next.filter(message => message.id > query.after!).slice(0, 50);
        if (kind === 'older' || kind === 'newer') {
          anchor.current = viewportAnchor(true); follow.current = false; restore.current = false;
          const combined = merge(rows.current, next);
          const list = stream.current, box = list?.getBoundingClientRect();
          const visible = list && box ? Array.from(list.querySelectorAll<HTMLElement>('[data-message-row]')).filter(row => { const rect = row.getBoundingClientRect(); return rect.bottom > box.top && rect.top < box.bottom; }).map(row => Number(row.dataset.messageRow)) : [];
          const first = combined.findIndex(message => message.id === visible[0]);
          const last = combined.findIndex(message => message.id === visible.at(-1));
          // Drop offscreen rows first. A fixed half-window cut can otherwise
          // remove visible content and clamp scrollTop, especially in tall panes.
          const preferred = kind === 'older' ? 0 : Math.max(0, combined.length - windowLimit.current);
          const start = first >= 0 && last >= 0 ? Math.min(first, Math.max(preferred, last + 1 - windowLimit.current)) : preferred;
          next = combined.slice(start, start + windowLimit.current);
        }
        else if (kind === 'poll') next = wasLatest && follow.current ? merge(rows.current.filter(message => !page.first || message.id >= page.first), next).slice(-windowLimit.current) : rows.current;
        else next = next.slice(-windowLimit.current);
        if (kind === 'latest') { follow.current = true; restore.current = false; }
        commit(next, context);
        if (changes) {
          profileCursor.current = kind === 'poll' ? Math.max(profileCursor.current, changes.cursor) : changes.cursor;
          const retained = new Set(next.map(message => message.authorId));
          const updated = new Map(profilesRef.current);
          for (const item of changes.profiles) { updated.delete(item.id); updated.set(item.id, item); }
          const idle = [...updated.keys()].filter(id => !retained.has(id));
          for (const id of idle.slice(0, Math.max(0, idle.length - 32))) updated.delete(id);
          profilesRef.current = updated; setProfiles(updated);
        }
        setReady(true); setHistoryError(false);
        if ((kind === 'poll' && paged && page.cursor < last! && page.cursor > after) || changes?.profiles.length === 500) refresh.current?.();
      } catch { if (generation === epoch.current) setHistoryError(true); }
      finally { if (generation === epoch.current) setLoading(false); }
    });
    queue.current = job.catch(() => {}); return job;
  }
  async function navigate(kind: 'older' | 'newer' | 'latest' | 'around', query: ChatHistoryRequest = {}) {
    if (!access || navigation.current) return;
    navigation.current = true;
    try { await loadHistory(kind, query); } finally { navigation.current = false; }
  }

  useEffect(() => () => { epoch.current++; selection.current++; }, []);
  useEffect(() => {
    if (!attachmentMenu) return;
    const close = (event: PointerEvent) => { if (!attachmentControl.current?.contains(event.target as Node)) setAttachmentMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setAttachmentMenu(false); attachmentControl.current?.querySelector('button')?.focus(); } };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, [attachmentMenu]);
  useEffect(() => { if (!visible || covered || !connected || sending) setAttachmentMenu(false); }, [visible, covered, connected, sending]);
  useEffect(() => {
    if (!visible) { initialPosition.current = readChatPosition(access); restore.current = true; return; }
    const saved = initialPosition.current, generation = epoch.current;
    if (ready && paged && saved && !rows.current.some(message => message.id === saved.id)) {
      void loadHistory('around', { around: saved.id }).then(() => { if (generation === epoch.current) { restore.current = true; commit([...rows.current]); } });
    }
  }, [visible]);
  useEffect(() => () => { if (imageDraft) URL.revokeObjectURL(imageDraft.preview); }, [imageDraft]);
  const previousLimit = useRef(limit);
  useEffect(() => {
    if (previousLimit.current === limit) return;
    const previous = previousLimit.current;
    previousLimit.current = limit;
    anchor.current = viewportAnchor();
    if (limit < previous) {
      if (atLatest()) { anchor.current = undefined; follow.current = true; commit(rows.current.slice(-windowLimit.current)); }
      else {
        const index = Math.max(0, rows.current.findIndex(message => message.id === anchor.current?.id));
        const start = Math.max(0, Math.min(index - 5, rows.current.length - limit));
        commit(rows.current.slice(start, start + limit));
      }
    } else if (access) void loadHistory(atLatest() ? 'latest' : 'around', atLatest() ? {} : { around: anchor.current?.id ?? rows.current[0]?.id });
  }, [limit]);
  useEffect(() => {
    if (!access || !connected) return;
    let active = true, polling = false, requested = false;
    let notification: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!active) return;
      if (polling) { requested = true; return; }
      polling = true; requested = false;
      await loadHistory('poll'); polling = false;
      if (active && requested) void poll();
    };
    refresh.current = () => { void poll(); };
    session.onChatRefresh = () => { notification ??= setTimeout(() => { notification = undefined; void poll(); }, 100); };
    if (!ready) void loadHistory('initial', paged && initialPosition.current ? { around: initialPosition.current.id } : {});
    else void poll();
    const timer = setInterval(poll, 2500);
    return () => { active = false; refresh.current = undefined; session.onChatRefresh = undefined; clearInterval(timer); clearTimeout(notification); };
  }, [access, key, connected, session, limit]);
  useEffect(() => { refresh.current?.(); }, [profile.nickname, profile.avatar]);
  useEffect(() => {
    if (access) return;
    let active = true;
    session.onChat = (payload, author, authorIdentity) => { void (async () => {
      try {
        const raw = chatDecoder.decode(payload);
        let content: (ChatContent & { key: string }) | undefined;
        if (key) content = await decryptChat(await getKey(), JSON.parse(raw));
        else {
          try { content = await decryptChat(undefined, JSON.parse(raw)); } catch {}
          if (!content && raw.trim() && payload.length <= chatTextLimit) content = { key: crypto.randomUUID(), text: raw.trim() };
        }
        if (active && content && !rows.current.some(message => message.key === content!.key)) {
          const id = ++newest.current;
          commit([...rows.current, { ...content, id, author, authorIdentity, sent: Date.now() }].slice(-windowLimit.current));
        }
      } catch { /* Ignore invalid live packets. */ }
    })(); };
    return () => { active = false; session.onChat = undefined; };
  }, [access, key, session, limit]);
  useEffect(() => {
    session.onTyping = (person, active) => setTyping(previous => { const next = new Map(previous); if (active) next.set(person, Date.now() + 4500); else next.delete(person); return next; });
    const timer = setInterval(() => setTyping(previous => {
      const next = new Map([...previous].filter(([, until]) => until > Date.now())); return next.size === previous.size ? previous : next;
    }), 1000);
    return () => { session.onTyping = undefined; clearInterval(timer); session.publishTyping(identity, false); };
  }, [session, identity]);
  useEffect(() => {
    const stop = () => { if (typingSent.current) { typingSent.current = 0; session.publishTyping(identity, false); } };
    if (!visible || !connected || sending || !draft.trim()) { stop(); return; }
    if (Date.now() - typingSent.current >= 1500) { typingSent.current = Date.now(); session.publishTyping(identity, true); }
    const timer = setTimeout(stop, 3000); return () => clearTimeout(timer);
  }, [session, identity, draft, sending, visible, connected]);
  useEffect(() => {
    if (!visible || covered) return;
    const frame = requestAnimationFrame(() => { if (!document.querySelector('dialog[open]')) input.current?.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
  }, [visible, covered]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close); window.addEventListener('resize', close); window.addEventListener('keydown', key); stream.current?.addEventListener('scroll', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('resize', close); window.removeEventListener('keydown', key); stream.current?.removeEventListener('scroll', close); };
  }, [menu]);
  useLayoutEffect(() => {
    const list = stream.current; if (!visible || !ready || !list) return;
    if (targetKey.current) {
      const target = Array.from(list.querySelectorAll<HTMLElement>('[data-message-key]')).find(row => row.dataset.messageKey === targetKey.current);
      if (target) { list.scrollTop = target.offsetTop - list.clientHeight / 3; target.animate([{ backgroundColor: 'var(--accent-soft)' }, { backgroundColor: 'transparent' }], { duration: 1000 }); }
      else setNotice(t("Исходное сообщение уже недоступно."));
      targetKey.current = undefined; follow.current = false; restore.current = false; anchor.current = undefined;
    } else if (anchor.current) {
      const saved = anchor.current; const row = list.querySelector<HTMLElement>(`[data-message-row="${saved.id}"]`);
      if (row) {
        const target = saved.part ? row.querySelector<HTMLElement>(saved.part === 'text' ? '.chat-message-body > p' : '.chat-image') : undefined;
        if (target) list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top + saved.offset;
        else list.scrollTop = row.offsetTop + saved.offset;
      }
      anchor.current = undefined;
    } else if (restore.current) {
      const saved = initialPosition.current;
      const row = saved && Array.from(list.querySelectorAll<HTMLElement>('[data-message-row]')).find(row => Number(row.dataset.messageRow) >= saved.id);
      list.scrollTop = row && saved ? row.offsetTop + (Number(row.dataset.messageRow) === saved.id ? Math.min(saved.offset, row.offsetHeight - 1) : 0) : list.scrollHeight;
      follow.current = list.scrollHeight - list.scrollTop - list.clientHeight < 10; restore.current = false;
    } else if (follow.current) list.scrollTop = list.scrollHeight;
    const sent = arrival.current;
    const sentRow = sent && Array.from(list.querySelectorAll<HTMLElement>('[data-message-key]')).find(row => row.dataset.messageKey === sent.key);
    if (sent && sentRow) {
      arrival.current = undefined;
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const target = sentRow.querySelector('p') ?? sentRow;
        const rect = target.getBoundingClientRect();
        target.animate([{ transform: `translate(${sent.x - rect.left}px, ${Math.max(-180, Math.min(180, sent.y - rect.top))}px)`, opacity: .3 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.2,.75,.3,1)' });
      }
    }
    setAway(!follow.current);
    scrollTop.current = list.scrollTop;
    rememberViewport();
  }, [messages, visible, ready]);
  useEffect(() => {
    const list = stream.current; if (!list || !visible || covered) return;
    const observer = new IntersectionObserver(entries => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      let last = readRef.current;
      for (const entry of entries) if (entry.isIntersecting) last = Math.max(last, Number((entry.target as HTMLElement).dataset.chatId));
      if (last === readRef.current) return;
      readRef.current = last; setRead(last); if (access) writeChatCursor(access, last);
      if (last >= boundsRef.current.last) setTotalUnread(0); else refresh.current?.();
    }, { root: list, threshold: 1 });
    const observe = () => { observer.disconnect(); for (const row of list.querySelectorAll('[data-chat-id]')) observer.observe(row); };
    observe(); window.addEventListener('focus', observe); document.addEventListener('visibilitychange', observe);
    return () => { observer.disconnect(); window.removeEventListener('focus', observe); document.removeEventListener('visibilitychange', observe); };
  }, [messages, visible, covered, access]);
  useEffect(() => { onUnread?.(paged ? totalUnread : messages.filter(message => message.id > read).length); }, [messages, read, totalUnread, paged, onUnread]);

  async function chooseImage(file?: File) {
    if (!file || sending) return;
    setNotice(''); const revision = ++selection.current;
    if (!paged) { setNotice(t("Для изображений нужен обновлённый сервер комнаты.")); return; }
    try {
      const selected = await prepareChatImage(file);
      if (revision !== selection.current) { URL.revokeObjectURL(selected.preview); return; }
      uploaded.current = undefined; pending.current = undefined; setImageDraft(selected);
    } catch (error) {
      if (revision === selection.current) setNotice(error instanceof Error && error.message === 'size' ? t("Изображение больше 2 МБ. Выберите файл поменьше.") : t("Выберите статическое PNG, JPEG или WebP до 2 МБ и 16 мегапикселей."));
    }
  }
  async function send() {
    const text = draft.trim();
    if (!connected || sending || (!text && !imageDraft) || chatEncoder.encode(text).length > chatTextLimit) return;
    sendTimes.current = sendTimes.current.filter(time => Date.now() - time < 1000);
    if (sendTimes.current.length >= chatSendsPerSecond) { setRateLimited(true); return; }
    setSending(true); setSendError(false); setRateLimited(false); setNotice('');
    const origin = input.current?.getBoundingClientRect();
    const inputStyle = input.current && getComputedStyle(input.current);
    try {
      const secret = await getKey();
      const extra = { ...(reply ? { reply } : {}), ...(imageDraft ? { image: imageDraft.image } : {}) };
      const signature = JSON.stringify({ text, ...extra });
      if (imageDraft && access) {
        if (uploaded.current?.id !== imageDraft.image.id) uploaded.current = { id: imageDraft.image.id, payload: await encodeImage(secret, imageDraft.image, imageDraft.file), confirmed: false };
        if (!uploaded.current.confirmed) {
          await window.desktop!.chatRequest(access.handle, { attachment: { id: uploaded.current.id, data: uploaded.current.payload } }); uploaded.current.confirmed = true;
        }
      }
      const packet = pending.current?.signature === signature ? pending.current.packet : await encryptChat(secret, text, extra);
      pending.current = { signature, packet };
      const author = profile.nickname.trim() || nickname;
      let id: number;
      if (access) {
        const result = await window.desktop!.chatRequest(access.handle, { packet }) as { id?: number; rateLimited?: boolean } | null;
        if (result?.rateLimited) { setRateLimited(true); return; }
        if (!Number.isSafeInteger(result?.id) || result!.id! <= 0) throw new Error('Send unconfirmed');
        id = result!.id!;
        if (origin) arrival.current = { key: packet.requestId, x: origin.left + parseFloat(inputStyle?.paddingLeft ?? '0'), y: origin.top + parseFloat(inputStyle?.paddingTop ?? '0') };
        if (atLatest()) { follow.current = true; commit(merge(rows.current, [{ id, key: packet.requestId, author, authorId: access.profileId, sent: Date.now(), text, ...extra }]).slice(-windowLimit.current)); }
        else await navigate('latest');
        session.publishChatRefresh(); refresh.current?.();
      } else {
        await session.sendChat(chatEncoder.encode(secret || reply ? JSON.stringify(packet) : text), identity);
        if (origin) arrival.current = { key: packet.requestId, x: origin.left + parseFloat(inputStyle?.paddingLeft ?? '0'), y: origin.top + parseFloat(inputStyle?.paddingTop ?? '0') };
        id = ++newest.current; follow.current = true;
        commit([...rows.current, { id, key: packet.requestId, author, authorIdentity: identity, sent: Date.now(), text, ...extra }].slice(-windowLimit.current));
      }
      sendTimes.current.push(Date.now()); readRef.current = Math.max(readRef.current, id); setRead(readRef.current); setTotalUnread(0);
      if (access) writeChatCursor(access, readRef.current);
      setHasSent(true); setDraft(''); setReply(undefined); setImageDraft(undefined); pending.current = undefined; uploaded.current = undefined; ++selection.current;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Attachment storage full')) setNotice(t("Хранилище изображений на сервере заполнено. Отправьте сообщение без вложения."));
      else setSendError(true);
    } finally { setSending(false); input.current?.focus({ preventScroll: true }); }
  }
  function nameOf(message: ChatMessage) { return (message.authorId ? profiles.get(message.authorId)?.nickname : undefined) ?? (message.authorIdentity ? people.find(person => person.id === message.authorIdentity)?.name : undefined) ?? message.author; }
  function beginReply(message: ChatMessage) {
    setReply({ key: message.key, ...(access ? { id: message.id } : {}), author: nameOf(message), text: (message.text || t("Изображение")).slice(0, 240) });
    setMenu(undefined); input.current?.focus({ preventScroll: true });
  }
  async function copyText(message: ChatMessage) {
    setMenu(undefined);
    try {
      if (window.desktop?.copyChatText) await window.desktop.copyChatText(message.text);
      else await navigator.clipboard.writeText(message.text);
    } catch { setNotice(t("Не удалось скопировать текст.")); }
  }
  function openMenu(message: ChatMessage, x: number, y: number) { setMenu({ message, x: Math.max(8, Math.min(x, window.innerWidth - 220)), y: Math.max(8, Math.min(y, window.innerHeight - (message.text ? 105 : 65))) }); }
  const unreadStart = !hasSent && entryLast !== undefined ? messages.findIndex(message => message.id > divider && message.id <= entryLast) : -1;
  const firstNew = unreadStart === 0 && groupBefore.current && groupBefore.current.id > divider ? -1 : unreadStart;
  const tooLong = chatEncoder.encode(draft.trim()).length > chatTextLimit;
  const hasOlder = !!access && !!messages.length && messages[0].id > bounds.first;
  const hasNewer = !!access && !!messages.length && messages.at(-1)!.id < bounds.last;
  const typists = people.filter(person => !person.local && typing.has(person.id));
  if (!visible) return null;
  return <section className="room-chat" aria-label={t("Текстовый чат")}>
    <div className="chat-feed"><div className="chat-stream" ref={stream} tabIndex={0} aria-label={t("Сообщения чата")} onScroll={event => {
      const list = event.currentTarget;
      const delta = list.scrollTop - scrollTop.current; scrollTop.current = list.scrollTop;
      rememberViewport();
      // Restoring an anchor also fires scroll. Only movement beyond that restored
      // position may turn a page, otherwise a small window bounces forward again.
      if (!delta) return;
      follow.current = !hasNewer && list.scrollHeight - list.scrollTop - list.clientHeight < 12; setAway(!follow.current);
      if (delta < 0 && list.scrollTop < 100 && hasOlder) void navigate('older', { before: rows.current[0].id });
      else if (delta > 0 && list.scrollHeight - list.scrollTop - list.clientHeight < 100 && hasNewer) void navigate('newer', { after: rows.current.at(-1)!.id });
    }}>
      {hasOlder && <button className="chat-page-loader" disabled={loading} onClick={() => void navigate('older', { before: messages[0].id })}>{loading ? t("Загружаем сообщения…") : t("Предыдущие сообщения")}</button>}
      {!messages.length && <p className="chat-empty">{ready ? t("Сообщений пока нет.") : t("Загружаем историю…")}</p>}
      {messages.map((message, index) => {
        const saved = message.authorId ? profiles.get(message.authorId) : undefined;
        const live = message.authorIdentity ? people.find(person => person.id === message.authorIdentity) : undefined;
        const name = nameOf(message);
        const continuation = index !== firstNew && !message.reply && continuesMessageGroup(index ? messages[index - 1] : groupBefore.current, message);
        return <article className={`chat-message${continuation ? ' chat-message-continuation' : ''}`} key={message.id}>
          {index === firstNew && <div className="chat-divider">{t("Новые сообщения")}</div>}
          <div className="chat-message-row" data-message-row={message.id} data-message-key={message.key} onContextMenu={event => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openMenu(message, event.clientX || rect.left + 50, event.clientY || rect.top); }}>
            {continuation ? <span className="chat-continuation-time"><MessageTime sent={message.sent}/></span> : <Avatar name={name} image={saved?.avatar ?? live?.avatar} className="chat-avatar"/>}
            <div className="chat-message-body">
              {!continuation && <div className="chat-meta"><strong>{name}</strong><MessageTime sent={message.sent}/></div>}
              {message.reply && <button type="button" className="chat-reply-quote" onClick={() => {
                targetKey.current = message.reply!.key;
                const original = rows.current.find(item => item.key === message.reply!.key);
                if (original) commit([...rows.current]);
                else if (access && message.reply!.id) void navigate('around', { around: message.reply!.id });
                else { targetKey.current = undefined; setNotice(t("Исходное сообщение уже недоступно.")); }
              }}><Icon name="reply" size={13}/><strong>{message.reply.author}</strong><span>{message.reply.text}</span></button>}
              {message.text && <p>{message.text}</p>}
              {message.image && access && <ChatImage image={message.image} access={access} getKey={getKey}/>}
            </div>
            <button type="button" className="chat-message-more" aria-label={t("Действия с сообщением")} aria-haspopup="menu" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); openMenu(message, rect.right - 185, rect.bottom + 4); }}><Icon name="more" size={18}/></button>
          </div>
          <div className="chat-read-end" data-chat-id={message.id}/>
        </article>;
      })}
      {hasNewer && <button className="chat-page-loader" disabled={loading} onClick={() => void navigate('newer', { after: messages.at(-1)!.id })}>{loading ? t("Загружаем сообщения…") : t("Следующие сообщения")}</button>}
    </div>
    {(hasNewer || away && messages.some(message => message.id > read)) && <button className="chat-jump" onClick={() => { if (hasNewer) void navigate('latest'); else { follow.current = true; stream.current?.scrollTo({ top: stream.current.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); } input.current?.focus({ preventScroll: true }); }}>{t("К новым сообщениям")}<Icon name="arrow-down" size={14}/></button>}
    </div>
    {historyError && <button type="button" className="chat-history-error" onClick={() => refresh.current?.()}>{t("Не удалось загрузить историю. Повторить")}</button>}
    {tooLong && <p className="text-error" role="status">{t("Сообщение слишком длинное.")}</p>}
    {sendError && <p className="text-error" role="alert">{t("Отправка не подтверждена. Попробуйте снова.")}</p>}
    {rateLimited && <p className="text-error" role="status">{t("Слишком много сообщений. Подождите секунду.")}</p>}
    {notice && <p className="chat-inline-notice" role="status">{notice}<button type="button" aria-label={t("Закрыть сообщение")} onClick={() => setNotice('')}>×</button></p>}
    <div className="chat-typing" role="status">{typists.length > 0 && <><span className="chat-typing-dots" aria-hidden="true"><i/><i/><i/></span>{typists.length === 1 ? t("{0} печатает…", typists[0].name) : t("Несколько участников печатают…")}</>}</div>
    <form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(); }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { event.preventDefault(); void chooseImage(event.dataTransfer.files[0]); }}>
      {reply && <div className="chat-reply-draft"><Icon name="reply" size={16}/><div><strong>{t("Ответ {0}", reply.author)}</strong><span>{reply.text}</span></div><button type="button" aria-label={t("Отменить ответ")} disabled={sending} onClick={() => setReply(undefined)}>×</button></div>}
      {imageDraft && <div className="chat-attachment-draft"><img src={imageDraft.preview} alt={imageDraft.image.name}/><div><strong>{imageDraft.image.name}</strong><span>{Math.ceil(imageDraft.image.size / 1024)} {t("КБ")}</span></div><button type="button" aria-label={t("Удалить вложение")} disabled={sending} onClick={() => { ++selection.current; setImageDraft(undefined); uploaded.current = undefined; pending.current = undefined; }}>×</button></div>}
      <div className="chat-compose" data-sending={sending || undefined}><input ref={picker} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={event => { void chooseImage(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }}/>
        <div className="chat-attachment-control" ref={attachmentControl} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setAttachmentMenu(false); }}>
          <button type="button" className="chat-attach" disabled={sending || !connected} aria-label={t("Добавить вложение")} aria-haspopup="menu" aria-expanded={attachmentMenu} onClick={() => setAttachmentMenu(value => !value)} onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setAttachmentMenu(true); } }}><Icon name="plus" size={22}/></button>
          {attachmentMenu && <div className="chat-attachment-menu" role="menu" aria-label={t("Вложения")}><button type="button" role="menuitem" autoFocus onClick={() => { setAttachmentMenu(false); picker.current?.click(); }}><Icon name="image" size={18}/>{t("Отправить файл")}</button></div>}
        </div>
        <textarea ref={input} rows={1} aria-label={t("Сообщение")} placeholder={t("Написать сообщение…")} value={draft} maxLength={chatTextLimit} readOnly={sending} onPaste={event => { const file = [...event.clipboardData.files].find(file => file.type.startsWith('image/')); if (file) { event.preventDefault(); void chooseImage(file); } }} onChange={event => { setDraft(event.target.value); pending.current = undefined; }} onKeyDown={event => {
          if (event.key === 'Escape' && reply) { setReply(undefined); return; }
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          event.preventDefault(); if (!event.repeat) void send();
        }}/>
      </div>
    </form>
    {menu && createPortal(<div className="chat-message-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={event => event.stopPropagation()}><button type="button" role="menuitem" autoFocus onClick={() => beginReply(menu.message)}><Icon name="reply" size={17}/>{t("Ответить")}</button>{menu.message.text && <button type="button" role="menuitem" onClick={() => void copyText(menu.message)}><Icon name="copy" size={17}/>{t("Скопировать текст")}</button>}</div>, document.body)}
  </section>;
}
