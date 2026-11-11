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
  assert.match(html, /rel="canonical" href="https:\/\/ilyarusskikh.github.io\/PawTalk\/(?:ru\/)?"/, `${file}: expected Pages URL`);
  for (const locale of ['en', 'ru', 'x-default']) assert.ok(html.includes(`hreflang="${locale}"`), `${file}: ${locale} alternate`);
  assert.match(html, /releases\/download\/(?:client-)?v(\d+\.\d+\.\d+)\/PawTalk\.Setup\.\1\.exe/, `${file}: Client installer URL`);
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
for (const image of files.filter(file => file.endsWith('.png'))) {
  const png = await readFile(image);
  assert.ok(png.length < 2 * 1024 * 1024, `${image}: keep screenshots small`);
  assert.equal(png.readUInt32BE(16), 1240, `${image}: screenshot width`);
}
console.log(`PASS website: ${files.filter(file => file.endsWith('.html')).length} pages, ${links} local links/assets, language metadata and screenshots.`);
