const { deviceAgreementKeySlot } = require('./protected-device-agreement.cjs');

const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const fail = code => Object.assign(Error(code), { code });
const local = () => fail('INVALID_LOCAL_DEVICE_BINDING');
const bindingKey = (challenge, deviceId) => `${challenge.serverId}:${challenge.cutoverDigest}:${deviceId}`;
const pendingSlot = (challenge, deviceId) => `pawtalk:device-binding-pending:v1:${bindingKey(challenge, deviceId)}:${challenge.operationId}`;
const floorSlot = (challenge, deviceId) => `pawtalk:device-binding-floor:v1:${bindingKey(challenge, deviceId)}`;

function readObject(encoded) {
  if (encoded == null) return;
  if (typeof encoded !== 'string' || encoded.length > 4096) throw local();
  let result;
  try { result = JSON.parse(encoded); } catch { throw local(); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw local();
  return result;
}

class ProtectedDeviceBindingStorage {
  constructor(credentials) {
    this.credentials = credentials;
    this.running = new Map();
  }

  serialize(challenge, deviceId, action) {
    const slot = deviceAgreementKeySlot(challenge.serverId, deviceId);
    const pending = (this.running.get(slot) ?? Promise.resolve()).catch(() => {}).then(action);
    this.running.set(slot, pending);
    return pending.finally(() => {
      if (this.running.get(slot) === pending) this.running.delete(slot);
    });
  }

  async pending(challenge, deviceId, cardDigest) {
    const attempt = readObject(await this.credentials.load(pendingSlot(challenge, deviceId), { required: true }));
    if (attempt && (attempt.cardDigest !== cardDigest || !hex(attempt.agreementSeed, 64) || !attempt.proposal)) throw local();
    return attempt;
  }

  async savePending(challenge, deviceId, attempt) {
    await this.credentials.save(pendingSlot(challenge, deviceId), JSON.stringify(attempt));
  }

  async #floor(challenge, deviceId) {
    const previous = readObject(await this.credentials.load(floorSlot(challenge, deviceId), { required: true }));
    if (previous && (!Number.isSafeInteger(previous.revision) || previous.revision < 2 ||
        !hex(previous.digest, 64) || !hex(previous.operationId, 32) || !hex(previous.cardDigest, 64) || !previous.proposal)) throw local();
    return previous;
  }

  async completed(challenge, deviceId, cardDigest) {
    const previous = await this.#floor(challenge, deviceId);
    if (previous?.operationId !== challenge.operationId) return;
    if (previous.cardDigest !== cardDigest) throw local();
    return previous.proposal;
  }

  async promote(challenge, receipt, { cardDigest, proposal, agreementSeed, clearPending }) {
    const { deviceId, revision, digest, operationId } = receipt;
    const previous = await this.#floor(challenge, deviceId);
    if (previous && revision < previous.revision) throw fail('POLICY_ROLLBACK');
    if (previous && revision === previous.revision &&
        (digest !== previous.digest || operationId !== previous.operationId || cardDigest !== previous.cardDigest)) throw fail('POLICY_FORK');
    // Record the verified receipt first. After a crash the pending seed can
    // still be installed under this receipt, while older replies remain stale.
    if (!previous || revision > previous.revision) {
      await this.credentials.save(floorSlot(challenge, deviceId), JSON.stringify({ revision, digest, operationId, cardDigest, proposal }));
    }
    if (agreementSeed !== undefined) await this.credentials.save(deviceAgreementKeySlot(challenge.serverId, deviceId), agreementSeed);
    if (clearPending) await this.credentials.save(pendingSlot(challenge, deviceId), null);
  }
}

module.exports = { ProtectedDeviceBindingStorage };
