// Only signaling uses this loopback bridge; audio/ICE stays directly in LiveKit.
// Chromium's hostname-only certificate-verification cache cannot isolate two
// different pinned servers on one IP. Each upstream socket is verified here
// before an HTTP header, media JWT or WebSocket byte can leave the process.
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { isIP } = require('node:net');
const { randomBytes, createHash } = require('node:crypto');
class VoiceSignal {
  async open(address, fingerprint) {
    this.close();
    const remote = new URL(address);
    if (remote.protocol !== 'wss:' || remote.username || remote.password || remote.search || remote.hash || (fingerprint && !/^[a-f0-9]{64}$/.test(fingerprint))) throw Error('Invalid media endpoint');
    const capability = '/' + randomBytes(32).toString('hex'), sockets = new Set(), pending = new Set();
    const hostname = remote.hostname.replace(/^\[|\]$/g, '');
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => {
      let completed = false;
      const done = (error, socket) => { if (!completed) { completed = true; callback(error, socket); } };
      const socket = tls.connect({ host: hostname, port: Number(remote.port) || 443, servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: !fingerprint }, () => {
        const raw = socket.getPeerCertificate().raw;
        if (fingerprint && (!raw || createHash('sha256').update(raw).digest('hex') !== fingerprint)) { const error = Error('Media TLS pin mismatch'); done(error); socket.destroy(); return; }
        socket.setTimeout(0); done(null, socket);
      });
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      socket.setTimeout(10000, () => socket.destroy(Error('Media TLS timeout')));
      socket.once('error', error => done(error));
      return undefined;
    };
    function upstream(request, response, socket, head) {
      if (!request.url.startsWith(capability + '/') || pending.size >= 16 || request.headers.host !== `127.0.0.1:${server.address()?.port}`) { response?.writeHead(404).end(); socket?.destroy(); return; }
      const suffix = request.url.slice(capability.length);
      if (!/^\/rtc(?:\/|\?)/.test(suffix) || suffix.includes('\\') || suffix.length > 16384) { response?.writeHead(404).end(); socket?.destroy(); return; }
      const headers = { ...request.headers, host: remote.host };
      delete headers.cookie; delete headers['proxy-authorization'];
      const upstream = https.request({ hostname, port: Number(remote.port) || 443, path: remote.pathname.replace(/\/$/, '') + suffix, method: request.method, headers, agent });
      pending.add(upstream); upstream.once('close', () => pending.delete(upstream));
      upstream.on('error', () => { if (response && !response.headersSent) response.writeHead(502).end(); else response?.destroy(); socket?.destroy(); });
      upstream.setTimeout(10000, () => upstream.destroy(Error('Media signaling timeout')));
      if (socket) {
        upstream.on('upgrade', (incoming, peer, upstreamHead) => {
          peer.setTimeout(0); socket.setTimeout(0);
          socket.write(`HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}\r\n` + incoming.rawHeaders.reduce((lines, value, index) => index % 2 ? lines + value + '\r\n' : lines + value + ': ', '') + '\r\n');
          if (head?.length) peer.write(head); if (upstreamHead.length) socket.write(upstreamHead);
          peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy());
          peer.once('close', () => socket.destroy()); socket.once('close', () => peer.destroy()); socket.pipe(peer).pipe(socket);
        });
        upstream.on('response', incoming => { incoming.resume(); socket.destroy(); }); upstream.end();
      } else {
        upstream.on('response', incoming => { if(incoming.statusCode>=300&&incoming.statusCode<400){incoming.resume();response.writeHead(502).end();return;} const headers={ ...incoming.headers, 'access-control-allow-origin': '*', 'cache-control': 'no-store' };delete headers['set-cookie']; response.writeHead(incoming.statusCode, headers); incoming.pipe(response); });
        let size = 0; request.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { request.destroy(); upstream.destroy(); } }); request.pipe(upstream);
        response.once('close', () => upstream.destroy());
      }
    }
    const server = http.createServer((request, response) => upstream(request, response));
    server.headersTimeout = 5000; server.requestTimeout = 10000; server.maxHeadersCount = 64;
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('upgrade', (request, socket, head) => upstream(request, undefined, socket, head));
    this.closeCurrent = () => { for (const request of pending) request.destroy(); for (const socket of sockets) socket.destroy(); agent.destroy(); server.close(); };
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return `ws://127.0.0.1:${server.address().port}${capability}`;
  }
  close() { this.closeCurrent?.(); this.closeCurrent = undefined; }
}
module.exports = { VoiceSignal };
