import {VideoMessage} from './VideoMessage';
import {VoicePlayer} from './VoicePlayer';
import {Modal} from './Modal';
import {useEffect,useRef,useState} from 'react';
import {membership,type Message} from './membership';
import {t} from './i18n';

export function ChatFile({serverId,channelId,file,pending=false}:{serverId:string;channelId:string;file:NonNullable<Message['content']['file']>;pending?:boolean}){
  const [saving,setSaving]=useState<{x:number;y:number}>();
  const [viewing,setViewing]=useState(false);
  const [url,setUrl]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0);
  useEffect(()=>{generation.current++;setUrl('');return()=>{generation.current++;};},[file.id]);
  useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);},[url]);
  async function load():Promise<string>{if(url)return url;if(busy)throw Error(t('Загрузка…'));setBusy(true);setError('');const current=generation.current;try{const bytes=await membership<Uint8Array>('file',{serverId,channelId,attachmentId:file.id});if(current!==generation.current)throw Error(t('Загрузка отменена'));const value=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:file.mime}));setUrl(value);return value;}catch(e){setError((e as Error).message);throw e;}finally{setBusy(false);}}
  if(file.mime.startsWith('video/'))return <VideoMessage serverId={serverId} channelId={channelId} files={[file]} pending={pending}/>;
  if(file.mime.startsWith('audio/'))return <div className="chat-voice" onContextMenu={event=>{event.preventDefault();if(pending)return;event.stopPropagation();setSaving({x:Math.min(event.clientX,innerWidth-190),y:Math.min(event.clientY,innerHeight-50)});}}><VoicePlayer disabled={pending} key={file.id} load={load} duration={file.voice?.duration} waveform={file.voice?.waveform}/>{saving&&<div className="chat-message-menu voice-save-menu" style={{left:saving.x,top:saving.y}} role="menu" onMouseLeave={()=>setSaving(undefined)}><button type="button" role="menuitem" onClick={()=>{setSaving(undefined);void load().then(value=>{const link=document.createElement('a');link.href=value;link.download=file.name;link.click();}).catch(()=>{});}}>{t('Сохранить файл')}</button></div>}</div>;
  return <div className="chat-file">{!url?<button type="button" disabled={busy||pending} onClick={()=>void load().catch(()=>{})}>{busy?t('Загрузка…'):file.name} · {Math.ceil(file.size/1024)} {t('КБ')}</button>:<>{file.mime==='image/gif'?<button type="button" className="chat-gif-preview" onClick={()=>setViewing(true)} aria-label={file.name}><img className="member-chat-image" src={url} alt={file.name}/></button>:null}<a href={url} download={file.name}>{t('Скачать')} · {file.name}</a></>}{viewing&&<Modal title={file.name} onClose={()=>setViewing(false)}><img className="chat-gif-full" src={url} alt={file.name}/></Modal>}{error&&<p role="alert" className="text-error">{error}</p>}</div>;
}
