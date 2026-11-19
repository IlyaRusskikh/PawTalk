import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { HostError, hostResult } = createRequire(import.meta.url)('../electron/host-errors.cjs');

test('hosting IPC preserves expected user errors and hides raw platform failures', async () => {
  assert.deepEqual(await hostResult(async()=>42,'fallback'),{value:42});
  assert.deepEqual(await hostResult(()=>{throw new HostError('Порты комнаты заняты.');},'fallback'),{error:'Порты комнаты заняты.'});
  assert.deepEqual(await hostResult(async()=>{throw Error('EACCES internal/path');},'Не удалось создать комнату.'),{error:'Не удалось создать комнату.'});
});
