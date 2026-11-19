import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const normalizeNotes = text => text.replaceAll('\r\n', '\n');
export const notesDigest = text => createHash('sha256').update(normalizeNotes(text)).digest('hex');
// Locale views share the tag's stem, including for SemVer prereleases.
export const isCanonicalNotesFile = name => !/\.(?:en|ru)\.md$/.test(name)
  && /^(?:client|server|manager)-v\d+\.\d+\.\d+(?:-[\w.-]+)?\.md$/.test(name);
// Frozen failed-release drafts, retained as history. Never exempt a release candidate.
const historicalDrafts = {
  'client-v0.12.0': '01776e6272b22cb3eeb8d84761e73164418a53e6d26551d6ef18ea6204af23a6',
  'server-v0.11.0': '517b6aa1ca85d4c16bbd2bc48b8cc36c08e7b56760f6ebeec2c35d68cf630fff',
  'manager-v0.5.0': '2588f49cd71e7e3d9b8d80f053e713081fe9c031b14d0966fb211632c388d386',
};
const temporary = [
  /\b(?:not yet|yet to be)\s+(?:published|verified|tested)\b/i,
  /\b(?:publication|verification|tag\s+CI|CI|checks?|tests?)\b[^.!?\n]{0,70}\b(?:pending|will be|not (?:yet )?(?:run|complete|passed)|have not|has not)\b/i,
  /\b(?:awaiting|pending)\s+(?:publication|verification|CI|checks?|tests?)\b/i,
  /\b(?:CI|tag verification|checks?|tests?)\b[^.!?\n]{0,60}\b(?:before (?:it|they) runs?|after (?:it|they) completes?|not claimed|claimed yet)\b/i,
  /(?:публикаци[яию]|провер[а-яё]*|\bCI\b)[^.!?\n]{0,75}(?:ещ[её] не|не (?:выполн|прой|заверш)|буд(?:ет|ут) (?:выполн|проведен|проведён)|ожида[ею])/iu,
  /(?:ожидает|ожидание|ожидается)\s+(?:публикаци|провер|CI)/iu,
  /описание подготовлено[^.!?\n]*(?:публикаци|релиз|CI)/iu,
  /(?:релиз|выпуск|тег)[^.!?\n]{0,40}ещ[её] не (?:опубликован|проверен)/iu,
];

