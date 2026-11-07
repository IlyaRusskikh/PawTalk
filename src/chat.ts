import { mediaKeyBytes } from '../shared/encryption.mjs';

export type ChatAccess = { handle: string; feed: string; ephemeral: boolean; profileId?: string };
export type ChatPacket = { requestId: string; nonce: string; ciphertext: string };
export type ChatProfilePacket = { nickname: string; nonce?: string; ciphertext?: string };
export type ChatProfile = { id: string; revision: number; nickname: string; avatar?: string };
export type ChatMessage = { key: string; id: number; author: string; authorIdentity?: string; authorId?: string; sent: number; text: string };
export const chatEncoder = new TextEncoder();
export const chatDecoder = new TextDecoder('utf-8', { fatal: true });
export const chatTextLimit = 4096;
export const chatMessageLimit = 500;
export const chatSendsPerSecond = 3;

export function continuesMessageGroup(previous: ChatMessage | undefined, message: ChatMessage) {
  if (!previous || message.sent < previous.sent || message.sent - previous.sent > 5 * 60 * 1000
    || new Date(previous.sent).toDateString() !== new Date(message.sent).toDateString()) return false;
  if (previous.authorId || message.authorId) return !!message.authorId && previous.authorId === message.authorId;
  return !!message.authorIdentity && previous.authorIdentity === message.authorIdentity;
}

export const base64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));
export const unbase64 = (data: string) => Uint8Array.from(atob(data), c => c.charCodeAt(0));

export async function chatKey(mediaKey: string, feed: string, purpose = 'Voicecord chat v1') {
  const root = await crypto.subtle.importKey('raw', mediaKeyBytes(mediaKey).buffer as ArrayBuffer, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: chatEncoder.encode(feed), info: chatEncoder.encode(purpose),
  }, root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptChat(key: CryptoKey, text: string): Promise<ChatPacket> {
  const requestId = crypto.randomUUID().replaceAll('-', '');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: nonce, additionalData: chatEncoder.encode(requestId),
  }, key, chatEncoder.encode(text));
  return { requestId, nonce: base64(nonce), ciphertext: base64(new Uint8Array(ciphertext)) };
}

export async function decryptChat(key: CryptoKey, input: unknown) {
  const packet = input as Partial<ChatPacket> | null;
  if (typeof packet?.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(packet.requestId)
    || typeof packet.nonce !== 'string' || packet.nonce.length !== 16
    || typeof packet.ciphertext !== 'string' || packet.ciphertext.length > 5484) return;
  try {
    const iv = unbase64(packet.nonce);
    const ciphertext = unbase64(packet.ciphertext);
    if (iv.length !== 12 || ciphertext.length <= 16 || ciphertext.length > chatTextLimit + 16) return;
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: chatEncoder.encode(packet.requestId) }, key, ciphertext);
    const text = chatDecoder.decode(raw).trim();
    if (text) return { key: packet.requestId, text };
  } catch {
    // Invalid ciphertext and plaintext packets are ignored.
  }
}

export async function decodeHistory(input: unknown, after: number, key: CryptoKey) {
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
    const saved = JSON.parse(localStorage.getItem('voicecord.chat.scroll.' + access.feed) ?? 'null');
    if (saved && Number.isSafeInteger(saved.id) && saved.id > 0 && Number.isFinite(saved.offset)) {
      return { id: saved.id, offset: saved.offset };
    }
  } catch { /* An unreadable position leaves the default scroll behavior in place. */ }
}

export function writeChatPosition(access: ChatAccess, position: ChatScrollPosition) {
  rememberForFeed(sessionPositions, access.feed, position);
  if (access.ephemeral) return;
  try { localStorage.setItem('voicecord.chat.scroll.' + access.feed, JSON.stringify(position)); } catch { /* Keep it for this session. */ }
}

export function readChatCursor(access?: ChatAccess) {
  if (!access) return 0;
  if (access.ephemeral) return sessionCursors.get(access.feed) ?? 0;
  try {
    const saved = Number(localStorage.getItem('voicecord.chat.read.' + access.feed));
    if (Number.isSafeInteger(saved) && saved > 0) return saved;
  } catch { /* Storage is unavailable. */ }
  return 0;
}

export function writeChatCursor(access: ChatAccess, id: number) {
  if (access.ephemeral) {
    rememberForFeed(sessionCursors, access.feed, id);
    return;
  }
  try { localStorage.setItem('voicecord.chat.read.' + access.feed, String(id)); } catch { /* Keep the cursor for this session. */ }
}
