import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { labels } = createRequire(import.meta.url)('../electron/update-progress.cjs');
const execute = promisify(execFile);
test('real PowerShell helper reports phases, confirms startup and retains the installer on failure', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'voicecord helper '));
  const status = path.join(directory, 'installation.json');
  const installer = path.join(directory, 'synthetic setup.exe');
  const labelsFile = path.join(directory, 'labels.json');
  const ready = path.join(directory, 'ready');
  const source = `using System; using System.IO; using System.Threading;
    public class Setup { public static int Main(string[] args) {
      Thread.Sleep(400); int code=Int32.Parse(Environment.GetEnvironmentVariable("VC_FIXTURE_EXIT"));
      if(code!=0)return code;
      string p=Environment.GetEnvironmentVariable("VC_FIXTURE_STATUS");
      File.WriteAllText(p,File.ReadAllText(p).Replace("\\\"phase\\\":\\\"installing\\\"","\\\"phase\\\":\\\"launched\\\""));
      return 0;
    } }`;
  // This fixture is a tiny local program, not an installer or downloaded code.
  try {
    const cs = path.join(directory, 'fixture.cs');
    await writeFile(cs, source);
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition ([IO.File]::ReadAllText(${quote(cs)})) -OutputType ConsoleApplication -OutputAssembly ${quote(installer)}`], { windowsHide: true });
    await writeFile(labelsFile, JSON.stringify(labels.en));
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/install-update.ps1'),
      '-Installer', installer, '-ParentId', '2147483647', '-InstallDirectory', directory, '-Executable', installer,
      '-StatusFile', status, '-ReadyFile', ready, '-Token', 'fixture', '-Version', '0.1.1', '-LabelsFile', labelsFile, '-NoUi', '-StartupTimeout', '2'];
    const env = { ...process.env, VC_FIXTURE_STATUS: status, VC_FIXTURE_EXIT: '7' };
    await assert.rejects(execute('powershell.exe', args, { env, windowsHide: true, timeout: 10000 }));
    assert.equal(JSON.parse((await readFile(status, 'utf8')).replace(/^\uFEFF/, '')).phase, 'failed');
    await access(installer);
    assert.match(await readFile(path.join(directory, 'update-helper.log'), 'utf8'), /code 7/);
    await execute('powershell.exe', args, { env: { ...env, VC_FIXTURE_EXIT: '0' }, windowsHide: true, timeout: 10000 });
    assert.equal(JSON.parse((await readFile(status, 'utf8')).replace(/^\uFEFF/, '')).phase, 'complete');
    await assert.rejects(access(installer));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
