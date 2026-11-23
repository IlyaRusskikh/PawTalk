const protectedTextWindowMaxAgeMs = 15_000;
const graceMillis = 60_000;

const protectedTextStatusReasons = Object.freeze({
  CURRENT_VERIFIED: 'CURRENT_VERIFIED',
  CURRENT_GRACE: 'CURRENT_GRACE',
  PREVIOUS_GRACE: 'PREVIOUS_GRACE',
  FRESH_KEY_PENDING: 'FRESH_KEY_PENDING',
  CURRENT_KEY_PENDING: 'CURRENT_KEY_PENDING',
  CUTOFF_EXPIRED: 'CUTOFF_EXPIRED',
  KEY_PROOF_INVALID: 'KEY_PROOF_INVALID',
  POLICY_PROOF_INVALID: 'POLICY_PROOF_INVALID',
  SERVER_BINDING_INVALID: 'SERVER_BINDING_INVALID',
  KEY_CONFLICT: 'KEY_CONFLICT',
  OFFLINE: 'OFFLINE',
  WINDOW_UNVERIFIED: 'WINDOW_UNVERIFIED',
  WINDOW_STALE: 'WINDOW_STALE',
  POLICY_UNVERIFIED: 'POLICY_UNVERIFIED',
});

const reasons = protectedTextStatusReasons;
const definiteFailures = new Set([reasons.KEY_PROOF_INVALID, reasons.POLICY_PROOF_INVALID, reasons.SERVER_BINDING_INVALID,
  reasons.KEY_CONFLICT, reasons.CUTOFF_EXPIRED]);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const result = (state, reason, allowSend = false) => ({ state, reason, allowSend });

function validateProtectedTextWindow(value) {
  const { policyRevision, policyHead, serverNow, currentGeneration, previousGeneration, currentCutoff, previousCutoff,
    needsFresh, currentKeyId } = value ?? {};
  if (!integer(policyRevision) || policyRevision === 0 || !hex(policyHead, 64) || !integer(serverNow) || serverNow === 0 ||
      ![currentGeneration, previousGeneration, currentCutoff, previousCutoff].every(integer) ||
      typeof needsFresh !== 'boolean' || (currentGeneration === 0 && (currentCutoff !== 0 || currentKeyId !== undefined)) ||
      (currentGeneration > 0 && !hex(currentKeyId, 64)) ||
      (previousCutoff === 0 ? previousGeneration !== 0 : currentGeneration < 2 || previousGeneration !== currentGeneration - 1) ||
      currentCutoff - serverNow > graceMillis || previousCutoff - serverNow > graceMillis) {
    throw Object.assign(new Error('INVALID_PROTECTED_TEXT_WINDOW'), { code: 'INVALID_PROTECTED_TEXT_WINDOW' });
  }
  return { policyRevision, policyHead, serverNow, currentGeneration, previousGeneration, currentCutoff, previousCutoff,
    needsFresh, ...(currentKeyId !== undefined && { currentKeyId }) };
}

// Policy and key describe facts already verified by the caller. The window is
// operational metadata and on its own never authorizes sending.
function classifyProtectedTextStatus({ serverId, channelId, online, window, receivedAt, now, policy, key, keyState, knownFailure } = {}) {
  if (hex(serverId, 32) && hex(channelId, 32) && knownFailure?.serverId === serverId && knownFailure.channelId === channelId &&
      definiteFailures.has(knownFailure.reason)) return result('red', knownFailure.reason);
  if (online !== true) return result('grey', reasons.OFFLINE);
  try { window = validateProtectedTextWindow(window); }
  catch { return result('grey', reasons.WINDOW_UNVERIFIED); }

  const elapsed = now - receivedAt;
  if (!Number.isFinite(now) || !Number.isFinite(receivedAt) || receivedAt < 0 || elapsed < 0 || elapsed > protectedTextWindowMaxAgeMs ||
      window.serverNow > Number.MAX_SAFE_INTEGER - elapsed) return result('grey', reasons.WINDOW_STALE);
  if (policy?.revision !== window.policyRevision || policy.head !== window.policyHead) return result('grey', reasons.POLICY_UNVERIFIED);

  const serverNow = window.serverNow + elapsed;
  const currentGrace = window.currentCutoff > serverNow;
  const previousGrace = window.previousCutoff > serverNow;
  const currentExpired = window.currentCutoff !== 0 && !currentGrace;
  const previousExpired = window.previousCutoff !== 0 && !previousGrace;
  const validKey = integer(key?.generation) && key.generation > 0 && hex(key.keyId, 64);
  const currentKey = validKey && key.generation === window.currentGeneration;
  const previousKey = validKey && key.generation === window.previousGeneration;
  if (currentKey && key.keyId !== window.currentKeyId) return result('red', reasons.KEY_CONFLICT);
  const currentUsable = currentKey && !window.needsFresh && !currentExpired;
  const previousUsable = previousKey && !window.needsFresh && previousGrace;
  const allowSend = policy.canSend === true && (currentUsable || previousUsable);

  if (currentGrace || previousGrace) {
    return result('yellow', currentGrace ? reasons.CURRENT_GRACE : reasons.PREVIOUS_GRACE, allowSend);
  }
  if (currentUsable) return result('green', reasons.CURRENT_VERIFIED, allowSend);
  if (currentExpired || (previousExpired && (previousKey || keyState === 'unavailable'))) {
    return result('red', reasons.CUTOFF_EXPIRED);
  }
  return result('yellow', window.needsFresh ? reasons.FRESH_KEY_PENDING : reasons.CURRENT_KEY_PENDING);
}

module.exports = { protectedTextStatusReasons, protectedTextWindowMaxAgeMs, validateProtectedTextWindow, classifyProtectedTextStatus };
