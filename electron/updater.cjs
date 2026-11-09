const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { labels, helperLaunch, waitForHelper } = require('./update-progress.cjs');

const REPOSITORY = 'IlyaRusskikh/PawTalk';
const { verifyManifest, UpdateSecurityError } = require('./update-manifest.cjs');
const { metadata, download } = require('./update-transport.cjs');
const MAX_SIZE = 1024 * 1024 * 1024;
function version(value) {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  return m ? { numbers: m.slice(1, 4).map(Number), pre: m[4]?.split('.') } : null;
}
function compare(a, b) {
  const x = version(a), y = version(b);
  if (!x || !y) throw new Error('Invalid version');
  for (let i = 0; i < 3; i++) if (x.numbers[i] !== y.numbers[i]) return Math.sign(x.numbers[i] - y.numbers[i]);
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i], r = y.pre[i];
    if (l === r) continue;
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    if (ln && rn) return Math.sign(Number(l) - Number(r));
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}
function selectRelease(releases, current) {
  return releases.filter(r => !r.draft && version(r.tag_name || '') && compare(r.tag_name, current) > 0)
    .sort((a, b) => compare(b.tag_name, a.tag_name)).flatMap(r => {
      const v = r.tag_name.replace(/^v/, '');
      const asset = r.assets?.find(a => [ `PawTalk Setup ${v}.exe`, `PawTalk.Setup.${v}.exe` ].includes(a.name)
        && a.state === 'uploaded' && Number.isSafeInteger(a.size) && a.size > 0 && a.size <= MAX_SIZE
        && /^sha256:[a-f0-9]{64}$/i.test(a.digest || '')
        && validAssetURL(a.browser_download_url, r.tag_name));
      return asset ? [{ version: v, prerelease: !!r.prerelease, asset }] : [];
    })[0] || null;
}
function validAssetURL(value, tag) {
  try {
    const u = new URL(value);
    const parts = u.pathname.split('/');
    return u.protocol === 'https:' && u.hostname === 'github.com' && !u.port && !u.username && !u.password && !u.search && !u.hash
      // GitHub owner/repository names are case-insensitive; tags and asset paths
      // remain case-sensitive. Do not normalize the entire download path.
      && parts.slice(1, 3).join('/').toLowerCase() === REPOSITORY.toLowerCase()
      && parts.slice(3).join('/').startsWith(`releases/download/${encodeURIComponent(tag)}/`);
  } catch { return false; }
}
class Updater {
  constructor({ current, directory, script, installDirectory, executable = path.join(installDirectory || '', 'PawTalk.exe'), language = () => 'ru', fetcher = fetch, launch = spawn, onState = () => {}, rooms = () => [], roomFetcher = fetcher, keys, downloadPolicy }) {
    Object.assign(this, { current, directory, script, installDirectory, executable, language, fetcher, launch, onState, rooms, roomFetcher, keys, downloadPolicy });
    this.state = { status: 'idle' }; this.release = null; this.busy = false;
  }
  set(value) { this.state = value; this.onState(value); return value; }
  async *sources() {
    yield null;
    const seen = new Set();
    for (const room of this.rooms().slice(0, 50)) {
      try {
        const source = await room.prepare();
        if (!source || seen.has(source.base)) continue;
        seen.add(source.base); yield { ...source, name: room.name };
      } catch { /* Offline rooms and old invitations are skipped. */ }
    }
  }
  fetchFor(source) { return source ? this.roomFetcher : this.fetcher; }
  async checkSource(source) {
    const releases = [];
    for (let page = 1; page <= 10; page++) {
      const batch = JSON.parse(await metadata(this.fetchFor(source), source, 'releases?per_page=100&page=' + page));
      if (!Array.isArray(batch)) throw Error('Invalid releases');
      releases.push(...batch); if (batch.length < 100) break;
    }
    const release = selectRelease(releases, this.current);
    if (!release) return null;
    const raw = await metadata(this.fetchFor(source), source, 'assets/v' + release.version + '/update-manifest.json', 16384);
    let manifest;
    try {
      manifest = verifyManifest(raw, this.keys);
      if (manifest.version !== release.version || manifest.name !== release.asset.name || manifest.size !== release.asset.size
        || 'sha256:' + manifest.sha256 !== release.asset.digest.toLowerCase() || manifest.prerelease !== release.prerelease) throw Error();
    } catch { throw new UpdateSecurityError(source?.name || 'GitHub'); }
    if (this.directory) {
      const trustFile = path.join(this.directory, 'trusted-manifest.json');
      let previous;
      try { previous = await fs.readFile(trustFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous) {
        // Authenticate saved metadata even after its freshness deadline.
        const envelope = JSON.parse(previous);
        const saved = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
        const trusted = verifyManifest(previous, this.keys, saved.publishedAt);
        if (compare(manifest.version, trusted.version) < 0) throw new UpdateSecurityError(source?.name || 'GitHub');
      }
      await fs.mkdir(this.directory, { recursive: true });
      await fs.writeFile(trustFile + '.tmp', raw, { mode: 0o600 });
      await fs.rename(trustFile + '.tmp', trustFile);
    }
    return { ...release, manifest, signedManifest: raw, metadataSource: source?.name || 'GitHub' };
  }
  async check() {
    if (this.busy || this.release) return this.state;
    this.busy = true; this.set({ status: 'checking' });
    try {
      for await (const source of this.sources()) {
        try {
          this.release = await this.checkSource(source);
          return this.release ? this.set({ status: 'available', version: this.release.version, prerelease: this.release.prerelease }) : this.set({ status: 'idle' });
        } catch (error) {
          if (error.code === 'UPDATE_SECURITY') return this.set({ status: 'security-failed', source: error.source });
        }
      }
      return this.set({ status: 'check-failed' });
    } finally { this.busy = false; }
  }
  async install() {
    if (this.busy || !this.release) throw new Error('Update unavailable');
    this.busy = true;
    const { manifest, version: next, prerelease } = this.release;
    const partial = path.join(this.directory, 'installer.part');
    const installer = path.join(this.directory, `PawTalk-${next}.exe`);
    try {
      try { verifyManifest(this.release.signedManifest, this.keys); }
      catch { throw new UpdateSecurityError(this.release.metadataSource); }
      this.set({ status: 'downloading', version: next, prerelease, progress: 0 });
      await fs.mkdir(this.directory, { recursive: true });
      let downloaded = false;
      for await (const source of this.sources()) {
        try {
          this.set({ status: 'downloading', version: next, prerelease, progress: 0, source: source?.name || 'GitHub' });
          await download({ fetcher: this.fetchFor(source), source, manifest, partial, policy: this.downloadPolicy,
            onProgress: progress => this.set({ status: 'downloading', version: next, prerelease, progress, source: source?.name || 'GitHub' }) });
          downloaded = true; break;
        } catch (error) {
          await fs.rm(partial, { force: true });
          if (error.code === 'UPDATE_SECURITY' || ['ENOSPC', 'EACCES', 'EPERM'].includes(error.code)) throw error;
        }
      }
      if (!downloaded) throw Error('No update source available');
      await fs.rename(partial, installer);
      const helper = path.join(this.directory, 'install-update.ps1');
      await fs.copyFile(this.script, helper);
      const token = randomUUID();
      const ready = path.join(this.directory, `ready-${token}`);
      const status = path.join(this.directory, 'installation.json');
      const labelsFile = path.join(this.directory, 'update-labels.json');
      await fs.writeFile(labelsFile, JSON.stringify(labels[this.language()] || labels.ru));
      await fs.writeFile(status, JSON.stringify({ token, version: next, executable: this.executable, phase: 'preparing' }));
      // The NSIS installer invokes the registered old uninstaller with --updated,
      // preserves user data, then installs and launches the replacement.
      const log = await fs.open(path.join(this.directory, 'update-launch.log'), 'a');
      let child;
      try {
        const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const workerArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
          '-Installer', installer, '-ParentId', String(process.pid), '-InstallDirectory', this.installDirectory,
          '-Executable', this.executable, '-StatusFile', status, '-ReadyFile', ready, '-Token', token, '-Version', next, '-LabelsFile', labelsFile];
        child = this.launch(powershell, helperLaunch(powershell, workerArgs, this.directory),
        // Windows PowerShell's ConsoleHost may exit without executing anything
        // under DETACHED_PROCESS. Keep its hidden console and unref the child.
        { detached: false, stdio: ['ignore', log.fd, log.fd], windowsHide: true, cwd: this.directory });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      } finally { await log.close(); }
      await waitForHelper(ready, token, child);
      child.unref();
      return this.set({ status: 'installing', version: next, prerelease });
    } catch (error) {
      await fs.appendFile(path.join(this.directory, 'update-launch.log'), `${new Date().toISOString()} ${error.message}\n`).catch(() => {});
      await fs.rm(partial, { force: true }).catch(() => {});
      return this.set({ status: error.code === 'UPDATE_SECURITY' ? 'security-failed' : 'failed', source: error.source, version: next, prerelease });
    } finally { this.busy = false; }
  }
}
module.exports = { Updater, compare, selectRelease, validAssetURL };
