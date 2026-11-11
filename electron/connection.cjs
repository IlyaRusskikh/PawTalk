const { t } = require('../shared/i18n.cjs');
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
  return serverCertificate(address, undefined, timeout);
}

async function serverCertificate(address, knownPin, timeout = 5000) {
  const room = invitation(address);
  const target = new URL(serverURL(address, true));
  if (target.protocol !== 'https:') return;
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const expected = room?.fingerprint ?? knownPin;
  return await new Promise((resolve, reject) => {
    let connected = false;
    const socket = tls.connect({ host: hostname, port: Number(target.port || 443), servername: require('node:net').isIP(hostname) ? undefined : hostname, rejectUnauthorized: !expected });
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error('Connection timed out'), { code: connected ? 'PAWTALK_TLS_TIMEOUT' : 'ETIMEDOUT' })), timeout);
    socket.once('connect', () => { connected = true; });
    socket.once('close', () => clearTimeout(timer));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      try {
        const actual = new X509Certificate(socket.getPeerCertificate().raw).fingerprint256.replace(/:/g, '').toLowerCase();
        if (expected && actual !== expected) throw Object.assign(new Error('Certificate pin mismatch'), { code: 'PAWTALK_CERTIFICATE_PIN' });
        socket.destroy(); resolve(actual);
      } catch (error) { socket.destroy(); reject(error); }
    });
  });
}

function connectionError(error) {
  if (error.code === 'PAWTALK_MEDIA_ADDRESS') return t("Неверный адрес голосового сервера");
  if (error.code === 'PAWTALK_PROTOCOL') return t("Версия API сервера не поддерживается. Обновите клиент или обратитесь к владельцу сервера.");
  // Node/Electron fetch wraps DNS and TCP failures in a TypeError with a cause.
  if (error?.cause?.code && !error.code) error = error.cause;
  if (['ENOTFOUND', 'EAI_AGAIN', 'ERR_NAME_NOT_RESOLVED'].includes(error.code)) return t("Не удалось найти сервер по имени. Проверьте адрес, подключение к интернету и DNS. Попросите владельца прислать актуальное приглашение.");
  if (error.code === 'PAWTALK_CERTIFICATE_PIN') return t("Приглашение устарело или относится к другой комнате: сертификат не совпадает. Скопируйте новое приглашение из работающей комнаты. После каждого пересоздания оно меняется.");
  if (error.code === 'ECONNREFUSED') return t("Сервер отклонил соединение: комната закрыта, порт неверный или подключение блокируется. Проверьте, что комната сейчас работает.");
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.code) || error.name === 'TimeoutError') return t("Сервер не ответил. В одной сети с владельцем используйте LAN-приглашение. Через интернет проверьте проброс TCP-порта комнаты, TCP-порта +1 и UDP-порта +2, брандмауэр и VPN. При CGNAT может понадобиться VPS с публичным IP. Доступ через публичный IP из своей сети может не поддерживаться роутером.");
  if (['ENETUNREACH', 'EHOSTUNREACH', 'EACCES', 'EPERM'].includes(error.code)) return t("Нет сетевого доступа к серверу. Проверьте подключение, VPN и правила брандмауэра.");
  if (error.code === 'PAWTALK_TLS_TIMEOUT' || String(error.code).includes('TLS') || String(error.code).includes('SSL')) return t("TCP-соединение установлено, но защищённое соединение TLS не удалось. Проверьте порт комнаты, VPN и сетевые фильтры.");
  return t("Не удалось подключиться к серверу. Проверьте, что комната работает и приглашение скопировано после её последнего запуска.");
}
module.exports = { localInvitation, verifyInvitation, serverCertificate, connectionError };
