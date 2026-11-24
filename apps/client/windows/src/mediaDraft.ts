import { chatImageLimit, inspectImage } from './chatImages';

export type MediaDraft={id:string;file:File;url:string;poster?:Blob;posterURL?:string;view?:Blob;duration?:number;error?:string};
export const imageMime=(mime:string)=>['image/png','image/jpeg','image/webp'].includes(mime);
export const videoMime=(mime:string)=>['video/mp4','video/webm'].includes(mime);
export const visualMime=(mime:string)=>imageMime(mime)||videoMime(mime)||mime==='image/gif';
export function hasGalleryPreview(file: { mime: string; preview?: unknown }) {
 return visualMime(file.mime) && (file.mime !== 'image/gif' || !!file.preview);
}
const maxMediaSourceSize = 128 * 1024 * 1024;
const maxCompressionDuration = 120;
export const largeAttachmentLimit = 50 * 1024 * 1024;
const compressedDurations = new WeakMap<File, number>();

export const mediaVariantsCapability = 'media-variants-v1';
export function createMediaDraft(file: File): MediaDraft {
 return { id: crypto.randomUUID(), file, url: URL.createObjectURL(file) };
}
export function disposeDraft(draft:MediaDraft){URL.revokeObjectURL(draft.url);if(draft.posterURL)URL.revokeObjectURL(draft.posterURL);}

function encode(canvas: HTMLCanvasElement, mime: string, quality: number) {
 return new Promise<Blob | undefined>(resolve => canvas.toBlob(blob => resolve(blob?.type === mime ? blob : undefined), mime, quality));
}

async function encodePreview(canvas: HTMLCanvasElement) {
 for (const quality of [0.75, 0.6, 0.45, 0.3]) {
  const blob = await encode(canvas, 'image/webp', quality);
  if (blob && blob.size <= 80 * 1024) return blob;
 }
}

function imageCanvas(source: ImageBitmap, maxSide: number) {
 const canvas = document.createElement('canvas');
 const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
 canvas.width = Math.max(1, Math.round(source.width * scale));
 canvas.height = Math.max(1, Math.round(source.height * scale));
 canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
 return canvas;
}

export async function fitChatImage(file: File): Promise<File> {
 if (!imageMime(file.type) || file.size <= chatImageLimit) return file;
 if (file.size > maxMediaSourceSize || inspectImage(new Uint8Array(await file.arrayBuffer()))?.mime !== file.type) {
  throw Error('Invalid image');
 }
 const bitmap = await createImageBitmap(file);
 try {
  let maxSide = Math.min(2560, Math.max(bitmap.width, bitmap.height));
  for (const quality of [0.9, 0.82, 0.74, 0.65, 0.55]) {
   const blob = await encode(imageCanvas(bitmap, maxSide), 'image/webp', quality);
   if (blob && blob.size <= chatImageLimit) {
    const name = (file.name.replace(/\.[^.]+$/, '') || 'image') + '.webp';
    return new File([blob], name, { type: blob.type, lastModified: file.lastModified });
   }
   maxSide = Math.round(maxSide * 0.75);
  }
  throw Error('Image exceeds the attachment limit');
 } finally {
  bitmap.close();
 }
}

export function canPrepareAttachment(file: File, limit: number) {
 return file.size > 0 && file.size <= (imageMime(file.type) || videoMime(file.type) ? maxMediaSourceSize : limit);
}

export async function fitChatAttachment(file: File, limit: number, signal: AbortSignal) {
 signal.throwIfAborted();
 if (imageMime(file.type)) return fitChatImage(file);
 if (file.size <= limit) return file;
 if (!videoMime(file.type) || file.size > maxMediaSourceSize) throw Error('Attachment exceeds the size limit');

 const video = document.createElement('video') as HTMLVideoElement & { captureStream(): MediaStream };
 const url = URL.createObjectURL(file);
 const loading = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
 let stream: MediaStream | undefined;
 let recorder: MediaRecorder | undefined;
 try {
  await new Promise<void>((resolve, reject) => {
   loading.throwIfAborted();
   const abort = () => finish(loading.reason);
   function finish(error?: unknown) {
    loading.removeEventListener('abort', abort);
    video.onloadeddata = video.onerror = null;
    if (error) reject(error); else resolve();
   }
   loading.addEventListener('abort', abort, { once: true });
   video.onloadeddata = () => finish();
   video.onerror = () => finish(Error('Could not decode video'));
   video.muted = true;
   video.preload = 'auto';
   video.src = url;
  });

  const durationBudget = Number.isFinite(video.duration) ? video.duration : maxCompressionDuration;
  const audioBitsPerSecond = 96_000;
  const videoBitsPerSecond = Math.floor(Math.min(4_000_000, limit * 8 * 0.85 / durationBudget - audioBitsPerSecond));
  if (!(video.duration > 0) || durationBudget > maxCompressionDuration || videoBitsPerSecond < 100_000) {
   throw Error('Video cannot be compressed within the attachment limit');
  }
  const recording = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(durationBudget * 1000) + 15_000)]);
  stream = video.captureStream();
  if (!stream.getVideoTracks().length) throw Error('Could not capture video');
  const capture = new MediaRecorder(stream, { mimeType: 'video/webm', videoBitsPerSecond, audioBitsPerSecond });
  recorder = capture;
  const parts: Blob[] = [];
  const result = await new Promise<File>((resolve, reject) => {
   recording.throwIfAborted();
   let total = 0;
   const abort = () => finish(recording.reason);
   function finish(error?: unknown) {
    recording.removeEventListener('abort', abort);
    video.onended = video.onerror = video.ontimeupdate = null;
    capture.ondataavailable = capture.onstop = capture.onerror = null;
    if (error) reject(error);
    else if (!total) reject(Error('Empty recording'));
    else resolve(new File(parts, (file.name.replace(/\.[^.]+$/, '') || 'video') + '.webm', {
     type: 'video/webm', lastModified: file.lastModified,
    }));
   }
   recording.addEventListener('abort', abort, { once: true });
   capture.ondataavailable = ({ data }) => {
    total += data.size;
    if (total > limit) finish(Error('Compressed video exceeds the attachment limit'));
    else if (data.size) parts.push(data);
   };
   capture.onerror = () => finish(Error('Could not encode video'));
   capture.onstop = () => finish(video.ended && video.currentTime <= maxCompressionDuration ? undefined : Error('Incomplete video'));
   video.ontimeupdate = () => { if (video.currentTime > maxCompressionDuration) finish(Error('Video exceeds the duration limit')); };
   video.onerror = () => finish(Error('Could not decode video'));
   video.onended = () => { if (capture.state !== 'inactive') capture.stop(); };
   try {
    capture.start(500);
    void video.play().catch(finish);
   } catch (error) {
    finish(error);
   }
  });
  compressedDurations.set(result, video.currentTime);
  return result;
 } finally {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  stream?.getTracks().forEach(track => track.stop());
  video.pause();
  video.removeAttribute('src');
  video.load();
  URL.revokeObjectURL(url);
 }
}

