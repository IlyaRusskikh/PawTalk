import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'deploy/generated');
try { await access(path.join(dir, 'api.env')); console.error('Конфигурация уже существует. Для ротации перенесите deploy/generated в резервную копию и повторите команду.'); process.exit(1); } catch {}
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const ip = (await rl.question('IP сервера (публичный или LAN): ')).trim();
  if (!isIP(ip)) throw new Error('Нужен корректный IP-адрес');
  const email = (await rl.question('Email для TLS-сертификатов: ')).trim();
  if (!/^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) throw new Error('Неверный email');
  // Generate a high-entropy shared password without echoing typed secrets.
  const password = randomBytes(18).toString('base64url');
  const salt = randomBytes(16); const digest = pbkdf2Sync(password, salt, 600000, 32, 'sha256');
  const hash = `pbkdf2-sha256$600000$${salt.toString('base64url')}$${digest.toString('base64url')}`;
  const key = 'vc_' + randomBytes(12).toString('hex'); const secret = randomBytes(32).toString('hex');
  const host = isIP(ip) === 6 ? `[${ip}]` : ip;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const save = (name, text) => writeFile(path.join(dir, name), text, { mode: 0o600, flag: 'wx' });
  // Quotes prevent Docker Compose from interpolating dollar signs in PBKDF2 hashes.
  await save('api.env', `LISTEN_ADDR=127.0.0.1:8080\nLIVEKIT_URL=wss://${host}/rtc\nLIVEKIT_API_KEY=${key}\nLIVEKIT_API_SECRET=${secret}\nPAWTALK_PASSWORD_HASH='${hash}'\n`);
  await save('api.dev.env', `LISTEN_ADDR=127.0.0.1:8080\nLIVEKIT_URL=ws://127.0.0.1:7880\nLIVEKIT_API_KEY=${key}\nLIVEKIT_API_SECRET=${secret}\nPAWTALK_PASSWORD_HASH='${hash}'\n`);
  await save('proxy.env', `SERVER_IP=${ip}\nSERVER_HOST=${host}\nACME_EMAIL=${email}\n`);
  const base = `port: 7880\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: 7881\n  udp_port: 7882\n  use_external_ip: false\n  node_ip: ${ip}\nkeys:\n  ${key}: ${secret}\nroom:\n  auto_create: true\n  empty_timeout: 300\n  max_participants: 30\nlogging:\n  level: info\n`;
  await save('livekit.yaml', base);
  await save('livekit.dev.yaml', base.replace('bind_addresses: [127.0.0.1]', 'bind_addresses: [0.0.0.0]').replace(`node_ip: ${ip}`, 'node_ip: 127.0.0.1'));
  console.log(`\nКонфигурация создана. Общий пароль (показан один раз):\n${password}\n\nСохраните пароль и передайте друзьям. В файлах хранится только его хеш.`);
  if (ip === '127.0.0.1' || ip === '::1') {
    console.log('\nЛокальный запуск Windows:\n  docker compose -f compose.dev.yaml up -d\n  powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\server-dev.ps1\nВ другом терминале: npm run dev\nАдрес в клиенте: http://127.0.0.1:8080\ncompose.yaml с host networking предназначен для Linux-сервера.');
  } else console.log('\nЗапуск на Linux-сервере: docker compose up -d --build\nДля локального теста на Windows используйте compose.dev.yaml.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { rl.close(); }
