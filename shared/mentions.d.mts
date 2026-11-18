export interface Mention {profileId:string;start:number;end:number}
export function validMentions(text:string,mentions?:Mention[]):Mention[];
export function shiftMentions(before:string,after:string,mentions:Mention[]):Mention[];
