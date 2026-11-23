import {notificationAvatar} from './notificationAvatar';
import {loadPeerAudio,savePeerAudio,projectPeerAudio,type PeerAudio} from './peerAudio.mjs';
import { HomeScreen } from './HomeScreen';
import {ServerAvatarDialog, type AvatarServer} from './ServerAvatarDialog';
import { AvatarStrip } from './ui/AvatarStrip';
import { useReorderDrag, setTransparentDragImage } from './ui/useReorderDrag';
import { AudioStatusIcons } from './ui/AudioStatusIcons';
import { Button } from './ui/Button';
import { ProtectedNicknameDialog } from './ProtectedNicknameDialog';
import { ProtectedServerProfile } from './ProtectedServerProfile';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionStatus } from './ConnectionStatus';
import { Avatar } from './Avatar';
import { AudioQuickMenu } from './AudioQuickMenu';
import { Icon } from './Controls';
import { BansDialog, DevicesDialog, InvitationDialog, LinkDialog } from './MemberDialogs';
import { MemberSettings } from './MemberSettings';
import { Modal } from './Modal';
import { Participants } from './Participants';
import { RoomSplit } from './RoomSplit';
import { ServerChat } from './ServerChat';
import { ServerVoicePreview } from './ServerVoicePreview';
import { VoiceSession, type Snapshot, type ProtectedVoiceTransport } from './session';
import { ProtectedChat, ProtectedChatPreview, ProtectedHistoryLoading, type ProtectedChatCache, type ProtectedDraft } from './ProtectedChat';
import { ProtectedRoleViewToolbar, useRoleView, type RoleViewRequest, type RoleViewSession } from './ProtectedRoleView';
import { ProtectedTextStatus, ProtectedVoiceStatus, useProtectedTextStatus } from './ProtectedTextStatus';
import { voiceRestrictionLabel, type VoiceRestrictionChoice } from './ProtectedVoiceRestrictionControls';
import { ProtectedChannelDialog } from './ProtectedChannelDialog';
import { ProtectedChannelDeleteDialog } from './ProtectedChannelDeleteDialog';
import { ProtectedScopedChannelSettingsDialog } from './ProtectedScopedChannelSettingsDialog';
import { ProtectedChannelACLDialog } from './ProtectedChannelACLDialog';
import { ProtectedPersonalACLDialog } from './ProtectedPersonalACLDialog';
import { ProtectedRolesDialog, ProtectedRolesSettings, type RoleEditorEntry } from './ProtectedRolesDialog';
import { ProtectedAssignmentsDialog, type ScopedAssignmentTarget } from './ProtectedAssignmentsDialog';
import { ProtectedCategoriesDialog } from './ProtectedCategoriesDialog';
import { ProtectedChannelList } from './ProtectedChannelList';
import { ProtectedRoster, type ChatAuthorRoster } from './ProtectedRoster';
import { useProtectedProfileAppearances } from './useProtectedProfileAppearances';
import { MemberRosterPanel } from './MemberRosterPanel';
import { setMemberDrag } from './memberMention';
import { ProtectedTimeoutDialog } from './ProtectedTimeoutDialog';
import { ProtectedAuditDialog } from './ProtectedAuditDialog';
import { ProtectedInvitesDialog } from './ProtectedInvitesDialog';
import { RecoverDeviceDialog, RecoverySetupDialog } from './ProtectedRecoveryDialogs';
import { ProtectedOwnershipDialog } from './ProtectedOwnershipDialog';
import { ApproveProtectedDeviceDialog, RequestProtectedDeviceDialog } from './ProtectedDeviceBindingDialogs';
import { ProtectedOwnDeviceList } from './ProtectedOwnDeviceList';
import { ProtectedLinkedProfilesDialog, ProtectedProfileLinkDialog } from './ProtectedProfileLinkDialogs';
import { ProtectedScopeHandoverDialog } from './ProtectedScopeHandoverDialog';
import { ProtectedBansDialog, ProtectedMemberModeration } from './ProtectedModerationDialogs';
import { loadSettings, remember, type Settings } from './settings';
import { playSound } from './sounds';
import { UpdateNotice } from './UpdateNotice';
import { HostPanel } from './HostPanel';
import { StandaloneMigrationDialog } from './StandaloneMigrationDialog';
import { avatarStorageKey, validAvatar } from './avatarImage';
import { t, useLanguage } from './i18n';
import { channelMuteKey, isChannelMuted, notificationsMuted, cursorKey, effectiveProfile, isServerMuted, isProtectedServerState,
  isMembershipConnectionUnavailable, membership, profileFor, storedJSON, type Channel, type Message, type MessagePage, type ServerRecord,
  type ServerState, type ProtectedServerState } from './membership';
import { ContextMenu, type MenuItem } from './ContextMenu';
import './membership.css';

type VoiceSidebarTarget = { serverId: string; sourceChannelId: string; targetSessionId: string };
const voiceParticipantDragType = 'application/x-pawtalk-voice-participant';


