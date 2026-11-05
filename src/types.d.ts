// Chromium supports AudioContext.setSinkId; TypeScript's DOM declarations lag it.
interface AudioContext { setSinkId(sinkId: string): Promise<void>; }
interface HostStatus { running: boolean; e2ee?: boolean; name?: string; port?: number; mapped?: boolean; internet?: boolean; localAddress?: string; invitations?: string[]; message?: string; }
interface HostCheckResult { state: 'internet' | 'unconfirmed' | 'error' | 'cancelled'; tcp: [boolean, boolean]; udp: boolean; }
interface Window {
  desktop?: {
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
    connect(input: { address: string; nickname: string; password: string; e2eeKey?: string }): Promise<{ url: string; token: string; identity: string; error?: string; e2eeRequired?: boolean; e2eeKey?: string }>;
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
