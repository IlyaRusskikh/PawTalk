import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { selectReleases, components, requiredAssets, repository } from './release-catalog.mjs';
const root = path.resolve(import.meta.dirname, '../website');
const catalog = selectReleases(components.map(component => {
  const tag_name = `${component}-v1.0.0`;
  return { tag_name, draft: false, prerelease: true, published_at: '2026-01-01T00:00:00Z',
    assets: requiredAssets(component, '1.0.0').map(name => ({ name, state: 'uploaded', size: 1, browser_download_url: `https://github.com/${repository}/releases/download/${tag_name}/${name}` })) };
}));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/releases.json')) {
      if (url.pathname.startsWith('/fail/')) { response.writeHead(503).end(); return; }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(catalog)); return;
    }
    const relative = decodeURIComponent(url.pathname.replace(/^\/fail/, '')).replace(/^\//, '');
    const file = path.resolve(root, relative.endsWith('/') || !relative ? `${relative}index.html` : relative);
    if (path.relative(root, file).startsWith('..')) throw Error('outside website');
    response.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, PAWTALK_WEBSITE_TEST_URL: `http://127.0.0.1:${server.address().port}` };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(createRequire(import.meta.url)('electron'), ['tests/website-ui.cjs'], { env, windowsHide: true, stdio: 'inherit' });
const exit = await new Promise(resolve => { child.on('error', error => { console.error(error); resolve(1); }); child.on('exit', resolve); });
server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
process.exitCode = exit ?? 1;
