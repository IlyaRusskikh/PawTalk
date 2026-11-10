// Live GitHub check using Electron's network stack. --selfhost also downloads
// through a real embedded room with direct client access disabled. Never installs.
const { app, net, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { X509Certificate, randomBytes } = require('node:crypto');
const { Updater, compare } = require('../electron/updater.cjs');
const { SelfHost } = require('../electron/selfhost.cjs');
const { UpdateRooms } = require('../electron/update-rooms.cjs');
const { invitation } = require('../electron/address.cjs');
const { localInvitation, verifyInvitation } = require('../electron/connection.cjs');
const { download } = require('../electron/update-transport.cjs');
// Isolate Chromium caches from the running client and other Electron checks.
const profile = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'pawtalk-update-profile-'));
app.setPath('userData', profile);

async function selfhostCheck(current) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pawtalk-update-live-'));
  const host = new SelfHost(path.resolve(__dirname, '../resources/server'));
  const pins = new Map();
  const fingerprint = certificate => new X509Certificate(certificate.data).fingerprint256.replaceAll(':', '').toLowerCase();
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const pin = pins.get(request.hostname);
    callback(pin ? (fingerprint(request.certificate) === pin ? 0 : -2) : -3);
  });
  const certificateError = (event, _contents, url, _error, certificate, callback) => {
    if (pins.get(new URL(url).hostname) === fingerprint(certificate)) { event.preventDefault(); callback(true); }
    else callback(false);
  };
  app.on('certificate-error', certificateError);
  try {
    const status = await host.start({ port: 31443, password: randomBytes(24).toString('base64url') });
    await verifyInvitation(status.localAddress);
    // A successful router mapping prepends a public invitation. A LAN test must
    // not depend on the router supporting NAT hairpin through that address.
    let address;
    for (const candidate of status.invitations.slice(status.internet ? 1 : 0)) {
      // VPN/container adapters can advertise an unreachable local address.
      try { await verifyInvitation(candidate); address = candidate; break; } catch {}
    }
    assert.ok(address, 'a reachable LAN invitation is required; host running: ' + host.status().running);
    const trust = value => { const room = invitation(value); pins.set(room.hostname, room.fingerprint); };
    const blocked = async () => { throw Error('Direct client GitHub access deliberately blocked'); };
    const requests = [], failures = [];
    const roomFetcher = async (url, options) => {
      assert.ok(url.startsWith(invitation(address).origin + '/api/updates/'), 'guest must use LAN, not loopback');
      assert.equal(options.redirect, 'error');
      assert.equal(new URL(url).hash, '', 'no invitation secrets in update requests');
      requests.push(url);
      try {
        const response = await net.fetch(url, options);
        if (!response.ok) throw Error(`Selfhost relay HTTP ${response.status}: ${await response.text()}`);
        return response;
      } catch (error) { failures.push(error.message); throw error; }
    };
    const rooms = new UpdateRooms(path.join(directory, 'rooms.json'), { verify: verifyInvitation, trust });
    rooms.set([{ address: address.split('#')[0], name: 'Self-host LAN relay' }]);
    await rooms.sources()[0].prepare();
    const updater = new Updater({ current, directory, fetcher: blocked, roomFetcher, rooms: () => rooms.sources() });
    const state = await updater.check();
    assert.equal(state.status, 'available', JSON.stringify({ state, failures }));
    assert.ok(compare(state.version, current) > 0);
    assert.equal(updater.release.metadataSource, 'Self-host LAN relay');
    console.log(`PASS real selfhost LAN + Electron: ${current} -> ${state.version}, trusted release signature; direct client GitHub blocked`);
    const source = { ...await rooms.sources()[0].prepare(), name: 'Self-host LAN relay' };

    const ownerRooms = new UpdateRooms(path.join(directory, 'owner.json'), {
      effective: value => localInvitation(value, status), verify: verifyInvitation, trust });
    ownerRooms.set([{ address: address.split('#')[0], name: 'Own room' }]);
    assert.equal((await ownerRooms.sources()[0].prepare()).base, invitation(status.localAddress).origin);
    const owner = new Updater({ current, fetcher: blocked, roomFetcher: (...args) => net.fetch(...args), rooms: () => ownerRooms.sources() });
    assert.equal((await owner.check()).status, 'available', JSON.stringify(owner.state));
    const stale = address.split('#')[0].replace(/.$/, value => value === 'a' ? 'b' : 'a');
    rooms.set([{ address: stale, name: 'Stale invitation' }]);
    await assert.rejects(rooms.sources()[0].prepare(), { code: 'PAWTALK_CERTIFICATE_PIN' });
    console.log('PASS owner loopback rewrite and rejection of stale certificate pin');
    if (process.argv.includes('--metadata-only')) return;

    let progress = -1;
    await download({ fetcher: roomFetcher, source, manifest: updater.release.manifest,
      partial: path.join(directory, 'installer.part'), onProgress: value => {
        const step = Math.floor(value / 10) * 10;
        if (step !== progress) { progress = step; console.log(`Selfhost installer download: ${step}%`); }
      } });
    assert.equal((await fs.stat(path.join(directory, 'installer.part'))).size, updater.release.manifest.size);
    assert.ok(requests.some(url => url.includes('/releases?')), 'release list uses the relay');
    assert.ok(requests.some(url => url.endsWith('/update-manifest.json')), 'signed manifest uses the relay');
    assert.ok(requests.some(url => url.endsWith('/' + updater.release.manifest.name)), 'installer uses the relay');
    console.log(`PASS full released installer via selfhost relay: ${updater.release.manifest.size} bytes, signed size and SHA-256 verified; never executed`);

    await download({ fetcher: async (url, options) => {
      const response = await roomFetcher(url, options);
      assert.equal(response.headers.get('X-PawTalk-Update-Cache'), 'hit', 'second installer download must use disk cache');
      return response;
    }, source, manifest: updater.release.manifest, partial: path.join(directory, 'cached-installer.part'), onProgress: () => {} });
    console.log('PASS repeated installer download from selfhost disk cache, signed size and SHA-256 verified');

  } finally {
    await host.stop();
    app.removeListener('certificate-error', certificateError);
    session.defaultSession.setCertificateVerifyProc(null);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const current = process.env.PAWTALK_UPDATE_TEST_CURRENT || '0.6.0';
    if (process.argv.includes('--selfhost')) {
      await selfhostCheck(current);
      return;
    }
    const updater = new Updater({ current, fetcher: (...args) => net.fetch(...args) });
    const state = await updater.check();
    assert.equal(state.status, 'available', JSON.stringify(state));
    assert.ok(compare(state.version, current) > 0);
    assert.equal(updater.release.manifest.version, state.version);
    console.log(`PASS live Electron update check: ${current} -> ${state.version}, trusted signed manifest, no installation`);
  } catch (error) { console.error(error); exitCode = 1; }
  finally {
    // Chromium can retain profile handles until exit; keep only disposable caches.
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    app.exit(exitCode);
  }
});
