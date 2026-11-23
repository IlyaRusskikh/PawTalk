import {shiftMentions,type Mention,type ProtectedMention} from '../../../../shared/mentions.mjs';
import {profileFor,type ServerState} from './membership';
export const memberDragType='application/x-pawtalk-member';
export function setMemberDrag(data: DataTransfer, serverId: string, profileId: string) {
 data.setData(memberDragType, JSON.stringify({serverId, profileId}));
 data.effectAllowed = 'copy';
}

export function dropProtectedMemberMention(raw: string, serverId: string,
 profiles: ReadonlyMap<string, { name: string }> | undefined, value: string, mentions: ProtectedMention[], start: number, end: number) {
 let payload: { serverId?: string; profileId?: string } | null;
 try { payload = JSON.parse(raw); } catch { return; }
 if (payload?.serverId !== serverId || typeof payload.profileId !== 'string' ||
     !/^[a-f0-9]{64}$/.test(payload.profileId) || mentions.length >= 64) return;
 const profile = profiles?.get(payload.profileId);
 if (!profile) return;
 const name = profile.name.slice(0, 128).replace(/\p{Cs}$/u, '');
 if (!name) return;
 const prefix = start > 0 && !/\s$/.test(value.slice(0,start)) ? ' ' : '';
 const offset = start + prefix.length;
 const next = value.slice(0,start) + prefix + '@' + name + ' ' + value.slice(end);
 if (next.length > 4096) return;
 const caret = offset + name.length + 2;
 const mention: ProtectedMention = {kind:'profile', id:payload.profileId, start:offset, end:caret-1};
 const delta = next.length - value.length;
 const retained = mentions.flatMap(item => item.end <= start ? [item] :
  item.start >= end ? [{...item, start:item.start+delta, end:item.end+delta}] : []);
 return {text:next, mentions:[...retained,mention].sort((a,b)=>a.start-b.start), caret};
}
export function dropMemberMention(raw:string,state:ServerState,value:string,mentions:Mention[],start:number,end:number){
 try{
  const payload=JSON.parse(raw);
  if(payload.serverId!==state.serverId||!state.members.some(m=>m.profileId===payload.profileId))return;
  const person=profileFor(state,payload.profileId);if(!person)return;
  const label='@'+person.nickname,prefix=start>0&&!/\s$/.test(value.slice(0,start))?' ':'';
  const text=value.slice(0,start)+prefix+label+' '+value.slice(end),offset=start+prefix.length;
  return {text,mentions:[...shiftMentions(value,text,mentions),{profileId:person.id,start:offset,end:offset+label.length}].sort((a,b)=>a.start-b.start),caret:offset+label.length+1};
 }catch{return;}
}
