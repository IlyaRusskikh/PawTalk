const { t } = require('../shared/i18n.cjs');
const { isIP } = require('node:net');
function invitation(address) {
  if (typeof address !== 'string' || !address.trim().startsWith('voicecord://')) return null;
  const url = new URL(address.trim());
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const params = new URLSearchParams(url.hash.slice(1));
  if (!isIP(hostname) || !url.port || url.username || url.password || url.search || !/^\/[a-f0-9]{64}$/.test(url.pathname) || (url.hash && !params.size)) throw new Error(t("Неверное приглашение в комнату"));
  for (const key of params.keys()) if (!['password', 'name', 'e2ee'].includes(key) || params.getAll(key).length !== 1) throw new Error(t("Неверное приглашение в комнату"));
  const e2eeKey = params.get('e2ee');
  if (e2eeKey !== null && !/^[a-f0-9]{64}$/.test(e2eeKey)) throw new Error(t("Неверный ключ E2EE"));
  const password = params.get('password');
  if (password !== null && Buffer.byteLength(password) > 1024) throw new Error(t("Неверный пароль приглашения"));
  return { password, e2eeKey, origin: `https://${url.host}`, fingerprint: url.pathname.slice(1), hostname };
}
function serverURL(address, development = false) {
  if (typeof address !== 'string' || address.length > 14000) throw new Error(t("Укажите IP сервера"));
  const room = invitation(address);
  if (room) return room.origin;
  const input = address.trim();
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const domain = hostname.length <= 253 && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname);
  const dev = development && hostname === '127.0.0.1' && url.protocol === 'http:';
  if ((!isIP(hostname) && !domain) || (!dev && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(t("Введите IP или доменное имя сервера, при необходимости с портом. Требуется HTTPS."));
  }
  return url.origin;
}
module.exports = { serverURL, invitation };
