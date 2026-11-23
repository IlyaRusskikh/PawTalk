import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.join(tmpdir(), 'pawtalk-protected-selfhost-'));
let vite;
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.argv.some(argument => ['--voice-protection-status', '--voice-move', '--voice-moderation', '--voice-deafen-sustained', '--voice-deafen-rejoin'].includes(argument))) {
    const { createServer } = await import('vite');
    vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 } });
    await vite.listen();
    env.PAWTALK_UI_TEST_URL = `http://127.0.0.1:${vite.httpServer.address().port}`;
  }
  process.exitCode = await new Promise((resolve, reject) => {
    const executable = require('electron');
    const script = new URL('./protected-selfhost-smoke.cjs', import.meta.url);
    const child = spawn(executable, [fileURLToPath(script), directory, ...process.argv.slice(2)],
      { env, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
} finally {
  await vite?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
}
