interface UpdateState { status: 'idle' | 'checking' | 'check-failed' | 'available' | 'downloading' | 'installing' | 'failed'; version?: string; prerelease?: boolean; progress?: number; installable?: boolean; }
// Chromium supports AudioContext.setSinkId; TypeScript's DOM declarations lag it.
interface AudioContext { setSinkId(sinkId: string): Promise<void>; }
interface HostStatus { running: boolean; e2ee?: boolean; name?: string; port?: number; mapped?: boolean; internet?: boolean; localAddress?: string; invitations?: string[]; message?: string; }
interface HostCheckResult { state: 'internet' | 'unconfirmed' | 'error' | 'cancelled'; tcp: [boolean, boolean]; udp: boolean; reason?: 'no-interface' | 'no-public-ip' | 'ports-in-use' | 'check-failed' | 'checker-unavailable'; }
interface Window {
  desktop?: {
    copyChatText?(text: string): Promise<void>;
    copyChatImage?(input: { bytes: Uint8Array; name: string }): Promise<void>;
    saveChatImage?(input: { bytes: Uint8Array; name: string }): Promise<boolean>;
    windowActive?(): Promise<boolean>;
    onWindowActive?(callback: (active: boolean) => void): () => void;
    getStartInTray?(): Promise<boolean>;
    setStartInTray?(value: boolean): Promise<boolean>;
    roomPresence?(address: string): Promise<number | null>;
    roomPreview?(address: string, cursor: { feed?: string; after: number }): Promise<import('./BookmarkRail').RoomPreview>;
    getAutoStart?(): Promise<boolean>;
    setAutoStart?(enabled: boolean): Promise<boolean>;
    copyServerKey(value: string): Promise<void>;
    getLanguage?(): Promise<'ru' | 'en'>;
    setLanguage?(value: 'ru' | 'en'): Promise<void>;
    updateState?(): Promise<UpdateState>;
    getAutoUpdate?(): Promise<boolean>;
    setAutoUpdate?(value: boolean): Promise<boolean>;
    checkUpdate?(): Promise<UpdateState>;
    installUpdate?(): Promise<UpdateState>;
    onUpdate?(callback: (state: UpdateState) => void): () => void;
    copyDiagnosticCommand(address: string): Promise<void>;
    copyInvitation(address: string): Promise<void>;
    pendingInvitation(): Promise<string>;
    diagnose(address: string): Promise<{ ok: boolean; message: string; e2eeRequired?: boolean }>;
    onInvitation(callback: (address: string) => void): () => void;
    startHost(input: { password: string; port: number; name: string; e2ee?: boolean }): Promise<HostStatus>;
    stopHost(): Promise<void>;
    hostStatus(): Promise<HostStatus>;
    checkHost(port: number): Promise<HostCheckResult>;
    cancelHostCheck(): Promise<void>;
    onHostChanged(callback: (status: HostStatus) => void): () => void;
    connect(input: { address: string; nickname: string; password: string; e2eeKey?: string }): Promise<{ url: string; token: string; identity: string; ownHost?: boolean; error?: string; e2eeRequired?: boolean; e2eeKey?: string; chat?: import('./chat').ChatAccess }>;
    chatRequest(handle: string, input: import('./chat').ChatHistoryRequest | { packet: import('./chat').ChatPacket } | { profile: import('./chat').ChatProfilePacket } | { attachment: { id: string; data?: Uint8Array } }): Promise<unknown>;
    chatClose(handle: string): Promise<void>;
    capabilities(): Promise<{ native: boolean; platform: string; packaged: boolean; secureStorage: boolean }>;
    loadPassword(address: string): Promise<{ password: string | null; e2eeKey?: string | null }>;
    savePassword(input: { address: string; password: string | null; e2eeKey?: string | null }): Promise<void>;
    configureKeys(input: { ptt: number; mute: string; deafen: string }): Promise<{ native: boolean; failed: string[] }>;
    duck(input: { active: boolean; factor: number }): Promise<void>;
    onPtt(callback: (down: boolean) => void): () => void;
    onAction(callback: (action: string) => void): () => void;
    onSuspend(callback: () => void): () => void;
  };
}
