// Published standalone servers advertise the configured public address, even
// when reached over LAN. Keep their /rtc proxy on the authenticated API origin
// rather than following an address supplied in a login response.
function mediaEndpoint(value, base, development = false) {
  const invalid = () => Object.assign(new Error('Invalid voice endpoint'), { code: 'PAWTALK_MEDIA_ADDRESS' });
  let media, api;
  try { media = new URL(value); api = new URL(base); } catch { throw invalid(); }
  if (!['wss:', ...(development ? ['ws:'] : [])].includes(media.protocol) || media.username || media.password || media.search || media.hash) throw invalid();
  if (media.hostname !== api.hostname) {
    if (media.pathname !== '/rtc') throw invalid();
    media = new URL('/rtc', api);
    media.protocol = api.protocol === 'https:' ? 'wss:' : 'ws:';
  }
  return media;
}
module.exports = { mediaEndpoint };
