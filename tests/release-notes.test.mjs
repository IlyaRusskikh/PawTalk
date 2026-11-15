import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkNotes, notesDigest, verifyReleaseNotes } from '../scripts/check-release-notes.mjs';

const tag = 'client-v0.12.1';
const text = await readFile(new URL(`../docs/releases/${tag}.md`,import.meta.url),'utf8');
test('publication-independent bilingual notes preserve previous failed tag history', () => {
  assert.deepEqual(checkNotes(text,{tag,channel:'preview'}),[]);
  assert.deepEqual(checkNotes(text+'\nThe client-v0.12.0 tag failed verification before publication.\n',{tag}),[]);
  assert.deepEqual(checkNotes(text+'\nReinstallation waits for pending SCM deletion.\n',{tag}),[]);
  assert.equal(notesDigest(text),notesDigest(text.replaceAll('\n','\r\n')));
});

test('temporary RU/EN publication and CI statuses fail with line diagnostics', () => {
  for (const phrase of [
    'Not yet published.', 'Publication pending.', 'Verification pending.', 'Tag CI pending.',
    'Prepared notes; publication and tag verification are pending.',
    'Successful tag CI will be recorded only after it completes.',
    'Tag CI success is not claimed before it runs.', 'No successful tag CI is claimed yet.',
    'Ожидает публикации.', 'CI ещё не пройден.', 'Проверки будут выполнены.',
    'Описание подготовлено, релиз ещё не опубликован.',
    'Описание подготовлено; публикация и проверка тега ещё не выполнены.',
  ]) assert.ok(checkNotes(text+'\n'+phrase,{tag}).some(e=>/line.*temporary/.test(e)),phrase);
});

test('missing sections, wrong identity/channel and mutable or obsolete links are rejected', () => {
  for (const bad of [
    text.replace('PawTalk Client 0.12.1','PawTalk Server 0.12.1'),
    text.replace('## English','## Translation'),
    text.replace('### Установка и обновление','### Другое'),
    text.replace('### Install or update','### Other'),
    text.replaceAll('Limitations','Constraints'),
    text.replaceAll('releases/download/client-v0.12.1/','releases/latest/'),
    text.replaceAll('PawTalk.Setup.0.12.1.exe','PawTalk.Setup.0.12.0.exe'),
    text+'\n[Tag CI](https://github.com/IlyaRusskikh/PawTalk/actions/workflows/client.yml)\n',
  ]) assert.ok(checkNotes(bad,{tag}).length);
  assert.ok(checkNotes(text,{tag,channel:'stable'}).length);
  assert.ok(checkNotes('# PawTalk Client 0.12.1 — Placeholder\n',{tag}).length);
});

test('only exact historical failed drafts are exempt, never selected release candidates', async () => {
  for (const oldTag of ['client-v0.12.0','server-v0.11.0','manager-v0.5.0']) {
    const old = await readFile(new URL(`../docs/releases/${oldTag}.md`,import.meta.url),'utf8');
    assert.deepEqual(checkNotes(old,{tag:oldTag,historical:true}),[]);
    assert.ok(checkNotes(old+'\nModified\n',{tag:oldTag,historical:true}).length);
    assert.ok(checkNotes(old,{tag:oldTag}).length);
  }
});

test('CLI rejects selected invalid notes with filename/reason and a nonzero exit status', () => {
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/check-release-notes.mjs',import.meta.url)),'client-v0.12.0'],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,1);
  assert.match(result.stderr,/client-v0\.12\.0\.md: line \d+: temporary publication\/CI status/);
});

test('remote verification checks exact full body, links, title, tag, channel and draft state', () => {
  const plan={tag,channel:'preview'};
  const release={tag_name:tag,name:text.split(/\r?\n/)[0].slice(2),body:text,draft:false,prerelease:true};
  verifyReleaseNotes(release,text,plan);
  for (const patch of [
    {name:'PawTalk Server 0.12.1'}, {tag_name:'client-v0.12.0'}, {prerelease:false}, {draft:true},
    {body:text.slice(0,-20)}, {body:text.replace('releases/download/','releases/latest/')},
  ]) assert.throws(()=>verifyReleaseNotes({...release,...patch},text,plan),/approved notes/);
});
