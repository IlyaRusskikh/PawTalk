// Run on a trusted participant's computer, never on an untrusted relay server.
import { generateMediaKey, mediaKeyID } from '../shared/encryption.mjs';
const key = generateMediaKey();
console.log(`Секретный ключ (не публикуйте; только для участников комнаты): ${key}\nПубличный отпечаток (SHA-256 key ID, для сервера): ${await mediaKeyID(key)}`);
if (process.argv[2]) {
  const url = new URL(process.argv[2]);
  if (url.protocol !== 'pawtalk:') throw new Error('Нужно приглашение pawtalk:// от VPS');
  const params = new URLSearchParams(url.hash.slice(1)); params.set('e2ee', key); url.hash = params.toString();
  console.log(`Приглашение с ключом (секрет): ${url}`);
}
