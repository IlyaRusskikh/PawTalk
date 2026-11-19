export type PeerAudio=Record<string,{volume:number;muted:boolean}>;
export const peerAudioStorageKey:string;
export function loadPeerAudio(storage:Pick<Storage,'getItem'>):PeerAudio;
export function savePeerAudio(storage:Pick<Storage,'setItem'>,value:PeerAudio):void;
export function projectPeerAudio(saved:PeerAudio,serverId:string,presences:{identity:string;profileId:string}[],resolve:(profileId:string)=>string):PeerAudio;
