const {validatePoll}=require('../../../../shared/polls.mjs');
const {validMentions}=require('../../../../shared/mentions.mjs');
const { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } = require('node:crypto');
const { serverURL } = require('./address.cjs');
const { mediaEndpoint } = require('./media-endpoint.cjs');
const { signatureFrame, apiProtocolVersion } = require('../../../../shared/membership.cjs');
const cryptoV2 = require('../../../../shared/server-crypto.mjs');
const {inspectImage}=require('../../../../shared/image.mjs');
const seedHeader = Buffer.from('302e020100300506032b657004220420', 'hex');
const hexID = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const requestID = () => randomBytes(16).toString('hex');
function failure(code) { return Object.assign(Error(code), { code }); }
function validatedAttachment(f,images=false){
 const image=images&&['image/png','image/jpeg','image/webp'].includes(f?.mime);
 if(!f||!hexID(f.id,32)||typeof f.name!=='string'||!f.name.length||f.name.length>255||(!image&&!['image/gif','video/mp4','video/webm','audio/webm','audio/ogg','application/octet-stream'].includes(f.mime))||!Number.isSafeInteger(f.size)||f.size<1||f.size>(image?2:50)*1024*1024)throw failure('INVALID_ATTACHMENT');
 const result={id:f.id,name:f.name,mime:f.mime,size:f.size};
 if(f.poster!==undefined){if(!f.mime.startsWith('video/')||!f.poster||!hexID(f.poster.id,32)||!['image/png','image/jpeg','image/webp'].includes(f.poster.mime))throw failure('INVALID_ATTACHMENT');result.poster={id:f.poster.id,mime:f.poster.mime};}
 if(f.duration!==undefined){if(!f.mime.startsWith('video/')||!Number.isFinite(f.duration)||f.duration<0||f.duration>7*86400)throw failure('INVALID_ATTACHMENT');result.duration=f.duration;}
 if(f.voice!==undefined){const v=f.voice;if(!f.mime.startsWith('audio/')||!v||!Number.isFinite(v.duration)||v.duration<=0||v.duration>14400||!Array.isArray(v.waveform)||v.waveform.length>128||v.waveform.some(n=>!Number.isFinite(n)||n<0||n>1))throw failure('INVALID_ATTACHMENT');result.voice={duration:v.duration,waveform:v.waveform};}
 return result;
}
function validatedContent(content) {
  if (!content || typeof content !== 'object' || typeof content.text !== 'string') throw failure('INVALID_MESSAGE');
  if (Buffer.byteLength(content.text) > 4096) throw failure('MESSAGE_TOO_LARGE');
  const result = { text: content.text };
  if(content.mentions!==undefined)result.mentions=validMentions(content.text,content.mentions);
  if (content.reply !== undefined) {
    const reply = content.reply;
    if (!reply || !Number.isSafeInteger(reply.id) || reply.id <= 0 || typeof reply.author !== 'string' || reply.author.length > 64 || typeof reply.text !== 'string' || Buffer.byteLength(reply.text) > 4096) throw failure('INVALID_MESSAGE');
    result.reply = { id: reply.id, author: reply.author, text: reply.text };
  }
  if (content.image !== undefined) {
    const image = content.image;
    if (!image || !hexID(image.id, 32) || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mime)) throw failure('INVALID_IMAGE');
    result.image = { id: image.id, mime: image.mime };
    if(image.name!==undefined){if(typeof image.name!=='string'||!image.name.length||image.name.length>255)throw failure('INVALID_IMAGE');result.image.name=image.name;}
  }
  if(content.gif!==undefined){const g=content.gif;const safe=value=>{try{const u=new URL(value);return typeof value==='string'&&value.length<=2048&&u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443');}catch{return false;}};if(!g||content.text!==g.source||!safe(g.source)||!safe(g.url)||content.file||content.image||content.poll)throw failure('INVALID_MESSAGE');if(g.mime!==undefined&&!['image/gif','video/mp4','video/webm'].includes(g.mime))throw failure('INVALID_MESSAGE');result.gif={source:g.source,url:g.url,...(g.mime?{mime:g.mime}:{})};}
  if(content.checklist!==undefined){
    const c=content.checklist;
    if(!c||typeof c.everyone!=='boolean'||!Array.isArray(c.items)||!c.items.length||c.items.length>100||content.poll||content.image||content.file)throw failure('INVALID_CHECKLIST');
    const seen=new Set();for(const item of c.items){if(!item||!hexID(item.id,32)||seen.has(item.id)||typeof item.text!=='string'||!item.text.trim()||item.text.length>300)throw failure('INVALID_CHECKLIST');seen.add(item.id);}
    result.checklist={everyone:c.everyone,items:c.items.map(({id,text})=>({id,text}))};
  }
  if(content.file!==undefined){if(content.image)throw failure('INVALID_ATTACHMENT');result.file=validatedAttachment(content.file);}
  if(content.files!==undefined){
    if(content.file||content.image||content.gif||content.poll||content.checklist||!Array.isArray(content.files)||!content.files.length||content.files.length>10)throw failure('INVALID_ATTACHMENT');
    result.files=content.files.map(file=>validatedAttachment(file,true));
  }
  const attachmentIDs=[...(result.image?[result.image.id]:[]),...[...(result.file?[result.file]:[]),...(result.files||[])].flatMap(f=>[f.id,...(f.poster?[f.poster.id]:[])])];
  if(new Set(attachmentIDs).size!==attachmentIDs.length)throw failure('INVALID_ATTACHMENT');
  if(content.poll!==undefined){
    if(!hexID(content.poll.id,32)||!content.text.trim()||Array.from(content.text).length>300||content.image||content.reply)throw failure('INVALID_POLL');
    result.poll={id:content.poll.id,...validatePoll(content.poll)};
    if(content.pollResult!==undefined){if(content.pollResult!==true)throw failure('INVALID_POLL');result.pollResult=true;}
  }else if(content.pollResult!==undefined)throw failure('INVALID_POLL');
  return result;
}

class MembershipClient {
  constructor({ credentials, fetcher, verify, trust, allowLoopback = false }) {
    this.credentials = credentials; this.fetcher = fetcher; this.verify = verify; this.trust = trust;
    this.allowLoopback = allowLoopback; this.connections = new Map(); this.pendingIdentity = undefined;
    this.registryQueue = Promise.resolve();
    this.profileCache = new Map(); this.pendingMessages=new Map();
  }
  identity() {
    return this.pendingIdentity ??= (async () => {
      let saved = await this.credentials.load('pawtalk:identity:v2');
      if (!saved) {
        saved = JSON.stringify({ root: randomBytes(32).toString('hex'), device: randomBytes(32).toString('hex') });
        await this.credentials.save('pawtalk:identity:v2', saved);
      }
      const seeds = JSON.parse(saved);
      if (!hexID(seeds.root, 64) || !hexID(seeds.device, 64)) throw failure('INVALID_LOCAL_IDENTITY');
      const key = seed => createPrivateKey({ key: Buffer.concat([seedHeader, Buffer.from(seed, 'hex')]), format: 'der', type: 'pkcs8' });
      const root = key(seeds.root), device = key(seeds.device);
      const profileKey = createPublicKey(root).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
      const deviceKey = createPublicKey(device).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
      return {
        profileKey, deviceKey, profileId: hash(Buffer.from(profileKey, 'base64url')), deviceId: hash(Buffer.from(deviceKey, 'base64url')),
        certificate: sign(null, signatureFrame('pawtalk-device-v2', profileKey, deviceKey), root).toString('base64url'), device,
      };
    })().catch(error => { this.pendingIdentity = undefined; throw error; });
  }
  async fetchJSON(base, path, { method = 'GET', body, headers = {}, fingerprint } = {}) {
    if (!path.startsWith('/api/') || path.includes('#') || path.includes('\\')) throw failure('INVALID_API_PATH');
    const response = await this.fetcher(base + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(path.includes('/attachments/') ? 120000 : 10000), pawtalkTLSFingerprint: fingerprint,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body,
    });
    const reader = response.body?.getReader(); const chunks = []; let size = 0;
    if (reader) {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > (path.includes('/attachments/') ? 70 : 16) * 1024 * 1024) { await reader.cancel(); throw failure('RESPONSE_TOO_LARGE'); }
        chunks.push(next.value);
      }
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('INVALID_API_RESPONSE'); }
    if (!response.ok) {
      const code = result?.error?.code;
      const error=failure(typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'SERVER_ERROR');
      const details=result?.error?.details;
      if(details&&typeof details==='object'&&!Array.isArray(details)){
        error.details={};
        if(details.expiresAt===null||Number.isSafeInteger(details.expiresAt)&&details.expiresAt>0)error.details.expiresAt=details.expiresAt;
        if(['kicked','left','linked'].includes(details.membershipState))error.details.membershipState=details.membershipState;
      }
      throw error;
    }
    return result;
  }
  async verified(address, expectedServerId) {
    const clean = address.split('#')[0], base = serverURL(clean, this.allowLoopback);
    let fingerprint;
    try { fingerprint = await this.verify(clean); } // Pin before invitation or session credentials.
    catch(error) { if(error.code==='PAWTALK_CERTIFICATE_PIN')throw failure('SERVER_KEY_CHANGED');throw error; }
    await this.trust(clean);
    const config = await this.fetchJSON(base, '/api/config', { fingerprint });
    if (config.apiProtocolVersion !== apiProtocolVersion || config.e2eeRequired !== true) throw failure('UNSUPPORTED_PROTOCOL');
    if (!hexID(config.serverId, 32) || (expectedServerId && config.serverId !== expectedServerId)) throw failure('SERVER_ID_CHANGED');
    const expectedTLS = hexID(fingerprint, 64) ? 'tls-sha256:' + fingerprint : '';
    const expectedOrigin = 'origin:' + base;
    if (!config.authBinding || (config.authBinding !== expectedTLS && config.authBinding !== expectedOrigin)) throw failure('SERVER_BINDING_MISMATCH');
    if (base.startsWith('https:') && !expectedTLS) throw failure('TLS_IDENTITY_MISSING');
    if (typeof config.identityKey !== 'string' || !/^[\w-]{43}$/.test(config.identityKey) || typeof config.identitySignature !== 'string' || !/^[\w-]{86}$/.test(config.identitySignature) || !Number.isSafeInteger(config.revision) || config.revision < 1 || typeof config.name !== 'string' || config.name.length > 128) throw failure('INVALID_SERVER_IDENTITY');
    const rawKey = Buffer.from(config.identityKey, 'base64url');
    if (hash(rawKey).slice(0, 32) !== config.serverId) throw failure('INVALID_SERVER_IDENTITY');
    const serverKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), type: 'spki', format: 'der' });
    const frame = signatureFrame('pawtalk-server-v2', config.serverId, config.authBinding, '2', config.name, config.initialized ? '1' : '0', String(config.revision));
    if (!verify(null, frame, serverKey, Buffer.from(config.identitySignature, 'base64url'))) throw failure('INVALID_SERVER_IDENTITY');
    return { base, address: clean, config, binding: config.authBinding, fingerprint };
  }
  async signed(connection, path, input) {
    const identity = await this.identity(), body = JSON.stringify(input);
    const challenge = await this.fetchJSON(connection.base, '/api/v2/challenge', { fingerprint: connection.fingerprint });
    if (challenge.serverId !== connection.config.serverId || !hexID(challenge.challenge, 32) || typeof challenge.nonce !== 'string' || !/^[\w-]{43}$/.test(challenge.nonce)) throw failure('INVALID_CHALLENGE');
    const fields = signatureFrame('pawtalk-request-v2', connection.config.serverId, connection.binding, 'POST', path, challenge.challenge, challenge.nonce, hash(body));
    const proof = { binding: connection.binding, profileKey: identity.profileKey, deviceKey: identity.deviceKey, certificate: identity.certificate, challenge: challenge.challenge, signature: sign(null, fields, identity.device).toString('base64url') };
    return this.fetchJSON(connection.base, path, { method: 'POST', body, fingerprint: connection.fingerprint, headers: { 'X-PawTalk-Proof': Buffer.from(JSON.stringify(proof)).toString('base64url') } });
  }
  async records() {
    const raw = await this.credentials.load('pawtalk:memberships:v2');
    if (!raw) return [];
    const result = JSON.parse(raw);
    if (!Array.isArray(result) || result.length > 1000 || result.some(item => !item || !hexID(item.serverId, 32) || typeof item.address !== 'string' || item.address.includes('#') || typeof item.name !== 'string')) throw failure('INVALID_LOCAL_MEMBERSHIPS');
    if(result.some(item=>item.pendingLeave&&(!hexID(item.pendingLeave.requestId,32)||!Number.isSafeInteger(item.pendingLeave.nextAttempt))))throw failure('INVALID_LOCAL_MEMBERSHIPS');
    return result;
  }
  async registry() { return (await this.records()).filter(record=>!record.pendingLeave); }
  async remember(connection) {
    const operation = this.registryQueue.catch(() => {}).then(async () => {
      const servers = await this.records();
      const item = { serverId: connection.config.serverId, address: connection.address, name: connection.displayName ?? connection.config.name };
      const index = servers.findIndex(server => server.serverId === item.serverId);
      if(servers[index]?.pendingLeave)throw failure('LEAVE_PENDING');
      if (index < 0) servers.push(item); else servers[index] = item;
      await this.credentials.save('pawtalk:memberships:v2', JSON.stringify(servers));
    });
    this.registryQueue = operation.catch(() => {}); return operation;
  }
  async forget(serverId) {
    this.connections.delete(serverId);
    const operation = this.registryQueue.catch(() => {}).then(async () => {
      const records = (await this.records()).filter(record => record.serverId !== serverId);
      await this.credentials.save('pawtalk:memberships:v2', JSON.stringify(records));
    });
    this.registryQueue = operation.catch(() => {}); return operation;
  }
  async join(address, nickname, deviceLabel) {
    if (typeof address !== 'string' || address.length > 14000) throw failure('INVALID_INVITE');
    const url = new URL(address), values = new URLSearchParams(url.hash.slice(1));
    const serverId = values.get('server'), inviteId = values.get('invite'), token = values.get('token'), setup = values.get('setup') === '1';
    if (values.get('v') !== '2' || !hexID(serverId, 32) || !hexID(inviteId, 32) || !/^[\w-]{43}$/.test(token || '')) throw failure('INVALID_INVITE');
    if((await this.records()).some(record=>record.serverId===serverId&&record.pendingLeave))throw failure('LEAVE_PENDING');
    const opening = values.get('open'), digest = values.get('package');
    if (!setup && (!hexID(opening, 64) || !hexID(digest, 64))) throw failure('INVALID_INVITE');
    const connection = await this.verified(address, serverId);
    const slot = 'pawtalk:server:v2:' + serverId;
    const existing = await this.credentials.load(slot); let saved = existing ? JSON.parse(existing) : {};
    if (connection.config.initialized && hexID(saved.secret, 64)) {
      try {
        const session = await this.signed(connection, '/api/v2/session', {});
        connection.token = session.sessionToken; connection.secret = saved.secret;
        this.connections.set(serverId, connection);
        const state = await this.state(serverId);
        await this.remember(connection); await this.credentials.save(slot, JSON.stringify({ secret: saved.secret }));
        return state;
      } catch (error) { if (error.code !== 'NOT_A_MEMBER') throw error; }
    }
    if (setup && connection.config.initialized) throw failure('ALREADY_INITIALIZED');
    if (saved.pending?.inviteId !== inviteId) {
      saved = { ...saved, pending: { inviteId, requestId: requestID() } };
      await this.credentials.save(slot, JSON.stringify(saved));
    }
    const prepared = await this.signed(connection, '/api/v2/invites/prepare', { inviteId, token, requestId: saved.pending.requestId, nickname, deviceLabel });
    if ((prepared.kind === 'bootstrap') !== setup || !hexID(prepared.attemptId, 32)) throw failure('INVALID_INVITE_RESPONSE');
    let secret;
    if (prepared.state === 'confirmed') {
      if (!hexID(saved.secret, 64)) throw failure('LOCAL_KEY_MISSING');
      secret = saved.secret;
    } else if (setup) secret = saved.secret || cryptoV2.randomSecret();
    else {
      if (prepared.packageDigest !== digest) throw failure('INVITATION_PACKAGE_CHANGED');
      secret = await cryptoV2.openInvitation(prepared.keyPackage, digest, serverId, inviteId, opening);
    }
    const keyId = await cryptoV2.rootKeyID(secret);
    saved = { ...saved, secret, pending: { ...saved.pending, attemptId: prepared.attemptId, deadline: prepared.deadline } };
    // No confirm before OS-protected save succeeds. This write also supports a
    // crash between saving keys and sending/receiving confirmation.
    await this.credentials.save(slot, JSON.stringify(saved));
    const result = await this.signed(connection, '/api/v2/invites/confirm', { attemptId: prepared.attemptId, requestId: saved.pending.requestId, packageDigest: prepared.packageDigest, keyId });
    if (typeof result.sessionToken !== 'string' || !/^[\w-]{43}$/.test(result.sessionToken)) throw failure('INVALID_API_RESPONSE');
    if ((await this.records()).some(value=>value.serverId===serverId&&value.pendingLeave)) throw failure('LEAVE_PENDING');
    connection.token = result.sessionToken; connection.secret = secret;
    this.connections.set(serverId, connection);
    await this.credentials.save(slot, JSON.stringify({ secret }));
    await this.remember(connection);
    return this.state(serverId);
  }
  async connect(record) {
    if ((await this.records()).some(value=>value.serverId===record.serverId&&value.pendingLeave)) throw failure('LEAVE_PENDING');
    const connection = await this.verified(record.address, record.serverId);
    const saved = await this.credentials.load('pawtalk:server:v2:' + record.serverId);
    const secret = saved && JSON.parse(saved).secret;
    if (!hexID(secret, 64)) throw failure('LOCAL_KEY_MISSING');
    const result = await this.signed(connection, '/api/v2/session', {});
    if ((await this.records()).some(value=>value.serverId===record.serverId&&value.pendingLeave)) throw failure('LEAVE_PENDING');
    connection.token = result.sessionToken; connection.secret = secret;
    this.connections.set(record.serverId, connection);
    return this.state(record.serverId);
  }
  async changeAddress(serverId, address) {
    // A trusted new transport never changes the saved server signing identity.
    // It also cannot create membership or bypass the admission protocol.
    const record = (await this.registry()).find(record => record.serverId === serverId);
    if (!record) throw failure('NOT_A_MEMBER');
    const previous = this.connections.get(serverId);
    try {
      const state = await this.connect({ ...record, address });
      await this.remember(this.connections.get(serverId));
      return state;
    } catch (error) {
      if (previous) this.connections.set(serverId, previous); else this.connections.delete(serverId);
      throw error;
    }
  }
  async request(serverId, path, method = 'GET', input) {
    const connection = this.connections.get(serverId);
    if (!connection || !path.startsWith('/api/v2/')) throw failure('NOT_CONNECTED');
    const body = input === undefined ? undefined : JSON.stringify(input);
    try {
      try { return await this.fetchJSON(connection.base, path, { method, body, fingerprint: connection.fingerprint, headers: { Authorization: 'Bearer ' + connection.token } }); }
      catch (failure) {
        if (failure.code !== 'INVALID_SESSION') throw failure;
        const session = await this.signed(connection, '/api/v2/session', {});
        connection.token = session.sessionToken;
        return await this.fetchJSON(connection.base, path, { method, body, fingerprint: connection.fingerprint, headers: { Authorization: 'Bearer ' + connection.token } });
      }
    } catch (failure) {
      if (['NOT_A_MEMBER', 'BANNED'].includes(failure.code)) await this.forget(serverId);
      throw failure;
    }
  }
  async state(serverId) {
    const result = await this.request(serverId, '/api/v2/state');
    const connection = this.connections.get(serverId);
    const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
    const integer=value=>Number.isSafeInteger(value)&&value>=0;
    const role=value=>['member','moderator','admin'].includes(value);
    if(!object(result)||!object(result.self)||typeof result.name!=='string'||result.name.length>256||!integer(result.revision)||!integer(result.controlRevision)||!hexID(result.self.profileId,64)||!hexID(result.self.effectiveProfileId,64)||!hexID(result.self.deviceId,64)||!role(result.self.role)||!Array.isArray(result.self.permissions)||result.self.permissions.length>256||result.self.permissions.some(value=>typeof value!=='string'||value.length>64))throw failure('INVALID_API_RESPONSE');
    const identity=await this.identity();if(result.self.profileId!==identity.profileId||result.self.deviceId!==identity.deviceId)throw failure('INVALID_API_RESPONSE');
    for(const [key,limit] of [['profiles',10000],['channels',1000],['members',10000],['devices',10000],['bindings',10000],['voice',10000]])if(!Array.isArray(result[key])||result[key].length>limit)throw failure('INVALID_API_RESPONSE');
    if(result.channels.some(value=>!object(value)||!hexID(value.id,32)||!['voice','text'].includes(value.kind)||typeof value.name!=='string'||value.name.length>256||typeof value.protected!=='boolean'||!integer(value.revision)||!integer(value.messageRevision)||!integer(value.lastMessageId))||
      result.members.some(value=>!object(value)||!hexID(value.profileId,64)||typeof value.online!=='boolean'||!role(value.role))||
      result.devices.some(value=>!object(value)||!hexID(value.id,64)||!hexID(value.originalProfileId,64)||typeof value.label!=='string'||value.label.length>128||typeof value.primary!=='boolean')||
      result.bindings.some(value=>!object(value)||!hexID(value.source,64)||!hexID(value.target,64))||
      result.voice.some(value=>!object(value)||!hexID(value.profileId,64)||!hexID(value.deviceId,64)||!hexID(value.channelId,32)||!hexID(value.identity,32)))throw failure('INVALID_API_RESPONSE');
    if (result.serverId !== serverId || result.keyId !== await cryptoV2.rootKeyID(connection.secret)) throw failure('SERVER_KEY_CHANGED');
    if(result.capabilities!==undefined){if(!Array.isArray(result.capabilities)||result.capabilities.length>128||result.capabilities.some(c=>typeof c!=='string'||c.length>64))throw failure('INVALID_API_RESPONSE');connection.config={...connection.config,capabilities:[...result.capabilities]};}
    if (!Array.isArray(result.profiles) || result.profiles.length > 10000 || !Array.isArray(result.channels) || result.channels.length > 1000) throw failure('INVALID_API_RESPONSE');
    result.profiles = await Promise.all(result.profiles.map(async profile => {
      if (!object(profile)||!hexID(profile.id, 64) || typeof profile.nickname !== 'string' || profile.nickname.length > 128 || !Number.isSafeInteger(profile.revision)) throw failure('INVALID_API_RESPONSE');
      const cacheKey = `${serverId}:${profile.id}:${profile.revision}`;
      if (this.profileCache.has(cacheKey)) return this.profileCache.get(cacheKey);
      let avatar;
      if (profile.avatarEnvelope) {
        try {
          if (typeof profile.avatarEnvelope !== 'string' || profile.avatarEnvelope.length > 24000) throw failure('INVALID_AVATAR');
          const packet = JSON.parse(Buffer.from(profile.avatarEnvelope, 'base64').toString('utf8'));
          const owner = profile.avatarContextProfileId || profile.id;
          const bytes = await cryptoV2.openContent(connection.secret, serverId, 'avatar', '', owner, owner, packet);
          const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (value.length <= 12000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {const metadata=inspectImage(Buffer.from(value.slice(value.indexOf(',')+1),'base64'));if(metadata&&metadata.width<=512&&metadata.height<=512)avatar = value;}
        } catch { /* Invalid avatar never blocks readable messages or falls back to plaintext. */ }
      }
      const output = { id: profile.id, nickname: profile.nickname, revision: profile.revision, avatar };
      this.profileCache.set(cacheKey, output);
      if (this.profileCache.size > 1000) this.profileCache.delete(this.profileCache.keys().next().value);
      return output;
    }));
    if(result.avatarEnvelope){
      try{
        if(typeof result.avatarEnvelope!=='string'||result.avatarEnvelope.length>24000||!hexID(result.avatarAuthor,64))throw failure('INVALID_AVATAR');
        const packet=JSON.parse(Buffer.from(result.avatarEnvelope,'base64').toString('utf8'));
        const clear=await cryptoV2.openContent(connection.secret,serverId,'avatar','','server-avatar',result.avatarAuthor,packet);
        const value=new TextDecoder('utf-8',{fatal:true}).decode(clear);this.validateAvatar(value);result.avatar=value;
      }catch{/* Unreadable server artwork does not block membership. */}
    }
    if(connection && result.name !== (connection.displayName ?? connection.config.name)){
      await this.remember({...connection,displayName:result.name});connection.displayName=result.name;
    }
    return result;
  }
  validateAvatar(value){
    if(typeof value!=='string'||value.length>12000||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))throw failure('INVALID_AVATAR');
    const image=inspectImage(Buffer.from(value.slice(value.indexOf(',')+1),'base64'));if(!image||image.width!==image.height||image.width>512)throw failure('INVALID_AVATAR');
  }
  async serverAvatar(serverId,value,expectedRevision){
    const connection=this.connections.get(serverId);if(!connection?.config?.capabilities?.includes('server-avatar-v1'))throw failure('UNSUPPORTED_FEATURE');
    const state=await this.state(serverId);let envelope=null;
    if(value!==null){this.validateAvatar(value);envelope=await cryptoV2.sealContent(connection.secret,serverId,'avatar','','server-avatar',state.self.effectiveProfileId,new TextEncoder().encode(value));}
    await this.request(serverId,'/api/v2/server/avatar','PATCH',{envelope,expectedRevision,requestId:requestID()});return this.state(serverId);
  }
  async profile(serverId, nickname, avatar, expectedRevision) {
    const state = await this.state(serverId), owner = state.self.effectiveProfileId;
    const connection = this.connections.get(serverId), input = { nickname, expectedRevision, requestId: requestID() };
    if (avatar === null) input.avatarEnvelope = null;
    else if (avatar !== undefined) {
      if (typeof avatar !== 'string' || avatar.length > 12000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar)) throw failure('INVALID_AVATAR');
      input.avatarEnvelope = await cryptoV2.sealContent(connection.secret, serverId, 'avatar', '', owner, owner, new TextEncoder().encode(avatar));
    }
    await this.request(serverId, '/api/v2/profile', 'PATCH', input);
    return this.state(serverId);
  }
  async invite(serverId, kind) {
    if (!['single', 'reusable'].includes(kind)) throw failure('INVALID_INVITE');
    const connection = this.connections.get(serverId); if (!connection) throw failure('NOT_CONNECTED');
    const inviteId = requestID(), rawToken = randomBytes(32), opening = cryptoV2.randomSecret();
    const { packet, digest } = await cryptoV2.sealInvitation(connection.secret, serverId, inviteId, opening);
    await this.request(serverId, '/api/v2/invites', 'POST', { inviteId, tokenHash: hash(rawToken), kind, keyPackage: packet, packageDigest: digest, requestId: requestID() });
    const link = new URL(connection.address);
    link.hash = new URLSearchParams({ v: '2', server: serverId, invite: inviteId, token: rawToken.toString('base64url'), open: opening, package: digest }).toString();
    return link.toString();
  }
  async messages(serverId, channelId, options = {}) {
    if (!hexID(channelId, 32)) throw failure('INVALID_CHANNEL');
    const query = new URLSearchParams();
    for (const key of ['limit', 'before', 'after', 'readAfter','around']) if (options[key] !== undefined) {
      if (!Number.isSafeInteger(options[key]) || options[key] < 0) throw failure('INVALID_PAGE');
      query.set(key, String(options[key]));
    }
    if(options.ids!==undefined){if(!Array.isArray(options.ids)||!options.ids.length||options.ids.length>500||options.ids.some(id=>!Number.isSafeInteger(id)||id<1))throw failure('INVALID_PAGE');query.set('ids',[...new Set(options.ids)].join(','));}
    const page = await this.request(serverId, `/api/v2/channels/${channelId}/messages?${query}`);
    if (!Array.isArray(page.messages) || page.messages.length > 500) throw failure('INVALID_API_RESPONSE');
    page.messages=await this.decodeMessages(serverId,channelId,page.messages);
    return page;
  }
  async decodeMessages(serverId,channelId,messages){
    if(!Array.isArray(messages)||messages.length>500)throw failure('INVALID_API_RESPONSE');
    const connection = this.connections.get(serverId);
    return Promise.all(messages.map(async message => {
      if (!Number.isSafeInteger(message.id) || message.id <= 0 || message.channelId !== channelId || !hexID(message.authorProfileId, 64) || !hexID(message.requestId, 32)) throw failure('INVALID_API_RESPONSE');
      if((message.locked!==undefined&&typeof message.locked!=='boolean')||(message.systemKind!==undefined&&message.systemKind!==''&&message.systemKind!=='poll-result'))throw failure('INVALID_API_RESPONSE');
      try {
        const clear = await cryptoV2.openContent(connection.secret, serverId, 'chat', channelId, message.requestId, message.authorProfileId, { version: 2, keyId: message.keyId, nonce: message.nonce, ciphertext: message.ciphertext });
        const content = validatedContent(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear)));
        return { ...message, content };
      } catch { return { ...message, unreadable: true, content: { text: '' } }; }
    }));
  }
  async send(serverId, channelId, content, original, clientRequestId) {
    content = validatedContent(content);
    if (!hexID(channelId, 32) || !content || typeof content.text !== 'string' || Buffer.byteLength(content.text) > 4096) throw failure('INVALID_MESSAGE');
    if (!content.text.trim() && !content.image && !content.file && !content.files?.length) throw failure('EMPTY_MESSAGE');
    const connection = this.connections.get(serverId); if (!connection) throw failure('NOT_CONNECTED');
    if((content.files||content.file?.poster)&&!connection.config?.capabilities?.includes('media-gallery-v1'))throw failure('UNSUPPORTED_FEATURE');
    if(content.checklist&&!connection.config?.capabilities?.includes('checklists-v1'))throw failure('UNSUPPORTED_FEATURE');
    if(content.poll&&(!connection.config?.capabilities?.includes('polls-v1')||original||content.pollResult))throw failure('UNSUPPORTED_FEATURE');
    if(original?.content?.image&&!content.image&&!connection.config?.capabilities?.includes('attachment-removal-v1'))throw failure('UNSUPPORTED_FEATURE');
    if(clientRequestId!==undefined&&!hexID(clientRequestId,32))throw failure('INVALID_MESSAGE');
    const identity = await this.identity(), resourceId = original?.requestId || clientRequestId || requestID(), author = original?.authorProfileId || identity.profileId;
    if (!hexID(resourceId, 32) || !hexID(author, 64) || (original && (!Number.isSafeInteger(original.id) || original.id < 1))) throw failure('INVALID_MESSAGE');
    const clear = new TextEncoder().encode(JSON.stringify(content));
    if (clear.length > 12288) throw failure('MESSAGE_TOO_LARGE');
    const cacheKey=clientRequestId&&[serverId,channelId,clientRequestId].join(':'),signature=hash(clear);
    let cached=cacheKey&&this.pendingMessages.get(cacheKey);
    if(cached&&(cached.signature!==signature||cached.originalId!==original?.id))throw failure('REQUEST_CONFLICT');
    if(!cached){const packet=await cryptoV2.sealContent(connection.secret,serverId,'chat',channelId,resourceId,author,clear);cached={signature,originalId:original?.id,packet};if(cacheKey){this.pendingMessages.set(cacheKey,cached);if(this.pendingMessages.size>100)this.pendingMessages.delete(this.pendingMessages.keys().next().value);}}
    const packet=cached.packet,path=original?`/api/v2/messages/${original.id}`:`/api/v2/channels/${channelId}/messages`;
    if(content.poll&&!cached.poll){
      if(content.poll.id!==resourceId)throw failure('INVALID_POLL');
      const resultID=requestID(),resultPacket=await cryptoV2.sealContent(connection.secret,serverId,'chat',channelId,resultID,author,new TextEncoder().encode(JSON.stringify({...content,pollResult:true})));
      cached.poll={optionCount:content.poll.options.length,duration:content.poll.duration,multiple:content.poll.multiple,anonymous:content.poll.anonymous,intermediate:content.poll.intermediate,result:{requestId:resultID,keyId:resultPacket.keyId,nonce:resultPacket.nonce,ciphertext:resultPacket.ciphertext,attachmentIds:[]}};
    }
    const result=await this.request(serverId,path,original?'PATCH':'POST',{requestId:original?(clientRequestId||requestID()):resourceId,keyId:packet.keyId,nonce:packet.nonce,ciphertext:packet.ciphertext,attachmentIds:original?[]:content.image?[content.image.id]:[...(content.file?[content.file]:[]),...(content.files||[])].flatMap(f=>[f.id,...(f.poster?[f.poster.id]:[])]),...(cached.poll?{poll:cached.poll}:{}),...(content.checklist?{checklist:{everyone:content.checklist.everyone,items:content.checklist.items.map(item=>item.id)}}:{}),...(original?.content?.image&&!content.image?{removeAttachment:true}:{})});
    if(cacheKey)this.pendingMessages.delete(cacheKey);return result;
  }

  async uploadFile(serverId,channelId,data,mime){
    if(data?.length>2*1024*1024&&!this.connections.get(serverId)?.config?.capabilities?.includes('media-files-v1'))throw failure('UNSUPPORTED_FEATURE');
    if(!hexID(channelId,32)||!['image/gif','video/mp4','video/webm','audio/webm','audio/ogg','application/octet-stream'].includes(mime)||!(data instanceof Uint8Array)||!data.length||data.length>50*1024*1024)throw failure('INVALID_ATTACHMENT');
    const connection=this.connections.get(serverId);if(!connection)throw failure('NOT_CONNECTED');
    const identity=await this.identity(),attachmentId=requestID();
    const packet=await cryptoV2.sealContent(connection.secret,serverId,'attachment',channelId,attachmentId,identity.profileId,data);
    await this.request(serverId,`/api/v2/channels/${channelId}/attachments/${attachmentId}`,'POST',packet);
    return {id:attachmentId,mime};
  }
  async file(serverId,channelId,attachmentId){
    if(!hexID(channelId,32)||!hexID(attachmentId,32))throw failure('INVALID_ATTACHMENT');
    const response=await this.request(serverId,`/api/v2/channels/${channelId}/attachments/${attachmentId}`);
    const connection=this.connections.get(serverId);if(!connection)throw failure('NOT_CONNECTED');
    return cryptoV2.openContent(connection.secret,serverId,'attachment',channelId,attachmentId,response.authorProfileId,response.packet);
  }
  async uploadImage(serverId, channelId, data, mime) {
    if (!hexID(channelId, 32) || !['image/png', 'image/jpeg', 'image/webp'].includes(mime) || !(data instanceof Uint8Array) || !data.length || data.length > 2 * 1024 * 1024) throw failure('INVALID_IMAGE');
    if(inspectImage(data)?.mime!==mime)throw failure('INVALID_IMAGE');
    const connection = this.connections.get(serverId); if (!connection) throw failure('NOT_CONNECTED');
    const identity = await this.identity(), attachmentId = requestID();
    const packet = await cryptoV2.sealContent(connection.secret, serverId, 'attachment', channelId, attachmentId, identity.profileId, data);
    await this.request(serverId, `/api/v2/channels/${channelId}/attachments/${attachmentId}`, 'POST', packet);
    return { id: attachmentId, mime };
  }
  async image(serverId, channelId, attachmentId, mime) {
    if (!hexID(channelId, 32) || !hexID(attachmentId, 32) || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw failure('INVALID_IMAGE');
    const response = await this.request(serverId, `/api/v2/channels/${channelId}/attachments/${attachmentId}`);
    const connection = this.connections.get(serverId);
    const bytes = await cryptoV2.openContent(connection.secret, serverId, 'attachment', channelId, attachmentId, response.authorProfileId, response.packet);
    if (bytes.length > 2 * 1024 * 1024) throw failure('IMAGE_TOO_LARGE');
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  }
  async voice(serverId, channelId) {
    if (!hexID(channelId, 32)) throw failure('INVALID_CHANNEL');
    const result = await this.request(serverId, '/api/v2/voice/join', 'POST', { channelId });
    const connection = this.connections.get(serverId);
    if (result.e2eeRequired !== true || result.channelId !== channelId) throw failure('INVALID_API_RESPONSE');
    result.url = mediaEndpoint(result.url, connection.base, this.allowLoopback).toString();
    result.key = cryptoV2.hex(await cryptoV2.deriveChannelBytes(connection.secret, serverId, 'voice', channelId));
    return result;
  }
  async leave(serverId,{defer=false}={}) {
    if(!defer&&this.connections.has(serverId)){
      try { await this.request(serverId,'/api/v2/leave','POST',{requestId:requestID()});await this.forget(serverId);return; }
      catch(error){if(['NOT_A_MEMBER','BANNED'].includes(error.code)){await this.forget(serverId);return;}if(!isConnectionFailure(error))throw error;}
    }
    const operation=this.registryQueue.catch(()=>{}).then(async()=>{
      const records=await this.records(),record=records.find(value=>value.serverId===serverId);
      if(!record)throw failure('NOT_A_MEMBER');
      record.pendingLeave||={requestId:requestID(),nextAttempt:0};delete record.leaveError;
      await this.credentials.save('pawtalk:memberships:v2',JSON.stringify(records));
      this.connections.delete(serverId);
    });
    this.registryQueue=operation.catch(()=>{});await operation;
  }
  async pendingDepartures(now=Date.now()) {
    const pending=(await this.records()).filter(record=>record.pendingLeave&&record.pendingLeave.nextAttempt<=now).sort((a,b)=>a.pendingLeave.nextAttempt-b.pendingLeave.nextAttempt).slice(0,2);
    return Promise.all(pending.map(async record=>{
      let outcome='retry';
      try{
        // Only authenticate and leave. Do not expose this connection to renderer
        // requests, fetch history, or restore the hidden membership in the rail.
        const connection=await this.verified(record.address,record.serverId);
        const session=await this.signed(connection,'/api/v2/session',{});
        await this.fetchJSON(connection.base,'/api/v2/leave',{method:'POST',body:JSON.stringify({requestId:record.pendingLeave.requestId}),fingerprint:connection.fingerprint,headers:{Authorization:'Bearer '+session.sessionToken}});
        outcome='done';
      }catch(error){if(['NOT_A_MEMBER','BANNED'].includes(error.code))outcome='done';else if(error.code==='LAST_ADMIN')outcome='blocked';}
      const operation=this.registryQueue.catch(()=>{}).then(async()=>{
        let records=await this.records();const current=records.find(value=>value.serverId===record.serverId);
        if(current?.pendingLeave?.requestId!==record.pendingLeave.requestId)return;
        if(outcome==='done')records=records.filter(value=>value!==current);
        else if(outcome==='blocked'){delete current.pendingLeave;current.leaveError='LAST_ADMIN';}
        else current.pendingLeave.nextAttempt=now+60000;
        await this.credentials.save('pawtalk:memberships:v2',JSON.stringify(records));
      });
      this.registryQueue=operation.catch(()=>{});await operation;
      return {serverId:record.serverId,outcome};
    }));
  }
}
function isConnectionFailure(error){return !error.code||['CONNECTION_FAILED','NOT_CONNECTED','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EHOSTUNREACH','ENETUNREACH','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','ERR_NETWORK_CHANGED','ERR_INTERNET_DISCONNECTED','ERR_CONNECTION_REFUSED','ABORT_ERR'].includes(error.code)||error.name==='AbortError'||error.name==='TimeoutError';}
module.exports = { MembershipClient };
