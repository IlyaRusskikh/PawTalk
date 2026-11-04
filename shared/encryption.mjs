// A separate random 256-bit media key; never derive it from the login password.
export function validMediaKey(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
export function generateMediaKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
}
export function mediaKeyBytes(value) {
  if (!validMediaKey(value)) throw new Error('Нужен ключ E2EE из приглашения: 64 шестнадцатеричных символа.');
  return Uint8Array.from(value.match(/../g), part => parseInt(part, 16));
}
export async function mediaKeyID(value) {
  const digest = await crypto.subtle.digest('SHA-256', mediaKeyBytes(value));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
export function invitationMediaKey(address) {
  const url = new URL(address.includes('://') ? address : `https://${address}`);
  const key = new URLSearchParams(url.hash.slice(1)).get('e2ee');
  if (key !== null && !validMediaKey(key)) throw new Error('Неверный ключ E2EE в приглашении.');
  return key;
}
