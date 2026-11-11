import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const { parseTag, parseVersion, compare, releasePlan, channelFor } = createRequire(import.meta.url)('../shared/release.cjs');
test('three release routes validate their own source and cannot cross-publish', () => {
  assert.equal(channelFor('0.9.0','stable'),'stable');
  assert.equal(channelFor('0.9.0-beta.1','stable'),'preview');
  assert.throws(() => channelFor('0.9.0','unknown'));
  const versions = { client:'0.9.0', server:'0.8.2', manager:'0.1.0' };
  for (const family of Object.keys(versions)) {
    const plan = releasePlan(`${family}-v${versions[family]}`, versions);
    for (const other of Object.keys(versions)) assert.equal(plan[other], family === other);
    assert.throws(() => releasePlan(`${family}-v9.0.0`, versions));
  }
  assert.throws(() => releasePlan('v0.9.0', versions));
  assert.equal(releasePlan('v0.8.1', {...versions,client:'0.8.1'}).server, false);
  for (const tag of ['v0.9.0','server-v01.2.3','manager-v1.0.0\n','client-v1.0.0-01','client-v1.0.0/evil','other-v1.0.0']) assert.equal(parseTag(tag), null, tag);
  assert.equal(parseVersion('1.0.0-01'), null);
  assert.ok(compare('1.0.0-beta.100000000000000000000','1.0.0-beta.99999999999999999999') > 0);
});
test('publication workflow routes are exclusive and refuse legacy publication', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  for (const family of ['client','server','manager']) assert.ok(workflow.includes(`needs.plan.outputs.component == '${family}'`));
  assert.ok(!workflow.includes("startsWith(github.ref, 'refs/tags/v')"));
  assert.ok(workflow.includes('scripts/release-contract.mjs'));
});
