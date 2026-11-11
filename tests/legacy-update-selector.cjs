// Frozen selector from PawTalk v0.8.0 (AGPL-3.0-only), regression fixture.
const REPOSITORY = 'IlyaRusskikh/PawTalk';
const MAX_SIZE = 1024 * 1024 * 1024;
function version(value) {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  return m ? { numbers: m.slice(1, 4).map(Number), pre: m[4]?.split('.') } : null;
}
function compare(a, b) {
  const x = version(a), y = version(b);
  if (!x || !y) throw new Error('Invalid version');
  for (let i = 0; i < 3; i++) if (x.numbers[i] !== y.numbers[i]) return Math.sign(x.numbers[i] - y.numbers[i]);
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i], r = y.pre[i];
    if (l === r) continue;
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    if (ln && rn) return Math.sign(Number(l) - Number(r));
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}
function selectRelease(releases, current) {
  return releases.filter(r => !r.draft && version(r.tag_name || '') && compare(r.tag_name, current) > 0)
    .sort((a, b) => compare(b.tag_name, a.tag_name)).flatMap(r => {
      const v = r.tag_name.replace(/^v/, '');
      const asset = r.assets?.find(a => [ `PawTalk Setup ${v}.exe`, `PawTalk.Setup.${v}.exe` ].includes(a.name)
        && a.state === 'uploaded' && Number.isSafeInteger(a.size) && a.size > 0 && a.size <= MAX_SIZE
        && /^sha256:[a-f0-9]{64}$/i.test(a.digest || '')
        && validAssetURL(a.browser_download_url, r.tag_name));
      return asset ? [{ version: v, prerelease: !!r.prerelease, asset }] : [];
    })[0] || null;
}
function validAssetURL(value, tag) {
  try {
    const u = new URL(value);
    const parts = u.pathname.split('/');
    return u.protocol === 'https:' && u.hostname === 'github.com' && !u.port && !u.username && !u.password && !u.search && !u.hash
      // GitHub owner/repository names are case-insensitive; tags and asset paths
      // remain case-sensitive. Do not normalize the entire download path.
      && parts.slice(1, 3).join('/').toLowerCase() === REPOSITORY.toLowerCase()
      && parts.slice(3).join('/').startsWith(`releases/download/${encodeURIComponent(tag)}/`);
  } catch { return false; }
}
module.exports = { selectRelease };
