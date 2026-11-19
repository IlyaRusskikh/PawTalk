export type MediaDraft={id:string;file:File;url:string;poster?:Blob;posterURL?:string;duration?:number;error?:string};
export const imageMime=(mime:string)=>['image/png','image/jpeg','image/webp'].includes(mime);
export const videoMime=(mime:string)=>['video/mp4','video/webm'].includes(mime);
export function disposeDraft(draft:MediaDraft){URL.revokeObjectURL(draft.url);if(draft.posterURL)URL.revokeObjectURL(draft.posterURL);}
export async function prepareDraft(file:File):Promise<MediaDraft>{
 const draft:MediaDraft={id:crypto.randomUUID(),file,url:URL.createObjectURL(file)};
 if(!videoMime(file.type))return draft;
 const video=document.createElement('video');video.muted=true;video.preload='auto';video.src=draft.url;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 const wait=(event:string)=>new Promise<void>((resolve,reject)=>{
  const done=()=>{cleanup();resolve();},fail=()=>{cleanup();reject(Error('video'));};
  const cleanup=()=>{video.removeEventListener(event,done);video.removeEventListener('error',fail);controller.signal.removeEventListener('abort',fail);};
  if(controller.signal.aborted)return fail();video.addEventListener(event,done,{once:true});video.addEventListener('error',fail,{once:true});controller.signal.addEventListener('abort',fail,{once:true});
 });
 try{
  await wait('loadeddata');if(!video.videoWidth)throw Error('video');if(Number.isFinite(video.duration))draft.duration=video.duration;
  const canvas=document.createElement('canvas'),ratio=Math.min(1,640/video.videoWidth,480/video.videoHeight);canvas.width=Math.max(1,Math.round(video.videoWidth*ratio));canvas.height=Math.max(1,Math.round(video.videoHeight*ratio));
  const context=canvas.getContext('2d',{willReadFrequently:true})!;
  for(const time of [0,.1,.3,.7,1.5,3]){
   const seek=Math.min(time,Math.max(0,video.duration-.02));if(Math.abs(seek-video.currentTime)>.001){const ready=wait('seeked');video.currentTime=seek;await ready;}
   context.drawImage(video,0,0,canvas.width,canvas.height);
   const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let light=0,count=0;
   for(let i=0;i<pixels.length;i+=64){light+=Math.max(pixels[i],pixels[i+1],pixels[i+2]);count++;}
   if(light/Math.max(1,count)>12||time===3)break;
  }
  draft.poster=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('video')),'image/jpeg',.82));draft.posterURL=URL.createObjectURL(draft.poster);
 }catch{draft.error='video';}
 finally{clearTimeout(timer);controller.abort();video.removeAttribute('src');video.load();}
 return draft;
}
