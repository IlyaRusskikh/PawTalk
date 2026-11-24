const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
app.setPath('userData',path.join(os.tmpdir(),'pawtalk-video-ui-'+process.pid));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const run=code=>win.webContents.executeJavaScript(code,true),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async(code)=>{for(let i=0;i<240;i++){if(await run(code))return;await wait(50);}throw Error(code+': '+await run('document.body.innerText.slice(-1800)'));};
 const timer=setTimeout(()=>app.exit(1),90000);
 try{for(const lang of ['ru','en']){
  await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/server-chat.html?compose=1&lang='+lang);
  await until("document.querySelectorAll('[data-message-row]').length===25");
  await run("(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['hello'],'Note.txt',{type:'text/plain'}));window.dropFixture=transfer;document.body.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()");
  await until("!!document.querySelector('.chat-file-drop-overlay')");
  assert.ok(await run("document.querySelector('.chat-file-drop-card').textContent.includes('General')"));
  await run("document.body.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.dropFixture}))");
  await until("document.querySelector('.attachment-filename')?.textContent==='Note.txt'&&!document.querySelector('.chat-file-drop-overlay')");
  await run("document.querySelector('.attachment-card-actions button:last-child').click()");
  await until("!document.querySelector('.chat-attachment-card')");
  await run(`(async()=>{
   const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d'),stream=canvas.captureStream(20),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];
   const done=new Promise(resolve=>recorder.onstop=resolve);recorder.ondataavailable=e=>chunks.push(e.data);
   const started=performance.now(),paint=()=>{ctx.fillStyle=performance.now()-started<300?'black':'#35ba72';ctx.fillRect(0,0,320,180);if(performance.now()-started<300)return;ctx.fillStyle='white';ctx.fillRect(30+(performance.now()-started)%200,50,40,80);};
   ctx.fillStyle='black';ctx.fillRect(0,0,320,180);recorder.start();const interval=setInterval(paint,50);await new Promise(resolve=>setTimeout(resolve,3000));recorder.stop();await done;clearInterval(interval);stream.getTracks().forEach(t=>t.stop());
   window.addFixtureDuration=(data,milliseconds)=>{let bytes=data;
   for(let i=0;i<data.length-12;i++)if(data[i]===0x15&&data[i+1]===0x49&&data[i+2]===0xa9&&data[i+3]===0x66){
    const start=i+4;let sizeBytes=1,mask=128;while(!(data[start]&mask)){sizeBytes++;mask>>=1;}let size=data[start]&(mask-1);for(let j=1;j<sizeBytes;j++)size=size*256+data[start+j];
    const end=start+sizeBytes+size,duration=new Uint8Array(11);duration.set([0x44,0x89,0x88]);new DataView(duration.buffer).setFloat64(3,milliseconds,false);
    bytes=new Uint8Array(data.length+11);bytes.set(data.subarray(0,end));bytes.set(duration,end);bytes.set(data.subarray(end),end+11);let n=size+11;for(let j=sizeBytes-1;j>=0;j--){bytes[start+j]=n&255;n=Math.floor(n/256);}bytes[start]|=mask;break;
   }
   return bytes;};
   const bytes=window.addFixtureDuration(new Uint8Array(await new Blob(chunks).arrayBuffer()),3000);
   window.videoFixture=bytes;const input=document.querySelector('.chat-compose input[type=file]'),transfer=new DataTransfer();transfer.items.add(new File([bytes],'First.webm',{type:'video/webm'}));transfer.items.add(new File([bytes],'Second.webm',{type:'video/webm'}));const photo=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));transfer.items.add(new File([photo],'Photo.png',{type:'image/png'}));transfer.items.add(new File([photo],'Other.png',{type:'image/png'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  if (lang === 'en') {
    const result = await run(`(async()=>{
      const {fitChatAttachment}=await import('/src/mediaDraft.ts');
      const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
      const ctx=canvas.getContext('2d'), stream=canvas.captureStream(15);
      const context=new AudioContext(), audio=context.createMediaStreamDestination(), oscillator=context.createOscillator();
      oscillator.connect(audio);oscillator.start();await context.resume();
      stream.addTrack(audio.stream.getAudioTracks()[0]);
      const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8,opus'}), chunks=[];
      recorder.ondataavailable=event=>chunks.push(event.data);
      const stopped=new Promise(resolve=>{recorder.onstop=resolve;});
      recorder.start();
      const start=performance.now(), timer=setInterval(()=>{
        ctx.fillStyle='green';ctx.fillRect(0,0,160,90);
        ctx.fillStyle='white';ctx.fillRect((performance.now()-start)%100,20,20,20);
      },50);
      await new Promise(resolve=>setTimeout(resolve,1200));
      recorder.stop();await stopped;clearInterval(timer);
      stream.getTracks().forEach(track=>track.stop());await context.close();
      const bytes=window.addFixtureDuration(new Uint8Array(await new Blob(chunks).arrayBuffer()),1200);
      const source=new File([bytes,Uint8Array.of(0xec,0x24,0,0),new Uint8Array(262144)],'Oversized.webm',{type:'video/webm'});
      const limit=128*1024;
      const compressed=await fitChatAttachment(source,limit,new AbortController().signal);
      const video=document.createElement('video'), url=URL.createObjectURL(compressed);
      try {
        await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=reject;video.src=url;});
        const compressedStream=video.captureStream();
        const result={size:compressed.size,name:compressed.name,video:compressedStream.getVideoTracks().length,audio:compressedStream.getAudioTracks().length};
        compressedStream.getTracks().forEach(track=>track.stop());
        return result;
      } finally {URL.revokeObjectURL(url);}
    })()`);
    assert.ok(result.size > 0 && result.size <= 128 * 1024);
    assert.deepEqual({ name: result.name, video: result.video, audio: result.audio }, { name: 'Oversized.webm', video: 1, audio: 1 });
  }
  await until("document.querySelectorAll('.attachment-thumbnail img').length===4&&!document.querySelector('.attachment-preparing')");
  assert.equal(await run("document.querySelectorAll('.chat-attachment-card').length"),4);
  assert.equal(await run("document.querySelectorAll('.attachment-card-actions button').length"),12);
  assert.ok(await run("(()=>{const card=document.querySelector('.chat-attachment-card'),thumb=card.querySelector('.attachment-thumbnail').getBoundingClientRect(),image=card.querySelector('img').getBoundingClientRect(),buttons=[...card.querySelectorAll('.attachment-card-actions button')].map(e=>e.getBoundingClientRect());return thumb.width>150&&thumb.height>=140&&image.width>150&&image.height>100&&buttons.every(b=>Math.abs(b.top-buttons[0].top)<1)})()"),'large thumbnail and horizontal tools override legacy attachment styles');

  assert.ok(await run("(()=>{const image=document.querySelector('.attachment-thumbnail img'),canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const c=canvas.getContext('2d');c.drawImage(image,0,0);const p=c.getImageData(0,0,1,1).data;return p[1]>80&&p[1]>p[0]*1.5;})()"),'sender skips the black beginning and saves a nonempty frame');
  await run("document.querySelectorAll('.attachment-thumbnail')[2].click()");
  await until("!!document.querySelector('dialog .photo-viewer-image')");
  await run("document.querySelector('dialog .modal-heading button').click()");
  assert.equal(await run("window.sendRequests.length"),0,'closing a photo preview cannot submit the composer');
  await fs.writeFile(path.join(os.tmpdir(),'pawtalk-video-drafts-'+lang+'.png'),(await win.capturePage()).toPNG());
  await run("document.querySelector('.attachment-card-actions button:nth-child(2)').click()");
  await until("!!document.querySelector('dialog input')");
  await run("(()=>{const e=document.querySelector('dialog input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Renamed.webm');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await run("document.querySelector('dialog form').requestSubmit()");
  await until("document.querySelector('.attachment-filename').textContent==='Renamed.webm'");
  await run("document.querySelector('.member-composer').requestSubmit()");
  await until("document.querySelectorAll('.chat-video-card').length===2&&document.querySelector('.chat-video-open').disabled===false");
  assert.ok(await run("window.sendRequests.at(-1).content.files.filter(f=>f.mime.startsWith('video/')).every(f=>f.poster?.id&&f.mime==='video/webm')"),'video and encrypted poster references share one message');
  assert.equal(await run("document.querySelectorAll('.chat-attachment-card').length"),0);
  await until("document.querySelectorAll('.chat-video-card .video-poster img').length===2");
  assert.ok(await run("(()=>{const r=[...document.querySelectorAll('.chat-message-attachments .chat-media-card')].map(e=>e.getBoundingClientRect());return r.length===4&&Math.abs(r[0].top-r[1].top)<1&&r[2].top>=r[0].bottom&&Math.abs(r[2].top-r[3].top)<1})()"),'mixed attachments use a two-column grid');
  await run("document.querySelector('.chat-photo-card .chat-video-open').click()");
  await until("!!document.querySelector('.photo-viewer-image')&&document.querySelector('.photo-viewer-image').naturalWidth>0");
  assert.equal(await run("document.querySelector('.photo-viewer .video-credits strong').textContent"),'Me');
  await run("document.querySelector('.photo-zoom-toolbar button:last-child').click()");
  assert.equal(await run("document.querySelector('.photo-zoom-fit').textContent"),'125%');
  await run("document.querySelector('.photo-zoom-fit').click()");
  await run("document.querySelector('.photo-viewer .video-previous').click()");
  await until("!!document.querySelector('.video-viewer video')&&!document.querySelector('.video-viewer video').paused");
  await run("document.querySelector('.video-next').click()");
  await until("!!document.querySelector('.photo-viewer-image')");
  await run("document.querySelector('.photo-viewer .video-next').click()");
  await until("document.querySelector('.photo-viewer .video-counter').textContent==='4 / 4'");
  await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' });
  await until("document.querySelector('.photo-viewer .video-counter')?.textContent==='3 / 4'");
  await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
  await until("document.querySelector('.photo-viewer .video-counter')?.textContent==='4 / 4'");
  await run("document.querySelector('.photo-viewer .video-viewer-footer > button:last-child').click()");
  await until("!!document.fullscreenElement");
  assert.ok(await run("(()=>{const image=document.querySelector('.photo-viewer-image'),r=image.getBoundingClientRect(),v=document.fullscreenElement.getBoundingClientRect();return Math.abs(r.top+r.height/2-v.top-v.height/2)<1&&Math.abs(r.left+r.width/2-v.left-v.width/2)<1&&Math.abs(r.height-v.height)<1&&getComputedStyle(image).objectFit==='contain'})()"),'fullscreen photo fills a centered contain box instead of inheriting auto height');
  await fs.writeFile(path.join(os.tmpdir(),'pawtalk-photo-centered-'+lang+'.png'),(await win.capturePage()).toPNG());

  await run("document.exitFullscreen()");
  await run(`document.querySelector('.photo-viewer .video-viewer-header button[aria-label="${lang === 'en' ? 'Close' : 'Закрыть'}"]').click()`);
  await until("!document.querySelector('.video-dialog')");
  await run("document.querySelector('.chat-video-open').click()");
  await until("!!document.querySelector('.video-viewer video')&&!document.querySelector('.video-viewer video').paused");
  assert.equal(await run("document.querySelector('.video-viewer video').controls"),false);
  assert.equal(await run("document.querySelector('.video-viewer .video-credits strong').textContent"),'Me');
  await run("document.querySelector('.video-volume').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
  await until("!!document.querySelector('.video-volume input')");
  assert.deepEqual(await run("(()=>{const i=document.querySelector('.video-volume input');return[i.min,i.max,i.value,getComputedStyle(i).writingMode]})()"),['0','2','1','vertical-lr']);
  await run("(()=>{const i=document.querySelector('.video-volume input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'1.6');i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await run("document.querySelector('.video-next').click()");
  await until("document.querySelector('.video-counter').textContent==='2 / 4'&&!document.querySelector('.video-viewer video').paused");
  await run("document.querySelector('.video-viewer-footer > button:last-child').click()");
  await until("document.fullscreenElement?.classList.contains('video-viewer')");
  assert.equal(win.isFullScreen(),true,'Fullscreen API enters actual native window fullscreen');
  await until("document.querySelector('.video-viewer video').currentTime>.5");
  await fs.writeFile(path.join(os.tmpdir(),'pawtalk-video-fullscreen-'+lang+'.png'),(await win.capturePage()).toPNG());
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until("!document.fullscreenElement&&!!document.querySelector('.video-dialog[open]')");
  await run("document.querySelector('.video-viewer video').pause();document.querySelector('.video-viewer').focus();document.querySelector('.video-viewer').dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}))");
  await until("!document.querySelector('.video-viewer video').paused");
  await run("document.querySelector('.video-volume').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.querySelector('.video-stage')}));document.querySelector('.video-viewer video').currentTime=0;document.querySelector('.video-viewer').focus();document.querySelector('.video-viewer').dispatchEvent(new PointerEvent('pointermove',{bubbles:true}))");
  await until("!document.querySelector('.video-volume input')");
  await run("document.querySelector('.video-viewer video').loop=true;document.querySelector('.video-viewer video').playbackRate=.25;document.querySelector('.video-viewer video').currentTime=0;document.querySelector('.video-viewer video').play();document.querySelector('.video-viewer').dispatchEvent(new PointerEvent('pointermove',{bubbles:true}))");
  await until("document.querySelector('.video-viewer').dataset.controls==='false'");
  await run("document.querySelector('.video-viewer').dispatchEvent(new PointerEvent('pointermove',{bubbles:true}))");
  assert.equal(await run("document.querySelector('.video-viewer').dataset.controls"),'true','moving pointer reveals hidden controls');
  await run("document.querySelector('.video-viewer video').pause();document.querySelector('.video-viewer').focus();document.querySelector('.video-viewer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))");
  assert.ok(await run("document.querySelector('.video-viewer video').currentTime>2"),'arrow key seeks by five seconds capped at duration');
  await run(`document.querySelector('.video-viewer-header button[aria-label="${lang === 'en' ? 'Close' : 'Закрыть'}"]').click()`);
  await until("!document.querySelector('.video-dialog')");
  console.log('PASS custom video '+lang+': sender poster, multiple attachments, rename, shared previews, autoplay, navigation, 0–200% vertical volume, actual fullscreen and Escape');
 }
 await win.loadURL(process.env.PAWTALK_UI_TEST_URL+'/tests/server-chat.html?compose=1&media-variants=1&lang=en');
 await until("document.querySelectorAll('[data-message-row]').length===25");
 const originalSize = await run(`(async()=>{
  const canvas=document.createElement('canvas');canvas.width=4000;canvas.height=3000;
  const context=canvas.getContext('2d'),image=context.createImageData(4000,3000);
  let random=59173;
  for(let y=0;y<3000;y++)for(let x=0;x<4000;x++){
   random=(Math.imul(random,1664525)+1013904223)>>>0;
   const i=(y*4000+x)*4,noise=(random>>>27)-16;
   image.data[i]=128+90*Math.sin(x/37)+noise;
   image.data[i+1]=128+80*Math.sin(y/62)+noise;
   image.data[i+2]=128+85*Math.cos((x+y)/53)+noise;
   image.data[i+3]=255;
  }
  context.putImageData(image,0,0);
  const photo=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.72));
  const digest=async blob=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())));
  window.originalDigest=await digest(photo);
  window.desktop.copyChatImage=async ({bytes})=>{
   window.copiedImage=new File([bytes],'Copied.png',{type:'image/png'});
   const bitmap=await createImageBitmap(window.copiedImage);
   window.copiedWidth=bitmap.width;
   bitmap.close();
  };
  const anchorClick=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){
   if(this.download==='Original.jpg'){
    void fetch(this.href).then(response=>response.blob()).then(blob=>digest(blob)).then(value=>{window.downloadDigest=value;});
   }else anchorClick.call(this);
  };
  const input=document.querySelector('.chat-compose input[type=file]'),transfer=new DataTransfer();
  transfer.items.add(new File([photo],'Original.jpg',{type:'image/jpeg'}));
  const gif=Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),c=>c.charCodeAt(0));
  transfer.items.add(new File([gif],'Tiny.gif',{type:'image/gif'}));
  input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  return photo.size;
 })()`);
 assert.ok(originalSize>=1024*1024 && originalSize<=2*1024*1024);
 await until("document.querySelectorAll('.attachment-thumbnail img').length===2&&!document.querySelector('.attachment-preparing')");
 await run("document.querySelector('.member-composer').requestSubmit()");
 await until("document.querySelectorAll('.chat-photo-card .video-poster img').length===2 && [...document.querySelectorAll('.chat-photo-card .video-poster img')].every(img=>img.naturalWidth>0)");
 const [photo,gif] = await run('window.sendRequests.at(-1).content.files');
 assert.equal(photo.size,originalSize);
 assert.equal(photo.preview.mime,'image/webp');
 assert.ok(photo.preview.size<=80*1024 && photo.view.size<=originalSize/2);
 assert.equal(gif.preview.mime,'image/webp');
 assert.equal(gif.view,undefined);
 assert.deepEqual([...new Set(await run('window.attachmentReads'))].sort(),[photo.preview.id,gif.preview.id].sort());
 await run("document.querySelector('.chat-photo-card .chat-video-open').click()");
 await until("document.querySelector('.photo-viewer-image')?.naturalWidth===2048");
 assert.deepEqual(await run("[...document.querySelectorAll('.photo-viewer .video-viewer-actions button')].slice(-2).map(button=>button.getAttribute('aria-label'))"),
  ['Copy image','Close']);
 assert.equal(await run('window.attachmentReads.at(-1)'),photo.view.id);
 await run("document.querySelector('button[aria-label=\"Copy image\"]').click()");
 await until('window.copiedWidth===2048');
 await until("document.querySelector('.viewer-image-status')?.textContent.includes('Image copied')");
 assert.equal(await run(`(() => {
  const toast=document.querySelector('.viewer-image-status').getBoundingClientRect();
  const viewer=document.querySelector('.photo-viewer').getBoundingClientRect();
  return toast.top >= viewer.top && toast.bottom <= viewer.top + viewer.height / 3;
 })()`),true,'Copy notice is shown at the top of the viewer');
 assert.ok(!(await run('window.attachmentReads')).includes(photo.id));
 await run("document.querySelector('button[aria-label=\"Download original\"]').click()");
 await until('!!window.downloadDigest');
 assert.equal(await run('window.attachmentReads.at(-1)'),photo.id);
 assert.deepEqual(await run('window.downloadDigest'),await run('window.originalDigest'),'download preserves the original SHA-256');
 await run("document.querySelector('.photo-viewer button[aria-label=\"Close\"]').click()");
 assert.ok(await run('window.copiedImage.size > 2 * 1024 * 1024'),'The preview expands into an oversized clipboard PNG');
 await run(`(() => {
  const clipboardData=new DataTransfer();
  clipboardData.items.add(window.copiedImage);
  document.querySelector('.member-composer textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData}));
 })()`);
 await until("document.querySelector('.attachment-filename')?.textContent === 'Copied.webp' && document.querySelector('.attachment-thumbnail img')?.naturalWidth > 0");
 assert.ok(await run("fetch(document.querySelector('.attachment-thumbnail img').src).then(response=>response.blob()).then(blob=>blob.size <= 2 * 1024 * 1024)"));
 await run("document.querySelector('.attachment-card-actions .danger-button').click()");
 await run(`(async()=>{
  const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
  const context=canvas.getContext('2d');context.fillStyle='green';context.fillRect(0,0,320,180);
  const image=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  const input=document.querySelector('.chat-compose input[type=file]'),transfer=new DataTransfer();
  transfer.items.add(new File([image],'Small.png',{type:'image/png'}));
  input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
 })()`);
 await until("document.querySelector('.attachment-thumbnail img')&&!document.querySelector('.attachment-preparing')");
 await run("document.querySelector('.member-composer').requestSubmit()");
 await until('window.sendRequests.length===2');
 const single = await run('window.sendRequests.at(-1).content.image');
 assert.equal(single.mime,'image/png');
 assert.equal(single.preview.mime,'image/webp');
 assert.equal(single.view,undefined);
 console.log('PASS media variants: static photo/GIF previews, optimized photo on open, byte-identical original on download');
 clearTimeout(timer);app.exit(0);}catch(error){console.error(error.stack);clearTimeout(timer);app.exit(1);}
});
