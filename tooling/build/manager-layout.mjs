// Source layout is independent of the immutable launcher/bundle protocol 1 paths.
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

const modules = ['__init__', 'release', 'config', 'runtime', 'controller', 'preflight', 'bundles', 'cli', 'platforms', 'native', 'admission'];
export const managerSourceFiles = {
  'manager/VERSION': 'apps/manager/VERSION',
  'manager/trust.json': 'apps/manager/linux/trust.json',
  'manager/pawtalkctl': 'apps/manager/linux/pawtalkctl',
  'manager/launcher': 'apps/manager/linux/launcher',
  ...Object.fromEntries(['compose.server.yaml', 'pawtalk-update.service', 'pawtalk-update.timer', 'pawtalk-health.service', 'pawtalk-health.timer'].map(name => ['manager/' + name, 'apps/manager/linux/deploy/' + name])),
  ...Object.fromEntries(modules.map(name => ['manager/pawtalk_manager/' + name + '.py', 'apps/manager/linux/pawtalk_manager/' + name + '.py'])),
  'LICENSE': 'LICENSE',
  'THIRD_PARTY_NOTICES.md': 'THIRD_PARTY_NOTICES.md',
};

export async function stageManagerSource(root, destination) {
  for (const [installed, source] of Object.entries(managerSourceFiles)) {
    const output = path.join(destination, installed);
    await mkdir(path.dirname(output), { recursive: true });
    await cp(path.join(root, source), output);
  }
}
