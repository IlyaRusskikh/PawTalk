const { createHash, createPublicKey, generateKeyPairSync, diffieHellman, randomBytes, sign, verify } = require('node:crypto');
const { signatureFrame } = require('../shared/membership.cjs');
const { sealLinkedRoot, openLinkedRoot, rootKeyID } = require('../shared/server-crypto.mjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const id = () => randomBytes(16).toString('hex');
const checkHex = (value, size) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${size}}$`).test(value);
const error = code => Object.assign(Error(code), { code });
function rawPublic(key) { return key.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'); }
function publicKey(raw, type) {
  if (typeof raw !== 'string' || !/^[\w-]{43}$/.test(raw)) throw error('INVALID_LINK_KEY');
  const header = type === 'x25519' ? '302a300506032b656e032100' : '302a300506032b6570032100';
  return createPublicKey({ key: Buffer.concat([Buffer.from(header, 'hex'), Buffer.from(raw, 'base64url')]), type: 'spki', format: 'der' });
}
function transcript(serverId, link) {
  return signatureFrame('pawtalk-link-v2', serverId, link.id, link.sourceProfileId, link.targetProfileId, link.chosenProfileId,
    link.sourceDeviceId, link.targetDeviceId, link.sourceExchangeKey, link.targetExchangeKey, String(link.sourceRevision), String(link.targetRevision));
}
function envelopeFrame(domain, frame, packet) { return signatureFrame(domain, digest(frame), digest(JSON.stringify(packet))); }

class MembershipLinks {
  constructor(client) { this.client = client; this.pending = new Map(); }
  prune() {for(const [id,entry] of this.pending)if(entry.link.expiresAt<=Date.now())this.pending.delete(id);}
  context(linkId) {
    this.prune();
    const entry = this.pending.get(linkId);
    if (!entry || entry.link.expiresAt <= Date.now()) { this.pending.delete(linkId); throw error('LINK_EXPIRED'); }
    return entry;
  }
  async start(serverId) {
    this.prune();if(this.pending.size>=64)throw error('LINK_LIMIT');
    const connection = this.client.connections.get(serverId); if (!connection) throw error('NOT_CONNECTED');
    const identity = await this.client.identity(), state = await this.client.state(serverId);
    if (!state.devices.some(device => device.id === identity.deviceId && device.primary)) throw error('PRIMARY_DEVICE_REQUIRED');
    const exchange = generateKeyPairSync('x25519'), rawToken = randomBytes(32), requestId = id();
    const link = await this.client.signed(connection, '/api/v2/links', { requestId, tokenHash: digest(rawToken), exchangeKey: rawPublic(exchange.publicKey) });
    if (link.id !== requestId || link.targetDeviceId !== identity.deviceId || link.targetProfileId !== state.self.effectiveProfileId || link.targetExchangeKey !== rawPublic(exchange.publicKey)) throw error('INVALID_LINK_RESPONSE');
    this.pending.set(link.id, { side: 'target', connection, exchange, link });
    const url = new URL(connection.address);
    url.hash = new URLSearchParams({ v: '2', server: serverId, link: link.id, token: rawToken.toString('base64url'), target: link.targetProfileId,
      targetDevice: link.targetDeviceId, targetKey: link.targetExchangeKey, targetRevision: String(link.targetRevision), signer: identity.deviceKey }).toString();
    return { id: link.id, text: url.toString(), expiresAt: link.expiresAt };
  }
  async propose(text, nickname, deviceLabel, chosen = 'target') {
    this.prune();if(this.pending.size>=64)throw error('LINK_LIMIT');
    if (typeof text !== 'string' || text.length > 14000) throw error('INVALID_LINK');
    const url = new URL(text), params = new URLSearchParams(url.hash.slice(1));
    const serverId = params.get('server'), linkId = params.get('link'), token = params.get('token');
    const target = params.get('target'), targetDevice = params.get('targetDevice'), targetKey = params.get('targetKey'), signer = params.get('signer');
    const targetRevision = Number(params.get('targetRevision'));
    if (params.get('v') !== '2' || !checkHex(serverId, 32) || !checkHex(linkId, 32) || !checkHex(target, 64) || !checkHex(targetDevice, 64) || !/^[\w-]{43}$/.test(token || '') || !Number.isSafeInteger(targetRevision) || targetRevision < 1 || !['target', 'source'].includes(chosen)) throw error('INVALID_LINK');
    publicKey(targetKey, 'x25519'); publicKey(signer, 'ed25519');
    if (digest(Buffer.from(signer, 'base64url')) !== targetDevice) throw error('INVALID_LINK_KEY');
    const connection = await this.client.verified(text, serverId), identity = await this.client.identity();
    let sourceRoot = identity.profileId, sourceRevision = 1;
    try {
      const session = await this.client.signed(connection, '/api/v2/session', {});
      connection.token = session.sessionToken;
      const state = await this.client.fetchJSON(connection.base, '/api/v2/state', { fingerprint: connection.fingerprint,headers: { Authorization: 'Bearer ' + connection.token } });
      if (!state.devices.some(device => device.id === identity.deviceId && device.primary)) throw error('PRIMARY_DEVICE_REQUIRED');
      sourceRoot = state.self.effectiveProfileId; sourceRevision = state.controlRevision;
    } catch (failure) { if (failure.code !== 'NOT_A_MEMBER') throw failure; }
    const exchange = generateKeyPairSync('x25519');
    const proposal = { id: linkId, targetProfileId: target, targetDeviceId: targetDevice, targetExchangeKey: targetKey, targetRevision,
      sourceProfileId: sourceRoot, sourceDeviceId: identity.deviceId, sourceExchangeKey: rawPublic(exchange.publicKey), sourceRevision,
      chosenProfileId: chosen === 'target' ? target : sourceRoot };
    const frame = transcript(serverId, proposal);
    const link = await this.client.signed(connection, `/api/v2/links/${linkId}/propose`, { token, nickname, deviceLabel, exchangeKey: proposal.sourceExchangeKey,
      chosenProfileId: proposal.chosenProfileId, signature: sign(null, frame, identity.device).toString('base64url') });
    if (digest(transcript(serverId, link)) !== digest(frame)) throw error('LINK_TRANSCRIPT_CHANGED');
    this.pending.set(linkId, { side: 'source', connection, exchange, link, signer, frame });
    return { id: linkId, code: digest(frame).slice(0, 10), chosenProfileId: link.chosenProfileId, expiresAt: link.expiresAt };
  }
  async status(linkId) {
    const ctx = this.context(linkId), serverId = ctx.connection.config.serverId;
    const link = await this.client.signed(ctx.connection, `/api/v2/links/${linkId}/status`, {});
    if (link.targetDeviceId !== ctx.link.targetDeviceId || link.targetProfileId !== ctx.link.targetProfileId || link.targetExchangeKey !== ctx.link.targetExchangeKey || link.targetRevision !== ctx.link.targetRevision) throw error('LINK_TRANSCRIPT_CHANGED');
    if (link.sourceDeviceId) {
      if (digest(Buffer.from(link.sourceDeviceKey, 'base64url')) !== link.sourceDeviceId) throw error('INVALID_LINK_KEY');
      const certified = signatureFrame('pawtalk-device-v2', link.sourceProfileKey, link.sourceDeviceKey);
      if (!verify(null, certified, publicKey(link.sourceProfileKey, 'ed25519'), Buffer.from(link.sourceCertificate, 'base64url'))) throw error('INVALID_LINK_CERTIFICATE');
      const frame = transcript(serverId, link);
      if (!verify(null, frame, publicKey(link.sourceDeviceKey, 'ed25519'), Buffer.from(link.sourceProof, 'base64url'))) throw error('INVALID_LINK_SIGNATURE');
      if (ctx.side === 'source' && digest(frame) !== digest(ctx.frame)) throw error('LINK_TRANSCRIPT_CHANGED');
      ctx.frame = frame;
    }
    ctx.link = link;
    return { id: linkId, state: link.state, code: ctx.frame ? digest(ctx.frame).slice(0, 10) : '', chosenProfileId: link.chosenProfileId,
      sourceProfileId: link.sourceProfileId, targetProfileId: link.targetProfileId, sourceNickname: typeof link.sourceNickname==='string'&&link.sourceNickname.length<=128?link.sourceNickname:undefined, targetNickname: typeof link.targetNickname==='string'&&link.targetNickname.length<=128?link.targetNickname:undefined, expiresAt: link.expiresAt };
  }
  async approve(linkId) {
    const ctx = this.context(linkId); if (ctx.side !== 'target') throw error('PRIMARY_DEVICE_REQUIRED');
    await this.status(linkId);
    if (ctx.link.state !== 'proposed') throw error('LINK_CHANGED');
    const identity = await this.client.identity(), serverId = ctx.connection.config.serverId;
    const shared = diffieHellman({ privateKey: ctx.exchange.privateKey, publicKey: publicKey(ctx.link.sourceExchangeKey, 'x25519') }).toString('hex');
    const keyEnvelope = await sealLinkedRoot(ctx.connection.secret, serverId, linkId, shared, ctx.frame);
    const signature = sign(null, envelopeFrame('pawtalk-link-approval-v2', ctx.frame, keyEnvelope), identity.device).toString('base64url');
    ctx.link = await this.client.signed(ctx.connection, `/api/v2/links/${linkId}/approve`, { signature, keyEnvelope });
    return this.status(linkId);
  }
  async finish(linkId) {
    const ctx = this.context(linkId); if (ctx.side !== 'source') throw error('INVALID_LINK');
    await this.status(linkId);
    if (!['approved', 'confirmed'].includes(ctx.link.state)) throw error('LINK_NOT_APPROVED');
    if (!verify(null, envelopeFrame('pawtalk-link-approval-v2', ctx.frame, ctx.link.keyEnvelope), publicKey(ctx.signer, 'ed25519'), Buffer.from(ctx.link.targetProof, 'base64url'))) throw error('INVALID_LINK_SIGNATURE');
    const serverId = ctx.connection.config.serverId, identity = await this.client.identity();
    const shared = diffieHellman({ privateKey: ctx.exchange.privateKey, publicKey: publicKey(ctx.link.targetExchangeKey, 'x25519') }).toString('hex');
    const secret = await openLinkedRoot(ctx.link.keyEnvelope, serverId, linkId, shared, ctx.frame);
    const slot = 'pawtalk:server:v2:' + serverId, previous = await this.client.credentials.load(slot);
    if (previous && JSON.parse(previous).secret && await rootKeyID(JSON.parse(previous).secret) !== await rootKeyID(secret)) throw error('SERVER_KEY_CHANGED');
    await this.client.credentials.save(slot, JSON.stringify({ secret }));
    const signature = sign(null, envelopeFrame('pawtalk-link-accept-v2', ctx.frame, ctx.link.keyEnvelope), identity.device).toString('base64url');
    await this.client.signed(ctx.connection, `/api/v2/links/${linkId}/confirm`, { signature });
    const session = await this.client.signed(ctx.connection, '/api/v2/session', {});
    ctx.connection.token = session.sessionToken; ctx.connection.secret = secret;
    this.client.connections.set(serverId, ctx.connection);
    await this.client.remember(ctx.connection); this.pending.delete(linkId);
    return this.client.state(serverId);
  }
  async unlink(serverId, deviceId, revoke = false) {
    const connection = this.client.connections.get(serverId); if (!connection || !checkHex(deviceId, 64)) throw error('INVALID_DEVICE');
    return this.client.signed(connection, `/api/v2/devices/${deviceId}/${revoke ? 'revoke' : 'unlink'}`, { requestId: id() });
  }
  async transferCreate(serverId, newDeviceId) {
    const state = await this.client.state(serverId), identity = await this.client.identity();
    if (!state.devices.some(device => device.id === identity.deviceId && device.primary) || !state.devices.some(device => device.id === newDeviceId && !device.primary)) throw error('PRIMARY_DEVICE_REQUIRED');
    const value = { version: 2, serverId, profileId: state.self.effectiveProfileId, oldDeviceId: identity.deviceId, newDeviceId, revision: state.controlRevision, requestId: id(), oldKey: identity.deviceKey, expiresAt: Date.now() + 600000 };
    const frame = this.controlFrame(value);
    value.oldSignature = sign(null, frame, identity.device).toString('base64url');
    this.controlPending ||= new Map();
    for (const [key, value] of this.controlPending) if (value.expiresAt <= Date.now()) this.controlPending.delete(key);
    if (this.controlPending.size >= 16) throw error('LINK_LIMIT');
    this.controlPending.set(value.requestId, value);
    return 'pawtalk-control-v2:' + Buffer.from(JSON.stringify(value)).toString('base64url');
  }
  controlFrame(value) {
    if (value.version !== 2 || !checkHex(value.serverId, 32) || !checkHex(value.profileId, 64) || !checkHex(value.oldDeviceId, 64) || !checkHex(value.newDeviceId, 64) || !checkHex(value.requestId, 32) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) throw error('INVALID_CONTROL_TRANSFER');
    return signatureFrame('pawtalk-control-v2', value.serverId, value.profileId, value.oldDeviceId, value.newDeviceId, String(value.revision), value.requestId);
  }
  readControl(text) {
    if (typeof text !== 'string' || text.length > 4096 || !text.startsWith('pawtalk-control-v2:')) throw error('INVALID_CONTROL_TRANSFER');
    try { return JSON.parse(Buffer.from(text.slice(19), 'base64url').toString('utf8')); } catch { throw error('INVALID_CONTROL_TRANSFER'); }
  }
  async transferAccept(serverId, text) {
    const value = this.readControl(text), frame = this.controlFrame(value), identity = await this.client.identity(), state = await this.client.state(serverId);
    if (value.serverId !== serverId || value.profileId !== state.self.effectiveProfileId || value.newDeviceId !== identity.deviceId || value.revision !== state.controlRevision || !state.devices.some(device => device.id === value.oldDeviceId && device.primary) || digest(Buffer.from(value.oldKey, 'base64url')) !== value.oldDeviceId || !verify(null, frame, publicKey(value.oldKey, 'ed25519'), Buffer.from(value.oldSignature, 'base64url'))) throw error('INVALID_CONTROL_TRANSFER');
    value.newSignature = sign(null, frame, identity.device).toString('base64url');
    return 'pawtalk-control-v2:' + Buffer.from(JSON.stringify(value)).toString('base64url');
  }
  async transferFinish(serverId, text) {
    const value = this.readControl(text); this.controlFrame(value);
    const pending = this.controlPending?.get(value.requestId);
    if (value.serverId !== serverId || !pending || Object.entries(pending).some(([key, expected]) => value[key] !== expected)) throw error('INVALID_CONTROL_TRANSFER');
    this.controlFinishes ||= new Map();
    for(const [key,entry] of this.controlFinishes)if(entry.expiresAt<=Date.now())this.controlFinishes.delete(key);
    const fingerprint=digest(JSON.stringify(value));
    let finish=this.controlFinishes.get(value.requestId);
    if(finish&&finish.fingerprint!==fingerprint)throw error('INVALID_CONTROL_TRANSFER');
    if(!finish){
      const promise=this.client.request(serverId, '/api/v2/control', 'POST', { newDeviceId: value.newDeviceId, requestId: value.requestId, expectedRevision: value.revision, oldSignature: value.oldSignature, newSignature: value.newSignature });
      finish={fingerprint,expiresAt:value.expiresAt,promise};this.controlFinishes.set(value.requestId,finish);
      promise.catch(()=>{if(this.controlFinishes.get(value.requestId)===finish)this.controlFinishes.delete(value.requestId);});
    }
    await finish.promise;
    // Keep the original signed request until TTL, so a response lost after the
    // mutation can be recovered without reporting an invalid transfer.
    return this.client.state(serverId);
  }
}
module.exports = { MembershipLinks };
