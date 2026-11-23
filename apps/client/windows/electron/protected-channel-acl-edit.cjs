const { createHash, createPublicKey, sign, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { permissionFitsACL } = require('../../../../shared/protected-access.mjs');
const { channelACLProjectionVersion, channelACLRoleRules, channelACLRulesDigest } = require('./protected-channel-policy-commitments.cjs');
const { validAuthorityKey } = require('./protected-scope-authority.cjs');

const action = 'channel.acl.roles.scoped';
const serverProofDomain = 'pawtalk-protected-channel-acl-roles-edit-proof-v1';
const personalAction = 'channel.acl.personal.scoped';
const personalServerProof = 'pawtalk-protected-channel-acl-personal-edit-proof-v1';
const spki = Buffer.from('302a300506032b6570032100', 'hex');
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => Object.assign(new Error('INVALID_PROTECTED_CHANNEL_ACL_EDIT'), { code: 'INVALID_PROTECTED_CHANNEL_ACL_EDIT' });

function aclEditBasisFields(trust, actor, basis, operationId) {
  if (!hex(trust?.serverId, 32) || !hex(trust.cutoverDigest, 64) || !hex(actor?.ProfileID, 64) || !hex(actor.DeviceID, 64) ||
      !hex(operationId, 32) || !Number.isSafeInteger(basis?.revision) || basis.revision < 1 || !hex(basis.digest, 64) ||
      !hex(basis.channelId, 32) || typeof basis.categoryId !== 'string' || /\p{Cs}/u.test(basis.categoryId)) throw invalid();
  return [trust.serverId, trust.cutoverDigest, actor.ProfileID, actor.DeviceID, operationId, String(basis.revision),
    basis.digest, basis.channelId, basis.kind, basis.categoryId];
}

function aclRoleEditFrame(trust, actor, basis, rules, operationId) {
  return aclRoleEditDigestFrame(trust, actor, basis, operationId,
    channelACLRulesDigest(basis.kind, basis.rules), channelACLRulesDigest(basis.kind, rules));
}

function aclRoleEditDigestFrame(trust, actor, basis, operationId, previousRulesDigest, nextRulesDigest) {
  if (!hex(previousRulesDigest, 64) || !hex(nextRulesDigest, 64)) throw invalid();
  return signatureFrame('pawtalk-protected-channel-acl-roles-edit-v1', ...aclEditBasisFields(trust, actor, basis, operationId),
    previousRulesDigest, nextRulesDigest);
}

function signACLIntent(frame, actor, device) {
  if (device?.type !== 'private' || device.asymmetricKeyType !== 'ed25519' ||
      digest(createPublicKey(device).export({ type: 'spki', format: 'der' }).subarray(-32)) !== actor.DeviceID) throw invalid();
  return sign(null, frame, device).toString('base64url');
}

function signProtectedChannelACLRoleEdit(trust, actor, basis, rules, operationId, device) {
  return signACLIntent(aclRoleEditFrame(trust, actor, basis, rules, operationId), actor, device);
}

function verifyRoleACLIntentSignature(trust, actor, basis, operationId, previousRulesDigest, nextRulesDigest, editorProof, signingKey) {
  if (!validAuthorityKey(signingKey) || !/^[A-Za-z0-9_-]{86}$/.test(editorProof)) throw invalid();
  const signature = Buffer.from(editorProof, 'base64url');
  const rawKey = Buffer.from(signingKey, 'hex');
  const frame = aclRoleEditDigestFrame(trust, actor, basis, operationId, previousRulesDigest, nextRulesDigest);
  if (signature.toString('base64url') !== editorProof || signature.length !== 64 || digest(rawKey) !== actor.DeviceID) throw invalid();
  const key = createPublicKey({ key: Buffer.concat([spki, rawKey]), type: 'spki', format: 'der' });
  if (!verify(null, frame, key, signature)) throw invalid();
}

function verifyProtectedChannelACLRoleEdit(trust, actor, draft, previous, snapshot, signingKey) {
  const change = draft?.ResourceChange;
  const claim = change?.ACLRoleEdit;
  const channel = Object.hasOwn(snapshot?.Channels ?? {}, change?.ID) && snapshot.Channels[change.ID];
  if (draft?.Action !== action || !channel || !claim || Object.keys(claim).length !== 4 || claim.CutoverDigest !== trust.cutoverDigest ||
      !(previous?.textProjectionVersion >= channelACLProjectionVersion) || draft.PreviousDigest !== previous.digest ||
      draft.Revision !== previous.revision + 1 ||
      !/^[A-Za-z0-9_-]{43}$/.test(claim.ServerKey)) throw invalid();
  const acl = channel.Synchronized ? snapshot.Categories?.[channel.CategoryID] : channel.ACL;
  const rules = channelACLRoleRules(acl?.Roles, channel.Kind);
  const basis = { revision: previous.revision, digest: previous.digest, channelId: change.ID, kind: channel.Kind,
    categoryId: channel.CategoryID ?? '', rules };
  if (claim.PreviousRulesDigest !== channelACLRulesDigest(channel.Kind, rules)) throw invalid();
  verifyRoleACLIntentSignature(trust, actor, basis, draft.OperationID, claim.PreviousRulesDigest,
    channelACLRulesDigest(channel.Kind, change.ACL?.Roles), claim.EditorProof, signingKey);
}

function aclPersonalEditFrame(trust, actor, basis, target, permission, rule, operationId) {
  if (!hex(target, 64) || !permissionFitsACL(permission, basis.kind) || !['allow', 'deny', 'inherit'].includes(rule)) throw invalid();
  return signatureFrame('pawtalk-protected-channel-acl-personal-edit-v1', ...aclEditBasisFields(trust, actor, basis, operationId),
    target, permission, rule);
}

function signProtectedChannelACLPersonalEdit(trust, actor, basis, target, permission, rule, operationId, device) {
  return signACLIntent(aclPersonalEditFrame(trust, actor, basis, target, permission, rule, operationId), actor, device);
}

function verifyPersonalACLIntentSignature(trust, actor, basis, target, permission, rule, operationId, editorProof, signingKey) {
  if (!validAuthorityKey(signingKey) || !/^[A-Za-z0-9_-]{86}$/.test(editorProof)) throw invalid();
  const signature = Buffer.from(editorProof, 'base64url');
  const rawKey = Buffer.from(signingKey, 'hex');
  const frame = aclPersonalEditFrame(trust, actor, basis, target, permission, rule, operationId);
  if (signature.length !== 64 || signature.toString('base64url') !== editorProof || digest(rawKey) !== actor.DeviceID) throw invalid();
  const key = createPublicKey({ key: Buffer.concat([spki, rawKey]), type: 'spki', format: 'der' });
  if (!verify(null, frame, key, signature)) throw invalid();
}

function verifyProtectedChannelACLPersonalEdit(trust, actor, draft, previous, snapshot, signingKey) {
  const change = draft?.ResourceChange;
  const claim = change?.ACLPersonalEdit;
  const channel = Object.hasOwn(snapshot?.Channels ?? {}, change?.ID) && snapshot.Channels[change.ID];
  if (draft?.Action !== personalAction || !channel || !claim || Object.keys(claim).length !== 5 || claim.CutoverDigest !== trust.cutoverDigest ||
      !(previous?.textProjectionVersion >= channelACLProjectionVersion) || draft.PreviousDigest !== previous.digest ||
      draft.Revision !== previous.revision + 1 || !/^[A-Za-z0-9_-]{43}$/.test(claim.ServerKey)) throw invalid();
  const basis = { revision: previous.revision, digest: previous.digest, channelId: change.ID, kind: channel.Kind,
    categoryId: channel.CategoryID ?? '' };
  verifyPersonalACLIntentSignature(trust, actor, basis, change.TargetProfileID, claim.Permission, claim.Rule,
    draft.OperationID, claim.EditorProof, signingKey);
}

module.exports = { scopedACLRoleEditAction: action, scopedACLRoleEditServerProof: serverProofDomain,
  signProtectedChannelACLRoleEdit, verifyProtectedChannelACLRoleEdit, scopedACLPersonalEditAction: personalAction,
  scopedACLPersonalEditServerProof: personalServerProof, signProtectedChannelACLPersonalEdit, verifyProtectedChannelACLPersonalEdit,
  verifyPersonalACLIntentSignature, verifyRoleACLIntentSignature };
