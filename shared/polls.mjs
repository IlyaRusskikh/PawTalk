export const pollDurations=Object.freeze([3600,14400,28800,86400,259200,604800,1209600]);
export function validatePoll(value){
 if(!value||!Array.isArray(value.options)||value.options.length<2||value.options.length>10||value.options.some(s=>typeof s!=='string'||!s.trim()||Array.from(s).length>100)||!pollDurations.includes(value.duration)||['multiple','anonymous','intermediate'].some(k=>typeof value[k]!=='boolean'))throw Error('INVALID_POLL');
 return {options:value.options.map(s=>s.trim()),duration:value.duration,multiple:value.multiple,anonymous:value.anonymous,intermediate:value.intermediate};
}
