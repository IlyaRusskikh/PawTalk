const { HostError } = require('./host-errors.cjs');
const { t } = require('../../../../shared/i18n.cjs');
const { spawn, fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir, networkInterfaces } = require('node:os');
const { isIP } = require('node:net');
const net = require('node:net');
const dgram = require('node:dgram');
const path = require('node:path');
const { createInterface } = require('node:readline');

function localAddresses() {
  const entries = Object.entries(networkInterfaces()).sort(([a], [b]) => Number(/virtual|vethernet|docker|vmware|wsl/i.test(a)) - Number(/virtual|vethernet|docker|vmware|wsl/i.test(b)));
  return [...new Set(entries.flatMap(([, values]) => values || []).filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address))];
}
function publicIPv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a,b] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
}
function bounded(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new HostError(message)), ms); })]).finally(() => clearTimeout(timer));
}
async function checkPorts(port) {
  const sockets = [];
  try {
    for (const p of [port, port+1, port+3]) {
      await new Promise((resolve, reject) => { const socket = net.createServer(); sockets.push(socket); socket.once('error', reject); socket.listen(p, '0.0.0.0', resolve); });
    }
    await new Promise((resolve, reject) => { const socket = dgram.createSocket('udp4'); sockets.push(socket); socket.once('error', reject); socket.bind(port+2, '0.0.0.0', resolve); });
  } catch { throw new HostError(t("Порты комнаты заняты. Укажите другой порт.")); }
  finally { for (const socket of sockets) { try { socket.close(); } catch {} } }
}
async function childReady(child, config, handshake) {
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const failed = () => new HostError(t("Не удалось запустить встроенный сервер. Возможно, порт занят."));
  let fail;
  const eof = new Promise((_, reject) => {
    fail = () => reject(failed());
    child.once('error', fail);
    child.once('exit', fail);
  });
  const iterator = lines[Symbol.asyncIterator]();
  async function read() {
    const { value, done } = await iterator.next();
    if (done || value.length > 50 * 1024) throw failed();
    const ready = JSON.parse(value);
    if (!/^[a-f0-9]{64}$/.test(ready?.fingerprint)) throw failed();
    return ready;
  }
  async function exchange() {
    child.stdin.write(JSON.stringify(config) + '\n');
    const offer = await read();
    if (!handshake) return offer;
    if (!offer.protected || offer.bootstrap !== undefined) {
      throw new HostError(t("Встроенный сервер несовместим с клиентом"));
    }
    const approval = handshake.authorize(offer);
    child.stdin.write(JSON.stringify(approval) + '\n');
    const receipt = await read();
    return { fingerprint: receipt.fingerprint, protectedBootstrap: handshake.confirm(receipt) };
  }
  try {
    return await bounded(Promise.race([exchange(), eof]), 15000, t("Встроенный сервер не запустился вовремя"));
  } finally {
    child.off('error', fail);
    child.off('exit', fail);
    lines.close();
    child.stdout.resume();
  }
}
class SelfHost {
  constructor(resources, onChange = () => {}) {
    this.resources = resources;
    this.onChange = onChange;
    this.state = { running: false };
    this.children = [];
  }
  status() { return this.state; }
  async start(input, protectedHost) {
    if (this.starting || this.stopping || this.state.running) throw new HostError(t("Комната уже запущена или меняет состояние"));
    if (!input || typeof input !== 'object') throw new HostError(t("Неверные настройки сервера"));
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)) throw new HostError(t("Укажите название комнаты до 80 символов"));
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65532) throw new HostError(t("Укажите порт от 1024 до 65532"));
    const protocol = input.protocol ?? 2;
    if (![2, 3].includes(protocol) || (protocol === 3) !== !!protectedHost) {
      throw new HostError(t("Неверные настройки сервера"));
    }
    this.starting = true;
    this.cancelled = false;
    try {
      await checkPorts(port);
      this.directory = await mkdtemp(path.join(tmpdir(), 'pawtalk-room-'));
      this.mapper = fork(path.join(__dirname, 'port-mapper.cjs'), [], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore','ignore','ignore','ipc'] });
      const mappedResult = bounded(new Promise(resolve => {
        this.mapper.once('message', resolve);
        this.mapper.once('error', () => resolve({ mapped: false, externalIP: '' }));
        this.mapper.once('exit', () => resolve({ mapped: false, externalIP: '' }));
      }), 30000, t("Роутер не ответил"));
      this.mapper.send({ port });
      this.mapper.on('message', update => {
        if (update.leaseLost && this.state.running) {
          this.state = { ...this.state, mapped: false, internet: false, invitations: this.state.internet ? this.state.invitations.slice(1) : this.state.invitations, message: t("Не удалось продлить проброс или изменился внешний IP. Пересоздайте комнату для подключения через интернет.") };
          this.onChange(this.state);
        }
      });
      let mapped = false, externalIP = '';
      try { ({ mapped, externalIP } = await mappedResult); } catch { this.mapper.kill(); }
      if (this.cancelled) throw new HostError(t("Создание комнаты отменено: компьютер перешёл в сон"));
      const lan = localAddresses();
      const nodeIP = publicIPv4(externalIP) && mapped ? externalIP : lan[0];
      if (!nodeIP) throw new HostError(t("Не найден сетевой адрес компьютера"));
      const key = 'vc_' + randomBytes(12).toString('hex'), secret = randomBytes(32).toString('hex');
      const config = path.join(this.directory, 'livekit.yaml');
      await writeFile(config, `port: ${port+3}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: ${port+1}\n  udp_port: ${port+2}\n  use_external_ip: false\n  advertise_internal_ip: true\n  node_ip: ${nodeIP}\n  enable_loopback_candidate: true\n  stun_servers: []\nkeys:\n  ${key}: ${secret}\nroom:\n  auto_create: true\n  max_participants: 30\nlogging:\n  level: error\n`, { mode: 0o600 });
      const api = spawn(path.join(this.resources, 'pawtalk-api.exe'), ['selfhost'], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      if (process.env.PAWTALK_SELFHOST_DEBUG === '1') api.stderr.on('data', data => console.error('selfhost:', data.toString()));
      else api.stderr.resume();
      api.stdin.on('error', () => {});
      this.children.push(api);
      const { fingerprint, bootstrap, protectedBootstrap } = await childReady(api, {
        Port: port, MediaPort: port+3, Key: key, Secret: secret, Name: input.name,
        Addresses: [...lan, ...(mapped && publicIPv4(externalIP) ? [externalIP] : [])],
        MediaExecutable: path.join(this.resources, 'livekit-server.exe'), MediaConfig: config,
        ...(protectedHost && { Protected: protectedHost.input }),
      }, protectedHost);
      if (this.cancelled) throw new HostError(t("Создание комнаты отменено: компьютер перешёл в сон"));
      const invite = ip => `pawtalk://${ip}:${port}/${fingerprint}`;
      const localAddress = invite('127.0.0.1');
      let serverId;
      if (protectedHost) {
        serverId = protectedBootstrap.trust.serverId;
        await protectedHost.register(localAddress, protectedBootstrap);
      } else {
        if (!bootstrap || !/^[a-f0-9]{32}$/.test(bootstrap.serverId) || !/^[a-f0-9]{32}$/.test(bootstrap.inviteId) || !/^[\w-]{43}$/.test(bootstrap.token)) {
          throw new HostError(t("Встроенный сервер несовместим с клиентом"));
        }
        serverId = bootstrap.serverId;
        this.bootstrapAddress = localAddress + '#' + new URLSearchParams({v:'2',server:serverId,invite:bootstrap.inviteId,token:bootstrap.token,setup:'1'});
      }
      if (api.exitCode !== null || api.signalCode !== null || this.cancelled) {
        if (protectedHost) await protectedHost.unregister(serverId);
        throw new HostError(t("Не удалось запустить встроенный сервер. Возможно, порт занят."));
      }
      api.once('exit', () => { if (this.state.running) void this.stop(t("Сервер комнаты остановился")); });
      const internet = mapped && publicIPv4(externalIP);
      this.state = { running: true, serverId, apiProtocolVersion: protocol, e2ee: true, name: input.name || t("Комната"), port, mapped, internet, localAddress, invitations: [...(internet ? [invite(externalIP)] : []), ...lan.map(invite)], message: internet ? t("Порты открыты на роутере. Доступность из интернета не проверена.") : t("Комната работает в локальной сети. Автопроброс недоступен или у провайдера дополнительный NAT."), fingerprint };
      this.onChange(this.state); return this.state;
    } catch (error) { await this.cleanup(); throw error; }
    finally { this.starting = false; }
  }
  async cleanup() {
    this.bootstrapAddress = undefined;
    for (const child of this.children.splice(0)) {
      const exited = new Promise(resolve => { child.once('exit', resolve); if (child.exitCode !== null || child.signalCode !== null) resolve(); });
      child.stdin?.end();
      try { await bounded(exited, 3000, 'shutdown timeout'); } catch { child.kill(); }
    }
    if (this.mapper) { const mapper = this.mapper; this.mapper = undefined; try { const exited = new Promise(resolve => { mapper.once('exit', resolve); if (mapper.exitCode !== null) resolve(); }); if (mapper.connected) mapper.send({ stop: true }); await bounded(exited, 8000, 'cleanup timeout'); } catch { mapper.kill(); } }
    if (this.directory) {
      const directory = path.resolve(this.directory);
      if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('pawtalk-room-')) throw new Error('Invalid temporary room directory');
      await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); this.directory = undefined;
    }
  }
  async stop(message = '') {
    if (this.stopping) return this.stopping;
    this.state = { running: false, message }; this.onChange(this.state);
    this.stopping = this.cleanup().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
}
module.exports = { SelfHost, publicIPv4, localAddresses, checkPorts, childReady };
