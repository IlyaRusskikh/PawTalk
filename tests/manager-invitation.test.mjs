import { test } from 'node:test';
import assert from 'node:assert/strict';
import { managerInvitation } from '../shared/manager-invitation.mjs';

test('legacy Manager paste separates the password from the strict certificate pin', () => {
  const address = 'pawtalk://192.0.2.10:18443/' + 'a'.repeat(64);
  for (const separator of ['\n', '\r\n', '\\\n', '\\\r\n']) {
    assert.deepEqual(managerInvitation(address + separator + 'test-password'), { address, password: 'test-password' });
  }
  for (const value of [address, address + '\\password', address + '\nfirst\nsecond', address + '\n', address.slice(0,-1) + '\npassword', 'https://example.com\npassword']) {
    assert.equal(managerInvitation(value), null);
  }
});
