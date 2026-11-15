interface UpdateState { status: 'idle' | 'checking' | 'check-failed' | 'available' | 'downloading' | 'installing' | 'failed' | 'security-failed'; version?: string; prerelease?: boolean; progress?: number; installable?: boolean; source?: string; }
// Chromium supports AudioContext.setSinkId; TypeScript's DOM declarations lag it.
interface AudioContext { setSinkId(sinkId: string): Promise<void>; }
interface HostStatus { running: boolean; serverId?: string; e2ee?: boolean; name?: string; port?: number; mapped?: boolean; internet?: boolean; localAddress?: string; invitations?: string[]; message?: string; }
interface HostCheckResult {
  state: 'internet' | 'unconfirmed' | 'error' | 'cancelled'; tcp: [boolean, boolean]; udp: boolean;
  reason?: 'no-interface' | 'no-public-ip' | 'ports-in-use' | 'check-failed' | 'checker-unavailable';
  network?: { lanIP: string; wanIP: string; externalIP: string; probeIP: string; comparison: 'same' | 'additional-nat' | 'different' | 'unavailable' };
}
interface Window {
  desktop?: {
    membership?(action:string,input?:Record<string,unknown>):Promise<{value?:unknown;error?:{code:string}}>;
    onMembershipChanged?(callback:(event:{serverId?:string;leaveError?:string;departure?:{serverId:string;name:string;kind:'kick'|'ban';expiresAt?:number|null}})=>void):()=>void;
    onMembershipVoiceLost?(callback:(event:{serverId:string})=>void):()=>void;
    onMembershipOpenChannel?(callback:(event:{serverId:string;channelId:string})=>void):()=>void;
    copyChatText?(text: string): Promise<void>;
    copyChatImage?(input: { bytes: Uint8Array; name: string }): Promise<void>;
    saveChatImage?(input: { bytes: Uint8Array; name: string }): Promise<boolean>;
    windowActive?(): Promise<boolean>;
    onWindowActive?(callback: (active: boolean) => void): () => void;
    getStartInTray?(): Promise<boolean>;
    setStartInTray?(value: boolean): Promise<boolean>;
    getAutoStart?(): Promise<boolean>;
    setAutoStart?(enabled: boolean): Promise<boolean>;
    getLanguage?(): Promise<'ru' | 'en'>;
    setLanguage?(value: 'ru' | 'en'): Promise<void>;
    updateState?(): Promise<UpdateState>;
    setUpdateRooms?(rooms: { address: string; name: string }[]): Promise<void>;
    getAutoUpdate?(): Promise<boolean>;
    setAutoUpdate?(value: boolean): Promise<boolean>;
    getUpdateChannel?(): Promise<'stable' | 'preview'>;
    setUpdateChannel?(value: 'stable' | 'preview'): Promise<'stable' | 'preview'>;
    checkUpdate?(): Promise<UpdateState>;
    installUpdate?(): Promise<UpdateState>;
    onUpdate?(callback: (state: UpdateState) => void): () => void;
    copyDiagnosticCommand(address: string): Promise<void>;
    copyInvitation(address: string): Promise<void>;
    pendingInvitation(): Promise<string>;
    diagnose(address: string): Promise<{ ok: boolean; message: string; e2eeRequired?: boolean }>;
    onInvitation(callback: (address: string) => void): () => void;
    startHost(input: { port: number; name: string; nickname?: string }): Promise<HostStatus>;
    stopHost(): Promise<void>;
    hostStatus(): Promise<HostStatus>;
    checkHost(port: number): Promise<HostCheckResult>;
    cancelHostCheck(): Promise<void>;
    onHostChanged(callback: (status: HostStatus) => void): () => void;
    capabilities(): Promise<{ native: boolean; platform: string; packaged: boolean; secureStorage: boolean }>;
    configureKeys(input: { ptt: number; mute: string; deafen: string }): Promise<{ native: boolean; failed: string[] }>;
    duck(input: { active: boolean; factor: number }): Promise<void>;
    onPtt(callback: (down: boolean) => void): () => void;
    onAction(callback: (action: string) => void): () => void;
    onSuspend(callback: () => void): () => void;
  };
}
