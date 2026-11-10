// Opt-in external-network check. Prepare current server binaries first with
// npm run server:prepare. Downloads the public installer, but never executes it.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = ['scripts/update-live-smoke.cjs', '--selfhost'];
if (process.argv.includes('--metadata-only')) args.push('--metadata-only');
const child = spawn(createRequire(import.meta.url)('electron'), args, {
  env, stdio: 'inherit', windowsHide: true,
});
child.on('error', error => { console.error(error); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));
