const { t } = require('../shared/i18n.cjs');
const { spawn, fork } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
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
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
async function checkPorts(port) {
  const sockets = [];
  try {
    for (const p of [port, port+1, port+3]) {
      await new Promise((resolve, reject) => { const socket = net.createServer(); sockets.push(socket); socket.once('error', reject); socket.listen(p, '0.0.0.0', resolve); });
    }
    await new Promise((resolve, reject) => { const socket = dgram.createSocket('udp4'); sockets.push(socket); socket.once('error', reject); socket.bind(port+2, '0.0.0.0', resolve); });
  } catch { throw new Error(t("Порты комнаты заняты. Укажите другой порт.")); }
  finally { for (const socket of sockets) { try { socket.close(); } catch {} } }
}
function childReady(child, ready) {
  return bounded(new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const fail = () => reject(new Error(t("Не удалось запустить встроенный сервер. Возможно, порт занят.")));
    child.once('error', fail); child.once('exit', fail);
    lines.on('line', line => { const value = ready(line); if (value) { child.off('error', fail); child.off('exit', fail); lines.close(); child.stdout.resume(); resolve(value); } });
  }), 15000, t("Встроенный сервер не запустился вовремя"));
}
class SelfHost {
  constructor(resources, onChange = () => {}) {
    this.resources = resources;
    this.onChange = onChange;
    this.state = { running: false };
    this.children = [];
  }
  status() { return this.state; }
  async start(input) {
    if (this.starting || this.stopping || this.state.running) throw new Error(t("Комната уже запущена или меняет состояние"));
    if (!input || typeof input.password !== 'string' || Buffer.byteLength(input.password) < 8 || Buffer.byteLength(input.password) > 1024) throw new Error(t("Пароль комнаты должен содержать от 8 до 1024 байт"));
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)) throw new Error(t("Укажите название комнаты до 80 символов"));
    if (input.e2ee !== undefined && typeof input.e2ee !== 'boolean') throw new Error(t("Неверный режим шифрования"));
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65532) throw new Error(t("Укажите порт от 1024 до 65532"));
    this.starting = true;
    this.cancelled = false;
    try {
      await checkPorts(port);
      this.directory = await mkdtemp(path.join(tmpdir(), 'voicecord-room-'));
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
      if (this.cancelled) throw new Error(t("Создание комнаты отменено: компьютер перешёл в сон"));
      const lan = localAddresses();
      const nodeIP = publicIPv4(externalIP) && mapped ? externalIP : lan[0];
      if (!nodeIP) throw new Error(t("Не найден сетевой адрес компьютера"));
      const key = 'vc_' + randomBytes(12).toString('hex'), secret = randomBytes(32).toString('hex');
      // This key stays in the client process and invitations, never in Go/LiveKit.
      const mediaKey = input.e2ee ? randomBytes(32).toString('hex') : null;
      const mediaKeyID = mediaKey ? createHash('sha256').update(Buffer.from(mediaKey, 'hex')).digest('hex') : '';
      const config = path.join(this.directory, 'livekit.yaml');
      await writeFile(config, `port: ${port+3}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: ${port+1}\n  udp_port: ${port+2}\n  use_external_ip: false\n  advertise_internal_ip: true\n  node_ip: ${nodeIP}\n  enable_loopback_candidate: true\n  stun_servers: []\nkeys:\n  ${key}: ${secret}\nroom:\n  auto_create: true\n  max_participants: 30\nlogging:\n  level: error\n`, { mode: 0o600 });
      const api = spawn(path.join(this.resources, 'voicecord-api.exe'), ['selfhost'], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      if (process.env.VOICECORD_SELFHOST_DEBUG === '1') api.stderr.on('data', data => console.error('selfhost:', data.toString()));
      else api.stderr.resume();
      api.stdin.on('error', () => {});
      this.children.push(api);
      const ready = childReady(api, line => { try { const v = JSON.parse(line); return /^[a-f0-9]{64}$/.test(v.fingerprint) ? v : null; } catch { return null; } });
      api.stdin.write(JSON.stringify({ Port: port, MediaPort: port+3, Key: key, Secret: secret, Password: input.password, RequireE2EE: !!mediaKey, E2EEKeyID: mediaKeyID, Addresses: [...lan, ...(mapped && publicIPv4(externalIP) ? [externalIP] : [])], MediaExecutable: path.join(this.resources, 'livekit-server.exe'), MediaConfig: config })+'\n');
      const { fingerprint } = await ready;
      if (this.cancelled) throw new Error(t("Создание комнаты отменено: компьютер перешёл в сон"));
      api.once('exit', () => { if (this.state.running) void this.stop(t("Сервер комнаты остановился")); });
      const invite = ip => `voicecord://${ip}:${port}/${fingerprint}#password=${encodeURIComponent(input.password)}&name=${encodeURIComponent(input.name || t("Комната"))}${mediaKey ? '&e2ee=' + mediaKey : ''}`;
      const internet = mapped && publicIPv4(externalIP);
      this.state = { running: true, e2ee: !!mediaKey, name: input.name || t("Комната"), port, mapped, internet, localAddress: invite('127.0.0.1'), invitations: [...(internet ? [invite(externalIP)] : []), ...lan.map(invite)], message: internet ? t("Порты открыты на роутере. Доступность из интернета не проверена.") : t("Комната работает в локальной сети. Автопроброс недоступен или у провайдера дополнительный NAT."), fingerprint };
      this.onChange(this.state); return this.state;
    } catch (error) { await this.cleanup(); throw error; }
    finally { this.starting = false; }
  }
  async cleanup() {
    for (const child of this.children.splice(0)) {
      const exited = new Promise(resolve => { child.once('exit', resolve); if (child.exitCode !== null) resolve(); });
      child.stdin?.end();
      try { await bounded(exited, 3000, 'shutdown timeout'); } catch { child.kill(); }
    }
    if (this.mapper) { const mapper = this.mapper; this.mapper = undefined; try { const exited = new Promise(resolve => { mapper.once('exit', resolve); if (mapper.exitCode !== null) resolve(); }); if (mapper.connected) mapper.send({ stop: true }); await bounded(exited, 8000, 'cleanup timeout'); } catch { mapper.kill(); } }
    if (this.directory) {
      const directory = path.resolve(this.directory);
      if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('voicecord-room-')) throw new Error('Invalid temporary room directory');
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
module.exports = { SelfHost, publicIPv4, localAddresses, checkPorts };
