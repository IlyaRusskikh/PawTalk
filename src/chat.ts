import { mediaKeyBytes } from '../shared/encryption.mjs';

export type ChatAccess = { handle: string; feed: string; ephemeral: boolean; profileId?: string; protocol?: number; encrypted?: boolean; mutations?: boolean };
export type ChatHistoryRequest = { after?: number; before?: number; around?: number; limit?: number; profilesAfter?: number; readAfter?: number; ids?: number[]; digest?: string };
export type ChatImage = { id: string; name: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; size: number; width: number; height: number };
export type ChatReply = { key: string; id?: number; author: string; text: string };
export type ChatContent = { text: string; image?: ChatImage; reply?: ChatReply; edited?: boolean };
export type ChatPacket = { requestId: string; nonce: string; ciphertext: string; attachmentId?: string };
export type ChatProfilePacket = { nickname: string; nonce?: string; ciphertext?: string };
export type ChatProfile = { id: string; revision: number; nickname: string; avatar?: string };
export type ChatMessage = ChatContent & { key: string; id: number; author: string; authorIdentity?: string; authorId?: string; sent: number };
export const chatEncoder = new TextEncoder();
export const chatDecoder = new TextDecoder('utf-8', { fatal: true });
export const chatTextLimit = 4096;
export const chatMessageLimit = 500;
export const chatWindowLimit = 100;
export const chatContentLimit = 12288;
export const chatImageLimit = 2 * 1024 * 1024;
export const chatSendsPerSecond = 3;

export function continuesMessageGroup(previous: ChatMessage | undefined, message: ChatMessage) {
  if (!previous || message.sent < previous.sent || message.sent - previous.sent > 5 * 60 * 1000
    || new Date(previous.sent).toDateString() !== new Date(message.sent).toDateString()) return false;
  if (previous.authorId || message.authorId) return !!message.authorId && previous.authorId === message.authorId;
  return !!message.authorIdentity && previous.authorIdentity === message.authorIdentity;
}

export const base64 = (data: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(binary);
};
export const unbase64 = (data: string) => Uint8Array.from(atob(data), c => c.charCodeAt(0));

export async function chatKey(mediaKey: string, feed: string, purpose = 'PawTalk chat v1') {
  const root = await crypto.subtle.importKey('raw', mediaKeyBytes(mediaKey).buffer as ArrayBuffer, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: chatEncoder.encode(feed), info: chatEncoder.encode(purpose),
  }, root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const contentPrefix = '\u001ePAWTALK:2\n';
export function validChatImage(image: unknown): image is ChatImage {
  const value = image as Partial<ChatImage> | null;
  return !!value && typeof value.id === 'string' && /^[a-f0-9]{32}$/.test(value.id)
    && typeof value.name === 'string' && value.name.length <= 128
    && ['image/png', 'image/jpeg', 'image/webp'].includes(value.mime ?? '')
    && Number.isSafeInteger(value.size) && value.size! > 0 && value.size! <= chatImageLimit
    && Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height)
    && value.width! > 0 && value.height! > 0 && value.width! <= 8192 && value.height! <= 8192 && value.width! * value.height! <= 16000000;
}
function parseContent(raw: string): ChatContent | undefined {
  if (!raw.startsWith(contentPrefix)) {
    const text = raw.trim();
    return text && chatEncoder.encode(text).length <= chatTextLimit ? { text } : undefined;
  }
  const value = JSON.parse(raw.slice(contentPrefix.length));
  if (!value || typeof value.text !== 'string' || chatEncoder.encode(value.text).length > chatTextLimit
    || (!value.text.trim() && !value.image) || (value.image && !validChatImage(value.image))) return;
  const reply = value.reply;
  if (reply && (typeof reply.key !== 'string' || !/^[a-f0-9-]{32,36}$/.test(reply.key)
    || (reply.id !== undefined && (!Number.isSafeInteger(reply.id) || reply.id <= 0))
    || typeof reply.author !== 'string' || reply.author.length > 64 || typeof reply.text !== 'string' || reply.text.length > 240)) return;
  return { text: value.text.trim(), ...(value.image ? { image: value.image as ChatImage } : {}), ...(reply ? { reply: reply as ChatReply } : {}), ...(value.edited === true ? { edited: true } : {}) };
}
export async function encryptChat(key: CryptoKey | undefined, text: string, extra?: Pick<ChatContent, 'image' | 'reply' | 'edited'>, existingKey?: string): Promise<ChatPacket> {
  const requestId = existingKey ?? crypto.randomUUID().replaceAll('-', '');
  const clear = chatEncoder.encode(extra?.image || extra?.reply || extra?.edited ? contentPrefix + JSON.stringify({ text, ...extra }) : text);
  if (clear.length > chatContentLimit || !parseContent(chatDecoder.decode(clear))) throw new Error('Invalid chat content');
  const attachment = extra?.image ? { attachmentId: extra.image.id } : {};
  if (!key) return { requestId, nonce: '', ciphertext: base64(clear), ...attachment };
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: nonce, additionalData: chatEncoder.encode(requestId),
  }, key, clear);
  return { requestId, nonce: base64(nonce), ciphertext: base64(new Uint8Array(ciphertext)), ...attachment };
}

