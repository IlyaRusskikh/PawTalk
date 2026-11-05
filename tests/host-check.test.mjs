import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
const { HostCheck, parseResult } = createRequire(import.meta.url)('../electron/host-check.cjs');
const prefix = 'VOICECORD_PREFLIGHT_RESULT:';
function child() {
  const process = new EventEmitter();
  process.stdin = new PassThrough(); process.stdout = new PassThrough(); process.stderr = new PassThrough();
  process.kill = () => { process.emit('close', 1); };
  return process;
}
test('host check accepts only complete structured results and cannot turn partial results green', () => {
  assert.equal(parseResult('PASS: TCP opened'), null);
  assert.deepEqual(parseResult(prefix + '{"state":"internet","tcp":[true,true],"udp":true}'), { state: 'internet', tcp: [true, true], udp: true });
  for (const bad of ['{}', '{"state":"internet","tcp":[true,false],"udp":true}', '{"state":"internet","tcp":[true,true],"udp":false}']) assert.throws(() => parseResult(prefix + bad));
});
test('host check isolates arguments, waits for cleanup/exit and blocks concurrent checks', async () => {
  const process = child(); let launch;
  const check = new HostCheck('C:\\App Folder\\check.ps1', (...args) => { launch = args; return process; });
  assert.throws(() => check.start('18443; command'), /порт/);
  const result = check.start(18443);
  assert.equal(launch[2].windowsHide, true);
  assert.ok(launch[1].includes('-Application'));
  assert.ok(launch[1].includes('C:\\App Folder\\check.ps1'));
  assert.throws(() => check.start(18444), /уже/);
  process.stdout.write('diagnostic output\n' + prefix + '{"state":"internet",');
  process.stdout.write('"tcp":[true,true],"udp":true}\r\n');
  assert.equal(check.running, true, 'result alone must not release ports before the process exits');
  process.emit('close', 0);
  assert.equal((await result).state, 'internet');
  assert.equal(check.running, false);
});
test('host check cancellation signals stdin and waits for worker cleanup', async () => {
  const process = child(); const check = new HostCheck('check.ps1', () => process);
  let input = ''; process.stdin.on('data', data => { input += data; });
  const result = check.start(18443);
  const cancelled = check.cancel();
  assert.equal(input, 'q\n');
  assert.equal(check.running, true);
  process.emit('close', 0);
  await cancelled;
  assert.equal((await result).state, 'cancelled');
  assert.equal(check.running, false);
});
test('host check rejects missing output instead of reporting local-only connectivity', async () => {
  const process = child(); const check = new HostCheck('check.ps1', () => process);
  const result = check.start(18443);
  process.emit('close', 0);
  await assert.rejects(result, /результат/);
});
