import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {reviewServerOptions, reviewServerPaths} from '../scripts/review-server.mjs';

test('native server review accepts isolated profiles, port groups and advertised IPs', () => {
  assert.deepEqual(reviewServerOptions([]), {profile: '', port: 28443, ip: '127.0.0.1', stop: false});
  assert.deepEqual(reviewServerOptions(['--profile=phone', '--port', '32443', '--ip=192.168.1.10', '--stop']),
    {profile: 'phone', port: 32443, ip: '192.168.1.10', stop: true});
  const files = reviewServerPaths('phone');
  assert.equal(path.basename(files.directory), 'review-server-phone');
  assert.equal(path.dirname(files.data), files.directory);
  assert.equal(path.dirname(files.runtime), files.directory);
  assert.notEqual(files.directory, reviewServerPaths('').directory);
});
test('review cannot redirect its data to installed profiles or accept invalid port groups', () => {
  for (const args of [['--profile', '..'], ['--profile=../Manager'], ['--data-dir', 'C:/ProgramData'],
    ['--port=65533'], ['--port=0'], ['--port=NaN'], ['--ip=0.0.0.0'], ['--ip=host.example'],
    ['--profile'], ['--port='], ['--stop=true'], ['--profile=a=b']]) assert.throws(() => reviewServerOptions(args), args.join(' '));
  assert.throws(() => reviewServerPaths('../installed'));
});
