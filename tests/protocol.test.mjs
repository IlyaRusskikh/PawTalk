import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { protocol } = createRequire(import.meta.url)('../shared/protocol.cjs');
test('new Client accepts published 0.8.0 and protocol 1, rejects breaking protocol explicitly', () => {
  assert.equal(protocol({e2eeRequired:false, profileChallenge:'legacy'}).version, 1);
  assert.deepEqual(protocol({apiProtocolVersion:1,capabilities:['chat-v2',null]}).capabilities, ['chat-v2']);
  for (const apiProtocolVersion of [0,2,'1',null]) {
    assert.throws(() => protocol({apiProtocolVersion}), {code:'PAWTALK_PROTOCOL'});
  }
  for (const invalid of [null,[],false,'legacy']) assert.throws(() => protocol(invalid),{code:'PAWTALK_PROTOCOL'});
});
