import { DevicesDialog,LinkDialog } from '../src/MemberDialogs';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ServerApp} from '../src/ServerApp';
import {defaults} from '../src/settings';
import {VoiceSession, type Snapshot} from '../src/session';
import {playSound} from '../src/sounds';
import {changeLanguage} from '../src/i18n';
import {applyTheme,defaultTheme} from '../src/theme';
import '../src/style.css';
import '../src/interface.css';
applyTheme(defaultTheme);
await changeLanguage(new URLSearchParams(location.search).get('language')==='en'?'en':'ru');
localStorage.setItem('pawtalk.onboarding',new URLSearchParams(location.search).has('wizard')?'pending':'done');localStorage.setItem('pawtalk.nickname','Me');
localStorage.setItem('pawtalk.settings',JSON.stringify({...defaults,sounds:true}));
const test=window as any,sid='1'.repeat(32),cid='2'.repeat(32),me='a'.repeat(64),friend='b'.repeat(64);
localStorage.removeItem('pawtalk.v2.read.'+sid+'.'+cid);localStorage.removeItem('pawtalk.v2.mute.'+sid);
const channel={id:cid,kind:'text',name:'General',protected:true,revision:1,messageRevision:1,lastMessageId:120};
const state={serverId:sid,name:'Synthetic notification server',revision:1,controlRevision:1,self:{profileId:me,effectiveProfileId:me,deviceId:'c'.repeat(64),role:'member',permissions:[]},profiles:[{id:me,nickname:'Me',revision:1},{id:friend,nickname:'Friend',revision:1}],channels:[channel],members:[{profileId:me,online:true,role:'member'},{profileId:friend,online:true,role:'member'}],devices:[],voice:[],bindings:[]};
const protectedMode = new URLSearchParams(location.search).get('protected');
const sizedPhotoPreview = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
const scopedSettingsFixture = protectedMode === 'scoped-settings';
const hiddenOriginalFixture = protectedMode === 'hidden-original';
const originalChannel = '7'.repeat(32), originalPoster = '8'.repeat(32);
const channelManagerFixture = ['owner', 'administrator', 'root-layout'].includes(protectedMode ?? '');
const fixtureNicknames = new Map([[me,{name:'Me',revision:0}],[friend,{name:'Friend',revision:0}]]);
test.renameRosterFixtureMember = () => fixtureNicknames.set(friend, { name:'Updated on next page', revision:1 });
test.rosterPageRequests = [];
test.voiceModeration = [];
let fixtureCommunity = { name:state.name, revision:1 };
let fixtureCommunityAvatar: { revision: number; avatar?: string } = { revision: 2,
  avatar: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5e8AAAAASUVORK5CYII=' };
test.setCommunityName = (name: string) => {
  fixtureCommunity = { name, revision:fixtureCommunity.revision+1 };
  refresh();
};
const protectedState = { apiProtocolVersion: 3, serverId: sid, profileId: me, canManageChannels: channelManagerFixture,
  ...(protectedMode === 'device-binding' && { canRevokeOwnDevices: true, profileAvatarSupported: true,
    profileAvatar: { revision: 2, avatar: fixtureCommunityAvatar.avatar, pending: false } }),
  eventsLive: protectedMode === 'formatted-chat' || new URLSearchParams(location.search).has('composer-activity'),
  composerEvents: new URLSearchParams(location.search).has('composer-activity'),
  canEditOwnNickname: channelManagerFixture,
  canEditCommunity: channelManagerFixture || protectedMode === 'community-editor',
  canEditRoles: protectedMode === 'role-editor', canAssignRoles: ['role-assigner', 'directory-assigner'].includes(protectedMode ?? ''),
  canManageScopeAuthority: protectedMode === 'owner',
  canListMembers: ['owner', 'directory-assigner'].includes(protectedMode ?? ''), canManageTimeouts: protectedMode === 'owner',
  canViewAudit: ['owner', 'auditor', 'audit-proof'].includes(protectedMode ?? ''),
  canListInvites: ['inviter', 'invite-viewer'].includes(protectedMode ?? ''),
  canManageBans: protectedMode === 'membership-moderator',
  categories: [{ id: 'category', name: 'General category' },
    ...(channelManagerFixture ? [{ id: 'destination', name: 'Destination' }, { id: 'empty', name: 'Empty category' }] : [])],
  channels: [{ id: cid, kind: 'text', name: 'General', categoryId: 'category', canOrder: protectedMode === 'editor',
    canEditSettings: scopedSettingsFixture, canInspectACL: scopedSettingsFixture },
    { id: '3'.repeat(32), kind: 'voice', name: 'Meetings', categoryId: 'category', canOrder: protectedMode === 'editor',
      canEditSettings: scopedSettingsFixture },
    ...(channelManagerFixture || ['formatted-chat', 'voice-protection'].includes(protectedMode ?? '') ? [{ id: '6'.repeat(32), kind: 'text', name: 'Lobby',
      categoryId: channelManagerFixture ? 'destination' : 'category',
      canOrder: false, canEditSettings: false }] : []),
    ...(protectedMode === 'voice-protection' ? [{ id: '5'.repeat(32), kind: 'voice', name: 'Breakout',
      categoryId: 'category', canOrder: false, canEditSettings: false }] : []),
    ...(hiddenOriginalFixture ? [{ id: originalChannel, kind: 'text', name: 'Private original room',
      categoryId: 'category', canOrder: false, canEditSettings: false }] : []),
    ...(protectedMode === 'editor' || scopedSettingsFixture ? [{ id: '4'.repeat(32), kind: 'text', name: 'Read only',
      categoryId: 'category', canOrder: false, canEditSettings: false }] : [])] };
const categories = [{ id: 'category', name: 'General category' }, { id: 'destination', name: 'Destination' }];
if (protectedMode === 'root-layout') {
  protectedState.channels[0].categoryId = '';
  protectedState.channels[1].categoryId = '';
}
const inviteFixtureNow = Date.now();
const fixtureInvites = [{ id: '8'.repeat(32), creator: friend, createdAt: inviteFixtureNow - 1000,
  expiresAt: inviteFixtureNow + 3_600_000, maxUses: 0, uses: 1, canRevoke: false }];
test.inviteRequests = [];
let channelDraft: Record<string, unknown> | undefined;
test.protectedChanges = [];
test.protectedMovePreviews = [];
test.protectedCopyPreviews = [];
test.protectedTotalChannels = 2;
test.historyFirst = 1;
test.protectedSends = [];
test.protectedHistoryReads = [];
test.pagingChatLast = 96;
test.roleViewOperations = [];
type FixtureProtectedEvent = { serverId: string } & ({ type: 'chat'; channelId: string } | { type: 'state' } |
  { type: 'composer'; channelId: string; profileId: string; activity: 'typing' | 'recording' | 'idle' });
const protectedEventListeners = new Set<(event: FixtureProtectedEvent) => void>();
if (new URLSearchParams(location.search).has('hold-photo-decode')) {
  const decode = HTMLImageElement.prototype.decode;
  const gate = new Promise<void>(resolve => { test.releasePhotoDecode = resolve; });
  test.photoDecodes = 0;
  HTMLImageElement.prototype.decode = async function () {
    test.photoDecodes++;
    await gate;
    return decode.call(this);
  };
}
test.composerCalls = [];
test.emitComposerActivity = (activity: 'typing' | 'recording' | 'idle', channelId = cid, profileId = friend) =>
  protectedEventListeners.forEach(listener => listener({ serverId: sid, type: 'composer', channelId, profileId, activity }));
test.invalidateGeneralChat = () => protectedEventListeners.forEach(listener => listener({ serverId: sid, type: 'chat', channelId: cid }));
test.protectedUploads = [];
test.protectedCanAttach = false;
test.protectedCanSendVoice = false;
test.protectedMentionMass = false;
test.protectedAlerts = [];
test.protectedAlertPolls = 0;
test.addProtectedAlert = (kind:'direct'|'group') => {
  test.protectedAlerts.push({ channelId:cid, position:test.protectedAlerts.length+20, kind });
  refresh();
};
test.protectedRemoved = [];
test.protectedCanDeleteOther = false;
test.protectedCanDeletePoll = false;
const checklistItem = 'c'.repeat(32);
let protectedChecklistChecked = false;
let protectedPollOwn: number[] = [];
let protectedPollClosed = false;
test.pollVoterVisible = true;
test.protectedEdits = [];
const fixtureEdits = new Map<number, { text: string; editedAt: number; revision: number;
  checklist?: { everyone: boolean; items: { id: string; text: string }[] } }>();
const fixturePins = new Set<number>();
const oldPinMime = new URLSearchParams(location.search).get('old-pin');
const oldPinFixture = oldPinMime !== null;
const oldPinMessage = { position: 2, own: false, authorProfileId: friend, sentAt: 123456,
  text: oldPinMime ? '' : 'Earlier pinned message',
  ...(oldPinMime && { files: [{ id: 'b'.repeat(32), mime: oldPinMime, name: 'Pinned media', size: 2 }] }) };
if (oldPinFixture) fixturePins.add(2);
if (hiddenOriginalFixture) fixturePins.add(1);
test.revisePinnedFixture = () => fixtureEdits.set(2, { text: 'Updated pinned text', editedAt: 123460, revision: 2 });
test.protectedTimeoutChanges = [];
test.protectedMembershipChanges = [];
const fixtureBans = new Map<string, { profileId: string; expiresAt: number; reason: string }>();
const fixtureTimeouts = new Map<string, { deadline: number; reason: string }>();
let auditRetention = 365;
test.auditChanges = [];
test.setProtectedChatVisible = (visible: boolean) => {
  test.protectedChatHidden = !visible;
  refresh();
};
test.revokeProtectedOrder = () => {
  for (const channel of protectedState.channels) channel.canOrder = false;
  refresh();
};
const accessImpact = {
  before: { visible: 1, fullHistory: 1, allowed: true }, after: { visible: 0, fullHistory: 0, allowed: false },
  gained: { visible: 0, fullHistory: 0 }, lost: { visible: 1, fullHistory: 1 },
};
const channelDelta = { gainedView: [], lostView: [{ id: friend, name: 'Friend' }], gainedHistory: [], lostHistory: [], keyChannels: 1 };
const records:any[]=[];for(let id=1;id<=120;id++)records.push({id,channelId:cid,authorProfileId:friend,requestId:id.toString(16).padStart(32,'0'),sentAt:Date.now()-100000,content:{text:'History '+id+': '+'text '.repeat(20)}});
const serverRecords=[{serverId:sid,name:state.name,address:'https://127.0.0.1:18443',status:'online'}];
type FixtureMembershipChange = { serverId: string; nickname?: { profileId: string; name: string } };
let online=true;const listeners=new Set<(event?: FixtureMembershipChange)=>void>();let activeListener=(_active:boolean)=>{};
const refresh=(event?: FixtureMembershipChange)=>listeners.forEach(listener=>listener(event));
let openChannelListener: ((event: { serverId: string; channelId: string; protected: boolean }) => void) | undefined;
test.openOriginalFixture = () => openChannelListener?.({ serverId: sid, channelId: originalChannel, protected: true });
test.revokeOriginalFixture = () => { test.originalRevoked = true; refresh(); };
test.deniedOriginalReads = 0;
const voiceProfileFixture = new URLSearchParams(location.search).has('voice-profile');
const emptyChatFixture = new URLSearchParams(location.search).has('empty-chat');
const pendingChatFixture = new URLSearchParams(location.search).has('pending-chat');
const pendingKeyErrorFixture = new URLSearchParams(location.search).has('pending-key-error');
let channelKeysPending = pendingChatFixture;
test.finishChannelSync = () => {
  channelKeysPending = false;
  protectedEventListeners.forEach(listener => listener({ serverId: sid, type: 'state' }));
};
if (protectedMode === 'voice-protection' || voiceProfileFixture) {
  test.voicePeerAudio = {};
  const setPerson = VoiceSession.prototype.setPerson;
  VoiceSession.prototype.setPerson = function (id, volume, muted) {
    test.voicePeerAudio[id] = { volume, muted };
    setPerson.call(this, id, volume, muted);
  };
  const profile: { name: string; avatar?: string } = { name: 'Default voice name' };
  let publishProfile: (() => void) | undefined;
  if (voiceProfileFixture) {
    VoiceSession.prototype.setNickname = function (name) { profile.name = name; publishProfile?.(); };
    VoiceSession.prototype.setAvatar = function (avatar) { profile.avatar = avatar; publishProfile?.(); };
    const disconnect = VoiceSession.prototype.disconnect;
    VoiceSession.prototype.disconnect = function () {
      publishProfile = undefined;
      return disconnect.call(this);
    };
  }
  VoiceSession.prototype.connectProtected = async function (_transport, scope) {
    if (!scope) throw Error('Missing protected voice scope');
    type Status = NonNullable<Snapshot['voiceProtection']>;
    const emit = (state: Status['state'], reason: Status['reason'], connectionState: string,
      scopeOverride: Partial<Pick<Status, 'serverId' | 'channelId'>> = {}) => {
      if (voiceProfileFixture) {
        publishProfile = connectionState === 'connected' ? () => emit(state, reason, connectionState, scopeOverride) : undefined;
        test.publishedVoiceProfile = { ...profile };
      }
      this.onUpdate({
        state: connectionState, people: state === 'green' ? [
          { id: 'e'.repeat(32), name: 'Friend', speaking: false, muted: false, ...test.voicePeerTransport, local: false },
          ...(voiceProfileFixture ? [{ id: 'c'.repeat(32), ...profile, speaking: false, muted: false,
            ...test.voiceLocalTransport, local: true }] : []),
        ] : [], db: -100, speaking: false,
        e2ee: state !== 'green',
        voiceProtection: { ...scope, ...scopeOverride, state, reason },
      });
    };
    test.voiceProtectionScope = scope;
    test.emitVoiceProtection = emit;
    emit('yellow', 'VOICE_KEY_PENDING', 'connecting');
    await new Promise<void>(resolve => {
      test.completeProtectedVoiceJoin = () => {
        emit('green', 'VOICE_VERIFIED', 'connected');
        resolve();
      };
    });
  };
}
test.setRotationQueue = (rotationQueue?: { waiting: number; processing: number }) => {
  test.rotationQueue = rotationQueue;
  refresh();
};
test.textProtectionCalls = [];
test.setTextProtection = (status: { state: string; reason: string; allowSend: boolean }, fromServerEvent = false) => {
  test.textProtection = status;
  if (fromServerEvent) protectedEventListeners.forEach(listener => listener({ serverId: sid, type: 'state' }));
  else window.dispatchEvent(new Event('focus'));
};
const noop=()=>()=>{};
test.desktopNotifications=[];test.messageReads=[];test.notificationReads=[];
test.recoveryCalls = [];
test.recoveryInventoryCalls = [];
test.ownershipCalls = [];
test.bindingCalls = [];
test.scopedSettingsCalls = [];
test.scopedSettingsRead = { policyHead: 'a'.repeat(64), policyRevision: 1,
  settings: { name: 'General', description: 'Existing description', slowmodeSeconds: 0, voiceCapacity: 0 } };
test.scopedSettingsCommitError = '';
let recoveryReplaced = false;
let recoveryPending = true;
let recoveryReady = false;
const ownershipFixture = protectedMode === 'ownership-offer' || protectedMode === 'ownership-accept';
const outgoing = protectedMode === 'ownership-offer';
const ownershipOperationId = 'd'.repeat(32);
let ownershipProfile = outgoing ? me : friend;
let ownershipOffered = protectedMode === 'ownership-accept';
let bindingApproved = false;
test.clientPerformance = [];
test.desktop={
 recordClientPerformance(stage:string,ms:number){test.clientPerformance.push({stage,ms});},
 membership:async(action:string,input:any={})=>{
  if (document.querySelector('.protected-role-view-page[open]') &&
      /^(chat\.protected\.(read|send)|voice\.protected\.join|roster\.protected\.read)$/.test(action)) {
    test.roleViewOperations.push(action);
  }
  if(action==='copy'){
    if (test.failClipboard) return {error:{code:'CLIPBOARD_UNAVAILABLE'}};
    test.copied=input.text;return{value:true};
  }
  if (action === 'protection.protected.read' && (protectedMode === 'text-protection' || (channelManagerFixture && test.textProtection))) {
    test.textProtectionCalls.push(structuredClone(input));
    return { value: input.offline ? { state: 'grey', reason: 'OFFLINE', allowSend: false } :
      test.textProtection ?? { state: 'green', reason: 'CURRENT_VERIFIED', allowSend: true } };
  }
  if (scopedSettingsFixture && action === 'channel.acl.protected.read') {
    return { value: { channelId: input.channelId, kind: 'text', synchronized: true,
      rules: { '@everyone': { Allow: ['channel.view'], Deny: ['message.send'] } }, policyHead: 'a'.repeat(64), revision: 2 } };
  }
  if (scopedSettingsFixture && action === 'channel.acl.protected.commit') {
    test.scopedACLCommit = input;
    return { value: { channelId: input.channelId, revision: 3 } };
  }
  if (scopedSettingsFixture && action === 'channel.acl.protected.personal.read') {
    return { value: { channelId: input.channelId, profileId: input.profileId, kind: 'text', synchronized: true,
      rules: null, policyHead: 'b'.repeat(64), revision: 3 } };
  }
  if (scopedSettingsFixture && action === 'channel.acl.protected.personal.commit') {
    test.scopedPersonalACLCommit = input;
    return { value: { channelId: input.channelId, profileId: input.profileId, revision: 4 } };
  }
  if (scopedSettingsFixture && action.startsWith('channel.settings.protected.')) {
    test.scopedSettingsCalls.push({ action, ...structuredClone(input) });
    const channel = protectedState.channels.find(item => item.id === input.channelId && item.canEditSettings);
    if (!channel) return { error: { code: 'PROTECTED_ACCESS_DENIED' } };
    if (action === 'channel.settings.protected.read') {
      if (test.scopedSettingsReadError) return { error: { code: test.scopedSettingsReadError } };
      if (test.publishScopedSettingsName && test.scopedSettingsRead.settings) channel.name = test.scopedSettingsRead.settings.name;
      return { value: { channelId: channel.id, kind: channel.kind, ...structuredClone(test.scopedSettingsRead) } };
    }
    if (action === 'channel.settings.protected.commit') {
      return test.scopedSettingsCommitError ? { error: { code: test.scopedSettingsCommitError } }
        : { value: { channelId: channel.id, revision: test.scopedSettingsRead.policyRevision + 1,
          confirmed: test.scopedSettingsCommitConfirmed === true } };
    }
  }
  if (action === 'device.protected.list') {
    const devices = [{ deviceId: 'c'.repeat(64), current: true }];
    if (protectedMode === 'device-binding' && bindingApproved) {
      devices.push({ deviceId: '1234567890abcdef'.repeat(4), current: false });
    }
    return { value: { devices } };
  }
  if (protectedMode === 'device-binding' && action.startsWith('device.protected.')) {
    test.bindingCalls.push({ action, ...input });
    const deviceId = '1234567890abcdef'.repeat(4);
    if (action === 'device.protected.challenge') return { value: { challengeCard: 'synthetic-link-card' } };
    if (action === 'device.protected.request' && input.challengeCard === 'synthetic-link-card') {
      return { value: { requestCard: 'synthetic-reply-card', deviceId } };
    }
    if (action === 'device.protected.preview' && input.requestCard === 'synthetic-reply-card') {
      return { value: { deviceId, expiresAt: Date.now() + 3600000 } };
    }
    if (action === 'device.protected.approve' && input.requestCard === 'synthetic-reply-card') {
      bindingApproved = true;
      return { value: { deviceId } };
    }
    if (action === 'device.protected.finish' && input.challengeCard === 'synthetic-link-card') {
      return bindingApproved ? { value: { serverId: sid } } : { error: { code: 'INVALID_PROTECTED_SESSION_PROOF' } };
    }
    if (action === 'device.protected.revoke' && input.deviceId === deviceId && bindingApproved) {
      bindingApproved = false;
      return { value: { deviceId } };
    }
    return { error: { code: 'INVALID_DEVICE_BINDING_CARD' } };
  }
  if (protectedMode === 'recovery' && action === 'recovery.protected.devices') {
    const phase = recoveryReady ? 'ready' : recoveryReplaced ? 'pending' : 'review';
    test.recoveryInventoryCalls.push({ phase, ...input });
    if (test.recoveryInventoryCalls.length === 1) return { error: { code: 'RATE_LIMIT' } };
    return { value: { devices: [
      { deviceId: ({ review: '4', pending: '5', ready: '6' }[phase]).repeat(64), current: false },
      { deviceId: 'c'.repeat(64), current: true },
    ] } };
  }
  if (protectedMode === 'recovery' && ['prepareRecovery', 'confirmRecovery', 'recoverDevice'].includes(action)) {
    const valid = input.recoveryBundle === 'synthetic-recovery-kit';
    test.recoveryCalls.push({ action, valid, replace: input.replace });
    if (action === 'prepareRecovery') return { value: { recoveryBundle: 'synthetic-recovery-kit' } };
    if (action === 'confirmRecovery' && input.recoveryBundle === 'synthetic-retired-kit')
      return { error: { code: 'PROTECTED_RECOVERY_KIT_RETIRED' } };
    if (!valid) return { error: { code: 'INVALID_RECOVERY_BUNDLE' } };
    if (action === 'recoverDevice') return { value: { serverId: sid } };
    if (!recoveryReplaced && input.replace !== true) return { error: { code: 'RECOVERY_REPLACEMENT_CONFIRMATION_REQUIRED' } };
    recoveryReplaced = true;
    if (recoveryPending) {
      recoveryPending = false;
      return { error: { code: 'PROTECTED_RECOVERY_PENDING' } };
    }
    recoveryReady = true;
    return { value: { ready: true } };
  }
  if (ownershipFixture && (action.startsWith('ownership.protected.') || action === 'roster.protected.read' && !input.channelId)) {
    test.ownershipCalls.push({ action, ...input });
    const incoming = !outgoing;
    const targetProfileId = outgoing ? friend : me;
    if (action === 'ownership.protected.read') {
      const offer = { operationId: ownershipOperationId, ownerProfileId: ownershipProfile, targetProfileId,
        expiresAt: Date.now() + 3600000, outgoing };
      return { value: { ownerProfileId: ownershipProfile, canOffer: ownershipProfile === me, ...(ownershipOffered && { offer }) } };
    }
    if (action === 'roster.protected.read') {
      if (incoming) return { error: { code: 'FORBIDDEN' } };
      if (input.after === me && input.revision === 1) return { value: { revision: 1, members: [{ id: friend, name: 'Friend' }] } };
      return { value: { revision: 1, next: me, members: [{ id: me, name: 'Me' }] } };
    }
    if (action === 'ownership.protected.offer' && outgoing && input.targetProfileId === friend) {
      ownershipOffered = true;
      return { value: { operationId: ownershipOperationId } };
    }
    if (input.operationId === ownershipOperationId && ownershipOffered) {
      if (action === 'ownership.protected.cancel' && outgoing) {
        ownershipOffered = false;
        return { value: true };
      }
      if (action === 'ownership.protected.accept' && incoming) {
        ownershipOffered = false;
        ownershipProfile = me;
        return { value: { ownerProfileId: me } };
      }
    }
    return { error: { code: 'PROTECTED_OWNER_TRANSFER_UNAVAILABLE' } };
  }
  if(action==='control.create')return{value:'synthetic-control-offer'};
  if(action==='control.accept')return{value:'synthetic-control-response'};
  if(action==='control.finish'){test.finishCalls=(test.finishCalls||0)+1;state.devices.forEach((device:any)=>{device.primary=device.id!=='c'.repeat(64);});test.renderDevices();await new Promise(resolve=>setTimeout(resolve,80));return{value:state};}
  if(action==='activity')return{value:{away:!!test.idle}};
  if(action==='link.pending')return{value:test.incomingLink?[{linkId:'link-fixture',serverId:sid}]:[]};
  if(action==='link.cancel'){test.linkCancelled=true;test.incomingLink=false;return{value:true};}
  if(action==='link.start')return{value:{id:'link-fixture',text:'synthetic-link'}};
  if(action==='link.status')return{value:{id:'link-fixture',state:'proposed',code:'1234567890',sourceProfileId:'e'.repeat(64),targetProfileId:me,chosenProfileId:me,sourceNickname:'Fresh profile',targetNickname:'Me',expiresAt:Date.now()+600000}};
  if(action==='servers')return{value:serverRecords.map(record=>({...record,status:online?'online':'offline'}))};
  if(action==='identity')return{value:{profileId:me,deviceId:'c'.repeat(64)}};
  if(!online)return{error:{code:'CONNECTION_FAILED'}};
  if(action==='connect'){
    if (test.throttleProtectedChat) return {error:{code:'RATE_LIMIT'}};
    const value=protectedMode?{...structuredClone(protectedState),
      community:fixtureCommunity,
      ...(['reader', 'community-editor'].includes(protectedMode ?? '') && { communityAvatar: fixtureCommunityAvatar }),
      timeout:fixtureTimeouts.get(me),
      ...(['rotation-queue', 'text-protection'].includes(protectedMode ?? '') && test.rotationQueue && {rotationQueue: test.rotationQueue}),
      channels:[...protectedState.channels, ...(test.voiceSidebarFixture && protectedMode !== 'voice-protection' ? [{ id:'5'.repeat(32), kind:'voice', name:'Breakout', categoryId:'category' }] : [])]
        .filter(channel=>(!test.protectedChatHidden || channel.kind!=='text') &&
        (!test.originalRevoked || channel.id!==originalChannel))
        .map(channel => channel.id === cid ? { ...channel,
          ...(channelKeysPending && !pendingKeyErrorFixture && { keysPending: true }),
          ...(test.allowChannelSettings && { canEditSettings: true }),
        } : channel.id === '3'.repeat(32) && test.voiceSidebarFixture ? { ...channel, ...test.voiceSidebarFixture } : channel)
    }:test.reorderMode?{...structuredClone(state),serverId:input.serverId}:structuredClone(state);
    if(protectedMode==='rotation-queue' && test.delayRotationQueueResponse){
      test.delayRotationQueueResponse=false;
      await new Promise<void>(resolve=>{test.releaseRotationQueueResponse=resolve;});
    }
    return{value};
  }
  const pinPage = () => ({canPin:test.protectedCanPin !== false,items:[...fixturePins].filter(position=>position>=test.historyFirst && !test.protectedRemoved.includes(position))
    .map(position=>({position,revision:fixtureEdits.get(position)?.revision ?? 1}))});
  const windowState = () => ({first:test.historyFirst,cursor:'',canDeleteOther:test.protectedCanDeleteOther,
    ...(protectedMode==='paging-chat' && {last:test.pagingChatLast}),
    ...(oldPinFixture && {last:80}),
    canDeletePoll:test.protectedCanDeletePoll,canCreateList:protectedMode==='history',canCreatePoll:protectedMode==='history',
    canAttach:test.protectedCanAttach,canSendVoice:test.protectedCanSendVoice || protectedState.composerEvents,
    canSend:protectedMode!=='poll-voting' && !(emptyChatFixture && new URLSearchParams(location.search).has('read-only')),
    ...((protectedMode==='pins' || hiddenOriginalFixture && input.channelId===originalChannel) && {pins:pinPage()}),
    edits:[...fixtureEdits].filter(([position])=>position>=test.historyFirst && !test.protectedRemoved.includes(position))
      .map(([position,value])=>({position,revision:value.revision})),
    removed:input.cursor===undefined ? [] : test.protectedRemoved.filter((position:number)=>position>=test.historyFirst)});
  if (hiddenOriginalFixture && test.originalRevoked && input.channelId === originalChannel && action.startsWith('chat.protected.')) {
    test.deniedOriginalReads++;
    return {error: {code: 'PROTECTED_ACCESS_DENIED'}};
  }
  if (test.throttleProtectedChat && ['chat.protected.window', 'chat.protected.read', 'roster.protected.read'].includes(action)) {
    return {error:{code:'RATE_LIMIT',retryAfter:1}};
  }
  if(action==='chat.protected.window')return{value:windowState()};
  if(action==='chat.protected.composer'){test.composerCalls.push(input);return{value:true};}
  if ((protectedMode === 'voice-protection' || test.voiceSidebarFixture) && action === 'voice.protected.restriction-choices') {
    const channel = [{action:'voice.mute',lift:false},{action:'voice.deafen',lift:false}];
    return {value:[...channel,
      ...(test.voiceShowServerChoices ? channel.map(choice => ({ ...choice, serverWide: true })) : []),
      {action:'voice.disconnect',lift:false}]};
  }
  if ((protectedMode === 'voice-protection' || test.voiceSidebarFixture) && ['voice.protected.restriction','voice.protected.disconnect'].includes(action)) {
    test.voiceModeration.push({action,input});
    return {value:true};
  }
  if (test.voiceSidebarFixture && action === 'voice.protected.move-choices') return { value: ['5'.repeat(32)] };
  if (test.voiceSidebarFixture && action === 'voice.protected.move') {
    test.voiceModeration.push({ action, input });
    return { value:true };
  }
  if(action==='chat.protected.read' && protectedMode==='paging-chat') {
    test.protectedHistoryReads.push({ after: input.after });
    const last = Math.min(test.pagingChatLast, input.after + (input.limit ?? 32));
    const messages = Array.from({length:last-input.after}, (_, index) => {
      const position = input.after + index + 1;
      const sentAt = position >= 95 ? 95 * 3600000 + (position - 95) * 60000 :
        position === 64 ? 65 * 3600000 - 60000 : position * 3600000;
      return {position,own:false,authorProfileId:friend,sentAt,text:'Entry '+position};
    });
    return {value:{...windowState(),messages,...(last<test.pagingChatLast && {next:last})}};
  }
  if(action==='chat.protected.mentions'){test.protectedAlertPolls++;return{value:[...test.protectedAlerts]};}
  if(action==='chat.protected.notify'){test.desktopNotifications.push(input);return{value:true};}
  if(action==='chat.protected.activity'){
    const position = test.protectedActivityPosition;
    if (!position || position <= input.after) return {value:undefined};
    if (input.notify) test.desktopNotifications.push({ ...input, position, ordinary:true });
    return {value:{position,incoming:true,recent:true,notified:input.notify}};
  }
  if(action==='roster.protected.mentions')return{value:{revision:1,members:[{id:friend,name:'Friend',roles:[{id:'crew',name:'Crew'}]}],
    mentions:{available:true,mass:test.protectedMentionMass,roles:['crew']}}};
  if(action==='chat.protected.browse'||action==='chat.protected.reference'){
    const entries=[{position:1,sentAt:123456,text:'Original poll question',
      files:[{id:'d'.repeat(32),name:'archive.bin',size:2,mime:'application/octet-stream'}]},
    {position:3,sentAt:123458,text:'Reply to poll result',files:[]}]
      .filter(row=>row.position>=test.historyFirst && !test.protectedRemoved.includes(row.position));
    if(action==='chat.protected.reference')return{value:entries.find(row=>row.position===input.position)};
    return{value:{checkpoint:{first:test.historyFirst,cursor:''},matches:entries.filter(row=>row.position>input.after &&
      (input.mode==='gallery' ? row.files.length : row.text.toLowerCase().includes(input.query.toLowerCase())))
      .map(row=>({...row,excerpt:row.text,names:row.files.map(file=>file.name)}))}};
  }
  if(action==='chat.protected.read'){
    if (pendingChatFixture) {
      test.protectedHistoryReads.push({ after: input.after });
      if (pendingKeyErrorFixture && channelKeysPending) return { error: { code: 'PROTECTED_KEY_PENDING' } };
      const messages = channelKeysPending ? (test.readablePendingHistory
        ? [{ position: 1, own: false, authorProfileId: friend, sentAt: 123456, text: 'Previously verified history' }]
        : [{ position: 1, locked: true }]) : [
        { position: 1, own: false, authorProfileId: friend, sentAt: 123456, text: 'Synchronized message' },
        { position: 2, locked: true },
      ];
      return { value: { ...windowState(), messages: messages.filter(message => message.position > input.after) } };
    }
    if (oldPinFixture) {
      test.protectedHistoryReads.push({ after: input.after });
      return { value: { ...windowState(), messages: [
        oldPinMessage,
        { position: 80, own: true, authorProfileId: me, sentAt: 123460, text: 'Reply to older pin', replyTo: 2 },
      ].filter(message => message.position > input.after) } };
    }
    if (emptyChatFixture) {
      const sent = test.protectedSends[0];
      return { value: { ...windowState(), messages: sent && input.after < 3
        ? [{ position: 3, own: true, authorProfileId: me, sentAt: Date.now(), text: sent.text }] : [] } };
    }
    if (new URLSearchParams(location.search).has('own-profile')) return {value:{...windowState(),messages:input.after ? [] : [
      {position:1, own:true, authorProfileId:me, sentAt:123456, text:'My previous message'},
    ]}};
    if (hiddenOriginalFixture) {
      const messages = input.channelId === originalChannel ? [
        { position: 1, own: false, sentAt: 123456, text: 'Private original caption', files: [{
          id: '9'.repeat(32), name: 'Private clip', mime: 'video/mp4', size: 2, poster: { id: originalPoster, mime: 'image/png' },
        }] },
        { position: 2, own: true, sentAt: 123457, text: 'Retained reply', replyTo: test.historyFirst === 1 ? 1 : null },
      ] : [{ position: 2, own: true, sentAt: 123457, text: 'Visible room' }];
      return {value: {...windowState(), messages: messages.filter(row => row.position >= test.historyFirst && row.position > input.after)}};
    }
    if(protectedMode==='formatted-chat'){
      test.protectedHistoryReads.push(input.channelId);
      if (input.channelId !== cid) return {value:{...windowState(),messages:[]}};
      const text = '@Friend **@Friend** [Example](https://example.test/) @Crew';
      const start = text.lastIndexOf('@Friend');
      return {value:{...windowState(),messages:[
        {position:1,own:false,authorProfileId:friend,sentAt:123456,text,mentions:[{kind:'profile',id:friend,start,end:start+7}, {kind:'role',id:'crew',start:text.length-5,end:text.length}]},
        {position:2,own:false,authorProfileId:friend,sentAt:123457,text:'https://giphy.com/gifs/synthetic-preview'},
        ...(test.deliverFormattedSend ? [{position:3,own:true,authorProfileId:me,sentAt:123458,canEdit:true,text:test.protectedSends[0].text}] : []),
      ].filter(message=>message.position>input.after)}};
    }
    if(protectedMode==='poll-result-window'){
      const original = test.historyFirst===1;
      const messages = [
        {position:1,own:false,sentAt:123456,text:'Original poll question',
          files:[{id:'d'.repeat(32),name:'archive.bin',size:2,mime:'application/octet-stream'}]},
        {position:2,own:false,sentAt:123457,text:'Protected poll result',originalPollPosition:1,dedicatedDeletion:true,
          pollResult:{winners:['Winning option']}},
        {position:3,own:false,sentAt:123458,text:'Reply to poll result',replyTo:original?2:null},
      ].filter(row => row.position>input.after && (row.position>2 || original));
      return{value:{...windowState(),messages}};
    }
    if (protectedMode === 'attachment-grid') {
      const photo = { id: 'a'.repeat(32), name: 'Photo.png', mime: 'image/png', size: 100 };
      const clip = { id: 'b'.repeat(32), name: 'Video.webm', mime: 'video/webm', size: 200,
        poster: { id: 'f'.repeat(32), mime: 'image/png' } };
      const messages = [
        { position: 1, own: false, sentAt: 123456, text: 'Mixed media',
          files: [photo, { ...photo, id: 'c'.repeat(32), name: 'Second.png',
            preview: { id: '9'.repeat(32), mime: 'image/webp', size: atob(sizedPhotoPreview).length, width: 1, height: 1 } }, clip] },
        { position: 2, own: true, canEdit: true, sentAt: 123457, text: '',
          files: [{ ...photo, id: 'd'.repeat(32) }] },
        { position: 3, own: false, sentAt: 123458, text: 'Voice history', files: [
          { id: 'e'.repeat(32), name: 'Voice.webm', mime: 'audio/webm', size: 200, voice: { duration: 1, waveform: [0.2, 0.8] } },
        ] },
      ];
      return { value: { ...windowState(), messages: messages.filter(message => message.position > input.after && !test.protectedRemoved.includes(message.position)) } };
    }
    if(protectedMode==='poll-voting'||protectedMode==='public-poll')return{value:{...windowState(),messages:input.after ? [] : [
      {position:1,own:false,sentAt:123456,text:'Imported poll',poll:{options:['First option','Second option'],
        multiple:false,anonymous:protectedMode==='poll-voting',intermediate:false}},
    ]}};
    const messages = protectedMode === 'history' || protectedMode === 'pins' ? [
      {position:1,own:false,sentAt:123456,text:'Old history'},
      {position:2,own:true,canEdit:true,sentAt:123457,text:'Continuous admission',
        ...(protectedMode==='history' && {replyTo:test.historyFirst === 1 && !test.protectedRemoved.includes(1) ? 1 : null}),
        ...fixtureEdits.get(2)},
      {position:3,own:false,sentAt:123458,text:'A moderator can remove this'},
      {position:4,own:true,sentAt:123459,dedicatedDeletion:true,completedPoll:true,text:'Closed poll'},
      ...(protectedMode==='history' ? [{position:5,own:true,sentAt:123460,dedicatedDeletion:true,text:'Poll result'}] : []),
      ...(protectedMode==='history' ? [{position:6,own:true,canEdit:true,sentAt:123461,text:'Imported checklist',
        checklist:{everyone:true,items:[{id:checklistItem,text:'Test checklist item'}]},...fixtureEdits.get(6)}] : []),
    ].filter(message => message.position >= test.historyFirst && message.position > input.after &&
      !test.protectedRemoved.includes(message.position)) : [];
    return{value:{...windowState(),messages,...(messages.length>=4&&{next:messages.at(-1)?.position})}};
  }
  if(action==='gif.resolve' && protectedMode==='formatted-chat' && input.url==='https://giphy.com/gifs/synthetic-preview'){
    return {value:{url:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',mime:'image/gif'}};
  }
  if(action==='chat.protected.delete'){
    test.protectedRemoved.push(input.position);
    if(input.completedPoll && input.position===4)test.protectedRemoved.push(5);
    return{value:true};
  }
  if(action==='chat.protected.checklist'){
    if(input.change)protectedChecklistChecked=input.change.checked;
    return{value:{revision:protectedChecklistChecked?1:0,canCheck:true,checked:{[checklistItem]:protectedChecklistChecked}}};
  }
  if(action==='chat.protected.poll'){
    if(protectedMode==='public-poll')return{value:{closesAt:123458,closedAt:123458,multiple:false,anonymous:false,
      intermediate:false,canVote:false,canClose:false,counts:[1,0],total:1,own:[],
      voters:[test.pollVoterVisible?[{id:friend,name:'Visible voter'}]:[],[]]}};
    if(input.vote){protectedPollOwn=input.vote.choices;return{value:true};}
    if(input.close){protectedPollClosed=true;return{value:true};}
    return{value:{closesAt:Date.now()+5000,closedAt:protectedPollClosed?Date.now():null,multiple:false,anonymous:true,intermediate:false,
      canVote:!protectedPollClosed,canClose:!protectedPollClosed,counts:protectedPollClosed?[0,1]:[],
      total:protectedPollOwn.length?1:0,own:protectedPollOwn}};
  }
  if (hiddenOriginalFixture && action === 'chat.protected.attachment' && input.attachmentId === originalPoster) {
    if (test.historyFirst > 1) return {error: {code: 'PROTECTED_ACCESS_DENIED'}};
    const png = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5e8AAAAASUVORK5CYII=');
    return {value: Uint8Array.from(png, letter => letter.charCodeAt(0))};
  }
  if (protectedMode === 'attachment-grid' && action === 'chat.protected.attachment') {
    if (input.attachmentId === '9'.repeat(32)) {
      return {value: Uint8Array.from(atob(sizedPhotoPreview), letter => letter.charCodeAt(0))};
    }
    if (input.attachmentId === 'b'.repeat(32)) {
      await new Promise<void>(resolve => { test.releaseFullVideo = resolve; });
      return {value: new Uint8Array(8 * 1024 * 1024)};
    }
    if (input.attachmentId === 'd'.repeat(32) && !test.photoRetried) {
      test.photoRetried = true;
      return {error: {code: 'RATE_LIMIT', retryAfter: 1}};
    }
    const png = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5e8AAAAASUVORK5CYII=');
    return {value: Uint8Array.from(png, letter => letter.charCodeAt(0))};
  }
  if(action==='chat.protected.attachment')return{value:new Uint8Array([0x62,0x62])};
  if(action==='chat.protected.stageAttachment'){test.protectedUploads.push(input);return{value:'a'.repeat(32)};}
  if(action==='chat.protected.edit'){
    const revised={text:input.text,editedAt:123460,revision:input.expectedRevision+1,
      ...(input.checklist&&{checklist:input.checklist})};
    test.protectedEdits.push(input);
    fixtureEdits.set(input.position,revised);
    return{value:{revision:revised.revision}};
  }
  if(action==='chat.protected.edition')return{value:{position:input.position,sentAt:123457,own:true,canEdit:true,
    ...(protectedMode==='history' && {replyTo:test.historyFirst === 1 && !test.protectedRemoved.includes(1) ? 1 : null}),
    ...fixtureEdits.get(input.position)}};
  if(action==='chat.protected.pin'){
    if(input.pinned)fixturePins.add(input.position);
    else fixturePins.delete(input.position);
    return{value:true};
  }
  if(action==='chat.protected.pins')return{value:pinPage()};
  if(action==='chat.protected.pinnedMessage')return{value:fixturePins.has(input.position)&&input.position>=test.historyFirst
    ? oldPinFixture ? oldPinMessage : {position:input.position,sentAt:123457,own:true,text:'Continuous admission',...fixtureEdits.get(input.position)} : undefined};
  if (action === 'chat.protected.send') {
    test.protectedSends.push(input);
    if (test.holdProtectedSend) await new Promise<void>(resolve => { test.releaseProtectedSend = resolve; });
    if (test.protectedSendError) return { error: { code: test.protectedSendError } };
    return { value: { Position: 3, Existing: false } };
  }
  if(action==='invite.protected.list')return{value:{ invites: input.before ? [] : fixtureInvites,
    canCreate: protectedMode === 'inviter', next: input.before ? undefined : fixtureInvites.at(-1)?.id }};
  if(action==='invite.protected.create') {
    test.inviteRequests.push(['create', input]);
    const invite = { id: fixtureInvites.length.toString(16).padStart(32, '0'), creator: me, createdAt: inviteFixtureNow,
      expiresAt: input.expiresAt || inviteFixtureNow + 86_400_000, maxUses: input.maxUses, uses: 0, canRevoke: true };
    fixtureInvites.unshift(invite);
    return { value: { invite, link: 'synthetic-invitation-link' } };
  }
  if(action==='invite.protected.revoke') {
    test.inviteRequests.push(['revoke', input]);
    const invite = fixtureInvites.find(entry => entry.id === input.inviteId);
    if (invite) Object.assign(invite, { revokedAt: Date.now(), canRevoke: false });
    return { value: true };
  }
  if(action==='audit.protected.read')return{value:{retention:auditRetention,canChange:protectedMode==='owner',scope:'f'.repeat(64),cutoff:0,
    entries:[
      ...(protectedMode==='audit-proof'?[{at:Date.now(),actor:me,actorName:'Me',action:'channel.order',kind:'channel',objectId:cid,channelId:cid,
        change:{layoutDigest:'b'.repeat(64)}}]:[]),
      {at:Date.now(),actor:me,actorName:'Me',action:'message.delete',kind:'message',objectId:'24',position:24,channelId:cid,change:{}},
      ...(auditRetention===365?[{at:Date.now()-864000000,actor:me,actorName:'Me',action:'member.timeout',kind:'member',objectId:friend,
        objectName:'Friend',reason:'Older reason',change:{previous:0,current:Date.now()-863940000}}]:[]),
    ]}};
  if(action==='audit.protected.verifyOrder') {
    test.checkedOrder = structuredClone(input);
    return {value: input.channelId===cid && input.digest==='b'.repeat(64) && input.actor===me};
  }
  if(action==='audit.protected.retention'){
    test.auditChanges.push(input);
    auditRetention=input.days;
    return{value:true};
  }
  if(action==='moderation.protected.timeout.read'){
    const timeout=fixtureTimeouts.get(input.profileId);
    return{value:{deadline:0,...timeout,canSet:input.profileId!==me,canLift:!!timeout}};
  }
  if(action==='moderation.protected.timeout.change'){
    test.protectedTimeoutChanges.push(input);
    const deadline=input.durationSeconds===0?0:Date.now()+input.durationSeconds*1000;
    if(deadline)fixtureTimeouts.set(input.profileId,{deadline,reason:input.reason});
    else fixtureTimeouts.delete(input.profileId);
    return{value:{deadline,existing:false}};
  }
  if(action==='moderation.protected.member.change') {
    test.protectedMembershipChanges.push(input);
    if (input.action === 'ban') fixtureBans.set(input.profileId, input);
    if (input.action === 'unban') fixtureBans.delete(input.profileId);
    return {value:input.cleanupId ? {cleanup:'done',removed:2} : true};
  }
  if(action==='moderation.protected.cleanup.preview') {
    test.protectedCleanupPreview = input;
    return {value:{id:'a'.repeat(32),count:2}};
  }
  if(action==='moderation.protected.bans')return{value:{bans:[...fixtureBans.values()]}};
  if(action==='profile.protected.nickname.read')return{value:fixtureNicknames.get(input.profileId)};
  if(action==='community.protected.rename'){
    if(!protectedState.canEditCommunity)return{error:{code:'PROTECTED_ACCESS_DENIED'}};
    if(input.revision!==fixtureCommunity.revision)return{error:{code:'SERVER_NAME_CHANGED'}};
    fixtureCommunity={name:input.name,revision:fixtureCommunity.revision+1};
    return{value:fixtureCommunity};
  }
  if (action === 'community.protected.avatar') {
    if (!protectedState.canEditCommunity) return { error: { code: 'PROTECTED_ACCESS_DENIED' } };
    if (input.expectedRevision !== fixtureCommunityAvatar.revision) return { error: { code: 'SERVER_AVATAR_CHANGED' } };
    test.protectedAvatarUpdate = input;
    fixtureCommunityAvatar = { revision: fixtureCommunityAvatar.revision + 1, avatar: input.avatar ?? undefined };
    return { value: fixtureCommunityAvatar };
  }
  if(action==='profile.protected.nickname.change'){
    const current=fixtureNicknames.get(input.profileId);
    if(!current || current.revision!==input.revision)return{error:{code:'REVISION_CONFLICT'}};
    const value={name:input.name,revision:current.revision+1};
    fixtureNicknames.set(input.profileId,value);
    refresh({serverId:sid,nickname:{profileId:input.profileId,name:value.name}});
    return{value};
  }
  if(action==='roster.protected.read' && protectedMode==='roster-pagination'){
    test.rosterPageRequests.push(input.after);
    const last=fixtureNicknames.get(friend)!;
    const nicknameDigest=(last.revision?'b':'a').repeat(64);
    const roles=[{id:'@everyone'}];
    if(input.after)return{value:{revision:1,channelId:input.channelId,nicknameDigest,members:[{id:friend,name:last.name,roles}]}};
    const members=Array.from({length:64},(_,i)=>({id:i.toString(16).padStart(64,'0'),name:'Member '+i,roles}));
    return{value:{revision:1,channelId:input.channelId,nicknameDigest,members,next:members[63].id}};
  }
  if(action==='roster.protected.read')return{value:{revision:1,channelId:input.channelId,roleColors:{crew:'#5a89bc'},members:[
    {id:me,name:fixtureNicknames.get(me)?.name,roles:[{id:'@everyone'}],canEditNickname:channelManagerFixture,
      ...(protectedMode === 'membership-moderator' && { presence: 'online' })},
    {id:friend,name:protectedMode === 'public-poll' ? 'Visible voter' : fixtureNicknames.get(friend)?.name,
      groupId:'featured',groupRank:1,color:'#5a89bc',canEditNickname:channelManagerFixture,
    ...((input.voice || ['formatted-chat', 'public-poll', 'inviter', 'invite-viewer'].includes(protectedMode ?? '') || test.explicitAdminView || test.previewRosterAvatar) &&
      { avatar: fixtureCommunityAvatar.avatar }),
      ...(protectedMode === 'membership-moderator' && { canKick:true, canBan:true, presence: 'away' }),
      ...(protectedState.canAssignRoles && { canAssignRoles:true }),
      roles:[{id:'featured',name:'Featured'},{id:'member',name:'Community',icon:'🐾'},{id:'@everyone'}]},
    ...(!input.channelId?[{id:'e'.repeat(64),name:'Other channel',roles:[{id:'@everyone'}]}]:[]),
    ...(protectedMode === 'membership-moderator'
      ? [{id:'f'.repeat(64),name:'Offline member',presence:'offline',roles:[{id:'@everyone'}]}] : []),
  ]}};
  if(action==='roles.scoped.basis')return{value:{revision:test.scopedRoleRevision ?? 1,
    policyHead:(test.scopedRoleRevision === 2 ? '8' : '9').repeat(64),...(input.profileId ? {roles:[
    {id:'member',name:'Community',assigned:true,canAssign:false},{id:'reader',name:'Reader',assigned:false,canAssign:true},
  ]} : {grantOptions:['channel.view'],roles:[
    {id:'@everyone',grants:['channel.view'],color:'',icon:'',hoist:false,mentionable:false},
    {id:'member',name:test.scopedRoleRevision === 2 ? 'Members' : 'Community',
      grants:['channel.view'],color:test.scopedRoleRevision === 2 ? '#305080' : '',icon:'',hoist:false,mentionable:false},
  ]})}};
  if(action==='roles.scoped.preview') {
    test.scopedRolePreviews = (test.scopedRolePreviews ?? 0) + 1;
    if(input.revision !== (test.scopedRoleRevision ?? 1)) return {error:{code:'PROTECTED_POLICY_CHANGED'}};
    channelDraft=structuredClone(input);
    return{value:{previewId:'e'.repeat(32),scopedImpact:[{id:cid,keyUpdate:true,viewAdded:1,viewRemoved:0,fullHistoryAdded:0,fullHistoryRemoved:0}]}};
  }
  if(action==='roles.scoped.commit') {
    if (test.changeScopedRoleOnCommit) { test.scopedRoleRevision = 2; test.changeScopedRoleOnCommit = false; }
    if(channelDraft?.revision !== (test.scopedRoleRevision ?? 1)) return {error:{code:'PROTECTED_POLICY_CHANGED'}};
    if (test.loseScopedRoleReply) {
      test.loseScopedRoleReply = false;
      return {error:{code:'ECONNRESET'}};
    }
    test.protectedChanges.push({confirmation:structuredClone(input),draft:channelDraft});
    return {value:true};
  }
  if(action==='channel.protected.manage'&&input.orderOnly===true)return{value:{revision:1,siblings:[{id:'3'.repeat(32),name:'Meetings'}]}};
  if(action==='channel.protected.manage')return{value:input.channelId?{revision:1,kind:'text',
    settings:{Name:'General',Description:'',SlowmodeSeconds:15,VoiceCapacity:0},synchronized:true,
    roles:[{id:'@everyone'}, ...(test.explicitAdminView ? [{id:'reader',name:'Reader',color:'#5a89bc'}] : [])],rules:{},
    categories, totalChannels:test.protectedTotalChannels, siblings:[{id:'3'.repeat(32), name:'Meetings'}],
    ...(input.personal && {profiles:[{id:friend,name:'Friend'},
      ...(test.explicitAdminView ? [{id:me,name:'Me',explicitViewOnly:true}] : [])],profileRules:{}})}:{revision:1,categories,
      ...(input.creationAccess && {roles:[{id:'member',name:'Reader'}],profiles:[{id:friend,name:'Friend'}]})}};
  if(action==='channel.protected.preview'){channelDraft=structuredClone(input);
    if(input.action==='channel.move')test.protectedMovePreviews.push(channelDraft);
    if(input.action==='channel.copy')test.protectedCopyPreviews.push(channelDraft);
    return{value:{previewId:'e'.repeat(32),
    ...(input.action==='channel.acl.personal'&&{impact:accessImpact}),
    ...(input.action==='channel.move'&&{impact:channelDelta})}};}
  if(action==='channel.protected.commit'){
    test.protectedChanges.push({confirmation:structuredClone(input),draft:channelDraft});
    if(channelDraft?.action==='channel.copy'){
      const source=protectedState.channels.find(channel=>channel.id===channelDraft?.channelId);
      if(!source)return{error:{code:'PROTECTED_ACCESS_DENIED'}};
      const channelId='a'.repeat(32);
      protectedState.channels.push({...source,id:channelId,name:'New channel'});
      return{value:{channelId}};
    }
    if(protectedMode==='editor'&&channelDraft?.action==='channel.order') {
      const first = protectedState.channels.shift();
      if(first) protectedState.channels.splice(1,0,first);
    }
    return{value:{channelId:cid}};
  }
  if(action==='role.protected.manage')return{value:{revision:1,roles:[
    {id:'@everyone',grants:['channel.view'],color:'',icon:'',hoist:false,mentionable:false,assigned:0},
    {id:'member',name:'Legacy name',grants:['channel.view'],color:'#5a89bc',icon:'🐾',hoist:false,mentionable:false,assigned:2},
    {id:'administrator',name:'Administrator',grants:['server.administrator'],color:'',icon:'',hoist:false,mentionable:false,assigned:1},
  ]}};
  if(action==='role.protected.preview'){channelDraft=structuredClone(input);return{value:{previewId:'f'.repeat(32)}};}
  if(action==='role.protected.view'){
    const administrator = input.roles.includes('administrator');
    return{value:{
      canManageChannels: administrator,
      categories: administrator ? protectedState.categories : [{id:'category',name:'General category'}],
      channels:protectedState.channels.filter(channel=>channel.categoryId === 'category' || administrator)
        .map(channel=>({...channel,canSend:administrator,canAttach:administrator,canConnect:administrator,
          members:[{id:friend,name:'Friend'}]})),
    }};
  }
  if(action==='role.protected.members-preview'){
    if(test.assignmentRequiresRecovery)return{error:{code:'PROTECTED_RECOVERY_REQUIRED',recoveryProfiles:[friend]}};
    channelDraft=structuredClone(input);return{value:{previewId:'d'.repeat(32),impact:{
      administrator:{added:0,ready:0,removed:0},changedChannels:1,keyChannels:1,
      details:[{id:cid,name:'General',beforeView:1,afterView:2,beforeHistory:1,afterHistory:1}],
    }}};
  }
  if(action==='role.protected.commit'){test.protectedChanges.push({confirmation:structuredClone(input),draft:channelDraft});return{value:{roleId:'member'}};}
  if(action==='member.protected.roles')return{value:{revision:1,profiles:[{id:friend,name:'Friend',roles:[]}],
    roles:[{id:'member',name:'Legacy name'}]}};
  if(action==='member.protected.roles.preview'){
    if(test.assignmentRequiresRecovery)return{error:{code:'PROTECTED_RECOVERY_REQUIRED',recoveryProfiles:[friend]}};
    channelDraft=structuredClone(input);return{value:{previewId:'d'.repeat(32),impact:accessImpact}};
  }
  if(action==='member.protected.roles.commit'){test.protectedChanges.push({confirmation:structuredClone(input),draft:channelDraft});return{value:{profileId:friend}};}
  if(action==='category.protected.manage')return{value:{revision:1,totalChannels:2,profiles:[{id:friend,name:'Friend'}],roles:[{id:'@everyone'}],
    categories:categories.map(category=>({...category,children:category.id==='category'?2:0,rules:{Roles:null,Profiles:null}}))}};
  if(action==='category.protected.preview'){channelDraft=structuredClone(input);return{value:{previewId:'a'.repeat(32)}};}
  if(action==='category.protected.commit'){
    test.protectedChanges.push({confirmation:structuredClone(input),draft:channelDraft});
    if(channelDraft?.action==='category.create'){
      const category={id:'8'.repeat(32),name:channelDraft.name};
      protectedState.categories.push(category);
      categories.push(category);
      return{value:{categoryId:category.id}};
    }
    return{value:{categoryId:'category'}};
  }
  if(action==='channel.order'){
   test.reorders.push(structuredClone(input));
   const items=input.items.map((item:any)=>state.channels.find(channel=>channel.id===item.id)!);
   state.channels=[...state.channels.filter(channel=>channel.kind!==input.kind),...items];refresh();return{value:true};
  }
  if(action==='notify'){test.desktopNotifications.push(input);return{value:true};}
  if(action==='notify.read'){test.notificationReads.push(input);return{value:true};}
  if(action==='messages'){
   const options=input.options||{},limit=options.limit||100;test.messageReads.push(structuredClone(options));
   if(test.messageDelay&&options.limit!==1)await new Promise(resolve=>setTimeout(resolve,test.messageDelay));
   let eligible=records.filter(record=>(!options.before||record.id<options.before)&&(!options.after||record.id>options.after));
   if(options.ids)eligible=eligible.filter(record=>options.ids.includes(record.id));
   if(options.around){const at=eligible.findIndex(record=>record.id>=options.around);eligible=eligible.slice(Math.max(0,at-Math.floor(limit/2)));}
   const page=options.ids||options.after||options.around?eligible.slice(0,limit):eligible.slice(-limit);
   return{value:{messages:structuredClone(page),first:records[0]?.id||0,last:records.at(-1)?.id||0,hasOlder:page[0]?.id>records[0]?.id,hasNewer:page.at(-1)?.id<records.at(-1)?.id,unread:records.filter(record=>record.id>(options.readAfter||0)&&record.authorProfileId!==me).length}};
  }
  return{value:true};
 },
 onMembershipChanged:(listener:(event?: FixtureMembershipChange)=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},onMembershipVoiceLost:noop,
 onMembershipProtectedEvent:(listener:(event: FixtureProtectedEvent) => void)=>{
   protectedEventListeners.add(listener);
   return () => protectedEventListeners.delete(listener);
 },
 onMembershipOpenChannel:(listener: NonNullable<typeof openChannelListener>) => {
   openChannelListener = listener;
   return () => { openChannelListener = undefined; };
 },
 windowActive:async()=>true,onWindowActive:(listener:typeof activeListener)=>{activeListener=listener;return()=>{activeListener=()=>{};};},
 pendingInvitation:async()=>'',onInvitation:noop,hostStatus:async()=>({running:false}),onHostChanged:noop,
 capabilities:async()=>({native:false,platform:'win32',packaged:false,secureStorage:true}),configureKeys:async()=>({native:false,failed:[]}),onPtt:noop,onAction:noop,onSuspend:noop,duck:async()=>{},updateState:async()=>({status:'idle'}),onUpdate:noop,
};
test.setWindowActive=(active:boolean)=>activeListener(active);
test.addMessages=async(count=1,own=false)=>{for(let i=0;i<count;i++){const id=(records.at(-1)?.id||0)+1;records.push({id,channelId:cid,authorProfileId:own?me:friend,requestId:id.toString(16).padStart(32,'0'),sentAt:Date.now(),content:{text:'New message '+id}});}channel.lastMessageId=records.at(-1).id;channel.messageRevision++;state.revision++;refresh();};
test.refresh=refresh;
test.addMention=()=>{const id=(records.at(-1)?.id||0)+1;records.push({id,channelId:cid,authorProfileId:friend,requestId:id.toString(16).padStart(32,'0'),sentAt:Date.now(),content:{text:'Hello @Me',mentions:[{profileId:me,start:6,end:9}]}});channel.lastMessageId=id;channel.messageRevision++;refresh();};

test.setupReorder=()=>{
 test.reorderMode=true;state.self.role='admin';
 state.channels.push(...(['voice','text'] as const).flatMap(kind=>Array.from({length:3},(_,i)=>({id:kind+i,kind,name:kind+' '+i,protected:false,revision:1,messageRevision:1,lastMessageId:0}))));
 serverRecords.push(...Array.from({length:2},(_,i)=>({serverId:String(i+4).repeat(32),name:'Synthetic server '+i,address:'https://127.0.0.1:18443',status:'online'})));
 refresh();
};
test.reorders=[];
test.addServer=()=>{serverRecords.push({serverId:'3'.repeat(32),name:'Synthetic second server',address:'https://127.0.0.1:18443',status:'online'});refresh();};
test.setConnected=(value:boolean)=>{online=value;refresh();};
test.setChatVisible=(visible:boolean)=>{(document.querySelector(visible?'.member-server-list button':'.member-home') as HTMLButtonElement)?.click();};
test.setCovered=(covered:boolean)=>{(document.querySelector(covered?'.member-rail-settings':'dialog .modal-heading button') as HTMLButtonElement)?.click();};
test.muteServer=(muted:boolean)=>{if(muted)localStorage.setItem('pawtalk.v2.mute.'+sid,String(Date.now()+60000));else localStorage.removeItem('pawtalk.v2.mute.'+sid);};
test.audioPlays = [];
const audioNodes: {source:AudioBufferSourceNode;gain?:GainNode;ended:boolean}[] = [];
test.soundState = (index:number) => ({ended:audioNodes[index].ended,gain:audioNodes[index].gain?.gain.value});
const soundGains = new WeakMap<AudioNode, GainNode>();
const connect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (...args: any[]) {
  if (this instanceof AudioBufferSourceNode && args[0] instanceof GainNode) soundGains.set(this, args[0]);
  return (connect as any).apply(this, args);
} as typeof connect;
const start = AudioBufferSourceNode.prototype.start;
AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
  const node={source:this,gain:soundGains.get(this),ended:false};
  audioNodes.push(node);
  this.addEventListener('ended',()=>{node.ended=true;});
  test.audioPlays.push({ offset:args[1]??0, seconds: this.buffer?.duration, channels: this.buffer?.numberOfChannels, sink: (this.context as AudioContext & { sinkId: string }).sinkId, gain: soundGains.get(this)?.gain.value });
  return start.apply(this, args);
};
test.playSound = (event: 'join' | 'leave' | 'message', overrides = {}) => playSound(event, { ...defaults, ...overrides });

Object.defineProperty(test,'notifications',{get:()=>test.audioPlays.length});
const root=createRoot(document.getElementById('root')!);root.render(<ServerApp/>);test.ready=true;
test.populatePeople=()=>{state.voice=Array.from({length:12},(_,i)=>({profileId:friend,deviceId:String(i).padStart(64,'0'),channelId:'voice0',identity:String(i).padStart(32,'0')})) as any;refresh();};
test.emitDeparture=(kind:string,expiresAt?:number|null)=>{
  if (kind === 'device-revoked' || kind === 'profile-unlinked') serverRecords.splice(0, 1);
  listeners.forEach(listener=>(listener as any)({departure:{serverId:sid,name:'Synthetic notice server',kind,expiresAt}}));
};
test.setRole=(role:string)=>{state.self.role=role;refresh();};
test.renderDevices=()=>root.render(<DevicesDialog state={{...state}} onClose={()=>{}} onRefresh={()=>{test.renderDevices();}}/>);
test.openDevices=(primary:boolean)=>{state.devices=[{id:'c'.repeat(64),label:'This PC',primary,originalProfileId:me},{id:'d'.repeat(64),label:'Other PC',primary:!primary,originalProfileId:friend}] as any;test.renderDevices();};
test.openLink=()=>{state.devices=[{id:'c'.repeat(64),label:'This PC',primary:true,originalProfileId:me}] as any;root.render(<LinkDialog state={{...state}} nickname="Me" onClose={()=>{}} onJoined={()=>{}}/>);};
