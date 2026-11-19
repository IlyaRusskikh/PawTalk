import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {resolveGif,loadGifMedia,loadGifMediaCached,publicAddress,safeURL}=createRequire(import.meta.url)('../electron/gif-link.cjs');
const gif=Buffer.from('GIF89a');
test('GIF detection uses actual bytes, follows bounded redirects, and resolves single Tenor pages',async()=>{
 const request=async url=>{
  if(url==='https://files.example.test/no-extension')return{redirect:'/actual'};
  if(url==='https://files.example.test/actual')return{type:'application/octet-stream',bytes:gif};
  if(url==='https://tenor.com/view/cat-gif-123')return{type:'text/html',bytes:Buffer.from('<meta property="og:image" content="https://media.tenor.com/cat/no-extension">')};
  if(url==='https://media.tenor.com/cat/no-extension')return{type:'image/gif',bytes:gif};
  return{type:'text/html',bytes:Buffer.from('not a GIF')};
 };
 assert.deepEqual(await resolveGif('https://files.example.test/no-extension',{request}),{url:'https://files.example.test/actual'});
 assert.deepEqual(await resolveGif('https://tenor.com/view/cat-gif-123',{request}),{url:'https://media.tenor.com/cat/no-extension'});
 assert.equal(await resolveGif('https://tenor.com/search/meow-gifs',{request}),null);
 assert.equal(await resolveGif('https://files.example.test/fake.gif',{request}),null);
 assert.equal(await resolveGif('https://files.example.test/loop',{request:async()=>({redirect:'/loop'})}),null);
});
test('GIF probes reject credentials, non-HTTPS, private addresses and unsafe redirects',async()=>{
 for(const url of ['http://example.test/gif','https://user:pass@example.test/gif','file:///test','https://example.test:8443/gif'])assert.throws(()=>safeURL(url));
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','192.168.1.1','172.16.1.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);
 assert.equal(await resolveGif('https://127.0.0.1/gif'),null);
 assert.equal(await resolveGif('https://example.test/gif',{request:async()=>({redirect:'http://example.test/image.gif'})}),null);
});

test('localized Tenor share links resolve the animation from the original page',async()=>{
 const source='https://tenor.com/ru/view/deal-with-it-dog-gif-9823664';
 const media='https://media1.tenor.com/m/6xcfcXMMccUAAAAC/deal-with.gif';
 const request=async url=>url===media
  ?{type:'image/gif',bytes:gif}
  :{type:'text/html',bytes:Buffer.from(`<meta property="og:image" content="${media}">`)};
 assert.deepEqual(await resolveGif(source,{request}),{url:media});
 assert.deepEqual(await resolveGif('https://www.tenor.com/pt-BR/search/dog-gifs',{request}),{url:media});
 assert.equal(await resolveGif('https://tenor.com.example.test/ru/view/deal-with-it-dog-gif-9823664',{request}),null);
 assert.equal(await resolveGif('https://giphy.com/ru/view/dog',{request}),null);
});

test('Klipy single-GIF pages resolve verified GIF and looping video formats',async()=>{
 const request=async url=>url==='https://klipy.com/gifs/rat-eat-pog'?{type:'text/html',bytes:Buffer.from('<meta property="og:video" content="https://static.klipy.com/ii/example/rat.webm">')}:{type:'video/webm',bytes:Buffer.from([0x1a,0x45,0xdf,0xa3,0,0,0,0,0,0,0,0])};
 assert.deepEqual(await resolveGif('https://klipy.com/gifs/rat-eat-pog',{request}),{url:'https://static.klipy.com/ii/example/rat.webm',mime:'video/webm'});
});


test('repeated Tenor search links resolve the same first verified animation in result order',async()=>{
 const request=async url=>url==='https://tenor.com/search/meow-gifs'
  ?{type:'text/html',bytes:Buffer.from('<meta property="og:image" content="https://tenor.com/logo.png"><img src="https://media1.tenor.com/first.gif"><img src="https://media.tenor.com/second.gif">')}
  :{type:'application/octet-stream',bytes:url.endsWith('.gif')?gif:Buffer.from('PNG')};
 const results=await Promise.all([1,2].map(()=>resolveGif('https://tenor.com/search/meow-gifs',{request})));
 assert.deepEqual(results,[{url:'https://media1.tenor.com/first.gif'},{url:'https://media1.tenor.com/first.gif'}]);
});


test('GIF fallback validates bounded animation bytes and each redirect provider',async()=>{
 const valid=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
 assert.deepEqual(await loadGifMedia('https://media.tenor.com/cat.gif',{request:async()=>({bytes:valid})}),{mime:'image/gif',base64:valid.toString('base64')});
 assert.equal(await loadGifMedia('https://unrelated.example.test/cat.gif',{request:async()=>{throw Error('must not request');}}),null);
 assert.equal(await loadGifMedia('https://media.tenor.com/cat.gif',{request:async()=>({redirect:'https://unrelated.example.test/cat.gif'})}),null);
 assert.equal(await loadGifMedia('https://media.tenor.com/cat.gif',{request:async()=>({bytes:Buffer.alloc(20*1024*1024+1)})}),null);
 const huge=Buffer.from(valid);huge.writeUInt16LE(65535,6);
 assert.equal(await loadGifMedia('https://media.tenor.com/cat.gif',{request:async()=>({bytes:huge})}),null);
 let calls=0;const request=async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return{bytes:valid};};
 const repeated=await Promise.all([1,2].map(()=>loadGifMediaCached('https://media.tenor.com/coalesced.gif',{request})));
 assert.equal(calls,1);assert.deepEqual(repeated[0],repeated[1]);
});
