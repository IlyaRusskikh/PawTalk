import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../node_modules/electron/install.js', import.meta.url));
const sources = [
  { name: 'npmmirror', mirror: process.env.ELECTRON_MIRROR || 'https://cdn.npmmirror.com/binaries/electron/' },
  { name: 'GitHub releases', mirror: null },
];
const attemptsPerSource = 2;
let attempt = 0;

for (const source of sources) {
  for (let sourceAttempt = 1; sourceAttempt <= attemptsPerSource; sourceAttempt++) {
    attempt++;
    const env = { ...process.env };
    if (source.mirror) env.ELECTRON_MIRROR = source.mirror;
    else delete env.ELECTRON_MIRROR;

    console.log(`Installing Electron from ${source.name} (attempt ${sourceAttempt}/${attemptsPerSource})...`);
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [installer], { env, stdio: 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', value => resolve(value ?? 1));
    });

    if (code === 0) process.exit(0);
    if (attempt === sources.length * attemptsPerSource) {
      console.error(`Electron binary installation failed after trying ${sources.map(item => item.name).join(' and ')}.`);
      process.exit(code || 1);
    }

    const waitSeconds = sourceAttempt * 10;
    console.warn(`Electron download failed; retrying in ${waitSeconds}s.`);
    await delay(waitSeconds * 1000);
  }
}
