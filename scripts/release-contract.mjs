import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { releasePlan, channelFor } = createRequire(import.meta.url)('../shared/release.cjs');
export async function versions() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url)));
  if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) throw Error('Client package versions differ');
  return { client: pkg.version, server: (await readFile(new URL('../server/VERSION', import.meta.url), 'utf8')).trim(),
    manager: (await readFile(new URL('../manager/VERSION', import.meta.url), 'utf8')).trim() };
}
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const plan = releasePlan(process.argv[2] || process.env.GITHUB_REF_NAME, await versions());
  console.log(JSON.stringify({...plan,channel:channelFor(plan.version,process.env[`PAWTALK_${plan.component.toUpperCase()}_CHANNEL`] || 'preview')}));
}
