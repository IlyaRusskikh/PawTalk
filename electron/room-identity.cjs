const {createHash}=require('node:crypto');
const {isIP}=require('node:net');

function roomIdentity(base,certificate,feed) {
 const url=new URL(base);
 const literal=!!isIP(url.hostname.replace(/^\[|\]$/g,''));
 const pin=/^[a-f0-9]{64}$/.test(certificate||'')?certificate:undefined;
 // IP invitations pin the room certificate. CA-authenticated domain rooms
 // keep their origin identity across normal certificate renewal.
 const scope=literal&&pin?pin:url.origin;
 const roomFeed=/^[a-f0-9]{32}$/.test(feed||'')?feed:url.origin;
 return {
  roomId:createHash('sha256').update(scope+'\n'+roomFeed).digest('hex'),
  bookmarkAddress:literal&&pin?`pawtalk://${url.hostname}:${url.port||443}/${pin}`:url.origin,
 };
}
module.exports={roomIdentity};
