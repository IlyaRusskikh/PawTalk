import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['tests/e2ee-main.cjs'], { env, windowsHide: true, stdio: 'inherit' });
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code || 0; });