async function prepareImage(draft: MediaDraft) {
 const file = draft.file;
 if (file.type === 'image/gif') {
  const header = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (header.length !== 10 || !/^GIF8[79]a$/.test(new TextDecoder().decode(header.subarray(0, 6)))) return;
  const view = new DataView(header.buffer);
  const width = view.getUint16(6, true), height = view.getUint16(8, true);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16000000) return;
 } else if (inspectImage(new Uint8Array(await file.arrayBuffer()))?.mime !== file.type) return;

 const bitmap = await createImageBitmap(file);
 try {
  draft.poster = await encodePreview(imageCanvas(bitmap, 480));
  if (draft.poster && imageMime(file.type) && file.size >= 1024 * 1024 && Math.max(bitmap.width, bitmap.height) > 2048) {
   const view = await encode(imageCanvas(bitmap, 2048), 'image/webp', 0.82);
   if (view && view.size <= file.size / 2) draft.view = view;
  }
 } finally {
  bitmap.close();
 }
}

// Keep every original and preview within the existing 20-object attachment quota.
export function allocateMediaViews(drafts: readonly (Pick<MediaDraft, 'poster' | 'view'> | undefined)[]) {
 let remaining = 20 - drafts.length - drafts.filter(draft => draft?.poster).length;
 return drafts.map(draft => {
  if (!draft?.view || remaining <= 0) return undefined;
  remaining--;
  return draft.view;
 });
}

export async function prepareDraft(file:File, variants = false):Promise<MediaDraft>{
 const draft = createMediaDraft(file);
 draft.duration = compressedDurations.get(file);
 if(!videoMime(file.type)){
  if (variants && visualMime(file.type)) {
   try { await prepareImage(draft); } catch { /* Unsupported media remains available as an original. */ }
   if (draft.poster) draft.posterURL = URL.createObjectURL(draft.poster);
  }
  return draft;
 }
 const video=document.createElement('video');video.muted=true;video.preload='auto';video.src=draft.url;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 const wait=(event:string)=>new Promise<void>((resolve,reject)=>{
  const done=()=>{cleanup();resolve();},fail=()=>{cleanup();reject(Error('video'));};
  const cleanup=()=>{video.removeEventListener(event,done);video.removeEventListener('error',fail);controller.signal.removeEventListener('abort',fail);};
  if(controller.signal.aborted)return fail();video.addEventListener(event,done,{once:true});video.addEventListener('error',fail,{once:true});controller.signal.addEventListener('abort',fail,{once:true});
 });
 try{
  await wait('loadeddata');if(!video.videoWidth)throw Error('video');if(Number.isFinite(video.duration))draft.duration??=video.duration;
  const width = variants ? 480 : 640;
  const canvas=document.createElement('canvas'),ratio=Math.min(1,width/video.videoWidth,480/video.videoHeight);canvas.width=Math.max(1,Math.round(video.videoWidth*ratio));canvas.height=Math.max(1,Math.round(video.videoHeight*ratio));
  const context=canvas.getContext('2d',{willReadFrequently:true})!;
  for(const time of [0,.1,.3,.7,1.5,3]){
   const seek=Math.min(time,Math.max(0,(draft.duration??video.duration)-.02));if(Math.abs(seek-video.currentTime)>.001){const ready=wait('seeked');video.currentTime=seek;await ready;}
   context.drawImage(video,0,0,canvas.width,canvas.height);
   const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let light=0,count=0;
   for(let i=0;i<pixels.length;i+=64){light+=Math.max(pixels[i],pixels[i+1],pixels[i+2]);count++;}
   if(light/Math.max(1,count)>12||time===3)break;
  }
  draft.poster=variants ? await encodePreview(canvas) : await encode(canvas, 'image/jpeg', 0.82);
  if (!draft.poster) throw Error('video');
  draft.posterURL=URL.createObjectURL(draft.poster);
 }catch{draft.error='video';}
 finally{clearTimeout(timer);controller.abort();video.removeAttribute('src');video.load();}
 return draft;
}
