import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const env = { ...process.env, VOICECORD_UI_TEST_URL: pathToFileURL(path.resolve('dist/index.html')).href };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(createRequire(import.meta.url)('electron'), ['tests/updates-ui.cjs'], { env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error); process.exit(1); });
child.on('exit', code => process.exit(code || 0));
