const { t } = require('../../../../shared/i18n.cjs');
const { isIP } = require('node:net');
const isDomain = hostname => /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname);
const protectedInviteFields = { v: /^3$/, server: /^[a-f0-9]{32}$/, invite: /^[a-f0-9]{32}$/,
  token: /^[A-Za-z0-9_-]{43}$/, cutover: /^[a-f0-9]{64}$/, anchor: /^[a-f0-9]{64}$/,
  owner: /^[a-f0-9]{64}$/, ownerDevice: /^[a-f0-9]{64}$/ };
function invitation(address) {
  if (typeof address !== 'string' || !address.trim().startsWith('pawtalk://')) return null;
  const url = new URL(address.trim());
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const params = new URLSearchParams(url.hash.slice(1));
  const invalid = () => new Error(t("Неверное приглашение в комнату"));
  const v2 = params.get('v') === '2';
  const v3 = params.get('v') === '3';
  const pinPath = /^\/([a-f0-9]{64})(\/v3)?$/.exec(url.pathname);
  const protectedAddress = Boolean(pinPath?.[2]) && (v3 || !url.hash);
  if (!pinPath || (pinPath[2] && !protectedAddress) || (!isIP(hostname) && !(protectedAddress && isDomain(hostname))) ||
      !url.port || url.username || url.password || url.search || (url.hash && !params.size)) throw invalid();
  const fingerprint = pinPath[1];
  if (v3) {
    if (params.get('setup') === '1') {
      if (!protectedAddress || params.size !== 4 || new Set(params.keys()).size !== 4 ||
          !/^[a-f0-9]{32}$/.test(params.get('server') ?? '') || !/^[a-f0-9]{64}$/.test(params.get('token') ?? '')) throw invalid();
      return { password: null, e2eeKey: null, origin: `https://${url.host}`, fingerprint, hostname };
    }
    if (params.size !== Object.keys(protectedInviteFields).length ||
        Object.entries(protectedInviteFields).some(([key, pattern]) => !pattern.test(params.get(key) ?? ''))) throw invalid();
    const token = params.get('token');
    if (Buffer.from(token, 'base64url').toString('base64url') !== token) throw invalid();
    return { password: null, e2eeKey: null, origin: `https://${url.host}`, fingerprint, hostname,
      protectedInvite: {
        inviteId: params.get('invite'), seed: token, trust: { serverId: params.get('server'), cutoverDigest: params.get('cutover'),
          anchorDigest: params.get('anchor'), ownerProfileId: params.get('owner'), ownerDeviceId: params.get('ownerDevice') },
      } };
  }
  const allowed = v2 ? ['v','server','invite','token','open','package','setup','link','target','targetDevice','targetKey','targetRevision','signer'] : ['password','name','e2ee'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new Error(t("Неверное приглашение в комнату"));
  if (v2 && (!/^[a-f0-9]{32}$/.test(params.get('server') || '') || !/^[\w-]{43}$/.test(params.get('token') || '') || !/^[a-f0-9]{32}$/.test(params.get('invite') || params.get('link') || ''))) throw new Error(t("Неверное приглашение в комнату"));
  const e2eeKey = params.get('e2ee');
  if (e2eeKey !== null && !/^[a-f0-9]{64}$/.test(e2eeKey)) throw new Error(t("Неверный ключ E2EE"));
  const password = params.get('password');
  if (password !== null && Buffer.byteLength(password) > 1024) throw new Error(t("Неверный пароль приглашения"));
  return { password, e2eeKey, origin: `https://${url.host}`, fingerprint, hostname };
}
function serverURL(address, development = false) {
  if (typeof address !== 'string' || address.length > 14000) throw new Error(t("Укажите IP сервера"));
  const room = invitation(address);
  if (room) return room.origin;
  const input = address.trim();
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const domain = isDomain(hostname);
  const dev = development && hostname === '127.0.0.1' && url.protocol === 'http:';
  if ((!isIP(hostname) && !domain) || (!dev && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(t("Введите IP или доменное имя сервера, при необходимости с портом. Требуется HTTPS."));
  }
  return url.origin;
}
module.exports = { serverURL, invitation };
