import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const contract = require('../shared/membership.cjs');

test('cross-language framing has explicit UTF-8 lengths and no delimiter ambiguity', () => {
  const frame = contract.signatureFrame('pawtalk', 'Привет', '', 'a\nb');
  assert.equal(Buffer.from(frame).toString('hex'), '0000000770617774616c6b0000000cd09fd180d0b8d0b2d0b5d1820000000000000003610a62');
  assert.notDeepEqual(contract.signatureFrame('a', 'bc'), contract.signatureFrame('ab', 'c'));
  assert.throws(() => contract.signatureFrame('x'.repeat(65533)), RangeError);
  assert.throws(() => contract.signatureFrame(null), TypeError);
});

test('Go/JS API version, capabilities and deadlines remain identical', async () => {
  const go = await readFile(new URL('../server/membership_protocol.go', import.meta.url), 'utf8');
  assert.match(go, /membershipProtocol\s*=\s*2/);
  for (const [name, expected] of [['Challenge', contract.policy.challengeSeconds], ['Session', contract.policy.sessionSeconds], ['Reservation', contract.policy.reservationSeconds], ['Link', contract.policy.linkSeconds]]) {
    assert.match(go, new RegExp(`membership${name}Seconds\\s*=\\s*${expected}\\b`));
  }
  for (const capability of contract.capabilities) assert.ok(go.includes(JSON.stringify(capability)));
  assert.equal(contract.apiProtocolVersion, 2);
  assert.ok(!contract.permissions.member.includes('invite.create'));
  assert.ok(contract.permissions.moderator.includes('invite.revoke.own'));
  assert.ok(!contract.permissions.moderator.includes('member.kick'));
  const digest = createHash('sha256').update(contract.signatureFrame('a', 'bc')).digest('hex');
  assert.equal(digest.length, 64);
});
