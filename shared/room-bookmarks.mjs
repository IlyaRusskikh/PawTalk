// Room identity is independent of passwords, display names and invitations'
// optional fragments. A verified room ID distinguishes rooms sharing a cert.
export function bookmarkAddress(value) {
 const url = new URL(value.includes('://') ? value.trim() : 'https://'+value.trim());
 if(url.username||url.password||url.search)throw Error('Invalid bookmark address');
 if(url.protocol==='pawtalk:') {
  if(!url.port||!/^\/[a-f0-9]{64}$/.test(url.pathname))throw Error('Invalid invitation');
  return `pawtalk://${url.hostname.toLowerCase()}:${Number(url.port)}/${url.pathname.slice(1)}`;
 }
 if(!['https:','http:'].includes(url.protocol)||url.pathname!=='/'||url.hash)throw Error('Invalid server address');
 return url.origin;
}
function parts(value) {
 try {
  const normalized=bookmarkAddress(value),url=new URL(normalized);
  return { normalized,pin:url.protocol==='pawtalk:'?url.pathname.slice(1):undefined,origin:`${url.hostname.toLowerCase()}:${Number(url.port||443)}` };
 } catch { return {}; }
}
export function sameBookmark(a,b) {
 if(!a||!b)return false;
 if(a.roomId&&b.roomId)return a.roomId===b.roomId;
 const x=parts(a.address),y=parts(b.address);
 if(!x.normalized||!y.normalized)return false;
 return x.normalized===y.normalized || (!!x.pin&&x.pin===y.pin) || (x.origin===y.origin&&(!x.pin||!y.pin));
}
export function reconcileBookmarks(items,target) {
 const matches=items.filter(item=>sameBookmark(item,target));
 if(!matches.length)return items;
 let added=false;
 return items.flatMap(item=>{
  if(!sameBookmark(item,target))return [item];
  if(added)return [];
  added=true;
  return [{...item,address:bookmarkAddress(target.address),...(target.roomId?{roomId:target.roomId}:{})}];
 });
}

export function loadBookmarks(value) {
 if(!Array.isArray(value))return [];
 const items=[];
 for(const saved of value.slice(0,50)) {
  if(!saved||typeof saved.address!=='string'||typeof saved.name!=='string'||saved.address.includes('#'))continue;
  try {
   const item={address:bookmarkAddress(saved.address),name:saved.name,...(typeof saved.roomId==='string'&&/^[a-f0-9]{64}$/.test(saved.roomId)?{roomId:saved.roomId}:{})};
   const existing=items.find(entry=>entry.address===item.address||sameBookmark(entry,item));
   if(!existing)items.push(item);
   else {
    // Preserve an explicitly pinned route when migrating legacy bare-IP copies.
    if(item.address.startsWith('pawtalk://')&&!existing.address.startsWith('pawtalk://'))existing.address=item.address;
    if(!existing.roomId&&item.roomId)existing.roomId=item.roomId;
   }
  }catch{}
 }
 return items;
}
