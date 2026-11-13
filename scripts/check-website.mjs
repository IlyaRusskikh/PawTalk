// Static-site guard: local assets/anchors, language metadata and a downloadable release.
// No dependencies, so it can run before a Pages deployment without npm install.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../website/', import.meta.url));
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : path.join(directory, entry.name)))).flat();
}
const files = await walk(root);
let links = 0;
for (const file of files.filter(file => file.endsWith('.html'))) {
  const html = await readFile(file, 'utf8');
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
  assert.ok(title?.includes('PawTalk'), `${file}: descriptive title`);
  assert.match(html, /<meta name="description" content="[^"]+">/, `${file}: description`);
  assert.match(html, /<html lang="(?:en|ru)">/, `${file}: page language`);
  assert.match(html, /rel="canonical" href="https:\/\/ilyarusskikh.github.io\/PawTalk\/(?:ru\/|downloads\/)?"/, `${file}: expected Pages URL`);
  for (const locale of ['en', 'ru', 'x-default']) assert.ok(html.includes(`hreflang="${locale}"`), `${file}: ${locale} alternate`);
  assert.match(html, /data-release="client"/, `${file}: catalog-backed Client download`);
  assert.match(html, /releases\.js/, `${file}: release catalog loader`);
  assert.doesNotMatch(html, /releases\/(?:latest|download\/)/, `${file}: no drifting hardcoded downloads`);
  for (const [, raw] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^(?:https?:|mailto:)/.test(raw)) continue;
    const [urlPath, anchor] = raw.split('#');
    let target = path.resolve(path.dirname(file), decodeURIComponent(urlPath || path.basename(file)));
    assert.ok(!path.relative(root, target).startsWith('..'), `Outside website: ${raw}`);
    if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html');
    await stat(target);
    if (anchor) assert.ok((await readFile(target, 'utf8')).includes(`id="${anchor}"`), `${file}: missing anchor ${raw}`);
    links++;
  }
}
const en = await readFile(path.join(root, 'index.html'), 'utf8');
const ru = await readFile(path.join(root, 'ru/index.html'), 'utf8');
const bindings = html => [...html.matchAll(/data-release="([^"]+)"(?: data-asset="([^"]+)")?/g)].map(match => match.slice(1).join(':')).sort();
assert.deepEqual(bindings(en), bindings(ru), 'English/Russian download catalog bindings agree');
if (process.argv.includes('--catalog')) {
  const { selectReleases, components } = await import('./release-catalog.mjs');
  const catalog = JSON.parse(await readFile(path.join(root, 'releases.json'), 'utf8'));
  const entries = components.flatMap(component => Object.values(catalog.components[component]).filter(Boolean));
  const reconstructed = entries.map(entry => ({ tag_name: entry.tag, draft: false, prerelease: entry.channel === 'preview', published_at: '2026-01-01T00:00:00Z',
    assets: Object.entries(entry.assets).map(([name, browser_download_url]) => ({ name, browser_download_url, state: 'uploaded', size: 1 })) }));
  // Dedupe latest/stable/preview entries; all generated entries must remain valid.
  const selected = selectReleases([...new Map(reconstructed.map(entry => [entry.tag_name, entry])).values()]);
  assert.deepEqual(selected, catalog, 'Prepared catalog satisfies selection and asset contracts');
}
for (const image of files.filter(file => file.endsWith('.png'))) {
  const png = await readFile(image);
  assert.ok(png.length < 2 * 1024 * 1024, `${image}: keep screenshots small`);
  assert.equal(png.readUInt32BE(16), 1240, `${image}: screenshot width`);
}
console.log(`PASS website: ${files.filter(file => file.endsWith('.html')).length} pages, ${links} local links/assets, language metadata and screenshots.`);