export async function decryptChat(key: CryptoKey | undefined, input: unknown) {
  const packet = input as Partial<ChatPacket> | null;
  if (typeof packet?.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(packet.requestId)
    || typeof packet.nonce !== 'string' || packet.nonce.length !== (key ? 16 : 0)
    || typeof packet.ciphertext !== 'string' || packet.ciphertext.length > 16408) return;
  try {
    const iv = unbase64(packet.nonce);
    const ciphertext = unbase64(packet.ciphertext);
    if (iv.length !== (key ? 12 : 0) || ciphertext.length <= (key ? 16 : 0) || ciphertext.length > chatContentLimit + (key ? 16 : 0)) return;
    const raw = key ? await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: chatEncoder.encode(packet.requestId) }, key, ciphertext) : ciphertext;
    const content = parseContent(chatDecoder.decode(raw));
    if (content && (content.image?.id ?? undefined) === packet.attachmentId) return { key: packet.requestId, ...content };
  } catch {
    // Invalid ciphertext and plaintext packets are ignored.
  }
}

export async function decodeHistory(input: unknown, after: number, key: CryptoKey | undefined) {
  type Record = ChatPacket & { id: number; author: string; authorId?: string; sent: number };
  const page = input as { first: number; messages: Record[] } | null;
  if (!page || !Number.isSafeInteger(page.first) || page.first < 0 || !Array.isArray(page.messages) || page.messages.length > chatMessageLimit) {
    throw new Error('Invalid chat history');
  }
  let cursor = after;
  for (const record of page.messages) {
    if (!record || !Number.isSafeInteger(record.id) || record.id <= cursor || page.first === 0 || record.id < page.first
      || typeof record.author !== 'string' || record.author.length > 64
      || (record.authorId !== undefined && !validProfileId(record.authorId))
      || !Number.isSafeInteger(record.sent) || record.sent < 0 || record.sent > 8.64e15) {
      throw new Error('Invalid chat record');
    }
    cursor = record.id;
  }
  const decoded = await Promise.all(page.messages.map(async record => {
    const content = await decryptChat(key, record);
    return content && { ...content, id: record.id, author: record.author, ...(record.authorId ? { authorId: record.authorId } : {}), sent: record.sent };
  }));
  return { first: page.first, cursor, messages: decoded.filter(message => message !== undefined) };
}

export function validProfileId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
}

const sessionCursors = new Map<string, number>();
export type ChatScrollPosition = { id: number; offset: number };
const sessionPositions = new Map<string, ChatScrollPosition>();

function rememberForFeed<T>(entries: Map<string, T>, feed: string, value: T) {
  entries.delete(feed);
  if (entries.size >= 50) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(feed, value);
}

export function readChatPosition(access?: ChatAccess): ChatScrollPosition | undefined {
  if (!access) return;
  const recent = sessionPositions.get(access.feed);
  if (recent || access.ephemeral) return recent;
  try {
    const saved = JSON.parse(localStorage.getItem('pawtalk.chat.scroll.' + access.feed) ?? 'null');
    if (saved && Number.isSafeInteger(saved.id) && saved.id > 0 && Number.isFinite(saved.offset)) {
      return { id: saved.id, offset: saved.offset };
    }
  } catch { /* An unreadable position leaves the default scroll behavior in place. */ }
}

export function writeChatPosition(access: ChatAccess, position: ChatScrollPosition) {
  rememberForFeed(sessionPositions, access.feed, position);
  if (access.ephemeral) return;
  try { localStorage.setItem('pawtalk.chat.scroll.' + access.feed, JSON.stringify(position)); } catch { /* Keep it for this session. */ }
}

export function readChatCursor(access?: ChatAccess) {
  if (!access) return 0;
  if (access.ephemeral) return sessionCursors.get(access.feed) ?? 0;
  try {
    const saved = Number(localStorage.getItem('pawtalk.chat.read.' + access.feed));
    if (Number.isSafeInteger(saved) && saved > 0) return saved;
  } catch { /* Storage is unavailable. */ }
  return 0;
}

export function writeChatCursor(access: ChatAccess, id: number) {
  if (access.ephemeral) {
    rememberForFeed(sessionCursors, access.feed, id);
    return;
  }
  try { localStorage.setItem('pawtalk.chat.read.' + access.feed, String(id)); } catch { /* Keep the cursor for this session. */ }
}