type ServerSettingsTab = 'profile' | 'members' | 'roles' | 'invites' | 'audit' | 'bans' | 'devices' | 'access';
const serverSettingsLabels = {
  profile: 'Профиль сервера', members: 'Участники', roles: 'Роли',
  invites: 'Приглашения', audit: 'Журнал аудита', bans: 'Баны', devices: 'Профиль и устройства', access: 'Доступ к серверу',
} satisfies Record<ServerSettingsTab, string>;
const serverSettingsIcons: Record<ServerSettingsTab, string> = {
  profile: 'user', members: 'users', roles: 'shield', invites: 'invite',
  audit: 'list', bans: 'ban', devices: 'devices', access: 'lock',
};
const emptyVoice: Snapshot = { state: 'disconnected', people: [], db: -100, speaking: false };
type ProtectedMentionAlert = { channelId: string; position: number; kind: 'direct' | 'group' };
function protectedNotificationPrefs(state: ProtectedServerState) {
  return { serverId: state.serverId, serverMuted: isServerMuted(state.serverId),
    mutedChannels: state.channels.filter(channel => channel.kind === 'text' && isChannelMuted(state.serverId, channel.id)).map(channel => channel.id) };
}
export function ServerApp() {
  useLanguage();
  const [protectedStates, setProtectedStates] = useState<Record<string, ProtectedServerState>>({});
  const [offlineProtectedServers, setOfflineProtectedServers] = useState<Record<string, true>>({});
  const [protectedChannelIds, setProtectedChannelIds] = useState<Record<string, string>>({});
  const [protectedDrafts, setProtectedDrafts] = useState<Record<string, ProtectedDraft>>({});
  const [protectedChannelDialog, setProtectedChannelDialog] = useState<{
    serverId: string; channel?: ProtectedServerState['channels'][number]; orderOnly?: boolean; initialMoveCategoryId?: string;
    initialCategoryId?: string; initialKind?: 'text' | 'voice'; initialAction?: 'channel.copy';
  }>();
  const [protectedDeleteChannel, setProtectedDeleteChannel] = useState<{
    serverId: string; channel: ProtectedServerState['channels'][number];
  }>();
  const [protectedDrag, setProtectedDrag] = useState<{ serverId: string; channelId: string }>();
  const protectedOrderPending = useRef(false);
  const [favoriteChannels, setFavoriteChannels] = useState(() => storedJSON<Record<string, boolean>>('pawtalk.protected.favorites', {}));
  const [scopedACL, setScopedACL] = useState<{ serverId: string; channelId: string }>();
  const [scopedPersonalACL, setScopedPersonalACL] = useState<{ serverId: string; channelId: string; profileId?: string; profileName?: string }>();
  const [scopedChannelSettings, setScopedChannelSettings] = useState<{
    serverId: string; channel: ProtectedServerState['channels'][number];
  }>();
  const [protectedRolesServer, setProtectedRolesServer] = useState('');
  const [serverSettings, setServerSettings] = useState<{ serverId: string; tab: ServerSettingsTab }>();
  const [migrationServers, setMigrationServers] = useState<Record<string, boolean>>({});
  const [migrationDialog, setMigrationDialog] = useState<string>();
  const [roleEditor, setRoleEditor] = useState<{ roleId?: string; sourceChannelId?: string; entry?: RoleEditorEntry }>();
  const [roleViewSession, setRoleViewSession] = useState<RoleViewSession>();
  const [roleViewChannelId, setRoleViewChannelId] = useState('');
  const [roleViewTextId, setRoleViewTextId] = useState('');
  const [roleViewRoster, setRoleViewRoster] = useState(true);
  const [roleFooter, setRoleFooter] = useState<HTMLDivElement | null>(null);
  const [createdChannelRole, setCreatedChannelRole] = useState<{ channelId: string; roleId: string }>();
  const [roleListVersion, setRoleListVersion] = useState(0);
  const [protectedAssignmentsServer, setProtectedAssignmentsServer] = useState('');
  const [scopedAssignment, setScopedAssignment] = useState<(ScopedAssignmentTarget & { serverId: string })>();
  const [protectedCategories, setProtectedCategories] = useState<{
    serverId: string; target?: { id: string; name: string; mode: 'edit' | 'delete' };
  }>();
  const [protectedMembersServer, setProtectedMembersServer] = useState('');
  const [nicknameServer, setNicknameServer] = useState('');
  const [timeoutTarget, setTimeoutTarget] = useState<{ serverId: string; profileId: string; name: string }>();
  const [pendingVoiceAudio, setPendingVoiceAudio] = useState<{ serverId: string; channelId: string; prefs: PeerAudio }>();
  const voiceParticipantDrag = useRef<{ target: VoiceSidebarTarget; choices: Promise<string[]>; destinations?: string[] }>(undefined);
  const [voiceDropChannel, setVoiceDropChannel] = useState<string>();
  const [servers, setServers] = useState<ServerRecord[]>([]), [states, setStates] = useState<Record<string, ServerState>>({}), [selected, setSelected] = useState(''), [chatIDs, setChatIDs] = useState<Record<string, string>>(()=>storedJSON('pawtalk.v2.channels',{}));
  const [homeAvatar,setHomeAvatar]=useState(()=>{const value=localStorage.getItem(avatarStorageKey)||'';return validAvatar(value)?value:undefined;});
  const [onboarding,setOnboarding]=useState(()=>localStorage.getItem('pawtalk.onboarding')==='pending'||(!localStorage.getItem('pawtalk.onboarding')&&!localStorage.getItem('pawtalk.nickname')));
  const onboardingActive=useRef(onboarding);onboardingActive.current=onboarding;
  useEffect(()=>{if(onboarding)localStorage.setItem('pawtalk.onboarding','pending');},[onboarding]);
  const [avatarServer,setAvatarServer]=useState<AvatarServer>();
  const [idle,setIdle]=useState(false);
  useEffect(()=>{let alive=true;const poll=()=>void membership<{away:boolean}>('activity').then(value=>{if(alive)setIdle(value.away);}).catch(()=>{});poll();const timer=setInterval(poll,5000);return()=>{alive=false;clearInterval(timer);};},[]);
  const [openLinkID,setOpenLinkID]=useState('');
  const [incomingLink,setIncomingLink]=useState<{linkId:string;serverId:string}>();
  useEffect(()=>{let alive=true,pending=false;async function poll(){if(pending)return;pending=true;try{const links=await membership<{linkId:string;serverId:string}[]>('link.pending');if(alive)setIncomingLink(links[0]);}catch{}finally{pending=false;}}void poll();const timer=setInterval(()=>void poll(),2000),off=window.desktop?.onMembershipServerEvent?.(event=>{if(event.type!=='chat')void poll();});return()=>{alive=false;clearInterval(timer);off?.();};},[]);
  const [departures,setDepartures]=useState<{serverId:string;name:string;kind:'kick'|'ban'|'device-revoked'|'profile-unlinked';expiresAt?:number|null;reason?:string}[]>([]);
  const [protectedModeration, setProtectedModeration] = useState<{serverId: string; profileId: string; name: string; action: 'kick' | 'ban'}>();
  const [roster, setRoster] = useState(() => localStorage.getItem('pawtalk.v2.roster') !== 'hidden'), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<'join'|'invite'|'protected-invites'|'protected-bans'|'protected-ownership'|'protected-profile-link'|'protected-linked-profiles'|'protected-scope-handover'|'device-bind-request'|'recovery-setup'|'recover-device'|'link'|'devices'|'bans'|'settings'|'create'|'host-share'|null>(onboarding?'settings':null), [address, setAddress] = useState(''), [linkText, setLinkText] = useState(''), [nickname, setNickname] = useState(() => localStorage.getItem('pawtalk.nickname') || t('Гость'));
  const [recoveryServer, setRecoveryServer] = useState<ServerRecord>();
  const [ownershipServer, setOwnershipServer] = useState<ServerRecord & { profileId: string }>();
  const [bindingServer, setBindingServer] = useState<ServerRecord>();
  const [profileLinkServer, setProfileLinkServer] = useState<ServerRecord & { profileId: string }>();
  const [settings, setSettings] = useState(loadSettings), [snapshot, setSnapshot] = useState(emptyVoice), [voice, setVoice] = useState<{ serverId: string; channelId: string }>(), [audioState, setAudioState] = useState({muted:false,deafened:false});
  const {muted,deafened}=audioState;
  const toggleMic=useCallback(()=>setAudioState(value=>value.deafened?{muted:false,deafened:false}:{muted:!value.muted,deafened:false}),[]);
  const toggleSound=useCallback(()=>setAudioState(value=>value.deafened?{muted:false,deafened:false}:{muted:true,deafened:true}),[]);
  const [native, setNative] = useState(false), [keyError, setKeyError] = useState(''), [devices, setDevices] = useState<MediaDeviceInfo[]>([]), [hostRunning, setHostRunning] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; anchor?: HTMLElement }>(), [muteServer, setMuteServer] = useState<string>(),[muteChannel,setMuteChannel]=useState<{serverId:string;channelId:string}>(), [leaveServer, setLeaveServer] = useState<ServerRecord>();
  const [addressServer, setAddressServer] = useState<ServerRecord>();
  const [renameServer,setRenameServer]=useState<{serverId:string;name:string}>(),[serverName,setServerName]=useState('');
  const [preview,setPreview]=useState<{serverId:string;anchor:{right:number;top:number}}>();
  const [sidebarWidth,setSidebarWidth]=useState(()=>{const value=Number(localStorage.getItem('pawtalk.v2.sidebar-width'));return Number.isFinite(value)&&value>=220&&value<=440?value:272;});
  const [windowWidth,setWindowWidth]=useState(innerWidth),resizeOffset=useRef(0);
  const maxSidebar=Math.max(220,Math.min(440,windowWidth-74-(roster&&selected?(windowWidth<=1000?190:232):0)-360-6));
  const sidebarPixels=Math.min(sidebarWidth,maxSidebar);
  useEffect(()=>{const resize=()=>{setWindowWidth(innerWidth);setPreview(undefined);};window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  useEffect(()=>{localStorage.setItem('pawtalk.v2.sidebar-width',String(sidebarWidth));},[sidebarWidth]);
  const [channelDialog, setChannelDialog] = useState<{ kind: 'text'|'voice'; channel?: Channel; deleting?: boolean }>(), [channelName, setChannelName] = useState('');
  const [moderation, setModeration] = useState<{ profileId: string; mode: 'role'|'kick'|'ban' }>(), [role, setRole] = useState('member'), [banDuration, setBanDuration] = useState('3600000');
  const [mentionIDs,setMentionIDs]=useState<Record<string,number[]>>({});
  const protectedActivity = useRef(new Map<string, number>());
  const protectedUnread = useRef(new Map<string, Set<number>>());
  const nextActivityPoll = useRef(new Map<string, number>());
  const [unread, setUnread] = useState<Record<string, number>>({}), [focused, setFocused] = useState(true), [prefsVersion, updatePrefs] = useState(0), [peerAudio,setPeerAudio]=useState(()=>loadPeerAudio(localStorage));
  const savedPeerAudio = useRef(peerAudio);
  const saveAudioPreferences = useCallback((patch: PeerAudio) => {
    const next = { ...savedPeerAudio.current, ...patch };
    savedPeerAudio.current = next;
    setPeerAudio(next);
    try { savePeerAudio(localStorage, next); }
    catch { setError(t('Не удалось сохранить громкость участника.')); }
  }, []);
  const contentFocused=focused&&!avatarServer&&!bindingServer&&!incomingLink&&!departures.length&&!modal&&!channelDialog&&!moderation&&!leaveServer&&!muteServer&&!muteChannel&&!addressServer&&!renameServer;
  const controller = useRef<VoiceSession | undefined>(undefined), current = useRef({ settings, servers, states, selected, chatIDs, protectedChannelIds, protectedStates, focused:contentFocused, deafened, voice }); current.current = { settings, servers, states, selected, chatIDs, protectedChannelIds, protectedStates, focused:contentFocused, deafened, voice };
  const mentionCache=useRef(new Map<string,Message[]>()),rescan=useRef(new Map<string,number>()),refreshAgain=useRef(false),soundAt=useRef(0);
  const seen = useRef(new Map<string, { revision: number; last: number; read?:number }>()), polling = useRef(false), mounted = useRef(true), joiningVoice = useRef(false);
  const voiceAttempt=useRef(0),pendingVoiceServer=useRef('');
  const periodicRefreshAt=useRef(0),notificationsRetry=useRef(false),deliveries=useRef(new Map<string,import('./membership').ServerEvent[]>()),knownUnread=useRef(new Map<string,number>()),deliveryGaps=useRef(new Map<string,number>());
  const viewports=useRef(new Map<string,boolean>());
  const notificationReads=useRef(new Map<string,number>());
  const protectedAlertsSeen = useRef(new Map<string, number>());
  useEffect(() => {
    for (const state of Object.values(current.current.protectedStates)) {
      void membership('chat.protected.muteNotifications', protectedNotificationPrefs(state)).catch(() => {});
    }
  }, [prefsVersion]);
  function acknowledgeNotifications(serverId:string,channelId:string,messageId:number){const key=serverId+':'+channelId;if(messageId<1||(notificationReads.current.get(key)||0)>=messageId)return;notificationReads.current.set(key,messageId);if(notificationReads.current.size>2048)notificationReads.current.delete(notificationReads.current.keys().next().value!);void membership('notify.read',{serverId,channelId,messageId}).catch(()=>{if(notificationReads.current.get(key)===messageId)notificationReads.current.delete(key);});}
  const hiddenVoice=useRef(new Map<string,string>());
  const [serverOrder,setServerOrder]=useState<string[]>(()=>storedJSON('pawtalk.v2.server-order',[]));
  const orderRef=useRef(serverOrder);orderRef.current=serverOrder;
  const reportedConnectionErrors=useRef(new Map<string,string>());
  const state = states[selected], record = servers.find(server => server.serverId === selected), chat = state?.channels.find(channel => channel.id === chatIDs[selected] && channel.kind === 'text') || state?.channels.find(channel => channel.kind === 'text');
  const lastProtectedState = protectedStates[selected];
  const protectedChatCache = useRef<ProtectedChatCache>(new Map());
  const [protectedChatProfiles, setProtectedChatProfiles] = useState<ChatAuthorRoster>();
  const [protectedOwnProfiles, setProtectedOwnProfiles] = useState<Record<string, {
    profileId: string; name: string; avatar?: string;
  }>>({});
  const protectedProfilesChanged = useCallback((profiles: NonNullable<typeof protectedChatProfiles>) => {
    setProtectedChatProfiles(profiles);
    const profileId = current.current.protectedStates[profiles.serverId]?.profileId;
    const ownProfile = profileId && profiles.names.get(profileId);
    if (!ownProfile || !profileId) return;
    setProtectedOwnProfiles(previous => {
      const own = previous[profiles.serverId];
      if (own?.profileId === profileId && own.name === ownProfile.name && own.avatar === ownProfile.avatar) return previous;
      return { ...previous, [profiles.serverId]: { profileId, ...ownProfile } };
    });
  }, []);
  const protectedRefreshAt = useRef(new Map<string, number>());
  const protectedOffline = !!lastProtectedState && !!offlineProtectedServers[selected];
  const protectedState = useMemo<ProtectedServerState | undefined>(() => {
    if (!protectedOffline || !lastProtectedState) return lastProtectedState;
    const { apiProtocolVersion, serverId, profileId, categories, channels } = lastProtectedState;
    return { apiProtocolVersion, serverId, profileId, categories,
      channels: channels.map(({ id, name, kind, categoryId, settings }) => ({ id, name, kind, categoryId, settings })) };
  }, [lastProtectedState, protectedOffline]);
  useEffect(() => {
    if (modal === 'protected-invites' && !protectedState?.canListInvites ||
        modal === 'protected-bans' && !protectedState?.canManageBans) setModal(null);
  }, [modal, protectedState?.canListInvites, protectedState?.canManageBans]);
  const moderateProtected = (profileId: string, name: string, action: 'kick' | 'ban') =>
    setProtectedModeration({ serverId: selected, profileId, name, action });
  const selfTimeout = protectedState?.timeout;
  const editTimeout = protectedState?.canManageTimeouts ? (profileId: string, name: string) =>
    setTimeoutTarget({ serverId: selected, profileId, name }) : undefined;
  const selectedProtectedChannel = protectedState?.channels.find(channel => channel.id === protectedChannelIds[selected]);
  const lastTextKey = protectedState && `pawtalk.v3.last-text.${selected}:${protectedState.profileId}`;
  const lastTextId = lastTextKey && localStorage.getItem(lastTextKey);
  const protectedText = selectedProtectedChannel?.kind === 'text' ? selectedProtectedChannel :
    protectedState?.channels.find(channel => channel.kind === 'text' && channel.id === lastTextId) ??
    protectedState?.channels.find(channel => channel.kind === 'text');
  const activeProtectedVoiceChannel = selectedProtectedChannel?.kind === 'voice' &&
    voice?.serverId === selected && voice.channelId === selectedProtectedChannel.id ? selectedProtectedChannel : undefined;
  const protectedChannel = activeProtectedVoiceChannel ?? protectedText;
  const visibleProtectedText = protectedText;
  useEffect(() => {
    if (lastTextKey && protectedText) localStorage.setItem(lastTextKey, protectedText.id);
  }, [lastTextKey, protectedText?.id]);
  const channelRoster = !protectedOffline && protectedChatProfiles?.serverId === selected &&
    protectedChatProfiles.channelId === visibleProtectedText?.id ? protectedChatProfiles : undefined;
  const channelProfiles = channelRoster?.names;
  const cachedOwnProfile = protectedOwnProfiles[selected];
  const ownProtectedProfile = protectedState && (cachedOwnProfile?.profileId === protectedState.profileId
    ? cachedOwnProfile : channelProfiles?.get(protectedState.profileId));
  const previousAvatar = homeAvatar ?? ownProtectedProfile?.avatar;
  const ownAvatar = protectedState?.profileAvatar && protectedState.profileAvatar.revision > 1
    ? protectedState.profileAvatar.avatar : previousAvatar;
  const permissionAppearance = protectedState && (protectedState.canListMembers || protectedText) ? {
    serverId: selected, channelId: protectedState.canListMembers ? undefined : protectedText?.id,
    ownProfileId: protectedState.profileId, ownAvatar,
  } : undefined;
  const avatarMigrationAttempts = useRef(new Set<string>());
  useEffect(() => {
    if (!previousAvatar || protectedOffline || protectedState?.profileAvatar?.revision !== 1 || !protectedState.profileId) return;
    const { serverId, profileId } = protectedState;
    const key = `${serverId}/${profileId}`;
    if (avatarMigrationAttempts.current.has(key)) return;
    avatarMigrationAttempts.current.add(key);
    void membership('profile.protected.avatar.save', { serverId, profileId, avatar: previousAvatar, revision: 1 }).catch(() => {});
  }, [previousAvatar, protectedOffline, protectedState]);
  const activeProtectedState = voice && protectedStates[voice.serverId];
  const voiceOwnProfile = voice && protectedOwnProfiles[voice.serverId];
  const activeVoiceProfile = activeProtectedState && voiceOwnProfile?.profileId === activeProtectedState.profileId
    ? voiceOwnProfile : undefined;
  const activeOwnAvatar = activeProtectedState?.profileAvatar && activeProtectedState.profileAvatar.revision > 1
    ? activeProtectedState.profileAvatar.avatar : homeAvatar ?? activeVoiceProfile?.avatar;
  useEffect(() => {
    if (!activeProtectedState || joiningVoice.current) return;
    controller.current?.setNickname(activeVoiceProfile?.name ?? nickname);
    controller.current?.setAvatar(activeOwnAvatar);
  }, [activeProtectedState?.serverId, activeVoiceProfile?.name, nickname, activeOwnAvatar]);
  const voiceProtection = snapshot.voiceProtection;
  const scopedVoiceProtection = voiceProtection?.serverId === selected ? voiceProtection : undefined;
  const lastProtectedText = useRef(new Map<string, { serverId: string; profileId: string; channelId: string }>());
  const currentTextScope = protectedState && visibleProtectedText
    ? { serverId: selected, profileId: protectedState.profileId, channelId: visibleProtectedText.id } : undefined;
  useEffect(() => {
    if (currentTextScope) lastProtectedText.current.set(selected, currentTextScope);
    else if (protectedState) lastProtectedText.current.delete(selected);
  }, [selected, protectedState, currentTextScope?.channelId, currentTextScope?.profileId]);
  const textScope = currentTextScope ?? (!protectedState && !state && record ? lastProtectedText.current.get(selected) : undefined);
  const textProtection = useProtectedTextStatus(textScope, protectedOffline || !protectedState);
  const protectedDraftKey = protectedState && visibleProtectedText ? `${selected}:${protectedState.profileId}:${visibleProtectedText.id}` : '';
  const protectedChannels = protectedState?.channels ?? [];
  useEffect(() => {
    if (protectedDeleteChannel && (protectedDeleteChannel.serverId !== selected || !protectedState?.canManageChannels ||
        !protectedState.channels.some(channel => channel.id === protectedDeleteChannel.channel.id))) {
      setProtectedDeleteChannel(undefined);
    }
  }, [protectedDeleteChannel, selected, protectedState]);
  const activeRoleView = protectedState?.canManageChannels && roleViewSession?.request.serverId === selected
    ? roleViewSession : undefined;
  const roleViewResult = useRoleView(activeRoleView);
  const roleView = roleViewResult?.view;
  const previewChannel = roleView?.channels.find(channel => channel.id === roleViewChannelId &&
    (channel.kind === 'text' || channel.canConnect)) ??
    roleView?.channels.find(channel => channel.id === protectedChannel?.id && channel.kind === 'text') ??
    roleView?.channels.find(channel => channel.kind === 'text') ?? roleView?.channels[0];
  const previewVoice = previewChannel?.kind === 'voice' && previewChannel.canConnect && previewChannel.id === roleViewChannelId;
  const previewText = previewChannel?.kind === 'text' ? previewChannel :
    roleView?.channels.find(channel => channel.kind === 'text' && channel.id === roleViewTextId) ??
    roleView?.channels.find(channel => channel.kind === 'text');
  const previewRosterChannel = previewText ?? previewChannel;
  const previewRosterScope = protectedState?.canListMembers ? undefined :
    previewText && protectedChannels.some(channel => channel.id === previewText.id) ? previewText.id : protectedText?.id;
  const previewRosterServer = activeRoleView && !protectedOffline &&
    (previewRosterScope || protectedState?.canListMembers) ? selected : undefined;
  const previewKnownProfiles = useProtectedProfileAppearances(previewRosterServer, previewRosterScope,
    previewRosterChannel?.members.map(member => member.id) ?? []);
  const displayedChannel = activeRoleView ? previewChannel : protectedChannel;
  const displayedChannels: ProtectedServerState['channels'] = activeRoleView ? (roleView?.channels ?? []).map(channel => {
    const liveChannel = protectedChannels.find(item => item.id === channel.id);
    return { ...channel, categoryId: channel.categoryId ?? '', name: channel.name ?? liveChannel?.name, settings: liveChannel?.settings };
  }) : protectedChannels;
  const displayedCanManageChannels = activeRoleView ? roleView?.canManageChannels : protectedState?.canManageChannels;
  const displayedCanListInvites = activeRoleView ? roleView?.canListInvites : protectedState?.canListInvites;
  function openRoleView(request: RoleViewRequest) {
    setRoleViewChannelId('');
    setRoleViewTextId('');
    setRoleViewRoster(roster);
    setMenu(undefined);
    setPreview(undefined);
    setRoleViewSession({ request, selected: request.initial });
  }
  useEffect(() => {
    if (roleViewSession && !activeRoleView) setRoleViewSession(undefined);
  }, [roleViewSession, activeRoleView]);
  const canShowScopedACL = scopedACL?.serverId === selected && protectedChannels.some(channel =>
    channel.id === scopedACL.channelId && channel.canInspectACL);
  const canShowScopedPersonalACL = scopedPersonalACL?.serverId === selected && protectedChannels.some(channel =>
    channel.id === scopedPersonalACL.channelId && channel.canInspectACL);
  const canEditProtectedRoles = protectedState?.canManageChannels || protectedState?.canEditRoles;
  const canShowScopedAssignment = protectedState?.canAssignRoles && scopedAssignment?.serverId === selected &&
    (scopedAssignment.channelId ? protectedChannels.some(channel => channel.id === scopedAssignment.channelId) : protectedState.canListMembers);
  useEffect(() => {
    if (scopedACL && !canShowScopedACL) setScopedACL(undefined);
  }, [scopedACL, canShowScopedACL]);
  useEffect(() => {
    if (scopedPersonalACL && !canShowScopedPersonalACL) setScopedPersonalACL(undefined);
  }, [scopedPersonalACL, canShowScopedPersonalACL]);
  useEffect(() => {
    if (protectedRolesServer && (protectedRolesServer !== selected || !canEditProtectedRoles)) setProtectedRolesServer('');
    if (scopedAssignment && !canShowScopedAssignment) setScopedAssignment(undefined);
  }, [protectedRolesServer, selected, canEditProtectedRoles, scopedAssignment, canShowScopedAssignment]);
  const orderChannel = protectedChannels.find(channel => channel.id === protectedChannelDialog?.channel?.id && channel.canOrder);
  const canShowOrderDialog = !!orderChannel && protectedChannels.some(channel =>
    channel.id !== orderChannel.id && channel.canOrder && channel.categoryId === orderChannel.categoryId);
  useEffect(() => {
    if (protectedChannelDialog?.orderOnly && !canShowOrderDialog) setProtectedChannelDialog(undefined);
  }, [protectedChannelDialog, canShowOrderDialog]);
  const categoryGroups = ((activeRoleView ? roleView?.categories : protectedState?.categories) ?? []).map(category => ({
    id: category.id, label: category.name ?? t('Категория · {0}', category.id.slice(0, 8)),
    channels: displayedChannels.filter(channel => channel.categoryId === category.id),
  }));
  const protectedChannelGroups = [
    { id: '', label: t('Без категории'), channels: displayedChannels.filter(channel => !channel.categoryId) },
    ...categoryGroups,
  ];
  const canDragProtectedChannel = !activeRoleView && !!protectedState?.canManageChannels && !protectedOffline;
  const draggedProtectedChannel = canDragProtectedChannel && protectedDrag?.serverId === selected
    ? protectedChannels.find(channel => channel.id === protectedDrag.channelId) : undefined;
  const protectedChannelDragType = 'application/x-pawtalk-protected-channel';
  const categoryDrag = useReorderDrag(categoryGroups.map(group => group.id), (ids, moved) => {
    const index = ids.indexOf(moved);
    if (index < 0 || ids.length < 2) return;
    const after = index === ids.length - 1;
    const anchorId = ids[index + (after ? -1 : 1)];
    void (async () => {
      const serverId = selected;
      try {
        const { revision } = await membership<{ revision: number }>('category.protected.manage', { serverId });
        const { previewId } = await membership<{ previewId: string }>('category.protected.preview', {
          serverId, revision, action: 'category.order', categoryId: moved, anchorId, after,
        });
        await membership('category.protected.commit', { serverId, previewId });
        void refresh();
      } catch (failure) { setError((failure as Error).message); }
    })();
  });
  async function reorderProtected(channels: ProtectedServerState['channels'], ids: string[], movedId: string) {
    if (protectedOffline || protectedOrderPending.current) return;
    const moved = channels.find(channel => channel.id === movedId);
    const index = ids.indexOf(movedId);
    const after = index === ids.length - 1;
    const anchorId = ids[index + (after ? -1 : 1)];
    if (!moved || !anchorId || !protectedState?.canManageChannels && !moved.canOrder) return;
    protectedOrderPending.current = true;
    const input = { serverId: selected, channelId: movedId };
    try {
      const basis = await membership<{ revision: number; siblings: { id: string }[] }>('channel.protected.manage',
        { ...input, ...(!protectedState?.canManageChannels && { orderOnly: true }) });
      if (!basis.siblings.some(channel => channel.id === anchorId)) {
        setError(t('Недостаточно прав для этого действия.'));
        return;
      }
      const { previewId } = await membership<{ previewId: string }>('channel.protected.preview',
        { ...input, revision: basis.revision, action: 'channel.order', anchorId, after, mixedOrder: !moved.categoryId });
      await membership('channel.protected.commit', { serverId: selected, previewId });
      setProtectedStates(previous => {
        const state = previous[selected];
        if (!state) return previous;
        const byId = new Map(state.channels.map(channel => [channel.id, channel]));
        if (ids.some(id => !byId.has(id))) return previous;
        const ordered = ids.map(id => byId.get(id)!);
        let at = 0;
        return { ...previous, [selected]: { ...state, channels: state.channels.map(channel =>
          ids.includes(channel.id) ? ordered[at++] : channel) } };
      });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      protectedOrderPending.current = false;
      void refresh();
    }
  }
  const own = state && profileFor(state, state.self.effectiveProfileId), active = snapshot.state !== 'disconnected', admin = state?.self.role === 'admin';
  async function refreshDevices() { try { setDevices(await navigator.mediaDevices.enumerateDevices()); } catch { setError(t('Не удалось получить список аудиоустройств')); } }
  function protectedReadPosition(state: ProtectedServerState, channelId: string) {
    return Number(localStorage.getItem(`pawtalk.v3.read.${state.serverId}:${state.profileId}:${channelId}`)) || 0;
  }
  function noteProtectedUnread(state: ProtectedServerState, channelId: string, position: number, mention = false) {
    if (protectedReadPosition(state, channelId) >= position) return;
    const key = `${state.serverId}:${channelId}`;
    const positions = protectedUnread.current.get(key) ?? new Set<number>();
    if (!positions.has(position)) {
      positions.add(position);
      if (positions.size > 100) positions.delete(positions.values().next().value!);
      protectedUnread.current.set(key, positions);
      setUnread(previous => ({ ...previous, [key]: positions.size }));
    }
    if (mention) setMentionIDs(previous => {
      const ids = previous[key] ?? [];
      return ids.includes(position) ? previous : { ...previous, [key]: [...ids.slice(-99), position] };
    });
  }
  function clearProtectedUnread(serverId: string, channelId: string, position: number) {
    const key = `${serverId}:${channelId}`;
    acknowledgeNotifications(serverId, channelId, position);
    const positions = protectedUnread.current.get(key);
    if (positions) {
      for (const seen of positions) if (seen <= position) positions.delete(seen);
      if (!positions.size) protectedUnread.current.delete(key);
      const count = positions.size;
      setUnread(previous => ({ ...previous, [key]: count }));
    }
    setMentionIDs(previous => !previous[key]?.length ? previous :
      { ...previous, [key]: previous[key].filter(seen => seen > position) });
  }
  function protectedChannelInView(state: ProtectedServerState, channelId: string) {
    const now = current.current;
    if (now.selected !== state.serverId || !now.focused) return false;
    const lastText = localStorage.getItem(`pawtalk.v3.last-text.${state.serverId}:${state.profileId}`);
    const channels = state.channels.filter(channel => channel.kind === 'text');
    return (channels.find(channel => channel.id === now.protectedChannelIds[state.serverId]) ??
      channels.find(channel => channel.id === lastText) ?? channels[0])?.id === channelId;
  }
  function playProtectedNotificationSound() {
    if (!current.current.deafened && Date.now() - soundAt.current > 750) {
      soundAt.current = Date.now();
      void playSound('message', current.current.settings);
    }
  }
  async function receiveProtectedActivity(state: ProtectedServerState, channelId: string) {
    const serverId = state.serverId;
    const key = `${serverId}:${state.profileId}:${channelId}`;
    const lastRead = protectedReadPosition(state, channelId);
    const after = Math.max(lastRead, protectedActivity.current.get(key) ?? 0);
    const result = await membership<{ position: number; incoming: boolean; recent?: boolean; notified?: boolean } | undefined>(
      'chat.protected.activity', { serverId, channelId, after,
        notify: !protectedChannelInView(state, channelId) && !notificationsMuted(serverId, channelId) });
    if (!result || !mounted.current || result.position <= (protectedActivity.current.get(key) ?? 0)) return;
    if (protectedActivity.current.size >= 2048) protectedActivity.current.delete(protectedActivity.current.keys().next().value!);
    protectedActivity.current.set(key, result.position);
    if (result.incoming && (result.recent || after > 0)) noteProtectedUnread(state, channelId, result.position);
    if (result.incoming && result.recent && protectedReadPosition(state, channelId) < result.position &&
        !protectedChannelInView(state, channelId) && !notificationsMuted(serverId, channelId)) playProtectedNotificationSound();
  }
  async function receiveProtectedMentions(state: ProtectedServerState) {
    const serverId = state.serverId;
    const alerts = await membership<ProtectedMentionAlert[]>('chat.protected.mentions', protectedNotificationPrefs(state));
    if (!mounted.current) return;
    const seen = protectedAlertsSeen.current;
    for (const [key, until] of seen) if (until <= Date.now()) seen.delete(key);
    for (const { channelId, position, kind } of alerts) {
      if (!state.channels.some(channel => channel.kind === 'text' && channel.id === channelId)) continue;
      const key = `${serverId}:${state.profileId}:${channelId}:${position}`;
      if (seen.has(key)) continue;
      const quiet = () => !mounted.current || protectedChannelInView(state, channelId) ||
        protectedReadPosition(state, channelId) >= position || kind === 'group' && notificationsMuted(serverId, channelId);
      if (kind === 'direct' || !notificationsMuted(serverId, channelId)) noteProtectedUnread(state, channelId, position, true);
      const shown = !quiet() && await membership<boolean>('chat.protected.notify', { serverId, channelId, position });
      if (seen.size >= 2048) seen.delete(seen.keys().next().value!);
      seen.set(key, Date.now() + 60_000);
      if (shown && !quiet()) playProtectedNotificationSound();
    }
  }
  const refresh = useCallback(async (periodic = false, onlyServer?: string) => {
    if (polling.current){refreshAgain.current=true;return;} polling.current = true;notificationsRetry.current=false;
    try {
      const records = await membership<ServerRecord[]>('servers'); const order=orderRef.current;records.sort((a,b)=>(order.includes(a.serverId)?order.indexOf(a.serverId):1e6)-(order.includes(b.serverId)?order.indexOf(b.serverId):1e6)); if (!mounted.current) return;
      for (const id of protectedRefreshAt.current.keys()) if (!records.some(record => record.serverId === id)) protectedRefreshAt.current.delete(id);
      for (const [key, entry] of protectedChatCache.current) {
        const record = records.find(record => key.startsWith(record.serverId + ':'));
        const previous = current.current.servers.find(server => server.serverId === record?.serverId);
        if (!record || record.status !== 'online' || entry.until <= Date.now() || previous && record.address !== previous.address) {
          protectedChatCache.current.delete(key);
        }
      }
      setServers(records.map(record => ({ ...record, name: current.current.protectedStates[record.serverId]?.community?.name ?? record.name })));
      setStates(previous=>Object.fromEntries(Object.entries(previous).filter(([id])=>records.some(record=>record.serverId===id))));
      setProtectedStates(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => records.some(record => record.serverId === id))));
      setProtectedOwnProfiles(previous => {
        const retained = Object.entries(previous).filter(([id]) => records.some(record => record.serverId === id));
        return retained.length === Object.keys(previous).length ? previous : Object.fromEntries(retained);
      });
      setOfflineProtectedServers(previous => Object.fromEntries(Object.entries(previous).filter(([id]) =>
        records.some(record => record.serverId === id))));
      if(current.current.selected&&!records.some(record=>record.serverId===current.current.selected))setSelected('');
      const refreshRecords = onlyServer ? records.filter(record => record.serverId === onlyServer) : records;
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(4, refreshRecords.length) }, async () => {
        while (index < refreshRecords.length && mounted.current) {
          const server = refreshRecords[index++];
          if (periodic && current.current.protectedStates[server.serverId]?.eventsLive &&
              Date.now() - (protectedRefreshAt.current.get(server.serverId) ?? 0) < 30_000) continue;
          try {
            const next = await membership<ServerState | ProtectedServerState>('connect', { serverId: server.serverId });
            if (!mounted.current) return;
            setOfflineProtectedServers(previous => Object.hasOwn(previous, server.serverId)
              ? Object.fromEntries(Object.entries(previous).filter(([id]) => id !== server.serverId)) : previous);
            if (isProtectedServerState(next)) {
              for (const key of protectedChatCache.current.keys()) {
                if (key.startsWith(next.serverId + ':') &&
                    !next.channels.some(channel => key === `${next.serverId}:${next.profileId}:${channel.id}`)) {
                  protectedChatCache.current.delete(key);
                }
              }
              protectedRefreshAt.current.set(next.serverId, Date.now());
              const previousProfile = current.current.protectedStates[next.serverId]?.profileId;
              const textIds = new Set(next.channels.filter(channel => channel.kind === 'text').map(channel => channel.id));
              for (const key of protectedUnread.current.keys()) {
                if (!key.startsWith(next.serverId + ':')) continue;
                const channelId = key.slice(next.serverId.length + 1);
                if ((previousProfile && previousProfile !== next.profileId) || !textIds.has(channelId)) {
                  protectedUnread.current.delete(key);
                  setUnread(previous => ({ ...previous, [key]: 0 }));
                  setMentionIDs(previous => ({ ...previous, [key]: [] }));
                }
              }
              setProtectedStates(previous => ({ ...previous, [next.serverId]: next }));
              setServers(previous => previous.map(record => record.serverId === next.serverId
                ? { ...record, status: 'online', name: next.community?.name ?? record.name } : record));
              setStates(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== next.serverId)));
              reportedConnectionErrors.current.delete(next.serverId);
              await receiveProtectedMentions(next).catch(() => {});
              if (!next.eventsLive && periodic) {
                const channels = next.channels.filter(channel => channel.kind === 'text');
                const index = nextActivityPoll.current.get(next.serverId) ?? 0;
                const channel = channels[index % channels.length];
                if (channel) {
                  nextActivityPoll.current.set(next.serverId, (index + 1) % channels.length);
                  await receiveProtectedActivity(next, channel.id).catch(() => {});
                }
              }
              continue;
            }
            const hidden=hiddenVoice.current.get(next.serverId);if(hidden){if(!next.voice.some(person=>person.deviceId===hidden))hiddenVoice.current.delete(next.serverId);else next.voice=next.voice.filter(person=>person.deviceId!==hidden);}
            setStates(previous => ({ ...previous, [next.serverId]: next }));
            setServers(previous=>previous.map(record=>record.serverId===next.serverId?{...record,name:next.name}:record));
            reportedConnectionErrors.current.delete(server.serverId);
            const channelKeys=new Set(next.channels.map(channel=>`${next.serverId}:${channel.id}`));
            setUnread(values=>Object.fromEntries(Object.entries(values).filter(([key])=>!key.startsWith(next.serverId+':')||channelKeys.has(key))));
            for (const channel of next.channels.filter(channel => channel.kind === 'text')) {
              const key = `${next.serverId}:${channel.id}`, previous = seen.current.get(key);
              const read = Number(localStorage.getItem(cursorKey(next.serverId, channel.id))) || 0;
              acknowledgeNotifications(next.serverId,channel.id,read);
              if (channel.lastMessageId <= read) { seen.current.set(key,{revision:channel.messageRevision,last:channel.lastMessageId,read});setUnread(values => ({ ...values, [key]: 0 }));setMentionIDs(values=>({...values,[key]:[]}));mentionCache.current.delete(key);rescan.current.delete(key);knownUnread.current.set(key,0);deliveries.current.set(key,(deliveries.current.get(key)||[]).filter(e=>e.revision!>channel.messageRevision)); continue; }
              if (previous?.revision === channel.messageRevision&&previous.read===read){rescan.current.delete(key);deliveries.current.set(key,(deliveries.current.get(key)||[]).filter(e=>e.revision!>previous.revision));continue;}
              const requestedScan=rescan.current.get(key)||0,fullScan=!previous||requestedScan||(!next.eventsLive&&previous.revision!==channel.messageRevision&&previous.last>=channel.lastMessageId);
              const queued=(deliveries.current.get(key)||[]).filter(e=>e.revision!>(previous?.revision??-1)).sort((a,b)=>a.revision!-b.revision!);
              let revision=previous?.revision,fast=!!previous&&!requestedScan&&(previous.read===read||read>=previous.last);
              for(const packet of queued){if(packet.previous!==revision)fast=false;revision=packet.revision;}
              fast=fast&&queued.length>0&&revision===channel.messageRevision;
              // State can arrive before the first envelope. Give a healthy
              // payload stream the same bounded grace as reordered envelopes.
              if(!fast&&(queued.length||next.eventsLive&&next.capabilities?.includes('message-events-v1'))&&previous&&!fullScan&&(previous.read===read||read>=previous.last)){let deadline=deliveryGaps.current.get(key);if(!deadline){deadline=Date.now()+200;deliveryGaps.current.set(key,deadline);setTimeout(()=>{if(mounted.current&&deliveryGaps.current.get(key)===deadline)void refresh();},210);}if(Date.now()<deadline)continue;}if(fast)deliveryGaps.current.delete(key);
              let page:MessagePage,mentions:Message[],arrivals:Message[]=[],cursor=read,scanThrough=channel.lastMessageId;
              if(fast){
                let count=read>=previous!.last?0:knownUnread.current.get(key)||0;const byId=new Map((mentionCache.current.get(key)||[]).filter(m=>m.id>read).map(m=>[m.id,m]));
                const incoming=(m:{authorProfileId:string;systemKind?:string})=>!!m.systemKind||effectiveProfile(next,m.authorProfileId)!==next.self.effectiveProfileId,newRows=new Map<number,Message>(),removed=new Set<number>();
                for(const packet of queued){for(const m of packet.messages||[]){if(m.id>previous!.last){if(!newRows.has(m.id)&&m.id>read&&incoming(m))count++;newRows.set(m.id,m);removed.delete(m.id);}byId.delete(m.id);if(m.id>read&&incoming(m)&&m.content.mentions?.some(mention=>effectiveProfile(next,mention.profileId)===next.self.effectiveProfileId))byId.set(m.id,m);}for(const d of packet.deleted||[]){byId.delete(d.id);newRows.delete(d.id);if(!removed.has(d.id)&&d.id>read&&incoming(d))count--;removed.add(d.id);}}
                arrivals=[...newRows.values()];mentions=[...byId.values()];page={messages:[],first:queued.at(-1)!.first||0,last:queued.at(-1)!.last!,unread:Math.max(0,count),hasOlder:false,hasNewer:false};cursor=scanThrough=page.last;
              }else{
                page=await membership<MessagePage>('messages',{serverId:next.serverId,channelId:channel.id,options:{limit:1,readAfter:read}});
                mentions=fullScan?[]:(mentionCache.current.get(key)||[]).filter(m=>m.id>read);cursor=fullScan?read:Math.max(read,previous?.last||0);scanThrough=Math.max(channel.lastMessageId,page.last);
                while(cursor<scanThrough){const batch=await membership<MessagePage>('messages',{serverId:next.serverId,channelId:channel.id,options:{limit:500,...(cursor?{after:cursor}:{around:1})}});arrivals.push(...batch.messages);for(const message of batch.messages)if(message.id>read&&effectiveProfile(next,message.authorProfileId)!==next.self.effectiveProfileId&&message.content.mentions?.some(mention=>effectiveProfile(next,mention.profileId)===next.self.effectiveProfileId))mentions.push(message);const last=batch.messages.at(-1)?.id||cursor;if(last<=cursor||last>=scanThrough){cursor=last;break;}cursor=last;}
              }
              if(!mounted.current)return;knownUnread.current.set(key,page.unread);setUnread(values=>({...values,[key]:page.unread}));deliveries.current.set(key,(deliveries.current.get(key)||[]).filter(e=>e.revision!>channel.messageRevision));
              const value=current.current,visible=value.selected===next.serverId&&(value.chatIDs[next.serverId]||next.channels.find(channel=>channel.kind==='text')?.id)===channel.id&&value.focused&&viewports.current.get(key)!==false;
              if(!mounted.current)return;if(rescan.current.get(key)===requestedScan)rescan.current.delete(key);seen.current.set(key,{revision:channel.messageRevision,last:Math.max(scanThrough,cursor),read});mentionCache.current.set(key,mentions);setMentionIDs(values=>({...values,[key]:mentions.map(message=>message.id)}));
              const newMention=previous&&mentions.filter(message=>message.id>previous.last).at(-1);
              if (previous && channel.lastMessageId > previous.last && page.unread && !visible && (!notificationsMuted(next.serverId,channel.id)||newMention)) {
                const incoming=arrivals.filter(message=>message.id>previous.last&&(!!message.systemKind||effectiveProfile(next,message.authorProfileId)!==next.self.effectiveProfileId));
                if(!incoming.length)continue;
                const message=newMention||incoming.at(-1);
                const now=current.current,nowRead=Number(localStorage.getItem(cursorKey(next.serverId,channel.id)))||0;
                const visibleNow=now.selected===next.serverId&&(now.chatIDs[next.serverId]||next.channels.find(c=>c.kind==='text')?.id)===channel.id&&now.focused&&viewports.current.get(key)!==false;
                if(visibleNow||nowRead>=channel.lastMessageId)continue;
                if(message&&!now.deafened&&Date.now()-soundAt.current>750){soundAt.current=Date.now();void playSound('message',now.settings);}
                if(message)void membership('notify', { serverId: next.serverId, channelId: channel.id, channelName: channel.name,
                  authorName:message.systemKind?t('Система'):profileFor(next,message.authorProfileId)?.nickname||t('Участник'),
                  authorAvatar:message.systemKind?undefined:notificationAvatar(profileFor(next,message.authorProfileId)?.nickname||t('Участник'),profileFor(next,message.authorProfileId)?.avatar),
                  messageId:message.id,lastMessageId:incoming.reduce((last,m)=>Math.max(last,m.id),message.id),batchCount:incoming.length,mention:!!newMention,text:message.unreadable?t('Не удалось расшифровать сообщение.'):message.content.text||((message.content.file||message.content.files?.length)?t('Вложения'):''),hasImage:!!message.content.image });
              }
            }
          } catch (error) {
            if ((error as { code?: string }).code === 'RATE_LIMIT' && current.current.protectedStates[server.serverId]) continue;
            if ((error as { code?: string }).code === 'MIGRATION_MAINTENANCE' && mounted.current) {
              setMigrationServers(previous => previous[server.serverId] ? previous : { ...previous, [server.serverId]: true });
              setOfflineProtectedServers(previous => previous[server.serverId] ? previous : { ...previous, [server.serverId]: true });
              continue;
            }
            const keepCached = isMembershipConnectionUnavailable(error);
            if (mounted.current) {
              if (keepCached) {
                setOfflineProtectedServers(previous => previous[server.serverId] ? previous : { ...previous, [server.serverId]: true });
              } else {
                setProtectedStates(previous => previous[server.serverId]
                  ? Object.fromEntries(Object.entries(previous).filter(([id]) => id !== server.serverId)) : previous);
              }
            }
            if (['BANNED', 'NOT_A_MEMBER', 'PROTECTED_DEVICE_REVOKED', 'PROTECTED_PROFILE_UNLINKED'].includes((error as { code: string }).code) ||
                (keepCached && current.current.protectedStates[server.serverId])) continue;
            notificationsRetry.current=true;const message=(error as Error).message;if (current.current.selected === server.serverId && mounted.current&&reportedConnectionErrors.current.get(server.serverId)!==message){reportedConnectionErrors.current.set(server.serverId,message);setError(message);}
          }
        }
      }));
    } catch (error) {
      notificationsRetry.current = true;
      if (mounted.current) {
        setError((error as Error).message);
      }
    } finally { polling.current = false;if(refreshAgain.current&&mounted.current){refreshAgain.current=false;queueMicrotask(()=>void refresh());} }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      const { servers, states, protectedStates } = current.current;
      const legacy = Object.values(states);
      const healthy = Object.keys(protectedStates).length > 0
        ? servers.length > 0 && servers.every(({ serverId }) => (protectedStates[serverId] ?? states[serverId])?.eventsLive)
        : legacy.length > 0 && legacy.every(state => state.eventsLive);
      if (healthy && !notificationsRetry.current && Date.now() - periodicRefreshAt.current < 30_000) return;
      periodicRefreshAt.current = Date.now();
      void refresh(true);
    }, 3500);
    const activityChannels = new Map<string, Set<string>>();
    let mentionRefresh: ReturnType<typeof setTimeout> | undefined;
    const protectedEvent = window.desktop?.onMembershipProtectedEvent?.(event => {
      const { serverId } = event;
      if (event.type === 'composer') return;
      if (event.type === 'voice') {
        controller.current?.refreshProtectedVoiceState(serverId, event.channelId);
        if (current.current.selected === serverId || current.current.voice?.serverId === serverId) void refresh(false, serverId);
        return;
      }
      for (const key of protectedChatCache.current.keys()) {
        if (key.startsWith(serverId + ':') && (event.type !== 'chat' || key.endsWith(':' + event.channelId)) &&
            (event.type !== 'status' || !event.live)) protectedChatCache.current.delete(key);
      }
      if (event.type === 'chat') {
        if (!current.current.protectedStates[serverId]?.channels.some(channel => channel.kind === 'text' && channel.id === event.channelId)) return;
        const channels = activityChannels.get(serverId) ?? new Set<string>();
        channels.add(event.channelId);
        activityChannels.set(serverId, channels);
        if (!mentionRefresh) mentionRefresh = setTimeout(() => {
          mentionRefresh = undefined;
          for (const [id, channels] of activityChannels) {
            const state = current.current.protectedStates[id];
            if (!state) continue;
            void receiveProtectedMentions(state).catch(() => {});
            void (async () => {
              for (const channelId of channels) await receiveProtectedActivity(state, channelId).catch(() => {});
            })();
          }
          activityChannels.clear();
        }, 400);
        return;
      }
      if (event.type === 'status') {
        setProtectedStates(states => states[serverId] ? { ...states, [serverId]: { ...states[serverId], eventsLive: event.live } } : states);
        if (event.live) return;
      }
      void refresh();
    });
    const serverEvent=window.desktop?.onMembershipServerEvent?.(event=>{if(event.delivery&&event.channelId){const key=event.serverId+':'+event.channelId;if([...deliveries.current.values()].reduce((n,v)=>n+v.length,0)>=64){deliveries.current.clear();for(const k of seen.current.keys())rescan.current.set(k,(rescan.current.get(k)||0)+1);}else deliveries.current.set(key,[...(deliveries.current.get(key)||[]),event]);void refresh();return;}if(event.rescan&&event.channelId)rescan.current.set(event.serverId+':'+event.channelId,(rescan.current.get(event.serverId+':'+event.channelId)||0)+1);if(event.type==='resync')for(const key of seen.current.keys())if(key.startsWith(event.serverId+':'))rescan.current.set(key,(rescan.current.get(key)||0)+1);void refresh();});
    const liveStatus=window.desktop?.onMembershipLiveStatus?.(event=>{setStates(values=>values[event.serverId]?{...values,[event.serverId]:{...values[event.serverId],eventsLive:event.live}}:values);if(!event.live)for(const key of seen.current.keys())if(key.startsWith(event.serverId+':'))rescan.current.set(key,(rescan.current.get(key)||0)+1);void refresh();});
    const changed = window.desktop?.onMembershipChanged?.(event => {
      const serverId = event?.serverId;
      const profile = event?.nickname;
      if (serverId && profile && current.current.protectedStates[serverId]?.profileId === profile.profileId) {
        setProtectedOwnProfiles(previous => ({
          ...previous, [serverId]: {
            ...profile,
            avatar: previous[serverId]?.profileId === profile.profileId ? previous[serverId].avatar : undefined,
          },
        }));
      }
      if(event?.departure){setDepartures(values=>[...values,event.departure!]);setModal(null);setChannelDialog(undefined);setModeration(undefined);setLeaveServer(undefined);setMuteServer(undefined);setMuteChannel(undefined);setAddressServer(undefined);setRenameServer(undefined);setError('');}
      if (event?.departure?.kind === 'device-revoked' || event?.departure?.kind === 'profile-unlinked') {
        const { serverId } = event.departure;
        setServers(values => values.filter(server => server.serverId !== serverId));
        setSelected(value => value === serverId ? '' : value);
        setServerSettings(value => value?.serverId === serverId ? undefined : value);
        setBindingServer(value => value?.serverId === serverId ? undefined : value);
      }
      if(event?.leaveError==='LAST_ADMIN')setError(t('Сервер отклонил отложенный выход: сначала назначьте другого администратора. Сервер возвращён в список.'));
      else if(event?.leaveError==='PROTECTED_OWNER_LEAVE')setError(t('Передайте владение сервером, прежде чем выйти.'));
      else if(event?.leaveError==='PROTECTED_DEPARTURE_CHANGED')setError(t('Данные изменились. Обновите их и повторите действие.'));
      void refresh();
    });
    const receive = (value: string) => { if (value) { setAddress(value); if(!onboardingActive.current)setModal('join'); } };
    const invitation = window.desktop?.onInvitation(receive); void window.desktop?.pendingInvitation().then(receive);
    const open = window.desktop?.onMembershipOpenChannel?.(value => {
      setSelected(value.serverId);
      if (value.protected) setProtectedChannelIds(previous => ({ ...previous, [value.serverId]: value.channelId }));
      else setChatIDs(previous => ({ ...previous, [value.serverId]: value.channelId }));
    });
    const focus = window.desktop?.onWindowActive?.(value=>{if(!value)current.current.focused=false;setFocused(value);}); void window.desktop?.windowActive?.().then(setFocused);
    const online = () => { void refresh(); };
    window.addEventListener('online', online);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      clearTimeout(mentionRefresh);
      protectedEvent?.(); changed?.(); serverEvent?.(); liveStatus?.(); invitation?.(); open?.(); focus?.();
      window.removeEventListener('online', online);
    };
  }, [refresh]);
  useEffect(() => {
    const session = new VoiceSession(current.current.settings); controller.current = session;
    session.onUpdate = value=>{setSnapshot(value);if(value.state==='disconnected'&&current.current.voice&&!joiningVoice.current){setVoice(undefined);void membership('voiceLeave').catch(()=>{});}}; session.onError = setError; void refreshDevices();
    void window.desktop?.capabilities().then(value => setNative(value.native));
    const ptt = window.desktop?.onPtt(down => session.setPtt(down));
    const action = window.desktop?.onAction(value => { if (value === 'mute') toggleMic(); if (value === 'deafen') toggleSound(); if (value === 'force-mute') setAudioState(value=>({...value,muted:true})); });
    const lost = window.desktop?.onMembershipVoiceLost?.(event => {if(current.current.voice?.serverId!==event.serverId&&pendingVoiceServer.current!==event.serverId)return;++voiceAttempt.current; void session.disconnect(); setVoice(undefined); setError(t('Голосовое соединение завершено сервером.')); });
    const suspend = window.desktop?.onSuspend(() => {++voiceAttempt.current; void session.disconnect(); setVoice(undefined); setAudioState(value=>({...value,muted:true})); });
    const change = () => void refreshDevices(); navigator.mediaDevices?.addEventListener('devicechange', change);
    return () => { ptt?.(); action?.(); lost?.(); suspend?.(); navigator.mediaDevices?.removeEventListener('devicechange', change); void session.disconnect(); };
  }, []);
  useEffect(() => { remember(settings); controller.current?.updateSettings(settings); }, [settings]);
  const previousAudio = useRef({ muted, deafened });
  useEffect(() => {
    controller.current?.setMute(muted, deafened); const previous = previousAudio.current;
    if (previous.deafened !== deafened) void playSound(deafened ? 'deafen' : 'undeafen', current.current.settings);
    else if (previous.muted !== muted) void playSound(muted ? 'mute' : 'unmute', current.current.settings);
    previousAudio.current = { muted, deafened };
  }, [muted, deafened]);
  useEffect(() => { void window.desktop?.configureKeys({ ptt: settings.pttKey, mute: settings.muteKey, deafen: settings.deafenKey }).then(value => setKeyError(value.failed.length ? t('Комбинация занята или указана неверно: ') + value.failed.join(', ') : '')).catch(() => setKeyError(t('Не удалось настроить горячие клавиши'))); }, [settings.pttKey, settings.muteKey, settings.deafenKey]);
  useEffect(() => { localStorage.setItem('pawtalk.nickname', nickname); }, [nickname]);
  useEffect(() => { localStorage.setItem('pawtalk.v2.channels',JSON.stringify(chatIDs)); }, [chatIDs]);
  useEffect(() => { localStorage.setItem('pawtalk.v2.roster', roster ? 'visible' : 'hidden'); }, [roster]);
  useEffect(() => { void window.desktop?.setUpdateRooms?.(servers.map(server => ({ address: server.address, name: server.name }))); }, [servers]);
  async function perform(action: string, input: Record<string, unknown>, done?: () => void) {
    setBusy(true); setError(''); try { await membership(action, input); done?.(); await refresh(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  function saveServerName() {
    if (!renameServer || busy) return;
    const { serverId, name: expectedName } = renameServer;
    const name = serverName.trim();
    if (!name || name === expectedName) return;
    void perform('server.rename', { serverId, name, expectedName }, () => setRenameServer(undefined));
  }
  function openServer(serverId: string) {
    if (serverId !== selected && protectedStates[serverId]?.channels.some(channel =>
      channel.kind === "voice" && channel.id === protectedChannelIds[serverId])) {
      setProtectedChannelIds(previous => {
        const next = { ...previous };
        delete next[serverId];
        return next;
      });
    }
    setSelected(serverId);
  }
  function joined(value: ServerState | ProtectedServerState) {
    if (isProtectedServerState(value)) setProtectedStates(previous => ({ ...previous, [value.serverId]: value }));
    else setStates(previous => ({ ...previous, [value.serverId]: value }));
    selectJoined(value.serverId);
  }
  function selectJoined(serverId: string) {
    setSelected(serverId); setModal(null); setAddress(''); setLinkText(''); void refresh();
  }
  async function join(address: string) {
    setBusy(true); setError(''); try { joined(await membership<ServerState | ProtectedServerState>('join', { address, nickname })); } catch (error) { setError((error as Error).message); throw error; } finally { setBusy(false); }
  }
  async function disconnectVoice(cancel=true) {if(cancel)++voiceAttempt.current;const previous=current.current.voice;if(previous){const old=current.current.states[previous.serverId];if(old){hiddenVoice.current.set(previous.serverId,old.self.deviceId);setStates(values=>({...values,[old.serverId]:{...old,voice:old.voice.filter(person=>person.deviceId!==old.self.deviceId)}}));}}setVoice(undefined); await controller.current?.disconnect(); await membership('voiceLeave'); }
  async function joinVoice(channel: Channel) {
    if (!state || joiningVoice.current) return;
    joiningVoice.current = true; setBusy(true); setError('');
    const attempt=++voiceAttempt.current;pendingVoiceServer.current=state.serverId;
    try {
      if (settings.inputMode === 'ptt' && !native) throw Error(t('Для Push-to-Talk нужно собрать нативный модуль Windows.'));
      await disconnectVoice(false); const access = await membership<{ url: string; token: string; key: string }>('voice', { serverId: state.serverId, channelId: channel.id });
      if(attempt!==voiceAttempt.current)throw Object.assign(Error('cancelled'),{code:'CANCELLED'});
      const profile = profileFor(state, state.self.effectiveProfileId); controller.current?.setNickname(profile?.nickname || nickname); controller.current?.setAvatar(profile?.avatar);
      const known=current.current.states[state.serverId]||state;for(const [id,pref] of Object.entries(projectPeerAudio(peerAudio,state.serverId,known.voice,id=>effectiveProfile(known,id))))controller.current?.setPerson(id,pref.volume,pref.muted);
      await controller.current!.connect(access.url, access.token, { required: true, key: access.key });
      if(attempt!==voiceAttempt.current)throw Object.assign(Error('cancelled'),{code:'CANCELLED'});
      await membership('voiceConnected', { serverId: state.serverId, channelId: channel.id }); hiddenVoice.current.delete(state.serverId); setVoice({ serverId: state.serverId, channelId: channel.id });  await refresh();
    } catch (error) { await controller.current?.disconnect(); void membership('voiceLeave'); setVoice(undefined); if(attempt===voiceAttempt.current&&(error as {code?:string}).code!=='CANCELLED')setError((error as Error).message); } finally { joiningVoice.current = false;pendingVoiceServer.current=''; setBusy(false); }
  }
  async function joinProtectedVoice(serverId: string, channelId: string) {
    const session = controller.current;
    if (!session || joiningVoice.current) return;
    joiningVoice.current = true;
    setBusy(true); setError('');
    const attempt = ++voiceAttempt.current;
    pendingVoiceServer.current = serverId;
    const scope = { serverId, channelId };
    let activeChannel = channelId;
    const transport: ProtectedVoiceTransport = {
      join: () => membership('voice.protected.join', scope),
      refresh: epochId => membership('voice.protected.refresh', { serverId, channelId: activeChannel, epochId }),
      reconnect: () => membership('voice.protected.reconnect', { serverId, channelId: activeChannel }),
      telemetry: sample => membership('voice.protected.telemetry', { serverId, channelId: activeChannel, ...sample }),
      onChannelControl: action => {
        if (attempt !== voiceAttempt.current) return;
        setAudioState(value => action === 'voice.deafen' ? { muted: true, deafened: true } : { ...value, muted: true });
      },
      leave: async () => { await membership('voiceLeave'); },
      onChannelChange: destination => {
        if (attempt !== voiceAttempt.current) return;
        const source = activeChannel;
        activeChannel = destination;
        setVoice({ serverId, channelId: destination });
        setProtectedChannelIds(previous => {
          const viewed = previous[serverId] ?? current.current.protectedStates[serverId]?.channels[0]?.id;
          return viewed === source ? { ...previous, [serverId]: destination } : previous;
        });
        void refresh();
      },
    };
    try {
      if (settings.inputMode === 'ptt' && !native) throw Error(t('Для Push-to-Talk нужно собрать нативный модуль Windows.'));
      await disconnectVoice(false);
      if (attempt !== voiceAttempt.current) return;
      const state = current.current.protectedStates[serverId];
      const members = state?.channels.find(channel => channel.id === channelId)?.voiceParticipants ?? [];
      for (const [id, pref] of Object.entries(projectPeerAudio(savedPeerAudio.current, serverId, members))) {
        session.setPerson(id, pref.volume, pref.muted);
      }
      const profile = protectedOwnProfiles[serverId];
      const knownName = state && profile?.profileId === state.profileId ? profile.name : undefined;
      session.setNickname(knownName ?? nickname);
      const savedAvatar = state?.profileAvatar;
      session.setAvatar(savedAvatar && savedAvatar.revision > 1 ? savedAvatar.avatar : homeAvatar ?? profile?.avatar);
      if (!knownName && state?.canEditOwnNickname) {
        const profileId = state.profileId;
        void membership<{ name: string }>('profile.protected.nickname.read', { serverId, profileId }).then(({ name }) => {
          if (attempt !== voiceAttempt.current || current.current.protectedStates[serverId]?.profileId !== profileId) return;
          setProtectedOwnProfiles(previous => previous[serverId]?.profileId === profileId ? previous
            : { ...previous, [serverId]: { profileId, name } });
        }).catch(() => {});
      }
      await session.connectProtected(transport, scope);
      if (attempt !== voiceAttempt.current) { await session.disconnect(); return; }
      setVoice(scope);
    } catch (error) {
      await session.disconnect();
      if (attempt === voiceAttempt.current) setError((error as Error).message);
    } finally {
      joiningVoice.current = false;
      pendingVoiceServer.current = '';
      setBusy(false);
    }
  }
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(previous => ({ ...previous, [key]: value }));
  function context(event: React.MouseEvent, items: MenuItem[]) { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, items }); }
  function openAddressSettings(server: ServerRecord) {
    setAddress(server.address);
    setAddressServer(server);
    setError('');
  }
  function serverNotificationItem(serverId: string): MenuItem {
    const muted = isServerMuted(serverId);
    return { icon: muted ? 'bell' : 'bell-off', label: t(muted ? 'Включить уведомления' : 'Заглушить уведомления'), action() {
      if (muted) {
        localStorage.removeItem(`pawtalk.v2.mute.${serverId}`);
        updatePrefs(value => value + 1);
      } else setMuteServer(serverId);
    } };
  }
  function serverMenu(event: React.MouseEvent, server: ServerRecord) {
    const items: MenuItem[] = [serverNotificationItem(server.serverId)];
    const protectedServer = protectedStates[server.serverId];
    if (protectedServer) {
      if (server.status !== 'online' || offlineProtectedServers[server.serverId]) items.push({
        icon: 'edit', label: t('Изменить адрес сервера'), disabled: voice?.serverId === server.serverId,
        action: () => openAddressSettings(server),
      });
      if (!offlineProtectedServers[server.serverId] && protectedServer.canListInvites) items.push({ icon: 'invite', label: t('Приглашения'),
        action() { setSelected(server.serverId); setModal('protected-invites'); } });
      items.push({ icon: 'exit', label: t('Выйти с сервера'), danger: true, action: () => setLeaveServer(server) });
      context(event, items);
      return;
    }
    items.push({ label: t('Изменить адрес сервера'), disabled: voice?.serverId === server.serverId,
      action: () => openAddressSettings(server) });
    if(states[server.serverId]?.self.role==='admin'&&states[server.serverId].capabilities?.includes('server-avatar-v1'))items.push({label:t('Аватар сервера'),action(){setAvatarServer(states[server.serverId]);}});
    if(states[server.serverId]?.self.role==='admin')items.push({label:t('Переименовать сервер'),action(){const name=states[server.serverId].name;setError('');setServerName(name);setRenameServer({serverId:server.serverId,name});}});
    if(states[server.serverId]?.self.role==='admin')items.push({label:t('Заблокированные участники'),action(){setSelected(server.serverId);setModal('bans');}});
    if(['admin','moderator'].includes(states[server.serverId]?.self.role||''))items.push({label:t('Пригласить участников'),action(){setSelected(server.serverId);setModal('invite');}});
    items.push({ label: t('Выйти с сервера'), danger: true, action: () => setLeaveServer(server) });context(event,items);
  }
  function channelNotificationItem(serverId: string, channelId: string): MenuItem {
    return { label: isChannelMuted(serverId, channelId) ? t('Включить уведомления') : t('Заглушить уведомления'), action() {
      if (isChannelMuted(serverId, channelId)) {
        localStorage.removeItem(channelMuteKey(serverId, channelId));
        updatePrefs(value => value + 1);
      } else setMuteChannel({ serverId, channelId });
    } };
  }
  function protectedChannelMenu(event: React.MouseEvent, channel: ProtectedServerState['channels'][number]) {
    event.stopPropagation();
    const key = `${selected}:${channel.id}`;
    const items: MenuItem[] = [{
      label: t(favoriteChannels[key] ? 'Убрать из избранного' : 'Добавить в избранное'),
      action() {
        const next = { ...favoriteChannels };
        if (next[key]) delete next[key];
        else next[key] = true;
        localStorage.setItem('pawtalk.protected.favorites', JSON.stringify(next));
        setFavoriteChannels(next);
      },
    }];
    if (channel.kind === 'text') {
      const mute = channelNotificationItem(selected, channel.id);
      const positions = protectedUnread.current.get(key);
      if (protectedState && positions?.size) {
        const { serverId, profileId } = protectedState;
        const position = Math.max(...positions);
        items.unshift({ label: t('Пометить как прочитанное'), action() {
          const readKey = `pawtalk.v3.read.${serverId}:${profileId}:${channel.id}`;
          localStorage.setItem(readKey, String(Math.max(position, Number(localStorage.getItem(readKey)) || 0)));
          clearProtectedUnread(serverId, channel.id, position);
        } });
      }
      items.push({ ...mute, label: t(isChannelMuted(selected, channel.id) ? 'Включить уведомления' : 'Заглушить канал') });
    }
    if (protectedState?.canManageChannels || channel.canEditSettings || channel.canInspectACL) {
      items.push({ label: t('Настройки канала'), action: () => openProtectedChannelSettings(channel) });
    }
    if (!protectedState?.canManageChannels && channel.canInspectACL) items.push(
      { label: t('Правила доступа'), action: () => setScopedACL({ serverId: selected, channelId: channel.id }) },
      { label: t('Персональные правила доступа'), action: () => setScopedPersonalACL({ serverId: selected, channelId: channel.id }) },
    );
    if (!protectedState?.canManageChannels && channel.canOrder && protectedChannels.some(neighbor => neighbor.id !== channel.id &&
        neighbor.canOrder && neighbor.categoryId === channel.categoryId)) {
      items.push({ label: t('Изменить порядок каналов'), action: () => setProtectedChannelDialog({ serverId: selected, channel, orderOnly: true }) });
    }
    if (protectedState?.canManageChannels) items.push(
      { label: t('Создать копию канала'), action: () => setProtectedChannelDialog({
        serverId: selected, channel, initialAction: 'channel.copy',
      }) },
      { label: t('Удалить канал'), danger: true, action: () => setProtectedDeleteChannel({ serverId: selected, channel }) },
    );
    if (items.length) context(event, items);
  }
  function openProtectedChannelSettings(channel: ProtectedServerState['channels'][number]) {
    if (protectedState?.canManageChannels) setProtectedChannelDialog({ serverId: selected, channel });
    else if (channel.canEditSettings) setScopedChannelSettings({ serverId: selected, channel });
    else if (channel.canInspectACL) setScopedACL({ serverId: selected, channelId: channel.id });
  }
  function scopedChannelNavigation(channelId: string, page: 'overview' | 'roles' | 'personal') {
    const channel = protectedChannels.find(channel => channel.id === channelId);
    if (!channel) return undefined;
    function open(target: typeof page) {
      setScopedChannelSettings(target === 'overview' && channel ? { serverId: selected, channel } : undefined);
      setScopedACL(target === 'roles' ? { serverId: selected, channelId } : undefined);
      setScopedPersonalACL(target === 'personal' ? { serverId: selected, channelId } : undefined);
    }
    return <nav className="settings-nav" aria-label={t('Настройки канала')}>
      <div className="settings-nav-caption">{channel.name ?? channelId}</div>
      {channel.canEditSettings && <button type="button" aria-current={page === 'overview' ? 'page' : undefined}
        onClick={() => open('overview')}><Icon name="settings" size={16}/>{t('Обзор')}</button>}
      {channel.canInspectACL && <>
        <button type="button" aria-current={page === 'roles' ? 'page' : undefined}
          onClick={() => open('roles')}><Icon name="shield" size={16}/>{t('Права доступа')}</button>
        <button type="button" aria-current={page === 'personal' ? 'page' : undefined}
          onClick={() => open('personal')}><Icon name="user" size={16}/>{t('Персональные правила доступа')}</button>
      </>}
    </nav>;
  }
  function protectedSidebarActions(): MenuItem[] {
    const items: MenuItem[] = [];
    if (protectedState?.canManageChannels) items.push(
      { icon: 'channel-add', label: t('Создать канал'), action: () => setProtectedChannelDialog({ serverId: selected }) },
      { icon: 'folder-add', label: t('Создать категорию'), action: () => setProtectedCategories({ serverId: selected }) },
    );
    return items;
  }
  const settingsTabs: ServerSettingsTab[] = [];
  if (protectedState?.community || record) settingsTabs.push('profile');
  if (protectedState?.canListMembers) settingsTabs.push('members');
  if (protectedState?.canManageChannels || protectedState?.canEditRoles) settingsTabs.push('roles');
  if (protectedState?.canListInvites) settingsTabs.push('invites');
  if (protectedState?.canViewAudit) settingsTabs.push('audit');
  if (protectedState?.canManageBans) settingsTabs.push('bans');
  if (protectedState?.profileId && !protectedState.joinPending) settingsTabs.push('devices');
  if (protectedState && record) settingsTabs.push('access');
  const serverSettingsTab = serverSettings && settingsTabs.includes(serverSettings.tab) ? serverSettings.tab : settingsTabs[0];
  const onlineProtectedServer = protectedState?.profileId && !protectedOffline && record?.status === 'online' ? record : undefined;
  const openProfileDevices = settingsTabs.includes('devices') ? () => {
    setProtectedMembersServer('');
    setServerSettings({ serverId: selected, tab: 'devices' });
  } : undefined;
  function openProtectedServerMenu(event: React.MouseEvent<HTMLButtonElement>) {
    if (!protectedState) return;
    const button = event.currentTarget;
    if (menu?.anchor === button) { setMenu(undefined); return; }
    const items: MenuItem[] = [
      { icon: 'settings', label: t('Настройки сервера'), action: () => setServerSettings({ serverId: selected, tab: 'profile' }) },
      ...protectedSidebarActions(),
      serverNotificationItem(selected),
    ];
    if (protectedState.canEditOwnNickname) items.push({
      icon: 'edit', label: t('Редактировать личный профиль'), action: () => setNicknameServer(selected),
    });
    const bounds = button.getBoundingClientRect();
    setMenu({ x: bounds.left, y: bounds.bottom + 4, anchor: button, items });
  }
  function channelMenu(event: React.MouseEvent, channel: Channel) {
    const items: MenuItem[] = channel.kind === 'text' ? [channelNotificationItem(selected, channel.id)] : [];
    if (admin) items.push({ label: t('Переименовать'), action: () => { setChannelName(channel.name); setChannelDialog({ kind: channel.kind, channel }); } },
      { label: t('Удалить канал'), danger: true, disabled: channel.protected, action: () => setChannelDialog({ kind: channel.kind, channel, deleting: true }) });
    if (items.length) context(event, items);
  }
  function memberMenu(event: React.MouseEvent, profileId: string) {
    if (!state) return; const own = state.self.effectiveProfileId === profileId, member = state.members.find(member => member.profileId === profileId);
    const items: MenuItem[] = [{ label: t('Скопировать ID профиля'), action: () => void membership('copy', { text: profileId }) }];
    if (own) items.push({ label: t('Связать устройства'), action: () => { setLinkText(''); setModal('link'); } }, { label: t('Связанные устройства'), action: () => setModal('devices') });
    if (admin) items.push({ label: t('Изменить роль'), action: () => { setRole(member?.role || 'member'); setModeration({ profileId, mode: 'role' }); } }, { label: t('Исключить с сервера'), danger: true, disabled: member?.role === 'admin', action: () => setModeration({ profileId, mode: 'kick' }) }, { label: t('Заблокировать'), danger: true, disabled: member?.role === 'admin', action: () => setModeration({ profileId, mode: 'ban' }) });
    context(event, items);
  }
  async function reorderChannels(kind:'voice'|'text',ids:string[]){
    if(!state||!admin)return;
    const list=ids.map(id=>state.channels.find(channel=>channel.id===id&&channel.kind===kind)!);
    if(list.some(channel=>!channel))return;
    const before=state.channels;
    setStates(values=>({...values,[state.serverId]:{...state,channels:[...state.channels.filter(c=>c.kind!==kind),...list]}}));
    try{await membership('channel.order',{serverId:state.serverId,kind,items:list.map(c=>({id:c.id,revision:c.revision}))});await refresh();}
    catch(error){setStates(values=>({...values,[state.serverId]:{...state,channels:before}}));setError((error as Error).message);void refresh();}
  }
  const serverDrag=useReorderDrag(servers.map(server=>server.serverId),order=>{
    localStorage.setItem('pawtalk.v2.server-order',JSON.stringify(order));orderRef.current=order;setServerOrder(order);
    setServers(values=>[...values].sort((a,b)=>order.indexOf(a.serverId)-order.indexOf(b.serverId)));
  });
  const voiceDrag=useReorderDrag((state?.channels||[]).filter(c=>c.kind==='voice').map(c=>c.id),ids=>{void reorderChannels('voice',ids);});
  const textDrag=useReorderDrag((state?.channels||[]).filter(c=>c.kind==='text').map(c=>c.id),ids=>{void reorderChannels('text',ids);});
  const onlineVoice = voice && states[voice.serverId];
  const activeVoiceMembers = activeProtectedState && voice
    ? activeProtectedState.channels.find(channel => channel.id === voice.channelId)?.voiceParticipants : undefined;
  const pendingPrefs = pendingVoiceAudio && pendingVoiceAudio.serverId === voice?.serverId &&
    pendingVoiceAudio.channelId === voice.channelId ? pendingVoiceAudio.prefs : undefined;
  useEffect(() => {
    if (!pendingVoiceAudio) return;
    if (!pendingPrefs || !voice) {
      setPendingVoiceAudio(undefined);
      return;
    }
    // The call can expose a participant before the server roster identifies their profile.
    const unresolved = { ...pendingPrefs };
    const patch: PeerAudio = {};
    for (const member of activeVoiceMembers ?? []) {
      if (!member.sessionId || !unresolved[member.sessionId]) continue;
      patch[`${voice.serverId}:${member.profileId}`] = unresolved[member.sessionId];
      delete unresolved[member.sessionId];
    }
    if (!Object.keys(patch).length) return;
    saveAudioPreferences(patch);
    setPendingVoiceAudio(Object.keys(unresolved).length ? { ...pendingVoiceAudio, prefs: unresolved } : undefined);
  }, [activeVoiceMembers, pendingPrefs, pendingVoiceAudio, saveAudioPreferences, voice]);
  const personPrefs = voice && activeProtectedState
    ? { ...projectPeerAudio(peerAudio, voice.serverId, activeVoiceMembers ?? []), ...pendingPrefs }
    : onlineVoice && voice ? projectPeerAudio(peerAudio, voice.serverId, onlineVoice.voice, id => effectiveProfile(onlineVoice, id)) : {};
  const audioBindings=JSON.stringify(personPrefs);
  useEffect(()=>{for(const [id,pref] of Object.entries(JSON.parse(audioBindings) as PeerAudio))controller.current?.setPerson(id,pref.volume,pref.muted);},[audioBindings,voice?.serverId,voice?.channelId]);
  function voiceProfile(target: VoiceSidebarTarget) {
    return protectedStates[target.serverId]?.channels.find(channel => channel.id === target.sourceChannelId)
      ?.voiceParticipants?.find(member => member.sessionId === target.targetSessionId)?.profileId;
  }
  function changeProtectedPersonAudio(target: VoiceSidebarTarget, volume: number, muted: boolean) {
    const { serverId, sourceChannelId: channelId, targetSessionId } = target;
    const profileId = voiceProfile(target);
    const pref = { volume: Math.max(0, Math.min(2, volume)), muted };
    const active = voice?.serverId === serverId && voice.channelId === channelId;
    if (profileId) saveAudioPreferences({ [`${serverId}:${profileId}`]: pref });
    else if (active) setPendingVoiceAudio({ serverId, channelId, prefs: { ...pendingPrefs, [targetSessionId]: pref } });
    if (active) controller.current?.setPerson(targetSessionId, pref.volume, pref.muted);
  }
  function changePersonAudio(id:string,volume:number,muted:boolean){
    if (voice && activeProtectedState) {
      changeProtectedPersonAudio({ serverId: voice.serverId, sourceChannelId: voice.channelId, targetSessionId: id }, volume, muted);
      return;
    }
    const presence = onlineVoice?.voice.find(item => item.identity === id);
    if (!presence || !voice || !onlineVoice) return;
    const pref = { volume: Math.max(0, Math.min(2, volume)), muted };
    saveAudioPreferences({ [`${voice.serverId}:${effectiveProfile(onlineVoice, presence.profileId)}`]: pref });
    controller.current?.setPerson(id, pref.volume, muted);
  }
  async function moveVoiceParticipant(target: VoiceSidebarTarget, destinationChannelId: string) {
    try { await membership('voice.protected.move', { ...target, destinationChannelId }); }
    catch (failure) { setError((failure as Error).message); }
  }
  async function openVoiceParticipantMenu(anchor: HTMLElement, target: VoiceSidebarTarget) {
    if (menu?.anchor === anchor) { setMenu(undefined); return; }
    const { left, bottom } = anchor.getBoundingClientRect();
    const profileId = voiceProfile(target);
    const { volume = 1, muted = false } = (profileId ? peerAudio[`${target.serverId}:${profileId}`] :
      voice?.serverId === target.serverId && voice.channelId === target.sourceChannelId ? pendingPrefs?.[target.targetSessionId] : undefined) ?? {};
    const local = { label: t(muted ? 'Снова слышать участника' : 'Не слышать участника'),
      action: () => changeProtectedPersonAudio(target, volume, !muted) };
    const opening = { x: left, y: bottom + 4, anchor, items: [local, { label: t('Загрузка…'), disabled: true, action() {} }] };
    setMenu(opening);
    const restrictions = await membership<VoiceRestrictionChoice[]>('voice.protected.restriction-choices', target).catch(() => []);
    const items: MenuItem[] = [local];
    for (const choice of restrictions) items.push({
      label: voiceRestrictionLabel(choice), danger: choice.action === 'voice.disconnect' || !!choice.serverWide,
      action() {
        void membership(choice.action === 'voice.disconnect' ? 'voice.protected.disconnect' : 'voice.protected.restriction',
          { ...target, ...choice }).catch(failure => setError((failure as Error).message));
      },
    });
    setMenu(previous => previous === opening ? { ...opening, items } : previous);
  }
  function startVoiceParticipantDrag(event: React.DragEvent, target: VoiceSidebarTarget) {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(voiceParticipantDragType, 'move');
    const drag = { target, choices: membership<string[]>('voice.protected.move-choices', target).catch(() => []), destinations: undefined as string[] | undefined };
    voiceParticipantDrag.current = drag;
    void drag.choices.then(destinations => { drag.destinations = destinations; });
  }
  function isVoiceParticipantDrop(event: React.DragEvent, channelId: string) {
    const drag = voiceParticipantDrag.current;
    return drag && drag.target.serverId === selected && drag.destinations?.includes(channelId) &&
      event.dataTransfer.types.includes(voiceParticipantDragType) ? drag.target : undefined;
  }
  const voiceProfiles = useProtectedProfileAppearances(
    !protectedOffline && protectedState ? selected : undefined,
    protectedState?.canListMembers ? undefined : protectedText?.id,
    protectedChannels.flatMap(channel => channel.voiceParticipants?.map(person => person.profileId) ?? []),
    true,
  );
  const people = snapshot.people.map(person => {
    if (activeProtectedState) {
      const presence = activeVoiceMembers?.find(member => member.sessionId === person.id);
      const profile = presence && voice?.serverId === selected
        ? voiceProfiles?.get(presence.profileId) ?? channelProfiles?.get(presence.profileId) : undefined;
      // Track and transport permissions can lag behind a server restriction change.
      const selfDeafened = person.local ? deafened : !!presence?.selfDeafened;
      const selfMuted = person.local ? muted : !!presence?.selfMuted;
      return { ...person, name: person.local ? activeVoiceProfile?.name ?? person.name : profile?.name ?? presence?.name ?? person.name,
        avatar: person.local ? activeOwnAvatar : profile?.avatar ?? person.avatar,
        muted: selfMuted || selfDeafened || !!presence?.muted || !!presence?.deafened,
        deafened: selfDeafened || !!presence?.deafened,
        serverMuted: presence?.serverMuted, serverDeafened: presence?.serverDeafened };
    }
    const presence = onlineVoice?.voice.find(item => item.identity === person.id);
    const profile = presence && onlineVoice && profileFor(onlineVoice, presence.profileId);
    return profile ? { ...person, name: profile.nickname, avatar: profile.avatar } : person;
  });
  const ownVoiceRestriction = activeVoiceMembers?.find(member => member.profileId === activeProtectedState?.profileId);
  const serverMicOff = !!(ownVoiceRestriction?.serverMuted || ownVoiceRestriction?.serverDeafened);
  const serverSoundOff = !!ownVoiceRestriction?.serverDeafened;
  const micRestricted = serverMicOff || !!(ownVoiceRestriction?.muted || ownVoiceRestriction?.deafened);
  const soundRestricted = serverSoundOff || !!ownVoiceRestriction?.deafened;
  const micOff = muted || micRestricted;
  const soundOff = deafened || soundRestricted;
  const canLiftOwn = !!(activeProtectedState?.canLiftOwnVoiceRestriction && ownVoiceRestriction?.sessionId && voice);
  const canLiftOwnServer = !!(activeProtectedState?.canLiftOwnServerVoiceRestriction && ownVoiceRestriction?.sessionId && voice);
  const canLiftMic = ownVoiceRestriction?.serverMuted ? canLiftOwn || canLiftOwnServer : canLiftOwn && !!ownVoiceRestriction?.muted;
  const canLiftSound = serverSoundOff ? canLiftOwn || canLiftOwnServer : canLiftOwn && soundRestricted;
  const liftOwnVoice = (action: 'voice.mute' | 'voice.deafen', serverWide: boolean) => {
    if (!voice || !ownVoiceRestriction?.sessionId) return;
    void membership('voice.protected.restriction', { serverId: voice.serverId, sourceChannelId: voice.channelId,
      targetSessionId: ownVoiceRestriction.sessionId, action, lift: true, serverWide }).catch(failure => setError((failure as Error).message));
  };
  const micTitle = t(serverMicOff ? 'Микрофон отключён на сервере' : micRestricted ? 'Микрофон отключён в этом канале' : 'Микрофон');
  const soundTitle = t(serverSoundOff ? 'Звук отключён на сервере' : soundRestricted ? 'Звук отключён в этом канале' : 'Звук');
  const micControl: MenuItem = {
    label: micRestricted && !canLiftMic ? micTitle : t(micOff ? 'Включить микрофон' : 'Выключить микрофон'),
    icon: micOff ? 'mic-off' : 'mic', disabled: micRestricted && !canLiftMic,
    action: () => canLiftMic ? liftOwnVoice('voice.mute', !!ownVoiceRestriction?.serverMuted) : toggleMic(),
  };
  const soundControl: MenuItem = {
    label: soundRestricted && !canLiftSound ? soundTitle : t(soundOff ? 'Включить звук' : 'Выключить звук'),
    icon: soundOff ? 'headphones-off' : 'headphones', disabled: soundRestricted && !canLiftSound,
    action: () => canLiftSound ? liftOwnVoice('voice.deafen', serverSoundOff) : toggleSound(),
  };
  function openOwnVoiceMenu(anchor: HTMLElement) {
    const { left, bottom } = anchor.getBoundingClientRect();
    setMenu(previous => previous?.anchor === anchor ? undefined :
      { x: left, y: bottom + 4, anchor, items: [micControl, soundControl] });
  }
  const audioControls = <>
    <AudioQuickMenu kind="input" settings={settings} update={update} devices={devices} onOpen={refreshDevices}>
      <button className={`icon-button ${serverMicOff ? "text-error" : micOff ? "member-audio-off" : ""}`}
        aria-label={micControl.label} title={micTitle} disabled={micControl.disabled} aria-pressed={micOff}
        onClick={micControl.action}>
        <Icon size={18} name={micOff ? "mic-off" : "mic"}/>
      </button>
    </AudioQuickMenu>
    <AudioQuickMenu kind="output" settings={settings} update={update} devices={devices} onOpen={refreshDevices}>
      <button className={`icon-button ${serverSoundOff ? "text-error" : soundOff ? "member-audio-off" : ""}`}
        aria-label={soundControl.label} title={soundTitle} disabled={soundControl.disabled} aria-pressed={soundOff}
        onClick={soundControl.action}>
        <Icon size={18} name={soundOff ? "headphones-off" : "headphones"}/>
      </button>
    </AudioQuickMenu>
  </>;
  const callControls = <div className="member-call-controls call-controls">{audioControls}
    {voice && <button className="icon-button call-leave member-voice-disconnect" title={t("Отключиться от голоса")}
      aria-label={t("Отключиться от голоса")} onClick={() => void disconnectVoice().catch(error => setError(error.message))}>
      <Icon size={18} name="exit"/>
    </button>}
  </div>;
  const hoveredServer = preview && servers.find(server => server.serverId === preview.serverId);
  const hoveredProtectedState = hoveredServer && !offlineProtectedServers[hoveredServer.serverId]
    ? protectedStates[hoveredServer.serverId] : undefined;
  const previewedCall = voice && hoveredProtectedState?.serverId === voice.serverId &&
    snapshot.state === 'connected' && voiceProtection?.serverId === voice.serverId && voiceProtection.channelId === voice.channelId
    ? { channelId: voice.channelId, people } : undefined;
  const serverLayout = <div className="server-app" onKeyDown={event=>{if(event.key==='Escape')setPreview(undefined);}}>
    <nav className="member-rail" aria-label={t('Серверы')} inert={!!activeRoleView}><button className={`member-orb member-home ${!selected ? 'selected' : ''}`} aria-label={t('Главная')} title={t('Главная')} onClick={() => setSelected('')}><Icon name="paw" size={28}/></button><div className="member-rail-line"/><div className="member-server-list" {...serverDrag.list}>{servers.map(server => {
      const count = Object.entries(unread).filter(([key]) => key.startsWith(server.serverId + ':')).reduce((total, [, value]) => total + value, 0);
      const avatar = protectedStates[server.serverId]?.communityAvatar?.avatar ?? states[server.serverId]?.avatar;
      return <button draggable {...serverDrag.item(server.serverId)} onDragStart={event=>{serverDrag.start(event,server.serverId);setPreview(undefined);}} onDragEnd={serverDrag.end} className={`member-orb ${selected === server.serverId ? 'selected' : ''}`} key={server.serverId} aria-label={`${server.name}${isServerMuted(server.serverId)?` · ${t('Уведомления отключены')}`:''}`} aria-describedby={preview?.serverId===server.serverId?'server-voice-preview':undefined} onMouseEnter={event=>{if(serverDrag.suppressClick())return;const box=event.currentTarget.getBoundingClientRect();setPreview({serverId:server.serverId,anchor:{right:box.right,top:box.top}});}} onMouseLeave={()=>setPreview(undefined)} onFocus={event=>{const box=event.currentTarget.getBoundingClientRect();setPreview({serverId:server.serverId,anchor:{right:box.right,top:box.top}});}} onBlur={()=>setPreview(undefined)} onClick={() => {if(serverDrag.suppressClick())return;setPreview(undefined); openServer(server.serverId); setError(''); }} onContextMenu={event => serverMenu(event, server)}>{avatar?<img className="member-server-avatar" src={avatar} alt=""/>:server.name.slice(0, 2).toUpperCase()}<i className={`member-status ${server.status}`}/>{count > 0 && <b className={`member-unread-badge ${isServerMuted(server.serverId)?'notifications-muted':''} ${Object.entries(mentionIDs).some(([key,ids])=>key.startsWith(server.serverId+':')&&ids.length)?'has-mention':''}`}>{count > 99 ? '99+' : count}</b>}</button>;
    })}</div><button className="member-orb" aria-label={t('Присоединиться к серверу')} title={t('Присоединиться к серверу')} onClick={() => { setAddress(''); setModal('join'); }}><Icon name="plus"/></button><div className="member-rail-actions"><UpdateNotice blocked={onboarding||!!bindingServer||(!!modal&&modal!=='settings')||!!addressServer||!!renameServer||!!channelDialog||!!moderation||!!leaveServer||!!muteServer||busy} active={active} hosting={hostRunning}/><button className="icon-button member-rail-settings" aria-label={t('Настройки')} title={t('Настройки')} onClick={() => setModal('settings')}><Icon name="settings"/></button></div></nav>
    <aside id="server-channels" className="member-channels" style={{width:sidebarPixels}}><div className="member-server-title">
      {protectedState ? <button className="protected-server-title" aria-haspopup="menu" aria-expanded={!!menu?.anchor}
        aria-disabled={!!activeRoleView} onClick={activeRoleView ? undefined : openProtectedServerMenu}>
        <span>{protectedState.community?.name ?? record?.name ?? t('Сервер')}</span><Icon name="chevron" size={16}/>
      </button> : <strong>{state?.name || record?.name || 'PawTalk'}</strong>}
      {displayedCanListInvites && <button className="icon-button" title={t('Пригласить участников')} disabled={!!activeRoleView}
        aria-label={t('Пригласить участников')} onClick={() => setModal('protected-invites')}><Icon name="invite" size={18}/></button>}
      {!protectedState && record && <button className="icon-button" aria-label={t('Меню сервера')} onClick={event => serverMenu(event, record)}><Icon name="more" size={18}/></button>}</div>
      {!activeRoleView && selfTimeout && <div className="member-empty protected-self-timeout" role="status">
        <p>{t('Тайм-аут на сервере до {0}', new Date(selfTimeout.deadline).toLocaleString())}</p>
        {selfTimeout.reason && <p>{t('Причина: {0}', selfTimeout.reason)}</p>}
        {selfTimeout.canLift && protectedState && editTimeout &&
          <Button onClick={() => editTimeout(protectedState.profileId, t('Вы'))}>{t('Снять тайм-аут')}</Button>}
      </div>}
      <div className="member-channel-scroll" {...(!activeRoleView && protectedState && categoryDrag.list)} onContextMenu={event => {
        if (activeRoleView || !protectedState || event.target !== event.currentTarget) return;
        const items = protectedSidebarActions();
        if (protectedState.canListInvites) items.push({ label: t('Пригласить участников'), action: () => setModal('protected-invites') });
        if (items.length) context(event, items);
      }}>{protectedState ? protectedChannelGroups.map(({ id: categoryId, label, channels }) => {
        const dropChannel = draggedProtectedChannel && (draggedProtectedChannel.categoryId || '') !== categoryId
          ? draggedProtectedChannel : undefined;
        return (channels.length > 0 || !!categoryId || !!dropChannel) && <section
          className={`member-channel-group ${categoryId ? 'protected-category-group' : 'protected-root-channels'}`} key={categoryId || 'root'}
          {...(!activeRoleView && categoryId && categoryDrag.item(categoryId))}
          data-channel-drop-target={dropChannel ? '' : undefined}
          onDragOver={event => {
            if (!dropChannel || !event.dataTransfer.types.includes(protectedChannelDragType)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }}
          onDrop={event => {
            if (!dropChannel || !event.dataTransfer.types.includes(protectedChannelDragType)) return;
            event.preventDefault();
            setProtectedDrag(undefined);
            setProtectedChannelDialog({ serverId: selected, channel: dropChannel, initialMoveCategoryId: categoryId });
          }}>
          {categoryId ? <div className="member-channel-caption"
            onContextMenu={event => {
              if (activeRoleView || !protectedState.canManageChannels) return;
              event.stopPropagation();
              const open = (mode: 'edit' | 'delete') =>
                setProtectedCategories({ serverId: selected, target: { id: categoryId, name: label, mode } });
              context(event, [
                { label: t('Редактировать категорию'), action: () => open('edit') },
                { label: t('Удалить категорию'), danger: true, action: () => open('delete') },
              ]);
            }}>
            <h2 draggable={canDragProtectedChannel} onDragStart={event => categoryDrag.start(event, categoryId)}
              onDragEnd={categoryDrag.end}>{label}</h2>
            {displayedCanManageChannels && <button className="icon-button" title={t('Создать канал')} aria-label={t('Создать канал')} disabled={!!activeRoleView}
              onClick={() => setProtectedChannelDialog({ serverId: selected, initialCategoryId: categoryId })}>
              <Icon name="plus" size={16}/>
            </button>}
          </div> : !channels.length && <p className="protected-root-drop-label">{label}</p>}
          <ProtectedChannelList channels={channels} onReorder={(ids, moved) => {
            if (!activeRoleView) void reorderProtected(channels, ids, moved);
          }}
            renderChannel={(channel, drag) => {
            const inVoice = !activeRoleView && channel.kind === 'voice' && voice?.serverId === selected && voice.channelId === channel.id;
            const active = displayedChannel?.id === channel.id || inVoice;
            const voiceMembers = activeRoleView || channel.kind !== 'voice' ? [] : inVoice ? people.map(person => ({
              id: person.id, sessionId: person.id, name: person.name, avatar: person.avatar, local: person.local,
              speaking: person.speaking, muted: person.muted, deafened: person.deafened,
              serverMuted: person.serverMuted, serverDeafened: person.serverDeafened,
            })) : (channel.voiceParticipants ?? []).map(({ profileId, sessionId, name, muted, deafened, serverMuted, serverDeafened, selfMuted, selfDeafened }) => {
              const profile = voiceProfiles?.get(profileId) ?? channelProfiles?.get(profileId);
              const local = profileId === protectedState.profileId;
              return { id: profileId, sessionId, name: profile?.name || name || t('Участник'), avatar: local ? ownAvatar : profile?.avatar,
                local, speaking: false, muted: muted || selfMuted || deafened || selfDeafened,
                deafened: deafened || selfDeafened, serverMuted, serverDeafened };
            });
            const voiceCapacity = channel.kind === 'voice' && !activeRoleView && !protectedOffline ? channel.settings?.voiceCapacity : 0;
            const occupied = inVoice ? people.length : channel.voiceParticipants?.length;
            const permission = roleView?.channels.find(item => item.id === channel.id);
            const locked = permission && (channel.kind === 'voice' ? !permission.canConnect : !permission.canSend);
            const channelKey = `${selected}:${channel.id}`;
            const unreadCount = activeRoleView ? 0 : unread[channelKey] ?? 0;
            const hasMention = (mentionIDs[channelKey]?.length ?? 0) > 0;
            const muted = notificationsMuted(selected, channel.id);
            return <>
            <div className="protected-channel-row" data-selected={displayedChannel?.id === channel.id}
              data-voice-drop={voiceDropChannel === channel.id || undefined}
              onDragOver={event => {
                if (channel.kind !== 'voice' || activeRoleView || !isVoiceParticipantDrop(event, channel.id)) return;
                event.preventDefault(); event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                setVoiceDropChannel(channel.id);
              }} onDragLeave={event => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  setVoiceDropChannel(previous => previous === channel.id ? undefined : previous);
                }
              }} onDrop={event => {
                if (channel.kind !== 'voice' || activeRoleView) return;
                const target = isVoiceParticipantDrop(event, channel.id);
                if (!target) return;
                event.preventDefault(); event.stopPropagation();
                voiceParticipantDrag.current = undefined;
                setVoiceDropChannel(undefined);
                void moveVoiceParticipant(target, channel.id);
              }}
              onContextMenu={activeRoleView ? undefined : event => protectedChannelMenu(event, channel)}>
            <button className={`member-channel ${active ? 'selected' : ''} ${unreadCount && (!muted || hasMention) ? 'has-unread' : ''}`}
              draggable={!activeRoleView && !protectedOffline && (canDragProtectedChannel || !!channel.canOrder)}
              onDragStart={event => {
                if (activeRoleView || protectedOffline || protectedOrderPending.current || !canDragProtectedChannel && !channel.canOrder) {
                  event.preventDefault(); return;
                }
                drag.start(event, channel.id);
                if (canDragProtectedChannel && !event.defaultPrevented) {
                  event.dataTransfer.setData(protectedChannelDragType, channel.id);
                  setProtectedDrag({ serverId: selected, channelId: channel.id });
                }
              }}
              onDragEnd={() => { drag.end(); setProtectedDrag(undefined); }}
              aria-current={displayedChannel?.id === channel.id ? 'true' : undefined}
              aria-disabled={channel.kind === 'voice' && locked || undefined}
              disabled={!activeRoleView && channel.kind === 'voice' && (busy || !!selfTimeout || protectedOffline)}
              onClick={() => {
                if (activeRoleView) {
                  if (channel.kind === 'voice' && !permission?.canConnect) return;
                  setRoleViewChannelId(channel.id);
                  if (channel.kind === 'text') setRoleViewTextId(channel.id);
                  return;
                }
                if (drag.suppressClick()) return;
                setProtectedChannelIds(previous => ({ ...previous, [selected]: channel.id }));
                if (channel.kind === 'voice' && (voice?.serverId !== selected || voice.channelId !== channel.id)) {
                  void joinProtectedVoice(selected, channel.id);
                }
              }}>
              <span>{channel.name ?? channel.id}</span>
              {locked && <span className="protected-channel-locked" title={t(channel.kind === 'voice'
                ? 'У роли нет права подключаться к голосовому каналу.' : 'У роли нет права отправлять сообщения.')}>
                <Icon name="lock" size={15}/>
              </span>}
              {!activeRoleView && favoriteChannels[`${selected}:${channel.id}`] && <span className="protected-channel-favorite" aria-label={t('Избранное')}>
                <Icon name="star" size={14}/>
              </span>}
              {unreadCount > 0 && <b className={`member-channel-count ${muted && !hasMention ? 'notifications-muted' : ''} ${hasMention ? 'has-mention' : ''}`}>
                {unreadCount > 99 ? '99+' : unreadCount}
              </b>}
              {!!voiceCapacity && occupied !== undefined && <b className="member-channel-count member-channel-capacity">
                {occupied} / {voiceCapacity}
              </b>}
            </button>
            {channel.kind === 'voice'
              ? <ProtectedVoiceStatus status={!activeRoleView && scopedVoiceProtection?.channelId === channel.id ? scopedVoiceProtection : undefined}/>
              : <ProtectedTextStatus status={!activeRoleView && textScope?.channelId === channel.id ? textProtection : undefined}/>}
            {(displayedCanManageChannels || channel.canEditSettings || channel.canInspectACL) &&
              <button className="icon-button protected-channel-settings" aria-label={t('Настройки канала')} disabled={!!activeRoleView}
                title={t('Настройки канала')} onClick={() => openProtectedChannelSettings(channel)}>
                <Icon name="settings" size={16}/>
              </button>}
            </div>
            {voiceMembers.length > 0 && <ul className="protected-voice-members">{voiceMembers.map(person => {
              const target = (!person.local || inVoice) && !protectedOffline && person.sessionId ? {
                serverId: selected, sourceChannelId: channel.id, targetSessionId: person.sessionId,
              } : undefined;
              return <li key={person.id} className="member-channel-person protected-voice-member" title={person.name}
                data-speaking={person.speaking && !person.muted || undefined} draggable={!!target}
                data-muted={person.muted || person.deafened || person.serverMuted || person.serverDeafened || undefined}
                data-self={person.local || undefined} tabIndex={target ? 0 : undefined}
                onDragStart={target ? event => startVoiceParticipantDrag(event, target) : undefined}
                onDragEnd={() => { voiceParticipantDrag.current = undefined; setVoiceDropChannel(undefined); }}
                onContextMenu={target ? event => {
                  event.preventDefault(); event.stopPropagation();
                  if (person.local) openOwnVoiceMenu(event.currentTarget);
                  else void openVoiceParticipantMenu(event.currentTarget, target);
                } : undefined}
                onKeyDown={target ? event => {
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                  event.preventDefault(); event.stopPropagation();
                  if (person.local) openOwnVoiceMenu(event.currentTarget);
                  else void openVoiceParticipantMenu(event.currentTarget, target);
                } : undefined}>
                <Avatar name={person.name} image={person.avatar}/>
                <span className="protected-voice-member-name">{person.name}</span>
                <AudioStatusIcons size={12} muted={person.muted} deafened={person.deafened}
                  serverMuted={person.serverMuted} serverDeafened={person.serverDeafened}/>
              </li>;
            })}</ul>}
            </>;
            }}/>
        </section>;
      }) : selected ? !state ? <p className="member-empty" role="status">{t('Подключение…')}</p> : <>{(['voice', 'text'] as const).map(kind => <section className="member-channel-group" key={kind} {...(kind==='voice'?voiceDrag:textDrag).list}><div className="member-channel-caption"><h2>{kind === 'voice' ? t('Голосовые каналы') : t('Текстовые чаты')}</h2>{admin && <button className="icon-button" title={t('Создать канал')} aria-label={t('Создать канал')} onClick={() => { setChannelName(''); setChannelDialog({ kind }); }}><Icon name="plus" size={16}/></button>}</div>{state.channels.filter(channel => channel.kind === kind).map(channel => <div key={channel.id} {...(kind==='voice'?voiceDrag:textDrag).item(channel.id)}><button draggable={admin} onDragStart={event=>{if(!admin){event.preventDefault();return;}(kind==='voice'?voiceDrag:textDrag).start(event,channel.id);}} onDragEnd={(kind==='voice'?voiceDrag:textDrag).end} className={`member-channel ${(unread[`${selected}:${channel.id}`]||0)>0&&!notificationsMuted(selected,channel.id)?'has-unread':''} ${(kind === 'text' && chat?.id === channel.id) || (kind === 'voice' && voice?.serverId === selected && voice.channelId === channel.id) ? 'selected' : ''}`} disabled={busy && kind === 'voice'} onClick={() => { if((kind==='voice'?voiceDrag:textDrag).suppressClick())return; if (kind === 'voice') { if (!(voice?.serverId === selected && voice.channelId === channel.id)) void joinVoice(channel); } else { setChatIDs(previous => ({ ...previous, [selected]: channel.id }));  } }} onContextMenu={event => channelMenu(event, channel)}><Icon name={kind === 'voice' ? 'sound' : 'chat'} size={18}/><span>{channel.name}</span>{(unread[`${selected}:${channel.id}`] || 0) > 0 && <b className={`member-channel-count ${notificationsMuted(selected,channel.id)?'notifications-muted':''} ${mentionIDs[`${selected}:${channel.id}`]?.length?'has-mention':''}`}>{unread[`${selected}:${channel.id}`]}</b>}</button>{kind === 'voice' && <AvatarStrip className="member-channel-people" size={23}>{state.voice.filter(presence => presence.channelId === channel.id).map(presence => { const profile = profileFor(state, presence.profileId), person = voice?.serverId === selected && voice.channelId === channel.id ? snapshot.people.find(person => person.id === presence.identity) : undefined, speaking = person?.speaking && !person.muted; return <span title={profile?.nickname} aria-label={profile?.nickname||t('Участник')} className={`member-channel-person ${speaking ? 'speaking' : ''}`} key={presence.deviceId}><Avatar name={profile?.nickname || t('Участник')} image={profile?.avatar}/><AudioStatusIcons className="member-channel-audio-status" size={10} muted={person?.muted} deafened={person?.deafened}/></span>; })}</AvatarStrip>}</div>)}</section>)}</> : <div className="member-home-navigation"><button onClick={() => setModal('join')}><Icon name="invite"/>{t('Присоединиться')}</button><button onClick={() => setModal(hostRunning ? 'host-share' : 'create')}><Icon name="plus"/>{hostRunning ? t('Мой сервер') : t('Создать сервер')}</button></div>}</div>
      <div className="member-user-panel" inert={!!activeRoleView} onContextMenu={event => { if (activeRoleView) return; if (state) memberMenu(event, state.self.effectiveProfileId); else context(event,[{label:t('Скопировать ID профиля'),action:()=>void membership<{profileId:string}>('identity').then(value=>membership('copy',{text:value.profileId})).catch(error=>setError(error.message))}]); }}><div className="member-user-identity"><button className="member-user-name" onClick={() => setModal('settings')}><span className="member-avatar-wrap"><Avatar name={own?.nickname || ownProtectedProfile?.name || nickname} image={state ? own?.avatar : ownAvatar}/><i className={`member-status ${selected&&record?.status!=='online'?'offline':idle?'away':'online'}`}/></span><span className="member-user-text"><strong>{own?.nickname || ownProtectedProfile?.name || nickname}</strong><small>{selected ? record?.status === 'online' ? idle?t('Отошел'):t('В сети') : t('Нет соединения') : idle?t('Отошел'):t('В сети')}</small></span></button></div><div className="member-audio-buttons">{!activeRoleView&&voice&&<ConnectionStatus name={onlineVoice?.name||nickname} delay={snapshot.rtt} loss={snapshot.packetLoss} diagnostics={snapshot.people.find(person=>person.local)?.diagnostics}/>}{audioControls}{!activeRoleView&&voice&&<button className="icon-button text-error member-voice-disconnect" title={t('Отключиться от голоса')} aria-label={t('Отключиться от голоса')} onClick={()=>void disconnectVoice().catch(error=>setError(error.message))}><Icon size={18} name="exit"/></button>}</div></div>
    </aside>
    <div className="member-sidebar-divider" role="separator" aria-orientation="vertical" aria-label={t('Ширина меню сервера')} aria-controls="server-channels" aria-valuemin={220} aria-valuemax={maxSidebar} aria-valuenow={sidebarPixels} tabIndex={0}
      onPointerDown={event=>{if(event.button!==0||!event.isPrimary)return;event.preventDefault();event.currentTarget.focus({preventScroll:true});event.currentTarget.setPointerCapture(event.pointerId);resizeOffset.current=event.clientX-event.currentTarget.getBoundingClientRect().left;}}
      onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId)){const left=event.currentTarget.parentElement!.getBoundingClientRect().left;setSidebarWidth(Math.max(220,Math.min(maxSidebar,event.clientX-left-74-resizeOffset.current)));}}}
      onKeyDown={event=>{const sizes:Record<string,number>={ArrowLeft:sidebarPixels-16,ArrowRight:sidebarPixels+16,Home:220,End:maxSidebar};if(sizes[event.key]!==undefined){event.preventDefault();setSidebarWidth(Math.max(220,Math.min(maxSidebar,sizes[event.key])));}}}
      onDoubleClick={()=>setSidebarWidth(272)}/>
    <main className="member-main">{selected && state ? <div className="member-workspace"><div className="member-content"><RoomSplit visible={!!(voice?.serverId === selected && active)} participants={<><Participants people={people} prefs={personPrefs} onChange={changePersonAudio}/>{callControls}</>} chat={chat ? <ServerChat key={`${selected}:${chat.id}`} state={state} channel={chat} focused={contentFocused} onViewport={latest=>viewports.current.set(`${selected}:${chat.id}`,latest)} onRead={last => {acknowledgeNotifications(selected,chat.id,last);setMentionIDs(values=>({...values,[`${selected}:${chat.id}`]:(values[`${selected}:${chat.id}`]||[]).filter(id=>id>last)}));if(last>=chat.lastMessageId)setUnread(previous => ({ ...previous, [`${selected}:${chat.id}`]: 0 }));}} onError={setError}/> : <p className="member-empty">{t('Нет доступных текстовых каналов.')}</p>}/></div><MemberRosterPanel open={roster} toggle={() => setRoster(value => !value)}><h2>{t('Участники — {0}', state.members.length)}</h2>{[...state.members].sort((a, b) => Number(b.online) - Number(a.online)).map(member => { const profile = profileFor(state, member.profileId); return <button draggable onDragStart={event=>{setMemberDrag(event.dataTransfer, state.serverId, member.profileId);setTransparentDragImage(event);}} className={`member-roster-person ${member.online ? '' : 'offline'}`} key={member.profileId} onContextMenu={event => memberMenu(event, member.profileId)} onClick={event => memberMenu(event, member.profileId)}><span className="member-avatar-wrap"><Avatar name={profile?.nickname || t('Участник')} image={profile?.avatar}/><i className={`member-status ${member.online ? member.away?'away':'online' : 'offline'}`}/></span><span className="member-roster-label"><span className="member-roster-nickname">{profile?.nickname || t('Участник')}</span>{effectiveProfile(state,member.profileId)===state.self.effectiveProfileId&&<small className="member-self-pin">{t('Вы')}</small>}</span>{member.role !== 'member' && <Icon name="shield" size={13}/>}</button>; })}</MemberRosterPanel></div> : protectedState ? displayedChannel ? <>
      <div className="member-workspace">
        <div className="member-content">
          {!activeRoleView && selectedProtectedChannel?.kind === 'voice' && busy && voice?.channelId !== selectedProtectedChannel.id &&
            <p className="member-empty" role="status">{t('Подключение…')}</p>}
          <RoomSplit visible={activeRoleView ? !!previewVoice : !!(voice?.serverId === selected && active)}
          participants={activeRoleView ? <div inert>
            <Participants people={[]} prefs={{}} onChange={() => {}}/>
            <div className="member-call-controls call-controls">
              <button className="icon-button" disabled aria-label={t('Микрофон')}><Icon name="mic" size={18}/></button>
              <button className="icon-button" disabled aria-label={t('Звук')}><Icon name="headphones" size={18}/></button>
            </div>
          </div> : <>{voice?.serverId === selected && <Participants people={people} prefs={personPrefs} onChange={changePersonAudio}
            moderation={{ serverId: selected, sourceChannelId: voice.channelId }}/>}
            {callControls}</>}
          chat={activeRoleView ? previewText ?
            <ProtectedChatPreview key={previewText.id} channelName={displayedChannels.find(channel => channel.id === previewText.id)?.name ?? previewText.id}
              canSend={previewText.canSend} canAttach={previewText.canAttach}/>
            : !previewVoice && previewChannel?.kind === 'voice' && !previewChannel.canConnect
              ? <p className="member-empty protected-chat-preview-locked"><Icon name="lock" size={18}/>
                {t('У роли нет права подключаться к голосовому каналу.')}</p> : null
            : visibleProtectedText ?
        <ProtectedChat key={protectedDraftKey} serverId={selected} channelId={visibleProtectedText.id}
          cache={protectedChatCache.current} cacheKey={protectedDraftKey}
          channelName={visibleProtectedText.name ?? visibleProtectedText.id} draft={protectedDrafts[protectedDraftKey]} timedOut={!!selfTimeout} eventsLive={protectedState.eventsLive}
          authorNames={channelProfiles} authorRosterCursor={channelRoster?.cursor}
          ownProfileId={protectedState.profileId} ownAvatar={ownAvatar} composerEvents={protectedState.composerEvents}
          onRead={position => clearProtectedUnread(selected, visibleProtectedText.id, position)}
          offline={protectedOffline} pauseSending={textProtection?.state === 'red'} protection={textProtection}
          keysPending={visibleProtectedText.keysPending}
          mediaVariants={protectedState.mediaVariants}
          changeDraft={(text, mentions) => {
            const draft = text ? { text, mentions, operationId: crypto.randomUUID().replaceAll('-', '') } : undefined;
            setProtectedDrafts(previous => {
              if (draft) return { ...previous, [protectedDraftKey]: draft };
              const next = { ...previous };
              delete next[protectedDraftKey];
              return next;
            });
          }}
          clearDraft={operationId => setProtectedDrafts(previous => {
            if (previous[protectedDraftKey]?.operationId !== operationId) return previous;
            const next = { ...previous };
            delete next[protectedDraftKey];
            return next;
          })}
          setDeferred={(operationId, deferred) => setProtectedDrafts(previous => {
            const draft = previous[protectedDraftKey];
            if (draft?.operationId !== operationId) return previous;
            return { ...previous, [protectedDraftKey]: { ...draft, deferred } };
          })}/> : <p className="member-empty">{t('Нет доступных текстовых каналов.')}</p>}/>
        </div>
        <MemberRosterPanel open={activeRoleView ? roleViewRoster : roster}
          toggle={() => activeRoleView ? setRoleViewRoster(value => !value) : setRoster(value => !value)}
          scoped={activeRoleView ? !!previewText : !!protectedText}>
          {activeRoleView ? <ProtectedRoster key={previewRosterChannel?.id} serverId={selected} profileId={protectedState.profileId} ownAvatar={ownAvatar}
            previewMembers={previewRosterChannel?.members.map(member => {
              const known = previewKnownProfiles?.get(member.id);
              return { id: member.id, name: known?.name ?? member.name, avatar: known?.avatar };
            }) ?? []}/>
            : !protectedOffline && (protectedText || protectedState.canListMembers)
            ? <ProtectedRoster key={`${selected}:${protectedText?.id ?? ''}`}
                eventsLive={protectedState.eventsLive} onProfiles={protectedProfilesChanged}
                serverId={selected} channelId={protectedText?.id} profileId={protectedState.profileId} ownAvatar={ownAvatar}
                onTimeout={editTimeout} onModerate={moderateProtected} onOpenProfileDevices={openProfileDevices}
                onAssignRoles={protectedState.canAssignRoles ? (profileId, profileName) =>
                  setScopedAssignment({ serverId: selected, profileId, profileName, channelId: protectedText?.id }) : undefined}
                onPersonalACL={protectedText?.canInspectACL && !protectedState.canManageChannels ? (profileId, profileName) =>
                  setScopedPersonalACL({ serverId: selected, channelId: protectedText.id, profileId, profileName }) : undefined}/>
            : <p className="member-empty">{t('Нет доступных участников')}</p>}
        </MemberRosterPanel>
      </div>
    </> : <div className="member-content">
      {!activeRoleView && protectedState.joinPending && !protectedOffline ? <ProtectedHistoryLoading keysPending/> :
      <p className="member-empty" role={roleViewResult?.error ? 'alert' : 'status'}>{activeRoleView
        ? roleViewResult?.error ?? t(roleView ? 'Нет доступных каналов.' : 'Подключение…')
        : protectedState.joinPending
        ? t('Вы присоединились. Подготавливается защищённый доступ.')
        : t('Нет доступных текстовых каналов.')}</p>}
      {!activeRoleView && (protectedState.canManageChannels || protectedState.canEditRoles) && <div className="modal-actions">
        {protectedState.canManageChannels && <Button onClick={() => setProtectedChannelDialog({ serverId: selected })}>{t('Создать канал')}</Button>}
        <Button onClick={() => setProtectedRolesServer(selected)}>{t('Роли')}</Button>
      </div>}
    </div> : selected ? <div className="member-welcome"><Icon name="paw" size={70}/><h1>{record?.name || t('Сервер')}</h1>
      {migrationServers[selected] ? <>
        <p>{t('Сервер ждёт подтверждения владельца для перехода на API 3.')}</p>
        <Button variant="primary" onClick={() => setMigrationDialog(selected)}>{t('Перенос сервера на API 3')}</Button>
      </> : <p>{t('Ожидаем соединения с сервером…')}</p>}
    </div> : <HomeScreen hosting={hostRunning} disabled={busy} onJoin={() => setModal('join')} onHost={() => setModal(hostRunning ? 'host-share' : 'create')}/> }</main>
  </div>;
  return <>
    {!activeRoleView && serverLayout}
    {migrationDialog && <StandaloneMigrationDialog key={migrationDialog} serverId={migrationDialog}
      onClose={() => setMigrationDialog(undefined)} onApplied={() => { void refresh(); }}/>}
    {protectedState && serverSettingsTab && serverSettings?.serverId === selected &&
      <Modal fullPage title={t('Настройки сервера')} className="settings-modal protected-server-settings" onClose={() => setServerSettings(undefined)}>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t('Настройки сервера')}>
            <div className="settings-nav-caption">{protectedState.community?.name ?? record?.name}</div>
            {settingsTabs.map(tab => <button key={tab} type="button" aria-current={serverSettingsTab === tab ? 'page' : undefined}
              onClick={() => setServerSettings({ serverId: selected, tab })}>
              <Icon name={serverSettingsIcons[tab]} size={18}/><span>{t(serverSettingsLabels[tab])}</span>
            </button>)}
          </nav>
          <section className="settings-panel protected-server-settings-panel"><div className="settings-content">
            <h2>{t(serverSettingsLabels[serverSettingsTab])}</h2>
            {serverSettingsTab === 'profile' && <ProtectedServerProfile key={selected}
              serverId={selected} community={protectedState.community} fallbackName={record?.name ?? t('Сервер')}
              avatar={protectedState.communityAvatar?.avatar} editable={protectedState.canEditCommunity === true && !!protectedState.community}
              onAvatar={protectedState.canEditCommunity && protectedState.community && protectedState.communityAvatar ? () => {
                const avatar = protectedState.communityAvatar!;
                setAvatarServer({ serverId: selected, name: protectedState.community!.name, avatarRevision: avatar.revision,
                  avatar: avatar.avatar, pending: avatar.pending, protectedAccess: true });
              } : undefined}
              onSaved={community => setProtectedStates(states => {
                const state = states[selected];
                if (!state || (state.community?.revision ?? 0) > community.revision) return states;
                return { ...states, [selected]: { ...state, community } };
              })}
              onRefresh={() => { void refresh(); }}/>}
            {serverSettingsTab === 'members' && <div className="protected-server-roster"><ProtectedRoster key={selected} serverId={selected} profileId={protectedState.profileId} ownAvatar={ownAvatar}
              onTimeout={editTimeout} onModerate={moderateProtected} onOpenProfileDevices={openProfileDevices}
              onAssignRoles={protectedState.canAssignRoles ? (profileId, profileName) => setScopedAssignment({
                serverId: selected, profileId, profileName,
              }) : undefined}/></div>}
            {serverSettingsTab === 'roles' && roleEditor && !roleEditor.sourceChannelId && <ProtectedRolesDialog inline
              serverId={selected} scoped={!protectedState.canManageChannels} initialRoleId={roleEditor.roleId} entry={roleEditor.entry}
              onRoleView={openRoleView}
              footerHost={roleFooter}
              channelNames={new Map(protectedState.channels.map(channel => [channel.id, channel.name ?? channel.id]))}
              onClose={() => setRoleEditor(undefined)} onApplied={() => {
                setRoleEditor(undefined);
                setRoleListVersion(version => version + 1);
                void refresh();
              }}/>}
            {serverSettingsTab === 'roles' && !roleEditor && (protectedState.canManageChannels
              ? <ProtectedRolesSettings key={`${selected}:${roleListVersion}`} serverId={selected}
                footerHost={roleFooter} onRoleView={openRoleView} onEdit={(roleId, entry) => setRoleEditor({ roleId, entry })}/>
              : <Button onClick={() => setRoleEditor({})}>{t('Роли сервера')}</Button>)}
            {serverSettingsTab === 'invites' && <ProtectedInvitesDialog inline key={selected}
              serverId={selected} profileId={protectedState.profileId} ownAvatar={ownAvatar}
              canListMembers={protectedState.canListMembers} textChannelId={protectedText?.id}
              onClose={() => setServerSettings(undefined)}/>}
            {serverSettingsTab === 'audit' && <ProtectedAuditDialog inline key={selected} serverId={selected}
              channelNames={Object.fromEntries(protectedChannels.map(channel => [channel.id, channel.name ?? channel.id]))}
              onClose={() => setServerSettings(undefined)}/>}
            {serverSettingsTab === 'bans' && <ProtectedBansDialog inline key={selected}
              serverId={selected} onClose={() => setServerSettings(undefined)}/>}
            {serverSettingsTab === 'devices' && <div className="form-fields profile-device-actions">
              {!onlineProtectedServer && <p role="status">{t('Нет соединения с сервером.')}</p>}
              <div>
                <p>{t('Есть ещё одно устройство, которое хотите подключить к этому серверу под своим профилем?')}</p>
                <Button variant="primary" disabled={!onlineProtectedServer} onClick={() => setBindingServer(onlineProtectedServer)}>
                  {t('Добавить новое устройство')}
                </Button>
              </div>
              {onlineProtectedServer && !bindingServer && <ProtectedOwnDeviceList key={selected} serverId={selected}
                canRevoke={protectedState.canRevokeOwnDevices === true}/>}
              <div>
                <p>{t('Хотите подготовиться на случай, если потеряете доступ ко всем устройствам?')}</p>
                <Button disabled={!onlineProtectedServer} onClick={() => { setRecoveryServer(onlineProtectedServer); setModal('recovery-setup'); }}>
                  {t('Восстановление доступа')}
                </Button>
              </div>
              <details key={`advanced-${selected}`}>
                <summary>{t('Дополнительные действия')}</summary>
                <div className="form-fields">
                  <div>
                    <p>{t('У вас уже есть второй профиль на этом сервере и вы хотите пользоваться одним основным профилем?')}</p>
                    <p>{t('До подтверждения вы увидите, сколько устройств перейдёт и какие назначения ролей будут сняты.')}</p>
                    <Button disabled={!onlineProtectedServer} onClick={() => {
                      if (!onlineProtectedServer) return;
                      setProfileLinkServer({ ...onlineProtectedServer, profileId: protectedState.profileId });
                      setModal('protected-profile-link');
                    }}>{t('Объединить два существующих профиля')}</Button>
                  </div>
                  <div><Button disabled={!onlineProtectedServer} onClick={() => {
                    if (!onlineProtectedServer) return;
                    setProfileLinkServer({ ...onlineProtectedServer, profileId: protectedState.profileId });
                    setModal('protected-linked-profiles');
                  }}>{t('Связанные профили')}</Button></div>
                </div>
              </details>
            </div>}
            {serverSettingsTab === 'access' && record && <div className="form-fields">
              <div><Button disabled={voice?.serverId === selected} onClick={() => openAddressSettings(record)}>
                {t('Изменить адрес сервера')}
              </Button></div>
              {onlineProtectedServer && <>
                <div><Button onClick={() => {
                  setOwnershipServer({ ...onlineProtectedServer, profileId: protectedState.profileId });
                  setModal('protected-ownership');
                }}>{t('Передача владения')}</Button></div>
                {protectedState.canManageScopeAuthority && <div><Button onClick={() => {
                  setProfileLinkServer({ ...onlineProtectedServer, profileId: protectedState.profileId });
                  setModal('protected-scope-handover');
                }}>{t('Передать подпись подтверждений')}</Button></div>}
              </>}
            </div>}
          </div>{serverSettingsTab === 'roles' && <div className="protected-role-footer" ref={setRoleFooter}/>}</section>
        </div>
      </Modal>}
    {protectedChannelDialog?.serverId === selected && (protectedState?.canManageChannels ||
      (protectedChannelDialog.orderOnly && canShowOrderDialog)) && <ProtectedChannelDialog
      key={`${selected}:${protectedChannelDialog.channel?.id ?? 'new'}:${protectedChannelDialog.orderOnly === true}:${protectedChannelDialog.initialMoveCategoryId}`} serverId={selected}
      channel={protectedChannelDialog.channel} channels={protectedChannels} orderOnly={protectedChannelDialog.orderOnly}
      initialMoveCategoryId={protectedChannelDialog.initialMoveCategoryId}
      initialCategoryId={protectedChannelDialog.initialCategoryId} initialKind={protectedChannelDialog.initialKind}
      initialAction={protectedChannelDialog.initialAction} appearanceScope={permissionAppearance}
      addedRole={createdChannelRole?.channelId === protectedChannelDialog.channel?.id ? createdChannelRole?.roleId : undefined}
      onCreateRole={protectedChannelDialog.channel && protectedState?.canManageChannels ? () => {
        setRoleEditor({ sourceChannelId: protectedChannelDialog.channel?.id });
        setProtectedRolesServer(selected);
      } : undefined}
      onClose={() => { setCreatedChannelRole(undefined); setProtectedChannelDialog(undefined); }} onApplied={(channelId, action) => {
        if (action === 'channel.create' || action === 'channel.copy') {
          setProtectedChannelIds(previous => ({ ...previous, [selected]: channelId }));
        }
        setProtectedChannelDialog(undefined);
        setCreatedChannelRole(undefined);
        void refresh();
      }}/>}
    {scopedChannelSettings?.serverId === selected && <ProtectedScopedChannelSettingsDialog
      key={`${selected}:${scopedChannelSettings.channel.id}`} serverId={selected} channel={scopedChannelSettings.channel}
      navigation={scopedChannelNavigation(scopedChannelSettings.channel.id, 'overview')}
      canEdit={protectedChannels.some(channel => channel.id === scopedChannelSettings.channel.id && channel.canEditSettings)}
      onClose={() => setScopedChannelSettings(undefined)} onConfirmed={() => void refresh()}/>}
    {protectedDeleteChannel?.serverId === selected && protectedState?.canManageChannels &&
      <ProtectedChannelDeleteDialog key={protectedDeleteChannel.channel.id}
        serverId={selected} channel={protectedDeleteChannel.channel} onClose={() => setProtectedDeleteChannel(undefined)}
        onDeleted={() => { setProtectedDeleteChannel(undefined); void refresh(); }}/>}
    {scopedACL && canShowScopedACL &&
      <ProtectedChannelACLDialog key={`${selected}:${scopedACL.channelId}`} serverId={selected} channelId={scopedACL.channelId}
        navigation={scopedChannelNavigation(scopedACL.channelId, 'roles')}
        onClose={() => setScopedACL(undefined)}/>}
    {scopedPersonalACL && canShowScopedPersonalACL &&
      <ProtectedPersonalACLDialog key={`${selected}:${scopedPersonalACL.channelId}:${scopedPersonalACL.profileId ?? ''}`}
        {...scopedPersonalACL} navigation={scopedChannelNavigation(scopedPersonalACL.channelId, 'personal')}
        onClose={() => setScopedPersonalACL(undefined)}/>}
    {protectedState && canEditProtectedRoles && selected === protectedRolesServer && <ProtectedRolesDialog
      key={`${selected}:${!!protectedState.canManageChannels}`} serverId={selected} scoped={!protectedState.canManageChannels}
      onRoleView={openRoleView}
      initialRoleId={roleEditor?.roleId} fullPage={!!roleEditor?.sourceChannelId}
      channelNames={new Map(protectedState.channels.map(channel => [channel.id, channel.name ?? channel.id]))}
      onClose={() => { setProtectedRolesServer(''); setRoleEditor(undefined); }} onAssignments={protectedState.canManageChannels ? () => {
        setProtectedRolesServer('');
        setRoleEditor(undefined);
        setProtectedAssignmentsServer(selected);
      } : undefined} onApplied={roleId => {
        if (roleId && roleEditor?.sourceChannelId) setCreatedChannelRole({ channelId: roleEditor.sourceChannelId, roleId });
        setProtectedRolesServer('');
        setRoleEditor(undefined);
        setRoleListVersion(version => version + 1);
        void refresh();
      }}/>}
    {protectedState?.canManageChannels && selected === protectedAssignmentsServer && <ProtectedAssignmentsDialog
      key={selected} serverId={selected} onClose={() => {
        setProtectedAssignmentsServer('');
        setProtectedRolesServer(selected);
      }} onApplied={() => {
        setProtectedAssignmentsServer('');
        void refresh();
      }}/>}
    {protectedState && scopedAssignment && canShowScopedAssignment && <ProtectedAssignmentsDialog
      key={`${selected}:${scopedAssignment.channelId ?? ''}:${scopedAssignment.profileId}`} serverId={selected} target={scopedAssignment}
      onClose={() => {
        if (!scopedAssignment.channelId && serverSettings?.serverId !== selected) setProtectedMembersServer(selected);
        setScopedAssignment(undefined);
      }} onApplied={() => { setScopedAssignment(undefined); void refresh(); }}/>}
    {protectedState?.canManageChannels && protectedCategories?.serverId === selected && <ProtectedCategoriesDialog
      key={`${selected}:${protectedCategories.target?.id ?? ''}:${protectedCategories.target?.mode ?? ''}`} serverId={selected}
      target={protectedCategories.target} appearanceScope={permissionAppearance} onClose={() => setProtectedCategories(undefined)}
      onApplied={() => { setProtectedCategories(undefined); void refresh(); }}/>}
    {protectedState?.canListMembers && selected === protectedMembersServer && <Modal title={t('Список участников сервера')}
      className="protected-server-roster" onClose={() => setProtectedMembersServer('')}>
      <ProtectedRoster key={selected} serverId={selected} profileId={protectedState.profileId} ownAvatar={ownAvatar} onTimeout={editTimeout} onModerate={moderateProtected}
        onOpenProfileDevices={openProfileDevices}
        onAssignRoles={protectedState.canAssignRoles ? (profileId, profileName) => {
          setProtectedMembersServer('');
          setScopedAssignment({ serverId: selected, profileId, profileName });
        } : undefined}/>
    </Modal>}
    {timeoutTarget?.serverId === selected && editTimeout && <ProtectedTimeoutDialog key={`${selected}:${timeoutTarget.profileId}`}
      serverId={selected} profileId={timeoutTarget.profileId} name={timeoutTarget.name} onClose={() => setTimeoutTarget(undefined)}
      onApplied={() => { setTimeoutTarget(undefined); void refresh(); }}/>}
    {preview && hoveredServer && <ServerVoicePreview server={hoveredServer} state={states[preview.serverId]}
      protectedState={hoveredProtectedState} call={previewedCall} anchor={preview.anchor}/>}
    {error && <div className="member-error" role="alert"><span>{error}</span><button className="icon-button" aria-label={t('Закрыть')} onClick={() => setError('')}>×</button></div>}
    {menu && <ContextMenu {...menu} onClose={() => setMenu(undefined)}/>}
    {modal === 'settings' && <MemberSettings wizard={onboarding} settings={settings} setSettings={setSettings} state={onboarding?undefined:state}
      onOpenProfileDevices={onboarding ? undefined : openProfileDevices} protectedProfile={!onboarding && protectedState ? {
      serverId:selected, profileId:protectedState.profileId, canEdit:!!protectedState.canEditOwnNickname,
      name:ownProtectedProfile?.name, avatar:ownAvatar, avatarSupported:protectedState.profileAvatarSupported,
      avatarRevision:protectedState.profileAvatar?.revision,
    } : undefined} nickname={nickname} onNickname={setNickname} onClose={() => {if(onboarding){localStorage.setItem('pawtalk.onboarding','done');setOnboarding(false);setModal(address?'join':null);}else setModal(null);}} onRefresh={() => {const value=localStorage.getItem(avatarStorageKey)||'';setHomeAvatar(validAvatar(value)?value:undefined);void refresh();}} native={native} keyError={keyError} active={active} voiceMic={controller.current?.mic} voiceSnapshot={snapshot}/>}
    {modal === 'join' && <Modal className="member-join-modal" error={error} title={t('Присоединиться к серверу')} onClose={() => setModal(null)}><form onSubmit={event => { event.preventDefault(); try { if (new URL(address).hash.includes('link=')) { setLinkText(address); setModal('link'); } else void join(address).catch(() => {}); } catch { setError(t('Неверная ссылка приглашения.')); } }}><div className="form-fields member-join-row"><label>{t('Ссылка приглашения или строка привязки')}<input autoFocus required type="text" autoComplete="off" spellCheck={false} value={address} onChange={event => setAddress(event.target.value)}/></label><Button variant="primary" disabled={busy || !address.trim()}>{busy ? t('Подключение…') : t('Присоединиться')}</Button></div></form>
      <div className="modal-actions member-join-alternatives">
        <Button disabled={busy} onClick={() => { setError(''); setModal('device-bind-request'); }}>{t('Привязать к существующему профилю')}</Button>
        <Button disabled={busy} onClick={() => { setError(''); setModal('recover-device'); }}>{t('Потеряли доступ ко всем устройствам?')}</Button>
      </div>
    </Modal>}
    {bindingServer && <ApproveProtectedDeviceDialog key={bindingServer.serverId}
      serverId={bindingServer.serverId} serverName={bindingServer.name} onClose={() => setBindingServer(undefined)}/>}
    {modal === 'device-bind-request' && <RequestProtectedDeviceDialog onClose={() => setModal('join')} onAttached={selectJoined}/>}
    {modal === 'protected-profile-link' && profileLinkServer && <ProtectedProfileLinkDialog key={profileLinkServer.serverId}
      serverId={profileLinkServer.serverId} serverName={profileLinkServer.name} profileId={profileLinkServer.profileId}
      onClose={() => setModal(null)} onChanged={() => void refresh()}/>}
    {modal === 'protected-linked-profiles' && profileLinkServer && <ProtectedLinkedProfilesDialog key={profileLinkServer.serverId}
      serverId={profileLinkServer.serverId} serverName={profileLinkServer.name} profileId={profileLinkServer.profileId}
      onScopeHandover={() => setModal('protected-scope-handover')}
      onClose={() => setModal(null)} onChanged={() => void refresh()}/>}
    {modal === 'protected-scope-handover' && profileLinkServer && <ProtectedScopeHandoverDialog key={profileLinkServer.serverId}
      serverId={profileLinkServer.serverId} serverName={profileLinkServer.name} profileId={profileLinkServer.profileId}
      onClose={() => setModal(null)} onChanged={() => void refresh()}/>}
    {modal === 'recovery-setup' && recoveryServer && <RecoverySetupDialog key={recoveryServer.serverId}
      serverId={recoveryServer.serverId} serverName={recoveryServer.name} onClose={() => setModal(null)}/>}
    {modal === 'protected-ownership' && ownershipServer && <ProtectedOwnershipDialog key={ownershipServer.serverId}
      serverId={ownershipServer.serverId} serverName={ownershipServer.name} profileId={ownershipServer.profileId}
      onClose={() => setModal(null)} onAccepted={() => void refresh()}/>}
    {modal === 'recover-device' && <RecoverDeviceDialog onClose={() => setModal('join')} onRecovered={selectJoined}/>}
    {departures[0]?.kind === 'device-revoked' && <Modal title={t('Это устройство отвязано от сервера')} onClose={() => setDepartures(values => values.slice(1))}>
      <p>{t('Доступ с этого устройства к серверу «{0}» отозван.', departures[0].name)}</p>
      <p>{t('Если это сделали не вы, воспользуйтесь сохранённым резервным набором. На новом доверенном устройстве откройте «Присоединиться к серверу → Потеряли доступ ко всем устройствам?» и введите набор.')}</p>
      <div className="modal-actions"><Button variant="primary" onClick={() => setDepartures(values => values.slice(1))}>{t('Понятно')}</Button></div>
    </Modal>}
    {departures[0]?.kind === 'profile-unlinked' && <Modal title={t('Профиль отсоединён')} onClose={() => setDepartures(values => values.slice(1))}>
      <p>{t('Ваш профиль отсоединили на сервере «{0}». Чтобы снова войти со своим профилем, попросите новое приглашение.', departures[0].name)}</p>
      <div className="modal-actions">
        <Button onClick={() => setDepartures(values => values.slice(1))}>{t('Закрыть')}</Button>
        <Button variant="primary" onClick={() => {
          setDepartures(values => values.slice(1)); setAddress(''); setModal('join');
        }}>{t('Присоединиться к серверу')}</Button>
      </div>
    </Modal>}
    {(departures[0]?.kind==='kick'||departures[0]?.kind==='ban')&&<Modal title={departures[0].kind==='ban'?t('Доступ к серверу заблокирован.'):t('Вы исключены с сервера')} onClose={()=>setDepartures(values=>values.slice(1))}>
      <p>{departures[0].kind==='kick'?t('Вы исключены с сервера «{0}». Для возвращения понадобится действующее приглашение.',departures[0].name):departures[0].expiresAt===null?t('Вы получили бессрочный бан на сервере «{0}».',departures[0].name):departures[0].expiresAt?t('Вы получили бан на сервере «{0}» до {1}.',departures[0].name,new Date(departures[0].expiresAt).toLocaleString()):t('Доступ к серверу «{0}» заблокирован. Срок не указан сервером.',departures[0].name)}</p>
      {departures[0].reason && <p>{t('Причина: {0}', departures[0].reason)}</p>}
      <div className="modal-actions"><Button variant="primary" onClick={()=>setDepartures(values=>values.slice(1))}>{t('Понятно')}</Button></div>
    </Modal>}
    {modal === 'invite' && state && <InvitationDialog state={state} onClose={() => setModal(null)}/>}
    {modal === 'protected-invites' && protectedState?.canListInvites &&
      <ProtectedInvitesDialog key={selected} serverId={selected} profileId={protectedState.profileId} ownAvatar={ownAvatar}
        canListMembers={protectedState.canListMembers} textChannelId={protectedText?.id} onClose={() => setModal(null)}/>}
    {modal === 'protected-bans' && protectedState?.canManageBans &&
      <ProtectedBansDialog key={selected} serverId={selected} onClose={() => setModal(null)}/>}
    {nicknameServer === selected && protectedState?.canEditOwnNickname &&
      <ProtectedNicknameDialog key={`${selected}:${protectedState.profileId}`} serverId={selected} profileId={protectedState.profileId}
        onClose={() => setNicknameServer('')} onSaved={() => { setNicknameServer(''); void refresh(); }}/>}
    {protectedModeration?.serverId === selected && protectedState &&
      <ProtectedMemberModeration {...protectedModeration} onClose={() => setProtectedModeration(undefined)}/>}
    {modal === 'link' && <LinkDialog state={state} nickname={nickname} initialText={linkText} onID={setOpenLinkID} onClose={() => {setOpenLinkID(''); setModal(null); void refresh(); }} onJoined={joined}/>}
    {incomingLink&&(modal!=='link'||incomingLink.linkId!==openLinkID)&&<LinkDialog key={incomingLink.linkId} initialID={incomingLink.linkId} state={states[incomingLink.serverId]} nickname={nickname} onClose={()=>{setIncomingLink(undefined);void refresh();}} onJoined={joined}/>}
    {modal === 'devices' && state && <DevicesDialog state={state} onClose={() => setModal(null)} onRefresh={() => void refresh()}/>}
    {modal === 'bans' && state && <BansDialog state={state} onClose={() => setModal(null)}/>}
    {(muteServer||muteChannel) && <Modal title={t('Заглушить уведомления')} onClose={() => {setMuteServer(undefined);setMuteChannel(undefined);}}><div className="member-mute-options">{[[15, t('На 15 минут')], [60, t('На 1 час')], [180, t('На 3 часа')], [480, t('На 8 часов')], [1440, t('На 24 часа')], [0, t('До тех пор, пока не включу')]].map(([minutes, label]) => <button key={minutes} onClick={() => { localStorage.setItem(muteChannel?channelMuteKey(muteChannel.serverId,muteChannel.channelId):`pawtalk.v2.mute.${muteServer}`, String(minutes ? Date.now() + Number(minutes) * 60000 : Number.MAX_SAFE_INTEGER)); setMuteServer(undefined);setMuteChannel(undefined); updatePrefs(value => value + 1); }}>{label}</button>)}</div></Modal>}
    {leaveServer && <Modal error={error} title={leaveServer.ownedSelfhost?t('Остановить сервер и выйти?'):t('Выйти с сервера?')} onClose={() => setLeaveServer(undefined)}><p>{leaveServer.ownedSelfhost?t('Сервер «{0}» запущен этим клиентом. Выход остановит его и отключит всех участников.',leaveServer.name):t('Все связанные устройства покинут «{0}». История и связи сохранятся. Для возвращения понадобится приглашение.', leaveServer.name)}</p>{!leaveServer.ownedSelfhost&&leaveServer.status!=='online'&&<p className="host-hint">{t('Сервер исчезнет из списка сейчас. Клиент сохранит запрос и отправит выход, когда сервер станет доступен.')}</p>}<div className="modal-actions"><button disabled={busy} onClick={() => setLeaveServer(undefined)}>{t('Отмена')}</button><button disabled={busy} className="danger-button" onClick={() => { const id = leaveServer.serverId; if (voice?.serverId === id) void disconnectVoice(); void perform('leave', { serverId: id }, () => { setLeaveServer(undefined); if (selected === id) setSelected(''); }); }}>{leaveServer.ownedSelfhost?t('Остановить и выйти'):t('Выйти с сервера')}</button></div></Modal>}
    {channelDialog && state && <Modal error={error} title={channelDialog.deleting ? t('Удалить канал?') : channelDialog.channel ? t('Переименовать канал') : t('Создать канал')} onClose={() => setChannelDialog(undefined)}><form onSubmit={event => { event.preventDefault(); const channel = channelDialog.channel; void perform(channelDialog.deleting ? 'channel.delete' : channel ? 'channel.patch' : 'channel.create', { serverId: state.serverId, kind: channelDialog.kind, channelId: channel?.id, name: channelName, expectedRevision: channel?.revision, position:channel?.position }, () => setChannelDialog(undefined)); }}><div className="form-fields">{channelDialog.deleting ? <p>{channelDialog.kind === 'text' ? t('Чат «{0}» и вся его история будут удалены безвозвратно.', channelDialog.channel!.name) : t('Участники покинут голосовой канал и останутся на сервере.')}</p> : <label>{t('Название канала')}<input required autoFocus maxLength={128} value={channelName} onChange={event => setChannelName(event.target.value)}/></label>}</div><div className="modal-actions"><button type="button" onClick={() => setChannelDialog(undefined)}>{t('Отмена')}</button><button disabled={busy} className={channelDialog.deleting ? 'danger-button' : 'primary'}>{channelDialog.deleting ? t('Удалить') : t('Сохранить')}</button></div></form></Modal>}
    {moderation && state && <Modal error={error} title={moderation.mode === 'role' ? t('Изменить роль') : moderation.mode === 'ban' ? t('Заблокировать участника') : t('Исключить участника')} onClose={() => setModeration(undefined)}><p>{profileFor(state, moderation.profileId)?.nickname}</p><div className="form-fields">{moderation.mode === 'role' ? <label>{t('Роль')}<select value={role} onChange={event => setRole(event.target.value)}><option value="member">{t('Участник')}</option><option value="moderator">{t('Модератор')}</option><option value="admin">{t('Администратор')}</option></select></label> : moderation.mode === 'ban' ? <label>{t('Срок блокировки')}<select value={banDuration} onChange={event => setBanDuration(event.target.value)}><option value="3600000">{t('1 час')}</option><option value="86400000">{t('24 часа')}</option><option value="604800000">{t('7 дней')}</option><option value="0">{t('Навсегда')}</option></select></label> : <p>{t('Все связанные устройства будут исключены. Вход по действующему приглашению останется доступен.')}</p>}</div><div className="modal-actions"><button disabled={busy} onClick={() => setModeration(undefined)}>{t('Отмена')}</button><button disabled={busy} className="primary" onClick={() => void perform(moderation.mode === 'role' ? 'role.set' : moderation.mode === 'kick' ? 'member.kick' : 'member.ban', { serverId: state.serverId, profileId: moderation.profileId, role, expiresAt: Number(banDuration) ? Date.now() + Number(banDuration) : null }, () => setModeration(undefined))}>{t('Подтвердить')}</button></div></Modal>}
    <HostPanel nickname={nickname} active={busy} modal={modal === 'create' || modal === 'host-share' ? modal : null} onClose={() => setModal(null)} onCreated={() => { setHostRunning(true); void window.desktop?.hostStatus().then(async host => {if(host.serverId)joined(await membership<ServerState>('connect',{serverId:host.serverId}));}).catch(error=>setError(error.message)); }} onStatus={setHostRunning} onJoin={async input => { await join(input.address); }} onStop={async () => { const host=await window.desktop?.hostStatus();if (voice?.serverId===host?.serverId) await disconnectVoice(); }} onError={setError} onBusy={setBusy}/>
    {renameServer&&<Modal error={error} title={t('Переименовать сервер')} onClose={()=>setRenameServer(undefined)}><form onSubmit={event=>{event.preventDefault();saveServerName();}}><div className="form-fields"><label>{t('Название сервера')}<input autoFocus required maxLength={64} value={serverName} onChange={event=>setServerName(event.target.value)}/></label></div><div className="modal-actions"><button type="button" disabled={busy} onClick={()=>setRenameServer(undefined)}>{t('Отмена')}</button><button className="primary" disabled={busy||!serverName.trim()||serverName.trim()===renameServer.name}>{t('Сохранить')}</button></div></form></Modal>}
    {avatarServer&&<ServerAvatarDialog state={avatarServer} onClose={()=>setAvatarServer(undefined)} onSaved={()=>void refresh()}/>}
    {addressServer && <Modal error={error} title={t('Изменить адрес сервера')} onClose={() => setAddressServer(undefined)}><form onSubmit={event => {event.preventDefault();void perform('server.address',{serverId:addressServer.serverId,address},()=>setAddressServer(undefined));}}><div className="form-fields"><label>{t('Адрес сервера')}<input autoFocus required value={address} onChange={event=>setAddress(event.target.value)}/></label><p>{t('Вставьте новый адрес или ссылку с отпечатком. Идентичность сервера и ваше членство должны сохраниться.')}</p></div><div className="modal-actions"><button type="button" disabled={busy} onClick={()=>setAddressServer(undefined)}>{t('Отмена')}</button><button className="primary" disabled={busy}>{t('Сохранить')}</button></div></form></Modal>}
    {activeRoleView && <Modal fullPage className="protected-role-view-page" title={t('Предпросмотр сервера от лица роли')}
      onClose={() => setRoleViewSession(undefined)}>
      <ProtectedRoleViewToolbar session={activeRoleView}
        onChange={selected => setRoleViewSession({ ...activeRoleView, selected })}
        onClose={() => setRoleViewSession(undefined)}/>
      {serverLayout}
    </Modal>}
  </>;
}
