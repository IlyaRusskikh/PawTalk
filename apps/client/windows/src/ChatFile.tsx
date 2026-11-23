import {VideoMessage} from './VideoMessage';
import {VoicePlayer} from './VoicePlayer';
import {Icon} from './Controls';
import {Modal} from './Modal';
import {useEffect,useEffectEvent,useRef,useState} from 'react';
import {membership,type Message} from './membership';
import {t} from './i18n';
import {hasGalleryPreview} from './mediaDraft';
import {attachmentBlob,withProtectedFileSlot} from './chatImages';

export function ChatFile({serverId,channelId,file,pending=false,protectedPosition}:{
  serverId:string;channelId:string;file:NonNullable<Message['content']['file']>;pending?:boolean;protectedPosition?:number;
}){
  const [saving,setSaving]=useState<{x:number;y:number}>();
  const [viewing,setViewing]=useState(false);
  const [asset,setAsset]=useState<{url:string;gif:boolean}>();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const element=useRef<HTMLDivElement>(null);
  const download=useRef<Promise<string>|undefined>(undefined);
  const objectUrl=useRef('');
  const generation=useRef(0);
  const gifCandidate=file.mime==='image/gif'||(file.mime==='application/octet-stream'&&/\.gif$/i.test(file.name));

  useEffect(()=>{
    setAsset(undefined);
    setBusy(false);
    setError('');
    setViewing(false);
    return()=>{
      generation.current++;
      download.current=undefined;
      if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);
      objectUrl.current='';
    };
  },[serverId,channelId,file.id,protectedPosition]);

  function load():Promise<string>{
    if(download.current)return download.current;
    const current=generation.current;
    setBusy(true);
    setError('');
    const action=protectedPosition===undefined?'file':'chat.protected.attachment';
    const fetchFile=async()=>{
      if(current!==generation.current)throw Error(t('Загрузка отменена'));
      return membership<Uint8Array>(action,{serverId,channelId,attachmentId:file.id,position:protectedPosition});
    };
    download.current=(protectedPosition===undefined?fetchFile():withProtectedFileSlot(fetchFile)).then(bytes=>{
      if(current!==generation.current)throw Error(t('Загрузка отменена'));
      const gif=gifCandidate&&/^GIF8[79]a$/.test(new TextDecoder().decode(bytes.subarray(0,6)));
      const url=URL.createObjectURL(attachmentBlob(bytes,gif?'image/gif':file.mime));
      objectUrl.current=url;
      setAsset({url,gif});
      return url;
    }).catch((e:Error)=>{
      if(current===generation.current){
        download.current=undefined;
        setError(e.message);
      }
      throw e;
    }).finally(()=>{
      if(current===generation.current)setBusy(false);
    });
    return download.current;
  }

  const autoLoad=useEffectEvent(()=>void load().catch(()=>{}));
  useEffect(()=>{
    const node=element.current;
    if(!gifCandidate||pending||!node)return;
    const observer=new IntersectionObserver(entries=>{
      if(!entries.some(entry=>entry.isIntersecting))return;
      observer.disconnect();
      autoLoad();
    },{root:node.closest('.chat-stream'),rootMargin:'120px'});
    observer.observe(node);
    return()=>observer.disconnect();
  },[gifCandidate,pending,serverId,channelId,file.id,protectedPosition]);

  if(hasGalleryPreview(file) || file.mime.startsWith('video/'))
    return <VideoMessage serverId={serverId} channelId={channelId} files={[file]} pending={pending} protectedPosition={protectedPosition}/>;
  if(file.mime.startsWith('audio/'))return <div className="chat-voice" onContextMenu={event=>{event.preventDefault();if(pending)return;event.stopPropagation();setSaving({x:Math.min(event.clientX,innerWidth-190),y:Math.min(event.clientY,innerHeight-50)});}}><VoicePlayer disabled={pending} key={file.id} load={load} duration={file.voice?.duration} waveform={file.voice?.waveform}/>{saving&&<div className="chat-message-menu voice-save-menu" style={{left:saving.x,top:saving.y}} role="menu" onMouseLeave={()=>setSaving(undefined)}><button type="button" role="menuitem" onClick={()=>{setSaving(undefined);void load().then(value=>{const link=document.createElement('a');link.href=value;link.download=file.name;link.click();}).catch(()=>{});}}>{t('Сохранить файл')}</button></div>}</div>;
  return <div className="chat-file" ref={element}>
    {!asset?<button type="button" disabled={busy||pending} onClick={()=>void load().catch(()=>{})}>{busy?t('Загрузка…'):file.name} · {Math.ceil(file.size/1024)} {t('КБ')}</button>:<>
      {asset.gif&&<button type="button" className="chat-gif-preview" onClick={()=>setViewing(true)} aria-label={file.name}>
        <img className="member-chat-image" src={asset.url} alt={file.name} onError={()=>{setViewing(false);setAsset({...asset,gif:false});}}/>
      </button>}
      {!asset.gif&&<a href={asset.url} download={file.name}>{t('Скачать')} · {file.name}</a>}
      {viewing&&asset.gif&&<Modal title={file.name} onClose={()=>setViewing(false)}
        footer={<div className="modal-actions"><a className="icon-button" href={asset.url} download={file.name} aria-label={t('Скачать')} title={t('Скачать')}><Icon name="download"/></a></div>}>
        <img className="chat-gif-full" src={asset.url} alt={file.name}/>
      </Modal>}
    </>}
    {error&&<p role="alert" className="text-error">{error}</p>}
  </div>;
}
