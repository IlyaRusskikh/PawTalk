const { createHash, createPublicKey, verify } = require('node:crypto');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { verifyTextRecipientDisclosure, textRevisionProjectionVersion, hasTextRecipientProjection,
  voiceRecipientProjectionVersion, verifyVoiceRecipientDisclosure } = require('./protected-channel-policy-commitments.cjs');
const { voiceRosterDigest } = require('./protected-voice-keys.cjs');
const { scopeAuthorityRequiresV2 } = require('./protected-scope-authority.cjs');

const hex = (value, width) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${width}}$`).test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = code => Object.assign(new Error(code), { code });
const prefix = Buffer.from('302a300506032b6570032100', 'hex');
const slot = trust => `pawtalk:protected-policy-scope:v1:${trust.serverId}`;
const authorityFields = ['authorityHead', 'authorityRevision', 'signerDeviceId', 'signerProfileId'];

function whereSigned(view) {
  if (!authorityFields.some(field => Object.hasOwn(view, field))) return;
  const { authorityHead, authorityRevision, signerDeviceId, signerProfileId } = view;
  if (!hex(authorityHead, 64) || !positive(authorityRevision) || authorityRevision <= 1 || !hex(signerDeviceId, 64) ||
      (Object.hasOwn(view, 'signerProfileId') && !hex(signerProfileId, 64))) {
    throw fail('INVALID_POLICY_ATTESTATION');
  }
  return { authorityHead, authorityRevision, signerDeviceId, ...(signerProfileId !== undefined && { signerProfileId }) };
}

function policyAttestationFrame(trust, view) {
  if (!hex(trust?.serverId, 32) || ![trust.anchorDigest, trust.ownerProfileId, trust.ownerDeviceId].every(value => hex(value, 64)) ||
      !positive(view?.revision) || ![view.digest, view.policyDigest, view.root].every(value => hex(value, 64)) ||
      (view.projectionVersion !== undefined && (!hasTextRecipientProjection(view.projectionVersion) || view.projectionVersion < textRevisionProjectionVersion)) ||
      (view.revision === 1 ? view.previous !== '' || view.digest !== trust.anchorDigest : !hex(view.previous, 64))) {
    throw fail('INVALID_POLICY_ATTESTATION');
  }
  const authority = whereSigned(view);
  const fields = [trust.serverId, trust.anchorDigest, authority?.signerProfileId ?? trust.ownerProfileId, authority?.signerDeviceId ?? trust.ownerDeviceId,
    String(view.revision), view.digest, view.previous, view.policyDigest, String(view.projectionVersion ?? 3), view.root];
  return authority
    ? signatureFrame('pawtalk-policy-scope-attestation-v2', ...fields, authority.authorityHead, String(authority.authorityRevision))
    : signatureFrame('pawtalk-policy-scope-attestation-v1', ...fields);
}

function authorityAt(authority, digest) {
  return authority?.state?.digest === digest ? authority.state : authority?.prefixes?.get(digest);
}

function verifyPolicyAttestation(trust, view, authority) {
  const frame = policyAttestationFrame(trust, view);
  const scope = whereSigned(view);
  if (!hex(view.signerKey, 64) || typeof view.signature !== 'string' || view.signature.length !== 88) {
    throw fail('INVALID_POLICY_ATTESTATION');
  }
  if (scope) {
    const signer = authorityAt(authority, scope.authorityHead);
    if (!signer || signer.digest !== scope.authorityHead || !positive(signer.sequence) || signer.revision !== scope.authorityRevision ||
        signer.deviceId !== scope.signerDeviceId || signer.deviceKey !== view.signerKey ||
        (signer.ownerProfileId ?? trust.ownerProfileId) !== (scope.signerProfileId ?? trust.ownerProfileId)) throw fail('INVALID_POLICY_ATTESTATION');
  }
  const bytes = Buffer.from(view.signerKey, 'hex');
  const signature = Buffer.from(view.signature, 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== (scope?.signerDeviceId ?? trust.ownerDeviceId) || signature.length !== 64 ||
      signature.toString('base64') !== view.signature ||
      !verify(null, frame, createPublicKey({ key: Buffer.concat([prefix, bytes]), type: 'spki', format: 'der' }), signature)) {
    throw fail('INVALID_POLICY_ATTESTATION');
  }
  const { revision, digest, previous, policyDigest, root, signerKey, projectionVersion } = view;
  return { revision, digest, previous, policyDigest, root, signerKey, signature: view.signature,
    ...(projectionVersion !== undefined && { projectionVersion }), ...scope };
}

const commitmentFields = ['revision', 'digest', 'previous', 'policyDigest', 'root', 'projectionVersion'];

class ProtectedPolicyAttestationCheckpoint {
  constructor(credentials) {
    this.credentials = credentials;
    this.pending = new Map();
  }

  acceptCurrent(trust, view, authority, inviteDescendants) {
    const key = slot(trust);
    const run = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const candidate = verifyPolicyAttestation(trust, view, authority);
      if (candidate.authorityHead !== undefined && authority?.state?.digest !== candidate.authorityHead ||
          candidate.authorityHead === undefined && scopeAuthorityRequiresV2(trust, authority?.state)) throw fail('POLICY_ROLLBACK');
      const raw = await this.credentials.load(key, { required: true });
      if (raw != null) {
        let saved, previousScope;
        try {
          saved = JSON.parse(raw);
          policyAttestationFrame(trust, saved);
          previousScope = whereSigned(saved);
        } catch { throw fail('INVALID_LOCAL_POLICY_ATTESTATION'); }
        if (previousScope) {
          if (!candidate.authorityHead || candidate.authorityRevision < previousScope.authorityRevision) throw fail('POLICY_ROLLBACK');
          if (!authorityAt(authority, previousScope.authorityHead)) throw fail('POLICY_FORK');
        }
        let previous;
        try { previous = verifyPolicyAttestation(trust, saved, authority); }
        catch { throw fail('INVALID_LOCAL_POLICY_ATTESTATION'); }
        if (candidate.revision < previous.revision) {
          const receipt = inviteDescendants?.get(previous.revision);
          if (!receipt) throw fail('POLICY_ROLLBACK');
          if (receipt.digest !== previous.digest || receipt.previousDigest !== previous.previous || receipt.resultDigest !== previous.policyDigest ||
              receipt.projectionRoot !== previous.root || previous.projectionVersion !== candidate.projectionVersion) {
            throw fail('POLICY_FORK');
          }
          return candidate;
        }
        if (candidate.revision === previous.revision) {
          if (candidate.signature === previous.signature) return previous;
          if ((candidate.authorityRevision ?? 0) <= (previous.authorityRevision ?? 0) ||
              commitmentFields.some(field => candidate[field] !== previous[field])) throw fail('POLICY_FORK');
        }
        if ((candidate.projectionVersion ?? 3) < (previous.projectionVersion ?? 3)) throw fail('POLICY_ROLLBACK');
        if (candidate.revision === previous.revision + 1 && candidate.previous !== previous.digest) throw fail('POLICY_FORK');
      }
      await this.credentials.save(key, JSON.stringify(candidate));
      return candidate;
    });
    this.pending.set(key, run);
    return run.finally(() => {
      if (this.pending.get(key) === run) this.pending.delete(key);
    });
  }
}

function verifyAttestedTextAdmission(view, channelId, disclosure, recipient) {
  if (!hex(channelId, 32) || disclosure?.channelId !== channelId || disclosure.revision !== view.revision ||
      disclosure.policyDigest !== view.policyDigest) throw fail('UNVERIFIED_EPOCH_POLICY');
  const statement = verifyTextRecipientDisclosure(view.root, channelId, disclosure, recipient, view.projectionVersion);
  if (statement.profileId !== recipient.profileId) throw fail('UNVERIFIED_EPOCH_RECIPIENT');
  return statement;
}

function verifyAttestedVoiceRoster(view, basis, roster, disclosure) {
  if (!hasTextRecipientProjection(view?.projectionVersion) || view.projectionVersion < voiceRecipientProjectionVersion ||
      !hex(basis?.channelId, 32) || basis.revision !== view.revision || basis.policyDigest !== view.policyDigest ||
      basis.rosterDigest !== voiceRosterDigest(roster)) {
    throw fail('UNVERIFIED_EPOCH_POLICY');
  }
  try {
    return verifyVoiceRecipientDisclosure(view.root, basis.channelId, roster, disclosure, view.projectionVersion);
  } catch (error) {
    if (error.code === 'INVALID_CHANNEL_POLICY_PROOF') throw fail('UNVERIFIED_VOICE_ROSTER');
    throw error;
  }
}

module.exports = { PolicyAttestationCheckpoint: ProtectedPolicyAttestationCheckpoint, policyAttestationFrame,
  verifyPolicyAttestation, verifyAttestedTextAdmission, verifyAttestedVoiceRoster };
