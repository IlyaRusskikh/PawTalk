const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash, createPrivateKey, createPublicKey, sign } = require('node:crypto');
const { MembershipClient } = require('../electron/membership-client.cjs');
const { createPinnedFixtureFetch } = require('./protected-fixture-fetch.cjs');
const { epochSignatureFrame, openSignedEpochPackage, sealEpochPackage, packagesDigest } = require('../electron/protected-epoch-packages.cjs');
const { openArchiveLinks } = require('../electron/protected-archive-links.cjs');
const { packageContext } = require('../electron/protected-archive-session.cjs');
const { verifyTextRecipientDisclosure, channelSettingsProjectionVersion } = require('../electron/protected-channel-policy-commitments.cjs');
const { verifyRevisionAudience } = require('../electron/protected-revision-audience.cjs');
const { sealProtectedRevision, openProtectedRevisionForDevice, openProtectedRevisionForArchive } = require('../electron/protected-text-revision.cjs');

const data = JSON.parse(readFileSync(0, 'utf8'));
const pinnedFetch = createPinnedFixtureFetch(data.base, data.certificate);
const digest = value => createHash('sha256').update(value).digest('hex');
const credentials = (root, device, member, agreement, saved = []) => {
  const values = new Map(saved ?? []);
  values.set('pawtalk:identity:v2', JSON.stringify({ root: root.repeat(32), device: device.repeat(32) }));
  values.set(`pawtalk:agreement:v1:${data.policyTrust.serverId}:${member.deviceId}`, agreement.repeat(32));
  return {
    load: async id => values.get(id), save: async (id, value) => { values.set(id, value); },
    epochs: () => [...values].filter(([id]) => id.startsWith('pawtalk:protected-epoch:')),
  };
};
let lostCommit = false;
let corruptRevisionRecipients = false;
let acceptedRevisionBody;
let lostMessagePacket, releaseConcurrentRetries;
const retriedMessagePackets = [];
const bothRetriesReady = new Promise(resolve => { releaseConcurrentRetries = resolve; });
const client = new MembershipClient({ credentials: credentials('01', '65', data.owner, '0b'), fetcher: async (url, options) => {
  const append = options.method === 'POST' && new URL(url).pathname === `/api/v3/history/live/${data.channelId}`;
  const packet = append ? JSON.parse(options.body) : undefined;
  const firstOperation = packet?.OperationID === '1'.repeat(32);
  if (firstOperation && data.step === 2) {
    retriedMessagePackets.push(packet);
    if (retriedMessagePackets.length === 2) releaseConcurrentRetries();
    await bothRetriesReady;
  }
  const response = await pinnedFetch(url, options);
  if (firstOperation) assert.ok(response.ok);
  if (firstOperation && data.step === 1) {
    assert.equal(lostMessagePacket, undefined);
    assert.deepEqual(await response.json(), { Position: 1, Existing: false });
    lostMessagePacket = packet;
    throw new Error('synthetic message response loss after durable append');
  }
  if (corruptRevisionRecipients && url.endsWith('/basis') && response.ok) {
    const basis = await response.json();
    basis.recipients.push({ id: data.reader.deviceId, publicKey: data.reader.publicKey });
    return Response.json(basis);
  }
  if (data.step === 2 && !lostCommit && url.endsWith('/live/commit') && response.ok) {
    lostCommit = true;
    throw new Error('synthetic response loss after durable rotation');
  }
  if (data.step === 3 && options.method === 'PUT' && url.includes('/history/revision/') && response.ok) {
    if (acceptedRevisionBody === undefined) {
      acceptedRevisionBody = options.body;
      throw new Error('synthetic revision response loss');
    }
    assert.equal(options.body, acceptedRevisionBody);
  }
  return response;
} });
const readerStore = credentials('02', '66', data.reader, '16', data.readerEpochs);
let historicalMutation;
let windowMutation;
const reader = new MembershipClient({ credentials: readerStore, fetcher: async (url, options) => {
  const query = new URL(url);
  if (query.pathname === '/api/v3/policy/proofs') {
    // The fixture supplies independently replayable, complete policy history.
    return Response.json(await readerPolicy(Number(query.searchParams.get('after'))));
  }
  const response = await pinnedFetch(url, options);
  if (windowMutation && query.pathname.startsWith('/api/v3/history/window/') && response.ok) {
    const window = await response.json();
    return Response.json(windowMutation(window));
  }
  if (historicalMutation && query.pathname.startsWith('/api/v3/keys/admitted/') && response.ok) {
    const delivery = await response.json();
    assert.equal(delivery.admissionPolicy.recipient.statement.id, data.reader.deviceId);
    assert.equal(delivery.admissionPolicy.recipient.statement.firstPosition, 3);
    assert.ok(delivery.admissionPolicy.revision < delivery.textPolicy.revision);
    historicalMutation(delivery);
    return Response.json(delivery);
  }
  return response;
} });
const prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
const privateKey = seed => createPrivateKey({
  key: Buffer.concat([prefix, Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8',
});

async function request(token, path, input) {
  const response = await pinnedFetch(data.base + path, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input), signal: AbortSignal.timeout(3000), pawtalkTLSFingerprint: data.fingerprint,
  });
  if (!response.ok) throw new Error(`fixture ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

const { policyTrust, channelId } = data;
const revisionPath = `/api/v3/history/revision/${channelId}/1`;
async function revisionRequest(token, path, status, attempt) {
  const response = await pinnedFetch(data.base + revisionPath + path, {
    method: attempt === undefined ? 'GET' : 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: attempt === undefined ? undefined : JSON.stringify(attempt),
    pawtalkTLSFingerprint: data.fingerprint,
  });
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}
function revisionContext(record, operationId, author) {
  return { serverId: policyTrust.serverId, channelId, position: 1, revision: record.revision, originalDigest: record.originalDigest,
    previousDigest: record.previousDigest, operationId, authorProfileId: author.profileId, authorDeviceId: author.deviceId,
    policyRevision: record.policyRevision, policyDigest: record.policyDigest, archive: record.archive.Record, archiveDigest: record.archiveDigest };
}
async function publishRevision() {
  const basis = await revisionRequest(data.owner.token, '/basis', 200);
  assert.equal(basis.position, 1);
  assert.equal(basis.revision, data.step);
  const expected = data.step === 2 ? [{ id: data.reader.deviceId, publicKey: data.reader.publicKey }] : [];
  assert.deepEqual(basis.recipients, expected);
  const scoped = await revisionRequest(data.owner.token, '/basis?scoped=1', 200);
  assert.deepEqual(verifyRevisionAudience(scoped.authorPolicy.limitedAudience, basis.position, scoped.recipients,
    scoped.authorPolicy.audienceProof), expected);
  if (data.step === 2) {
    assert.throws(() => verifyRevisionAudience(scoped.authorPolicy.limitedAudience, basis.position, [], scoped.authorPolicy.audienceProof),
      { code: 'UNVERIFIED_EPOCH_RECIPIENTS' });
  } else {
    assert.throws(() => verifyRevisionAudience(scoped.authorPolicy.limitedAudience, 3, [], scoped.authorPolicy.audienceProof),
      { code: 'UNVERIFIED_EPOCH_RECIPIENTS' });
  }
  assert.equal(await client.verifyEpochProof(basis.archive, policyTrust, ownerPolicy), basis.archiveDigest);
  const { device: authorKey } = await client.identity();
  const authorPublic = createPublicKey(authorKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const operationId = String(8 + data.step).padStart(32, 'a');
  const context = revisionContext(basis, operationId, data.owner);
  const sealed = sealProtectedRevision(context, `edition ${data.step}`, basis.recipients, authorKey);
  const { revision, previousDigest, policyRevision, policyDigest, archiveDigest } = basis;
  const attempt = { revision, previousDigest, policyRevision, policyDigest, archiveDigest, operationId, ...sealed };
  if (data.step === 2) {
    assert.equal((await revisionRequest(data.reader.token, '/basis', 403)).error.code, 'PROTECTED_ACCESS_DENIED');
    assert.equal((await revisionRequest(data.owner.token, '', 409, { ...attempt, packages: [] })).error.code, 'PROTECTED_REVISION_CHANGED');
    const substitute = { ...attempt.packages[0], id: data.owner.deviceId, publicKey: data.owner.publicKey };
    assert.equal((await revisionRequest(data.owner.token, '', 409, { ...attempt, packages: [substitute] })).error.code, 'PROTECTED_REVISION_CHANGED');
    assert.equal((await revisionRequest(data.owner.token, '', 409, { ...attempt, policyRevision: policyRevision - 1 })).error.code,
      'PROTECTED_REVISION_CHANGED');
    const invalid = { ...attempt, packet: { ...attempt.packet, signature: Buffer.alloc(64).toString('base64') } };
    assert.equal((await revisionRequest(data.owner.token, '', 403, invalid)).error.code, 'INVALID_PROTECTED_REVISION');
  }
  if (data.step === 3) {
    corruptRevisionRecipients = true;
    try {
      await assert.rejects(client.editProtectedChatMessage(runtimeConnection(data.owner), channelId, 1, 2, operationId, 'edition 3'),
        { code: 'UNVERIFIED_EPOCH_RECIPIENTS' });
    } finally {
      corruptRevisionRecipients = false;
    }
    await assert.rejects(client.editProtectedChatMessage(runtimeConnection(data.owner), channelId, 1, 2, operationId, 'edition 3'),
      /synthetic revision response loss/);
  }
  const receipt = data.step === 3
    ? await client.editProtectedChatMessage(runtimeConnection(data.owner), channelId, 1, 2, operationId, 'edition 3')
    : await revisionRequest(data.owner.token, '', 200, attempt);
  assert.equal(receipt.revision, revision);
  assert.equal(receipt.existing, data.step === 3);
  assert.match(receipt.digest, /^[0-9a-f]{64}$/);
  if (data.step === 2) {
    assert.equal(receipt.digest, digest(Buffer.from(attempt.packet.signature, 'base64')));
    assert.deepEqual(await revisionRequest(data.owner.token, '', 200, attempt), { ...receipt, existing: true });
    assert.equal((await revisionRequest(data.owner.token, '', 409, { ...attempt, packet: {
      ...attempt.packet, nonce: Buffer.alloc(12).toString('base64'),
    } })).error.code, 'PROTECTED_REVISION_CHANGED');
    assert.equal((await revisionRequest(data.owner.token, '', 409, { ...attempt, operationId: 'e'.repeat(32) })).error.code,
      'PROTECTED_REVISION_CHANGED');
    const delivered = await revisionRequest(data.reader.token, '', 200);
    assert.equal(delivered.digest, receipt.digest);
    const recipient = expected[0];
    assert.equal(openProtectedRevisionForDevice(context, delivered.record.packet, { ...delivered.package, proof: delivered.proof },
      recipient, privateKey(22), authorPublic), 'edition 2');
  } else {
    assert.equal((await revisionRequest(data.reader.token, '', 403)).error.code, 'PROTECTED_ACCESS_DENIED');
  }
}
const runtimeConnection = member => ({ base: data.base, serverId: policyTrust.serverId, policyTrust,
  token: member.token, profileId: member.profileId, deviceId: member.deviceId, fingerprint: data.fingerprint,
});
const fetchPolicy = token => after => request(token, '/policy', { after });
const ownerPolicy = fetchPolicy(data.owner.token);
const readerPolicy = fetchPolicy(data.reader.token);
const epochProofs = token => (_channel, purpose, from, through) => request(token, '/epochs', { purpose, from, through });
const ownerEpochProofs = epochProofs(data.owner.token);
const readerEpochProofs = epochProofs(data.reader.token);
async function syncPolicy(client, fetchPolicyPage) {
  let after = 0;
  for (;;) {
    const progress = await client.verifyProtectedPolicyPage(await fetchPolicyPage(after), policyTrust);
    if (progress.complete) return;
    after = progress.revision;
  }
}

const rotation = {
  policyTrust, channelId, profileId: data.owner.profileId,
  fetchPolicyPage: ownerPolicy, fetchEpochProofs: ownerEpochProofs,
  claim: (_channel, purpose) => request(data.owner.token, '/claim', { purpose }),
  commit: (record, packages, links) => request(data.owner.token, '/commit', { record, packages, links }),
};

async function main() {
  await syncPolicy(client, ownerPolicy);
  const ownerRuntime = runtimeConnection(data.owner);
  const readerRuntime = runtimeConnection(data.reader);
  if (data.step === 1) {
    const verified = await client.policyCheckpoint().load(policyTrust);
    const scopePaths = [];
    let corruptRoot = false;
    let changeOrderCategory = false;
    let changeSignedOrdering = false;
    let changeOrderEvidence = false;
    let omitArchiveTargetSigner = false;
    const scoped = new MembershipClient({ credentials: credentials('02', '66', data.reader, '16'), fetcher: async (url, options) => {
      const path = new URL(url).pathname;
      scopePaths.push(path);
      if (changeSignedOrdering && path === '/api/v3/policy/channel-order' && options.method === 'POST') {
        const change = JSON.parse(options.body);
        return pinnedFetch(url, { ...options, body: JSON.stringify({ ...change, after: !change.after }) });
      }
      const response = await pinnedFetch(url, options);
      if (response.ok && changeOrderEvidence && path === `/api/v3/policy/channel-order/${data.voiceProbeChannel}/proof`) {
        const evidence = await response.json();
        evidence.change.after = !evidence.change.after;
        return Response.json(evidence);
      }
      if (response.ok && changeOrderCategory && path === `/api/v3/policy/channel-order/${data.probeChannel}`) {
        return Response.json({ ...await response.json(), categoryId: 'f'.repeat(32) });
      }
      if (corruptRoot && path.endsWith('/attestations/current') && response.ok) {
        const attestation = await response.json();
        return Response.json({ ...attestation, root: 'f'.repeat(64) });
      }
      if (response.ok && path === `/api/v3/keys/rotate/${data.probeChannel}/targets`) {
        assert.equal(new URL(url).searchParams.get('scoped'), '1');
        if (omitArchiveTargetSigner) {
          const deliveries = await response.json();
          delete deliveries[0].Epoch.signingPolicy;
          return Response.json(deliveries);
        }
      }
      return response;
    } });
    await assert.rejects(scoped.readProtectedPolicyAttestation(readerRuntime), { code: 'POLICY_ATTESTATION_UNAVAILABLE' });
    await assert.rejects(scoped.fetchJSON(data.base, '/api/v3/policy/attestations', {
      method: 'POST', fingerprint: data.fingerprint, headers: { Authorization: `Bearer ${readerRuntime.token}` },
      body: JSON.stringify({ revision: verified.revision, signature: Buffer.alloc(64).toString('base64') }),
    }), { code: 'PROTECTED_ACCESS_DENIED' });
    await client.publishProtectedPolicyAttestation(ownerRuntime, verified.revision);
    await client.publishProtectedPolicyAttestation(ownerRuntime, verified.revision);
    const attestation = await scoped.readProtectedPolicyAttestation(readerRuntime);
    assert.equal(attestation.root, verified.textProjectionRoot);
    assert.deepEqual(Object.keys(attestation).sort(), ['digest', 'policyDigest', 'previous', 'projectionVersion', 'revision', 'root', 'signature', 'signerKey']);
    assert.equal(attestation.projectionVersion, channelSettingsProjectionVersion);
    const admission = await scoped.verifyProtectedRuntimeOwnAdmission(readerRuntime, channelId);
    assert.deepEqual(admission, { revision: verified.revision, policyDigest: verified.resultDigest, firstPosition: 1, fullHistory: true });
    for (const [id, kind] of [[data.probeChannel, 'text'], [data.voiceProbeChannel, 'voice']]) {
      assert.deepEqual(await scoped.verifyProtectedChannelOrderAuthority(readerRuntime, id), {
        channelId: id, kind, categoryId: data.probeCategory, revision: verified.revision, policyDigest: verified.resultDigest,
      });
    }
    for (const id of [channelId, 'f'.repeat(32)]) {
      await assert.rejects(scoped.verifyProtectedChannelOrderAuthority(readerRuntime, id), { code: 'PROTECTED_ACCESS_DENIED' });
    }
    changeOrderCategory = true;
    await assert.rejects(scoped.verifyProtectedChannelOrderAuthority(readerRuntime, data.probeChannel), { code: 'INVALID_CHANNEL_POLICY_PROOF' });
    changeOrderCategory = false;
    const ordering = { Action: 'channel.order', OperationID: 'c'.repeat(32),
      ResourceChange: { ID: data.probeChannel, AnchorID: data.voiceProbeChannel, After: true } };
    const preview = await scoped.previewProtectedRuntimePolicy(readerRuntime, ordering, policyTrust);
    assert.deepEqual(preview.draft.ResourceChange, ordering.ResourceChange);
    assert.equal(preview.snapshot, undefined);
    assert.equal(preview.channelOrderBasisVersion, 2);
    assert.notEqual(preview.channelOrderBasis, digest(JSON.stringify([data.probeChannel, data.voiceProbeChannel])));
    const wrongAnchor = structuredClone(preview);
    wrongAnchor.draft.ResourceChange.AnchorID = channelId;
    await assert.rejects(scoped.verifyProtectedRuntimePolicyPreview(readerRuntime, wrongAnchor, ordering, policyTrust),
      { code: 'INVALID_POLICY_PREVIEW' });
    const orderOf = async connection => {
      const state = await scoped.fetchJSON(connection.base, '/api/v3/state', {
        fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
      });
      if (connection.profileId === readerRuntime.profileId) {
        assert.deepEqual(state.Channels.filter(item => item.CanOrder).map(item => item.ID).sort(),
          [data.probeChannel, data.voiceProbeChannel].sort());
      }
      return state.Channels.filter(item => item.CategoryID === data.probeCategory).map(item => item.ID);
    };
    assert.deepEqual(await orderOf(ownerRuntime), [data.probeChannel, data.hiddenProbeChannel, data.voiceProbeChannel]);
    const staleOrdering = { ...ordering, OperationID: 'd'.repeat(32), ResourceChange: {
      ID: data.voiceProbeChannel, AnchorID: data.probeChannel, After: true,
    } };
    const stalePreview = await scoped.previewProtectedRuntimePolicy(readerRuntime, staleOrdering, policyTrust);
    const commitOrder = (selected, intent) => scoped.commitProtectedRuntimePolicy(readerRuntime, {
      preview: selected, intent, expectedResultDigest: selected.draft.ResultDigest,
    }, policyTrust);
    changeSignedOrdering = true;
    await assert.rejects(commitOrder(preview, ordering), { code: 'INVALID_POLICY_SIGNATURE' });
    changeSignedOrdering = false;
    const moved = await commitOrder(preview, ordering);
    assert.equal(moved.existing, false);
    assert.deepEqual(await commitOrder(preview, ordering), { ...moved, existing: true });
    await assert.rejects(commitOrder(stalePreview, staleOrdering), { code: 'PROTECTED_POLICY_CHANGED' });
    assert.deepEqual(await orderOf(readerRuntime), [data.voiceProbeChannel, data.probeChannel]);
    assert.deepEqual(await orderOf(ownerRuntime), [data.voiceProbeChannel, data.hiddenProbeChannel, data.probeChannel]);
    assert.equal((await scoped.readProtectedPolicyAttestation(readerRuntime)).digest, verified.digest);
    const recordedOrder = (await client.readProtectedAudit(ownerRuntime)).entries.find(entry => entry.channelId === data.probeChannel && entry.action === 'channel.order');
    assert.equal(recordedOrder.change.layoutDigest, moved.digest);
    const witnessed = await client.readVerifiedProtectedChannelOrder(ownerRuntime, data.probeChannel, moved.digest);
    assert.equal(witnessed.authorProfileId, data.reader.profileId);
    assert.equal(witnessed.digest, moved.digest);
    const recordOwnerOrder = async (operationId, anchor) => {
      const intent = { Action: 'channel.order', OperationID: operationId,
        ResourceChange: { ID: data.voiceProbeChannel, AnchorID: anchor, After: true } };
      const preview = await client.previewProtectedRuntimePolicy(ownerRuntime, intent, policyTrust);
      return client.commitProtectedRuntimePolicy(ownerRuntime, { preview, intent, expectedResultDigest: preview.draft.ResultDigest }, policyTrust);
    };
    const ownerOrder = await recordOwnerOrder('e'.repeat(32), data.probeChannel);
    changeOrderEvidence = true;
    await assert.rejects(scoped.readVerifiedProtectedChannelOrder(readerRuntime, data.voiceProbeChannel, ownerOrder.digest), { code: 'INVALID_CHANNEL_ORDER_PROOF' });
    changeOrderEvidence = false;
    assert.deepEqual(await scoped.readVerifiedProtectedChannelOrder(readerRuntime, data.voiceProbeChannel, ownerOrder.digest), {
      source: data.voiceProbeChannel, anchor: data.probeChannel, after: true, revision: verified.revision,
      authorProfileId: data.owner.profileId, digest: ownerOrder.digest,
    });
    const hiddenOrder = await recordOwnerOrder('f'.repeat(32), data.hiddenProbeChannel);
    assert.equal(await scoped.readVerifiedProtectedChannelOrder(readerRuntime, data.voiceProbeChannel, hiddenOrder.digest), null);
    assert.equal(await scoped.readVerifiedProtectedChannelOrder(readerRuntime, data.voiceProbeChannel, '0'.repeat(64)), null);
    assert.equal((await scoped.readVerifiedProtectedChannelOrder(readerRuntime, data.voiceProbeChannel, ownerOrder.digest)).digest, ownerOrder.digest);
    assert.equal(await scoped.policyCheckpoint().load(policyTrust), undefined);
    assert.ok(!scopePaths.includes('/api/v3/policy/proofs'));
    corruptRoot = true;
    await assert.rejects(scoped.verifyProtectedRuntimeOwnAdmission(readerRuntime, channelId), { code: 'INVALID_POLICY_ATTESTATION' });
    corruptRoot = false;
    await assert.rejects(client.runProtectedRotation('live', {
      ...rotation,
      claim: async (channel, purpose) => {
        const task = await rotation.claim(channel, purpose);
        task.Recipients[data.reader.deviceId].PublicKey = 'd'.repeat(64);
        return task;
      },
      commit: () => assert.fail('recipient substitution reached commit'),
    }), { code: 'UNVERIFIED_EPOCH_RECIPIENTS' });
    await assert.rejects(client.runProtectedRotation('live', {
      ...rotation,
      claim: async (channel, purpose) => ({ ...await rotation.claim(channel, purpose), PolicyDigest: 'b'.repeat(64) }),
      commit: () => assert.fail('unverified policy reached commit'),
    }), { code: 'UNVERIFIED_EPOCH_POLICY' });
    await client.rotateProtectedRuntimeText(ownerRuntime, data.probeChannel, 'live');
    omitArchiveTargetSigner = true;
    await assert.rejects(scoped.rotateProtectedRuntimeText(readerRuntime, data.probeChannel, 'archive'), { code: 'UNVERIFIED_EPOCH_POLICY' });
    omitArchiveTargetSigner = false;
    const scopedArchive = await scoped.rotateProtectedRuntimeText(readerRuntime, data.probeChannel, 'archive');
    assert.deepEqual([scopedArchive.generation, scopedArchive.through], [1, 1]);
    const { record, secret } = await scoped.loadProtectedRuntimeKey(readerRuntime, data.probeChannel, 'archive', { policyTrust });
    assert.equal(record.KeyID, scopedArchive.keyId);
    assert.equal(digest(secret), scopedArchive.keyId);
    secret.fill(0);
    assert.ok(!scopePaths.includes('/api/v3/policy/proofs'));
  }
  await syncPolicy(reader, readerPolicy);
  let live;
  if (data.step === 3) {
    const verified = await client.policyCheckpoint().load(policyTrust);
    let corruptHistory = false;
    let substituteHead = false;
    let replayPages = 0;
    const published = [];
    const ownerCredentials = credentials('01', '65', data.owner, '0b');
    const returningClient = () => new MembershipClient({ credentials: ownerCredentials, fetcher: async (url, options) => {
      const path = new URL(url).pathname;
      const response = await pinnedFetch(url, options);
      if (response.ok && substituteHead && path.endsWith('/attestations/pending')) {
        return Response.json({ ...await response.json(), headDigest: 'f'.repeat(64) });
      }
      if (response.ok && path === '/api/v3/policy/proofs') {
        replayPages++;
        if (corruptHistory) {
          const page = await response.json();
          page.proofs[1].snapshot = Buffer.from('{}').toString('base64');
          return Response.json(page);
        }
      }
      if (response.ok && path === '/api/v3/policy/attestations' && options.method === 'POST') {
        published.push(JSON.parse(options.body).revision);
      }
      return response;
    } });
    await returningClient().refreshProtectedRuntimePolicy(ownerRuntime, policyTrust);
    // The saved checkpoint survives restart, but the verified history index is in memory.
    const ownerReturning = returningClient();
    const pendingPath = '/api/v3/policy/attestations/pending';
    const pending = connection => ownerReturning.fetchJSON(connection.base, pendingPath, {
      fingerprint: connection.fingerprint, headers: { Authorization: `Bearer ${connection.token}` },
    });
    await assert.rejects(pending(readerRuntime), { code: 'PROTECTED_ACCESS_DENIED' });
    assert.deepEqual((await pending(ownerRuntime)).revisions, [verified.revision - 1, verified.revision]);
    substituteHead = true;
    await assert.rejects(ownerReturning.syncProtectedPolicyAttestations(ownerRuntime), { code: 'POLICY_FORK' });
    substituteHead = false;
    corruptHistory = true;
    await assert.rejects(ownerReturning.syncProtectedPolicyAttestations(ownerRuntime), { code: 'INVALID_POLICY_SNAPSHOT' });
    assert.deepEqual(published, []);
    corruptHistory = false;
    replayPages = 0;
    await ownerReturning.syncProtectedPolicyAttestations(ownerRuntime);
    assert.deepEqual(published, [verified.revision, verified.revision - 1]);
    assert.equal(replayPages, 1);
    assert.deepEqual((await pending(ownerRuntime)).revisions, []);
    assert.equal((await ownerReturning.readProtectedPolicyAttestation(readerRuntime, verified.revision - 1)).revision, verified.revision - 1);
    let substitute = true;
    let checkedCommittedEpoch = false;
    const paths = [];
    const executor = new MembershipClient({ credentials: credentials('02', '66', data.reader, '16'), fetcher: async (url, options) => {
      const query = new URL(url);
      paths.push(query.pathname);
      const response = await pinnedFetch(url, options);
      if (response.ok && query.pathname === `/api/v3/keys/proofs/${channelId}/live` && query.searchParams.get('through') === '3') {
        assert.equal(query.searchParams.get('scoped'), '1');
        checkedCommittedEpoch = true;
      }
      if (response.ok && query.pathname.endsWith('/live/claim')) {
        assert.equal(query.searchParams.get('scoped'), '1');
        if (substitute) {
          const task = await response.json();
          task.Recipients[data.owner.deviceId].PublicKey = '5'.repeat(64);
          return Response.json(task);
        }
      }
      if (response.ok && query.pathname === `/api/v3/keys/rotate/${channelId}/live/commit`) {
        const { generation, keyId } = await response.json();
        live = { generation, keyId };
        throw Error('synthetic scoped rotation response loss');
      }
      return response;
    } });
    await assert.rejects(executor.rotateProtectedRuntimeText(readerRuntime, channelId, 'live'), { code: 'UNVERIFIED_EPOCH_RECIPIENTS' });
    assert.equal(live, undefined);
    substitute = false;
    await executor.serviceProtectedRuntimeRotations(readerRuntime);
    assert.equal(live?.generation, 3);
    assert.ok(checkedCommittedEpoch);
    assert.ok(!paths.includes('/api/v3/policy/proofs'));
    assert.equal(await executor.policyCheckpoint().load(policyTrust), undefined);
  } else {
    live = await client.rotateProtectedRuntimeText(ownerRuntime, channelId, 'live');
  }
  if (data.step === 2) assert.ok(lostCommit);
  const liveDelivery = await request(data.reader.token, '/live', { keyId: live.keyId });
  if (data.step === 3) assert.equal(liveDelivery.Epoch.Principal.DeviceID, data.reader.deviceId);
  const readerContext = delivery => packageContext(policyTrust.serverId, delivery.Epoch.Record, data.reader.deviceId, data.reader.publicKey);
  const readLive = (receiver, delivery, fetchEpochProofs = readerEpochProofs) =>
    receiver.openProtectedEpochPackage(delivery, readerContext(delivery), privateKey(22), {
      policyTrust, fetchPolicyPage: readerPolicy, fetchEpochProofs,
    });
  if (data.step === 4) {
    await assert.rejects(readLive(reader, liveDelivery, async () => []), { code: 'EPOCH_CHAIN_GAP' });
  }
  const liveSecret = await readLive(reader, liveDelivery);
  assert.equal(digest(liveSecret), live.keyId);
  const disclosure = await reader.fetchProtectedRuntimeTextChannelProof(readerRuntime, channelId);
  const policy = await reader.policyCheckpoint().load(policyTrust);
  const statement = verifyTextRecipientDisclosure(policy.textProjectionRoot, channelId, disclosure, {
    recipientId: data.reader.deviceId, recipientKey: data.reader.publicKey, purpose: 'live',
  }, policy.textProjectionVersion);
  assert.equal(statement.id, data.reader.deviceId);
  assert.equal(statement.firstPosition, data.step < 3 ? 1 : 3);
  assert.equal(statement.archive, data.step === 1 || data.step === 4);
  assert.equal(disclosure.recipient.count, 2);
  assert.equal(disclosure.recipient.siblings.length, 1);
  const encoded = JSON.stringify(disclosure);
  assert.ok(!encoded.includes(data.owner.deviceId) && !encoded.includes(data.owner.publicKey) &&
    !encoded.includes(policy.textProjectionSeed));
  const tampered = structuredClone(disclosure);
  tampered.recipient.statement.firstPosition++;
  await assert.rejects(reader.policyCheckpoint().verifyTextChannelDisclosure(channelId, tampered, policyTrust),
    { code: 'INVALID_CHANNEL_POLICY_PROOF' });
  const changedAudience = { ...disclosure, archiveAudience: '0'.repeat(64) };
  await assert.rejects(reader.policyCheckpoint().verifyTextChannelDisclosure(channelId, changedAudience, policyTrust),
    { code: 'INVALID_CHANNEL_POLICY_PROOF' });
  assert.throws(() => verifyTextRecipientDisclosure(policy.textProjectionRoot, channelId, disclosure, {
    recipientId: data.owner.deviceId, recipientKey: data.owner.publicKey, purpose: 'live',
  }, policy.textProjectionVersion), { code: 'INVALID_CHANNEL_POLICY_PROOF' });
  if (!statement.archive) {
    assert.throws(() => verifyTextRecipientDisclosure(policy.textProjectionRoot, channelId, disclosure, {
      recipientId: data.reader.deviceId, recipientKey: data.reader.publicKey, purpose: 'archive',
    }, policy.textProjectionVersion), { code: 'INVALID_CHANNEL_POLICY_PROOF' });
  }
  const send = (text, operationId, replyTo) => client.sendProtectedRuntimeText(ownerRuntime, channelId, text, operationId,
    { policyTrust, fetchPolicyPage: ownerPolicy, fetchEpochProofs: ownerEpochProofs }, replyTo);
  if (data.step === 2) {
    const first = data.firstMessagePacket;
    assert.equal(first.KeyID, data.firstLive.keyId);
    const retries = await Promise.all([send('epoch 1', first.OperationID), send('epoch 1', first.OperationID)]);
    assert.deepEqual(retries, [{ Position: 1, Existing: true }, { Position: 1, Existing: true }]);
    assert.equal(retriedMessagePackets.length, 2);
    for (const retry of retriedMessagePackets) {
      assert.equal(retry.OperationID, first.OperationID);
      assert.equal(retry.KeyID, live.keyId);
      assert.notEqual(retry.KeyID, first.KeyID);
    }
    assert.equal(new Set([first, ...retriedMessagePackets].map(packet => packet.Nonce)).size, 3);
    assert.equal(new Set([first, ...retriedMessagePackets].map(packet => packet.Ciphertext)).size, 3);
    const page = await client.readProtectedRuntimeText(ownerRuntime, channelId);
    assert.equal(page.messages.length, 1);
    const [{ Packet, Position, Generation }] = page.messages;
    assert.deepEqual([Position, Generation, Packet.OperationID, Packet.KeyID, Packet.Nonce, Packet.Ciphertext],
      [1, 1, first.OperationID, first.KeyID, first.Nonce, first.Ciphertext]);
  }
  if (data.step > 1) {
    assert.deepEqual(await send(`epoch ${data.step}`, String(data.step).repeat(32), 1), { Position: data.step, Existing: false });
  }
  if (data.step === 1) {
    await assert.rejects(send('epoch 1', '1'.repeat(32)), /synthetic message response loss after durable append/);
    assert.equal(lostMessagePacket.KeyID, live.keyId);
    liveSecret.fill(0);
    await assert.rejects(reader.setProtectedMessagePin(readerRuntime, channelId, 1, true), { code: 'PROTECTED_ACCESS_DENIED' });
    await client.setProtectedMessagePin(ownerRuntime, channelId, 1, true);
    assert.deepEqual(await reader.readProtectedPins(readerRuntime, channelId), {
      items: [{ position: 1, revision: 1 }], canPin: false, next: undefined,
    });
    assert.equal((await reader.readProtectedPinnedMessage(readerRuntime, channelId, 1)).text, 'epoch 1');
    await client.setProtectedMessagePin(ownerRuntime, channelId, 1, false);
    process.stdout.write(JSON.stringify({ live, firstDelivery: liveDelivery, firstMessagePacket: lostMessagePacket,
      readerEpochs: readerStore.epochs() }));
    return;
  }
  if (data.step === 4) {
    const reloaded = new MembershipClient({ credentials: readerStore });
    await assert.rejects(readLive(reloaded, data.firstDelivery), { code: 'EPOCH_ROLLBACK' });
    const fork = structuredClone(liveDelivery);
    const record = fork.Epoch.Record;
    record.LeaseID = 'b'.repeat(32);
    fork.Package.Ciphertext = sealEpochPackage(liveSecret, readerContext(fork)).toString('base64');
    record.PackagesDigest = packagesDigest([fork.Package]);
    fork.Proof = { index: 0, count: 1, siblings: [] };
    const { device } = await client.identity();
    record.Signature = sign(null, epochSignatureFrame(policyTrust.serverId, data.owner.profileId,
      data.owner.deviceId, record), device).toString('base64');
    await assert.rejects(readLive(reloaded, fork), { code: 'EPOCH_FORK' });
  }
  liveSecret.fill(0);
  if (data.step === 2) {
    await assert.rejects(client.runProtectedRotation('archive', {
      ...rotation,
      claim: async (channel, purpose) => {
        const task = await rotation.claim(channel, purpose);
        task.Recipients[data.reader.deviceId] = {
          ProfileID: data.reader.profileId, PublicKey: data.reader.publicKey, Kind: 'device',
        };
        return task;
      },
      commit: () => assert.fail('limited reader received a signed archive package'),
    }), { code: 'UNVERIFIED_EPOCH_RECIPIENTS' });
    const task = await rotation.claim(channelId, 'archive');
    const { ChannelID, Purpose, Generation, Revision, TaskID, LeaseID, ArchiveThrough, ArchiveTargets } = task;
    const record = { ChannelID, Purpose, Generation, Revision, TaskID, LeaseID, ArchiveThrough };
    const targets = async (connection, record, targets) => pinnedFetch(`${data.base}/api/v3/keys/rotate/${channelId}/targets`, {
      method: 'POST', body: JSON.stringify({ Record: record, Targets: targets }), pawtalkTLSFingerprint: data.fingerprint,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
    });
    assert.equal((await targets(readerRuntime, record, ArchiveTargets)).status, 403);
    let response = await targets(ownerRuntime, { ...record, LeaseID: '0'.repeat(32) }, ArchiveTargets);
    assert.equal((await response.json()).error.code, 'PROTECTED_ROTATION_UNAVAILABLE');
    response = await targets(ownerRuntime, record, [{ ...ArchiveTargets[0], KeyID: '0'.repeat(64) }]);
    assert.equal((await response.json()).error.code, 'PROTECTED_KEY_PENDING');
  }
  if (data.step === 2) assert.equal((await revisionRequest(data.owner.token, '/basis', 409)).error.code, 'PROTECTED_KEY_PENDING');
  const archive = await client.rotateProtectedRuntimeText(ownerRuntime, channelId, 'archive');
  if (data.step === 2 || data.step === 3) {
    const verified = await client.policyCheckpoint().load(policyTrust);
    await client.publishProtectedPolicyAttestation(ownerRuntime, verified.revision);
    let changedEvidence = '';
    const paths = [];
    const scoped = new MembershipClient({ credentials: credentials('02', '66', data.reader, '16'), fetcher: async (url, options) => {
      const path = new URL(url).pathname;
      paths.push(path);
      const response = await pinnedFetch(url, options);
      if (!response.ok) return response;
      if (changedEvidence === 'epoch' && path.includes('/keys/current/')) {
        const delivery = await response.json();
        delete delivery.Epoch.signingPolicy;
        return Response.json(delivery);
      }
      if (changedEvidence === 'author' && path.includes('/history/live/')) {
        const page = await response.json();
        page.messages[0].AuthorPolicy.recipient.statement.signingKey = 'f'.repeat(64);
        return Response.json(page);
      }
      if (changedEvidence === 'revision author' && path === revisionPath) {
        const delivery = await response.json();
        delivery.authorPolicy.recipient.statement.canSend = false;
        return Response.json(delivery);
      }
      return response;
    } });
    const timeline = await scoped.readProtectedChatPage(readerRuntime, channelId, 0);
    await assert.rejects(scoped.verifyProtectedChannelOrderAuthority(readerRuntime, data.probeChannel), { code: 'PROTECTED_ACCESS_DENIED' });
    const sourceAudit = (await client.readProtectedAudit(ownerRuntime)).entries.find(entry => entry.channelId === data.probeChannel && entry.action === 'channel.order');
    const historicalOrder = await scoped.readVerifiedProtectedChannelOrder(readerRuntime, data.probeChannel, sourceAudit.change.layoutDigest);
    assert.equal(historicalOrder.authorProfileId, data.reader.profileId);
    assert.equal(historicalOrder.revision, 1);
    assert.deepEqual(timeline.messages.map(row => row.text), data.step === 2 ? ['epoch 1', 'epoch 2'] : ['epoch 3']);
    if (data.step === 2) {
      assert.equal(timeline.canSend, false);
      assert.equal(timeline.pins.canPin, true);
      await scoped.setProtectedMessagePin(readerRuntime, channelId, 1, true);
      await scoped.setProtectedMessagePin(readerRuntime, channelId, 1, true);
      assert.deepEqual((await scoped.readProtectedPins(readerRuntime, channelId)).items, [{ position: 1, revision: 1 }]);
      assert.equal((await scoped.readProtectedPinnedMessage(readerRuntime, channelId, 1)).text, 'epoch 1');
    } else {
      assert.deepEqual(timeline.pins.items, []);
      await assert.rejects(scoped.setProtectedMessagePin(readerRuntime, channelId, 1, false), { code: 'PROTECTED_ACCESS_DENIED' });
      assert.equal(await scoped.readProtectedPinnedMessage(readerRuntime, channelId, 1), undefined);
    }
    assert.equal(await scoped.policyCheckpoint().load(policyTrust), undefined);
    assert.ok(!paths.includes('/api/v3/policy/proofs'));
    if (data.step === 2) {
      for (const kind of ['epoch', 'author']) {
        changedEvidence = kind;
        await assert.rejects(scoped.readProtectedChatPage(readerRuntime, channelId, 0),
          { code: kind === 'epoch' ? 'UNVERIFIED_EPOCH_POLICY' : 'INVALID_CHANNEL_POLICY_PROOF' });
      }
      changedEvidence = '';
      await publishRevision();
      assert.deepEqual((await scoped.readProtectedPins(readerRuntime, channelId)).items, [{ position: 1, revision: 2 }]);
      assert.equal((await scoped.readProtectedPinnedMessage(readerRuntime, channelId, 1)).text, 'edition 2');
      const edited = await scoped.readProtectedChatEdition(readerRuntime, channelId, 1);
      assert.deepEqual([edited.position, edited.revision, edited.text], [1, 2, 'edition 2']);
      changedEvidence = 'revision author';
      await assert.rejects(scoped.readProtectedChatEdition(readerRuntime, channelId, 1), { code: 'INVALID_CHANNEL_POLICY_PROOF' });
      assert.ok(!paths.includes('/api/v3/policy/proofs'));
    }
  }
  if (data.step === 3) await publishRevision();
  if (data.step === 2) {
    await assert.rejects(request(data.reader.token, '/head', { keyId: archive.keyId }), /channel_restricted/);
    await assert.rejects(readerEpochProofs(channelId, 'archive', 0, 1), /channel_restricted/);
    const timeline = await reader.readProtectedChatPage(readerRuntime, channelId, 0);
    assert.equal(timeline.first, 1);
    assert.deepEqual(timeline.messages.map(row => row.text), ['edition 2', 'epoch 2']);
    assert.equal(timeline.messages[1].replyTo, 1);
    assert.equal((await reader.readProtectedChatEdition(readerRuntime, channelId, 1)).revision, 2);
    await assert.rejects(reader.loadProtectedRuntimeKey(readerRuntime, channelId, 'archive', { policyTrust }),
      { code: 'PROTECTED_ACCESS_DENIED' });
    const ownerPackage = await request(data.owner.token, '/head', { keyId: archive.keyId });
    const { Epoch: { Record: archiveRecord }, Links: links } = await request(data.owner.token, '/links', { keyId: archive.keyId });
    assert.deepEqual(ownerPackage.Epoch.Record, archiveRecord);
    const signer = { profileId: data.owner.profileId, deviceId: data.owner.deviceId,
      key: createPublicKey((await client.identity()).device).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
    const archiveContext = packageContext(policyTrust.serverId, archiveRecord, data.owner.deviceId, data.owner.publicKey);
    assert.throws(() => openSignedEpochPackage(ownerPackage, archiveContext, privateKey(22), signer), { message: 'INVALID_EPOCH_PACKAGE' });
    const { secret: archiveSecret } = await client.loadProtectedRuntimeKey(ownerRuntime, channelId, 'archive', { policyTrust });
    const currentLive = await readLive(reader, liveDelivery);
    const previousLive = openSignedEpochPackage(data.firstDelivery, readerContext(data.firstDelivery), privateKey(22), signer);
    try {
      const source = { serverId: policyTrust.serverId, channelId, generation: archiveRecord.Generation, keyId: archiveRecord.KeyID };
      const recovered = openArchiveLinks(archiveSecret, source, links, archiveRecord.ArchiveLinksDigest);
      try {
        assert.ok(recovered.some(link => digest(link.secret) === data.firstLive.keyId));
        for (const retained of [currentLive, previousLive]) {
          assert.throws(() => openArchiveLinks(retained, source, links, archiveRecord.ArchiveLinksDigest), /authenticate/i);
        }
      } finally {
        for (const { secret } of recovered) secret.fill(0);
      }
    } finally {
      archiveSecret.fill(0);
      currentLive.fill(0);
      previousLive.fill(0);
    }
  }
  if (data.step >= 3) {
    const ownPastPackage = await pinnedFetch(`${data.base}/api/v3/keys/admitted/${channelId}/${data.firstLive.keyId}`, {
      headers: { Authorization: `Bearer ${readerRuntime.token}` }, pawtalkTLSFingerprint: data.fingerprint,
    });
    assert.equal(ownPastPackage.status, 403);
    const timeline = await reader.readProtectedChatPage(readerRuntime, channelId, 0);
    assert.equal(timeline.first, data.step === 3 ? 3 : 1);
    if (data.step === 3) {
      assert.deepEqual(timeline.messages.map(row => row.text), ['epoch 3']);
      assert.equal(timeline.messages[0].replyTo, null);
      const wire = await reader.readProtectedRuntimeText(readerRuntime, channelId);
      assert.equal(wire.messages[0].Packet.Reply, undefined);
      assert.match(wire.messages[0].Packet.ReplyDigest, /^[a-f0-9]{64}$/);
      await assert.rejects(reader.withCurrentProtectedChatPolicy(readerRuntime, options =>
        reader.sendProtectedRuntimeText(readerRuntime, channelId, 'hidden original', 'a'.repeat(32), options, 1)),
      { code: 'PROTECTED_ACCESS_DENIED' });
      await assert.rejects(reader.fetchProtectedRuntimeArchiveLinks(readerRuntime, channelId, archive.keyId),
        { code: 'PROTECTED_ACCESS_DENIED' });
    } else {
      assert.deepEqual(timeline.messages.map(row => row.text), ['edition 3', 'epoch 2', 'epoch 3', 'epoch 4']);
      assert.deepEqual(timeline.messages.map(row => row.replyTo), [undefined, 1, 1, 1]);
    }
  }
  if (data.step === 4) {
    windowMutation = window => {
      assert.equal(window.first, 1);
      return { ...window, first: 3, edits: window.edits.filter(edit => edit.position >= 3),
        pins: { ...window.pins, items: window.pins.items.filter(item => item.position >= 3) } };
    };
    try {
      const stalePage = await reader.readProtectedChatPage(readerRuntime, channelId, 0, '');
      assert.equal(stalePage.first, 3);
      assert.deepEqual(stalePage.messages, []);
      assert.equal(stalePage.retry, true);
    } finally {
      windowMutation = undefined;
    }
    for (const mutate of [
      delivery => { delete delivery.admissionPolicy; },
      delivery => { delivery.admissionPolicy = delivery.textPolicy; },
      delivery => { delivery.admissionPolicy.recipient.statement.firstPosition++; },
    ]) {
      historicalMutation = mutate;
      try {
        await assert.rejects(reader.readProtectedChatPage(readerRuntime, channelId, 2),
          { code: 'INVALID_CHANNEL_POLICY_PROOF' });
      } finally {
        historicalMutation = undefined;
      }
    }
    const head = await request(data.reader.token, '/head', { keyId: archive.keyId });
    const headContext = packageContext(policyTrust.serverId, head.Epoch.Record, data.reader.deviceId, data.reader.publicKey);
    let reads = 0;
    const initial = {
      policyTrust, fetchPolicyPage: readerPolicy, fetchEpochProofs: readerEpochProofs,
      channelId, targetGeneration: data.firstLive.generation,
      targetKeyId: data.firstLive.keyId, head, headContext, privateKey: privateKey(22),
      fetchLinks: (_channel, keyId) => { reads++; return request(data.reader.token, '/links', { keyId }); },
      pageLimit: 1,
    };
    const first = await reader.readProtectedArchiveKey(initial);
    assert.ok(first.cursor);
    assert.equal(reads, 1);
    const reloaded = new MembershipClient({ credentials: readerStore });
    const second = await reloaded.readProtectedArchiveKey({ ...initial, cursor: first.cursor });
    assert.ok(second.cursor);
    assert.equal(reads, 2);
    const third = await reloaded.readProtectedArchiveKey({ ...initial, cursor: second.cursor });
    assert.equal(digest(third.secret), data.firstLive.keyId);
    assert.equal(reads, 3);
    third.secret.fill(0);
    second.cursor.secret.fill(0);
    const previous = await initial.fetchLinks(initial.channelId, first.cursor.context.keyId);
    const previousDigest = digest(Buffer.from(previous.Epoch.Record.Signature, 'base64'));
    const historicalArchive = {
      ...initial, cursor: first.cursor, targetPurpose: 'archive', targetGeneration: previous.Epoch.Record.Generation,
      targetKeyId: previous.Epoch.Record.KeyID, targetEpochDigest: previousDigest,
    };
    const recovered = await reloaded.readProtectedArchiveKey(historicalArchive);
    assert.equal(digest(recovered.secret), historicalArchive.targetKeyId);
    const delivered = await revisionRequest(data.reader.token, '', 200);
    assert.equal(delivered.package, undefined);
    assert.equal(delivered.record.archive.Record.KeyID, historicalArchive.targetKeyId);
    const author = await client.identity();
    const authorPublic = createPublicKey(author.device).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    assert.equal(openProtectedRevisionForArchive(revisionContext(delivered.record, delivered.record.operationId, data.owner),
      delivered.record.packet, recovered.secret, authorPublic), 'edition 3');
    recovered.secret.fill(0);
    await assert.rejects(reloaded.readProtectedArchiveKey({ ...historicalArchive, targetEpochDigest: 'f'.repeat(64) }),
      { code: 'ARCHIVE_CHAIN_CONFLICT' });
    await assert.rejects(reader.readProtectedArchiveKey({
      ...initial, fetchLinks: async (channel, keyId) => {
        const delivery = await initial.fetchLinks(channel, keyId);
        delivery.Links[0].Ciphertext = Buffer.alloc(60).toString('base64');
        return delivery;
      },
    }), /INVALID_ARCHIVE_LINKS/);
    await assert.rejects(reader.readProtectedArchiveKey({
      ...initial, cursor: first.cursor, fetchLinks: async (channel, keyId) => {
        const delivery = await initial.fetchLinks(channel, keyId);
        delivery.Epoch.Principal = { DeviceID: data.reader.deviceId, ProfileID: data.reader.profileId };
        const { device } = await reader.identity();
        delivery.Epoch.Record.Signature = sign(null, epochSignatureFrame(policyTrust.serverId, data.reader.profileId,
          data.reader.deviceId, delivery.Epoch.Record), device).toString('base64');
        return delivery;
      },
    }), { code: 'UNTRUSTED_EPOCH_SIGNER' });
    const cold = new MembershipClient({ credentials: readerStore });
    await assert.rejects(cold.readProtectedArchiveKey({
      ...initial, cursor: first.cursor,
      fetchPolicyPage: async after => ({ ...await readerPolicy(after), headDigest: 'f'.repeat(64) }),
    }), { code: 'UNVERIFIED_EPOCH_POLICY' });
    first.cursor.secret.fill(0);
    const verified = await client.policyCheckpoint().load(policyTrust);
    await client.publishProtectedPolicyAttestation(ownerRuntime, verified.revision);
    const requestedPaths = [];
    let omitArchiveSigner = false;
    let injectRevisionRecipient = false;
    const scoped = new MembershipClient({ credentials: credentials('02', '66', data.reader, '16'), fetcher: async (url, options) => {
      const query = new URL(url);
      requestedPaths.push(query.pathname);
      const response = await pinnedFetch(url, options);
      if (response.ok && query.pathname === `/api/v3/history/revision/${channelId}/5/basis`) {
        assert.equal(query.searchParams.get('scoped'), '1');
        if (injectRevisionRecipient) {
          const basis = await response.json();
          basis.recipients.push({ id: data.owner.deviceId, publicKey: data.owner.publicKey });
          return Response.json(basis);
        }
      }
      if (response.ok && query.pathname.startsWith(`/api/v3/keys/archive/${channelId}/`)) {
        assert.equal(query.searchParams.get('scoped'), '1');
        if (omitArchiveSigner) {
          const delivery = await response.json();
          delete delivery.Epoch.signingPolicy;
          return Response.json(delivery);
        }
      }
      return response;
    } });
    const receipt = await scoped.withCurrentProtectedChatPolicy(readerRuntime, options =>
      scoped.sendProtectedRuntimeText(readerRuntime, channelId, 'scoped sender', 'a'.repeat(32), options));
    assert.deepEqual(receipt, { Position: 5, Existing: false });
    const own = await scoped.readProtectedChatPage(readerRuntime, channelId, 4);
    assert.deepEqual(own.messages.map(message => [message.position, message.text, message.own]), [[5, 'scoped sender', true]]);
    const history = await scoped.readProtectedChatPage(readerRuntime, channelId, 1);
    assert.deepEqual(history.messages.map(message => message.text), ['epoch 2', 'epoch 3', 'epoch 4', 'scoped sender']);
    const archivedEdit = await scoped.readProtectedChatEdition(readerRuntime, channelId, 1);
    assert.deepEqual([archivedEdit.position, archivedEdit.revision, archivedEdit.text], [1, 3, 'edition 3']);
    assert.ok(requestedPaths.some(path => path.startsWith(`/api/v3/keys/archive/${channelId}/`)));
    omitArchiveSigner = true;
    await assert.rejects(scoped.readProtectedChatPage(readerRuntime, channelId, 1), { code: 'UNVERIFIED_EPOCH_POLICY' });
    omitArchiveSigner = false;
    injectRevisionRecipient = true;
    const operation = 'f'.repeat(32);
    await assert.rejects(scoped.editProtectedChatMessage(readerRuntime, channelId, 5, 1, operation, 'scoped edition'),
      { code: 'UNVERIFIED_EPOCH_RECIPIENTS' });
    injectRevisionRecipient = false;
    const edited = await scoped.editProtectedChatMessage(readerRuntime, channelId, 5, 1, operation, 'scoped edition');
    assert.equal(edited.existing, false);
    assert.deepEqual(await scoped.editProtectedChatMessage(readerRuntime, channelId, 5, 1, operation, 'scoped edition'),
      { ...edited, existing: true });
    assert.equal((await scoped.readProtectedChatEdition(readerRuntime, channelId, 5)).text, 'scoped edition');
    assert.equal((await scoped.readProtectedPinnedMessage(readerRuntime, channelId, 1)).text, 'edition 3');
    await scoped.setProtectedMessagePin(readerRuntime, channelId, 1, false);
    assert.equal(await scoped.readProtectedPinnedMessage(readerRuntime, channelId, 1), undefined);
    await scoped.setProtectedMessagePin(readerRuntime, channelId, 1, true);
    await client.deleteProtectedMessage(ownerRuntime, channelId, 1);
    const deletedSource = await scoped.readProtectedRuntimeText(readerRuntime, channelId, { after: 0, limit: 3 });
    assert.deepEqual(deletedSource.messages.map(row => row.Position), [2, 3, 4]);
    assert.ok(deletedSource.messages.every(row => row.Packet.Reply === undefined && row.Packet.ReplyDigest));
    assert.deepEqual((await scoped.readProtectedPins(readerRuntime, channelId)).items, []);
    await assert.rejects(scoped.setProtectedMessagePin(readerRuntime, channelId, 1, true), { code: 'PROTECTED_ACCESS_DENIED' });
    assert.ok(!requestedPaths.includes('/api/v3/policy/proofs'));
    assert.equal(await scoped.policyCheckpoint().load(policyTrust), undefined);
  }
  process.stdout.write(JSON.stringify({ live, archive }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
