// Public download discovery only; updater signature/trust contracts stay independent.
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const repository = 'IlyaRusskikh/PawTalk';
export const components = ['client', 'server', 'manager'];
// Use the existing component-tag grammar and SemVer comparator, including huge pre-release IDs.
import { createRequire } from 'node:module';
const { parseTag, compare } = createRequire(import.meta.url)('../shared/release.cjs');
export { parseTag };
export function requiredAssets(component, version) {
  return {
    client: [`PawTalk.Setup.${version}.exe`, `PawTalk.Licenses.${version}.zip`, 'SHA256SUMS.txt', 'update-manifest.json'],
    server: [`PawTalk.Server.${version}.windows-x64.zip`, 'server-manifest.json'],
    manager: [`PawTalk.Server.Manager.Setup.${version}.exe`, `PawTalk.Manager.${version}.tar.gz`, 'manager-manifest.json'],
  }[component];
}
export function selectReleases(releases) {
  if (!Array.isArray(releases)) throw Error('Invalid releases response');
  const catalog = { schema: 1, repository, components: {} };
  for (const component of components) {
    const candidates = releases.flatMap(release => {
      if (!release || typeof release !== 'object') return [];
      const parsed = parseTag(release.tag_name);
      if (!parsed || parsed.component !== component || release.draft !== false || typeof release.prerelease !== 'boolean' || !Number.isFinite(Date.parse(release.published_at)) || !Array.isArray(release.assets)) return [];
      const prefix = `https://github.com/${repository}/releases/download/${release.tag_name}/`;
      const assets = {};
      for (const name of requiredAssets(component, parsed.version)) {
        const matches = release.assets?.filter(asset => asset.name === name) ?? [];
        if (matches.length !== 1) return [];
        const asset = matches[0];
        if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.browser_download_url?.toLowerCase() !== (prefix + name).toLowerCase()) return [];
        assets[name] = asset.browser_download_url;
      }
      return [{ parsed, tag: release.tag_name, version: parsed.version,
        channel: release.prerelease || parsed.version.includes('-') ? 'preview' : 'stable',
        url: `https://github.com/${repository}/releases/tag/${release.tag_name}`, assets }];
    }).sort((a, b) => compare(b.version, a.version) || a.tag.localeCompare(b.tag));
    const publicEntry = entry => entry ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'parsed')) : null;
    if (!candidates.length) throw Error(`No complete published ${component} release`);
    catalog.components[component] = { latest: publicEntry(candidates[0]),
      stable: publicEntry(candidates.find(entry => entry.channel === 'stable')),
      preview: publicEntry(candidates.find(entry => entry.channel === 'preview')) };
  }
  return catalog;
}
export async function fetchReleases({ fetchImpl = fetch, token = process.env.GH_TOKEN } = {}) {
  const releases = [];
  for (let page = 1; page <= 100; page++) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error(`GitHub releases API: HTTP ${response.status}`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw Error('Invalid releases response');
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  throw Error('Release pagination limit exceeded');
}
export async function generateCatalog(directory, options) {
  // No fallback to source versions, guessed URLs or partial API data. Existing Pages stays live on failure.
  const catalog = selectReleases(await fetchReleases(options));
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, 'releases.json');
  await writeFile(target + '.tmp', JSON.stringify(catalog, null, 2) + '\n');
  await rename(target + '.tmp', target);
  return catalog;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateCatalog(path.resolve(process.argv[2] ?? 'website'));
  console.log('Prepared complete public release catalog; no Git changes or publication.');
}
