import { signatureFrame } from './framing.mjs';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
export const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
export function unhex(value, size) {
  if (typeof value !== 'string' || value.length !== size * 2 || !/^[0-9a-f]+$/.test(value)) throw Error('Invalid cryptographic identifier');
  return Uint8Array.from(value.match(/../g), pair => Number.parseInt(pair, 16));
}
export function randomSecret() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
export async function digestHex(bytes) { return hex(await crypto.subtle.digest('SHA-256', bytes)); }
export async function rootKeyID(secret) { return digestHex(unhex(secret, 32)); }
export function encodeBytes(bytes) {
  bytes = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decodeBytes(value, max = 2 * 1024 * 1024 + 16) {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) + 4 || !/^[\w-]*$/.test(value)) throw Error('Invalid encrypted packet');
  const decoded = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), letter => letter.charCodeAt(0));
  if (decoded.length > max || encodeBytes(decoded) !== value) throw Error('Invalid encrypted packet');
  return decoded;
}
async function hkdf(secret, serverId, info) {
  const source = await crypto.subtle.importKey('raw', unhex(secret, 32), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: unhex(serverId, 16), info }, source, 256));
}
export async function deriveChannelBytes(secret, serverId, purpose, channelId = '') {
  if (!['chat', 'voice', 'attachment', 'avatar'].includes(purpose)) throw Error('Invalid encryption purpose');
  if (purpose !== 'avatar') unhex(channelId, 16);
  else if (channelId !== '') throw Error('Avatars use a server context');
  return hkdf(secret, serverId, signatureFrame('pawtalk-key-v2', purpose, channelId, await rootKeyID(secret)));
}
async function aesKey(bytes, usages) { return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, usages); }
async function seal(bytes, plaintext, aad, keyId) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, await aesKey(bytes, ['encrypt']), plaintext);
  return { version: 2, keyId, nonce: encodeBytes(nonce), ciphertext: encodeBytes(ciphertext) };
}
async function open(bytes, packet, aad, keyId) {
  if (!packet || packet.version !== 2 || packet.keyId !== keyId || Object.keys(packet).some(key => !['version', 'keyId', 'nonce', 'ciphertext'].includes(key))) throw Error('Invalid encrypted packet');
  const nonce = decodeBytes(packet.nonce, 12), ciphertext = decodeBytes(packet.ciphertext);
  if (nonce.length !== 12 || ciphertext.length < 17) throw Error('Invalid encrypted packet');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, await aesKey(bytes, ['decrypt']), ciphertext));
}
export async function sealInvitation(secret, serverId, inviteId, openingSecret) {
  unhex(inviteId, 16);
  const keyId = await rootKeyID(secret);
  const key = await hkdf(openingSecret, serverId, signatureFrame('pawtalk-invite-v2', inviteId));
  const aad = signatureFrame('pawtalk-invite-package-v2', serverId, inviteId, keyId);
  const packet = await seal(key, encoder.encode(JSON.stringify({ version: 2, serverId, secret, keyId })), aad, keyId);
  return { packet, digest: await digestHex(encoder.encode(JSON.stringify(packet))) };
}
export async function openInvitation(packet, expectedDigest, serverId, inviteId, openingSecret) {
  unhex(serverId, 16); unhex(inviteId, 16); unhex(expectedDigest, 32);
  if (await digestHex(encoder.encode(JSON.stringify(packet))) !== expectedDigest) throw Error('Invitation package changed');
  unhex(packet.keyId, 32);
  const key = await hkdf(openingSecret, serverId, signatureFrame('pawtalk-invite-v2', inviteId));
  const aad = signatureFrame('pawtalk-invite-package-v2', serverId, inviteId, packet.keyId);
  const result = JSON.parse(decoder.decode(await open(key, packet, aad, packet.keyId)));
  if (result.version !== 2 || result.serverId !== serverId || result.keyId !== packet.keyId || await rootKeyID(result.secret) !== result.keyId) throw Error('Invalid invitation contents');
  return result.secret;
}
export async function sealLinkedRoot(secret, serverId, linkId, sharedSecret, transcript) {
  unhex(linkId, 16);
  const keyId = await rootKeyID(secret), transcriptHash = await digestHex(transcript);
  const key = await hkdf(sharedSecret, serverId, signatureFrame('pawtalk-link-delivery-v2', linkId, transcriptHash));
  return seal(key, encoder.encode(JSON.stringify({ version: 2, serverId, secret, keyId })), transcript, keyId);
}
export async function openLinkedRoot(packet, serverId, linkId, sharedSecret, transcript) {
  unhex(linkId, 16); unhex(packet.keyId, 32);
  const key = await hkdf(sharedSecret, serverId, signatureFrame('pawtalk-link-delivery-v2', linkId, await digestHex(transcript)));
  const result = JSON.parse(decoder.decode(await open(key, packet, transcript, packet.keyId)));
  if (result.version !== 2 || result.serverId !== serverId || result.keyId !== packet.keyId || await rootKeyID(result.secret) !== result.keyId) throw Error('Invalid linked-device key package');
  return result.secret;
}
function contentContext(serverId, purpose, channelId, resourceId, authorProfileId, keyId) {
  unhex(serverId, 16); unhex(authorProfileId, 32);
  if (typeof resourceId !== 'string' || resourceId.length < 1 || resourceId.length > 64) throw Error('Invalid encrypted resource');
  return signatureFrame('pawtalk-content-v2', serverId, purpose, channelId, resourceId, authorProfileId, keyId);
}
export async function sealContent(secret, serverId, purpose, channelId, resourceId, authorProfileId, plaintext) {
  const keyId = await rootKeyID(secret), key = await deriveChannelBytes(secret, serverId, purpose, channelId);
  return seal(key, plaintext, contentContext(serverId, purpose, channelId, resourceId, authorProfileId, keyId), keyId);
}
export async function openContent(secret, serverId, purpose, channelId, resourceId, authorProfileId, packet) {
  const keyId = await rootKeyID(secret), key = await deriveChannelBytes(secret, serverId, purpose, channelId);
  return open(key, packet, contentContext(serverId, purpose, channelId, resourceId, authorProfileId, keyId), keyId);
}
