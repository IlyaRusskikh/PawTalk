import {useEffect,useRef,useState} from 'react';
import {membership,type ChatAttachment,type MediaVariant} from './membership';
import {Icon} from './Controls';
import {VideoViewer} from './VideoViewer';
import {t} from './i18n';
import {attachmentBlob,chatImageLimit,inspectImage,withImageSlot,withProtectedFileSlot,withProtectedPreviewSlot} from './chatImages';
import {imageMime} from './mediaDraft';

function Poster({serverId,channelId,file,enabled,protectedPosition}:{
 serverId:string;channelId:string;file:ChatAttachment;enabled:boolean;protectedPosition?:number;
}){
 const node=useRef<HTMLSpanElement>(null),[url,setUrl]=useState('');
 const started=useRef<number | undefined>(undefined);
 const record = (stage: 'media.preview.decoded' | 'media.preview.failed') => {
  if(started.current === undefined)return;
  window.desktop?.recordClientPerformance?.(stage, performance.now() - started.current);
  started.current = undefined;
 };
 const [error,setError]=useState('');
 const originalPhoto = protectedPosition !== undefined && imageMime(file.mime) && file.size <= chatImageLimit;
 const poster = file.preview ?? file.poster ?? (originalPhoto ? file : undefined);
 const size = file.preview?.size;
 useEffect(()=>{
  setUrl('');
  setError('');
  if(!enabled||!poster)return;
  const source = poster;
  const queue = protectedPosition === undefined ? withImageSlot : withProtectedPreviewSlot;
  let generation = 0, objectURL='';
  let visible = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  async function load(current: number, remaining: number) {
   try {
    await queue(async () => {
     if (current !== generation) return;
     const scope = { serverId, channelId, attachmentId: source.id };
     if (size === undefined && protectedPosition === undefined) {
      const data = await membership<string>('image', { ...scope, mime: source.mime });
      if (current === generation) setUrl(data);
      return;
     }
     const action = protectedPosition === undefined ? 'file' : 'chat.protected.attachment';
     const bytes = await membership<Uint8Array>(action, { ...scope, position: protectedPosition });
     if (current !== generation) return;
     if (size !== undefined) {
      const image = bytes.length === size ? inspectImage(bytes) : undefined;
      if (image?.mime !== source.mime || Math.max(image.width, image.height) > 480) {
       throw Error(t('Не удалось загрузить изображение.'));
      }
     }
     objectURL = URL.createObjectURL(attachmentBlob(bytes, source.mime));
     setUrl(objectURL);
     setError('');
    });
   } catch (failure) {
    if (current !== generation) return;
    const reason = failure as Error & { code?: string; retryAfter?: number };
    setError(reason.message);
    if (protectedPosition !== undefined && remaining > 0 && ['RATE_LIMIT', 'CONNECTION_FAILED', 'PROTECTED_KEY_PENDING',
     'PROTECTED_PROOF_BUSY', 'POLICY_ATTESTATION_UNAVAILABLE', 'UNVERIFIED_EPOCH_POLICY'].includes(reason.code ?? '')) {
     retryTimer = setTimeout(() => void load(current, remaining - 1), Math.max(1000, (reason.retryAfter ?? 0) * 1000));
    } else record('media.preview.failed');
   }
  }
  const observer=new IntersectionObserver(entries=>{
   const next = entries.at(-1)?.isIntersecting === true;
   if (next === visible) return;
   visible = next;
   const current = ++generation;
   clearTimeout(retryTimer);
   if (!visible) {
    started.current = undefined;
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = '';
    setUrl('');
    return;
   }
   started.current = performance.now();
   void load(current, 2);
  },{root:node.current?.closest('.chat-stream,.member-history'),rootMargin:'200px'});
  if(node.current)observer.observe(node.current);
  return()=>{generation++;clearTimeout(retryTimer);observer.disconnect();if(objectURL)URL.revokeObjectURL(objectURL);};
 },[serverId,channelId,poster?.id,poster?.mime,size,enabled,protectedPosition]);
 return <span ref={node} className="video-poster" title={error || undefined}>{url?<img src={url} decoding="async" alt=""
  onLoad={()=>record('media.preview.decoded')} onError={()=>record('media.preview.failed')}/>:<span className="video-poster-placeholder"><Icon name={file.mime.startsWith('image/')?'image':'video'} size={40}/></span>}</span>;
}
export function VideoMessage({serverId,channelId,files,group=files,pending=false,author,avatar,date,protectedPosition,saveImageNatively=false}:{
 serverId:string;channelId:string;files:ChatAttachment[];group?:ChatAttachment[];pending?:boolean;author?:string;avatar?:string;date?:number;protectedPosition?:number;saveImageNatively?:boolean;
}){
 const [view,setView]=useState<number>(),[error,setError]=useState(''),[saving,setSaving]=useState('');
 const cache=useRef(new Map<string, Promise<{ url: string; blob: Blob }>>()),urls=useRef(new Set<string>()),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;for(const url of urls.current)URL.revokeObjectURL(url);};},[]);
 function load(file:ChatAttachment|MediaVariant) {
  const cached = cache.current.get(file.id);
  if (cached) return cached;
  const action = protectedPosition === undefined ? 'file' : 'chat.protected.attachment';
  const fetchFile = async () => {
     if (!alive.current) throw Error(t('Загрузка отменена'));
     const bytes = await membership<Uint8Array>(action, { serverId, channelId, attachmentId: file.id, position: protectedPosition });
     if (!alive.current) throw Error('cancelled');
     if (!('name' in file)) {
      const image = bytes.length === file.size ? inspectImage(bytes) : undefined;
      if (image?.mime !== file.mime || Math.max(image.width, image.height) > 2048) throw Error('Invalid media variant');
     }
     const blob = attachmentBlob(bytes, file.mime);
     const url = URL.createObjectURL(blob);
     urls.current.add(url);
     return { url, blob };
  };
  const request = (protectedPosition === undefined ? fetchFile() : withProtectedFileSlot(fetchFile))
    .catch(error => { cache.current.delete(file.id); throw error; });
  cache.current.set(file.id, request);
  return request;
 }
 async function download(file:ChatAttachment) {
  const { url, blob } = await load(file);
  if (!alive.current) return;
  if (saveImageNatively && imageMime(file.mime) && window.desktop?.saveChatImage) {
   const bytes = new Uint8Array(await blob.arrayBuffer());
   if (alive.current) return window.desktop.saveChatImage({ bytes, name: file.name });
   return;
  }
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
 }
 async function save(file:ChatAttachment){setSaving(file.id);setError('');try{await download(file);}catch{if(alive.current)setError(t('Не удалось скачать оригинал.'));}finally{if(alive.current)setSaving('');}}
 return <div className="chat-videos">
  {files.map(file => {
   const image = file.mime.startsWith('image/');
   return <div className={`chat-media-card ${image?'chat-photo-card':'chat-video-card'}`} key={file.id}>
    <button type="button" className="chat-video-open" disabled={pending}
     aria-label={image ? t('Открыть изображение {0}',file.name) : t('Воспроизвести')+' · '+file.name}
     onClick={()=>setView(group.findIndex(item=>item.id===file.id))}>
     <Poster serverId={serverId} channelId={channelId} file={file} enabled={!pending} protectedPosition={protectedPosition}/>
     {!image&&<span className="chat-video-play"><Icon name="play" size={30}/></span>}
    </button>
    <button type="button" className="chat-video-save icon-button" disabled={pending||!!saving}
     aria-label={t('Скачать оригинал')+' · '+file.name} title={t('Скачать оригинал')} onClick={()=>void save(file)}>
     <Icon name="download"/>
    </button>
   </div>;
  })}
  {error&&<p role="alert" className="text-error">{error}</p>}
  {view!==undefined&&<VideoViewer items={group.map(file=>({
   id:file.id,name:file.name,duration:file.duration,image:file.mime.startsWith('image/'),load:async()=>(await load(file.view ?? file)).url,
   ...((file.view || saveImageNatively) && { downloadOriginal:()=>download(file) }),
  }))} initial={view} author={author} avatar={avatar} date={date} onClose={()=>setView(undefined)}/>}
 </div>;
}
