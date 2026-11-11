import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const secretLabel = 'Секретный ключ (не публикуйте; только для участников комнаты): ';
const idLabel = 'Публичный отпечаток (SHA-256 key ID, для сервера): ';
for (const engine of ['node','powershell.exe','pwsh.exe']) {
  test(`${engine} generator returns a participant secret and raw server fingerprint without env assignments`,{skip:engine !== 'node' && process.platform !== 'win32'},async () => {
    const command = engine === 'node' ? process.execPath : engine;
    const script = fileURLToPath(new URL(engine === 'node' ? '../scripts/e2ee-key.mjs' : '../scripts/e2ee-key.ps1',import.meta.url));
    const args = engine === 'node' ? [script] : ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script];
    const {stdout} = await execute(command,args,{windowsHide:true,encoding:'utf8',timeout:15000});
    const lines = stdout.trim().split(/\r?\n/);
    assert.equal(lines.length,2,'generator outputs exactly two values');
    assert.ok(lines[0].startsWith(secretLabel),'localized secret label');
    assert.ok(lines[1].startsWith(idLabel),'localized fingerprint label');
    const secret = lines[0].slice(secretLabel.length),id = lines[1].slice(idLabel.length);
    assert.ok(/^[a-f0-9]{64}$/.test(secret),'secret is a raw 256-bit value');
    assert.ok(/^[a-f0-9]{64}$/.test(id),'fingerprint is a raw SHA-256 hex value');
    assert.equal(id,createHash('sha256').update(Buffer.from(secret,'hex')).digest('hex'));
    assert.equal(stdout.includes('PAWTALK_E2EE'),false,'no legacy env assignments');
  });
}
test('standalone CMD wrapper preserves readable Cyrillic labels and no env lines',{skip:process.platform !== 'win32'},() => {
  const script = fileURLToPath(new URL('../scripts/e2ee-key.cmd',import.meta.url));
  const output = spawnSync('cmd.exe',['/d','/c',script],{input:'\r\n',encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(output.status,0,output.error?.message || output.stderr);
  const lines = output.stdout.trim().split(/\r?\n/);
  assert.ok(lines[0].startsWith(secretLabel),'CMD secret label is readable');
  assert.ok(lines[1].startsWith(idLabel),'CMD fingerprint label is readable');
  assert.equal(output.stdout.includes('PAWTALK_E2EE'),false);
});
