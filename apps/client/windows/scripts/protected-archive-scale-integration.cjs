const assert = require('node:assert/strict');
const { createHash, createPrivateKey, sign } = require('node:crypto');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { MembershipClient } = require('../electron/membership-client.cjs');
const { createPinnedFixtureFetch } = require('./protected-fixture-fetch.cjs');
const { packageContext } = require('../electron/protected-archive-session.cjs');
const { sealArchiveLink } = require('../electron/protected-archive-links.cjs');
const { archiveRevisionPublicKey, epochSignatureFrame, packagesDigest, sealEpochPackage } = require('../electron/protected-epoch-packages.cjs');
const { sealProtectedText } = require('../electron/protected-live-text.cjs');

const data = JSON.parse(readFileSync(0, 'utf8'));
const { policyTrust, channelId, generations, owner } = data;
const digest = value => createHash('sha256').update(value).digest('hex');
const seedSecret = (purpose, generation) => createHash('sha256').update(`archive stress fixture ${purpose} ${generation}`).digest();
const oldestText = 'Synthetic oldest retained archive message';
const additionalMessageGenerations = data.additionalMessageGenerations ?? [];
const historicalMessageGenerations = [1, ...additionalMessageGenerations];
const messageText = generation => generation === 1 ? oldestText : `Synthetic archive message at generation ${generation}`;

async function seedArchive() {
  const device = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 0x65)]),
    type: 'pkcs8', format: 'der' });
  const principal = { ProfileID: owner.profileId, DeviceID: owner.deviceId };
  let previousLive = '', previousArchive = '';
  const rows = [];
  function makeEpoch(purpose, generation, secret, previous, links = []) {
    const record = { ChannelID: channelId, Purpose: purpose, Generation: generation,
      Revision: 1, PolicyDigest: data.initialPolicyDigest, PreviousDigest: previous, KeyID: digest(secret),
      TaskID: `${purpose === 'live' ? 'a' : 'b'}${generation.toString(16).padStart(31, '0')}`, LeaseID: 'c'.repeat(32),
      ArchiveThrough: purpose === 'archive' ? generation : 0,
      ArchiveLinksDigest: purpose === 'archive' ? digest(JSON.stringify(links)) : '' };
    if (purpose === 'archive') record.ArchiveWrapKey = archiveRevisionPublicKey(policyTrust.serverId, record, secret);
    const pkg = { RecipientID: owner.deviceId, Purpose: purpose, Ciphertext: sealEpochPackage(secret,
      packageContext(policyTrust.serverId, record, owner.deviceId, owner.publicKey)).toString('base64') };
    record.PackagesDigest = packagesDigest([pkg]);
    record.Signature = sign(null, epochSignatureFrame(policyTrust.serverId, owner.profileId, owner.deviceId, record), device).toString('base64');
    rows.push(JSON.stringify({ proof: { Principal: principal, Record: record }, package: pkg, links }));
    return digest(Buffer.from(record.Signature, 'base64'));
  }
  for (const generation of historicalMessageGenerations) {
    const secret = seedSecret('live', generation);
    const packet = sealProtectedText(secret, policyTrust.serverId, principal, { ChannelID: channelId,
      OperationID: `4${generation.toString(16).padStart(31, '0')}`, KeyID: digest(secret) }, messageText(generation), device);
    secret.fill(0);
    process.stdout.write(`${JSON.stringify({ message: { generation, packet } })}\n`);
  }
  for (let generation = 1; generation <= generations; generation++) {
    const live = seedSecret('live', generation), archive = seedSecret('archive', generation);
    previousLive = makeEpoch('live', generation, live, previousLive);
    const source = { serverId: policyTrust.serverId, channelId, generation, keyId: digest(archive) };
    const links = [];
    if (generation > 1) {
      const previous = seedSecret('archive', generation - 1);
      links.push(sealArchiveLink(archive, source, { Purpose: 'archive', Generation: generation - 1, KeyID: digest(previous) }, previous));
      previous.fill(0);
    }
    links.push(sealArchiveLink(archive, source, { Purpose: 'live', Generation: generation, KeyID: digest(live) }, live));
    previousArchive = makeEpoch('archive', generation, archive, previousArchive, links);
    live.fill(0);
    archive.fill(0);
    if (generation % 64 === 0 && !process.stdout.write(`${rows.splice(0).join('\n')}\n`)) await once(process.stdout, 'drain');
  }
  if (rows.length) process.stdout.write(`${rows.join('\n')}\n`);
}

