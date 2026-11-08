import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';
const { diagnosticCommand } = createRequire(import.meta.url)('../electron/diagnostic-command.cjs');
const pin = 'a'.repeat(64);
test('CMD diagnostics exclude password, fit CMD limit, and reject injected targets', () => {
 const mediaKey = 'b'.repeat(64);
 const command = diagnosticCommand(`pawtalk://192.168.0.13:18443/${pin}#password=hidden-secret&name=room&e2ee=${mediaKey}`);
 assert.ok(command.length < 8191);
 const source = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
 assert.ok(!source.includes('hidden-secret'));
 assert.ok(!source.includes(mediaKey));
 assert.ok(source.includes(pin));
 assert.ok(source.includes('/healthz') && source.includes('/rtc'));
 for (const input of ['https://example.com', `pawtalk://evil.example:18443/${pin}`, `pawtalk://127.0.0.1:18443/${pin}#password=x&bad=value`]) assert.throws(() => diagnosticCommand(input));
});
test('generated command verifies real TLS pin, endpoints, TCP, and rejects wrong pins', { skip: process.platform !== 'win32' }, async t => {
 const go = process.env.PAWTALK_GO || path.join(tmpdir(), 'pawtalk-tools/go/bin/go.exe');
 try { await access(go); } catch { t.skip('Go test certificate generator unavailable'); return; }
 const dir = await mkdtemp(path.join(tmpdir(), 'pawtalk-diagnostic-test-'));
 let web, tcp;
 try {
  const file = path.join(dir, 'cert.go');
  await writeFile(file, `package main
import("crypto/rand";"crypto/rsa";"crypto/x509";"encoding/json";"encoding/pem";"math/big";"os";"time")
func main(){k,_:=rsa.GenerateKey(rand.Reader,2048);c:=&x509.Certificate{SerialNumber:big.NewInt(1),NotBefore:time.Now().Add(-time.Hour),NotAfter:time.Now().Add(time.Hour),KeyUsage:x509.KeyUsageDigitalSignature|x509.KeyUsageKeyEncipherment,ExtKeyUsage:[]x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}};der,e:=x509.CreateCertificate(rand.Reader,c,c,&k.PublicKey,k);if e!=nil{panic(e)};json.NewEncoder(os.Stdout).Encode(map[string]string{"cert":string(pem.EncodeToMemory(&pem.Block{Type:"CERTIFICATE",Bytes:der})),"key":string(pem.EncodeToMemory(&pem.Block{Type:"RSA PRIVATE KEY",Bytes:x509.MarshalPKCS1PrivateKey(k)}))})}`);
  const made = spawnSync(go, ['run', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(made.status, 0, made.stderr);
  const cert = JSON.parse(made.stdout);
  const actualPin = new X509Certificate(cert.cert).fingerprint256.replaceAll(':', '').toLowerCase();
  const requests = [];
  web = https.createServer(cert, (req, res) => { requests.push(req.url); res.end('ok'); });
  await new Promise(r => web.listen(0, '127.0.0.1', r));
  const port = web.address().port;
  if (port > 65532) { t.skip('Port too high'); return; }
  tcp = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(port + 1, '127.0.0.1', resolve); });
  const run = async fingerprint => {
   const command = diagnosticCommand(`pawtalk://127.0.0.1:${port}/${fingerprint}`);
   return await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', command.split(' ').at(-1)], { windowsHide: true });
    let out = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => out += b);
    child.on('error', reject); child.on('exit', code => resolve({ code, out }));
   });
  };
  const good = await run(actualPin); assert.equal(good.code, 0, good.out); assert.match(good.out, /PASS:/);
  assert.deepEqual(requests, ['/healthz', '/rtc']);
  const wrong = await run(pin); assert.equal(wrong.code, 1, wrong.out); assert.match(wrong.out, /Certificate mismatch/);
 } finally { if(web) await new Promise(r => web.close(r)); if(tcp) await new Promise(r => tcp.close(r)); await rm(dir, { recursive: true, force: true }); }
});
