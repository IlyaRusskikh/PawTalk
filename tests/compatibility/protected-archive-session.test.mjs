import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import archive from '../../apps/client/windows/electron/protected-archive-session.cjs';
import links from '../../apps/client/windows/electron/protected-archive-links.cjs';
import packages from '../../apps/client/windows/electron/protected-epoch-packages.cjs';

const { packageContext, readArchiveKey } = archive;
const { sealArchiveLink } = links;
const { epochSignatureFrame, packagesDigest, sealEpochPackage } = packages;
const hash = value => createHash('sha256').update(value).digest('hex');
const raw = key => key.export({ type: 'spki', format: 'der' }).subarray(-32);

function fixture() {
  const serverId = '1'.repeat(32), channelId = '2'.repeat(32), profileId = '3'.repeat(64);
  const signer = generateKeyPairSync('ed25519'), agreement = generateKeyPairSync('x25519');
  const signingKey = raw(signer.publicKey);
  const deviceId = hash(signingKey), publicKey = raw(agreement.publicKey).toString('hex');
  const pages = new Map(), epochs = new Map();
  const secret = (purpose, generation) => createHash('sha256').update(`${purpose}:${generation}`).digest();
  const target = generation => ({ generation, keyId: hash(secret('live', generation)) });
  const archiveId = generation => hash(secret('archive', generation));
  let head, headContext, previousDigest = '';
  for (let generation = 1; generation <= 5; generation++) {
    const record = { ChannelID: channelId, Purpose: 'archive', Generation: generation, Revision: 1, PolicyDigest: '4'.repeat(64),
      PreviousDigest: previousDigest, TaskID: generation.toString(16).padStart(32, '0'), LeaseID: '5'.repeat(32),
      ArchiveThrough: generation, KeyID: archiveId(generation) };
    const archiveSecret = secret('archive', generation);
    const context = packageContext(serverId, record, deviceId, publicKey);
    const wraps = [];
    if (generation > 1) wraps.push(sealArchiveLink(archiveSecret, context, {
      Purpose: 'archive', Generation: generation - 1, KeyID: archiveId(generation - 1),
    }, secret('archive', generation - 1)));
    wraps.push(sealArchiveLink(archiveSecret, context, { Purpose: 'live', Generation: generation, KeyID: target(generation).keyId },
      secret('live', generation)));
    record.ArchiveLinksDigest = hash(JSON.stringify(wraps));
    const pkg = { RecipientID: deviceId, Purpose: 'archive', Ciphertext: sealEpochPackage(archiveSecret, context).toString('base64') };
    record.PackagesDigest = packagesDigest([pkg]);
    const signature = sign(null, epochSignatureFrame(serverId, profileId, deviceId, record), signer.privateKey);
    record.Signature = signature.toString('base64');
    previousDigest = hash(signature);
    const epoch = { Principal: { ProfileID: profileId, DeviceID: deviceId }, Record: record };
    pages.set(record.KeyID, { Epoch: epoch, Links: wraps });
    epochs.set(generation, previousDigest);
    head = { Epoch: epoch, Package: pkg, Proof: { index: 0, count: 1, siblings: [] } };
    headContext = context;
  }
  const options = { serverId, channelId, head, headContext, privateKey: agreement.privateKey, acceptHead: async () => {},
    authorizeEpoch: async () => ({ profileId, deviceId, key: signingKey.toString('hex') }),
    fetchLinks: async (_channel, keyId) => pages.get(keyId) };
  return { options, pages, epochs, target, archiveId, secret };
}

