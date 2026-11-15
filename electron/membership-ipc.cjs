const { randomBytes } = require('node:crypto');
const { t } = require('../shared/i18n.cjs');
const { messagePreview } = require('../shared/chat-format.mjs');
const randomID = () => randomBytes(16).toString('hex');
// Local registry/validation failures are not authenticated server revocations.
function fail(code) { throw Object.assign(Error(code), { code, local: true }); }
function string(value, max = 14000) { if (typeof value !== 'string' || value.length > max) fail('INVALID_INPUT'); return value; }
function id(value, size = 32) { if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${size}}$`).test(value)) fail('INVALID_INPUT'); return value; }

function registerMembershipIPC({ ipcMain, authorized, client, links, clipboard, send, getWindow, Notification, getHost, stopHost, setVoiceEndpoint = () => {} }) {
  const statuses = new Map(), connecting = new Map(), knownRecords = new Map(), departed = new Set(), intentionalDepartures = new Set(); let activeVoice, preparedVoice, voiceEpoch=0,voiceBusy=false, stopped = false, timer, lastNotification = 0, departureTask;
  const locked=error=>['SERVER_KEY_CHANGED','SERVER_ID_CHANGED','INVALID_SERVER_IDENTITY','SERVER_BINDING_MISMATCH'].includes(error.code);
  async function reportDeparture(serverId,error,record=knownRecords.get(serverId)){
    if(error.local||intentionalDepartures.has(serverId)||!record||!['NOT_A_MEMBER','BANNED'].includes(error.code)||departed.has(serverId))return;
    departed.add(serverId);
    const departure={serverId,name:record.name,kind:error.code==='BANNED'?'ban':'kick'};
    if(error.code==='BANNED'&&(error.details?.expiresAt===null||Number.isSafeInteger(error.details?.expiresAt)))departure.expiresAt=error.details.expiresAt;
    await client.forget(serverId);
    if(activeVoice?.serverId===serverId||preparedVoice?.serverId===serverId){await voiceLeave();send('membership-voice-lost',{serverId});}
    send('membership-changed',{serverId,departure});
  }
  async function connectRecord(record) {
    knownRecords.set(record.serverId,record);
    if (client.connections.has(record.serverId)) {
      try{const state=await client.state(record.serverId);statuses.set(record.serverId,'online');departed.delete(record.serverId);return state;}
      catch(error){statuses.set(record.serverId,locked(error)?'locked':'offline');throw error;}
    }
    if (connecting.has(record.serverId)) return connecting.get(record.serverId);
    const operation = client.connect(record).then(state => { statuses.set(record.serverId, 'online'); departed.delete(record.serverId);return state; }).catch(async error => {
      statuses.set(record.serverId, locked(error) ? 'locked' : 'offline');
      await reportDeparture(record.serverId,error,record);
      throw error;
    }).finally(() => connecting.delete(record.serverId));
    connecting.set(record.serverId, operation); return operation;
  }
  async function background() {
    if (stopped) return;
    try {
      const records = await client.registry(); let index = 0;
      if(!departureTask&&client.pendingDepartures)departureTask=client.pendingDepartures().then(results=>{if(stopped)return;for(const result of results)if(result.outcome==='blocked'){intentionalDepartures.delete(result.serverId);send('membership-changed',{serverId:result.serverId,leaveError:'LAST_ADMIN'});}if(results.length)send('membership-changed',{});}).catch(()=>{}).finally(()=>{departureTask=undefined;});
      const connections=Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
        while (index < records.length && !stopped) {
          const record = records[index++];
          try {
            await connectRecord(record);
            await client.request(record.serverId, '/api/v2/heartbeat', 'POST', {}); statuses.set(record.serverId, 'online');
            if (activeVoice?.serverId === record.serverId) {
              try { await client.request(record.serverId, '/api/v2/voice/heartbeat', 'POST', {}); }
              catch(error) { if(['NOT_A_MEMBER','BANNED'].includes(error.code))await reportDeparture(record.serverId,error,record);else{await voiceLeave();send('membership-voice-lost',{serverId:record.serverId});} }
            }
          } catch(error) { statuses.set(record.serverId, locked(error)?'locked':'offline');await reportDeparture(record.serverId,error,record); }
        }
      }));
      await connections;
      send('membership-changed', {});
    } catch { /* Protected storage unavailable: UI reports it, never downgrade storage. */ }
    finally { if (!stopped) timer = setTimeout(() => void background(), 15000); }
  }
  async function voiceLeave() {
    voiceEpoch++;
    const previous = activeVoice || preparedVoice; activeVoice = preparedVoice = undefined;
    await setVoiceEndpoint(null);
    if (previous) { try { await client.request(previous.serverId, '/api/v2/voice/leave', 'POST', {}); } catch {} }
  }
  const actions = {
    async servers() { const host=getHost?.();const records=await client.registry();for(const record of records)knownRecords.set(record.serverId,record);return records.map(record => ({ ...record, ownedSelfhost:!!(host?.running&&host.serverId===record.serverId),source:host?.running&&host.serverId===record.serverId?'selfhost':'external',status: statuses.get(record.serverId) || 'offline' })); },
    async identity() { const identity = await client.identity(); return { profileId: identity.profileId, deviceId: identity.deviceId }; },
    async join(input) {
      const result = await client.join(string(input.address), string(input.nickname, 64), string(input.deviceLabel || t('Компьютер'), 64));
      intentionalDepartures.delete(result.serverId);departed.delete(result.serverId);
      statuses.set(result.serverId, 'online'); send('membership-changed', { serverId: result.serverId }); return result;
    },
    async connect(input) {
      const serverId = id(input.serverId), record = (await client.registry()).find(record => record.serverId === serverId);
      if (!record) fail('NOT_A_MEMBER'); return connectRecord(record);
    },
    async state(input) { return client.state(id(input.serverId)); },
    async 'server.rename'(input) {
      const serverId=id(input.serverId);
      await client.request(serverId,'/api/v2/server','PATCH',{name:string(input.name,256),expectedName:string(input.expectedName,256),requestId:randomID()});
      const state=await client.state(serverId);send('membership-changed',{serverId});return state;
    },
    async 'server.address'(input) {
      const serverId = id(input.serverId);
      if (activeVoice?.serverId === serverId || preparedVoice?.serverId === serverId) fail('BUSY');
      const result = await client.changeAddress(serverId, string(input.address));
      statuses.set(serverId, 'online'); send('membership-changed', { serverId }); return result;
    },
    async messages(input) { return client.messages(id(input.serverId), id(input.channelId), input.options || {}); },
    async send(input) { return client.send(id(input.serverId), id(input.channelId), input.content, input.original, input.requestId===undefined?undefined:id(input.requestId)); },
    async upload(input) {
      if (!(input.bytes instanceof Uint8Array) || input.bytes.length > 2 * 1024 * 1024) fail('INVALID_IMAGE');
      return client.uploadImage(id(input.serverId), id(input.channelId), input.bytes, string(input.mime, 32));
    },
    async image(input) { return client.image(id(input.serverId), id(input.channelId), id(input.attachmentId), string(input.mime, 32)); },
    async profile(input) { return client.profile(id(input.serverId), string(input.nickname, 64), input.avatar, input.expectedRevision); },
    async invite(input) {
      const serverId = id(input.serverId), link = await client.invite(serverId, string(input.kind, 16));
      // A selfhost owner connects over loopback. Share its advertised LAN/WAN
      // origin with the same pinned certificate, not an unusable 127.0.0.1 link.
      const host = getHost?.();
      if (host?.running && host.serverId === serverId && host.invitations?.length) {
        const output = new URL(host.invitations[0]); output.hash = new URL(link).hash; return output.toString();
      }
      return link;
    },
    async leave(input) {
      const serverId=id(input.serverId),host=getHost?.();
      // stopHost emits serverEnded synchronously; pending requests may finish later.
      intentionalDepartures.add(serverId);
      try {
        if(activeVoice?.serverId===serverId||preparedVoice?.serverId===serverId)await voiceLeave();
        if(host?.running&&host.serverId===serverId){if(!stopHost)fail('HOST_UNAVAILABLE');await stopHost();await client.forget(serverId);}
        else await client.leave(serverId,{defer:statuses.get(serverId)!=='online'});
        statuses.delete(serverId);send('membership-changed',{serverId});return true;
      } catch(error) { intentionalDepartures.delete(serverId);throw error; }
    },
    async voice(input) {
      const serverId=id(input.serverId),channelId=id(input.channelId);if(voiceBusy)fail('BUSY');voiceBusy=true;
      try{await voiceLeave();const epoch=voiceEpoch,access=await client.voice(serverId,channelId);
        if(epoch!==voiceEpoch){try{await client.request(serverId,'/api/v2/voice/leave','POST',{});}catch{}fail('CANCELLED');}
        preparedVoice={serverId,channelId};try{access.url=await setVoiceEndpoint(access.url,client.connections.get(serverId)?.fingerprint)||access.url;if(epoch!==voiceEpoch)fail('CANCELLED');return access;}catch(error){await voiceLeave();throw error;}
      }finally{voiceBusy=false;}
    },
    async voiceConnected(input) { const serverId=id(input.serverId),channelId=id(input.channelId);if(preparedVoice?.serverId!==serverId||preparedVoice.channelId!==channelId)fail('VOICE_NOT_PREPARED');activeVoice = preparedVoice;preparedVoice=undefined; return true; },
    async voiceLeave() { await voiceLeave(); return true; },
    async copyProfile(input) { const state = await client.state(id(input.serverId)); clipboard.writeText(state.self.effectiveProfileId); return true; },
    async copy(input) { clipboard.writeText(string(input.text)); return true; },
    async 'channel.order'(input) { if(!['text','voice'].includes(input.kind)||!Array.isArray(input.items)||input.items.length<1||input.items.length>1000)fail('INVALID_INPUT');const items=input.items.map(item=>{if(!item||!Number.isSafeInteger(item.revision)||item.revision<1)fail('INVALID_INPUT');return {id:id(item.id),revision:item.revision};});return client.request(id(input.serverId),'/api/v2/channel-order','POST',{kind:input.kind,items,requestId:randomID()}); },
    async 'channel.create'(input) { return client.request(id(input.serverId), '/api/v2/channels', 'POST', { kind: string(input.kind, 16), name: string(input.name, 128), requestId: randomID() }); },
    async 'channel.patch'(input) { return client.request(id(input.serverId), '/api/v2/channels/' + id(input.channelId), 'PATCH', { name: string(input.name, 128), position: input.position, expectedRevision: input.expectedRevision, requestId: randomID() }); },
    async 'channel.delete'(input) { return client.request(id(input.serverId), '/api/v2/channels/' + id(input.channelId), 'DELETE', { requestId: randomID() }); },
    async 'message.delete'(input) {
      if (!Number.isSafeInteger(input.messageId) || input.messageId <= 0) fail('INVALID_MESSAGE');
      return client.request(id(input.serverId), '/api/v2/messages/' + input.messageId, 'DELETE', { requestId: randomID() });
    },
    async 'role.set'(input) { return client.request(id(input.serverId), '/api/v2/members/' + id(input.profileId, 64) + '/role', 'PUT', { role: string(input.role, 16), requestId: randomID() }); },
    async 'member.kick'(input) { return client.request(id(input.serverId), '/api/v2/members/' + id(input.profileId, 64) + '/kick', 'POST', { requestId: randomID() }); },
    async 'member.ban'(input) { return client.request(id(input.serverId), '/api/v2/members/' + id(input.profileId, 64) + '/ban', 'POST', { expiresAt: input.expiresAt ?? null, reason: string(input.reason || '', 1024), requestId: randomID() }); },
    async 'invite.list'(input) { return client.request(id(input.serverId), '/api/v2/invites'); },
    async 'invite.revoke'(input) { return client.request(id(input.serverId), '/api/v2/invites/' + id(input.inviteId), 'DELETE', { requestId: randomID() }); },
    async 'ban.revoke'(input) { return client.request(id(input.serverId), '/api/v2/bans/' + id(input.banId), 'DELETE', { requestId: randomID() }); },
    async 'ban.list'(input) { return client.request(id(input.serverId), '/api/v2/bans'); },
    async 'link.start'(input) { return links.start(id(input.serverId)); },
    async 'link.propose'(input) { return links.propose(string(input.text), string(input.nickname, 64), string(input.deviceLabel || t('Компьютер'), 64), input.chosen || 'target'); },
    async 'link.status'(input) { return links.status(id(input.linkId)); },
    async 'link.approve'(input) { return links.approve(id(input.linkId)); },
    async 'link.finish'(input) { const result = await links.finish(id(input.linkId)); intentionalDepartures.delete(result.serverId);departed.delete(result.serverId);send('membership-changed', {}); return result; },
    async 'device.unlink'(input) { return links.unlink(id(input.serverId), id(input.deviceId, 64), false); },
    async 'device.revoke'(input) { return links.unlink(id(input.serverId), id(input.deviceId, 64), true); },
    async 'control.create'(input) { return links.transferCreate(id(input.serverId), id(input.deviceId, 64)); },
    async 'control.accept'(input) { return links.transferAccept(id(input.serverId), string(input.text, 4096)); },
    async 'control.finish'(input) { const value=await links.transferFinish(id(input.serverId), string(input.text, 4096)); send('membership-changed', {}); return value; },
    async notify(input) {
      const serverId = id(input.serverId), channelId=id(input.channelId); if (!client.connections.has(serverId) || getWindow()?.isFocused() || Date.now() - lastNotification < 3000 || !Notification?.isSupported()) return false;
      const channelName=string(input.channelName,128).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').trim();
      const author=string(input.authorName||t('Участник'),128).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').trim();
      if(input.hasImage!==undefined&&typeof input.hasImage!=='boolean')fail('INVALID_INPUT');
      const text=messagePreview(string(input.text||'',4096),t('Спойлер'));
      const content=[input.hasImage?t('Изображение'):'',text].filter(Boolean).join(' · ');
      if(!content)return false;
      const preview=Array.from(content).slice(0,240).join('')+(Array.from(content).length>240?'…':'');
      const record = (await client.registry()).find(record => record.serverId === serverId);
      lastNotification = Date.now();
      const notification = new Notification({ silent: true, title: `${record?.name || 'PawTalk'} · #${channelName}`, body: `${author}: ${preview}` });
      notification.on('click', () => { const win = getWindow(); if (win && !win.isDestroyed()) { win.show(); win.focus(); send('membership-open-channel', { serverId, channelId }); } }); notification.show(); return true;
    },
  };
  ipcMain.handle('membership', async (event, action, input = {}) => {
    authorized(event);
    try {
      if (typeof action !== 'string' || !Object.hasOwn(actions, action) || !input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_ACTION');
      return { value: await actions[action](input) };
    } catch (failure) {
      if(typeof input?.serverId==='string')await reportDeparture(input.serverId,failure);
      const code = typeof failure.code === 'string' && /^[A-Z_]{1,64}$/.test(failure.code) ? failure.code : 'CONNECTION_FAILED';
      return { error: { code } };
    }
  });
  return { start() { void background(); }, stop() { stopped = true; clearTimeout(timer); void voiceLeave(); }, suspend() { void voiceLeave(); },
    async serverEnded(serverId) { intentionalDepartures.add(serverId);knownRecords.delete(serverId);if(activeVoice?.serverId===serverId||preparedVoice?.serverId===serverId){await voiceLeave();send('membership-voice-lost',{serverId});} await client.forget(serverId);statuses.delete(serverId);send('membership-changed',{serverId}); },statuses };
}
module.exports = { registerMembershipIPC };
