/** @param {URL} url */
export function isGifProviderPage(url) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'tenor.com' && /^\/[a-z]{2,3}(?:-[a-z0-9]{2,8})*\/(?:view|search)\//i.test(url.pathname)) return true;
  return ['tenor.com', 'giphy.com', 'klipy.com'].includes(host) && /^\/(?:view|gifs|search)\//.test(url.pathname);
}