test('an interrupted link resumes at the authenticated predecessor and reopens the current recipient package', async () => {
  const { options, pages, target, archiveId, secret } = fixture();
  const { keyId } = target(1);
  const input = { ...options, targetGeneration: 1, targetKeyId: keyId };
  let cursor;
  const visited = [];
  await assert.rejects(readArchiveKey({ ...input, onInterrupted: next => { cursor = next; },
    fetchLinks: async (_, key) => {
      visited.push(key);
      const page = structuredClone(pages.get(key));
      if (key === archiveId(3)) page.Links[0].Ciphertext = 'A'.repeat(80);
      return page;
    },
  }), error => error.message === 'INVALID_ARCHIVE_LINKS' && !Object.hasOwn(error, 'cursor'));
  assert.deepEqual(visited, [archiveId(5), archiveId(4), archiveId(3)]);
  assert.equal(cursor.context.keyId, archiveId(3));

  const poisoned = structuredClone(options.head);
  poisoned.Package.Ciphertext = 'A'.repeat(108);
  await assert.rejects(readArchiveKey({ ...input, head: poisoned, revalidateRecipient: true, cursor }));
  const result = await readArchiveKey({ ...input, revalidateRecipient: true, cursor,
    fetchLinks: async (_, key) => { visited.push(key); return pages.get(key); },
  });
  assert.deepEqual(visited.slice(3), [archiveId(3), archiveId(2), archiveId(1)]);
  assert.deepEqual(result.secret, secret('live', 1));
  cursor.secret.fill(0);
  result.secret.fill(0);
});

test('batch resolves distinct live generations in one pass across chunks', async () => {
  const { options, pages, target, archiveId, secret } = fixture();
  const visited = [];
  const input = { ...options, pageLimit: 2,
    fetchLinks: async (_, key) => { visited.push(key); return pages.get(key); } };
  const first = await readArchiveKey({ ...input, targets: [target(1), target(5), target(3)] });
  const second = await readArchiveKey({ ...input, targets: [target(1), target(3)], cursor: first.cursor });
  const last = await readArchiveKey({ ...input, targets: [target(1)], cursor: second.cursor });
  assert.equal(last.cursor, undefined);
  const keys = [...first.keys, ...second.keys, ...last.keys];
  assert.deepEqual(keys.map(({ generation }) => generation), [5, 3, 1]);
  assert.deepEqual(visited, [5, 4, 3, 2, 1].map(archiveId));
  for (const value of keys) {
    assert.deepEqual(value.secret, secret('live', value.generation));
    assert.equal(hash(value.secret), value.keyId);
    value.secret.fill(0);
  }
  first.cursor.secret.fill(0);
  second.cursor.secret.fill(0);
  await assert.rejects(readArchiveKey({ ...input, targets: [target(5), target(5)] }), { code: 'INVALID_ARCHIVE_REQUEST' });
});

test('batch leaves its resume cursor before any unreturned key and rejects target mismatch and authorization failure', async () => {
  const { options, pages, target, archiveId, epochs, secret } = fixture();
  const targets = [target(4), target(2)];
  let cursor;
  const onInterrupted = next => { cursor = next; };
  const input = { ...options, targets, onInterrupted };
  await assert.rejects(readArchiveKey({ ...input, fetchLinks: async (_, key) => {
    if (key === archiveId(3)) throw Object.assign(new Error('temporary failure'), { code: 'ECONNRESET' });
    return pages.get(key);
  } }), { code: 'ECONNRESET' });
  assert.equal(cursor.context.generation, 4);
  const result = await readArchiveKey({ ...input, cursor });
  assert.deepEqual(result.keys.map(value => value.generation), [4, 2]);
  for (const key of result.keys) key.secret.fill(0);
  cursor.secret.fill(0);
  cursor = undefined;

  await assert.rejects(readArchiveKey({ ...input, targets: [{ generation: 4, keyId: '8'.repeat(64) }] }),
    { code: 'ARCHIVE_KEY_MISMATCH' });
  await assert.rejects(readArchiveKey({ ...input, fetchLinks: async () => {
    throw Object.assign(new Error('denied'), { code: 'PROTECTED_ACCESS_DENIED' });
  } }), { code: 'PROTECTED_ACCESS_DENIED' });
  assert.equal(cursor, undefined);

  const single = { ...options, targetPurpose: 'archive', targetKeyId: archiveId(3), targetGeneration: 3 };
  await assert.rejects(readArchiveKey({ ...single, targetEpochDigest: epochs.get(4) }), { code: 'ARCHIVE_CHAIN_CONFLICT' });
  const historical = await readArchiveKey({ ...single, targetEpochDigest: epochs.get(3) });
  assert.deepEqual(historical.secret, secret('archive', 3));
  historical.secret.fill(0);
});
