// API 2 contracts are independent of Client, Server and Manager release numbers.
const apiProtocolVersion = 2;
const dataSchemaVersion = 2;
const capabilities = Object.freeze(['membership-v1', 'channels-v1', 'device-links-v1', 'invites-v1', 'mandatory-e2ee-v1']);
const policy = Object.freeze({
  challengeSeconds: 60, sessionSeconds: 43200, reservationSeconds: 120,
  singleInviteSeconds: 86400, reusableInviteSeconds: 3600, bootstrapSeconds: 86400,
  linkSeconds: 600, maxSingleInvites: 100, maxReusableInvites: 100,
  mediaTokenSeconds: 60, presenceSeconds: 45,
});
const permissions = Object.freeze({
  member: Object.freeze(['chat.read', 'chat.write', 'voice.join']),
  moderator: Object.freeze(['chat.read', 'chat.write', 'voice.join', 'invite.create', 'invite.revoke.own']),
  admin: Object.freeze(['chat.read', 'chat.write', 'voice.join', 'invite.create', 'invite.revoke.own', 'invite.revoke.any', 'channel.manage', 'role.manage', 'member.kick', 'member.ban']),
});

const { signatureFrame } = require('./framing.mjs');

module.exports = { apiProtocolVersion, dataSchemaVersion, capabilities, policy, permissions, signatureFrame };
