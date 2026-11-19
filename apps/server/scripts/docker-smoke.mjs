// API 2 has one production Go/LiveKit container, not a second bare API core.
// Keep the documented Docker check entry point on the shared lifecycle harness.
if (process.argv.slice(2).some(argument => argument !== '--containers-only')) throw Error('Usage: node apps/server/scripts/docker-smoke.mjs [--containers-only]');
process.env.PAWTALK_TEST_IMAGE ||= 'pawtalk-server:local';
if (!process.argv.includes('--containers-only')) process.argv.push('--audio');
await import('./server-smoke.mjs');