function credentials(root, device) {
  const values = new Map([['pawtalk:identity:v2', JSON.stringify({ root: root.repeat(32), device: device.repeat(32) })]]);
  return { load: async id => values.get(id), save: async (id, value) => { values.set(id, value); } };
}

async function measureArchive() {
  const pinnedFetch = createPinnedFixtureFetch(data.base, data.certificate);
  const verify = async address => {
    assert.equal(new URL(address).pathname, `/${data.fingerprint}`);
    return data.fingerprint;
  };
  const ownerStore = credentials('01', '65');
  await ownerStore.save(`pawtalk:agreement:v1:${policyTrust.serverId}:${owner.deviceId}`, '0b'.repeat(32));
  const writer = { historicalPackages: 0, historicalPackageBytes: 0, historicalLinksWritten: 0, historicalLinkBytes: 0,
    archiveReads: 0, epochProofRequests: 0, archivePackagesWritten: 0 };
  const host = new MembershipClient({ allowLoopback: true, credentials: ownerStore, fetcher: async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname.startsWith('/api/v3/keys/archive/')) writer.archiveReads++;
    if (pathname.startsWith('/api/v3/keys/proofs/')) writer.epochProofRequests++;
    if (pathname.endsWith('/archive/commit')) {
      const { Packages, Links } = JSON.parse(options.body);
      writer.archivePackagesWritten += Packages.length;
      for (const link of Links) {
        if (link.Generation > generations) continue;
        writer.historicalLinksWritten++;
        writer.historicalLinkBytes += Buffer.from(link.Ciphertext, 'base64').length;
      }
    }
    const response = await pinnedFetch(url, options);
    if (pathname.endsWith('/targets') && response.ok) {
      for (const delivery of await response.clone().json()) {
        if (delivery.Epoch.Record.Generation > generations) continue;
        writer.historicalPackages++;
        writer.historicalPackageBytes += Buffer.from(delivery.Package.Ciphertext, 'base64').length;
      }
    }
    return response;
  } });
  const reader = { archiveReads: 0, archiveWireBytes: 0, recoveredLinks: 0, encryptedLinkBytes: 0 };
  const resume = additionalMessageGenerations.length ? { failedReadCount: 0, resumedReadCount: 0, memorySamples: [] } : undefined;
  const sampledReads = new Set([0, 64, 1024, 4096, 8192, generations + 1]);
  const corruptAt = 2048;
  let phase = 'clean';
  let firstLink, damagedLink;
  const sampleMemory = archiveReads => {
    global.gc();
    const { heapUsed, rss } = process.memoryUsage();
    resume.memorySamples.push({ archiveReads, heapKiB: Math.round(heapUsed / 1024), rssKiB: Math.round(rss / 1024) });
  };
  const guestCredentials = credentials('03', '67');
  const createGuest = () => new MembershipClient({ allowLoopback: true, verify, trust: async () => {},
    credentials: guestCredentials, fetcher: async (url, options) => {
    const pathname = new URL(url).pathname;
    assert.notEqual(pathname, '/api/v3/policy/proofs');
    const response = await pinnedFetch(url, options);
    if (pathname.startsWith('/api/v3/keys/archive/') && response.ok) {
      const body = await response.clone().text();
      if (phase === 'corrupt') {
        firstLink ??= pathname;
        resume.failedReadCount++;
        if (resume.failedReadCount !== corruptAt) return response;
        damagedLink = pathname;
        const delivery = JSON.parse(body);
        const packet = Buffer.from(delivery.Links[0].Ciphertext, 'base64');
        packet[0] ^= 1;
        delivery.Links[0].Ciphertext = packet.toString('base64');
        return Response.json(delivery);
      }
      if (phase === 'resume') {
        if (++resume.resumedReadCount === 1) assert.equal(pathname, damagedLink, 'retry starts at the unverified response');
        return response;
      }
      reader.archiveReads++;
      reader.archiveWireBytes += Buffer.byteLength(body);
      const { Links } = JSON.parse(body);
      reader.recoveredLinks += Links.length;
      for (const link of Links) reader.encryptedLinkBytes += Buffer.from(link.Ciphertext, 'base64').length;
      if (resume && sampledReads.has(reader.archiveReads)) sampleMemory(reader.archiveReads);
    }
    return response;
  } });
  const guest = createGuest();

  const connection = { ...owner, base: data.base, fingerprint: data.fingerprint, serverId: policyTrust.serverId,
    cutoverDigest: policyTrust.cutoverDigest, policyTrust };
  const started = performance.now();
  const { link } = await host.createProtectedInvite(connection);
  await guest.redeemProtectedInvite(link, 'Synthetic full-history reader');
  const visitor = await guest.openStoredProtectedRuntime(policyTrust.serverId);
  await host.refreshProtectedRuntimePolicy(connection, policyTrust);
  await host.rotateProtectedRuntimeText(connection, channelId, 'live');
  const archive = await host.rotateProtectedRuntimeText(connection, channelId, 'archive');
  await host.syncProtectedPolicyAttestations(connection);
  const invitationMs = Math.round(performance.now() - started);
  assert.equal(archive.generation, generations + 1);
  assert.equal(writer.historicalPackages, 1, 'only the previous archive head is read');
  assert.equal(writer.historicalLinksWritten, 1, 'only the previous archive head is wrapped again');
  assert.equal(writer.historicalPackageBytes, 80);
  assert.equal(writer.historicalLinkBytes, 60);
  assert.equal(writer.archiveReads, 0);
  assert.equal(writer.archivePackagesWritten, 2, 'one new archive package per entitled device');
  assert.ok(writer.epochProofRequests <= 2);
  assert.equal(reader.archiveReads, 0, 'joining prepares access without traversing the archive');

  const verifyMessages = page => assert.deepEqual(page.messages.map(message => message.text), historicalMessageGenerations.map(messageText));
  if (resume) {
    phase = 'corrupt';
    await assert.rejects(guest.readProtectedChatPage(visitor, channelId, 0), error => {
      assert.equal(error.message, 'INVALID_ARCHIVE_LINKS');
      resume.diagnosis = error.message;
      return true;
    });
    assert.equal(resume.failedReadCount, corruptAt);
    assert.ok(damagedLink && damagedLink !== firstLink);
    phase = 'resume';
    verifyMessages(await guest.readProtectedChatPage(visitor, channelId, 0));
    assert.equal(resume.resumedReadCount, generations + 2 - corruptAt, 'retry reads exactly the remaining chain');
    phase = 'clean';
    sampleMemory(0);
  }
  const reading = performance.now();
  verifyMessages(await (resume ? createGuest() : guest).readProtectedChatPage(visitor, channelId, 0));
  assert.equal(reader.archiveReads, generations + 1);
  assert.equal(reader.recoveredLinks, 2 * generations + 1);
  const historicalReadMs = Math.round(performance.now() - reading);
  if (resume) {
    resume.verifiedPrefixLinks = corruptAt - 1;
    resume.messageGenerations = historicalMessageGenerations;
    global.gc();
    resume.afterCompletionHeapKiB = Math.round(process.memoryUsage().heapUsed / 1024);
  }
  console.log(JSON.stringify({ generations, writer, reader, invitationMs, historicalReadMs, ...(resume && { resume }) }));
}

(process.argv[2] === 'seed' ? seedArchive() : measureArchive()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
