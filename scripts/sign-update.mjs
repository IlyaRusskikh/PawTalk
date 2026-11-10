// Sign the exact release installer. Never print or copy the private key into the repository.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const keys = JSON.parse(await readFile(path.join(root, 'electron/update-keys.json'), 'utf8'));
const keyText = process.env.PAWTALK_UPDATE_PRIVATE_KEY || (process.env.PAWTALK_UPDATE_KEY_FILE && await readFile(process.env.PAWTALK_UPDATE_KEY_FILE, 'utf8'));
if (!keyText) throw Error('Set PAWTALK_UPDATE_PRIVATE_KEY or PAWTALK_UPDATE_KEY_FILE to sign updates.');
const key = createPrivateKey(keyText);
const publicPEM = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
const keyId = Object.keys(keys).find(id => keys[id] === publicPEM);
if (key.asymmetricKeyType !== 'ed25519' || !keyId) throw Error('Signing key does not match a trusted update key.');
const directory = path.resolve(process.argv[2] || path.join(root, 'release'));
const name = `PawTalk.Setup.${version}.exe`;
const installer = path.join(directory, name);
const hash = createHash('sha256');
for await (const chunk of createReadStream(installer)) hash.update(chunk);
const publishedAt = Date.now();
const payload = Buffer.from(JSON.stringify({ schema: 1, component: 'client', version, name, size: (await stat(installer)).size,
  sha256: hash.digest('hex'), prerelease: version.includes('-') || process.env.PAWTALK_PRERELEASE === 'true',
  publishedAt, expiresAt: publishedAt + 365 * 86400000 }));
await writeFile(path.join(directory, 'update-manifest.json'), JSON.stringify({ keyId, payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }) + '\n');
console.log('Signed update-manifest.json for ' + name);
