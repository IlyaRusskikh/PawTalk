import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
const { SelfHost, publicIPv4, checkPorts } = createRequire(import.meta.url)('../electron/selfhost.cjs');

test('selfhost rejects invalid passwords and port ranges before starting processes', async () => {
 const host = new SelfHost('unused');
 for (const input of [{ password: 'short', port: 18443 }, { password: 'long-enough', port: 443 }, { password: 'long-enough', port: 65533 }, { password: 'long-enough', port: 18443.5 }]) await assert.rejects(host.start(input));
 assert.equal(host.status().running, false);
});

test('CGNAT and local addresses are never presented as public invitations', () => {
 for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.0.1', '100.64.0.1', '100.127.255.254', '169.254.1.1', '224.0.0.1', '::1', '']) assert.equal(publicIPv4(ip), false, ip);
 assert.equal(publicIPv4('8.8.8.8'), true);
});

test('occupied room ports are rejected without launching or mapping anything', async () => {
 const server = net.createServer();
 await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
 try { await assert.rejects(checkPorts(server.address().port), /заняты/); }
 finally { await new Promise(resolve => server.close(resolve)); }
});
