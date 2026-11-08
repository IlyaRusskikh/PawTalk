import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../node_modules/electron/install.js', import.meta.url));
const attempts = 5;

for (let attempt = 1; attempt <= attempts; attempt++) {
  console.log(`Installing Electron binary (attempt ${attempt}/${attempts})...`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installer], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', value => resolve(value ?? 1));
  });

  if (code === 0) process.exit(0);
  if (attempt === attempts) {
    console.error(`Electron binary installation failed after ${attempts} attempts.`);
    process.exit(code || 1);
  }

  const waitSeconds = attempt * 10;
  console.warn(`Electron download failed; retrying in ${waitSeconds}s.`);
  await delay(waitSeconds * 1000);
}
