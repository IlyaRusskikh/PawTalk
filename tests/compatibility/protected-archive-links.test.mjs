import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { sealArchiveLink, openArchiveLinks } from '../../apps/client/windows/electron/protected-archive-links.cjs';

const digest = links => createHash('sha256').update(JSON.stringify(links)).digest('hex');

test('archive links recover only authorized predecessors and live keys', () => {
  const previous = randomBytes(32);
  const live = randomBytes(32);
  const archivedLive = randomBytes(32);
  const head = randomBytes(32);
  const source = { serverId: 'a'.repeat(32), channelId: 'room', generation: 2, keyId: 'b'.repeat(64) };
  const previousTarget = { Purpose: 'archive', Generation: 1, KeyID: 'c'.repeat(64) };
  const liveTarget = { Purpose: 'live', Generation: 3, KeyID: 'd'.repeat(64) };
  const firstSource = { ...source, generation: 1, keyId: previousTarget.KeyID };
  const firstLinks = [sealArchiveLink(previous, firstSource, { Purpose: 'live', Generation: 1, KeyID: 'e'.repeat(64) }, archivedLive)];
  const links = [
    sealArchiveLink(head, source, previousTarget, previous),
    sealArchiveLink(head, source, liveTarget, live),
  ];
  const [recoveredPrevious, recoveredLive] = openArchiveLinks(head, source, links, digest(links));
  assert.deepEqual(recoveredPrevious.secret, previous);
  assert.deepEqual(recoveredLive.secret, live);
  assert.deepEqual(openArchiveLinks(recoveredPrevious.secret, firstSource, firstLinks, digest(firstLinks))[0].secret, archivedLive);
  assert.throws(() => openArchiveLinks(live, source, links, digest(links)));
  assert.throws(() => openArchiveLinks(previous, source, links, digest(links)));
  assert.throws(() => openArchiveLinks(head, { ...source, channelId: 'other' }, links, digest(links)));
  assert.throws(() => openArchiveLinks(head, source, links.slice(1), digest(links)), /INVALID_ARCHIVE_LINKS/);
});
