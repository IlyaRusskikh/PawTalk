import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const server = await createServer({ server: { host: '127.0.0.1', port: 5189, strictPort: true } });
await server.listen();
const env = { ...process.env, VOICECORD_UI_TEST_URL: 'http://127.0.0.1:5189' }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(createRequire(import.meta.url)('electron'), ['tests/chat-ui.cjs'], { env, windowsHide: true, stdio: 'inherit' });
child.on('error', async error => { console.error(error); await server.close(); process.exit(1); });
child.on('exit', async code => { await server.close(); process.exit(code || 0); });
