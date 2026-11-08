import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PAWTALK_DEV_URL;
const child = spawn(createRequire(import.meta.url)('electron'), ['tests/fixes-main.cjs'], { env, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exit(1); });
child.on('exit', code => process.exit(code || 0));
