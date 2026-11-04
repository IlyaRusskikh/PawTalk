// Preserve runtime notices when Vite bundles frontend dependencies.
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const parts = ['Runtime dependency licenses and notices\nGenerated from package-lock.json by scripts/prepare-licenses.mjs.\n'];
for (const [dir, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  if (!dir || entry.dev || entry.devOptional) continue;
  const folder = path.join(root, dir);
  const pkg = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
  if (pkg.version !== entry.version) throw new Error(`Run npm ci: ${dir} differs from lockfile`);
  parts.push(`\n${'='.repeat(72)}\n${pkg.name} ${entry.version}\nLicense: ${entry.license}\nSource: ${typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || pkg.homepage || 'See npm package'}\n`);
  const files = (await readdir(folder)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(name)).sort();
  for (const name of files) {
    if ((await stat(path.join(folder, name))).isFile()) parts.push(`\n--- ${name} ---\n${await readFile(path.join(folder, name), 'utf8')}`);
  }
  if (!files.length) {
    // Some upstream npm tarballs put their grant in README or omit its text.
    const readme = (await readdir(folder)).find(name => /^readme(?:\.md)?$/i.test(name));
    if (readme) parts.push(`\n--- Upstream ${readme} ---\n${await readFile(path.join(folder, readme), 'utf8')}`);
    const supplement = path.join(root, 'licenses', `${pkg.name.replaceAll('/', '__').replaceAll('@', '')}.txt`);
    try { parts.push(`\n--- Supplemental license ---\n${await readFile(supplement, 'utf8')}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; throw new Error(`Missing license supplement: ${pkg.name}`); }
  }
}
const output = parts.join('\n').replaceAll('\r\n', '\n').split('\n').map(line => line.trimEnd()).join('\n').trimEnd() + '\n';
await writeFile(path.join(root, 'licenses/npm-runtime.txt'), output);
console.log('Runtime dependency notices ready.');
