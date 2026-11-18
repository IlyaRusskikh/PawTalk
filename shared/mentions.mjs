export function validMentions(text, mentions = []) {
 if (!Array.isArray(mentions) || mentions.length > 64) throw Error('INVALID_MENTIONS');
 let end = 0;
 return mentions.map(mention => {
  if (!mention || !/^[a-f0-9]{64}$/.test(mention.profileId) || !Number.isSafeInteger(mention.start) || !Number.isSafeInteger(mention.end) || mention.start < end || mention.end <= mention.start + 1 || mention.end > text.length || text[mention.start] !== '@' || mention.end - mention.start > 129) throw Error('INVALID_MENTIONS');
  end = mention.end;
  return {profileId: mention.profileId, start: mention.start, end: mention.end};
 });
}
export function shiftMentions(before, after, mentions) {
 let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
 let oldEnd=before.length,newEnd=after.length;while(oldEnd>start&&newEnd>start&&before[oldEnd-1]===after[newEnd-1]){oldEnd--;newEnd--;}
 const delta=newEnd-oldEnd;
 return mentions.flatMap(m=>m.end<=start?[m]:m.start>=oldEnd?[{...m,start:m.start+delta,end:m.end+delta}]:[]);
}
