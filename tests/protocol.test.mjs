import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { protocol } = createRequire(import.meta.url)('../shared/protocol.cjs');
test('API 2 accepts its explicit contract and rejects missing, legacy and unknown protocols', () => {
  assert.throws(() => protocol({profileChallenge:'legacy'}), {code:'PAWTALK_PROTOCOL'});
  assert.deepEqual(protocol({apiProtocolVersion:2,capabilities:['membership-v1',null]}).capabilities, ['membership-v1']);
  for (const apiProtocolVersion of [0,1,3,'2',null]) {
    assert.throws(() => protocol({apiProtocolVersion}), {code:'PAWTALK_PROTOCOL'});
  }
  for (const invalid of [null,[],false,'legacy']) assert.throws(() => protocol(invalid),{code:'PAWTALK_PROTOCOL'});
});
