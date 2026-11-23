const keyPattern=/^[a-f0-9]{32}:[a-f0-9]{64}$/;
export const peerAudioStorageKey='pawtalk.peer-audio.v1';
export function loadPeerAudio(storage){
 try{
  const raw=storage.getItem(peerAudioStorageKey);if(!raw||raw.length>1024*1024)return {};
  const data=JSON.parse(raw);if(!data||typeof data!=='object'||Array.isArray(data))return {};
  return Object.fromEntries(Object.entries(data).slice(0,5000).filter(([key,pref])=>keyPattern.test(key)&&pref&&Number.isFinite(pref.volume)&&pref.volume>=0&&pref.volume<=2&&typeof pref.muted==='boolean').map(([key,pref])=>[key,{volume:pref.volume,muted:pref.muted}]));
 }catch{return {};}
}
export function savePeerAudio(storage,value){storage.setItem(peerAudioStorageKey,JSON.stringify(value));}
export function projectPeerAudio(saved,serverId,presences,resolve=profileId=>profileId){
 return Object.fromEntries(presences.flatMap(presence => {
  const identity = presence.identity ?? presence.sessionId;
  return identity ? [[identity, saved[serverId+':'+resolve(presence.profileId)] ?? {volume:1,muted:false}]] : [];
 }));
}
