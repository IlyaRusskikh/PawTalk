import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { repository, components, requiredAssets, selectReleases, fetchReleases, generateCatalog } from '../scripts/release-catalog.mjs';

function release(component, version, extras = {}) {
  const tag_name = `${component}-v${version}`;
  return { tag_name, draft: false, prerelease: false, published_at: '2026-11-01T00:00:00Z',
    assets: requiredAssets(component, version).map(name => ({ name, state: 'uploaded', size: 123,
      browser_download_url: `https://github.com/${repository}/releases/download/${tag_name}/${name}` })), ...extras };
}
const baseline = () => components.map(component => release(component, '1.0.0'));
test('component lines, stable/preview and SemVer precedence ignore API/date ordering', () => {
  const releases = [...baseline(), release('client', '1.10.0', { prerelease: true }), release('client', '1.9.0'),
    release('server', '2.0.0-beta.9'), release('server', '2.0.0-beta.10'),
    release('manager', '1.0.1-beta.100000000000000000000'), release('manager', '1.0.1-beta.99999999999999999999')];
  const selected = selectReleases(releases.reverse()).components;
  assert.equal(selected.client.latest.version, '1.10.0');
  assert.equal(selected.client.stable.version, '1.9.0');
  assert.equal(selected.client.preview.version, '1.10.0');
  assert.equal(selected.server.latest.version, '2.0.0-beta.10');
  assert.equal(selected.server.latest.channel, 'preview'); // SemVer suffix overrides a bad GitHub flag.
  assert.equal(selected.server.stable.version, '1.0.0');
  assert.equal(selected.manager.latest.version, '1.0.1-beta.100000000000000000000');
  assert.deepEqual(selectReleases(releases), selectReleases([...releases].reverse()));
  assert.equal(selectReleases(components.map(c => release(c, '1.0.0', { prerelease: true }))).components.client.stable, null);
  assert.equal(selectReleases(baseline()).components.client.preview, null);
  assert.equal(selectReleases([...baseline(), release('client', '2.0.0-beta.10'), release('client', '2.0.0')]).components.client.latest.version, '2.0.0');
});
test('draft, invalid, incomplete, duplicate, external and unuploaded assets cannot displace a release', () => {
  const bad = [release('client', '99.0.0', { draft: true }), release('client', '99.0.0', { assets: [] }),
    release('client', '99.0.0', { published_at: null }), release('client', '99.0.0', { tag_name: 'client-v01.0.0' }),
    release('client', '99.0.0', { tag_name: 'v99.0.0' }), release('client', '99.0.0', { tag_name: 'client-v1.0.0-01' }),
    release('client', '99.0.0', { tag_name: 'client-v99.0.0\n' }), null,
    release('client', '99.0.0', { assets: {} })];
  for (const mutation of [asset => asset.size = 0, asset => asset.state = 'new',
    asset => asset.browser_download_url = 'https://evil.example/file.exe',
    asset => asset.browser_download_url = asset.browser_download_url.replace('99.0.0/', '98.0.0/')]) {
    const candidate = release('client', '99.0.0'); mutation(candidate.assets[0]); bad.push(candidate);
  }
  const duplicate = release('client', '99.0.0'); duplicate.assets.push(duplicate.assets[0]); bad.push(duplicate);
  assert.equal(selectReleases([...baseline(), ...bad]).components.client.latest.version, '1.0.0');
  for (const component of components) for (const asset of requiredAssets(component, '2.0.0')) {
    const incomplete = release(component, '2.0.0');
    incomplete.assets = incomplete.assets.filter(entry => entry.name !== asset);
    assert.equal(selectReleases([...baseline(), incomplete]).components[component].latest.version, '1.0.0', asset);
  }
  assert.throws(() => selectReleases([]), /No complete published/);
  assert.throws(() => selectReleases({}), /Invalid releases/);
});
test('API pagination is complete and authenticated; errors never return partial releases', async () => {
  const requests = [];
  const batches = [Array.from({ length: 100 }, () => baseline()[0]), baseline()];
  const fetched = await fetchReleases({ token: 'synthetic-test-token', fetchImpl: async (url, options) => {
    requests.push({ url, options }); return { ok: true, json: async () => batches.shift() };
  } });
  assert.equal(fetched.length, 103);
  assert.match(requests[1].url, /page=2$/);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer synthetic-test-token');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  for (const status of [403, 404, 429, 500]) await assert.rejects(fetchReleases({ fetchImpl: async () => ({ ok: false, status }) }), new RegExp(`HTTP ${status}`));
  await assert.rejects(fetchReleases({ fetchImpl: async () => { throw Error('timeout'); } }), /timeout/);
  await assert.rejects(fetchReleases({ fetchImpl: async () => ({ ok: true, json: async () => { throw Error('invalid JSON'); } }) }), /invalid JSON/);
  await assert.rejects(fetchReleases({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /Invalid releases/);
  let page = 0;
  await assert.rejects(fetchReleases({ fetchImpl: async () => ++page === 1 ? { ok: true, json: async () => Array(100).fill(baseline()[0]) } : { ok: false, status: 503 } }), /HTTP 503/);
});
test('generation replaces complete catalog only after successful API/selection; preserves last file on failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pawtalk-catalog-'));
  try {
    const file = path.join(directory, 'releases.json');
    const good = { fetchImpl: async () => ({ ok: true, json: async () => baseline() }) };
    await generateCatalog(directory, good);
    const previous = await readFile(file, 'utf8');
    for (const fetchImpl of [async () => ({ ok: false, status: 503 }), async () => ({ ok: true, json: async () => baseline().slice(1) })]) {
      await assert.rejects(generateCatalog(directory, { fetchImpl }));
      assert.equal(await readFile(file, 'utf8'), previous);
    }
    await writeFile(file, 'old');
    await generateCatalog(directory, good);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), selectReleases(baseline()));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('browser loader resolves both languages/channels and keeps errors free of invented links', async () => {
  const saved = { fetch: globalThis.fetch, document: globalThis.document };
  let invocation = 0;
  async function run(lang, failure = false) {
    const nodes = components.flatMap(component => ['latest', 'stable'].map(channel => ({
      dataset: { release: component, channel, version: '' }, textContent: component,
      removeAttribute() {},
    })));
    nodes.push({ dataset: { release: 'client', asset: 'PawTalk.Setup.' }, removeAttribute() {} });
    const status = { textContent: '' };
    globalThis.document = { documentElement: { lang }, querySelectorAll: () => nodes, querySelector: () => status };
    globalThis.fetch = async () => ({ ok: !failure, json: async () => selectReleases(baseline()) });
    await import(`../website/releases.js?test=${++invocation}`);
    await new Promise(resolve => setImmediate(resolve));
    return { nodes, status };
  }
  try {
    for (const lang of ['en', 'ru']) {
      const good = await run(lang);
      assert.equal(good.nodes[0].textContent, lang === 'ru' ? 'Client 1.0.0 (стабильный)' : 'Client 1.0.0 (stable)');
      assert.equal(good.nodes[6].href, baseline()[0].assets[0].browser_download_url);
      const failed = await run(lang, true);
      assert.equal(failed.nodes.some(node => node.href), false);
      assert.match(failed.status.textContent, lang === 'ru' ? /недоступны/ : /unavailable/);
    }
  } finally { globalThis.fetch = saved.fetch; globalThis.document = saved.document; }
});
