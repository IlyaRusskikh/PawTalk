const { t } = require('../shared/i18n.cjs');
const { spawn } = require('node:child_process');
const path = require('node:path');

function parseResult(line) {
  if (!line.startsWith('PAWTALK_PREFLIGHT_RESULT:')) return null;
  const result = JSON.parse(line.slice('PAWTALK_PREFLIGHT_RESULT:'.length));
  if (!['internet', 'unconfirmed', 'error', 'cancelled'].includes(result.state) ||
      !Array.isArray(result.tcp) || result.tcp.length !== 2 || result.tcp.some(v => typeof v !== 'boolean') ||
      typeof result.udp !== 'boolean' || (result.state === 'internet' && (!result.tcp.every(Boolean) || !result.udp))) {
    throw new Error(t("Неверный результат проверки сети."));
  }
  const value = { state: result.state, tcp: result.tcp, udp: result.udp };
  if (['no-interface', 'no-public-ip', 'ports-in-use', 'check-failed', 'checker-unavailable'].includes(result.reason)) value.reason = result.reason;
  return value;
}

class HostCheck {
  constructor(script, launch = spawn) { this.script = script; this.launch = launch; this.current = null; }
  get running() { return !!this.current; }
  start(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65532) throw new Error(t("Укажите порт от 1024 до 65532."));
    if (this.current) throw new Error(t("Проверка сети уже выполняется."));
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = this.launch(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-Port', String(port), '-Seconds', '60', '-Application'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const run = { child, done: null, cancelled: false };
    this.current = run;
    run.done = new Promise((resolve, reject) => {
      let pending = '', result = null, protocolError = false;
      const timeout = setTimeout(() => this.cancel(), 100000);
      child.stdin.on('error', () => {});
      child.stdout.on('data', data => {
        pending += data.toString('utf8');
        if (pending.length > 65536) { protocolError = true; pending = ''; void this.cancel(); return; }
        let index;
        while ((index = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, index).trim(); pending = pending.slice(index + 1);
          try { result = parseResult(line) || result; }
          catch { protocolError = true; void this.cancel(); }
        }
      });
      child.stderr.resume();
      child.once('error', () => {
        clearTimeout(timeout); if (this.current === run) this.current = null;
        reject(new Error(t("Не удалось запустить проверку сети. Нужен Windows PowerShell.")));
      });
      child.once('close', code => {
        clearTimeout(timeout); clearTimeout(run.killTimer);
        if (this.current === run) this.current = null;
        if (run.cancelled) { resolve({ state: 'cancelled', tcp: [false, false], udp: false }); return; }
        if (code !== 0 || protocolError || !result) { reject(new Error(t("Не удалось получить результат проверки сети. Попробуйте ещё раз."))); return; }
        resolve(result);
      });
    });
    return run.done;
  }
  async cancel() {
    const run = this.current;
    if (!run) return;
    if (!run.cancelled) {
      run.cancelled = true;
      run.child.stdin.end('q\n');
      // Give finally enough time to remove leases, even if the router is slow.
      run.killTimer = setTimeout(() => run.child.kill(), 20000);
    }
    await run.done?.catch(() => {});
  }
}
module.exports = { HostCheck, parseResult };
