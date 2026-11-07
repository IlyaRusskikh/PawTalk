import { avatarPayloadLimit, validAvatar } from './avatarImage';
import { base64, unbase64, chatEncoder, chatDecoder, validProfileId, type ChatProfile, type ChatProfilePacket } from './chat';

export async function encodeChatProfile(key: CryptoKey | undefined, id: string, nickname: string, avatar?: string): Promise<ChatProfilePacket> {
  if (!avatar) return { nickname };
  if (!key) return { nickname, ciphertext: base64(chatEncoder.encode(avatar)) };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: chatEncoder.encode(id) }, key, chatEncoder.encode(avatar));
  return { nickname, nonce: base64(iv), ciphertext: base64(new Uint8Array(encrypted)) };
}

export async function decodeChatProfiles(input: unknown, after: number, key: CryptoKey | undefined) {
  const records = (input as { profiles?: unknown } | null)?.profiles;
  if (!Array.isArray(records) || records.length > 564) throw new Error('Invalid chat profiles');
  let cursor = after;
  for (const profile of records) {
    if (!profile || !validProfileId(profile.id) || !Number.isSafeInteger(profile.revision) || profile.revision <= cursor
      || typeof profile.nickname !== 'string' || !profile.nickname.trim() || profile.nickname.length > 64) throw new Error('Invalid chat profile');
    cursor = profile.revision;
  }
  const profiles = await Promise.all(records.map(async (profile): Promise<ChatProfile> => {
    const result: ChatProfile = { id: profile.id, revision: profile.revision, nickname: profile.nickname };
    if ((key && (typeof profile.nonce !== 'string' || profile.nonce.length !== 16)) || typeof profile.ciphertext !== 'string' || profile.ciphertext.length > 16024) return result;
    try {
      const iv = unbase64(profile.nonce ?? '');
      const ciphertext = unbase64(profile.ciphertext);
      if (iv.length !== (key ? 12 : 0) || ciphertext.length > avatarPayloadLimit + (key ? 16 : 0)) return result;
      const clear = key ? await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: chatEncoder.encode(profile.id) }, key, ciphertext) : ciphertext;
      const avatar = chatDecoder.decode(clear);
      if (validAvatar(avatar)) result.avatar = avatar;
    } catch { /* An invalid avatar leaves the author's initials visible. */ }
    return result;
  }));
  return { cursor, profiles };
}
