export interface PollDefinition {options:string[];duration:number;multiple:boolean;anonymous:boolean;intermediate:boolean}
export const pollDurations:readonly number[];
export function validatePoll(value:PollDefinition):PollDefinition;
