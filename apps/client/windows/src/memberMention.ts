import {shiftMentions,type Mention} from '../../../../shared/mentions.mjs';
import {profileFor,type ServerState} from './membership';
export const memberDragType='application/x-pawtalk-member';
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
