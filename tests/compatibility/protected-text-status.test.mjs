import { test } from 'node:test';
import assert from 'node:assert/strict';
import status from '../../apps/client/windows/electron/protected-text-status.cjs';

const { validateProtectedTextWindow, classifyProtectedTextStatus, protectedTextWindowMaxAgeMs } = status;
const serverId = '12'.repeat(16), channelId = '23'.repeat(16), policyHead = '34'.repeat(32);
const currentKeyId = '45'.repeat(32), previousKeyId = '56'.repeat(32);
const window = { policyRevision: 7, policyHead, serverNow: 50_000, currentGeneration: 3, previousGeneration: 0,
  currentCutoff: 0, previousCutoff: 0, needsFresh: false, currentKeyId };
const policy = { revision: 7, head: policyHead, canSend: true };
const key = { generation: 3, keyId: currentKeyId };
const oldKey = { generation: 2, keyId: previousKeyId };
const previousGrace = { ...window, previousGeneration: 2, previousCutoff: 50_250 };
const base = { serverId, channelId, online: true, window, receivedAt: 180, now: 200, policy, key };
const classify = overrides => classifyProtectedTextStatus({ ...base, ...overrides });

test('window validates deployment wire invariants without carrying queue or access flags', () => {
  assert.deepEqual(validateProtectedTextWindow({ ...window, queue: 42, canSend: true }), window);
  assert.deepEqual(validateProtectedTextWindow(previousGrace), previousGrace);
  for (const invalid of [
    { policyRevision: 0 }, { policyHead: 'b' }, { serverNow: Number.MAX_SAFE_INTEGER + 1 }, { serverNow: -1 },
    { needsFresh: 0 }, { currentGeneration: 0 }, { currentKeyId: undefined }, { currentCutoff: 110_001 },
    { previousGeneration: 1 }, { previousGeneration: 1, previousCutoff: 50_100 },
  ]) assert.throws(() => validateProtectedTextWindow({ ...window, ...invalid }), { code: 'INVALID_PROTECTED_TEXT_WINDOW' });
});

test('matching signed policy and a verified current key give green independent of queue and send permission', () => {
  assert.deepEqual(classify(), { state: 'green', reason: 'CURRENT_VERIFIED', allowSend: true });
  assert.deepEqual(classify({ window: { ...window, queue: 99 }, policy: { ...policy, canSend: false } }),
    { state: 'green', reason: 'CURRENT_VERIFIED', allowSend: false });
  assert.equal(classify({ policy: { ...policy, canSend: undefined } }).allowSend, false);
  assert.deepEqual(classify({ key: { ...key, keyId: previousKeyId } }), { state: 'red', reason: 'KEY_CONFLICT', allowSend: false });
});

test('raw status, mismatched signed head and expired observations can never authorize sending', () => {
  for (const overrides of [
    { policy: undefined }, { policy: { ...policy, head: 'f'.repeat(64) } }, { policy: { ...policy, revision: 6 } },
  ]) assert.deepEqual(classify(overrides), { state: 'grey', reason: 'POLICY_UNVERIFIED', allowSend: false });
  assert.deepEqual(classify({ window: {} }), { state: 'grey', reason: 'WINDOW_UNVERIFIED', allowSend: false });
  for (const now of [undefined, 179, 180 + protectedTextWindowMaxAgeMs + 1]) {
    assert.deepEqual(classify({ now }), { state: 'grey', reason: 'WINDOW_STALE', allowSend: false });
  }
});

test('verified current and previous grace are yellow until the server-relative cutoff', () => {
  const current = { ...window, currentCutoff: 50_250 };
  assert.deepEqual(classify({ window: current, now: 429.9 }), { state: 'yellow', reason: 'CURRENT_GRACE', allowSend: true });
  assert.deepEqual(classify({ window: current, now: 430 }), { state: 'red', reason: 'CUTOFF_EXPIRED', allowSend: false });
  assert.deepEqual(classify({ window: previousGrace }), { state: 'yellow', reason: 'PREVIOUS_GRACE', allowSend: true });
  assert.deepEqual(classify({ window: previousGrace, key: oldKey }), { state: 'yellow', reason: 'PREVIOUS_GRACE', allowSend: true });
  assert.equal(classify({ window: previousGrace, key: oldKey, now: 430 }).state, 'red');
  assert.equal(classify({ window: previousGrace, now: 430 }).state, 'green');
});

test('missing and fresh-key-pending states cannot send and distinguish an exhausted cutoff', () => {
  const first = { ...window, currentGeneration: 0, currentKeyId: undefined };
  assert.deepEqual(classify({ window: first, key: undefined }), { state: 'yellow', reason: 'CURRENT_KEY_PENDING', allowSend: false });
  assert.deepEqual(classify({ window: { ...window, needsFresh: true } }),
    { state: 'yellow', reason: 'FRESH_KEY_PENDING', allowSend: false });
  assert.equal(classify({ window: { ...previousGrace, needsFresh: true }, key: oldKey }).allowSend, false);
  assert.deepEqual(classify({ window: previousGrace, key: undefined, keyState: 'pending', now: 430 }),
    { state: 'yellow', reason: 'CURRENT_KEY_PENDING', allowSend: false });
  assert.deepEqual(classify({ window: previousGrace, key: undefined, keyState: 'unavailable', now: 430 }),
    { state: 'red', reason: 'CUTOFF_EXPIRED', allowSend: false });
  assert.equal(classify({ window: previousGrace, key: undefined, now: 430 }).state, 'yellow');
});

test('network loss preserves only a known definite failure for the same server and channel', () => {
  assert.deepEqual(classify({ online: false }), { state: 'grey', reason: 'OFFLINE', allowSend: false });
  for (const reason of ['SERVER_BINDING_INVALID', 'POLICY_PROOF_INVALID', 'KEY_PROOF_INVALID', 'CUTOFF_EXPIRED']) {
    assert.deepEqual(classify({ online: false, knownFailure: { serverId, channelId, reason } }), { state: 'red', reason, allowSend: false });
  }
  for (const failure of [{ serverId: channelId, channelId, reason: 'KEY_PROOF_INVALID' },
    { serverId, channelId: serverId, reason: 'KEY_PROOF_INVALID' }, { serverId, channelId, reason: 'ECONNRESET' }]) {
    assert.equal(classify({ online: false, knownFailure: failure }).state, 'grey');
  }
});
