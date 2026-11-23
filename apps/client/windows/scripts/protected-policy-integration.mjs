import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import process from 'node:process';
import { MembershipClient } from '../electron/membership-client.cjs';
import { CredentialStore } from '../electron/credentials.cjs';
import { signatureFrame } from '../../../../shared/framing.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { initial, latest, current, trust } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const records = new Map();
const credentials = {
  async load(id) { return records.get(id); },
  async save(id, value) { records.set(id, value); },
};
const client = new MembershipClient({ credentials });
const check = (page, expectedTrust = trust) => client.verifyProtectedPolicyPage(page, expectedTrust);
const expect = (page, code, expectedTrust) => assert.rejects(check(page, expectedTrust), { code });

await expect(initial, 'UNTRUSTED_POLICY_ANCHOR', { ...trust, anchorDigest: 'f'.repeat(64) });
await expect(initial, 'UNTRUSTED_POLICY_ANCHOR', { ...trust, ownerDeviceId: 'f'.repeat(64) });
const firstPage = { ...initial, headRevision: latest.headRevision, headDigest: latest.headDigest, snapshot: undefined };
assert.deepEqual(await check(firstPage), { revision: 1, digest: initial.headDigest, complete: false });
const afterAnchor = [...records.values()][0];
const digest = value => createHash('sha256').update(value).digest('hex');
const initialSnapshot = JSON.parse(Buffer.from(initial.proofs[0].snapshot, 'base64'));
const ownerDevice = Object.entries(initialSnapshot.PolicyDevices).find(([, signer]) => signer.ProfileID === trust.ownerProfileId);
const readerDevice = Object.entries(initialSnapshot.PolicyDevices).find(([, signer]) => signer.ProfileID !== trust.ownerProfileId);
const privateKey = seed => createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]),
  format: 'der', type: 'pkcs8',
});
const mutateSignedResult = (device, key, changeSnapshot, {
  template = latest.proofs[0], changeDraft = () => {}, prefix = [],
} = {}) => {
  const [deviceId, { ProfileID: profileId }] = device;
  const entry = structuredClone(template);
  const proof = JSON.parse(Buffer.from(entry.record, 'base64'));
  const snapshot = JSON.parse(Buffer.from(entry.snapshot, 'base64'));
  changeSnapshot(snapshot);
  entry.snapshot = Buffer.from(JSON.stringify(snapshot)).toString('base64');
  proof.Principal = { ProfileID: profileId, DeviceID: deviceId };
  proof.Draft.ResultDigest = digest(Buffer.from(entry.snapshot, 'base64'));
  const draft = proof.Draft;
  changeDraft(draft);
  const change = draft.DeviceChange;
  const fields = change ? [change.DeviceID, change.PublicKey, Buffer.from(change.Consent ?? '', 'base64').toString('base64url')] : [];
  if (entry.resourceChange !== undefined) fields.push(digest(Buffer.from(entry.resourceChange, 'base64')));
  const sig = sign(null, signatureFrame('pawtalk-protected-policy-v1', trust.serverId, profileId, deviceId,
    draft.Action, draft.OperationID, String(draft.Revision), draft.PreviousDigest, draft.ResultDigest,
    draft.PublicKey, digest(Buffer.from(entry.roleUpdate, 'base64')), ...fields), key);
  draft.Signature = sig.toString('base64');
  entry.record = Buffer.from(JSON.stringify(proof)).toString('base64');
  return { headRevision: draft.Revision, headDigest: digest(sig), proofs: [...prefix, entry] };
};
await expect(mutateSignedResult(readerDevice, privateKey(102), () => {}), 'UNAUTHORIZED_POLICY_TRANSITION');
await expect(mutateSignedResult(ownerDevice, privateKey(101), snapshot => {
  snapshot.RecoveryReady = { [readerDevice[1].ProfileID]: true };
}), 'UNAUTHORIZED_POLICY_TRANSITION');
const outsideKey = privateKey(103);
const rawOutsideKey = createPublicKey(outsideKey).export({ type: 'spki', format: 'der' }).subarray(-32);
const outsideId = digest(rawOutsideKey);
const outsideDevice = { ProfileID: trust.ownerProfileId, PublicKey: rawOutsideKey.toString('hex') };
await expect(mutateSignedResult([outsideId, outsideDevice], outsideKey, snapshot => {
  snapshot.PolicyDevices[outsideId] = outsideDevice;
}), 'UNTRUSTED_POLICY_SIGNER');
await expect(mutateSignedResult(ownerDevice, privateKey(101), () => {}, {
  template: latest.proofs[2],
  prefix: latest.proofs.slice(0, 2),
  changeDraft(draft) { draft.DeviceChange.Consent = Buffer.alloc(64).toString('base64'); },
}), 'INVALID_DEVICE_CONSENT');
const aclIndex = latest.proofs.findIndex(entry => JSON.parse(Buffer.from(entry.record, 'base64')).Draft.Action === 'channel.acl.update');
assert.ok(aclIndex > 0);
await expect(mutateSignedResult(readerDevice, privateKey(102), () => {}, {
  template: latest.proofs[aclIndex], prefix: latest.proofs.slice(0, aclIndex),
}), 'UNAUTHORIZED_POLICY_TRANSITION');
const wrongACLBytes = structuredClone(latest);
wrongACLBytes.proofs[aclIndex].resourceChange = Buffer.from('{}').toString('base64');
await expect(wrongACLBytes, 'INVALID_POLICY_PROOF');

