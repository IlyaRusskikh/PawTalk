// Component release contract. Published legacy releases remain immutable.
const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
function parseVersion(value) {
  if (typeof value !== 'string' || value.trim() !== value) return null;
  const match = pattern.exec(value);
  if (!match || match.slice(1, 4).some(n => !Number.isSafeInteger(Number(n)))) return null;
  return { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') };
}
function compare(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw Error('Invalid version');
  for (let i = 0; i < 3; i++) if (x.numbers[i] !== y.numbers[i]) return Math.sign(x.numbers[i] - y.numbers[i]);
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i], r = y.pre[i];
    if (l === r) continue;
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    if (ln && rn) return l.length === r.length ? (l < r ? -1 : 1) : Math.sign(l.length - r.length);
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}
function parseTag(tag, legacy = false) {
  if (typeof tag !== 'string' || tag.trim() !== tag) return null;
  const m = /^(client|server|manager)-v(.+)$/.exec(tag);
  if (m && parseVersion(m[2])) return { component: m[1], version: m[2] };
  if (legacy && tag.startsWith('v') && parseVersion(tag.slice(1)) && compare(tag.slice(1), '0.8.1') <= 0) return { component: 'client', version: tag.slice(1), legacy: true };
  return null;
}
function releasePlan(tag, versions) {
  const parsed = parseTag(tag, tag === 'v0.8.1');
  if (!parsed || versions[parsed.component] !== parsed.version) throw Error('Release tag/version mismatch');
  return { ...parsed, client: parsed.component === 'client', server: parsed.component === 'server', manager: parsed.component === 'manager' };
}
function channelFor(version, requested = 'preview') {
  if (!parseVersion(version) || !['stable', 'preview'].includes(requested)) throw Error('Invalid release channel');
  return version.includes('-') ? 'preview' : requested;
}
module.exports = { parseVersion, compare, parseTag, releasePlan, channelFor };
