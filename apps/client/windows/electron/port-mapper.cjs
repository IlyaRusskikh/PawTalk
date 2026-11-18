// Isolate router implementations so an unresponsive gateway cannot freeze shutdown.
let mapper;
let stopping = false;
let renewTimer;
async function windowsGateway() {
  if (process.platform !== 'win32') return undefined;
  const { promisify } = require('node:util');
  const { execFile } = require('node:child_process');
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1 -ExpandProperty NextHop"], { windowsHide: true, timeout: 5000 });
  const ip = stdout.trim();
  return require('node:net').isIP(ip) === 4 ? ip : undefined;
}
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(renewTimer);
  try { await mapper?.destroy(); } catch {}
  process.exit(0);
}
process.on('disconnect', () => void stop());
process.on('message', async input => {
  if (input.stop) { void stop(); return; }
  try {
    const { default: NatAPI } = await import('@silentbot1/nat-api');
    mapper = new NatAPI({ ttl: 1200, autoUpdate: false, enablePMP: false, description: 'PawTalk temporary room', upnpPermanentFallback: false });
    let mapped = true;
    for (const [port, protocol] of [[input.port, 'TCP'], [input.port+1, 'TCP'], [input.port+2, 'UDP']]) {
      if (stopping) return;
      try { if (!await mapper.map({ publicPort: port, privatePort: port, protocol })) mapped = false; } catch { mapped = false; }
    }
    // Prefer UPnP; NAT-PMP is a fallback for routers without it.
    if (!mapped && process.platform === 'win32' && !stopping) {
      try {
        await mapper.destroy();
        const gateway = await windowsGateway();
        if (gateway) {
          mapper = new NatAPI({ ttl: 1200, autoUpdate: false, enablePMP: false, enableUPNP: false, description: 'PawTalk temporary room' });
          const { default: PMP } = await import('@silentbot1/nat-api/lib/pmp/index.js');
          mapper._pmpClient = new PMP(gateway);
          const mapping = mapper._pmpClient.portMapping.bind(mapper._pmpClient);
          mapper._pmpClient.portMapping = async options => {
            const result = await mapping(options);
            if (options.ttl > 0 && result.public !== options.public) {
              await mapping({ ...options, public: result.public, ttl: 0 });
              throw new Error('Router assigned a different external port');
            }
            return result;
          };
          mapped = true;
          for (const [port, protocol] of [[input.port, 'TCP'], [input.port+1, 'TCP'], [input.port+2, 'UDP']]) {
            if (stopping) return;
            if (!await mapper.map({ publicPort: port, privatePort: port, protocol })) mapped = false;
          }
        }
      } catch { mapped = false; }
    }
    const externalIP = await mapper.externalIp();
    if (!stopping) process.send?.({ mapped, externalIP });
    if (!mapped) { await stop(); return; }
    // Own the renewal schedule: avoid the dependency's recursive UPnP intervals
    // and broken NAT-PMP refresh callback. _map renews without duplicating leases.
    let renewing = false;
    renewTimer = setInterval(async () => {
      if (renewing || stopping) return;
      renewing = true;
      try {
        let valid = true;
        for (const [port, protocol] of [[input.port, 'TCP'], [input.port+1, 'TCP'], [input.port+2, 'UDP']]) {
          if (stopping) return;
          const [ok] = await mapper._map({ publicPort: port, privatePort: port, protocol, ttl: 1200, description: 'PawTalk temporary room' });
          if (!ok) valid = false;
        }
        if (await mapper.externalIp() !== externalIP) valid = false;
        if (!valid && !stopping) process.send?.({ leaseLost: true });
      } catch { if (!stopping) process.send?.({ leaseLost: true }); }
      finally { renewing = false; }
    }, 600000);
  } catch { if (!stopping) process.send?.({ mapped: false, externalIP: '' }); }
});
