import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { chatDecoder, chatEncoder, chatKey, chatMessageLimit, chatSendsPerSecond, chatTextLimit, continuesMessageGroup, decodeHistory, decryptChat, encryptChat, readChatCursor, readChatPosition, writeChatCursor, writeChatPosition, type ChatAccess, type ChatMessage, type ChatPacket, type ChatProfile } from './chat';
import { decodeChatProfiles, encodeChatProfile } from './chatProfiles';
import { Icon } from './Controls';
import { Avatar } from './Avatar';
import { MessageTime } from './MessageTime';
import { t } from './i18n';
import type { Person, VoiceSession } from './session';

export type ChatRoom = { identity: string; nickname: string; access?: ChatAccess; key?: string };

function syncScrollFades(list: HTMLElement) {
  list.toggleAttribute('data-more-above', list.scrollTop > 1);
  list.toggleAttribute('data-more-below', list.scrollHeight - list.scrollTop - list.clientHeight > 1);
}

function messageRows(list: HTMLElement) {
  return Array.from(list.querySelectorAll<HTMLElement>('[data-message-row]'));
}

type LocalProfile = { nickname: string; avatar?: string };

export function RoomChat({ room, session, people, profile, visible, connected, covered }: {
  room: ChatRoom; session: VoiceSession; people: Person[]; profile: LocalProfile; visible: boolean; connected: boolean; covered: boolean;
}) {
  const { access, key, nickname, identity } = room;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [profiles, setProfiles] = useState(new Map<string, ChatProfile>());
  const messageAuthors = useRef(new Map<number, string>());
  const profileCursor = useRef(0);
  const profileKey = useRef<Promise<CryptoKey> | undefined>(undefined);
  const currentProfile = useRef(profile);
  currentProfile.current = profile;
  const sentProfile = useRef<LocalProfile | undefined>(undefined);
  const publishingProfile = useRef(false);
  const [ready, setReady] = useState(!access);
  const [historyError, setHistoryError] = useState(false);
  const [sendError, setSendError] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const sendTimes = useRef<number[]>([]);
  const [typing, setTyping] = useState(new Map<string, number>());
  const typingSent = useRef(0);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');
  const [read, setRead] = useState(() => readChatCursor(access));
  const [divider, setDivider] = useState(read);
  const [entryLast, setEntryLast] = useState<number>();
  const [hasSent, setHasSent] = useState(false);
  const readRef = useRef(read);
  const newest = useRef(0);
  const stream = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const focused = useRef(false);
  const marker = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const jump = useRef(true);
  const [initialPosition] = useState(() => readChatPosition(access));
  const position = useRef(initialPosition);
  const pending = useRef<{ text: string; packet: ChatPacket } | undefined>(undefined);
  const encryption = useRef<Promise<CryptoKey> | undefined>(undefined);
  const refresh = useRef<(() => void) | undefined>(undefined);
  const arrival = useRef<{ id: number; x: number; y: number } | undefined>(undefined);
  const stopHighlight = useRef<(() => void) | undefined>(undefined);

  function rememberViewport(list: HTMLElement) {
    const row = messageRows(list).find(item => item.offsetTop + item.offsetHeight > list.scrollTop);
    if (!row) return;
    const next = { id: Number(row.dataset.messageRow), offset: Math.round(list.scrollTop - row.offsetTop) };
    if (position.current?.id === next.id && position.current.offset === next.offset) return;
    position.current = next;
    if (access) writeChatPosition(access, next);
  }

  useEffect(() => {
    if (!visible) { focused.current = false; return; }
    if (covered || focused.current) return;
    const frame = requestAnimationFrame(() => {
      if (document.querySelector('dialog[open]')) return;
      input.current?.focus({ preventScroll: true });
      focused.current = document.activeElement === input.current;
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, covered]);

  function getKey() {
    if (!key) throw new Error('Chat key missing');
    encryption.current ??= chatKey(key, access?.feed ?? 'live');
    return encryption.current;
  }

  function appendLive(message: Omit<ChatMessage, 'id'>) {
    const id = ++newest.current;
    setMessages(previous => previous.some(item => item.key === message.key)
      ? previous
      : [...previous.slice(1 - chatMessageLimit), { ...message, id }]);
    return id;
  }

  useEffect(() => {
    session.onTyping = (person, active) => {
      setTyping(previous => {
        const next = new Map(previous);
        if (active) next.set(person, Date.now() + 4500);
        else next.delete(person);
        return next;
      });
    };
    const timer = setInterval(() => {
      setTyping(previous => {
        const now = Date.now();
        const remaining = [...previous].filter(([, until]) => until > now);
        return remaining.length === previous.size ? previous : new Map(remaining);
      });
    }, 1000);
    return () => { session.onTyping = undefined; clearInterval(timer); session.publishTyping(identity, false); stopHighlight.current?.(); };
  }, [session, identity]);

  useEffect(() => {
    const stop = () => {
      if (!typingSent.current) return;
      typingSent.current = 0;
      session.publishTyping(identity, false);
    };
    if (!visible || !connected || sending || !draft.trim()) { stop(); return; }
    const now = Date.now();
    if (now - typingSent.current >= 1500) {
      typingSent.current = now;
      session.publishTyping(identity, true);
    }
    const timer = setTimeout(stop, 3000);
    return () => clearTimeout(timer);
  }, [session, identity, draft, sending, visible, connected]);

  useEffect(() => {
    if (access) return;
    let active = true;
    const receive = async (payload: Uint8Array, author: string, authorIdentity: string) => {
      try {
        const raw = chatDecoder.decode(payload);
        const content = key
          ? await decryptChat(await getKey(), JSON.parse(raw))
          : raw.trim() && payload.length <= chatTextLimit ? { key: crypto.randomUUID(), text: raw.trim() } : undefined;
        if (active && content) appendLive({ ...content, author, authorIdentity, sent: Date.now() });
      } catch { /* Ignore malformed chat packets. */ }
    };
    session.onChat = (payload, author, authorIdentity) => { void receive(payload, author, authorIdentity); };
    return () => { active = false; session.onChat = undefined; };
  }, [access, key, session]);

  useEffect(() => {
    if (!access || !connected) return;
    const { handle } = access;
    const profileId = access.profileId;
    let active = true, running = false, requested = false;
    const poll = async () => {
      if (!active) return;
      if (running) { requested = true; return; }
      requested = false;
      running = true;
      try {
        if (profileId && key) {
          profileKey.current ??= chatKey(key, access.feed, 'Voicecord chat profile v1');
          const current = currentProfile.current;
          const trimmed = current.nickname.trim();
          if (!publishingProfile.current && trimmed && !/\p{Cc}/u.test(trimmed)
            && (current.nickname !== sentProfile.current?.nickname || current.avatar !== sentProfile.current?.avatar)) {
            publishingProfile.current = true;
            try {
              const update = await encodeChatProfile(await profileKey.current, profileId, trimmed, current.avatar);
              if (active) {
                await window.desktop!.chatRequest(handle, { profile: update });
                sentProfile.current = current;
                session.publishChatRefresh();
              }
            } catch { /* Retry profile sync on the next poll without blocking history. */ }
            finally { publishingProfile.current = false; }
          }
        }
        if (!active) return;
        const after = newest.current;
        const raw = await window.desktop!.chatRequest(handle, { after, ...(profileId ? { profilesAfter: profileCursor.current } : {}) });
        const page = await decodeHistory(raw, after, await getKey());
        const changes = profileId && profileKey.current ? await decodeChatProfiles(raw, profileCursor.current, await profileKey.current) : undefined;
        if (!active) return;
        newest.current = page.cursor;
        setEntryLast(previous => previous ?? page.cursor);
        if (changes) {
          profileCursor.current = changes.cursor;
          const authors = messageAuthors.current;
          for (const id of authors.keys()) if (!page.first || id < page.first) authors.delete(id);
          for (const message of page.messages) if (message.authorId) authors.set(message.id, message.authorId);
          if (changes.profiles.length) {
            const retained = new Set(authors.values());
            setProfiles(previous => {
              const next = new Map(previous);
              for (const item of changes.profiles) {
                next.delete(item.id);
                next.set(item.id, item);
              }
              const idle = [...next.keys()].filter(id => !retained.has(id));
              for (const id of idle.slice(0, Math.max(0, idle.length - 64))) next.delete(id);
              return next;
            });
          }
        }
        setMessages(previous => {
          const retained = previous.filter(message => message.id > page.cursor || (page.first && message.id >= page.first));
          if (!page.messages.length && retained.length === previous.length) return previous;
          const merged = new Map([...retained, ...page.messages].map(message => [message.id, message]));
          return [...merged.values()].sort((a, b) => a.id - b.id);
        });
        setReady(true);
        setHistoryError(false);
      } catch { if (active) setHistoryError(true); }
      finally {
        running = false;
        if (active && requested) void poll();
      }
    };
    refresh.current = () => { void poll(); };
    let notification: ReturnType<typeof setTimeout> | undefined;
    session.onChatRefresh = () => {
      notification ??= setTimeout(() => { notification = undefined; void poll(); }, 100);
    };
    void poll();
    const timer = setInterval(poll, 2500);
    return () => { active = false; refresh.current = undefined; session.onChatRefresh = undefined; clearTimeout(notification); clearInterval(timer); };
  }, [access, connected, key, session]);

  useEffect(() => { refresh.current?.(); }, [profile.nickname, profile.avatar]);

  useLayoutEffect(() => {
    if (!visible) {
      jump.current = true;
      setDivider(readRef.current);
      return;
    }
    const list = stream.current;
    if (!list || !ready) return;
    const sent = arrival.current;
    const sentRow = sent && list.querySelector<HTMLElement>(`[data-message-row="${sent.id}"]`);
    if (sent && sentRow) {
      list.scrollTop = list.scrollHeight;
      follow.current = true;
      jump.current = false;
      arrival.current = undefined;
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const target = sentRow.getBoundingClientRect();
        const dy = Math.max(-160, Math.min(160, sent.y - target.top));
        sentRow.animate([
          { transform: `translate(${sent.x - target.left}px, ${dy}px) scale(.94)`, opacity: 0.35 },
          { transform: 'none', opacity: 1 },
        ], { duration: 240, easing: 'cubic-bezier(.2,.75,.3,1)' });
      }
    } else if (jump.current) {
      const saved = position.current;
      if (saved && messages.length) {
        const rows = messageRows(list);
        const anchor = rows.find(row => Number(row.dataset.messageRow) >= saved.id);
        const offset = Number(anchor?.dataset.messageRow) === saved.id ? saved.offset : 0;
        list.scrollTop = anchor ? anchor.offsetTop + Math.min(offset, anchor.offsetHeight - 1) : list.scrollHeight;
      } else {
        list.scrollTop = marker.current?.offsetTop ?? list.scrollHeight;
      }
      follow.current = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
      jump.current = false;
    } else if (follow.current) {
      list.scrollTop = list.scrollHeight;
    }
    syncScrollFades(list);
    rememberViewport(list);
  }, [messages, visible, ready]);

  useLayoutEffect(() => {
    const list = stream.current;
    if (!visible || !list) return;
    const observer = new ResizeObserver(() => {
      if (follow.current) list.scrollTop = list.scrollHeight;
      syncScrollFades(list);
      if (!jump.current) rememberViewport(list);
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    const list = stream.current;
    if (!visible || !ready || covered || !list) return;
    const observer = new IntersectionObserver(entries => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      let last = readRef.current;
      for (const entry of entries) {
        if (entry.isIntersecting) last = Math.max(last, Number((entry.target as HTMLElement).dataset.chatId));
      }
      if (last === readRef.current) return;
      readRef.current = last;
      setRead(last);
      if (access) writeChatCursor(access, last);
    }, { threshold: 1 });
    const observe = () => {
      observer.disconnect();
      for (const target of list.querySelectorAll('[data-chat-id]')) observer.observe(target);
    };
    observe();
    window.addEventListener('focus', observe);
    document.addEventListener('visibilitychange', observe);
    return () => {
      observer.disconnect();
      window.removeEventListener('focus', observe);
      document.removeEventListener('visibilitychange', observe);
    };
  }, [access, covered, messages, visible, ready]);

  async function send() {
    const text = draft.trim();
    if (!connected || sending || !text || chatEncoder.encode(text).length > chatTextLimit) return;
    const now = Date.now();
    sendTimes.current = sendTimes.current.filter(time => now - time < 1000);
    if (sendTimes.current.length >= chatSendsPerSecond) { setRateLimited(true); return; }
    const origin = composer.current?.getBoundingClientRect();
    setSending(true);
    setSendError(false);
    setRateLimited(false);
    try {
      let packet: ChatPacket | undefined;
      if (key) {
        packet = pending.current?.text === text ? pending.current.packet : await encryptChat(await getKey(), text);
        pending.current = { text, packet };
      }
      let id: number;
      const author = profile.nickname.trim() || nickname;
      if (access && packet) {
        const result = await window.desktop!.chatRequest(access.handle, { packet }) as { id?: number; rateLimited?: boolean } | null;
        if (result?.rateLimited) { setRateLimited(true); return; }
        if (typeof result?.id !== 'number' || !Number.isSafeInteger(result.id) || result.id <= 0) throw new Error('Chat save unconfirmed');
        id = result.id;
        const confirmed = { id, key: packet.requestId, author, authorId: access.profileId, text, sent: Date.now() };
        setMessages(previous => previous.some(message => message.id === id) ? [...previous] : [...previous, confirmed].sort((a, b) => a.id - b.id));
        session.publishChatRefresh();
        refresh.current?.();
      } else if (!access) {
        await session.sendChat(chatEncoder.encode(packet ? JSON.stringify(packet) : text), identity);
        id = appendLive({ key: packet?.requestId ?? crypto.randomUUID(), author, authorIdentity: identity, text, sent: Date.now() });
      } else {
        throw new Error('Chat key missing');
      }
      sendTimes.current.push(Date.now());
      arrival.current = { id, x: origin?.left ?? 0, y: origin?.top ?? 0 };
      if (id > readRef.current) {
        readRef.current = id;
        setRead(id);
        if (access) writeChatCursor(access, id);
      }
      setHasSent(true);
      pending.current = undefined;
      setDraft('');
    } catch { setSendError(true); }
    finally { setSending(false); }
  }

  const firstUnread = messages.find(message => message.id > read);
  const firstNew = !hasSent && entryLast !== undefined ? messages.findIndex(message => message.id > divider && message.id <= entryLast) : -1;
  const tooLong = chatEncoder.encode(draft.trim()).length > chatTextLimit;
  if (!visible) return null;
  const peopleById = new Map(people.map(person => [person.id, person]));
  const typists = people.filter(person => !person.local && typing.has(person.id));

  return <section className="room-chat" aria-label={t("Текстовый чат")}>
    <div className="chat-heading">
      <div className="chat-features">
        <button type="button" aria-describedby="room-chat-features">{t("Особенности")}<Icon name="info" size={14}/></button>
        <div className="chat-feature-tip" id="room-chat-features" role="tooltip">
          <p>{key ? t("Текст шифруется от отправителя до участников. Сервер не может прочитать переписку.") : t("Сообщения защищены при передаче. Сервер может прочитать текст.")}</p>
          <p>{access?.ephemeral
            ? t("До {0} последних сообщений доступны при повторном входе. История хранится в памяти до остановки комнаты или до 7 дней.", chatMessageLimit)
            : access
              ? t("До {0} последних сообщений хранятся на сервере до 7 дней. При входе видны и сообщения, отправленные в ваше отсутствие.", chatMessageLimit)
              : t("До {0} последних сообщений остаются в чате, пока вы в комнате. При повторном входе лента пустая.", chatMessageLimit)}</p>
          <p>{t("Enter отправляет сообщение. Shift+Enter добавляет новую строку.")}</p>
        </div>
      </div>
    </div>
      <div className="chat-feed">
      <div className="chat-stream" ref={stream} tabIndex={0} aria-label={t("Сообщения чата")} onScroll={event => {
        const list = event.currentTarget;
        follow.current = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
        syncScrollFades(list);
        if (!jump.current) rememberViewport(list);
      }}>
        {!messages.length && <p className="chat-empty">{ready ? t("Сообщений пока нет.") : t("Загружаем историю…")}</p>}
        {messages.map((message, index) => {
          const saved = message.authorId ? profiles.get(message.authorId) : undefined;
          const live = message.authorIdentity ? peopleById.get(message.authorIdentity) : undefined;
          const name = saved?.nickname ?? live?.name ?? message.author;
          const continuation = index !== firstNew && continuesMessageGroup(messages[index - 1], message);
          return <article className={`chat-message${continuation ? ' chat-message-continuation' : ''}`} key={message.id}>
          {index === firstNew && <div className="chat-divider" ref={marker}>{t("Новые сообщения")}</div>}
          <div className="chat-message-row" data-message-row={message.id}>
            {continuation ? <span className="chat-continuation-time"><MessageTime sent={message.sent}/></span> : <Avatar name={name} image={saved?.avatar ?? live?.avatar} className="chat-avatar"/>}
            <div className="chat-message-body">
              {!continuation && <div className="chat-meta"><strong>{name}</strong><MessageTime sent={message.sent}/></div>}
              <p>{message.text}</p>
            </div>
          </div>
          <div className="chat-read-end" data-chat-id={message.id}/>
        </article>;
        })}
      </div>
      {firstUnread && <button type="button" className="chat-jump" onClick={() => {
        const list = stream.current;
        const target = list?.querySelector<HTMLElement>(`[data-message-row="${firstUnread.id}"]`);
        if (list && target) {
          stopHighlight.current?.();
          const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
          const flash = () => {
            stopHighlight.current?.();
            target.animate([{ backgroundColor: '#7663ad44' }, { backgroundColor: 'transparent' }], { duration: reduced ? 150 : 850, easing: 'ease-out' });
          };
          if (reduced) {
            list.scrollTop = target.offsetTop - 16;
            flash();
          } else {
            list.addEventListener('scrollend', flash, { once: true });
            const timer = setTimeout(flash, 650);
            stopHighlight.current = () => { clearTimeout(timer); list.removeEventListener('scrollend', flash); stopHighlight.current = undefined; };
            list.scrollTo({ top: target.offsetTop - 16, behavior: 'smooth' });
          }
        }
        input.current?.focus({ preventScroll: true });
      }}>{t("Перейти к новым")}<Icon name="arrow-down" size={15}/></button>}
      </div>
      {historyError && <p className="text-error" role="status">{t("Не удалось загрузить историю чата. Повторяем подключение…")}</p>}
      {tooLong && <p className="text-error" role="status">{t("Сообщение слишком длинное.")}</p>}
      {sendError && <p className="text-error" role="alert">{t("Отправка не подтверждена. Попробуйте снова.")}</p>}
      {rateLimited && <p className="text-error" role="status">{t("Слишком много сообщений. Подождите секунду.")}</p>}
      {typists.length > 0 && <p className="chat-typing" role="status">
        <span className="chat-typing-dots" aria-hidden="true"><i/><i/><i/></span>
        {typists.length === 1 ? t("{0} печатает…", typists[0].name) : t("Несколько участников печатают…")}
      </p>}
      <form className="chat-compose" ref={composer} data-sending={sending || undefined} onSubmit={event => { event.preventDefault(); void send(); }}>
        <Avatar name={profile.nickname || nickname} image={profile.avatar} className="chat-avatar composer-avatar"/>
        <textarea ref={input} rows={1} aria-label={t("Сообщение")} placeholder={t("Написать сообщение…")} value={draft}
          maxLength={chatTextLimit} readOnly={sending} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            event.preventDefault();
            if (!event.repeat) void send();
          }}/>
      </form>
  </section>;
}
