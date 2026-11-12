import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Each language/motion combination uses a fresh actual main/preload process.
for (const language of ['ru', 'en']) for (const reduced of ['0', '1']) {
  const env = { ...process.env, PAWTALK_TEST_LANGUAGE: language, PAWTALK_TEST_REDUCED: reduced, PAWTALK_TEST_E2EE: reduced };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), ['scripts/selfhost-main-smoke.cjs'], { env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
  if (code !== 0) process.exit(code);
}
