// Local-only single-container server. VPS deployments use Docker Swarm instead.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const flags = process.argv.slice(2);
if (flags.some(flag => flag !== '--build')) {
  console.error('Usage: npm run dev:server [-- --build]');
  process.exit(2);
}
const build = flags.includes('--build');
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const image = build ? 'pawtalk-server:dev' : `ghcr.io/ilyarusskikh/pawtalk-server:${version}`;
function docker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`docker ${args[0]} exited with code ${code}`)));
  });
}
try {
  if (build) await docker(['build', '-f', 'server/standalone.Dockerfile', '-t', image, '.']);
  console.log('Local development only. This server is accessible from this PC via 127.0.0.1.');
  console.log('On first start, save the generated password from the logs. Use the pinned pawtalk:// invitation.');
  console.log('In another terminal: npm run dev. To show the current invitation: docker exec pawtalk-dev-server /pawtalk serve info');
  console.log('Keep the data volume pawtalk-dev-server-data to retain the password and certificate across restarts.');
  await docker(['run', '--rm', '--name', 'pawtalk-dev-server',
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--tmpfs', '/tmp:uid=65532,gid=65532,mode=0700',
    '-v', 'pawtalk-dev-server-data:/data',
    '-e', 'PAWTALK_PUBLIC_IP=127.0.0.1', '-e', 'PAWTALK_PORT=18443',
    '-p', '127.0.0.1:18443:18443/tcp',
    '-p', '127.0.0.1:18444:18444/tcp',
    '-p', '127.0.0.1:18445:18445/udp', image]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
