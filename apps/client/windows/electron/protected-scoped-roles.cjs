const { createHash, createPublicKey, sign, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { textRecipientBlind, profileRoleAuthorityProjectionVersion } = require('./protected-channel-policy-commitments.cjs');
const { scopedRoleRosterAlias } = require('./protected-role-roster.cjs');

const keyPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const invalid = () => Object.assign(new Error('INVALID_PROTECTED_ROLE_SIGNATURE'), { code: 'INVALID_PROTECTED_ROLE_SIGNATURE' });
const scopedRoleEditAction = 'roles.scoped';
const scopedRoleEditServerProof = 'pawtalk-protected-roles-edit-proof-v1';

function scopedRoleEditFrame(trust, actor, operationId, change) {
  if (!hex(trust?.serverId, 32) || !hex(trust.cutoverDigest, 64) || !hex(actor?.ProfileID, 64) || !hex(actor.DeviceID, 64) ||
      !hex(operationId, 32) || !Number.isSafeInteger(change?.revision) || change.revision < 1 || !hex(change.policyHead, 64)) throw invalid();
  const committedRoster = change.rosterCommitment !== undefined;
  if (committedRoster && (!hex(change.rosterCommitment, 64) || !hex(change.targetProfileId, 64))) throw invalid();
  const fields = [trust.serverId, trust.cutoverDigest, actor.ProfileID, actor.DeviceID, operationId, String(change.revision),
    change.policyHead, change.targetProfileId ?? '', committedRoster ? change.rosterCommitment : change.rosterChannelId ?? ''];
  const appendList = list => {
    if (!Array.isArray(list)) throw invalid();
    fields.push(String(list.length), ...list);
  };
  appendList(change.add ?? []);
  appendList(change.remove ?? []);
  appendList(change.delete ?? []);
  if (change.order === undefined) fields.push('-');
  else appendList(change.order);
  if (change.definitions === undefined) fields.push('-');
  else {
    if (!Array.isArray(change.definitions)) throw invalid();
    fields.push(String(change.definitions.length));
    for (const definition of change.definitions) {
      fields.push(definition.id);
      appendList(definition.grants ?? []);
      const presentation = definition.presentation;
      if (presentation) {
        if (['Hoist', 'Mentionable'].some(key => presentation[key] !== undefined && typeof presentation[key] !== 'boolean')) throw invalid();
        fields.push('1', presentation.Name, presentation.Color ?? '', presentation.Icon ?? '',
          String(presentation.Hoist ?? false), String(presentation.Mentionable ?? false));
      } else fields.push('0');
    }
  }
  const intent = createHash('sha256');
  for (const field of fields) intent.update(signatureFrame(field));
  return signatureFrame(committedRoster ? 'pawtalk-protected-roles-edit-v2' : 'pawtalk-protected-roles-edit-v1', intent.digest('hex'));
}

function signScopedRoleEdit(trust, actor, operationId, change, privateKey) {
  if (privateKey?.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519' ||
      hash(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32)) !== actor.DeviceID) throw invalid();
  return sign(null, scopedRoleEditFrame(trust, actor, operationId, change), privateKey).toString('base64url');
}

function verifyScopedRoleEdit(trust, actor, draft, previous, device, redacted = false) {
  const resource = draft.ResourceChange;
  const edit = resource?.RolesEdit;
  if (!edit || Object.keys(resource).length !== 2 || resource.ID !== '' || Object.keys(edit).length !== 4 ||
      edit.CutoverDigest !== trust.cutoverDigest || !previous || edit.Change?.revision !== previous.revision ||
      edit.Change.policyHead !== previous.digest || device?.ProfileID !== actor.ProfileID || device.Revoked ||
      !hex(device.PublicKey, 64) || typeof edit.EditorProof !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(edit.EditorProof)) throw invalid();
  const { rosterChannelId, rosterCommitment } = edit.Change;
  if (!redacted) {
    if (previous.textProjectionVersion === profileRoleAuthorityProjectionVersion && rosterChannelId) {
      if (!hex(previous.textProjectionSeed, 64) || !hex(rosterChannelId, 32)) throw invalid();
      const salt = textRecipientBlind(Buffer.from(previous.textProjectionSeed, 'hex'), Buffer.from(rosterChannelId), 30, '').toString('hex');
      if (scopedRoleRosterAlias(rosterChannelId, salt) !== rosterCommitment) throw invalid();
    } else if (rosterCommitment !== undefined) throw invalid();
  }
  const key = Buffer.from(device.PublicKey, 'hex');
  const proof = Buffer.from(edit.EditorProof, 'base64url');
  if (hash(key) !== actor.DeviceID || proof.toString('base64url') !== edit.EditorProof ||
      !verify(null, scopedRoleEditFrame(trust, actor, draft.OperationID, edit.Change),
        createPublicKey({ key: Buffer.concat([keyPrefix, key]), type: 'spki', format: 'der' }), proof)) throw invalid();
}

function verifyScopedRoleReceipt(trust, actor, request, receipt) {
  if (!receipt || Object.keys(receipt).length !== 5 || receipt.operationId !== request.operationId ||
      receipt.revision !== request.change.revision + 1 || !hex(receipt.digest, 64) ||
      typeof receipt.serverKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(receipt.serverKey) ||
      typeof receipt.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(receipt.signature)) throw invalid();
  const key = Buffer.from(receipt.serverKey, 'base64url');
  const proof = Buffer.from(receipt.signature, 'base64url');
  if (key.toString('base64url') !== receipt.serverKey || hash(key).slice(0, 32) !== trust.serverId ||
      proof.toString('base64url') !== receipt.signature) throw invalid();
  const frame = signatureFrame('pawtalk-protected-roles-receipt-v1', trust.serverId, trust.cutoverDigest, actor.ProfileID, actor.DeviceID,
    request.operationId, request.change.policyHead, String(receipt.revision), receipt.digest, request.signature);
  if (!verify(null, frame, createPublicKey({ key: Buffer.concat([keyPrefix, key]), type: 'spki', format: 'der' }), proof)) throw invalid();
}

module.exports = { scopedRoleEditAction, scopedRoleEditServerProof, signScopedRoleEdit, verifyScopedRoleEdit, verifyScopedRoleReceipt };
