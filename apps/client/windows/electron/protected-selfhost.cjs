const { createHash, createPublicKey, randomBytes, sign } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { signatureFrame } = require('../../../../shared/membership.cjs');
const { deviceAgreementPrivateKey } = require('./protected-device-agreement.cjs');
const { protectedPolicySignatureFrame, verifyPolicyTextProjection } = require('./protected-policy-checkpoint.cjs');
const { policyAttestationFrame } = require('./protected-policy-attestation.cjs');
const { replayPolicyTransition } = require('./protected-policy-replay.cjs');
const { voiceRecipientProjectionVersion, channelSettingsProjectionVersion, profileRoleAuthorityProjectionVersion } =
  require('./protected-channel-policy-commitments.cjs');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const id = (value, size = 64) => typeof value === 'string' && value.length === size && /^[0-9a-f]+$/.test(value);
const invalid = () => Object.assign(new Error('INVALID_PROTECTED_SELFHOST'), { code: 'INVALID_PROTECTED_SELFHOST' });
const certificateFields = ['serverId', 'binding', 'cutoverDigest', 'ownerProfileId', 'ownerDeviceId'];
const defaultGrants = ['channel.view', 'history.full', 'profile.edit-self', 'message.send', 'message.attach', 'message.voice',
  'poll.create', 'poll.vote', 'checklist.create', 'checklist.check', 'voice.connect', 'voice.speak'].sort();
const naming = (value, limit) => typeof value === 'string' && value !== '' && value === value.trim() &&
  [...value].length <= limit && !/[\p{Cc}\p{Cs}]/u.test(value);

function verifyInitialSnapshot(snapshot, input, actor) {
  const { ProfileID, DeviceID } = actor;
  const { Members, PolicyDevices, KeyRecipients, Roles, Channels, Admissions } = snapshot;
  if (snapshot.Owner !== ProfileID || snapshot.PolicyAnchored !== false ||
      !isDeepStrictEqual(Members, { [ProfileID]: { ID: ProfileID, Roles: null, Active: true, TimeoutUntil: 0 } }) ||
      !isDeepStrictEqual(PolicyDevices, { [DeviceID]: { ProfileID, PublicKey: input.deviceKey } }) ||
      !isDeepStrictEqual(KeyRecipients, { [DeviceID]: { ProfileID, Kind: 'device', PublicKey: input.agreementKey } }) ||
      Object.keys(Roles ?? {}).length !== 1 || !Array.isArray(Roles['@everyone']?.Grants) ||
      !isDeepStrictEqual([...Roles['@everyone'].Grants].sort(), defaultGrants) ||
      ['Order', 'Categories', 'CategoryNames', 'CategoryCreators', 'CategoryOrder', 'RecoveryReady', 'RetiredRecipientKeys',
        'RecoveryIdentities', 'RetiredRecoverySigningKeys',
        'RetiredChannels', 'VoiceRestrictions', 'InvitationUses', 'MemberRemovals', 'InheritedBanLifts', 'EpochWindows', 'ArchiveHeads',
        'RolePresentation'].some(key => Object.keys(snapshot[key] ?? {}).length)) throw invalid();
  const channels = Object.entries(Channels ?? {});
  if (channels.length !== 2 || channels.map(([, channel]) => channel.Kind).sort().join(',') !== 'text,voice' ||
      channels.some(([channelId, channel]) => !id(channelId, 32) || channel.CategoryID !== '' || channel.Synchronized !== false ||
        channel.NextPosition !== 0 || Object.values(channel.ACL ?? {}).some(value => Object.keys(value ?? {}).length) ||
        !naming(channel.Settings?.Name, 64) || channel.Settings.Description !== '' || channel.Settings.SlowmodeSeconds !== 0 ||
        channel.Settings.VoiceCapacity !== (channel.Kind === 'voice' ? 30 : 0))) throw invalid();
  const text = channels.find(([, channel]) => channel.Kind === 'text')[0];
  const voice = channels.find(([, channel]) => channel.Kind === 'voice')[0];
  if (!isDeepStrictEqual(snapshot.ChannelOrder, [text, voice]) ||
      !isDeepStrictEqual(Admissions, { [text]: { [ProfileID]: { FirstPosition: 1 } } })) throw invalid();
}