const gap = { ...latest, proofs: latest.proofs.slice(1) };
await expect(gap, 'POLICY_CHAIN_GAP');
const tampered = structuredClone(latest);
const firstRecord = JSON.parse(Buffer.from(tampered.proofs[0].record, 'base64'));
firstRecord.Draft.Signature = Buffer.alloc(64).toString('base64');
tampered.proofs[0].record = Buffer.from(JSON.stringify(firstRecord)).toString('base64');
await expect(tampered, 'INVALID_POLICY_SIGNATURE');
await expect({ ...latest, snapshot: Buffer.from('{}').toString('base64') }, 'INVALID_POLICY_SNAPSHOT');
assert.equal([...records.values()][0], afterAnchor);

const reloaded = new MembershipClient({ credentials });
const advance = reloaded.verifyProtectedPolicyPage(latest, trust);
const racingRollback = assert.rejects(reloaded.verifyProtectedPolicyPage(initial, trust), { code: 'POLICY_ROLLBACK' });
assert.deepEqual(await advance,
  { revision: latest.headRevision, digest: latest.headDigest, complete: true });
await racingRollback;
await expect(initial, 'POLICY_ROLLBACK');
await expect({ ...current, headDigest: 'f'.repeat(64) }, 'POLICY_FORK');
assert.equal((await check(current)).complete, true);
await expect(mutateSignedResult([outsideId, outsideDevice], outsideKey, () => {}, {
  changeDraft(draft) {
    draft.Revision = current.headRevision + 1;
    draft.PreviousDigest = current.headDigest;
  },
}), 'UNTRUSTED_POLICY_SIGNER');

const failing = new MembershipClient({
  credentials: { load: async () => undefined, save: async () => { throw new Error('storage unavailable'); } },
});
await assert.rejects(failing.verifyProtectedPolicyPage(initial, trust), /storage unavailable/);
const unavailable = new MembershipClient({
  credentials: new CredentialStore('', { isEncryptionAvailable: async () => false }),
});
await assert.rejects(unavailable.verifyProtectedPolicyPage(initial, trust), { code: 'SECURE_STORAGE_UNAVAILABLE' });
console.log('PASS Go policy proof pages, Client continuity, restart checkpoint, known rollback and fork rejection');
