import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function ciScope(component = 'all') {
  if (!['all', 'client', 'server', 'manager'].includes(component)) throw Error('Unknown CI component: ' + component);
  return {
    component,
    client: component === 'all' || component === 'client',
    server: component === 'all' || component === 'server',
    manager: component === 'all' || component === 'manager',
    host: component !== 'client',
    publishedServer: component === 'client' || component === 'manager',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = ciScope(process.argv[2] ?? 'all');
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(plan).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  console.log(JSON.stringify(plan));
}
