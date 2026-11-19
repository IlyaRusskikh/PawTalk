import {useEffect,useRef,useState} from 'react';
import {membership,type ChatAttachment} from './membership';
import {Icon} from './Controls';
import {VideoViewer} from './VideoViewer';
import {t} from './i18n';

function Poster({serverId,channelId,file,enabled}:{serverId:string;channelId:string;file:ChatAttachment;enabled:boolean}){
 const node=useRef<HTMLSpanElement>(null),[url,setUrl]=useState('');
 useEffect(()=>{if(!enabled)return;let cancelled=false;const observer=new IntersectionObserver(entries=>{if(!entries.some(e=>e.isIntersecting))return;const poster=file.poster||(file.mime.startsWith('image/')?file:undefined);if(!poster)return;observer.disconnect();void membership<string>('image',{serverId,channelId,attachmentId:poster.id,mime:poster.mime}).then(value=>{if(!cancelled)setUrl(value);}).catch(()=>{});},{rootMargin:'200px'});if(node.current)observer.observe(node.current);return()=>{cancelled=true;observer.disconnect();};},[serverId,channelId,file.poster?.id,enabled]);
 return <span ref={node} className="video-poster">{url?<img src={url} alt=""/>:<span className="video-poster-placeholder"><Icon name="video" size={40}/></span>}</span>;
}
export function VideoMessage({serverId,channelId,files,group=files,pending=false,author,avatar,date}:{serverId:string;channelId:string;files:ChatAttachment[];group?:ChatAttachment[];pending?:boolean;author?:string;avatar?:string;date?:number}){
 const [view,setView]=useState<number>(),[error,setError]=useState(''),[saving,setSaving]=useState('');
 const cache=useRef(new Map<string,Promise<string>>()),urls=useRef(new Set<string>()),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;for(const url of urls.current)URL.revokeObjectURL(url);};},[]);
 function load(file:ChatAttachment){let pending=cache.current.get(file.id);if(!pending){pending=membership<Uint8Array>('file',{serverId,channelId,attachmentId:file.id}).then(bytes=>{if(!alive.current)throw Error('cancelled');const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:file.mime}));urls.current.add(url);return url;}).catch(error=>{cache.current.delete(file.id);throw error;});cache.current.set(file.id,pending);}return pending;}
 async function save(file:ChatAttachment){setSaving(file.id);try{const url=await load(file);if(!alive.current)return;const link=document.createElement('a');link.href=url;link.download=file.name;link.click();}catch{if(alive.current)setError(t('Не удалось загрузить видео.'));}finally{if(alive.current)setSaving('');}}
 return <div className="chat-videos">{files.map((file)=><div className={`chat-media-card ${file.mime.startsWith('image/')?'chat-photo-card':'chat-video-card'}`} key={file.id}><button type="button" className="chat-video-open" disabled={pending} aria-label={file.mime.startsWith('image/')?t('Открыть изображение {0}',file.name):t('Воспроизвести')+' · '+file.name} onClick={()=>setView(group.findIndex(f=>f.id===file.id))}><Poster serverId={serverId} channelId={channelId} file={file} enabled={!pending}/>{!file.mime.startsWith('image/')&&<span className="chat-video-play"><Icon name="play" size={30}/></span>}</button><button type="button" className="chat-video-save icon-button" disabled={pending||!!saving} aria-label={t('Скачать')+' · '+file.name} title={t('Скачать')} onClick={()=>void save(file)}><Icon name="download"/></button></div>)}{error&&<p role="alert" className="text-error">{error}</p>}{view!==undefined&&<VideoViewer items={group.map(file=>({id:file.id,name:file.name,image:file.mime.startsWith('image/'),load:()=>load(file)}))} initial={view} author={author} avatar={avatar} date={date} onClose={()=>setView(undefined)}/>}</div>;
}
