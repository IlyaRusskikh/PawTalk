import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const env = { ...process.env, PAWTALK_CHAT_ACCEPTANCE: '1', PAWTALK_CAPTURE_DIR: 'release/qa/chat-main' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(createRequire(import.meta.url)('electron'), ['scripts/capture-docs.cjs'], { env, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exit(1); });
child.on('exit', code => process.exit(code || 0));
