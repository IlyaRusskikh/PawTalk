const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');
const { invitation, serverURL } = require('./address.cjs');

function localInvitation(address, status) {
  serverURL(address); // Validate even when no local host is running.
  if (!status?.running || !status.localAddress || !status.invitations?.some(value => value.split('#')[0] === address.trim().split('#')[0])) return address;
  const requested = invitation(address), local = invitation(status.localAddress);
  // Never rewrite an old or foreign invitation just because the IP matches.
  return requested && local && requested.fingerprint === local.fingerprint ? status.localAddress : address;
}

async function verifyInvitation(address, timeout = 5000) {
  const room = invitation(address);
  if (!room) return;
  const target = new URL(room.origin);
  await new Promise((resolve, reject) => {
    let connected = false;
    const socket = tls.connect({ host: room.hostname, port: Number(target.port || 443), rejectUnauthorized: false });
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error('Connection timed out'), { code: connected ? 'VOICECORD_TLS_TIMEOUT' : 'ETIMEDOUT' })), timeout);
    socket.once('connect', () => { connected = true; });
    socket.once('close', () => clearTimeout(timer));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      try {
        const actual = new X509Certificate(socket.getPeerCertificate().raw).fingerprint256.replace(/:/g, '').toLowerCase();
        if (actual !== room.fingerprint) throw Object.assign(new Error('Certificate pin mismatch'), { code: 'VOICECORD_CERTIFICATE_PIN' });
        socket.destroy(); resolve();
      } catch (error) { socket.destroy(); reject(error); }
    });
  });
}

function connectionError(error) {
  if (error.code === 'VOICECORD_CERTIFICATE_PIN') return 'Приглашение устарело или относится к другой комнате: сертификат не совпадает. Скопируйте новое приглашение из работающей комнаты. После каждого пересоздания оно меняется.';
  if (error.code === 'ECONNREFUSED') return 'Сервер отклонил соединение: комната закрыта, порт неверный или подключение блокируется. Проверьте, что комната сейчас работает.';
  if (error.code === 'ETIMEDOUT' || error.name === 'TimeoutError') return 'Сервер не ответил. Если вы в одной сети с владельцем, используйте приглашение «Локальная сеть». Для подключения через интернет проверьте автопроброс и VPN на обеих сторонах. Доступ через публичный IP из своей сети может не поддерживаться роутером.';
  if (['ENETUNREACH', 'EHOSTUNREACH', 'EACCES', 'EPERM'].includes(error.code)) return 'Нет сетевого доступа к серверу. Проверьте подключение, VPN и правила брандмауэра.';
  if (error.code === 'VOICECORD_TLS_TIMEOUT' || String(error.code).includes('TLS') || String(error.code).includes('SSL')) return 'TCP-соединение установлено, но защищённое соединение TLS не удалось. Проверьте порт комнаты, VPN и сетевые фильтры.';
  return 'Не удалось подключиться к серверу. Проверьте, что комната работает и приглашение скопировано после её последнего запуска.';
}
module.exports = { localInvitation, verifyInvitation, connectionError };
