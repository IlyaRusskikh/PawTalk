const { app } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { waitForHelper, helperLaunch } = require('../electron/update-progress.cjs');
app.whenReady().then(async () => {
  const directory = process.env.PAWTALK_HANDOFF_DIRECTORY;
  const ready = path.join(directory, 'ready');
  const done = path.join(directory, 'done');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const script = `[IO.File]::WriteAllText(${quote(ready)},'test-token'); while(Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue){Start-Sleep -Milliseconds 100}; [IO.File]::WriteAllText(${quote(done)},'survived')`;
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawn(powershell, helperLaunch(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], directory),
    { detached: false, windowsHide: true, stdio: 'ignore' });
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await waitForHelper(ready, 'test-token', child, 5000);
    child.unref(); app.quit();
  } catch (error) { console.error(error); child.kill(); app.exit(1); }
});
