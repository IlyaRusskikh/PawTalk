const { randomBytes, createHash } = require('node:crypto');
const { t } = require('../shared/i18n.cjs');
const { messagePreview } = require('../shared/chat-format.mjs');
const randomID = () => randomBytes(16).toString('hex');
// Local registry/validation failures are not authenticated server revocations.
function fail(code) { throw Object.assign(Error(code), { code, local: true }); }
function string(value, max = 14000) { if (typeof value !== 'string' || value.length > max) fail('INVALID_INPUT'); return value; }
function id(value, size = 32) { if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${size}}$`).test(value)) fail('INVALID_INPUT'); return value; }

function registerMembershipIPC({ ipcMain, authorized, client, links, clipboard, send, getWindow, Notification, getIdleSeconds = () => 0, getHost, stopHost, setVoiceEndpoint = () => {} }) {
  const linkAlerts=new Set(),notified=new Map(),notificationBatches=new Map(),notificationReads=new Map(),shownNotifications=new Map();
  const notificationID=key=>createHash('sha256').update(key).digest('hex').slice(0,16);
  function closeNotification(key){const shown=shownNotifications.get(key);shownNotifications.delete(key);try{shown?.notification.close?.();}catch{}}
  function cancelNotificationBatch(key){const batch=notificationBatches.get(key);if(!batch)return;batch.cancelled=true;clearTimeout(batch.timer);batch.resolve(false);notificationBatches.delete(key);}
  function clearNotifications(serverId){for(const key of notificationBatches.keys())if(!serverId||key.startsWith(serverId+':'))cancelNotificationBatch(key);for(const key of shownNotifications.keys())if(!serverId||key.startsWith(serverId+':'))closeNotification(key);}
  const alreadyRead=(key,batch)=>{const read=notificationReads.get(key)||0;return read>0&&(!batch.last||read>=batch.last||batch.previewId>0&&read>=batch.previewId);};
  const snapshots=new Map(),versions=new Map(),activities=new Map(),linkChecks=new Map();
  const live=new (require('./membership-live.cjs').MembershipLive)(client,(kind,event)=>{
    if(kind==='membership-server-event'){
      if(event.type!=='chat')for(const [linkId,ctx] of links.pending)if(ctx.connection.config.serverId===event.serverId)linkChecks.delete(linkId);
      versions.set(event.serverId,(versions.get(event.serverId)||0)+1);const cached=snapshots.get(event.serverId);
      if(cached){if(event.type==='chat'){cached.value={...cached.value,channels:cached.value.channels.map(c=>c.id===event.channelId&&c.messageRevision<=event.revision?{...c,messageRevision:event.revision,lastMessageId:event.last}:c)};}else cached.at=0;}
    }
    send(kind,event);
  },(serverId,value)=>snapshots.set(serverId,{value,at:Date.now()}));
  const snapshotResult=(serverId,value)=>({...value,eventsLive:live.healthy(serverId)});
 const statuses = new Map(), connecting = new Map(), knownRecords = new Map(), departed = new Set(), intentionalDepartures = new Set(); let activeVoice, preparedVoice, voiceEpoch=0,voiceBusy=false, stopped = false, timer, departureTask;
  const locked=error=>['SERVER_KEY_CHANGED','SERVER_ID_CHANGED','INVALID_SERVER_IDENTITY','SERVER_BINDING_MISMATCH'].includes(error.code);
  async function reportDeparture(serverId,error,record=knownRecords.get(serverId)){
    if(error.local||intentionalDepartures.has(serverId)||!record||!['NOT_A_MEMBER','BANNED'].includes(error.code)||departed.has(serverId))return;
    departed.add(serverId);
    const departure={serverId,name:record.name,kind:error.code==='BANNED'?'ban':'kick'};
    if(error.code==='BANNED'&&(error.details?.expiresAt===null||Number.isSafeInteger(error.details?.expiresAt)))departure.expiresAt=error.details.expiresAt;
    clearNotifications(serverId);live.remove(serverId);snapshots.delete(serverId);await client.forget(serverId);
    if(activeVoice?.serverId===serverId||preparedVoice?.serverId===serverId){await voiceLeave();send('membership-voice-lost',{serverId});}
    send('membership-changed',{serverId,departure});
  }
  async function connectRecord(record,force=false) {
    knownRecords.set(record.serverId,record);
    const cached=snapshots.get(record.serverId);
    if(!force&&cached&&live.healthy(record.serverId)&&cached.at>0)return snapshotResult(record.serverId,cached.value);
    if(connecting.has(record.serverId))return connecting.get(record.serverId);
    const version=versions.get(record.serverId)||0;
    const operation=(client.connections.has(record.serverId)?client.state(record.serverId):client.connect(record)).then(value=>{
      const changed=(versions.get(record.serverId)||0)!==version,latest=snapshots.get(record.serverId)?.value;
      if(changed&&latest)value={...value,channels:value.channels.map(c=>{const newer=latest.channels.find(n=>n.id===c.id);return newer&&newer.messageRevision>c.messageRevision?newer:c;})};
      snapshots.set(record.serverId,{value,at:changed?0:Date.now()});statuses.set(record.serverId,'online');departed.delete(record.serverId);live.ensure(record.serverId,value);return snapshotResult(record.serverId,value);
    }).catch(async error=>{statuses.set(record.serverId,locked(error)?'locked':'offline');await reportDeparture(record.serverId,error,record);throw error;}).finally(()=>connecting.delete(record.serverId));
    connecting.set(record.serverId,operation);return operation;
  }

  async function background() {
    if (stopped) return;
    const beforeStatuses=JSON.stringify([...statuses]);
    try {
      const records = await client.registry();live.reconcile(records);for(const serverId of snapshots.keys())if(!records.some(r=>r.serverId===serverId))snapshots.delete(serverId); let index = 0;
      if(!departureTask&&client.pendingDepartures)departureTask=client.pendingDepartures().then(results=>{if(stopped)return;for(const result of results)if(result.outcome==='blocked'){intentionalDepartures.delete(result.serverId);send('membership-changed',{serverId:result.serverId,leaveError:'LAST_ADMIN'});}if(results.length)send('membership-changed',{});}).catch(()=>{}).finally(()=>{departureTask=undefined;});
      const connections=Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
        while (index < records.length && !stopped) {
          const record = records[index++];
          try {
            await connectRecord(record);
            if(live.healthy(record.serverId))await live.reconcileSequence(record.serverId);
            if(!live.healthy(record.serverId))await client.request(record.serverId, '/api/v2/heartbeat', 'POST', {});
            if(client.connections.get(record.serverId)?.config?.capabilities?.includes('activity-v1')){const away=getIdleSeconds()>=300,stamp=client.connections.get(record.serverId).token+':'+away;if(activities.get(record.serverId)!==stamp){await client.request(record.serverId,'/api/v2/activity','POST',{away});activities.set(record.serverId,stamp);}}
            statuses.set(record.serverId, 'online');
            if (activeVoice?.serverId === record.serverId) {
              try { await client.request(record.serverId, '/api/v2/voice/heartbeat', 'POST', {}); }
              catch(error) { if(['NOT_A_MEMBER','BANNED'].includes(error.code))await reportDeparture(record.serverId,error,record);else{await voiceLeave();send('membership-voice-lost',{serverId:record.serverId});} }
            }
          } catch(error) { statuses.set(record.serverId, locked(error)?'locked':'offline');await reportDeparture(record.serverId,error,record); }
        }
      }));
      await connections;
      if(beforeStatuses!==JSON.stringify([...statuses])||records.some(record=>!live.healthy(record.serverId)))send('membership-changed', {});
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
    async servers() { const host=getHost?.();const records=await client.registry();live.reconcile(records);for(const record of records)knownRecords.set(record.serverId,record);return records.map(record => ({ ...record, ownedSelfhost:!!(host?.running&&host.serverId===record.serverId),source:host?.running&&host.serverId===record.serverId?'selfhost':'external',status: statuses.get(record.serverId) || 'offline' })); },
    async activity(){return {away:getIdleSeconds()>=300};},
    async identity() { const identity = await client.identity(); return { profileId: identity.profileId, deviceId: identity.deviceId }; },
    async join(input) {
      const result = await client.join(string(input.address), string(input.nickname, 64), string(input.deviceLabel || t('Компьютер'), 64));
      intentionalDepartures.delete(result.serverId);departed.delete(result.serverId);
      statuses.set(result.serverId, 'online'); send('membership-changed', { serverId: result.serverId }); return result;
    },
    async connect(input) {
      const serverId = id(input.serverId), record = (await client.registry()).find(record => record.serverId === serverId);
      if (!record) fail('NOT_A_MEMBER'); return connectRecord(record,input.force===true);
    },
    async state(input) { return client.state(id(input.serverId)); },
    async 'server.avatar'(input){return client.serverAvatar(id(input.serverId),input.avatar,input.expectedRevision);},
    async 'server.rename'(input) {
      const serverId=id(input.serverId);
      await client.request(serverId,'/api/v2/server','PATCH',{name:string(input.name,256),expectedName:string(input.expectedName,256),requestId:randomID()});
      const state=await client.state(serverId);send('membership-changed',{serverId});return state;
    },
    async 'server.address'(input) {
      const serverId = id(input.serverId);
      if (activeVoice?.serverId === serverId || preparedVoice?.serverId === serverId) fail('BUSY');
      const result = await client.changeAddress(serverId, string(input.address));live.remove(serverId);snapshots.set(serverId,{value:result,at:Date.now()});live.ensure(serverId,result);
      statuses.set(serverId, 'online'); send('membership-changed', { serverId }); return result;
    },
    async 'poll.create'(input){const pollId=id(input.requestId);return client.send(id(input.serverId),id(input.channelId),{text:string(input.question,600),poll:{...input.definition,id:pollId}},undefined,pollId);},
    async 'poll.state'(input){return client.request(id(input.serverId),'/api/v2/polls/'+id(input.pollId));},
    async 'poll.vote'(input){if(!Array.isArray(input.choices)||input.choices.length>10||input.choices.some(i=>!Number.isInteger(i)||i<0||i>9))fail('INVALID_INPUT');return client.request(id(input.serverId),'/api/v2/polls/'+id(input.pollId)+'/vote','PUT',{choices:input.choices,requestId:id(input.requestId)});},
    async 'poll.close'(input){return client.request(id(input.serverId),'/api/v2/polls/'+id(input.pollId)+'/close','POST',{requestId:id(input.requestId)});},
    async 'chat.watch'(input){return live.watch(id(input.serverId),id(input.channelId),id(input.subscriptionId));},
    async 'chat.unwatch'(input){return live.unwatch(id(input.subscriptionId));},
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
      intentionalDepartures.add(serverId);clearNotifications(serverId);live.remove(serverId);snapshots.delete(serverId);
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
    async 'link.pending'() {
      links.prune();for(const linkId of linkAlerts)if(!links.pending.has(linkId))linkAlerts.delete(linkId);const pending=[];
      for(const [linkId,ctx] of links.pending){
        if(ctx.side!=='target')continue;
        try{const check=linkChecks.get(linkId),serverId=ctx.connection.config.serverId;const status=live.healthy(serverId)&&check&&Date.now()-check.at<30000?check.status:await links.status(linkId);linkChecks.set(linkId,{at:check?.status===status?check.at:Date.now(),status});
          if(status.state==='proposed'){
            pending.push({linkId,serverId:ctx.connection.config.serverId});
            if(!linkAlerts.has(linkId)){linkAlerts.add(linkId);const win=getWindow();if(win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();}}
          }else if(['cancelled','expired','confirmed'].includes(status.state)){links.pending.delete(linkId);linkAlerts.delete(linkId);}
        }catch(error){if(['LINK_EXPIRED','LINK_NOT_FOUND'].includes(error.code)){links.pending.delete(linkId);linkAlerts.delete(linkId);}}
      }return pending;
    },
    async 'link.cancel'(input){return links.cancel(id(input.linkId));},
    async 'link.status'(input) { return links.status(id(input.linkId)); },
    async 'link.approve'(input) { return links.approve(id(input.linkId)); },
    async 'link.finish'(input) { const result = await links.finish(id(input.linkId)); intentionalDepartures.delete(result.serverId);departed.delete(result.serverId);send('membership-changed', {}); return result; },
    async 'device.unlink'(input) { return links.unlink(id(input.serverId), id(input.deviceId, 64), false); },
    async 'device.revoke'(input) { return links.unlink(id(input.serverId), id(input.deviceId, 64), true); },
    async 'control.create'(input) { return links.transferCreate(id(input.serverId), id(input.deviceId, 64)); },
    async 'control.accept'(input) { return links.transferAccept(id(input.serverId), string(input.text, 4096)); },
    async 'control.finish'(input) { const value=await links.transferFinish(id(input.serverId), string(input.text, 4096)); send('membership-changed', {}); return value; },
    async 'notify.read'(input){
      const serverId=id(input.serverId),channelId=id(input.channelId),read=input.messageId;if(!Number.isSafeInteger(read)||read<0)fail('INVALID_INPUT');
      const key=serverId+':'+channelId;notificationReads.set(key,Math.max(notificationReads.get(key)||0,read));if(notificationReads.size>2048)notificationReads.delete(notificationReads.keys().next().value);
      const batch=notificationBatches.get(key);if(batch&&alreadyRead(key,batch))cancelNotificationBatch(key);
      const shown=shownNotifications.get(key);if(shown&&alreadyRead(key,shown))closeNotification(key);
      return true;
    },
    async notify(input) {
      const serverId = id(input.serverId), channelId=id(input.channelId); if (!client.connections.has(serverId) || (!input.mention&&(getWindow()?.isFocused())) || !Notification?.isSupported()) return false;
      if(input.mention!==undefined&&typeof input.mention!=='boolean')fail('INVALID_INPUT');
      const notificationKey=serverId+':'+channelId;
      if(input.messageId!==undefined){if(!Number.isSafeInteger(input.messageId)||input.messageId<1)fail('INVALID_INPUT');}
      if(input.lastMessageId!==undefined&&(!Number.isSafeInteger(input.lastMessageId)||input.lastMessageId<(input.messageId||1)))fail('INVALID_INPUT');
      const last=input.lastMessageId||input.messageId||0;
      if(last&&((notified.get(notificationKey)||0)>=last||(notificationReads.get(notificationKey)||0)>=last))return false;
      const channelName=string(input.channelName,128).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').trim();
      const author=string(input.authorName||t('Участник'),128).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').trim();
      if(input.hasImage!==undefined&&typeof input.hasImage!=='boolean')fail('INVALID_INPUT');
      const text=messagePreview(string(input.text||'',4096),t('Спойлер'));
      if(input.batchCount!==undefined&&(!Number.isSafeInteger(input.batchCount)||input.batchCount<1||input.batchCount>1000000))fail('INVALID_INPUT');
      const content=[input.hasImage?t('Изображение'):'',text].filter(Boolean).join(' · ');
      if(!content)return false;
      const preview=Array.from(content).slice(0,240).join('')+(Array.from(content).length>240?'…':'');
      const existing=notificationBatches.get(notificationKey);
      if(existing&&last&&existing.last>=last)return false;
      const alertMention=!!input.mention||!!existing?.mention,alertAuthor=existing?.mention&&!input.mention?existing.author:author,alertPreview=existing?.mention&&!input.mention?existing.preview:preview;
      const first=existing?.first||Date.now(),count=(existing?.count||0)+(input.batchCount||1);
      const previewId=existing?.mention&&!input.mention?existing.previewId:input.messageId||last;
      if(existing)cancelNotificationBatch(notificationKey);
      if(!existing&&notificationBatches.size>=128)cancelNotificationBatch(notificationBatches.keys().next().value);
      return new Promise(resolve=>{
        const batch={first,count,mention:alertMention,author:alertAuthor,preview:alertPreview,previewId,last,cancelled:false,resolve,timer:undefined};
        const eligible=()=>!stopped&&!batch.cancelled&&notificationBatches.get(notificationKey)===batch&&Date.now()-first<30000&&client.connections.has(serverId)&&!intentionalDepartures.has(serverId)&&!alreadyRead(notificationKey,batch)&&(!last||(notified.get(notificationKey)||0)<last)&&!(!alertMention&&getWindow()?.isFocused());
        batch.timer=setTimeout(()=>{void(async()=>{
          if(!eligible())return false;
          const record=(await client.registry()).find(record=>record.serverId===serverId);
          // Reading, focus or leaving can change while registry I/O is pending.
          if(!eligible())return false;
          if(last){notified.set(notificationKey,last);if(notified.size>2048)notified.delete(notified.keys().next().value);}
          const notification=new Notification({id:notificationID(notificationKey),groupId:notificationID(serverId),silent:true,title:`${record?.name||'PawTalk'} · #${channelName}`,body:(count>1?t('Новых сообщений: {0}',count)+' · ':'')+`${alertAuthor}: ${alertPreview}`});
          closeNotification(notificationKey);if(shownNotifications.size>=128)closeNotification(shownNotifications.keys().next().value);
          shownNotifications.set(notificationKey,{notification,last,previewId});
          // Windows prepares toasts asynchronously after show() returns. A read
          // can arrive before the shell displays it, so dismiss that late show too.
          notification.on('show',()=>{if(stopped||shownNotifications.get(notificationKey)?.notification!==notification||alreadyRead(notificationKey,{last,previewId})||!client.connections.has(serverId)||intentionalDepartures.has(serverId)||!alertMention&&getWindow()?.isFocused()){if(shownNotifications.get(notificationKey)?.notification===notification)shownNotifications.delete(notificationKey);try{notification.close?.();}catch{}}});
          // Keep the object after native timeout: it can still be in Action Center.
          notification.on('failed',()=>{if(shownNotifications.get(notificationKey)?.notification===notification)shownNotifications.delete(notificationKey);});
          notification.on('click',()=>{const win=getWindow();if(win&&!win.isDestroyed()){win.show();win.focus();send('membership-open-channel',{serverId,channelId});}});notification.show();return true;
        })().then(resolve,()=>resolve(false)).finally(()=>{if(notificationBatches.get(notificationKey)===batch)notificationBatches.delete(notificationKey);});},Math.max(0,Math.min(250,first+1000-Date.now())));
        notificationBatches.set(notificationKey,batch);
      });
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
  return { start() { void background(); }, stop() { stopped = true;clearNotifications();live.stop(); clearTimeout(timer); void voiceLeave(); }, suspend() { void voiceLeave(); },
    async serverEnded(serverId) { clearNotifications(serverId);live.remove(serverId);snapshots.delete(serverId);intentionalDepartures.add(serverId);knownRecords.delete(serverId);if(activeVoice?.serverId===serverId||preparedVoice?.serverId===serverId){await voiceLeave();send('membership-voice-lost',{serverId});} await client.forget(serverId);statuses.delete(serverId);send('membership-changed',{serverId}); },statuses };
}
module.exports = { registerMembershipIPC };