export function checkNotes(text, {tag, channel, historical = false} = {}) {
  text = normalizeNotes(text);
  const errors = [];
  const match = /^(client|server|manager)-v(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.exec(tag ?? '');
  if (!match) return ['invalid component release tag'];
  const [, component, version] = match;
  if (historical && historicalDrafts[tag] === notesDigest(text)) return [];
  const title = text.split('\n')[0];
  const expectedTitle = `# PawTalk ${component[0].toUpperCase()+component.slice(1)} ${version} — `;
  if (!title.startsWith(expectedTitle) || title.slice(expectedTitle.length).trim().length < 8) errors.push('title must name component, version and release theme');
  for (const [index, line] of text.split('\n').entries()) {
    if (temporary.some(pattern => pattern.test(line))) errors.push(`line ${index+1}: temporary publication/CI status`);
    if (/tag\s*(?:CI|workflow|verification)/i.test(line) && /actions\/workflows\//i.test(line)) errors.push(`line ${index+1}: obsolete tag CI workflow link; use a confirmed Actions run`);
  }
  const intro = text.split(/^## /m)[0];
  if (!/\b(?:preview|stable)\b/i.test(intro)) errors.push('missing preview/stable channel in introduction');
  if (channel && !new RegExp(`\\b${channel}\\b`, 'i').test(intro)) errors.push('introduction channel differs from candidate');
  if (!/Windows|Linux/i.test(intro)) errors.push('missing supported platforms in introduction');
  for (const language of ['Русский', 'English']) {
    const section = text.split(`## ${language}\n`)[1]?.split(/^## /m)[0] ?? '';
    if (section.trim().length < 100) errors.push(`missing meaningful ${language} description`);
    const change = language === 'Русский' ? /### (?:Добавлено|Исправлено|Изменено)\n\s+\S/ : /### (?:Added|Fixed|Changed)\n\s+\S/;
    const install = language === 'Русский' ? /### Установка и обновление\n\s+\S/ : /### (?:Install or update|Installation and upgrade)\n\s+\S/;
    if (!change.test(section)) errors.push(`missing ${language} changes`);
    if (!install.test(section)) errors.push(`missing ${language} installation/upgrade instructions`);
  }
  if (!/^#{2,3} .*Ограничения/m.test(text) || !/^#{2,3} .*Limitations/m.test(text)) errors.push('missing bilingual limitations section');
  const base = 'https://github.com/IlyaRusskikh/PawTalk/';
  const download = component === 'client' ? `PawTalk.Setup.${version}.exe` : component === 'server' ? `PawTalk.Server.${version}.windows-x64.zip` : `PawTalk.Server.Manager.Setup.${version}.exe`;
  if (!text.includes(`${base}releases/download/${tag}/${download}`)) errors.push('missing correct component/version download link pinned to tag');
  if (!text.includes(`${base}tree/${tag}`) || !text.includes('AGPL-3.0-only')) errors.push('missing tagged source link and license identification');
  for (const url of text.match(/https?:\/\/[^\s)]+/g) ?? []) {
    if (url.includes('/releases/latest') || /\/(?:blob|tree)\/(?:main|master)(?:\/|$)/.test(url)) errors.push('release links must use immutable tags, not latest/main');
    const asset = url.split('/').at(-1);
    if (url.startsWith(`${base}releases/download/${tag}/`) && asset.startsWith('PawTalk.') && !asset.includes(`.${version}.`)) errors.push('download filename version mismatch');
  }
  return errors;
}

export function assertNotes(text, options) {
  const errors = checkNotes(text, options);
  if (errors.length) throw Error(`Release notes ${options.tag}: ${errors.join('; ')}`);
  return text.split(/\r?\n/)[0].replace(/^# /, '');
}

// Exact normalized body equality checks every link as well as the full bilingual text.
export function verifyReleaseNotes(release, text, plan, draft = false) {
  const title = assertNotes(text, plan);
  if (!release || release.tag_name !== plan.tag || release.name !== title ||
      release.draft !== draft || release.prerelease !== (plan.channel === 'preview') ||
      normalizeNotes(release.body ?? '') !== normalizeNotes(text)) throw Error('Release title/tag/channel/body differs from approved notes');
}

async function main() {
  const args = process.argv.slice(2);
  const published = args[0] === '--published';
  const tags = published ? args.slice(1) : args;
  if (published && !tags.length) throw Error('Supply published release tags');
  const directory = path.resolve(import.meta.dirname, '../../releases');
  const files = tags.length ? tags.map(tag => `${tag}.md`) : (await readdir(directory)).filter(isCanonicalNotesFile);
  let failures = 0;
  for (const file of files) {
    const tag = path.basename(file, '.md');
    if (file !== `${tag}.md`) throw Error('Expected release tag, not path');
    const text = await readFile(path.join(directory, file), 'utf8');
    const errors = checkNotes(text, {tag, historical: !tags.length});
    for (const error of errors) { console.error(`${file}: ${error}`); failures++; }
    if (published && !errors.length) {
      const release = JSON.parse(execFileSync('gh',['api',`repos/IlyaRusskikh/PawTalk/releases/tags/${tag}`],{encoding:'utf8',windowsHide:true}));
      const channel = /\bpreview\b/i.test(text.split(/^## /m)[0]) ? 'preview' : 'stable';
      verifyReleaseNotes(release,text,{tag,channel});
    }
  }
  if (failures) process.exitCode = 1;
  else console.log(`PASS release notes: ${files.length} files${tags.length ? '' : '; 3 frozen failed-release drafts retained'}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
