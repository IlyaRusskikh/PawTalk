import { createServer } from 'vite';
import './prepare-rnnoise.mjs';
// UI iteration can reuse the already prepared server binaries.
if (!process.argv.includes('--skip-server-build')) await import('./prepare-server.mjs');
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const server = await createServer();
await server.listen();
const env = { ...process.env, VOICECORD_DEV_URL: 'http://127.0.0.1:5173' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['.'], { stdio: 'inherit', env });
child.on('exit', async code => { await server.close(); process.exit(code || 0); });
process.on('SIGINT', () => child.kill());
