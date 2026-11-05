import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createServer as createTCPServer, createConnection } from 'node:net';
import { createSocket } from 'node:dgram';
import { promisify } from 'node:util';
import path from 'node:path';

const execute = promisify(execFile);
const shells = ['powershell.exe'];
if (process.platform === 'win32' && spawnSync('pwsh.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true }).status === 0) shells.push('pwsh.exe');
for (const shell of shells) test(`preflight SOAP faults, finite leases and ownership cleanup (${shell})`, { skip: process.platform !== 'win32' }, async () => {
  const mappings = new Map();
  const calls = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.end('<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/control</controlURL></service></serviceList></device></root>');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const action = req.headers.soapaction.match(/#(\w+)/)[1];
    const field = name => body.match(new RegExp(`<${name}>(.*?)</${name}>`))?.[1];
    const port = field('NewExternalPort');
    const key = `${field('NewProtocol')}:${port}`;
    calls.push({ action, port, body });
    const fault = code => { res.writeHead(500, { 'Content-Type': 'text/xml' }); res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><u:UPnPError xmlns:u="urn:schemas-upnp-org:control-1-0"><u:errorCode>\n${code}\n</u:errorCode><u:errorDescription>Router diagnostic</u:errorDescription></u:UPnPError></detail></s:Fault></s:Body></s:Envelope>`); };
    let result = '';
    if (action === 'GetSpecificPortMappingEntry') {
      if (!mappings.has(key)) { fault(714); return; }
      const mapping = mappings.get(key);
      result = `<NewInternalClient>${mapping.client}</NewInternalClient><NewPortMappingDescription>${mapping.description}</NewPortMappingDescription>`;
    } else if (action === 'AddPortMapping') {
      if (port === '18450') { fault(725); return; }
      if (port === '18451') { res.writeHead(500); res.end('Internal server error'); return; }
      mappings.set(key, { client: field('NewInternalClient'), description: field('NewPortMappingDescription') });
    } else if (action === 'DeletePortMapping') mappings.delete(key);
    res.setHeader('Content-Type', 'text/xml');
    res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><Response>${result}</Response></s:Body></s:Envelope>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const source = path.resolve('scripts/check-selfhost.ps1').replaceAll("'", "''");
  const run = command => execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference='Stop'; . '${source}'; $service=Get-UPnPService 'http://127.0.0.1:${server.address().port}/description'; ${command}`], { timeout: 20000, windowsHide: true });
  try {
    await run("Add-TestMapping $service 18443 '192.168.1.10' 'owned'; Remove-TestMapping $service 18443 '192.168.1.10' 'owned'");
    assert.equal(mappings.size, 0);
    const add = calls.find(call => call.action === 'AddPortMapping');
    assert.match(add.body, /<NewLeaseDuration>300<\/NewLeaseDuration>/);
    mappings.set('TCP:18443', { client: '192.168.1.99', description: 'someone else' });
    await run("Add-TestMapping $service 18443 '192.168.1.10' 'owned' UDP; Remove-TestMapping $service 18443 '192.168.1.10' 'owned' UDP");
    assert.equal(mappings.size, 1, 'UDP cleanup preserves the TCP mapping on the same port');
    const before = calls.length;
    await assert.rejects(run("Add-TestMapping $service 18443 '192.168.1.10' 'owned'"), /Existing TCP mapping/);
    await assert.rejects(run("Remove-TestMapping $service 18443 '192.168.1.10' 'owned'"), /changed ownership/);
    assert.ok(calls.slice(before).every(call => call.action === 'GetSpecificPortMappingEntry'));
    await assert.rejects(run("Add-TestMapping $service 18450 '192.168.1.10' 'owned'"), /UPNP_725: AddPortMapping - Router diagnostic/);
    await assert.rejects(run("Add-TestMapping $service 18451 '192.168.1.10' 'owned'"), /AddPortMapping: HTTP 500/);
    assert.equal(calls.filter(call => call.action === 'AddPortMapping' && call.port === '18450').length, 1, 'no permanent-lease fallback');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

for (const shell of shells) test(`UDP probe requires a selected node, bounded echo and external acknowledgement (${shell})`, { skip: process.platform !== 'win32' }, async () => {
  const udp = createSocket('udp4');
  await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
  const reservation = createSocket('udp4');
  await new Promise(resolve => reservation.bind(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const foreign = createSocket('udp4');
  await new Promise(resolve => foreign.bind(0, '127.0.0.2', resolve));
  const payload = Buffer.from([0, 1, 2, 255]);
  let acknowledged = false;
  let acknowledgedBeforeDispatch = false;
  udp.on('message', message => { if (message.equals(payload)) acknowledged = true; });
  let foreignEcho = false;
  foreign.on('message', () => { foreignEcho = true; });
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/nodes/ips') {
      res.end(JSON.stringify({ nodes: ['127.0.0.1'] }));
    } else if (req.url.startsWith('/check-udp?')) {
      foreign.send(payload, port, '127.0.0.1');
      udp.send(Buffer.alloc(512), port, '127.0.0.1');
      udp.send(payload, port, '127.0.0.1');
      // Reply must be sent while dispatch is still pending, not after this response.
      setTimeout(() => {
        acknowledgedBeforeDispatch = acknowledged;
        res.end(JSON.stringify({ ok: 1, request_id: 'synthetic-1', nodes: { mock: ['xx', 'Test', 'Test', '127.0.0.1'] } }));
      }, 1200);
    } else {
      res.end(JSON.stringify({ mock: [acknowledged ? { time: 0.01, address: '203.0.113.20' } : { timeout: 3, address: '203.0.113.20' }] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const source = path.resolve('scripts/check-selfhost.ps1').replaceAll("'", "''");
  try {
    const command = `$ErrorActionPreference='Stop'; . '${source}'; function Test-PublicIPv4 { return $true }; $socket=New-Object Net.Sockets.UdpClient(${port}); $probe=New-UdpProbe '203.0.113.20' ${port} 'http://127.0.0.1:${server.address().port}'; try { $deadline=[DateTime]::UtcNow.AddSeconds(10); while (-not $probe.Finished -and [DateTime]::UtcNow -lt $deadline) { Receive-UdpProbe $socket $probe; Update-UdpProbe $probe; Start-Sleep -Milliseconds 20 }; if (-not $probe.Confirmed -or $probe.Echoes -ne 1) { throw 'UDP round trip failed or unrelated packet echoed' }; if ((Get-PreflightVerdict $true $false $false) -notlike 'PARTIAL SUCCESS:*') { throw 'Missing partial success verdict' }; $report=ConvertFrom-Json '{"mock":[{"time":3,"timeout":3,"address":"203.0.113.20"}]}'; if (Test-PortReport $report $probe) { throw 'Timeout treated as success' }; $probe.Confirmed=$false; $probe.Finished=$false; $probe.Received=$false; $probe.Started=[DateTime]::UtcNow.AddSeconds(-46); Update-UdpProbe $probe; if ($probe.Confirmed) { throw 'False UDP success' }; if ((Get-PreflightVerdict $true $true $true) -notlike 'SUCCESS:*') { throw 'Missing success verdict' } } finally { $probe.Client.Dispose(); $socket.Dispose() }`;
    const result = await execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { timeout: 16000, windowsHide: true });
    assert.ok(acknowledged);
    assert.ok(acknowledgedBeforeDispatch, 'echo must arrive before dispatch HTTP response');
    assert.equal(foreignEcho, false);
    assert.match(result.stdout, /round trip confirmed/);
    assert.match(result.stdout, /UDP probe timed out/);
  } finally { udp.close(); foreign.close(); await new Promise(resolve => server.close(resolve)); }
});

for (const shell of shells) test(`automatic TCP check verifies API results and reports service failure (${shell})`, { skip: process.platform !== 'win32' }, async () => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/check-tcp?')) {
      const target = new URL(req.url, 'http://localhost').searchParams.get('host');
      if (target.endsWith(':18444')) { res.writeHead(502); res.end('{}'); return; }
      assert.equal(target, '203.0.113.20:18443');
      res.end(JSON.stringify({ ok: 1, request_id: 'tcp-test', nodes: { mock: ['xx', 'Test', 'Test', '198.51.100.1'] } }));
    } else if (req.url === '/check-result/tcp-test') {
      res.end(JSON.stringify({ mock: [{ time: 0.03, address: '203.0.113.20' }] }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const source = path.resolve('scripts/check-selfhost.ps1').replaceAll("'", "''");
  try {
    const command = `$ErrorActionPreference='Stop'; . '${source}'; $base='http://127.0.0.1:${server.address().port}'; $a=New-TcpProbe '203.0.113.20' 18443 $base; $b=New-TcpProbe '203.0.113.20' 18444 $base; try { $deadline=[DateTime]::UtcNow.AddSeconds(8); while ((-not $a.Finished -or -not $b.Finished) -and [DateTime]::UtcNow -lt $deadline) { Update-PortProbe $a; Update-PortProbe $b; Start-Sleep -Milliseconds 20 }; if (-not $a.Confirmed) { throw 'TCP API success not detected' }; if ($b.Confirmed -or $b.Error -notlike '*HTTP 502*') { throw 'Service failure treated as TCP success' }; foreach ($bad in @('{"mock":[{"time":0.1,"error":"Connection refused","address":"203.0.113.20"}]}','{"other":[{"time":0.1,"address":"203.0.113.20"}]}','{"mock":[{"time":0.1,"address":"203.0.113.99"}]}')) { if (Test-PortReport (ConvertFrom-Json $bad) $a) { throw 'Invalid TCP result accepted' } } } finally { $a.Client.Dispose(); $b.Client.Dispose() }`;
    const result = await execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { timeout: 12000, windowsHide: true });
    assert.match(result.stdout, /PASS: TCP 18443 confirmed/);
    assert.match(result.stdout, /HTTP 502/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

for (const scenario of ['timeout', 'udp-first', 'tcp-first', 'cancel', 'extra-port-in-use']) test(`preflight cleanup and caller preservation (${scenario})`, { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  let port;
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = 20000 + Math.floor(Math.random() * 15000);
    const reservations = [];
    try {
      for (const number of [candidate, candidate + 1, candidate + 3]) {
        const listener = createTCPServer(); reservations.push(listener);
        await new Promise((resolve, reject) => { listener.on('error', reject); listener.listen(number, '0.0.0.0', resolve); });
      }
      port = candidate;
    } catch { }
    finally { for (const listener of reservations) if (listener.listening) await new Promise(resolve => listener.close(resolve)); }
    if (port) break;
  }
  assert.ok(port, 'a free local TCP port range is available');
  const source = path.resolve('scripts/check-selfhost.ps1').replaceAll("'", "''");
  const seconds = scenario === 'timeout' ? 10 : 180;
  const cancellation = ['cancel', 'extra-port-in-use'].includes(scenario);
  const mockProbe = scenario === 'timeout' || cancellation ? '' : `function Test-PublicIPv4 { return $true }; function New-UdpProbe { return @{ Client=(New-Object IO.MemoryStream); Received=$false; Confirmed=$false; Ready=[DateTime]::UtcNow.AddSeconds(${scenario === 'tcp-first' ? 1 : 0}) } }; function Receive-UdpProbe {}; function Update-UdpProbe($probe) { if ([DateTime]::UtcNow -ge $probe.Ready) { $probe.Received=$true; $probe.Confirmed=$true } };`;
  const probeOptions = scenario === 'timeout' || cancellation ? '-SkipUdpCheck' : "-PublicIP '203.0.113.20'";
  const application = scenario === 'timeout' ? '' : '-Application';
  const command = `. '${source}' -Port ${port} -Seconds ${seconds} ${probeOptions} -SkipTcpCheck ${application}; function Get-NetIPConfiguration { [pscustomobject]@{ IPv4DefaultGateway=1; IPv4Address=@([pscustomobject]@{IPAddress='127.0.0.1'}) } }; function Find-UPnPService { throw 'Synthetic: no router' }; ${mockProbe} Start-SelfHostCheck; Write-Output 'CALLER_STILL_RUNNING'`;
  const extra = scenario === 'extra-port-in-use' ? createTCPServer() : null;
  if (extra) await new Promise(resolve => extra.listen(port + 3, '0.0.0.0', resolve));
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(output))); });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', data => { output += data; if (output.includes(`Waiting up to ${seconds} seconds`)) resolve(); });
      child.stderr.on('data', data => { output += data; });
      child.once('exit', () => reject(new Error(output)));
      child.once('error', reject);
    });
    const connectedAt = Date.now();
    for (const number of [port, port + 1]) {
      await new Promise((resolve, reject) => { const socket = createConnection(number, '127.0.0.1'); socket.on('error', reject); socket.on('connect', () => { socket.end(); resolve(); }); });
    }
    if (cancellation) child.stdin.end('q\n');
    await done;
    if (scenario !== 'timeout' && !cancellation) {
      assert.ok(Date.now() - connectedAt < 5000, 'full success exits immediately instead of waiting 180 seconds');
      assert.match(output, /=== RESULT ===\s+SUCCESS:/);
      assert.match(output, /VOICECORD_PREFLIGHT_RESULT:.*"state":"internet"/);
    }
    if (cancellation) assert.match(output, /VOICECORD_PREFLIGHT_RESULT:.*"state":"cancelled"/);
    assert.match(output, /CALLER_STILL_RUNNING/, 'the script returns to its caller without exit');
    if (!cancellation) assert.match(output, /TCP connection accepted/);
    assert.match(output, /Synthetic: no router/);
    assert.match(output, /Listeners closed/);
    if (extra) await new Promise(resolve => extra.close(resolve));
    for (const number of [port, port + 1, port + 3]) {
      const listener = createTCPServer();
      await new Promise((resolve, reject) => { listener.on('error', reject); listener.listen(number, '0.0.0.0', resolve); });
      await new Promise(resolve => listener.close(resolve));
    }
    const udp = createSocket('udp4');
    try { await new Promise((resolve, reject) => { udp.on('error', reject); udp.bind(port + 2, '0.0.0.0', resolve); }); }
    finally { udp.close(); }
  } finally { child.kill(); if (extra?.listening) await new Promise(resolve => extra.close(resolve)); }
});

for (const shell of shells) test(`external checker retries transient HTTP errors and confirms recovered requests (${shell})`, { skip: process.platform !== 'win32' }, async () => {
  let attempts = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/check-tcp?')) {
      if (++attempts === 1) { res.writeHead(502); res.end('{}'); return; }
      res.end(JSON.stringify({ ok: 1, request_id: 'retry-test', nodes: { mock: ['xx', 'Test', 'Test', '198.51.100.1'] } }));
    } else res.end(JSON.stringify({ mock: [{ time: 0.02, address: '203.0.113.20' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const source = path.resolve('scripts/check-selfhost.ps1').replaceAll("'", "''");
  try {
    const command = `$ErrorActionPreference='Stop'; . '${source}'; $probe=New-TcpProbe '203.0.113.20' 18443 'http://127.0.0.1:${server.address().port}'; try { $deadline=[DateTime]::UtcNow.AddSeconds(8); while (-not $probe.Finished -and [DateTime]::UtcNow -lt $deadline) { Update-PortProbe $probe; Start-Sleep -Milliseconds 20 }; if (-not $probe.Confirmed -or $probe.Error) { throw 'Recovered checker did not confirm TCP' } } finally { $probe.Client.Dispose() }`;
    const result = await execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, timeout: 12000 });
    assert.equal(attempts, 2);
    assert.match(result.stdout, /retry 1\/2/);
    assert.match(result.stdout, /PASS: TCP 18443 confirmed/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
