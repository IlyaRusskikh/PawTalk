const https=require('node:https');
const dns=require('node:dns/promises');
const {BlockList,isIP}=require('node:net');
const blocked4=new BlockList(),blocked6=new BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]])blocked4.addSubnet(address,prefix,'ipv4');
for(const [address,prefix] of [['::',96],['::ffff:0:0',96],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32]])blocked6.addSubnet(address,prefix,'ipv6');
function publicAddress(address){const family=isIP(address);return !!family&&!(family===4?blocked4:blocked6).check(address,family===4?'ipv4':'ipv6');}
function safeURL(value){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||url.href.length>2048)throw Error('Invalid GIF URL');url.hash='';return url;}

// Resolve DNS ourselves, reject private addresses, and pin the checked address in
// the HTTPS lookup callback. Every redirect goes through the same checks.
async function readRemote(value,signal,{full=false,maxBytes=20*1024*1024}={}){
 if(signal.aborted)throw Error('GIF lookup timed out');
 const url=safeURL(value),host=url.hostname.replace(/^\[|\]$/g,'');
 const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await new Promise((resolve,reject)=>{const abort=()=>reject(Error('GIF lookup timed out'));signal.addEventListener('abort',abort,{once:true});dns.lookup(host,{all:true}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
 if(!addresses.length||addresses.some(entry=>!publicAddress(entry.address)))throw Error('Non-public GIF host');
 if(signal.aborted)throw Error('GIF lookup timed out');
 return new Promise((resolve,reject)=>{
  const selected=addresses[0];
  const request=https.get(url,{signal,lookup:(_host,options,callback)=>options.all?callback(null,[selected]):callback(null,selected.address,selected.family)},response=>{
   if(response.statusCode>=300&&response.statusCode<400){response.destroy();resolve({redirect:response.headers.location});return;}
   if(response.statusCode!==200&&response.statusCode!==206){response.destroy();reject(Error('GIF lookup failed'));return;}
   const chunks=[];let size=0,finished=false,checked=false;
   const finish=()=>{if(finished)return;finished=true;const bytes=Buffer.concat(chunks);resolve({type:String(response.headers['content-type']||'').split(';')[0].toLowerCase(),bytes});response.destroy();};
   response.on('data',chunk=>{
    if(full&&size+chunk.length>maxBytes){finished=true;response.destroy();reject(Error('GIF too large'));return;}
    chunks.push(full?chunk:chunk.subarray(0,Math.max(0,524288-size)));size+=chunk.length;
    if(full){if(size>=12&&!checked){checked=true;if(!animationMime(chunks.length===1?chunks[0]:Buffer.concat(chunks))){finished=true;response.destroy();reject(Error('Not animation media'));}}}
    else if(size>=12&&animationMime(Buffer.concat(chunks)))finish();else if(size>=524288)finish();
   });
   response.on('end',finish);response.on('error',error=>{if(!finished)reject(error);});
  });request.on('error',reject);
 });
}
const gifBytes=bytes=>Buffer.isBuffer(bytes)&&/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii'));
const animationMime=bytes=>gifBytes(bytes)?'image/gif':bytes?.length>=12&&bytes.subarray(4,8).toString('ascii')==='ftyp'?'video/mp4':bytes?.length>=4&&bytes.readUInt32BE(0)===0x1a45dfa3?'video/webm':undefined;
const decode=value=>value.replaceAll('&amp;','&').replaceAll('&#38;','&').replaceAll('\\u0026','&').replaceAll('\\/','/');
async function resolveGif(value,{request=readRemote}={}){
 try{
  const signal=AbortSignal.timeout(8000);
  const read=async input=>{let url=safeURL(input);for(let i=0;i<4;i++){const result=await request(url.href,signal);if(result.redirect){url=safeURL(new URL(result.redirect,url).href);continue;}return {url:url.href,...result};}throw Error('Too many redirects');};
  const result=await read(value);
  if(gifBytes(result.bytes))return {url:result.url};
  const source=safeURL(value),provider=/^(?:www\.)?(?:tenor\.com|giphy\.com|klipy\.com)$/.test(source.hostname);
  // Search links preview the first actual animation in provider result order.
  if(!provider||!/^\/(?:view|gifs|search)\//.test(source.pathname)||result.type!=='text/html')return null;
  const html=result.bytes.toString('utf8'),candidates=[];
  for(const tag of html.matchAll(/<meta\b[^>]*>/gi)){
   if(!/\b(?:property|name)\s*=\s*["'](?:og:image(?::url)?|twitter:image(?::src)?|og:video(?::url)?)["']/i.test(tag[0]))continue;
   const content=/\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag[0]);if(content)candidates.push(decode(content[1]));
  }
  candidates.push(...[...html.matchAll(/https?:[^\s"'<>]+?\.(?:gif|webm|mp4)(?:\?[^\s"'<>]*)?/gi)].map(match=>decode(match[0])));
  for(const candidate of [...new Set(candidates)].slice(0,5)){
   try{const url=safeURL(candidate);if(!/(?:^|\.)(?:tenor\.com|giphy\.com|klipy\.com)$/.test(url.hostname))continue;
   const image=await read(url.href),mime=animationMime(image.bytes);if(mime)return mime==='image/gif'?{url:image.url}:{url:image.url,mime};}catch{if(signal.aborted)break;}
  }
 }catch{/* Keep the original message/link when resolution is unavailable. */}
 return null;
}
const cache=new Map();
function resolveGifCached(value){const now=Date.now(),saved=cache.get(value);if(saved&&now-saved.at<60000)return saved.promise;const entry={at:now,promise:undefined};entry.promise=resolveGif(value).then(result=>{if(!result&&cache.get(value)===entry)cache.delete(value);return result;});cache.set(value,entry);while(cache.size>128)cache.delete(cache.keys().next().value);return entry.promise;}
const mediaPending=new Map();
const mediaQueue=[];let mediaActive=0;
function pumpMedia(){while(mediaActive<2&&mediaQueue.length)mediaQueue.shift()();}
async function loadGifMedia(value,{request=readRemote}={}){
 try{
  const signal=AbortSignal.timeout(20000);let url=safeURL(value);
  for(let i=0;i<4;i++){
   if(!/(?:^|\.)(?:tenor\.com|giphy\.com|klipy\.com)$/.test(url.hostname))return null;
   const result=await request(url.href,signal,{full:true});
   if(result.redirect){url=safeURL(new URL(result.redirect,url).href);continue;}
   const mime=animationMime(result.bytes);if(!mime||result.bytes.length>20*1024*1024)return null;
   if(mime==='image/gif'){
    if(result.bytes.length<10)return null;
    const width=result.bytes.readUInt16LE(6),height=result.bytes.readUInt16LE(8);
    if(!width||!height||width>8192||height>8192||width*height>16000000)return null;
   }
   return{mime,base64:result.bytes.toString('base64')};
  }
 }catch{/* The original source link remains usable if both transports fail. */}
 return null;
}
function loadGifMediaCached(value,options){
 if(mediaPending.has(value))return mediaPending.get(value);
 if(mediaPending.size>=32)return Promise.resolve(null);
 let deliver;const pending=new Promise(resolve=>{deliver=resolve;});mediaPending.set(value,pending);
 mediaQueue.push(()=>{mediaActive++;void loadGifMedia(value,options).then(deliver).finally(()=>{mediaPending.delete(value);mediaActive--;pumpMedia();});});pumpMedia();return pending;
}
module.exports={resolveGif,resolveGifCached,loadGifMedia,loadGifMediaCached,publicAddress,safeURL};
