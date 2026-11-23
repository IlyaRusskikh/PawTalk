export interface Mention {profileId:string;start:number;end:number}
export type ProtectedMentionTarget = {kind:'profile'|'role';id:string} | {kind:'everyone'|'online';id?:never};
export type ProtectedMention = ProtectedMentionTarget & {start:number;end:number};
export function validMentions(text:string,mentions?:Mention[]):Mention[];
export function shiftMentions<T extends {start:number;end:number}>(before:string,after:string,mentions:T[]):T[];
