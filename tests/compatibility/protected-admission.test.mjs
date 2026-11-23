import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { test } from 'node:test';
import { signatureFrame } from '../../shared/framing.mjs';

const publicID = key => key.export({ type: 'spki', format: 'der' }).toString('base64url');

function invitationFrame(invitation) {
  return signatureFrame('pawtalk-prototype-invitation', invitation.server, invitation.id,
    invitation.expires, invitation.uses, publicID(invitation.redemptionKey));
}

function redemptionFrame(invitation, redemption) {
  return signatureFrame('pawtalk-prototype-redemption', invitation.server, invitation.id,
    redemption.id, redemption.profile, redemption.deviceCertificate);
}

test('a signed invitation redemption is bound to one device identity', () => {
  const issuer = generateKeyPairSync('ed25519');
  const link = generateKeyPairSync('ed25519');
  const otherLink = generateKeyPairSync('ed25519');
  const invitation = {
    server: 'server-id',
    id: 'invitation-id',
    expires: '3600000',
    uses: '1',
    redemptionKey: link.publicKey,
  };
  const redemption = {
    id: 'redemption-id',
    profile: 'profile-id',
    deviceCertificate: 'bound-device-certificate',
  };
  const issued = sign(null, invitationFrame(invitation), issuer.privateKey);
  const redeemed = sign(null, redemptionFrame(invitation, redemption), link.privateKey);
  assert.equal(verify(null, invitationFrame(invitation), issuer.publicKey, issued), true);
  assert.equal(verify(null, redemptionFrame(invitation, redemption), invitation.redemptionKey, redeemed), true);

  const otherInvite = { ...invitation, redemptionKey: otherLink.publicKey };
  assert.equal(verify(null, invitationFrame(otherInvite), issuer.publicKey, issued), false);
  const mutations = [
    { ...redemption, id: 'other-id' },
    { ...redemption, profile: 'other-profile' },
    { ...redemption, deviceCertificate: 'other-certificate' },
  ];
  for (const changed of mutations) {
    assert.equal(verify(null, redemptionFrame(invitation, changed), invitation.redemptionKey, redeemed), false);
  }
  const anotherServer = { ...invitation, server: 'another-server' };
  assert.equal(verify(null, redemptionFrame(anotherServer, redemption), invitation.redemptionKey, redeemed), false);
  assert.equal(verify(null, invitationFrame({ ...invitation, uses: '2' }), issuer.publicKey, issued), false);
});
