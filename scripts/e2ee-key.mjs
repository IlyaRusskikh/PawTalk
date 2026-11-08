// Run on a trusted participant's computer, never on an untrusted relay server.
import { generateMediaKey, mediaKeyID } from '../shared/encryption.mjs';
const key = generateMediaKey();
console.log(`Ключ для клиентов (секрет): ${key}\nPAWTALK_E2EE=true\nPAWTALK_E2EE_KEY_ID=${await mediaKeyID(key)}`);
if (process.argv[2]) {
  const url = new URL(process.argv[2]);
  if (url.protocol !== 'pawtalk:') throw new Error('Нужно приглашение pawtalk:// от VPS');
  const params = new URLSearchParams(url.hash.slice(1)); params.set('e2ee', key); url.hash = params.toString();
  console.log(`Приглашение с ключом (секрет): ${url}`);
}
