import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

{
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)('electron'), ['tests/update-layout.cjs'], { env, windowsHide: true, stdio: ['ignore','pipe','pipe'], timeout: 60000 });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve,reject) => { child.on('error',reject); child.on('exit',resolve); });
  assert.equal(code, 0, output);
  console.log(output.trim());
}