function prepareProtectedSelfHost(identity, nickname, deviceLabel) {
  if (!naming(nickname, 32) || !naming(deviceLabel, 64)) throw invalid();
  const profileKey = Buffer.from(identity.profileKey, 'base64url').toString('hex');
  const deviceKey = Buffer.from(identity.deviceKey, 'base64url').toString('hex');
  if (!id(profileKey) || !id(deviceKey) || profileKey === deviceKey ||
      digest(Buffer.from(profileKey, 'hex')) !== identity.profileId || digest(Buffer.from(deviceKey, 'hex')) !== identity.deviceId) throw invalid();
  const seed = randomBytes(32);
  const agreement = deviceAgreementPrivateKey(seed.toString('hex'));
  const agreementKey = createPublicKey(agreement).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const input = Object.freeze({ profileKey, deviceKey, agreementKey, nickname, deviceLabel });
  let accepted;
  let cleared = false;
  return {
    input,
    authorize(offer) {
      const { fingerprint, protected: bootstrap } = offer ?? {};
      const { serverId, binding, cutoverDigest, ownerProfileId, ownerDeviceId, draft, snapshot } = bootstrap ?? {};
      if (cleared || accepted || !id(fingerprint) || !id(serverId, 32) || !id(binding) || !id(cutoverDigest) ||
          ownerProfileId !== identity.profileId || ownerDeviceId !== identity.deviceId ||
          draft?.Action !== 'policy.anchor' || draft.Revision !== 1 || draft.PreviousDigest !== '' ||
          !id(draft.OperationID, 32) || !id(draft.ResultDigest) || draft.PublicKey !== '' || draft.RoleUpdate !== null ||
          draft.Signature !== null || draft.DeviceChange !== undefined || draft.ResourceChange !== undefined ||
          ![voiceRecipientProjectionVersion, channelSettingsProjectionVersion, profileRoleAuthorityProjectionVersion].includes(draft.TextProjectionVersion) ||
          typeof snapshot !== 'string' || snapshot.length > 32 * 1024) throw invalid();
      const bytes = Buffer.from(snapshot, 'base64');
      const cutoverFrame = signatureFrame('pawtalk-selfhost-cutover-v1', serverId, fingerprint, binding,
        ownerProfileId, ownerDeviceId, agreementKey, draft.ResultDigest);
      if (bytes.toString('base64') !== snapshot || digest(bytes) !== draft.ResultDigest || digest(cutoverFrame) !== cutoverDigest) {
        throw invalid();
      }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const actor = { ProfileID: ownerProfileId, DeviceID: ownerDeviceId };
      verifyInitialSnapshot(value, input, actor);
      replayPolicyTransition(undefined, value, actor, draft, ownerProfileId);
      verifyPolicyTextProjection(draft, value);
      const policySignature = sign(null, protectedPolicySignatureFrame(serverId, actor, draft, Buffer.from('null')), identity.device);
      const ownerFrame = signatureFrame('pawtalk-selfhost-owner-v1', serverId, fingerprint, binding, cutoverDigest,
        ownerProfileId, ownerDeviceId, agreementKey, draft.ResultDigest);
      const anchorDigest = digest(policySignature);
      const trust = { serverId, cutoverDigest, ownerProfileId, ownerDeviceId, anchorDigest };
      const scopeFrame = policyAttestationFrame(trust, { revision: 1, digest: anchorDigest, previous: '',
        policyDigest: draft.ResultDigest, root: draft.TextProjectionRoot, projectionVersion: draft.TextProjectionVersion });
      accepted = { fingerprint, binding, trust };
      return {
        policySignature: policySignature.toString('base64url'),
        profileSignature: identity.signProfile(ownerFrame).toString('base64url'),
        scopeAttestation: sign(null, scopeFrame, identity.device).toString('base64url'),
      };
    },
    confirm(receipt) {
      if (cleared || !accepted || receipt?.fingerprint !== accepted.fingerprint || !receipt.protected ||
          certificateFields.some(key => receipt.protected[key] !== (key === 'binding' ? accepted.binding : accepted.trust[key])) ||
          receipt.protected.anchorDigest !== accepted.trust.anchorDigest) throw invalid();
      return { ...accepted, agreementSeed: seed.toString('hex') };
    },
    pending() {
      if (cleared || !accepted) throw invalid();
      return { ...accepted, agreementSeed: seed.toString('hex') };
    },
    clear() { cleared = true; seed.fill(0); },
  };
}

module.exports = { prepareProtectedSelfHost };
